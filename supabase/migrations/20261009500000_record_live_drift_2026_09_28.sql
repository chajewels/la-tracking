-- ═══════════════════════════════════════════════════════════════════════════
-- RECORD-ONLY (2026-09-28). Live function drift reconciliation. A NO-OP ON LIVE.
--
-- Captured from live by the owner at 2026-09-28 13:46 JST (fetch-live.sql, SQL Editor, read
-- only). Every body below is the pg_get_functiondef output byte for byte; each one's
-- md5(prosrc) and md5(pg_get_functiondef) are quoted in its section and were re-verified
-- against the export before this file was written.
--
-- Why: scripts/function-drift-audit (2026-09-28 13:07 JST, excluding the unapplied
-- 20261010100000_media_cutouts_cut_once.sql) reported 7 a_differs, 1 b_live_only and
-- 1 c_repo_only. CLAUDE.md "FUNCTION CHANGES START FROM LIVE (Bug #280)" requires all three
-- to be 0 before a migration that redefines functions is applied. This file takes six of the
-- a_differs and the one b_live_only to 0. The other two are NOT function bodies:
--
--   page365_metals_from_text  (a_differs) — live and repo are BYTE-IDENTICAL (md5(prosrc)
--       59e64019d2958da8fedefb9f19db1763 on both). The body contains U+3000 (ideographic
--       space) in a regex; the audit script normalised it as whitespace in Python while
--       Postgres's \s does not. Fixed in scripts/function-drift-audit in the same PR; nothing
--       to record here.
--   next_reconciliation_batch (c_repo_only) — 20260923100000 was never applied to live and
--       daily-reconciliation calls it. Left for the owner to decide; see the PR. Not touched.
--
-- HOW IT STAYS A NO-OP. Nothing is done blindly:
--   * A preflight checks every body first. Each must equal the recorded live md5 (then it is
--     skipped: no CREATE runs at all) or a known older repo body (a fresh rebuild from
--     supabase/migrations/, where it is brought up to live). Anything else STOPS before any
--     change.
--   * ACLs are compared as a set with the recorded live ACL and touched only if they differ.
--     A role that does not exist (sandbox_exec_* on a local rebuild) is skipped with a notice.
--   * Triggers are compared by definition and touched only if they differ.
--   * A final self-check re-reads everything and raises if any of it is not as recorded.
--
-- NOTHING IS "FIXED". Several of these carry EXECUTE for PUBLIC (the three trigger
-- functions). That is live's ACL and is recorded as such; trigger functions cannot be called
-- through PostgREST. Changing it would be a separate, deliberate migration.
--
-- Helpers live in pg_temp for this session only and are dropped at the end.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PREFLIGHT. Check every function before touching anything. Each must be either
--    exactly the live body recorded here (the normal case on live: then this file is a
--    no-op) or a known older repo body (a fresh rebuild from supabase/migrations/).
--    Anything else means live has moved since 2026-09-28 13:46 JST: STOP, nothing changed.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE r record; v_got text; v_bad text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.get_daily_cash_orders()', '279e864efad013082479668613ec6602', ARRAY[]::text[]),
    ('public.get_daily_cash_orders_last_month()', '15043ff8aa97f6c4b1a1c547395476aa', ARRAY[]::text[]),
    ('public.get_daily_new_layaway_sales(text)', '04ee041473d8d057bfa077488a4220db', ARRAY[]::text[]),
    ('public.get_daily_new_layaway_sales_last_month(text)', '11490ceeea02e28d261d63266dd428d2', ARRAY[]::text[]),
    ('public.set_updated_at()', 'e3addd320004eb7a8494e7a0c2614c97', ARRAY['c8d4fb7d57a71b370cbd9a48a3075673']::text[]),
    ('public.sync_service_request_from_job()', '8b697a926f7951da3b4dae1454afddda', ARRAY['b43687239ce96df2a729092a10264597']::text[]),
    ('public.force_layaway_english_only()', '1f2da719fe9da1651dfa5c878c8e3458', ARRAY['absent']::text[])
  ) AS t(sig, live_md5, prior_md5)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_got IS NULL AND NOT 'absent' = ANY(r.prior_md5) THEN
      v_bad := v_bad || format(E'\n  %s: missing', r.sig);
    ELSIF v_got IS NOT NULL AND v_got <> r.live_md5 AND NOT v_got = ANY(r.prior_md5) THEN
      v_bad := v_bad || format(E'\n  %s: body md5 %s, expected %s', r.sig, v_got, r.live_md5);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — live has moved since the 2026-09-28 capture; re-read it. Nothing changed.%', v_bad;
  END IF;
