-- Square L2–L8 hardening (2026-10-09, eighth release). docs/SQUARE.md "L2–L8".
-- Project doc: claude/square-golive-countercheck-2026-10-09-evening.md (the Low items).
--
--   L3  apply_square_payment_state: square_payments.refund_jpy never goes down (a later
--       payment.updated without refunded_money used to write 0 over a known refund).
--   L4  one lock order for a card attempt: the ATTEMPT first. close_square_attempt_atomic
--       locked the order before the attempt (file_square_authorization_atomic: attempt →
--       order → payment); apply_square_payment_state now locks the attempt before the
--       payment row it later updates the attempt from.
--   L2  record_square_dispute refuses a dispute it cannot read as positive whole yen
--       (bad_amount / bad_currency / parent_mismatch) and rings ONE card_dispute_unrecorded
--       bell per (dispute, reason) — never stores a figure the Hub could not read.
--   L5  a signed-in caller cannot move remaining_balance / total_paid of a cash order while
--       a card or Paidy payment holds it (new trigger guard_cash_order_balance_during_hold;
--       total / discount / shipping were already guarded).
--   L6  "Mark refund issued — card": the card figure is capped per payment at the money
--       RECORDED on the order (square_order_card_refund_recordable_jpy), and an order paid
--       partly by card and partly another way can be marked a second time for the other
--       part (or for a later completed Square refund) — each part once, never the gross.
--   L7  file_square_authorization_atomic: a hold filed on an attempt that was already
--       closed says the Hub voids it automatically (the edge does it; bell if it fails).
--
--   Every patch starts from the live text behind an md5 guard (Bug #280); no comment line
--   inside any patch anchor or new text (Lovable's runner drops such lines). A re-run is a
--   no-op.

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

-- L3 + L4 -------------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,text,text,jsonb,jsonb,text,uuid)', 'eeed3c3ed1ba50d30c26dcb90606e252', jsonb_build_array(
  jsonb_build_object('old', $o$   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
$o$,
                     'new', $n$   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  PERFORM 1 FROM public.square_card_attempts a
   WHERE a.id = (SELECT attempt_id FROM public.square_payments WHERE square_payment_id = p_square_payment_id)
      OR a.reference = (SELECT reference FROM public.square_payments WHERE square_payment_id = p_square_payment_id)
   ORDER BY a.id FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
$n$),
  jsonb_build_object('old', $o$         refund_jpy = greatest(coalesce(p_refunded_jpy, 0), 0),
$o$,
                     'new', $n$         refund_jpy = greatest(coalesce(p_refunded_jpy, 0), coalesce(refund_jpy, 0), 0),
$n$)
));

-- L4 ------------------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.close_square_attempt_atomic(uuid,text)', '706dca83c7f28da36ca00fbf80ea578e', jsonb_build_array(
  jsonb_build_object('old', $o$  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id;
  IF v_att.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders WHERE id = v_att.cash_order_id FOR UPDATE;
  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id FOR UPDATE;
$o$,
                     'new', $n$  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_att.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders WHERE id = v_att.cash_order_id FOR UPDATE;
$n$)
));

-- L2 ------------------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.record_square_dispute(text,text,text,text,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb)', '1fe4414de85e291a25adb50b65df0115', jsonb_build_array(
  jsonb_build_object('old', $o$  v_st    text := upper(coalesce(p_state, 'UNKNOWN'));
$o$,
                     'new', $n$  v_st    text := upper(coalesce(p_state, 'UNKNOWN'));
  v_refuse text := NULL;
$n$),
  jsonb_build_object('old', $o$  SELECT * INTO v_old FROM public.square_disputes WHERE square_dispute_id = p_dispute_id FOR UPDATE;
$o$,
                     'new', $n$  SELECT * INTO v_old FROM public.square_disputes WHERE square_dispute_id = p_dispute_id FOR UPDATE;
  IF coalesce(p_amount_jpy, 0) <= 0 THEN v_refuse := 'bad_amount';
  ELSIF upper(coalesce(p_payload -> 'amount_money' ->> 'currency', '')) <> 'JPY' THEN v_refuse := 'bad_currency';
  ELSIF (p_payload -> 'amount_money' ->> 'amount') IS DISTINCT FROM p_amount_jpy::text THEN v_refuse := 'bad_amount';
  ELSIF v_old.id IS NOT NULL AND v_old.square_payment_id <> p_square_payment_id THEN v_refuse := 'parent_mismatch';
  END IF;
  IF v_refuse IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                    WHERE n.type = 'card_dispute_unrecorded' AND n.metadata ->> 'dispute_id' = p_dispute_id AND n.metadata ->> 'error' = v_refuse) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_dispute_unrecorded', 'Square dispute NOT recorded — needs a look',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · Square dispute ' || p_dispute_id || ' (' || lower(v_st) || ', '
                || coalesce(p_payload -> 'amount_money' ->> 'amount', coalesce(p_amount_jpy, 0)::text) || ' ' || coalesce(p_payload -> 'amount_money' ->> 'currency', '?')
                || ') was refused: ' || v_refuse
                || CASE v_refuse
                     WHEN 'parent_mismatch' THEN ' — this dispute id is already recorded on payment ' || v_old.square_payment_id || '.'
                     WHEN 'bad_currency' THEN ' — not a yen dispute.'
                     ELSE ' — no positive whole-yen amount the Hub could read.' END
                || ' The Hub ledger was not changed, so this order is NOT marked as disputed: do not refund it or issue store credit on it until the dispute is checked in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'dispute_id', p_dispute_id,
                                 'state', v_st, 'error', v_refuse, 'amount_jpy', p_amount_jpy, 'test', v_sq.test));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', v_refuse);
  END IF;
