-- Payment submissions in ONE transaction (owner-approved plan 2026-10-01 10:11 JST).
--
-- WHY. Bulk Payment Import sent every CSV row to record-payment on its own,
-- with no proof, so since the 30 June rule ("proof of payment is required on
-- every submit path") every row has been refused and the page is unusable.
-- record-multi-payment writes its legs in a loop: a failure on leg 3 of 5
-- leaves a half batch, and a retry after a timeout books the same money
-- twice (its own TODO, 2026-06). Both now go through this function.
--
-- WHAT. insert_payment_submissions_batch(p_batch_key, p_proof_url, p_rows,
-- p_source, p_sender_name, p_user_id, p_force) inserts one pending
-- payment_submissions row per element of p_rows, all or none:
--   * IDEMPOTENT: p_batch_key is the submissions' reference_number. A second
--     call with a key that already has rows inserts nothing and returns the
--     existing ids (inserted=false) — a client retry after a timeout cannot
--     double-book.
--   * PROOF: every row gets its own proof_url when the row carries one, else
--     the batch proof. A row with neither is refused, so the "proof required"
--     rule (PAYMENT-SUBMISSIONS.md) holds here too.
--   * GUARD: the same per-account advisory lock and 30-minute same-amount
--     duplicate check as insert_payment_submission_guarded, except that rows
--     of THIS batch never count as each other's duplicates (two equal catch-up
--     installments for one account are normal in a bulk file). A duplicate
--     raises, so the whole batch rolls back and the message names the row.
--   * NO 24-hour rate cap (owner decision D-1): the caller is admin/finance.
--   * AUDIT: one audit_logs row per submission, action = p_source-specific
--     ('staff_bulk_import_submitted' | 'staff_multi_payment_submitted').
-- The payments table is NOT touched — confirmation stays with
-- review-payment-submission, one submission at a time ("Confirm all in this
-- batch" is a later step, owner decision D-3).
--
-- WHO MAY CALL. auth.uid() when present (a signed-in staff member in the
-- browser), else p_user_id (an edge function running as service_role has
-- already verified the user). Bulk import requires the bulk_payment_import
-- permission (admin, or a role/override granting it); the multi-invoice
-- source requires is_staff. EXECUTE is granted to authenticated and
-- service_role only.
--
-- p_rows element: { "row": 3, "invoice_number": "18189" | "account_id": "<uuid>",
--   "amount": 3136, "date": "2026-10-01", "method": "cash", "remarks": "…",
--   "proof_url": "https://…" (optional), "is_downpayment": false (optional) }
-- Returns: { "inserted": bool, "batch_key": text, "count": int,
--   "submission_ids": [uuid…], "rows": [{row, account_id, invoice_number, submission_id}] }

BEGIN;

CREATE OR REPLACE FUNCTION public.insert_payment_submissions_batch(
  p_batch_key   text,
  p_proof_url   text,
  p_rows        jsonb,
  p_source      text DEFAULT 'bulk_import',
  p_sender_name text DEFAULT NULL,
  p_user_id     uuid DEFAULT NULL,
  p_force       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid         uuid := coalesce(auth.uid(), p_user_id);
  v_existing    uuid[];
  v_row         jsonb;
  v_rownum      int;
  v_acct        record;
  v_amount      numeric;
  v_date        date;
  v_proof       text;
  v_dup         record;
  v_id          uuid;
  v_ids         uuid[] := '{}';
  v_out         jsonb := '[]'::jsonb;
  v_action      text;
  v_type        text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_source = 'bulk_import' THEN
    IF NOT public.has_permission(v_uid, 'bulk_payment_import') THEN
      RAISE EXCEPTION 'permission_denied: bulk_payment_import' USING ERRCODE = '42501';
    END IF;
    v_action := 'staff_bulk_import_submitted';
  ELSIF p_source = 'multi_invoice' THEN
    IF NOT public.is_staff(v_uid) THEN
      RAISE EXCEPTION 'permission_denied: staff only' USING ERRCODE = '42501';
    END IF;
    v_action := 'staff_multi_payment_submitted';
  ELSE
    RAISE EXCEPTION 'unknown source %', p_source;
  END IF;

  IF p_batch_key IS NULL OR length(trim(p_batch_key)) < 8 THEN
    RAISE EXCEPTION 'batch_key is required (at least 8 characters)';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'rows must be a non-empty array';
  END IF;
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'at most 500 rows per batch';
  END IF;

  -- Idempotency: the key already has submissions → nothing to do.
  SELECT array_agg(id ORDER BY created_at) INTO v_existing
    FROM payment_submissions WHERE reference_number = p_batch_key;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'inserted', false, 'batch_key', p_batch_key,
      'count', cardinality(v_existing),
      'submission_ids', to_jsonb(v_existing), 'rows', '[]'::jsonb);
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_rownum := coalesce((v_row->>'row')::int, 0);

    IF v_row ? 'account_id' AND nullif(v_row->>'account_id','') IS NOT NULL THEN
      SELECT id, customer_id, invoice_number, status, remaining_balance
        INTO v_acct FROM layaway_accounts WHERE id = (v_row->>'account_id')::uuid;
    ELSE
      SELECT id, customer_id, invoice_number, status, remaining_balance
        INTO v_acct FROM layaway_accounts WHERE invoice_number = v_row->>'invoice_number';
    END IF;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'row %: account not found (%)', v_rownum, coalesce(v_row->>'invoice_number', v_row->>'account_id');
    END IF;
    IF v_acct.status NOT IN ('active','overdue','extension_active','reactivated','final_settlement') THEN
      RAISE EXCEPTION 'row %: account #% is % — cannot accept payments', v_rownum, v_acct.invoice_number, v_acct.status;
    END IF;

    v_amount := (v_row->>'amount')::numeric;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'row %: amount must be > 0', v_rownum;
    END IF;
    IF v_amount > v_acct.remaining_balance + 0.01 THEN
      RAISE EXCEPTION 'row %: amount % exceeds remaining balance % on #%', v_rownum, v_amount, v_acct.remaining_balance, v_acct.invoice_number;
    END IF;
    BEGIN
      v_date := (v_row->>'date')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'row %: date must be YYYY-MM-DD', v_rownum;
    END;
    IF v_date IS NULL THEN
      RAISE EXCEPTION 'row %: date is required', v_rownum;
    END IF;

    v_proof := nullif(trim(coalesce(v_row->>'proof_url', '')), '');
    IF v_proof IS NULL THEN v_proof := nullif(trim(coalesce(p_proof_url, '')), ''); END IF;
    IF v_proof IS NULL THEN
      RAISE EXCEPTION 'row %: proof of payment is required', v_rownum;
    END IF;

    v_type := CASE WHEN coalesce((v_row->>'is_downpayment')::boolean, false) THEN 'downpayment'
                   WHEN p_source = 'bulk_import' THEN 'installment' ELSE 'installment' END;

    -- Same guard as insert_payment_submission_guarded, per account.
    PERFORM pg_advisory_xact_lock(hashtext('payment_submission:' || v_acct.id::text));
    IF NOT p_force THEN
      SELECT id, created_at, sender_name INTO v_dup
        FROM payment_submissions
       WHERE account_id = v_acct.id
         AND status IN ('submitted','under_review')
         AND created_at >= now() - interval '30 minutes'
         AND abs(submitted_amount - v_amount) < 1
         AND reference_number IS DISTINCT FROM p_batch_key
       ORDER BY created_at DESC LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'duplicate_submission_detected: row % — a % submission for #% is already pending (by %, % min ago). Nothing was imported.',
          v_rownum, v_amount, v_acct.invoice_number, coalesce(v_dup.sender_name,'unknown'),
          greatest(1, round(extract(epoch FROM (now() - v_dup.created_at)) / 60)::int)
          USING ERRCODE = '23505';
      END IF;
    END IF;

    INSERT INTO payment_submissions (
      account_id, customer_id, submitted_amount, payment_date, payment_method,
      reference_number, notes, status, submission_type, sender_name, proof_url
    ) VALUES (
      v_acct.id, v_acct.customer_id, v_amount, v_date,
      coalesce(nullif(trim(v_row->>'method'),''), 'cash'),
      p_batch_key,
      nullif(trim(coalesce(v_row->>'remarks','')), ''),
      'submitted', v_type, p_sender_name, v_proof
    ) RETURNING id INTO v_id;

    INSERT INTO audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('payment_submission', v_id, v_action,
      jsonb_build_object('batch_key', p_batch_key, 'row', v_rownum, 'amount', v_amount,
                         'account_id', v_acct.id, 'payment_date', v_date, 'source', p_source),
      v_uid);

    v_ids := v_ids || v_id;
    v_out := v_out || jsonb_build_object('row', v_rownum, 'account_id', v_acct.id,
                        'invoice_number', v_acct.invoice_number, 'submission_id', v_id);
  END LOOP;

  RETURN jsonb_build_object('inserted', true, 'batch_key', p_batch_key,
    'count', cardinality(v_ids), 'submission_ids', to_jsonb(v_ids), 'rows', v_out);
END;
$function$;

REVOKE ALL ON FUNCTION public.insert_payment_submissions_batch(text, text, jsonb, text, text, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insert_payment_submissions_batch(text, text, jsonb, text, text, uuid, boolean) TO authenticated, service_role;

-- Bulk import's own rows carry the batch key as reference_number; this makes
-- the idempotency lookup and "all rows of a batch" in Submissions cheap.
CREATE INDEX IF NOT EXISTS idx_payment_submissions_reference_number
  ON public.payment_submissions (reference_number) WHERE reference_number IS NOT NULL;

COMMIT;