END
$pre$;

-- Session-only helpers (pg_temp). Not part of the schema.
CREATE OR REPLACE FUNCTION pg_temp.drift_record_fn(p_sig text, p_live_md5 text, p_prior text[], p_def text)
RETURNS text LANGUAGE plpgsql AS $h$
DECLARE v_got text;
BEGIN
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure(p_sig);
  IF v_got = p_live_md5 THEN
    RAISE NOTICE '% — already the recorded live body; skipped', p_sig;
    RETURN 'skipped';
  END IF;
  IF NOT ((v_got IS NULL AND 'absent' = ANY(p_prior)) OR v_got = ANY(p_prior)) THEN
    RAISE EXCEPTION 'STOP — % has body md5 %, neither live nor a known repo body', p_sig, coalesce(v_got, 'missing');
  END IF;
  EXECUTE p_def;
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure(p_sig);
  IF v_got IS DISTINCT FROM p_live_md5 THEN
    RAISE EXCEPTION 'STOP — % recorded to md5 %, expected %', p_sig, v_got, p_live_md5;
  END IF;
  RAISE NOTICE '% — brought up to the recorded live body', p_sig;
  RETURN 'recorded';
END
$h$;

-- EXECUTE grantees as a sorted set; PUBLIC for grantee 0.
CREATE OR REPLACE FUNCTION pg_temp.drift_acl_of(p_sig text)
RETURNS text[] LANGUAGE sql AS $h$
  SELECT coalesce(array_agg(g ORDER BY g), ARRAY[]::text[])
    FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                               ELSE pg_get_userbyid(a.grantee)::text END AS g
            FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE p.oid = to_regprocedure(p_sig) AND a.privilege_type = 'EXECUTE') s
$h$;

CREATE OR REPLACE FUNCTION pg_temp.drift_record_acl(p_sig text, p_roles text[])
RETURNS text LANGUAGE plpgsql AS $h$
DECLARE
  v_want  text[];
  v_have  text[] := pg_temp.drift_acl_of(p_sig);
  v_owner text   := (SELECT pg_get_userbyid(p.proowner)::text FROM pg_proc p WHERE p.oid = to_regprocedure(p_sig));
  g text;
BEGIN
  SELECT coalesce(array_agg(DISTINCT r ORDER BY r), ARRAY[]::text[]) INTO v_want
    FROM unnest(p_roles) r
   WHERE r = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
  FOR g IN SELECT r FROM unnest(p_roles) r
            WHERE r <> 'PUBLIC' AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) LOOP
    RAISE NOTICE '% — role % does not exist here; its grant is skipped', p_sig, g;
  END LOOP;
  IF v_have = v_want THEN
    RAISE NOTICE '% — ACL already as recorded; skipped', p_sig;
    RETURN 'skipped';
  END IF;
  FOREACH g IN ARRAY v_have LOOP
    CONTINUE WHEN g = ANY(v_want) OR g = v_owner;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %s', to_regprocedure(p_sig),
                   CASE WHEN g = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g) END);
  END LOOP;
  FOREACH g IN ARRAY v_want LOOP
    CONTINUE WHEN g = ANY(v_have);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', to_regprocedure(p_sig),
                   CASE WHEN g = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g) END);
  END LOOP;
  IF pg_temp.drift_acl_of(p_sig) IS DISTINCT FROM v_want THEN
    RAISE EXCEPTION 'STOP — % ACL is %, expected %', p_sig, pg_temp.drift_acl_of(p_sig), v_want;
  END IF;
  RAISE NOTICE '% — ACL set to %', p_sig, v_want;
  RETURN 'recorded';
END
$h$;

-- Trigger definitions compared with schema qualifiers and whitespace ignored.
CREATE OR REPLACE FUNCTION pg_temp.drift_norm(p text)
RETURNS text LANGUAGE sql AS $h$
  SELECT btrim(regexp_replace(replace(p, 'public.', ''), '[[:space:]]+', ' ', 'g'))
