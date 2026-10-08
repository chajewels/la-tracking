-- Record-only (2026-10-08). Already applied on live — replaying is a no-op.
--
-- Why: 20261119100000_paidy_p04_p05 changed these three functions with
-- md5-guarded IN-PLACE patches (pg_temp.cj_patch, Bug #280). The drift audit
-- reads only CREATE FUNCTION statements, so the repo's newest copy of each was
-- the PRE-patch body. This file records the bodies exactly as live runs them
-- after release #428 (pg_get_functiondef read 2026-10-08), md5 of each equal
-- to live:
--
--   cash_order_payment_lock(uuid,uuid,boolean)       80a48f4e4fd879804dcfa9935b56eaee
--   end_paidy_checkout_attempt(uuid,uuid,text)       cf44228b8e127953116483970bbd8a5d
--   start_paidy_checkout_attempt(uuid,uuid,integer)  21e779750fff39c4ae64391fd78db569
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- cash_order_payment_lock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_payment_lock(p_cash_order_id uuid, p_ignore_paidy_row uuid DEFAULT NULL::uuid, p_ignore_attempts boolean DEFAULT false)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    -- Paidy took money the Hub has not recorded and no staff decision closed it.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_payments pp
       WHERE pp.cash_order_id = p_cash_order_id AND pp.status = 'captured'
         AND pp.id IS DISTINCT FROM p_ignore_paidy_row
         AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                          WHERE s.paidy_payment_id = pp.id AND s.confirmed_payment_id IS NOT NULL)
         -- P01 (2026-10-06): a staff note never releases it — only a full
         -- refund in Paidy's own ledger does.
         AND coalesce(pp.refund_jpy, 0) < pp.amount_jpy)
      THEN 'paidy_captured_unrecorded'
    -- P01: a Paidy capture case with no Paidy record locks its order while open.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_cases c
       WHERE c.cash_order_id = p_cash_order_id AND c.paidy_payment_row IS NULL AND c.status = 'open'
         AND c.kind IN ('captured_unrecorded','captured_no_submission','record_failed'))
      THEN 'paidy_captured_unrecorded'
    -- A Paidy submission waiting for the capture, or a Confirm claimed but not recorded.
    WHEN EXISTS (
      SELECT 1 FROM public.payment_submissions s
       WHERE s.cash_order_id = p_cash_order_id AND s.paidy_payment_id IS NOT NULL
         AND s.paidy_payment_id IS DISTINCT FROM p_ignore_paidy_row
         AND (s.status IN ('submitted','under_review') OR (s.status = 'confirmed' AND s.confirmed_payment_id IS NULL)))
      THEN 'paidy_submission_pending'
    -- An authorisation Paidy still holds that no reviewer rejected (e.g. one
    -- waiting to be filed). Past its expiry it no longer holds the order.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_payments pp
       WHERE pp.cash_order_id = p_cash_order_id AND pp.status = 'authorized'
         AND pp.id IS DISTINCT FROM p_ignore_paidy_row
         AND coalesce(pp.expires_at, pp.authorized_at + interval '30 days') > now()
         AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                          WHERE s.paidy_payment_id = pp.id AND s.status IN ('rejected','cancelled')))
      THEN 'paidy_authorized'
    -- The customer's Paidy window: open, or closed by her but not yet
    -- confirmed empty with Paidy (P04, 2026-10-08). The sweep ends it
    -- (expire_paidy_checkout_attempts) — never the clock alone.
    WHEN NOT p_ignore_attempts AND EXISTS (
      SELECT 1 FROM public.paidy_checkout_attempts a
       WHERE a.cash_order_id = p_cash_order_id AND a.status = 'open')
      THEN 'paidy_checkout_open'
    -- Square (2026-10-04, owner 3A / SQ11): a card attempt in flight, a live
    -- card hold, or captured card money not yet recorded — no other payment
    -- until it is resolved (public.square_order_unresolved). Not a paidy_*
    -- reason, so the Paidy guard trigger lets the card's own filing through;
    -- guard_provider_submission enforces it for everything else.
    WHEN public.square_order_unresolved(p_cash_order_id)
      THEN 'card_payment_unresolved'
    -- Any other payment waiting for a reviewer (one pending payment per order).
    WHEN EXISTS (
      SELECT 1 FROM public.payment_submissions s
       WHERE s.cash_order_id = p_cash_order_id AND s.paidy_payment_id IS NULL
         AND (s.status IN ('submitted','under_review') OR (s.status = 'confirmed' AND s.confirmed_payment_id IS NULL)))
      THEN 'submission_pending'
    ELSE NULL
  END
$function$;

-- ---------------------------------------------------------------------------
-- end_paidy_checkout_attempt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.end_paidy_checkout_attempt(p_attempt_id uuid, p_customer_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  -- P04 (2026-10-08): her close is NOTED, not acted on. The attempt stays
  -- open (the order stays locked) until the hourly sweep has confirmed with
  -- Paidy that nothing holds money for it (expire_paidy_checkout_attempts).
  UPDATE public.paidy_checkout_attempts
     SET customer_closed_at = coalesce(customer_closed_at, now()),
         end_reason = left(coalesce(p_reason, 'closed'), 40)
   WHERE id = p_attempt_id AND customer_id = p_customer_id AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'ended', v_n = 1);
END
$function$;

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
  -- nothing for the order (expire_paidy_checkout_attempts); the window she
  -- closed herself is replaced by the one she opens now — the lock carries
  -- over to it, nothing is released.
  PERFORM public.expire_paidy_checkout_attempts(v_order.id);
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now()
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id
     AND status = 'open' AND customer_closed_at IS NOT NULL;

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
