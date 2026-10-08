-- 20261123100000_paidy_pa01_pa02_pa03.sql
-- Paidy reassessment PA01 / PA02 / PA03 (owner brief 2026-10-08, decision
-- 16:16 JST: Paidy at cancel = REFUSE, like Square's R05 — company policy is
-- no cash refund; a refund pressed in the Paidy dashboard is an exception).
--
--   PA02  Money already given back through Paidy (any verified paidy_refunds
--         row) never comes back a second time as store credit: both cancel
--         RPCs refuse "store credit issued" (paidy_already_refunded), and a
--         Paidy-paid web order cannot be closed as "refund issued" without a
--         verified Paidy refund covering the Paidy money
--         (paidy_refund_needs_dashboard) — the twins of R05 / B01.
--         record_paidy_refund (NEW, service_role) is the ONLY writer of
--         paidy_refunds: it locks the ORDER first, then the payment, inserts
--         idempotently by refund id, raises refund_jpy monotonically, and
--         rings paidy_refund_after_credit once per refund when the order
--         already holds a cancellation credit lot — the reconciliation path
--         for a dashboard refund made AFTER credit (the Hub cannot stop the
--         click; a human voids the lot).
--   PA03  mark_web_order_refund_issued_atomic: method 'paidy' needs Paidy
--         money on the order AND verified Paidy refunds; the amount recorded
--         is LEAST(paidy money, verified refund total) and the audit carries
--         cumulative refunded + remaining obligation — never the gross.
--         Mixed payments: a non-Paidy method records only the non-Paidy money.
--   PA01  resolve_paidy_case: a capture case with NO payment row (an orphan —
--         its open case is the order's only lock) cannot be closed by
--         no_action / handled_in_paidy / released (orphan_capture_unsettled).
--         It closes through record_capture, or when paidy-reconcile verifies a
--         full refund with Paidy (refunded_in_paidy, verified).
--
-- Function bodies are patched IN PLACE from the live text behind an md5 guard
-- (Bug #280): the helper STOPS, changing nothing, if a function has moved or an
-- anchor is not found exactly once. Re-running is a no-op. Grants of patched
-- functions are untouched (CREATE OR REPLACE keeps the ACL). Live md5s read
-- 2026-10-08 16:14 JST:
--   cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)             89b5dca234e0a4c8b8316f2f69268b8c
--   terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) 0512fb205e097d5c1e2f34c964ab65bc
--   mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)          3369f10e9db3ff83317df3e2e356d35a
--   resolve_paidy_case(uuid,text,text)                                     bd8ae39af2d8fd14fd7b328c58b05bfe
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