$h$;

CREATE OR REPLACE FUNCTION pg_temp.drift_record_trigger(p_table text, p_name text, p_def text, p_prior text[])
RETURNS text LANGUAGE plpgsql AS $h$
DECLARE v_rel regclass := to_regclass(p_table); v_cur text;
BEGIN
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'STOP — table % does not exist', p_table;
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_cur
    FROM pg_trigger t WHERE t.tgrelid = v_rel AND t.tgname = p_name AND NOT t.tgisinternal;
  IF pg_temp.drift_norm(v_cur) = pg_temp.drift_norm(p_def) THEN
    RAISE NOTICE '% on % — already as recorded; skipped', p_name, p_table;
    RETURN 'skipped';
  END IF;
  IF v_cur IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM unnest(p_prior) x WHERE pg_temp.drift_norm(x) = pg_temp.drift_norm(v_cur)) THEN
    RAISE EXCEPTION 'STOP — trigger % on % is %, neither live nor a known repo definition', p_name, p_table, v_cur;
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', p_name, v_rel);
  EXECUTE p_def;
  RAISE NOTICE '% on % — brought up to the recorded live definition', p_name, p_table;
  RETURN 'recorded';
END
$h$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. public.get_daily_cash_orders()
--    live prosrc md5 279e864efad013082479668613ec6602  (audit de3200143c83; functiondef md5 ad0edf26d81f2f4d385e6709af182300, 1229 bytes)
--    live acl        {postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres,authenticated=X/postgres}
--    Why it drifted: carries the 2026-09-24 view_finance gate. That gate went live through an in-place patch
-- (20260924140200, DO + EXECUTE), which the drift audit cannot read, so the audit still saw the
-- 20260917070100 body. The only difference is the gate. Live is the intended version.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.get_daily_cash_orders()', '279e864efad013082479668613ec6602', ARRAY[]::text[], $def$CREATE OR REPLACE FUNCTION public.get_daily_cash_orders()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Finance only (2026-09-24): the /finance route's own key. Customers hold
  -- authenticated sessions too. Service-role / SQL Editor (uid NULL) pass.
  IF auth.uid() IS NOT NULL AND NOT public.has_permission(auth.uid(), 'view_finance') THEN
    RAISE EXCEPTION 'view_finance permission required' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(co.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN co.currency = 'PHP' THEN co.total_amount / r.rate
                 ELSE co.total_amount END) AS total_sales_value
      FROM cash_orders co
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE co.is_test = false
        AND co.status = 'completed'::cash_order_status
        AND DATE_TRUNC('month', co.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY co.order_date::DATE
      ORDER BY co.order_date::DATE ASC
    ) t
  );
END;
$function$
$def$);
SELECT pg_temp.drift_record_acl('public.get_daily_cash_orders()', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. public.get_daily_cash_orders_last_month()
--    live prosrc md5 15043ff8aa97f6c4b1a1c547395476aa  (audit 32bb30f4cd7e; functiondef md5 2d5f97baf90d9d1379761b496bb5dc06, 1261 bytes)
--    live acl        {postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres,authenticated=X/postgres}
--    Why it drifted: same as get_daily_cash_orders: the view_finance gate from 20260924140200, nothing else.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.get_daily_cash_orders_last_month()', '15043ff8aa97f6c4b1a1c547395476aa', ARRAY[]::text[], $def$CREATE OR REPLACE FUNCTION public.get_daily_cash_orders_last_month()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Finance only (2026-09-24): the /finance route's own key. Customers hold
  -- authenticated sessions too. Service-role / SQL Editor (uid NULL) pass.
  IF auth.uid() IS NOT NULL AND NOT public.has_permission(auth.uid(), 'view_finance') THEN
    RAISE EXCEPTION 'view_finance permission required' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(co.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN co.currency = 'PHP' THEN co.total_amount / r.rate
                 ELSE co.total_amount END) AS total_sales_value
      FROM cash_orders co
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE co.is_test = false
        AND co.status = 'completed'::cash_order_status
        AND DATE_TRUNC('month', co.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
      GROUP BY co.order_date::DATE
      ORDER BY co.order_date::DATE ASC
    ) t
  );
