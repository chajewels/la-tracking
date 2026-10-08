-- 20261119100000_paidy_p04_p05.sql
-- Paidy QA/QC reassessment (2026-10-06), owner answers 2026-10-08:
--
-- P04  Closing the Paidy window never unlocks the order by itself. Her close
--      is NOTED (customer_closed_at); the attempt stays open — and the order
--      stays locked — until the hourly sweep confirms with Paidy that nothing
--      holds money for it (expire_paidy_checkout_attempts). She may open Paidy
--      again herself: the new window replaces the one she closed.
-- P05  customers.family_name / given_name: Paidy gets the buyer's name as two
--      fields entered by her (or staff), never a guess from full_name.
--
-- md5-guarded in-place patches of the LIVE bodies (read 2026-10-08):
--   cash_order_payment_lock(uuid,uuid,boolean)   35d820e8e8c5adb8499e73aad93e4454
--   end_paidy_checkout_attempt(uuid,uuid,text)   f6e046e27cb60edf986a4ae5e4c25e64
--   start_paidy_checkout_attempt(uuid,uuid,integer) cc183390d587af5b8decc4eec77ef708
-- Signatures unchanged; grants re-asserted to the live ACL (service_role only).
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_checkout_attempts
  ADD COLUMN IF NOT EXISTS customer_closed_at timestamptz;
COMMENT ON COLUMN public.paidy_checkout_attempts.customer_closed_at IS
  'P04: when the customer reported the Paidy window closed/rejected. Noted only — the attempt ends when expire_paidy_checkout_attempts confirms nothing holds money.';

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS family_name text,
  ADD COLUMN IF NOT EXISTS given_name text;
COMMENT ON COLUMN public.customers.family_name IS 'P05 (2026-10-08): buyer family name as she entered it; Paidy buyer.name1 = family + given.';
COMMENT ON COLUMN public.customers.given_name IS 'P05 (2026-10-08): buyer given name as she entered it.';

-- P04: the one way an open Paidy window ends without a filing. Only when
-- the window has timed out AND Paidy may hold nothing for the order AND no
-- Paidy notification received since it opened is still waiting.
CREATE OR REPLACE FUNCTION public.expire_paidy_checkout_attempts(p_cash_order_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.paidy_checkout_attempts a
     SET status = 'expired', ended_at = now(), end_reason = coalesce(a.end_reason, 'timeout')
   WHERE a.status = 'open' AND a.expires_at <= now()
     AND (p_cash_order_id IS NULL OR a.cash_order_id = p_cash_order_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_payments pp
        WHERE pp.cash_order_id = a.cash_order_id
          AND (pp.status = 'captured'
               OR (pp.status = 'authorized'
                   AND coalesce(pp.expires_at, pp.authorized_at + interval '30 days') > now()
                   AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                                    WHERE s.paidy_payment_id = pp.id AND s.status IN ('rejected','cancelled')))))
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_webhook_events e
        WHERE e.processed_at IS NULL AND e.received_at >= a.started_at
          AND coalesce(e.last_error, '') <> 'other_environment');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;
REVOKE ALL ON FUNCTION public.expire_paidy_checkout_attempts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_paidy_checkout_attempts(uuid) TO service_role;

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

-- P04a. The lock: an open window holds the order until the sweep ends it,
-- never the clock alone.
SELECT pg_temp.cj_patch('public.cash_order_payment_lock(uuid,uuid,boolean)', '35d820e8e8c5adb8499e73aad93e4454', jsonb_build_array(
  jsonb_build_object('old', $o$    -- The customer's Paidy window is open right now.
    WHEN NOT p_ignore_attempts AND EXISTS (
      SELECT 1 FROM public.paidy_checkout_attempts a
       WHERE a.cash_order_id = p_cash_order_id AND a.status = 'open' AND a.expires_at > now())
$o$, 'new', $n$    -- The customer's Paidy window: open, or closed by her but not yet
    -- confirmed empty with Paidy (P04, 2026-10-08). The sweep ends it
    -- (expire_paidy_checkout_attempts) — never the clock alone.
    WHEN NOT p_ignore_attempts AND EXISTS (
      SELECT 1 FROM public.paidy_checkout_attempts a
       WHERE a.cash_order_id = p_cash_order_id AND a.status = 'open')
$n$)));

-- P04b. Her close is noted; the attempt (and the lock) stays until the sweep.
SELECT pg_temp.cj_patch('public.end_paidy_checkout_attempt(uuid,uuid,text)', 'f6e046e27cb60edf986a4ae5e4c25e64', jsonb_build_array(
  jsonb_build_object('old', $o$  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now(), end_reason = left(coalesce(p_reason, 'closed'), 40)
   WHERE id = p_attempt_id AND customer_id = p_customer_id AND status = 'open';
$o$, 'new', $n$  -- P04 (2026-10-08): her close is NOTED, not acted on. The attempt stays
  -- open (the order stays locked) until the hourly sweep has confirmed with
  -- Paidy that nothing holds money for it (expire_paidy_checkout_attempts).
  UPDATE public.paidy_checkout_attempts
     SET customer_closed_at = coalesce(customer_closed_at, now()),
         end_reason = left(coalesce(p_reason, 'closed'), 40)
   WHERE id = p_attempt_id AND customer_id = p_customer_id AND status = 'open';
$n$)));

-- P04c. Start: a timed-out window ends only through the same guarded path;
-- the window she closed herself is replaced by the new one she opens.
SELECT pg_temp.cj_patch('public.start_paidy_checkout_attempt(uuid,uuid,integer)', 'cc183390d587af5b8decc4eec77ef708', jsonb_build_array(
  jsonb_build_object('old', $o$  UPDATE public.paidy_checkout_attempts
     SET status = 'expired', ended_at = now(), end_reason = 'timeout'
   WHERE cash_order_id = v_order.id AND status = 'open' AND expires_at <= now();
$o$, 'new', $n$  -- P04 (2026-10-08): a timed-out window ends only when Paidy may hold
  -- nothing for the order (expire_paidy_checkout_attempts); the window she
  -- closed herself is replaced by the one she opens now — the lock carries
  -- over to it, nothing is released.
  PERFORM public.expire_paidy_checkout_attempts(v_order.id);
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now()
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id
     AND status = 'open' AND customer_closed_at IS NOT NULL;
$n$)));

REVOKE ALL ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.end_paidy_checkout_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_paidy_checkout_attempt(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) TO service_role;