-- ---------------------------------------------------------------------------
-- 1. record_paidy_refund — the ONLY writer of paidy_refunds (PA02 race +
--    reconciliation). Called by paidy-sync (service role) after the edge
--    function has verified the refund on Paidy's read-back (payment id,
--    capture id, whole yen, environment, order binding — owner correction 1).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_paidy_refund(
  p_refund_id text, p_paidy_payment_row uuid, p_amount_jpy numeric, p_capture_id text,
  p_refunded_at timestamptz, p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_rec    public.paidy_payments%ROWTYPE;
  v_order  public.cash_orders%ROWTYPE;
  v_new    boolean := false;
  v_total  numeric(12,2);
  v_credit numeric(12,2);
  v_bell   boolean := false;
BEGIN
  IF p_refund_id IS NULL OR btrim(p_refund_id) = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_refund_id'); END IF;
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy <> trunc(p_amount_jpy) THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_amount'); END IF;
  -- Lock the ORDER first (the cancel RPCs hold the same lock), then the payment:
  -- a refund and a cancel serialise, and a cancel that lands first sees this refund.
  SELECT o.* INTO v_order FROM public.paidy_payments pp JOIN public.cash_orders o ON o.id = pp.cash_order_id
   WHERE pp.id = p_paidy_payment_row FOR UPDATE OF o;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_rec FROM public.paidy_payments WHERE id = p_paidy_payment_row FOR UPDATE;
  IF v_rec.status <> 'captured' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_captured', 'status', v_rec.status); END IF;
  IF p_capture_id IS NOT NULL AND v_rec.capture_id IS NOT NULL AND p_capture_id <> v_rec.capture_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'capture_mismatch', 'capture_id', v_rec.capture_id);
  END IF;

  INSERT INTO public.paidy_refunds (paidy_payment_row, cash_order_id, refund_id, amount_jpy, refunded_at, payload)
  VALUES (p_paidy_payment_row, v_order.id, p_refund_id, p_amount_jpy, p_refunded_at, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (refund_id) DO NOTHING;
  v_new := FOUND;

  SELECT COALESCE(SUM(amount_jpy), 0) INTO v_total FROM public.paidy_refunds WHERE paidy_payment_row = p_paidy_payment_row;
  IF v_total > v_rec.amount_jpy THEN
    -- More refunded than captured can only be a Paidy-side anomaly: keep the
    -- rows (they are Paidy's facts) but say so; nothing else is written.
    RETURN jsonb_build_object('ok', false, 'error', 'refund_exceeds_capture', 'refunded_jpy', v_total, 'captured_jpy', v_rec.amount_jpy, 'inserted', v_new);
  END IF;
  -- Monotonic: the ledger total never lowers a previously observed figure.
  UPDATE public.paidy_payments SET refund_jpy = v_total, updated_at = now()
   WHERE id = p_paidy_payment_row AND (refund_jpy IS NULL OR refund_jpy < v_total);

  -- Reconciliation (owner correction 2): a refund landing on an order that
  -- ALREADY holds a cancellation credit lot rings paidy_refund_after_credit
  -- once per refund — a human voids the lot (Settings → Store Credit).
  SELECT COALESCE(SUM(original_amount), 0) INTO v_credit FROM public.store_credit_lots l
   WHERE l.source_cash_order_id = v_order.id AND l.source_type = 'cancelled_cash' AND l.status <> 'voided';
  IF v_new AND v_credit > 0
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'paidy_refund_after_credit' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('paidy_refund_after_credit', 'Paidy refund on an order that already has store credit',
            COALESCE(v_order.web_reference, v_order.invoice_number) || ' · ¥' || p_amount_jpy::bigint || ' refunded in the Paidy dashboard (' || p_refund_id
              || ') but ¥' || v_credit::bigint || ' store credit was already issued on cancellation. Void the credit lot (Settings → Store Credit) or the customer is compensated twice.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('refund_id', p_refund_id, 'paidy_payment_id', v_rec.paidy_payment_id, 'cash_order_id', v_order.id,
                               'refund_jpy', p_amount_jpy, 'credit_jpy', v_credit, 'refunded_total_jpy', v_total));
    v_bell := true;
  END IF;

  RETURN jsonb_build_object('ok', true, 'inserted', v_new, 'refunded_total_jpy', v_total,
                            'captured_jpy', v_rec.amount_jpy, 'remaining_jpy', v_rec.amount_jpy - v_total,
                            'credit_already_issued_jpy', v_credit, 'bell', v_bell);
END
$function$;
REVOKE ALL ON FUNCTION public.record_paidy_refund(text, uuid, numeric, text, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_paidy_refund(text, uuid, numeric, text, timestamptz, jsonb) TO service_role;

-- paidy_refunds.refund_id must be unique for the idempotent insert above.
DO $d$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'paidy_refunds' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(refund_id)%') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_paidy_refunds_refund_id ON public.paidy_refunds (refund_id);
  END IF;
END
$d$;

-- ---------------------------------------------------------------------------
-- 2. PA02 — cancel_cash_order_atomic: refuse credit when Paidy already refunded.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', '89b5dca234e0a4c8b8316f2f69268b8c', jsonb_build_array(
  jsonb_build_object('old', $o$  v_card_refunded boolean := false;
BEGIN$o$, 'new', $n$  v_card_refunded boolean := false;
  v_paidy_refunded numeric(12,2) := 0;
BEGIN$n$),
  jsonb_build_object('old', $o$  IF NOT p_preview AND v_card_refunded AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_already_refunded: money on this order was already refunded through Square — it cannot be issued again as store credit' USING ERRCODE='P0001';
  END IF;$o$, 'new', $n$  IF NOT p_preview AND v_card_refunded AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_already_refunded: money on this order was already refunded through Square — it cannot be issued again as store credit' USING ERRCODE='P0001';
  END IF;
  -- PA02 (owner 2026-10-08, refuse): money already given back through Paidy
  -- (a verified paidy_refunds row — an exception to the no-cash-refund policy)
  -- never comes back again as store credit; staff finish it by hand.
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_cash_order_id;
  IF NOT p_preview AND v_paidy_refunded > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'paidy_already_refunded: ¥% of this order was already refunded in the Paidy dashboard — it cannot be issued again as store credit', v_paidy_refunded::bigint USING ERRCODE='P0001';
  END IF;$n$),
  jsonb_build_object('old', $o$      'card_refunded', v_card_refunded,
      'currency', v_currency, 'money_received', v_money_received,$o$, 'new', $n$      'card_refunded', v_card_refunded,
      'paidy_refunded_jpy', v_paidy_refunded,
      'currency', v_currency, 'money_received', v_money_received,$n$)
));

