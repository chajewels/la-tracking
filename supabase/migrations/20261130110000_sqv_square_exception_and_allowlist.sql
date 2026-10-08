-- SQV01–SQV04 + D-G04 (independent fix revalidation 2026-10-09; owner decisions
-- 2026-10-09 ~01:55 JST: approve first then pay, Square facts only, read-only
-- preflight, allow-list). Project doc: claude/square-fix-revalidation-response-2026-10-09.md
--
--   SQV01  mark_web_order_refund_issued_atomic is service_role ONLY again (SQF06
--          had widened it to authenticated while it trusts a caller-supplied
--          p_user_id). The only caller is the mark-refund-issued edge (service
--          client, after requireAuth + permission + admin checks).
--   SQV02  A store-credit lot used to settle a card refund is LOCKED and ALLOCATED
--          to exactly one refund obligation: card_refund_exceptions.store_credit_lot_id
--          is UNIQUE. Eligibility: the customer's own, JPY, active, not expired,
--          unspent, issued AFTER the approval, a manual lot (no order source),
--          exactly the approved amount.
--   SQV03  Approve first, then pay (D-SQV03). approve_card_refund_exception_atomic
--          (admin) refuses while ANY Square refund on the order is not COMPLETED /
--          FAILED / REJECTED, computes the cap (captured − COMPLETED refunds − credit
--          issued on the order) and RESERVES the amount in an `approved` row (one
--          live row per order). The bank transfer / lot happens AFTER approval;
--          "Mark refund issued" then RECORDS against the approval and refuses if a
--          refund started or completed since (exception_refund_in_progress /
--          exception_superseded). cancel_card_refund_exception_atomic (admin,
--          reason) withdraws an unpaid approval. The edge re-reads every Square
--          refund of the order from Square BEFORE approving.
--   SQV04  The age trigger is the ORIGINAL payment (square_payments.authorized_at)
--          more than one calendar year ago (interval '1 year'), Square facts only
--          (D-SQV04: no trigger without a FAILED/REJECTED refund row or the age).
--   D-G04  square_audience ('everyone' | 'listed', fail-closed to 'listed') +
--          square_card_customer_ids (uuid list). square_card_allowed(customer):
--          off → false; test → is_test customers (as the edge already did); on →
--          everyone, or only the listed customers. Honoured by the checkout draft,
--          the staff method change, the customer's own switch and
--          reserve_square_attempt (the last stop before Square). Changed ONLY via
--          set_square_settings (admin, audited, guard trigger). Seeded 'listed'
--          with an EMPTY list: switching to 'on' offers card to nobody until the
--          owner lists customers or chooses 'everyone'. Mode 'test' is unaffected.
--
--   Every patch starts from the live text behind an md5 guard (Bug #280); no `--`
--   line inside any patch anchor (Lovable's runner drops such lines). A re-run is
--   a no-op.

-- ---------------------------------------------------------------------------
-- 1. Patch helpers (session-only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

CREATE OR REPLACE FUNCTION pg_temp.cj_patch_all(p_sig text, p_before text, p_old text, p_new text, p_count integer)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn  regprocedure := to_regprocedure(p_sig);
  v_def text;
  v_n   integer;
BEGIN
  IF v_fn IS NULL THEN RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig; END IF;
  v_def := pg_get_functiondef(v_fn);
  IF position(p_new IN v_def) > 0 THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_n := (length(v_def) - length(replace(v_def, p_old, ''))) / length(p_old);
  IF v_n <> p_count THEN RAISE EXCEPTION 'STOP — % anchor found % times, expected %', p_sig, v_n, p_count; END IF;
  EXECUTE replace(v_def, p_old, p_new);
END
$p$;

-- ---------------------------------------------------------------------------
-- 2. card_refund_exceptions — one row per "card refund outside Square" obligation.
--    Written ONLY by the three SECURITY DEFINER functions below (service role).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.card_refund_exceptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id         uuid NOT NULL REFERENCES public.cash_orders(id),
  status                text NOT NULL CHECK (status IN ('approved', 'recorded', 'cancelled')),
  payout                text NOT NULL CHECK (payout IN ('bank_transfer', 'store_credit')),
  trigger_kind          text NOT NULL CHECK (trigger_kind IN ('refund_failed', 'refund_rejected', 'payment_over_1_year')),
  square_refund_id      text,
  square_support_ticket text NOT NULL CHECK (btrim(square_support_ticket) <> ''),
  amount_jpy            bigint NOT NULL CHECK (amount_jpy > 0),
  cap_jpy               bigint NOT NULL,
  card_captured_jpy     bigint NOT NULL,
  card_refunded_jpy     bigint NOT NULL,
  credit_issued_jpy     bigint NOT NULL,
  approved_by           uuid NOT NULL,
  approved_at           timestamptz NOT NULL DEFAULT now(),
  approval_note         text,
  recorded_by           uuid,
  recorded_at           timestamptz,
  transfer_date         date,
  transfer_reference    text,
  store_credit_lot_id   uuid REFERENCES public.store_credit_lots(id),
  customer_request      text,
  cancelled_by          uuid,
  cancelled_at          timestamptz,
  cancel_reason         text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_jpy <= cap_jpy),
  CHECK (status <> 'recorded' OR (recorded_by IS NOT NULL AND recorded_at IS NOT NULL)),
  CHECK (status <> 'recorded' OR payout <> 'store_credit' OR store_credit_lot_id IS NOT NULL),
  CHECK (status <> 'recorded' OR payout <> 'bank_transfer' OR (transfer_date IS NOT NULL AND btrim(coalesce(transfer_reference, '')) <> '')),
  CHECK (status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_refund_exceptions_live_order
  ON public.card_refund_exceptions (cash_order_id) WHERE status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS uq_card_refund_exceptions_lot
  ON public.card_refund_exceptions (store_credit_lot_id) WHERE store_credit_lot_id IS NOT NULL;
ALTER TABLE public.card_refund_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_refund_exceptions_staff_select ON public.card_refund_exceptions;
CREATE POLICY card_refund_exceptions_staff_select ON public.card_refund_exceptions
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.card_refund_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.card_refund_exceptions TO authenticated;
GRANT ALL ON public.card_refund_exceptions TO service_role;
COMMENT ON TABLE public.card_refund_exceptions IS
  'SQF06/SQV02/SQV03 (owner D-SQF06 + D-SQV03): a card refund paid OUTSIDE Square because Square could not refund (FAILED/REJECTED refund, or original payment over 1 year). approved = amount reserved before any money moves; recorded = paid (bank transfer, or a manual store-credit lot allocated here, UNIQUE per lot); cancelled = approval withdrawn before payment. One live row per order. Written only by approve_card_refund_exception_atomic / cancel_card_refund_exception_atomic / mark_web_order_refund_issued_atomic.';

-- ---------------------------------------------------------------------------
-- 6. The allow-list (D-G04): settings rows + readers. (Numbered as in the plan;
--    placed here because the patched functions below call them.)
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('square_audience', to_jsonb('listed'::text),
        'Card payments (Square) audience while square_mode = on: everyone | listed. Fail-closed to listed. Changed only via set_square_settings (admin, audited).'),
       ('square_card_customer_ids', '[]'::jsonb,
        'Customer ids offered card payment when square_audience = listed (production). Changed only via set_square_settings (admin, audited).')
ON CONFLICT DO NOTHING;
DO $seedchk$
BEGIN
  IF (SELECT count(*) FROM public.system_settings WHERE key IN ('square_audience', 'square_card_customer_ids')) <> 2 THEN
    RAISE EXCEPTION 'STOP — the allow-list settings rows are missing (system_settings.key may not be unique); nothing changed';
  END IF;
END
$seedchk$;

CREATE OR REPLACE FUNCTION public.square_audience()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v = 'everyone' THEN 'everyone' ELSE 'listed' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_audience') AS v) s
$fn$;

CREATE OR REPLACE FUNCTION public.square_card_customer_ids_json()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT coalesce((SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END
                     FROM public.system_settings WHERE key = 'square_card_customer_ids'), '[]'::jsonb)
$fn$;

CREATE OR REPLACE FUNCTION public.square_card_allowed(p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT CASE public.square_mode()
           WHEN 'test' THEN coalesce((SELECT c.is_test FROM public.customers c WHERE c.id = p_customer_id), false)
           WHEN 'on'   THEN public.square_audience() = 'everyone'
                            OR (p_customer_id IS NOT NULL
                                AND public.square_card_customer_ids_json() ? p_customer_id::text)
           ELSE false
         END
$fn$;
REVOKE ALL ON FUNCTION public.square_audience() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.square_card_customer_ids_json() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.square_card_allowed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_audience() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.square_card_customer_ids_json() TO service_role;
GRANT EXECUTE ON FUNCTION public.square_card_allowed(uuid) TO service_role;
COMMENT ON FUNCTION public.square_card_allowed(uuid) IS
  'D-G04 (owner 2026-10-09): may this customer pay by card now? off → no; test → only is_test customers; on → everyone when square_audience = everyone, else only customers in square_card_customer_ids. TS mirror: _shared/card-rules.ts squareCardAllowed.';

-- ---------------------------------------------------------------------------
-- 3. Approve (step 1) and cancel an approval — D-SQV03.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_card_refund_exception_atomic(
  p_order_id uuid, p_user_id uuid, p_payout text, p_square_refund_id text, p_ticket text,
  p_amount_jpy bigint, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_order    public.cash_orders%ROWTYPE;
  v_trigger  text;
  v_rid      text := nullif(btrim(coalesce(p_square_refund_id, '')), '');
  v_ticket   text := nullif(btrim(coalesce(p_ticket, '')), '');
  v_captured bigint;
  v_refunded bigint;
  v_credit   bigint;
  v_cap      bigint;
  v_open     jsonb;
  v_row      public.card_refund_exceptions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF NOT public.has_role(p_user_id, 'admin') THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF p_payout IS NULL OR p_payout NOT IN ('bank_transfer', 'store_credit') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_payout');
  END IF;
  IF v_ticket IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'square_support_ticket');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_web_order'); END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_payments
                  WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF EXISTS (SELECT 1 FROM public.card_refund_exceptions WHERE cash_order_id = p_order_id AND status <> 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_exists');
  END IF;

  SELECT jsonb_agg(jsonb_build_object('refund_id', r.square_refund_id, 'status', r.status, 'amount_jpy', r.amount_jpy))
    INTO v_open
    FROM public.square_refunds r
   WHERE r.cash_order_id = p_order_id AND r.status NOT IN ('COMPLETED', 'FAILED', 'REJECTED');
  IF v_open IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_refund_in_progress', 'refunds', v_open);
  END IF;

  IF v_rid IS NOT NULL THEN
    SELECT 'refund_' || lower(r.status) INTO v_trigger
      FROM public.square_refunds r
     WHERE r.cash_order_id = p_order_id AND r.square_refund_id = v_rid AND r.status IN ('FAILED', 'REJECTED');
    IF v_trigger IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_triggered', 'detail', 'refund_not_failed_or_rejected');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.square_payments sp
                 WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured'
                   AND sp.authorized_at < now() - interval '1 year') THEN
    v_trigger := 'payment_over_1_year';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'exception_not_triggered', 'detail', 'no_failed_refund_and_payment_within_1_year');
  END IF;

  SELECT coalesce(sum(round(sp.amount_jpy)), 0)::bigint INTO v_captured
    FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
  SELECT coalesce(sum(r.amount_jpy), 0)::bigint INTO v_refunded
    FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
  SELECT coalesce(sum(round(l.original_amount)), 0)::bigint INTO v_credit
    FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
  v_cap := v_captured - v_refunded - v_credit;
  IF v_cap <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_nothing_owed', 'cap_jpy', v_cap,
                              'card_captured_jpy', v_captured, 'card_refunded_jpy', v_refunded, 'credit_issued_jpy', v_credit);
  END IF;
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy > v_cap THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_over_cap', 'cap_jpy', v_cap, 'requested_jpy', p_amount_jpy,
                              'card_captured_jpy', v_captured, 'card_refunded_jpy', v_refunded, 'credit_issued_jpy', v_credit);
  END IF;

  INSERT INTO public.card_refund_exceptions (cash_order_id, status, payout, trigger_kind, square_refund_id,
         square_support_ticket, amount_jpy, cap_jpy, card_captured_jpy, card_refunded_jpy, credit_issued_jpy,
         approved_by, approval_note)
  VALUES (p_order_id, 'approved', p_payout, v_trigger, v_rid, v_ticket, p_amount_jpy, v_cap, v_captured, v_refunded,
          v_credit, p_user_id, nullif(btrim(coalesce(p_note, '')), ''))
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'card_refund_exception_approved', NULL, to_jsonb(v_row), p_user_id);
  INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
  VALUES ('card_refund_exception_approved', 'Refund outside Square approved — pay it now',
          coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(p_amount_jpy, 'FM999,999,999')
            || ' approved to be refunded by ' || replace(p_payout, '_', ' ') || ' (Square ' || replace(v_trigger, '_', ' ')
            || ', ticket ' || v_ticket || '). Pay it, then record it on the order with "Mark refund issued".',
          v_order.customer_id, v_order.invoice_number,
          jsonb_build_object('cash_order_id', p_order_id, 'exception_id', v_row.id, 'amount_jpy', p_amount_jpy, 'payout', p_payout));

  RETURN jsonb_build_object('ok', true, 'exception', to_jsonb(v_row), 'cap_jpy', v_cap,
                            'reference', coalesce(v_order.web_reference, v_order.invoice_number));
