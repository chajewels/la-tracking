-- Staff guard on 14 SECURITY DEFINER functions any signed-in user could call
-- (owner go 2026-10-09 17:37 JST). docs/FIXED-BUGS.md "Staff-only report and
-- allocation functions".
--
-- FOUND by the structure-drift audit (F2, 2026-10-09): these 14 functions run
-- as their owner (SECURITY DEFINER, so table security does not apply) and have
-- no caller check, and live grants EXECUTE to `authenticated` — i.e. to every
-- login in the shared auth system, which includes every customer who signed up
-- on the portal or the website. One of them writes:
--   admin_keep_allocation_override  — rewrites a payment allocation amount
-- and 13 read business or account money:
--   audit_account, audit_all_accounts, audit_delete_cleanup_invariants,
--   get_aging_buckets, get_cash_orders_monthly, get_forecast_6m,
--   get_forecast_drilldown, get_monthly_analytics, get_monthly_sales,
--   get_staff_performance, get_trade_kpis, get_trade_monthly_trends,
--   monthly_inflow_by_plan_6m
--
-- THE FIX: ONE new check, public.assert_staff_caller(permission), made the
-- FIRST statement of each function. Nothing else in any body changes.
--   - no request identity (SQL Editor, pg_cron, a migration)  → allowed
--   - service_role (edge functions)                           → allowed
--   - a staff login (is_staff: admin / staff / finance / csr)  → allowed
--   - admin_keep_allocation_override: has_permission('edit_schedule'),
--     the same permission the Hub's "Edit paid amount" pencil requires
--   - anyone else → 42501 'not allowed'
-- PostgREST always sets request.jwt.claims on an API call (anonymous calls
-- included), so the "no identity" branch cannot be reached from the API.
--
-- HOW (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"): each function is patched
-- IN PLACE from its live definition. The patch refuses unless the current
-- pg_get_functiondef md5 equals the live one read on 2026-10-09, and refuses
-- unless the result's md5 equals the expected one (computed on a replay of the
-- repo, whose 14 definitions are byte-identical to live). Re-running is a
-- no-op: a function already at the expected md5 is skipped.
--   plpgsql body → `PERFORM public.assert_staff_caller(...);` after its first BEGIN
--   sql body     → `SELECT public.assert_staff_caller();` as its first statement
--                  (the last statement still returns the rows)
-- Existing grants are kept (CREATE OR REPLACE keeps the ACL).

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.assert_staff_caller(p_permission text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_raw text := current_setting('request.jwt.claims', true);
  v_claims jsonb;
  v_uid uuid;
BEGIN
  -- No request identity: a direct database session, never an API call.
  IF v_raw IS NULL OR v_raw = '' THEN
    RETURN;
  END IF;
  v_claims := v_raw::jsonb;
  IF v_claims->>'role' = 'service_role' THEN
    RETURN;
  END IF;
  v_uid := NULLIF(v_claims->>'sub', '')::uuid;
  IF p_permission IS NULL THEN
    IF public.is_staff(v_uid) THEN
      RETURN;
    END IF;
  ELSIF public.has_permission(v_uid, p_permission) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
END
$function$;

-- Only ever called from inside the guarded SECURITY DEFINER functions (which
-- run as their owner), so nobody needs to call it directly.
REVOKE ALL ON FUNCTION public.assert_staff_caller(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_staff_caller(text) TO service_role;

CREATE OR REPLACE FUNCTION pg_temp.cj_guard(p_fn regprocedure, p_old_md5 text, p_new_md5 text, p_permission text)
 RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_def  text := pg_get_functiondef(p_fn);
  v_lang text;
  v_at   int;
  v_rest text;
  v_head text;
  v_call text;
  v_new  text;
BEGIN
  IF md5(v_def) = p_new_md5 THEN
    RAISE NOTICE 'staff guard: % already guarded, skipped', p_fn;
    RETURN;
  END IF;
  IF md5(v_def) <> p_old_md5 THEN
    RAISE EXCEPTION 'staff guard: % differs from the live definition read on 2026-10-09 (md5 %), refusing', p_fn, md5(v_def);
  END IF;

  SELECT l.lanname INTO v_lang FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = p_fn;
  v_at := strpos(v_def, 'AS $function$');
  IF v_at = 0 OR strpos(substr(v_def, v_at + 13), 'AS $function$') > 0 THEN
    RAISE EXCEPTION 'staff guard: % has no single body marker, refusing', p_fn;
  END IF;
  v_call := 'public.assert_staff_caller(' || COALESCE(quote_literal(p_permission), '') || ')';

  IF v_lang = 'sql' THEN
    v_new := left(v_def, v_at + 12) || E'\nSELECT ' || v_call || ';' || substr(v_def, v_at + 13);
  ELSIF v_lang = 'plpgsql' THEN
    v_rest := substr(v_def, v_at + 13);
    v_head := substring(v_rest FROM '^(.*?)\mBEGIN\M');
    IF v_head IS NULL THEN
      RAISE EXCEPTION 'staff guard: % has no BEGIN, refusing', p_fn;
    END IF;
    v_new := left(v_def, v_at + 12) || v_head || 'BEGIN' || E'\n  PERFORM ' || v_call || ';'
             || substr(v_rest, length(v_head) + 6);
  ELSE
    RAISE EXCEPTION 'staff guard: % is %, refusing', p_fn, v_lang;
  END IF;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_fn)) <> p_new_md5 THEN
    RAISE EXCEPTION 'staff guard: % patched to md5 %, expected %, refusing', p_fn, md5(pg_get_functiondef(p_fn)), p_new_md5;
  END IF;