-- ---------------------------------------------------------------------------
-- 3. PA02 + PA03 — terminate_web_order_atomic.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '0512fb205e097d5c1e2f34c964ab65bc', jsonb_build_array(
  jsonb_build_object('old', $o$  v_card_refunded boolean := false;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;$o$, 'new', $n$  v_card_refunded boolean := false;
  v_paidy_paid numeric(12,2) := 0; v_paidy_refunded numeric(12,2) := 0;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;$n$),
  jsonb_build_object('old', $o$    IF NOT p_preview AND v_money_received > 0 AND p_refund_status = 'refund_issued' AND v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_refund_needs_square',
        'status', v_status);
    END IF;$o$, 'new', $n$    IF NOT p_preview AND v_money_received > 0 AND p_refund_status = 'refund_issued' AND v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_refund_needs_square',
        'status', v_status);
    END IF;
    -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
    -- dashboard, and only a refund the Hub has read back from Paidy counts.
    -- "Refund issued" on a Paidy-paid order needs verified Paidy refunds that
    -- cover the Paidy money; otherwise choose "refund pending", refund in
    -- Paidy, and "Mark refund issued" once the Hub has recorded it.
    SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid FROM public.cash_payments
     WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
    SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded FROM public.paidy_refunds r
     WHERE r.cash_order_id = p_order_id;
    IF NOT p_preview AND v_paidy_paid > 0 AND p_refund_status = 'refund_issued' AND v_paidy_refunded < v_paidy_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_refund_needs_dashboard',
        'status', v_status, 'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;$n$),
  jsonb_build_object('old', $o$    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_refunded THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_already_refunded',
        'status', v_status);
    END IF;$o$, 'new', $n$    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_refunded THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_already_refunded',
        'status', v_status);
    END IF;
    -- PA02 (owner 2026-10-08, refuse): money already given back through Paidy
    -- (a verified paidy_refunds row — an exception to the no-cash-refund
    -- policy) can never come back a second time as store credit. Staff see
    -- the reason and use "refund pending" → "Mark refund issued" instead.
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_paidy_refunded > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_already_refunded',
        'status', v_status, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;$n$),
  jsonb_build_object('old', $o$      'paid_by_card', v_card_paid,
      'card_refunded', v_card_refunded,
      'refund_decision_required', (v_money_received > 0),$o$, 'new', $n$      'paid_by_card', v_card_paid,
      'card_refunded', v_card_refunded,
      'paid_by_paidy', (v_paidy_paid > 0),
      'paidy_paid_jpy', v_paidy_paid,
      'paidy_refunded_jpy', v_paidy_refunded,
      'refund_decision_required', (v_money_received > 0),$n$)
));

