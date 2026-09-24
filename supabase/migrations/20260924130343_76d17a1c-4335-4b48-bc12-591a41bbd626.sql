-- SECURITY DEFINER functions that anyone could call. ACL-only; no function
-- body changes.
--
-- Owner acceptance run 2026-09-24, finding 7. The security linter went
-- 104 -> 105 during the reserve-first A2 apply. A2's own objects add no
-- finding (its one grant, email_delivery_report TO authenticated, is unchanged
-- from 20260913100000 and the body gates staff roles itself). The linter's rows
-- are not visible outside Lovable, so the +1 could not be named. Auditing
-- every SECURITY DEFINER function executable by anon on live (2026-09-24)
-- found these REAL exposures instead, all executable by PUBLIC ("=X"):
--
--   create_web_layaway_atomic      writes a layaway plan + schedule + stock
--   reactivate_web_layaway_atomic  revives an expired web plan, re-holds stock
--   unwaive_penalty_atomic         reinstates a waived penalty
--   void_redemption_atomic         voids a loyalty redemption, returns points,
--                                  reverses its synthetic payment
--   web_deposit_deadline_hours     says whether a customer id has prior orders
--
-- None checks its caller: they trust a p_user_id argument or none at all,
-- because they were only ever meant to be reached from edge functions with the
-- service role. PUBLIC execute let an anonymous PostgREST call skip the edge
-- function's auth and permission checks entirely.
--
-- HOW THEY GOT PUBLIC. A DROP + CREATE FUNCTION starts from the default ACL,
-- which grants EXECUTE to PUBLIC. 20260918090000 / 20260918120000 re-created
-- create_web_layaway_atomic without a REVOKE; reserve-first A1 then carried
-- that ACL forward faithfully (_a1_carry_acl). The other four predate this
-- week. Lesson for every future DROP + CREATE: re-assert the grants.
--
-- CALLERS, checked 2026-09-24 against the repo and live pg_proc/pg_policies:
-- every caller is an edge function using the service role (website,
-- reactivate-web-layaway, unwaive-waiver, process-loyalty-redemption,
-- confirm-web-order-ready, revive-web-cash-order), or a SECURITY DEFINER
-- function that runs as owner (approve_redemption_atomic,
-- create_web_order_atomic, create_web_layaway_atomic,
-- revive_web_cash_order_atomic, confirm_web_order_ready_atomic). No browser
-- code and no RLS policy calls any of them. layaway_quote only NAMES
-- create_web_layaway_atomic in a comment.
--
-- The four Finance daily-sales RPCs are called from the browser
-- (src/hooks/financeQueryOptions.ts), so they keep authenticated and lose only
-- PUBLIC/anon: an anonymous caller could read daily sales totals.
--
-- Left alone on purpose: has_role, is_staff, timesheet_can_view_all (RLS
-- helpers returning a boolean about a uid) and trigger functions (a trigger
-- function cannot be called through PostgREST).
--
-- Lovable's sandbox role (sandbox_exec_<ref>) holds its own explicit grant and
-- is not touched: REVOKE FROM PUBLIC does not remove a named grantee.

DO $guard$
DECLARE
  v_missing text := '';
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[
    'public.create_web_layaway_atomic(uuid,uuid,text,timestamptz,date,text,timestamptz,boolean)',
    'public.reactivate_web_layaway_atomic(uuid,timestamptz,text,uuid,text)',
    'public.unwaive_penalty_atomic(uuid,uuid,text)',
    'public.void_redemption_atomic(uuid,uuid,text,text)',
    'public.web_deposit_deadline_hours(uuid,uuid)',
    'public.get_daily_cash_orders()',
    'public.get_daily_cash_orders_last_month()',
    'public.get_daily_new_layaway_sales(text)',
    'public.get_daily_new_layaway_sales_last_month(text)'] LOOP
    IF to_regprocedure(r) IS NULL THEN v_missing := v_missing || E'\n  ' || r; END IF;
  END LOOP;
  IF v_missing <> '' THEN
    RAISE EXCEPTION E'STOP — signature(s) not on live, nothing changed:%', v_missing;
  END IF;
END
$guard$;

-- Service-role only.
REVOKE ALL ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date, text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date, text, timestamptz, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.reactivate_web_layaway_atomic(uuid, timestamptz, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_web_layaway_atomic(uuid, timestamptz, text, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.unwaive_penalty_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unwaive_penalty_atomic(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.void_redemption_atomic(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_redemption_atomic(uuid, uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.web_deposit_deadline_hours(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_deposit_deadline_hours(uuid, uuid) TO service_role;

-- Signed-in staff only (the Finance dashboard).
REVOKE ALL ON FUNCTION public.get_daily_cash_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_cash_orders() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_daily_cash_orders_last_month() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_cash_orders_last_month() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_daily_new_layaway_sales(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_new_layaway_sales(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_daily_new_layaway_sales_last_month(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_new_layaway_sales_last_month(text) TO authenticated, service_role;

DO $proof$
DECLARE
  v_bad text := '';
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS a,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS u,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS s
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (
       'create_web_layaway_atomic', 'reactivate_web_layaway_atomic', 'unwaive_penalty_atomic',
       'void_redemption_atomic', 'web_deposit_deadline_hours', 'get_daily_cash_orders',
       'get_daily_cash_orders_last_month', 'get_daily_new_layaway_sales',
       'get_daily_new_layaway_sales_last_month')
  LOOP
    IF r.a OR NOT r.s
       OR (r.proname LIKE 'get_daily_%' AND NOT r.u)
       OR (r.proname NOT LIKE 'get_daily_%' AND r.u) THEN
      v_bad := v_bad || format(E'\n  %s anon=%s authenticated=%s service_role=%s', r.sig, r.a, r.u, r.s);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — grants did not land as intended; rolled back.%', v_bad;
  END IF;
END
$proof$;