END;
$function$
$def$);
SELECT pg_temp.drift_record_acl('public.get_daily_cash_orders_last_month()', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. public.get_daily_new_layaway_sales(text)
--    live prosrc md5 04ee041473d8d057bfa077488a4220db  (audit 1503bfc48221; functiondef md5 ca91cee3b5470e1107465d43b9411f47, 1587 bytes)
--    live acl        {postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres,authenticated=X/postgres}
--    Why it drifted: same: the view_finance gate from 20260924140200 on top of the baseline body, nothing else.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.get_daily_new_layaway_sales(text)', '04ee041473d8d057bfa077488a4220db', ARRAY[]::text[], $def$CREATE OR REPLACE FUNCTION public.get_daily_new_layaway_sales(currency_mode text DEFAULT 'ALL'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Finance only (2026-09-24): the /finance route's own key. Customers hold
  -- authenticated sessions too. Service-role / SQL Editor (uid NULL) pass.
  IF auth.uid() IS NOT NULL AND NOT public.has_permission(auth.uid(), 'view_finance') THEN
    RAISE EXCEPTION 'view_finance permission required' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(la.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND la.status <> 'cancelled'::account_status
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY la.order_date::DATE
      ORDER BY la.order_date::DATE ASC
    ) t
  );
END;
$function$
$def$);
SELECT pg_temp.drift_record_acl('public.get_daily_new_layaway_sales(text)', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. public.get_daily_new_layaway_sales_last_month(text)
--    live prosrc md5 11490ceeea02e28d261d63266dd428d2  (audit d4705d5ac852; functiondef md5 c1ac755eca7c1a9e428adfe951159c4e, 1619 bytes)
--    live acl        {postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres,authenticated=X/postgres}
--    Why it drifted: same: the view_finance gate from 20260924140200 on top of the baseline body, nothing else.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.get_daily_new_layaway_sales_last_month(text)', '11490ceeea02e28d261d63266dd428d2', ARRAY[]::text[], $def$CREATE OR REPLACE FUNCTION public.get_daily_new_layaway_sales_last_month(currency_mode text DEFAULT 'ALL'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Finance only (2026-09-24): the /finance route's own key. Customers hold
  -- authenticated sessions too. Service-role / SQL Editor (uid NULL) pass.
  IF auth.uid() IS NOT NULL AND NOT public.has_permission(auth.uid(), 'view_finance') THEN
    RAISE EXCEPTION 'view_finance permission required' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(la.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND la.status <> 'cancelled'::account_status
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
      GROUP BY la.order_date::DATE
      ORDER BY la.order_date::DATE ASC
    ) t
  );