-- ---------------------------------------------------------------------------
-- 4. PA03 — mark_web_order_refund_issued_atomic: Paidy bound to verified
--    refunds; cumulative + remaining recorded; mixed payments record only the
--    non-Paidy money under a non-Paidy method.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)', '3369f10e9db3ff83317df3e2e356d35a', jsonb_build_array(
  jsonb_build_object('old', $o$  v_card_refunded numeric(12,2);
BEGIN$o$, 'new', $n$  v_card_refunded numeric(12,2);
  v_paidy_paid numeric(12,2) := 0;
  v_paidy_refunded numeric(12,2) := 0;
  v_paidy_remaining numeric(12,2) := 0;
BEGIN$n$),
  jsonb_build_object('old', $o$  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds WHERE cash_order_id = p_order_id AND status = 'COMPLETED';
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;$o$, 'new', $n$  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds WHERE cash_order_id = p_order_id AND status = 'COMPLETED';
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;
  -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
  -- dashboard and counts only once the Hub has read the refund back from
  -- Paidy (paidy_refunds, written by record_paidy_refund). Method 'paidy'
  -- needs Paidy money on the order and at least one verified refund; the
  -- amount recorded is the verified total, capped at the Paidy money, and the
  -- audit carries cumulative refunded + remaining — never the gross. A
  -- non-Paidy method on a mixed order records only the non-Paidy money.
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_order_id;
  IF v_method = 'paidy' AND v_paidy_paid <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_paidy');
  END IF;
  IF v_method = 'paidy' THEN
    IF v_paidy_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_verified_paidy_refund', 'paidy_paid_jpy', v_paidy_paid);
    END IF;
    v_amount := LEAST(v_paidy_paid, v_paidy_refunded);
    v_paidy_remaining := GREATEST(0, v_paidy_paid - v_paidy_refunded);
  ELSIF v_paidy_paid > 0 THEN
    IF v_amount - v_paidy_paid <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_paidy');
    END IF;
    v_amount := v_amount - v_paidy_paid;
  END IF;$n$),
  jsonb_build_object('old', $o$          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),$o$, 'new', $n$          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_total_jpy', v_paidy_refunded,
                             'paidy_remaining_jpy', v_paidy_remaining,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),$n$),
  jsonb_build_object('old', $o$  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));$o$, 'new', $n$  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));$n$)
));

-- ---------------------------------------------------------------------------
-- 5. PA01 — resolve_paidy_case: an orphan capture is never released by a note.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.resolve_paidy_case(uuid,text,text)', 'bd8ae39af2d8fd14fd7b328c58b05bfe', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_case.status <> 'open' THEN RETURN jsonb_build_object('error', 'already_resolved'); END IF;
$o$, 'new', $n$  IF v_case.status <> 'open' THEN RETURN jsonb_build_object('error', 'already_resolved'); END IF;

  -- PA01 (owner brief 2026-10-08): a capture case with NO payment row is an
  -- orphan — Paidy took money the Hub has no receipt for, and this open case
  -- is the order's only lock (cash_order_payment_lock). A note never settles
  -- it: it closes through record_capture once a Hub payment row exists, or
  -- when paidy-reconcile has verified with Paidy that the capture was fully
  -- refunded (resolution refunded_in_paidy, written by the sweep itself).
  IF v_case.paidy_payment_row IS NULL
     AND v_case.kind IN ('captured_unrecorded','captured_no_submission','record_failed')
     AND p_resolution IN ('no_action','handled_in_paidy','released','refunded_in_paidy','end_submission') THEN
    RETURN jsonb_build_object('error', 'orphan_capture_unsettled', 'paidy_payment_id', v_case.paidy_payment_id);
  END IF;
$n$)
));

