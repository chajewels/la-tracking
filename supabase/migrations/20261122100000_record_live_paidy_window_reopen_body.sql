-- Record-only (2026-10-08). Already applied on live — replaying is a no-op.
--
-- Why: 20261121100000_paidy_window_reopen patched start_paidy_checkout_attempt
-- with an md5-guarded IN-PLACE patch (pg_temp.cj_patch, Bug #280). The drift
-- audit reads only CREATE FUNCTION statements, so the repo's newest copy
-- (20261120100000) was the PRE-patch body. This file records the body exactly
-- as live runs it after release #432 (pg_get_functiondef read 2026-10-08,
-- after Lovable applied the patch), md5 equal to live:
--
--   start_paidy_checkout_attempt(uuid,uuid,integer)  0ab389929a0e53cf8a2980a9dc2b4935
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps the function's live ACL
-- (service_role only, re-asserted by 20261121100000).

-- ---------------------------------------------------------------------------
-- start_paidy_checkout_attempt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_paidy_checkout_attempt(p_cash_order_id uuid, p_customer_id uuid, p_ttl_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_lock    text;
  v_attempt public.paidy_checkout_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment');
  END IF;
  -- The customer chose how to pay at checkout (2026-10-05, owner C1): a
  -- website order takes Paidy only when Paidy is its method; staff change it.
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'paidy' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' OR v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0
     OR v_order.remaining_balance <= 0 OR v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'paidy_not_offered');
  END IF;

  -- P04 (2026-10-08): a timed-out window ends only when Paidy may hold
  -- nothing for the order (expire_paidy_checkout_attempts); ANY open window
  -- of hers (closed, or left open in a lost tab — QA 2026-10-08) is replaced
  -- by the one she opens now — the lock carries over to it, nothing is
  -- released.
  PERFORM public.expire_paidy_checkout_attempts(v_order.id);
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now(),
         end_reason = coalesce(end_reason, 'replaced')
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id
     AND status = 'open';

  v_lock := public.cash_order_payment_lock(v_order.id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', v_lock);
  END IF;

  BEGIN
    INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, amount_jpy, expires_at)
    VALUES (v_order.id, p_customer_id, v_order.remaining_balance,
            now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 30), 60))))
    RETURNING * INTO v_attempt;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', 'paidy_checkout_open');
  END;
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'expires_at', v_attempt.expires_at,
                            'amount_jpy', v_attempt.amount_jpy);
END
$function$;