END
$fn$;

CREATE OR REPLACE FUNCTION public.cancel_card_refund_exception_atomic(p_order_id uuid, p_user_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_row    public.card_refund_exceptions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF NOT public.has_role(p_user_id, 'admin') THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF v_reason IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'reason_required'); END IF;
  PERFORM 1 FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  SELECT * INTO v_row FROM public.card_refund_exceptions
   WHERE cash_order_id = p_order_id AND status <> 'cancelled' FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_approval'); END IF;
  IF v_row.status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_recorded');
  END IF;
  UPDATE public.card_refund_exceptions
     SET status = 'cancelled', cancelled_by = p_user_id, cancelled_at = now(), cancel_reason = v_reason, updated_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'card_refund_exception_cancelled', jsonb_build_object('status', 'approved'), to_jsonb(v_row), p_user_id);
  RETURN jsonb_build_object('ok', true, 'exception', to_jsonb(v_row));
END
$fn$;
REVOKE ALL ON FUNCTION public.approve_card_refund_exception_atomic(uuid, uuid, text, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_card_refund_exception_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_card_refund_exception_atomic(uuid, uuid, text, text, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_card_refund_exception_atomic(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. mark_web_order_refund_issued_atomic (live md5 60af1e0e1af03c61d8daa487a6d88bdc):
--    the exception methods now RECORD an approved exception (step 2) instead of
--    deciding everything at record time (SQV02/SQV03/SQV04).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', '60af1e0e1af03c61d8daa487a6d88bdc', jsonb_build_array(
  jsonb_build_object('old', $o$  v_lot public.store_credit_lots%ROWTYPE;
BEGIN
$o$,
                     'new', $n$  v_lot public.store_credit_lots%ROWTYPE;
  v_cre public.card_refund_exceptions%ROWTYPE;
  v_payout text;
BEGIN
$n$),
  jsonb_build_object('old', $o$  IF v_method IN ('bank_transfer_exception', 'store_credit_exception') THEN
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
$o$,
                     'new', $n$  IF v_method IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF NOT v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
    END IF;
    IF NOT public.has_role(p_user_id, 'admin') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
    END IF;
    v_payout := CASE v_method WHEN 'bank_transfer_exception' THEN 'bank_transfer' ELSE 'store_credit' END;
    SELECT * INTO v_cre FROM public.card_refund_exceptions
     WHERE cash_order_id = p_order_id AND status = 'approved' FOR UPDATE;
    IF v_cre.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_approved');
    END IF;
    IF v_cre.payout <> v_payout THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_payout_mismatch', 'approved_payout', v_cre.payout);
    END IF;
    IF EXISTS (SELECT 1 FROM public.square_refunds r
                WHERE r.cash_order_id = p_order_id AND r.status NOT IN ('COMPLETED', 'FAILED', 'REJECTED')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_refund_in_progress');
    END IF;
    SELECT coalesce(sum(round(sp.amount_jpy)), 0) INTO v_card_captured
      FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
    SELECT coalesce(sum(r.amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
    SELECT coalesce(sum(round(l.original_amount)), 0) INTO v_credit_issued
      FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
    v_cap := v_card_captured - v_card_refunded - v_credit_issued;
    IF v_cre.amount_jpy > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_superseded', 'cap_jpy', v_cap, 'approved_jpy', v_cre.amount_jpy,
                                'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
    END IF;
    v_exc := COALESCE(p_exception, '{}'::jsonb);
    IF v_payout = 'bank_transfer' THEN
      IF COALESCE(v_exc ->> 'transfer_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_date');
      END IF;
      IF (v_exc ->> 'transfer_date')::date > (now() AT TIME ZONE 'Asia/Manila')::date
         OR (v_exc ->> 'transfer_date')::date < (v_cre.approved_at AT TIME ZONE 'Asia/Manila')::date THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_date', 'detail', 'transfer_date');
      END IF;
      IF NULLIF(btrim(COALESCE(v_exc ->> 'transfer_reference', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_reference');
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(),
             transfer_date = (v_exc ->> 'transfer_date')::date,
             transfer_reference = left(btrim(v_exc ->> 'transfer_reference'), 200), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    ELSE
      IF NULLIF(btrim(COALESCE(v_exc ->> 'customer_request', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'customer_request');
      END IF;
      IF COALESCE(v_exc ->> 'store_credit_lot_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'store_credit_lot_id');
      END IF;
      SELECT * INTO v_lot FROM public.store_credit_lots WHERE id = (v_exc ->> 'store_credit_lot_id')::uuid FOR UPDATE;
      IF v_lot.id IS NULL OR v_lot.customer_id IS DISTINCT FROM v_order.customer_id OR v_lot.currency::text <> 'JPY'
         OR v_lot.status::text <> 'active' OR v_lot.expires_at <= now() OR v_lot.remaining_amount <> v_lot.original_amount
         OR v_lot.original_amount <> v_cre.amount_jpy OR v_lot.source_cash_order_id IS NOT NULL
         OR v_lot.issued_at < v_cre.approved_at
         OR EXISTS (SELECT 1 FROM public.card_refund_exceptions x WHERE x.store_credit_lot_id = v_lot.id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_lot_mismatch', 'detail',
          CASE WHEN v_lot.id IS NULL THEN 'lot_not_found'
               WHEN v_lot.customer_id IS DISTINCT FROM v_order.customer_id THEN 'lot_not_this_customer'
               WHEN v_lot.currency::text <> 'JPY' THEN 'lot_not_jpy'
               WHEN v_lot.status::text <> 'active' THEN 'lot_not_active'
               WHEN v_lot.expires_at <= now() THEN 'lot_expired'
               WHEN v_lot.remaining_amount <> v_lot.original_amount THEN 'lot_already_spent'
               WHEN v_lot.source_cash_order_id IS NOT NULL THEN 'lot_tied_to_an_order'
               WHEN v_lot.issued_at < v_cre.approved_at THEN 'lot_issued_before_approval'
               WHEN v_lot.original_amount <> v_cre.amount_jpy THEN 'lot_amount_differs'
               ELSE 'lot_already_allocated' END,
          'lot_amount', v_lot.original_amount, 'approved_jpy', v_cre.amount_jpy);
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(), store_credit_lot_id = v_lot.id,
             customer_request = left(btrim(v_exc ->> 'customer_request'), 500), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    END IF;
    v_amount := v_cre.amount_jpy;
    v_exc := jsonb_build_object('exception_id', v_cre.id, 'trigger', v_cre.trigger_kind, 'payout', v_cre.payout,
                                'square_refund_id', v_cre.square_refund_id, 'square_support_ticket', v_cre.square_support_ticket,
                                'transfer_date', v_cre.transfer_date, 'transfer_reference', v_cre.transfer_reference,
                                'store_credit_lot_id', v_cre.store_credit_lot_id, 'customer_request', v_cre.customer_request,
                                'approved_by', v_cre.approved_by, 'approved_at', v_cre.approved_at,
                                'cap_jpy', v_cap, 'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded,
                                'credit_issued_jpy', v_credit_issued);
  END IF;
$n$)
));

-- ---------------------------------------------------------------------------
-- 5. record_square_refund (live md5 2da293298e29ea12c5caf5a2832362ef): the
--    later-refund bell also covers an APPROVED (not yet paid) exception, and any
--    refund that is not FAILED/REJECTED — pending money matters before the
--    transfer is made (SQV03).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)', '2da293298e29ea12c5caf5a2832362ef', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_st = 'COMPLETED' AND (v_old.id IS NULL OR v_old.status IS DISTINCT FROM 'COMPLETED')
     AND EXISTS (SELECT 1 FROM public.audit_logs a
                  WHERE a.entity_type = 'cash_order' AND a.entity_id = v_sq.cash_order_id AND a.action = 'refund_marked_issued'
                    AND a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception'))
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'card_refund_after_exception' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refund_after_exception', 'Square refund completed AFTER a refund exception',
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || p_refund_id || ' COMPLETED in Square, but this order was already refunded outside Square (bank transfer / store credit exception). The customer may now be paid back twice: a staff case — never settle both.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
  END IF;
$o$,
                     'new', $n$  IF v_st NOT IN ('FAILED', 'REJECTED') AND (v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status)
     AND (EXISTS (SELECT 1 FROM public.card_refund_exceptions x
                   WHERE x.cash_order_id = v_sq.cash_order_id AND x.status IN ('approved', 'recorded')
                     AND x.square_refund_id IS DISTINCT FROM p_refund_id)
          OR EXISTS (SELECT 1 FROM public.audit_logs a
                      WHERE a.entity_type = 'cash_order' AND a.entity_id = v_sq.cash_order_id AND a.action = 'refund_marked_issued'
                        AND a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception')))
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'card_refund_after_exception' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refund_after_exception', 'Square refund AFTER a refund-outside-Square approval',
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || p_refund_id || ' is ' || lower(v_st) || ' in Square, but a refund outside Square (bank transfer / store credit) is approved or already paid for this order. If it is not paid yet, do NOT pay it: cancel the approval. If it is paid, the customer may be paid back twice: a staff case — never settle both.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
  END IF;
$n$)
));

-- ---------------------------------------------------------------------------
-- 7. guard_square_settings (live md5 aa1202f69a696c8e0c0f7367ee396142): the two
--    allow-list keys are guarded like the four Square settings.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch_all('public.guard_square_settings()', 'aa1202f69a696c8e0c0f7367ee396142',
  $o$('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')$o$,
  $n$('square_mode','square_app_id','square_location_id','card_agreement_min_jpy','square_audience','square_card_customer_ids')$n$, 2);

-- ---------------------------------------------------------------------------
-- 8. get_square_settings (live md5 6c7e6c0b0027346205bb221800635dc2): returns the
--    audience, the listed customers (code + name) and the last production preflight.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.get_square_settings()', '6c7e6c0b0027346205bb221800635dc2', jsonb_build_array(
  jsonb_build_object('old', $o$    'can_change',            public.has_role(v_uid, 'admin'::public.app_role),
$o$,
                     'new', $n$    'audience',              public.square_audience(),
    'card_customers',        coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'code', c.customer_code, 'name', c.full_name) ORDER BY c.customer_code)
                                         FROM public.customers c
                                        WHERE c.id::text IN (SELECT jsonb_array_elements_text(public.square_card_customer_ids_json()))), '[]'::jsonb),
    'preflight',             (SELECT value || jsonb_build_object('updated_at', updated_at) FROM public.square_sync_state WHERE key = 'preflight:production'),
    'can_change',            public.has_role(v_uid, 'admin'::public.app_role),
$n$)
));

-- ---------------------------------------------------------------------------
-- 9. set_square_settings (live md5 8d28717d29598b48492b5c1a912c713d) gains
--    p_audience ('everyone' | 'listed') and p_card_customer_codes (customer codes,
--    CJ-YYYY-NNNNN). New parameters change the signature, so the 5-argument
--    function is dropped and re-created FROM THE LIVE TEXT with these edits, inside
--    one DO block behind the md5 guard; grants re-asserted after (2026-09-24 rule).
-- ---------------------------------------------------------------------------
DO $sqv_set$
DECLARE
  v_old regprocedure := to_regprocedure('public.set_square_settings(text,text,text,numeric,text)');
  v_def text;
  e     jsonb;
  v_n   integer;
BEGIN
  IF v_old IS NULL AND to_regprocedure('public.set_square_settings(text,text,text,numeric,text,text,text[])') IS NOT NULL THEN
    RAISE NOTICE 'set_square_settings already has the allow-list — no change';
    RETURN;
  END IF;
  IF v_old IS NULL THEN RAISE EXCEPTION 'STOP — set_square_settings(text,text,text,numeric,text) is not on live; nothing changed'; END IF;
  v_def := pg_get_functiondef(v_old);
  IF md5(v_def) <> '8d28717d29598b48492b5c1a912c713d' THEN
    RAISE EXCEPTION 'STOP — set_square_settings has moved on live (md5 %); re-read it. Nothing changed.', md5(v_def);
  END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(jsonb_build_array(
  jsonb_build_object('old', $o$p_expected_mode text DEFAULT NULL::text)$o$,
                     'new', $n$p_expected_mode text DEFAULT NULL::text, p_audience text DEFAULT NULL::text, p_card_customer_codes text[] DEFAULT NULL::text[])$n$),
  jsonb_build_object('old', $o$  v_now       timestamptz := now();
$o$,
                     'new', $n$  v_now       timestamptz := now();
  v_aud_row   public.system_settings%ROWTYPE;
  v_ids_row   public.system_settings%ROWTYPE;
  v_new_aud   text;
  v_new_ids   jsonb;
  v_old_ids   jsonb;
  v_bad       text[];
$n$),
  jsonb_build_object('old', $o$  SELECT * INTO v_min_row  FROM public.system_settings WHERE key = 'card_agreement_min_jpy' FOR UPDATE;
$o$,
                     'new', $n$  SELECT * INTO v_min_row  FROM public.system_settings WHERE key = 'card_agreement_min_jpy' FOR UPDATE;
  SELECT * INTO v_aud_row  FROM public.system_settings WHERE key = 'square_audience' FOR UPDATE;
  SELECT * INTO v_ids_row  FROM public.system_settings WHERE key = 'square_card_customer_ids' FOR UPDATE;
$n$),
  jsonb_build_object('old', $o$  IF v_mode_row.id IS NULL OR v_app_row.id IS NULL OR v_loc_row.id IS NULL OR v_min_row.id IS NULL THEN
$o$,
                     'new', $n$  IF v_mode_row.id IS NULL OR v_app_row.id IS NULL OR v_loc_row.id IS NULL OR v_min_row.id IS NULL
     OR v_aud_row.id IS NULL OR v_ids_row.id IS NULL THEN
$n$),
  jsonb_build_object('old', $o$  IF v_new_min < 0 OR v_new_min <> trunc(v_new_min) THEN
    RETURN jsonb_build_object('error', 'invalid_agreement_min');
  END IF;
$o$,
                     'new', $n$  IF v_new_min < 0 OR v_new_min <> trunc(v_new_min) THEN
    RETURN jsonb_build_object('error', 'invalid_agreement_min');
  END IF;
  v_new_aud := CASE WHEN p_audience IS NULL THEN public.square_audience() ELSE btrim(p_audience) END;
  IF v_new_aud NOT IN ('everyone', 'listed') THEN
    RETURN jsonb_build_object('error', 'invalid_audience');
  END IF;
  v_old_ids := CASE WHEN jsonb_typeof(v_ids_row.value) = 'array' THEN v_ids_row.value ELSE '[]'::jsonb END;
  IF p_card_customer_codes IS NULL THEN
    v_new_ids := v_old_ids;
  ELSE
    SELECT array_agg(s.c ORDER BY s.c) INTO v_bad
      FROM (SELECT DISTINCT upper(btrim(x)) AS c FROM unnest(p_card_customer_codes) x WHERE btrim(coalesce(x, '')) <> '') s
     WHERE NOT EXISTS (SELECT 1 FROM public.customers cu WHERE upper(cu.customer_code) = s.c);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'unknown_customer_code', 'codes', to_jsonb(v_bad));
    END IF;
    SELECT coalesce(jsonb_agg(DISTINCT cu.id::text ORDER BY cu.id::text), '[]'::jsonb) INTO v_new_ids
      FROM public.customers cu
     WHERE upper(cu.customer_code) IN (SELECT upper(btrim(x)) FROM unnest(p_card_customer_codes) x WHERE btrim(coalesce(x, '')) <> '');
  END IF;
$n$),
  jsonb_build_object('old', $o$  PERFORM set_config('app.allow_square_settings_change', '', true);
$o$,
                     'new', $n$  IF coalesce(v_aud_row.value #>> '{}', '') IS DISTINCT FROM v_new_aud THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_aud), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_aud_row.id;
    v_changed := true;
  END IF;
  IF v_old_ids IS DISTINCT FROM v_new_ids THEN
    UPDATE public.system_settings SET value = v_new_ids, updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_ids_row.id;
    v_changed := true;
  END IF;
  PERFORM set_config('app.allow_square_settings_change', '', true);
$n$),
  jsonb_build_object('old', $o$                              'location_id', v_new_loc, 'agreement_min_jpy', v_new_min);
$o$,
                     'new', $n$                              'location_id', v_new_loc, 'agreement_min_jpy', v_new_min,
                              'audience', v_new_aud, 'card_customer_ids', v_new_ids);
$n$),
  jsonb_build_object('old', $o$                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id),
$o$,
                     'new', $n$                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id,
                             'audience', v_aud_row.value, 'card_customer_ids', v_old_ids),