-- ---------------------------------------------------------------------------
-- 6. PA01 — the sweep's verified close of an orphan capture case. Service role
--    only; called by paidy-reconcile AFTER it read the payment back from Paidy
--    and saw the capture fully refunded. Nothing else may resolve an orphan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_orphan_paidy_case_verified(p_case_id uuid, p_refunded_jpy numeric, p_captured_jpy numeric, p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_case public.paidy_cases%ROWTYPE;
BEGIN
  SELECT * INTO v_case FROM public.paidy_cases WHERE id = p_case_id FOR UPDATE;
  IF v_case.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_case.status <> 'open' THEN RETURN jsonb_build_object('error', 'already_resolved'); END IF;
  IF v_case.paidy_payment_row IS NOT NULL THEN RETURN jsonb_build_object('error', 'not_an_orphan'); END IF;
  IF p_captured_jpy IS NULL OR p_captured_jpy <= 0 OR p_refunded_jpy IS NULL OR p_refunded_jpy < p_captured_jpy THEN
    RETURN jsonb_build_object('error', 'not_fully_refunded', 'captured_jpy', p_captured_jpy, 'refunded_jpy', p_refunded_jpy);
  END IF;
  UPDATE public.paidy_cases
     SET status = 'resolved', resolved_at = now(), resolved_by = NULL,
         resolution = 'refunded_in_paidy',
         resolution_note = 'Verified by paidy-reconcile: Paidy reports the capture (¥' || p_captured_jpy::bigint || ') fully refunded (¥' || p_refunded_jpy::bigint || ').',
         detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('verified_refund', COALESCE(p_payload, '{}'::jsonb), 'verified_at', now())
   WHERE id = p_case_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('paidy_case', p_case_id, 'paidy_case_resolved',
          jsonb_build_object('kind', v_case.kind, 'paidy_payment_id', v_case.paidy_payment_id, 'cash_order_id', v_case.cash_order_id,
                             'resolution', 'refunded_in_paidy', 'verified_by', 'paidy-reconcile',
                             'captured_jpy', p_captured_jpy, 'refunded_jpy', p_refunded_jpy), NULL);
  RETURN jsonb_build_object('ok', true, 'case_id', p_case_id);
END
$function$;
REVOKE ALL ON FUNCTION public.resolve_orphan_paidy_case_verified(uuid, numeric, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_orphan_paidy_case_verified(uuid, numeric, numeric, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Self-checks: the patched bodies carry the new text; nothing else changed.
-- ---------------------------------------------------------------------------
DO $c$
DECLARE v text;
BEGIN
  v := pg_get_functiondef(to_regprocedure('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'));
  IF position('paidy_already_refunded' IN v) = 0 OR position('card_already_refunded' IN v) = 0 THEN RAISE EXCEPTION 'self-check cancel_cash_order_atomic failed'; END IF;
  v := pg_get_functiondef(to_regprocedure('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'));
  IF position('paidy_already_refunded' IN v) = 0 OR position('paidy_refund_needs_dashboard' IN v) = 0 OR position('card_refund_needs_square' IN v) = 0 THEN RAISE EXCEPTION 'self-check terminate_web_order_atomic failed'; END IF;
  v := pg_get_functiondef(to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text)'));
  IF position('no_verified_paidy_refund' IN v) = 0 OR position('no_completed_card_refund' IN v) = 0 THEN RAISE EXCEPTION 'self-check mark_web_order_refund_issued_atomic failed'; END IF;
  v := pg_get_functiondef(to_regprocedure('public.resolve_paidy_case(uuid,text,text)'));
  IF position('orphan_capture_unsettled' IN v) = 0 THEN RAISE EXCEPTION 'self-check resolve_paidy_case failed'; END IF;
  IF to_regprocedure('public.record_paidy_refund(text,uuid,numeric,text,timestamptz,jsonb)') IS NULL THEN RAISE EXCEPTION 'self-check record_paidy_refund missing'; END IF;
  IF to_regprocedure('public.resolve_orphan_paidy_case_verified(uuid,numeric,numeric,jsonb)') IS NULL THEN RAISE EXCEPTION 'self-check resolve_orphan_paidy_case_verified missing'; END IF;
END
$c$;