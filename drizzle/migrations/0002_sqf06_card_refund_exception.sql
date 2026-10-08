-- SQF06 — "Card refund outside Square" exception (independent go-live counter-check
-- 2026-10-08; owner decision D-SQF06 = approved as recommended, 2026-10-08 23:38 JST).
-- Project doc: claude/square-go-live-countercheck-response-2026-10-08.md §2.
--
--   Until now a card-paid web order could be marked refunded ONLY with method
--   'card', once Square showed a COMPLETED refund (B01). When Square cannot
--   refund — the refund FAILED / was REJECTED, or the capture is older than 365
--   days (Square's refund window) — the order stayed refund_pending with nowhere
--   to go. The nine-point exception, as the owner approved it:
--     1. TRIGGER   a square_refunds row FAILED or REJECTED on the order, or a
--                  captured square_payments row older than 365 days — each a fact
--                  the Hub read back from Square; nothing else opens the path
--                  (exception_not_triggered).
--     2. APPROVER  admin only (has_role(p_user_id, 'admin'); admin_only).
--     3. EVIDENCE  the Square refund id (or the over-age capture) AND a Square
--                  Support ticket number; refused without
--                  (exception_evidence_required, missing = the field).
--     4. PAYOUT    bank transfer in yen to the customer's own account
--                  (method bank_transfer_exception: transfer_date + transfer_
--                  reference required); store credit ONLY on the customer's
--                  written request (method store_credit_exception: the admin
--                  first issues the manual lot through Settings → Store Credit,
--                  then records it here with the lot id + the request; the lot
--                  must be the customer's, in yen, exactly the amount). Never
--                  cash, never another card.
--     5. CAP       captured card money − COMPLETED Square refunds − store credit
--                  already issued on the order; computed here, never typed
--                  (exception_over_cap; exception_nothing_owed when <= 0).
--     6. RECORD    refund_status → refund_issued with the method, amount, refund
--                  id, ticket, transfer date and reference in the audit row
--                  (new_value_json.exception); shown as "Refunded by bank
--                  transfer (Square exception)".
--     7. LATER     a Square refund that COMPLETES after the exception rings
--                  card_refund_after_exception (record_square_refund, migration
--                  20261129100000) — a staff case, never both settled.
--     8. WORDING   "or reverse the Square refund" is gone (20261129100000).
--     9. EMAIL     the existing refund-received / refund-issued email, method
--                  line "bank transfer" (edge: mark-refund-issued).
--
--   mark_web_order_refund_issued_atomic gains p_exception jsonb DEFAULT NULL.
--   Postgres would make every 5-argument call ambiguous between two overloads,
--   so the 5-argument function is DROPPED and re-created with 6 — from the LIVE
--   text behind an md5 guard (Bug #280; live md5 c2732c8418cd42c5f84919701c881948),
--   grants re-asserted. No `--` line appears inside any edit (Lovable's runner
--   drops such lines — docs/MIGRATIONS.md "Lovable strips in-body comments").

CREATE OR REPLACE FUNCTION pg_temp.cj_edit(p_text text, p_old text, p_new text)
RETURNS text LANGUAGE plpgsql AS $e$
DECLARE v_n integer := (length(p_text) - length(replace(p_text, p_old, ''))) / length(p_old);
BEGIN
  IF v_n <> 1 THEN RAISE EXCEPTION 'STOP — anchor found % times, expected 1: %', v_n, left(p_old, 120); END IF;
  RETURN replace(p_text, p_old, p_new);
END
$e$;

DO $sqf06$
DECLARE
  v_old  regprocedure := to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)');
  v_six  regprocedure := to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)');
  v_def  text;
  v_new  text;
BEGIN
  IF v_old IS NULL AND v_six IS NOT NULL THEN
    RAISE NOTICE 'mark_web_order_refund_issued_atomic already has p_exception — no change';
    RETURN;
  END IF;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'STOP — mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text) is not on live; nothing changed';
  END IF;
  v_def := pg_get_functiondef(v_old);
  IF md5(v_def) <> 'c2732c8418cd42c5f84919701c881948' THEN
    RAISE EXCEPTION 'STOP — mark_web_order_refund_issued_atomic has moved on live (md5 %); re-read it before patching. Nothing changed.', md5(v_def);
  END IF;
  v_new := v_def;

  v_new := pg_temp.cj_edit(v_new,
    $o$p_refunded_on date, p_note text DEFAULT NULL::text)$o$,
    $n$p_refunded_on date, p_note text DEFAULT NULL::text, p_exception jsonb DEFAULT NULL::jsonb)$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$  v_paidy_remaining numeric(12,2) := 0;$o$,
    $n$  v_paidy_remaining numeric(12,2) := 0;
  v_exc jsonb := NULL;
  v_exc_trigger text := NULL;
  v_exc_amount numeric(12,2) := 0;
  v_card_captured numeric(12,2) := 0;
  v_credit_issued numeric(12,2) := 0;
  v_cap numeric(12,2) := 0;
  v_lot public.store_credit_lots%ROWTYPE;$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other') THEN$o$,
    $n$  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other', 'bank_transfer_exception', 'store_credit_exception') THEN$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$  IF v_method <> 'card' AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;$o$,
    $n$  IF v_method IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF NOT v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
    END IF;
    IF NOT public.has_role(p_user_id, 'admin') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
    END IF;
    v_exc := COALESCE(p_exception, '{}'::jsonb);
    IF NULLIF(btrim(COALESCE(v_exc ->> 'square_support_ticket', '')), '') IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'square_support_ticket');
    END IF;
    IF NULLIF(btrim(COALESCE(v_exc ->> 'square_refund_id', '')), '') IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM public.square_refunds r
                  WHERE r.cash_order_id = p_order_id AND r.square_refund_id = btrim(v_exc ->> 'square_refund_id')
                    AND r.status IN ('FAILED', 'REJECTED')) THEN
        v_exc_trigger := 'refund_' || lower((SELECT r.status FROM public.square_refunds r
                                              WHERE r.cash_order_id = p_order_id AND r.square_refund_id = btrim(v_exc ->> 'square_refund_id') LIMIT 1));
      ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'exception_not_triggered', 'detail', 'refund_not_failed_or_rejected');
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.square_payments sp
                   WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured'
                     AND sp.captured_at IS NOT NULL AND sp.captured_at < now() - interval '365 days') THEN
      v_exc_trigger := 'capture_over_365_days';
    ELSE
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_triggered', 'detail', 'no_failed_refund_and_capture_within_365_days');
    END IF;
    SELECT COALESCE(SUM(sp.amount_jpy), 0) INTO v_card_captured
      FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
    SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
    SELECT COALESCE(SUM(l.original_amount), 0) INTO v_credit_issued
      FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
    v_cap := v_card_captured - v_card_refunded - v_credit_issued;
    IF v_cap <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_nothing_owed', 'cap_jpy', v_cap,
                                'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
    END IF;
    IF COALESCE(v_exc ->> 'amount_jpy', '') !~ '^[0-9]+$' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'amount_jpy', 'cap_jpy', v_cap);
    END IF;
    v_exc_amount := (v_exc ->> 'amount_jpy')::numeric;
    IF v_exc_amount <= 0 OR v_exc_amount > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_over_cap', 'cap_jpy', v_cap, 'requested_jpy', v_exc_amount,
                                'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
    END IF;
    IF v_method = 'bank_transfer_exception' THEN
      IF COALESCE(v_exc ->> 'transfer_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_date');
      END IF;
      IF (v_exc ->> 'transfer_date')::date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_date', 'detail', 'transfer_date');
      END IF;
      IF NULLIF(btrim(COALESCE(v_exc ->> 'transfer_reference', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_reference');
      END IF;
    ELSE
      IF NULLIF(btrim(COALESCE(v_exc ->> 'customer_request', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'customer_request');
      END IF;
      IF COALESCE(v_exc ->> 'store_credit_lot_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'store_credit_lot_id');
      END IF;
      SELECT * INTO v_lot FROM public.store_credit_lots WHERE id = (v_exc ->> 'store_credit_lot_id')::uuid;
      IF v_lot.id IS NULL OR v_lot.customer_id IS DISTINCT FROM v_order.customer_id OR v_lot.currency::text <> 'JPY'
         OR v_lot.status::text = 'voided' OR v_lot.original_amount <> v_exc_amount OR v_lot.source_cash_order_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_lot_mismatch', 'detail',
          CASE WHEN v_lot.id IS NULL THEN 'lot_not_found'
               WHEN v_lot.customer_id IS DISTINCT FROM v_order.customer_id THEN 'lot_not_this_customer'
               WHEN v_lot.currency::text <> 'JPY' THEN 'lot_not_jpy'
               WHEN v_lot.status::text = 'voided' THEN 'lot_voided'
               WHEN v_lot.source_cash_order_id IS NOT NULL THEN 'lot_already_tied_to_an_order'
               ELSE 'lot_amount_differs' END,
          'lot_amount', v_lot.original_amount, 'requested_jpy', v_exc_amount);
      END IF;
    END IF;
    v_amount := v_exc_amount;
    v_exc := jsonb_build_object('trigger', v_exc_trigger, 'payout', CASE WHEN v_method = 'bank_transfer_exception' THEN 'bank_transfer' ELSE 'store_credit' END,
                                'square_refund_id', NULLIF(btrim(COALESCE(v_exc ->> 'square_refund_id', '')), ''),
                                'square_support_ticket', btrim(v_exc ->> 'square_support_ticket'),
                                'transfer_date', v_exc ->> 'transfer_date', 'transfer_reference', NULLIF(btrim(COALESCE(v_exc ->> 'transfer_reference', '')), ''),
                                'store_credit_lot_id', v_exc ->> 'store_credit_lot_id', 'customer_request', NULLIF(btrim(COALESCE(v_exc ->> 'customer_request', '')), ''),
                                'cap_jpy', v_cap, 'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
  END IF;
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$  IF v_method <> 'card' AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;$o$,
    $n$  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$  ELSIF v_paidy_paid > 0 THEN
    IF v_amount - v_paidy_paid <= 0 THEN$o$,
    $n$  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF v_amount - v_paidy_paid <= 0 THEN$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$                             'paidy_remaining_jpy', v_paidy_remaining,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),$o$,
    $n$                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),$n$);

  v_new := pg_temp.cj_edit(v_new,
    $o$                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));$o$,
    $n$                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));$n$);

  DROP FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text);
  EXECUTE v_new;
  IF to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'STOP — the 6-argument function did not store; rolled back';
  END IF;
END
$sqf06$;

-- Grants re-asserted after DROP + CREATE (the default ACL grants PUBLIC; 2026-09-24 rule).
REVOKE ALL ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text, jsonb) IS
  'Addendum §9 #8 + B01 + PA03 + SQF06 (owner D-SQF06, 2026-10-08): marks a cancelled web order''s refund as issued. Card money: method card once Square shows a COMPLETED refund (its amount), or — admin only, when a Square refund FAILED/REJECTED or the capture is over 365 days old, with the Square Support ticket — bank_transfer_exception / store_credit_exception, capped at captured − completed refunds − credit issued (p_exception carries the evidence; the audit row keeps it).';

-- Self-check (structure; behaviour: development/sql/sqf06-card-refund-exception-acceptance.sql).
DO $self$
DECLARE d text := pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'::regprocedure);
BEGIN
  IF position('exception_over_cap' IN d) = 0 OR position('exception_not_triggered' IN d) = 0 OR position('admin_only' IN d) = 0
     OR position('store_credit_exception' IN d) = 0 OR position('''exception'', v_exc' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — mark_web_order_refund_issued_atomic lacks the SQF06 exception path';
  END IF;
  IF to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP — the 5-argument overload still exists (ambiguous calls)';
  END IF;
END
$self$;