$n$),
  jsonb_build_object('old', $o$          jsonb_build_object('mode', v_new_mode, 'app_id', v_new_app, 'location_id', v_new_loc,
                             'agreement_min_jpy', v_new_min),
$o$,
                     'new', $n$          jsonb_build_object('mode', v_new_mode, 'app_id', v_new_app, 'location_id', v_new_loc,
                             'agreement_min_jpy', v_new_min, 'audience', v_new_aud, 'card_customer_ids', v_new_ids),
$n$),
  jsonb_build_object('old', $o$                            'app_id', v_new_app, 'location_id', v_new_loc, 'agreement_min_jpy', v_new_min,
                            'updated_at', v_now);
$o$,
                     'new', $n$                            'app_id', v_new_app, 'location_id', v_new_loc, 'agreement_min_jpy', v_new_min,
                            'audience', v_new_aud, 'card_customer_ids', v_new_ids, 'updated_at', v_now);
$n$)
  )) LOOP
    v_n := (length(v_def) - length(replace(v_def, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN RAISE EXCEPTION 'STOP — set_square_settings anchor found % times: %', v_n, left(e ->> 'old', 120); END IF;
    v_def := replace(v_def, e ->> 'old', e ->> 'new');
  END LOOP;
  DROP FUNCTION public.set_square_settings(text, text, text, numeric, text);
  EXECUTE v_def;
END
$sqv_set$;
REVOKE ALL ON FUNCTION public.set_square_settings(text, text, text, numeric, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_square_settings(text, text, text, numeric, text, text, text[]) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. The card-offer decisions honour the allow-list (D-G04): checkout draft,
--     staff method change, the customer's own switch, and the card reservation
--     (the last stop before Square). Live md5s in each guard.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', '1a4470ed6f70bbb2e525795e7c096f80', jsonb_build_array(
  jsonb_build_object('old', $o$  v_country text;
BEGIN
$o$,
                     'new', $n$  v_country text;
  v_cust   uuid;
BEGIN
$n$),
  jsonb_build_object('old', $o$    SELECT payment_method, mode, settlement_currency, status, web_reference, upper(nullif(btrim(coalesce(country, '')), ''))
      INTO v_old, v_mode, v_cur, v_status, v_ref, v_country
$o$,
                     'new', $n$    SELECT payment_method, mode, settlement_currency, status, web_reference, upper(nullif(btrim(coalesce(country, '')), '')), customer_id
      INTO v_old, v_mode, v_cur, v_status, v_ref, v_country, v_cust
$n$),
  jsonb_build_object('old', $o$           upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), ''))
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref, v_country
$o$,
                     'new', $n$           upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), '')), customer_id
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref, v_country, v_cust
$n$),
  jsonb_build_object('old', $o$     OR (p_method = 'square' AND public.square_mode() = 'off') THEN
$o$,
                     'new', $n$     OR (p_method = 'square' AND NOT public.square_card_allowed(v_cust)) THEN
$n$)
));
SELECT pg_temp.cj_patch('public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)', 'fc1ebaf0e6804fec539a1a0f83a3c3d3', jsonb_build_array(
  jsonb_build_object('old', $o$     OR (v_method = 'square' AND public.square_mode() = 'off') THEN
$o$,
                     'new', $n$     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id)) THEN
$n$)
));
SELECT pg_temp.cj_patch('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', '2a59ac7ca310c5369f9fad32f48646d2', jsonb_build_array(
  jsonb_build_object('old', $o$  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
$o$,
                     'new', $n$  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
  IF p_method = 'square' AND NOT public.square_card_allowed(p_customer_id) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;
$n$)
));
SELECT pg_temp.cj_patch('public.reserve_square_attempt(uuid,uuid,bigint,text,text,text,boolean,text,text,text,jsonb)', 'db791046f18e34bf61b7ec1115141991', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_order.customer_id IS DISTINCT FROM p_customer_id THEN RETURN jsonb_build_object('error', 'wrong_customer'); END IF;
$o$,
                     'new', $n$  IF v_order.customer_id IS DISTINCT FROM p_customer_id THEN RETURN jsonb_build_object('error', 'wrong_customer'); END IF;
  IF NOT public.square_card_allowed(p_customer_id) THEN RETURN jsonb_build_object('error', 'card_not_offered'); END IF;
$n$)
));