END
$f$;

SELECT pg_temp.cj_guard('public.admin_keep_allocation_override(uuid,numeric)', '137f2b90db05110dd270cce81f0d6984', '34589e1d39b82c4ae2e70b436e0161d0', 'edit_schedule');
SELECT pg_temp.cj_guard('public.audit_account(text)', 'eec1d67d7605bd60f035b4695d8cb173', '15aecbb452a9204af7e3a2cbfba0f2c6', NULL);
SELECT pg_temp.cj_guard('public.audit_all_accounts()', '04f60423592ecfeba6cd08dde71d928d', 'a8606b9c06dd90de079b73a55f3a21dc', NULL);
SELECT pg_temp.cj_guard('public.audit_delete_cleanup_invariants()', 'e96cabdc4e365196d0e25985369a906b', '153d64fadfcc6371fa0e55d5f70d66f0', NULL);
SELECT pg_temp.cj_guard('public.get_aging_buckets(text)', '67a7c66e8b2fa8b9e179bfadcd883580', '2132dfdf815028bd965509e5f26b513d', NULL);
SELECT pg_temp.cj_guard('public.get_cash_orders_monthly()', 'b3e3782cb3edefbed358e84574fb223a', 'f803bcaf0fe60f2e1a07e8bb87c4eaea', NULL);
SELECT pg_temp.cj_guard('public.get_forecast_6m()', '1b93bcdd99e8318680bbe9938972563b', 'c3cd3dc7217b9dff7d6d4aa184df24e6', NULL);
SELECT pg_temp.cj_guard('public.get_forecast_drilldown(text)', '176012b51d03f1f42040c49231794fe7', 'dfd33626026258ef2c5ac2ef25d2ebe8', NULL);
SELECT pg_temp.cj_guard('public.get_monthly_analytics()', 'e8e6ca21a5729c2c8a3254ff40405089', '14a48b463eb505766d510fa38c80fffb', NULL);
SELECT pg_temp.cj_guard('public.get_monthly_sales(text,integer)', 'a4138da55813c0050f6760f1512d853d', '9798341e4b75f262a173c2751cc60ef3', NULL);
SELECT pg_temp.cj_guard('public.get_staff_performance(integer)', '67b2631ad23c391aa9da9bb5801e72a3', '8f2d9dfc7878d815728c2af101e94581', NULL);
SELECT pg_temp.cj_guard('public.get_trade_kpis()', '4b299b49cc31cd209cdf7d39f3c16e41', 'c6f95e42eed4823b17d245409054a463', NULL);
SELECT pg_temp.cj_guard('public.get_trade_monthly_trends(integer)', 'f484c2b45269212163681f461d72beff', 'bc06913760c3f7ddd22d2c60b07ea91c', NULL);
SELECT pg_temp.cj_guard('public.monthly_inflow_by_plan_6m()', 'dce3ecbcdeda1521a21d43a67be67abd', 'd8c8dffe3dc561f359aa49b75c687a49', NULL);