END;
$function$
$def$);
SELECT pg_temp.drift_record_acl('public.get_daily_new_layaway_sales_last_month(text)', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. public.set_updated_at()
--    live prosrc md5 e3addd320004eb7a8494e7a0c2614c97  (audit 3726c19bac70; functiondef md5 244a26d0c839637b13190cfe4b917c32, 157 bytes)
--    live acl        {=X/postgres,postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres}
--    Why it drifted: cosmetic only. The baseline body reads NOW() and ends END; — live reads now() and ends END.
-- Behaviour is identical. Changed live with no trace in git (most likely a Lovable/SQL Editor
-- CREATE OR REPLACE while the website tables were built, 2026-09-21/22).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.set_updated_at()', 'e3addd320004eb7a8494e7a0c2614c97', ARRAY['c8d4fb7d57a71b370cbd9a48a3075673']::text[], $def$CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END $function$
$def$);
SELECT pg_temp.drift_record_acl('public.set_updated_at()', ARRAY['PUBLIC', 'postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. public.sync_service_request_from_job()
--    live prosrc md5 8b697a926f7951da3b4dae1454afddda  (audit 43c3337cbd52; functiondef md5 0f55644ca036f8874b117fb403a78864, 783 bytes)
--    live acl        {=X/postgres,postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres}
--    Why it drifted: BEHAVIOUR DIFFERS, and live is the intended one. 20260921000000 claimed to record live but
-- recorded a reconstruction. The repo copy fires whenever the status maps (no OLD check), can
-- flip a DECLINED request to completed, and can move a completed request BACK to in_progress.
-- Live acts only when service_status actually changes, never touches a declined request on
-- Completed, and moves to in_progress only from requested/received — which is what
-- docs/SERVICE-REQUESTS.md promises ("Pending, Cancelled ... untouched"; staff own the rest).
-- Its trigger differs too: live is AFTER UPDATE OF service_status (the repo also had INSERT).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.sync_service_request_from_job()', '8b697a926f7951da3b4dae1454afddda', ARRAY['b43687239ce96df2a729092a10264597']::text[], $def$CREATE OR REPLACE FUNCTION public.sync_service_request_from_job()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.service_status IS DISTINCT FROM OLD.service_status THEN
    IF NEW.service_status = 'Completed' THEN
      UPDATE public.service_requests
         SET status = 'completed', updated_at = now()
       WHERE service_job_id = NEW.id AND status <> 'declined';
    ELSIF NEW.service_status IN ('Process','On-going') THEN
      UPDATE public.service_requests
         SET status = 'in_progress', updated_at = now()
       WHERE service_job_id = NEW.id AND status IN ('requested','received');
    END IF;
    -- Pending and Cancelled: staff decide on the request explicitly.
  END IF;
  RETURN NEW;
END $function$
$def$);
SELECT pg_temp.drift_record_acl('public.sync_service_request_from_job()', ARRAY['PUBLIC', 'postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. public.force_layaway_english_only()
--    live prosrc md5 1f2da719fe9da1651dfa5c878c8e3458  (audit 98d2f91ded97; functiondef md5 223e3f03a092858a74d6e00081947df1, 645 bytes)
--    live acl        {=X/postgres,postgres=X/postgres,service_role=X/postgres,sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres}
--    Why it drifted: LIVE ONLY — never in git. BEFORE INSERT/UPDATE on website_faq_items and website_posts: any
-- row whose text mentions layaway (English, or レイアウェイ) is forced to layaway_only = true.
-- Owner rule: layaway is English-market only (CLAUDE.md WEB PAYMENT REMINDERS). Both triggers
-- are recorded below as well; neither was in git either.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT pg_temp.drift_record_fn('public.force_layaway_english_only()', '1f2da719fe9da1651dfa5c878c8e3458', ARRAY['absent']::text[], $def$CREATE OR REPLACE FUNCTION public.force_layaway_english_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE t text;
BEGIN
  t := concat_ws(' ', to_jsonb(NEW) ->> 'question_en', to_jsonb(NEW) ->> 'answer_en',
                      to_jsonb(NEW) ->> 'question_ja', to_jsonb(NEW) ->> 'answer_ja',
                      to_jsonb(NEW) ->> 'title_en',   to_jsonb(NEW) ->> 'body_en',
                      to_jsonb(NEW) ->> 'excerpt_en', to_jsonb(NEW) ->> 'title_ja',
                      to_jsonb(NEW) ->> 'body_ja');
  IF t ILIKE '%layaway%' OR t LIKE '%レイアウェイ%' THEN
    NEW.layaway_only := true;
  END IF;
  RETURN NEW;
END $function$
$def$);
SELECT pg_temp.drift_record_acl('public.force_layaway_english_only()', ARRAY['PUBLIC', 'postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Triggers that exist only on live (or differ from the repo). Each is left alone when
--    its definition already matches; otherwise it is created, or replaced from the one known
--    older repo definition. Any other definition stops the migration.
-- ─────────────────────────────────────────────────────────────────────────────

SELECT pg_temp.drift_record_trigger('public.website_faq_items', 'trg_faq_items_layaway_en',
  'CREATE TRIGGER trg_faq_items_layaway_en BEFORE INSERT OR UPDATE ON public.website_faq_items FOR EACH ROW EXECUTE FUNCTION public.force_layaway_english_only()',
  ARRAY[]::text[]);

SELECT pg_temp.drift_record_trigger('public.website_posts', 'trg_posts_layaway_en',
  'CREATE TRIGGER trg_posts_layaway_en BEFORE INSERT OR UPDATE ON public.website_posts FOR EACH ROW EXECUTE FUNCTION public.force_layaway_english_only()',
  ARRAY[]::text[]);

SELECT pg_temp.drift_record_trigger('public.service_jobs', 'trg_sync_service_request_from_job',
  'CREATE TRIGGER trg_sync_service_request_from_job AFTER UPDATE OF service_status ON public.service_jobs FOR EACH ROW EXECUTE FUNCTION public.sync_service_request_from_job()',
  ARRAY['CREATE TRIGGER trg_sync_service_request_from_job AFTER INSERT OR UPDATE OF service_status ON public.service_jobs FOR EACH ROW EXECUTE FUNCTION public.sync_service_request_from_job()']::text[]);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. SELF-CHECK. Everything must now be exactly as recorded, or the migration fails.
-- ─────────────────────────────────────────────────────────────────────────────
DO $chk$
DECLARE r record; v_got text; v_bad text := '';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.get_daily_cash_orders()', '279e864efad013082479668613ec6602', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]),
    ('public.get_daily_cash_orders_last_month()', '15043ff8aa97f6c4b1a1c547395476aa', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]),
    ('public.get_daily_new_layaway_sales(text)', '04ee041473d8d057bfa077488a4220db', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]),
    ('public.get_daily_new_layaway_sales_last_month(text)', '11490ceeea02e28d261d63266dd428d2', ARRAY['postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz', 'authenticated']::text[]),
    ('public.set_updated_at()', 'e3addd320004eb7a8494e7a0c2614c97', ARRAY['PUBLIC', 'postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz']::text[]),
    ('public.sync_service_request_from_job()', '8b697a926f7951da3b4dae1454afddda', ARRAY['PUBLIC', 'postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz']::text[]),
    ('public.force_layaway_english_only()', '1f2da719fe9da1651dfa5c878c8e3458', ARRAY['PUBLIC', 'postgres', 'service_role', 'sandbox_exec_pfoicalpzdcmyxzvwyhz']::text[])
  ) AS t(sig, live_md5, roles)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_got IS DISTINCT FROM r.live_md5 THEN
      v_bad := v_bad || format(E'\n  %s: body md5 %s', r.sig, v_got);
    END IF;
    IF pg_temp.drift_acl_of(r.sig) IS DISTINCT FROM (
         SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(r.roles) x
          WHERE x = 'PUBLIC' OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = x)) THEN
      v_bad := v_bad || format(E'\n  %s: acl %s', r.sig, pg_temp.drift_acl_of(r.sig));
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('public.website_faq_items', 'trg_faq_items_layaway_en', 'CREATE TRIGGER trg_faq_items_layaway_en BEFORE INSERT OR UPDATE ON public.website_faq_items FOR EACH ROW EXECUTE FUNCTION public.force_layaway_english_only()'),
    ('public.website_posts', 'trg_posts_layaway_en', 'CREATE TRIGGER trg_posts_layaway_en BEFORE INSERT OR UPDATE ON public.website_posts FOR EACH ROW EXECUTE FUNCTION public.force_layaway_english_only()'),
    ('public.service_jobs', 'trg_sync_service_request_from_job', 'CREATE TRIGGER trg_sync_service_request_from_job AFTER UPDATE OF service_status ON public.service_jobs FOR EACH ROW EXECUTE FUNCTION public.sync_service_request_from_job()')
  ) AS t(tbl, name, def)
  LOOP
    SELECT pg_get_triggerdef(t.oid) INTO v_got FROM pg_trigger t
     WHERE t.tgrelid = to_regclass(r.tbl) AND t.tgname = r.name AND NOT t.tgisinternal;
    IF pg_temp.drift_norm(v_got) IS DISTINCT FROM pg_temp.drift_norm(r.def) THEN
      v_bad := v_bad || format(E'\n  trigger %s: %s', r.name, coalesce(v_got, 'missing'));
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'record_live_drift_2026_09_28 self-check failed:%', v_bad;
  END IF;
  RAISE NOTICE 'record_live_drift_2026_09_28: all 7 functions, their ACLs and 3 triggers match the 2026-09-28 capture';
END
$chk$;

DROP FUNCTION pg_temp.drift_record_trigger(text, text, text, text[]);
DROP FUNCTION pg_temp.drift_norm(text);
DROP FUNCTION pg_temp.drift_record_acl(text, text[]);
DROP FUNCTION pg_temp.drift_acl_of(text);
DROP FUNCTION pg_temp.drift_record_fn(text, text, text[], text);