$n$)
));

-- L7 ------------------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.file_square_authorization_atomic(uuid,text,bigint,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,jsonb,text,timestamp with time zone,jsonb,date,text,text,text,text)', 'a38f0098901621b0e049f4a80042dd17', jsonb_build_array(
  jsonb_build_object('old', $o$                || '). Open Website → Card payments: record it or void it in the Square Dashboard.',
$o$,
                     'new', $n$                || CASE WHEN left(v_reason, 8) = 'attempt_'
                        THEN '). Its card attempt was already closed, so the Hub voids this hold automatically. A "Card hold could not be voided" bell follows only if that fails.'
                        ELSE '). Open Website → Card payments: record it or void it in the Square Dashboard.' END,
$n$)
));

-- L6 ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_order_card_refund_recordable_jpy(p_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $f$
  SELECT coalesce(sum(least(x.recorded, greatest(0, x.done - (x.captured - x.recorded)))), 0)::numeric
    FROM (SELECT sum(r.amount_jpy) AS done,
                 max(coalesce(sp.captured_amount_jpy, round(sp.amount_jpy)::bigint)) AS captured,
                 max(cp.amount_paid) AS recorded
            FROM public.square_refunds r
            JOIN public.square_payments sp ON sp.id = r.square_payment_row
            JOIN public.cash_payments cp ON cp.id = sp.cash_payment_id AND cp.voided_at IS NULL
           WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED'
           GROUP BY sp.id) x
$f$;
REVOKE ALL ON FUNCTION public.square_order_card_refund_recordable_jpy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_order_card_refund_recordable_jpy(uuid) TO service_role;

SELECT pg_temp.cj_patch('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'd31a247c532e2c741d4fae702fd05cf5', jsonb_build_array(
  jsonb_build_object('old', $o$  v_card_disputed numeric(12,2) := 0;
$o$,
                     'new', $n$  v_card_disputed numeric(12,2) := 0;
  v_further boolean := false;
  v_marked_card numeric(12,2) := 0;
  v_marked_noncard boolean := false;
  v_marked_exc boolean := false;
$n$),
  jsonb_build_object('old', $o$  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
     ORDER BY a.created_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v_prev ->> 'method' = v_method THEN
$o$,
                     'new', $n$  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
       AND a.new_value_json ->> 'method' = v_method
     ORDER BY a.created_at DESC LIMIT 1;
    SELECT coalesce(sum((a.new_value_json ->> 'amount')::numeric) FILTER (WHERE a.new_value_json ->> 'method' = 'card'), 0),
           coalesce(bool_or(a.new_value_json ->> 'method' IN ('bank_transfer', 'paidy', 'cash', 'other')), false),
           coalesce(bool_or(a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception')), false)
      INTO v_marked_card, v_marked_noncard, v_marked_exc
      FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued';
    v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                            WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
    SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
      FROM public.cash_payments
     WHERE cash_order_id = p_order_id AND voided_at IS NULL
       AND COALESCE(payment_method, '') <> 'square'
       AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
    IF v_method = 'card' THEN
      v_further := NOT v_marked_exc AND public.square_order_card_refund_recordable_jpy(p_order_id) > v_marked_card + 0.005;
    ELSIF v_method IN ('bank_transfer', 'paidy', 'cash', 'other') THEN
      v_further := v_prev IS NULL AND NOT v_marked_noncard AND v_card_paid AND v_noncard > 0;
    END IF;
    IF NOT v_further AND v_prev IS NOT NULL THEN
$n$),
  jsonb_build_object('old', $o$  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
$o$,
                     'new', $n$  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' AND NOT v_further THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
$n$),
  jsonb_build_object('old', $o$  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(LEAST(x.done, x.cap)), 0) INTO v_card_refunded
      FROM (SELECT SUM(r.amount_jpy) AS done,
                   MAX(COALESCE(sp.captured_amount_jpy, round(sp.amount_jpy)::bigint)) AS cap
              FROM public.square_refunds r
              JOIN public.square_payments sp ON sp.id = r.square_payment_row
             WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED' AND sp.cash_payment_id IS NOT NULL
             GROUP BY sp.id) x;
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;
$o$,
                     'new', $n$  IF v_method = 'card' THEN
    v_card_refunded := public.square_order_card_refund_recordable_jpy(p_order_id);
    IF v_card_refunded - v_marked_card <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := v_card_refunded - v_marked_card;
  END IF;
$n$),
  jsonb_build_object('old', $o$  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('bank_transfer_exception', 'store_credit_exception') THEN
$o$,
                     'new', $n$  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') THEN
$n$),
  jsonb_build_object('old', $o$                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
$o$,
                     'new', $n$                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'further_mark', v_further, 'card_marked_before_jpy', v_marked_card,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
$n$),
  jsonb_build_object('old', $o$                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
$o$,
                     'new', $n$                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'further_mark', v_further,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
$n$)
));

-- L5 ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_cash_order_balance_during_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $f$
DECLARE v_lock text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.remaining_balance IS NOT DISTINCT FROM OLD.remaining_balance
     OR NEW.total_paid IS DISTINCT FROM OLD.total_paid THEN
    RETURN NEW;
  END IF;
  v_lock := public.cash_order_payment_lock(NEW.id);
  IF v_lock LIKE 'paidy%' THEN
    RAISE EXCEPTION 'paidy_in_progress: % — this order is being paid with Paidy, so its balance cannot be edited. Reject the Paidy payment first.', v_lock
      USING ERRCODE = 'P0001';
  END IF;
  IF v_lock = 'card_payment_unresolved' THEN
    RAISE EXCEPTION 'card_payment_unresolved — this order has a card payment waiting for Confirm, Reject or recording, so its balance cannot be edited. Resolve the card payment first.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION public.guard_cash_order_balance_during_hold() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_cash_order_balance_during_hold ON public.cash_orders;
CREATE TRIGGER trg_guard_cash_order_balance_during_hold
  BEFORE UPDATE OF remaining_balance ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_order_balance_during_hold();

-- Self-check --------------------------------------------------------------------------
DO $self$
DECLARE
  d text;
BEGIN
  d := pg_get_functiondef('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)'::regprocedure);
  IF position('coalesce(refund_jpy, 0), 0)' IN d) = 0 OR position('FROM public.square_card_attempts a' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — L3/L4 apply not complete';
  END IF;
  IF position('square_card_attempts' IN d) > position('FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE' IN d) THEN
    RAISE EXCEPTION 'STOP — L4 apply lock order wrong';
  END IF;
  d := pg_get_functiondef('public.close_square_attempt_atomic(uuid,text)'::regprocedure);
  IF position('square_card_attempts WHERE id = p_attempt_id FOR UPDATE' IN d) = 0
     OR position('square_card_attempts WHERE id = p_attempt_id FOR UPDATE' IN d) > position('cash_orders WHERE id = v_att.cash_order_id FOR UPDATE' IN d) THEN
    RAISE EXCEPTION 'STOP — L4 close not complete';
  END IF;
  d := pg_get_functiondef('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)'::regprocedure);
  IF position('card_dispute_unrecorded' IN d) = 0 OR position('bad_currency' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — L2 not complete';
  END IF;
  d := pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'::regprocedure);
  IF position('square_order_card_refund_recordable_jpy' IN d) = 0 OR position('further_mark' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — L6 not complete';
  END IF;
  d := pg_get_functiondef('public.file_square_authorization_atomic(uuid,text,bigint,text,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,timestamptz,jsonb,date,text,text,text,text)'::regprocedure);
  IF position('voids this hold automatically' IN d) = 0 THEN
    RAISE EXCEPTION 'STOP — L7 not complete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_cash_order_balance_during_hold'
                  AND tgrelid = 'public.cash_orders'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP — L5 trigger missing';
  END IF;
  IF has_function_privilege('anon', 'public.square_order_card_refund_recordable_jpy(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.square_order_card_refund_recordable_jpy(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_cash_order_balance_during_hold()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_cash_order_balance_during_hold()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.file_square_authorization_atomic(uuid,text,bigint,text,text,text,text,text,timestamptz,timestamptz,text,jsonb,text,timestamptz,jsonb,date,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.close_square_attempt_atomic(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — grants changed';
  END IF;
END
$self$;