-- ---------------------------------------------------------------------------
-- 11. SQV01 — the refund writer is service_role ONLY again (as 20261112100000 and
--     20261118100000 had it; 20261129110000 widened it by mistake).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_web_order_refund_issued_atomic(uuid, uuid, text, date, text, jsonb) TO service_role;

COMMENT ON TABLE public.square_sync_state IS
  'Square sync checkpoints (QC06/QC07), the last square-reconcile run (QC11) and the production preflight (D-SQV05). Keys: events:<env> {through, cursor, window_start}, refunds:<env> {through}, disputes:<env> {through}, reconcile_last_run {at, status, report}, reconcile_last_ok {at}, preflight:<env> {token, locations, location_match, events, passed, at, by}. Written by square-reconcile and square-preflight (service role) only.';

-- ---------------------------------------------------------------------------
-- 12. Self-check (structure; behaviour: development/sql/sqv-square-exception-allowlist-acceptance.sql).
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  d text;
BEGIN
  IF has_function_privilege('authenticated', 'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — SQV01: authenticated can still execute mark_web_order_refund_issued_atomic';
  END IF;
  d := pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'::regprocedure);
  IF position('exception_not_approved' IN d) = 0 OR position('lot_already_allocated' IN d) = 0
     OR position('exception_superseded' IN d) = 0 OR position('captured_at < now() - interval' IN d) > 0 THEN
    RAISE EXCEPTION 'STOP — mark_web_order_refund_issued_atomic lacks the SQV02/SQV03 record step';
  END IF;
  d := pg_get_functiondef('public.record_square_refund(text,text,text,bigint,text,timestamptz,timestamptz,jsonb)'::regprocedure);
  IF position('public.card_refund_exceptions x' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — record_square_refund does not watch approved exceptions';
  END IF;
  IF to_regprocedure('public.set_square_settings(text,text,text,numeric,text,text,text[])') IS NULL
     OR to_regprocedure('public.set_square_settings(text,text,text,numeric,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP — set_square_settings signature not as expected';
  END IF;
  IF position('square_card_allowed' IN pg_get_functiondef('public.reserve_square_attempt(uuid,uuid,bigint,text,text,text,boolean,text,text,text,jsonb)'::regprocedure)) = 0
     OR position('square_card_allowed' IN pg_get_functiondef('public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)'::regprocedure)) = 0
     OR position('square_card_allowed' IN pg_get_functiondef('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)'::regprocedure)) = 0
     OR position('square_card_allowed' IN pg_get_functiondef('public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — a card-offer writer does not call square_card_allowed';
  END IF;
  IF public.square_audience() <> 'listed' AND (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_audience') IS DISTINCT FROM 'everyone' THEN
    RAISE EXCEPTION 'STOP — square_audience is not fail-closed';
  END IF;
END
$self$;
