-- ============================================================================
-- Page365 selectable interval + time-safe hide (PR 3d) — LOCAL behaviour
-- tests (2026-10-03). Local Postgres only. Run after the stubs and all eight
-- earlier migrations, then this one (no new stub is needed):
--
--   (the PR 3b sequence from docs/sql/20261001_page365_hide_follow_local_stub.sql, then)
--   $P supabase/migrations/20261002100000_page365_quick_fetch.sql
--   $P supabase/migrations/20261003100000_page365_interval.sql
--   $P supabase/migrations/20261003100000_page365_interval.sql   # re-run is safe
--   $P docs/sql/20261003_page365_interval_local_tests.sql
--
-- Every check RAISEs on failure; the last line prints ALL PR 3d CHECKS PASSED.
--
-- Covers: the setting is seeded 30 and reads 30; only 5/10/20/30 (RPC
-- invalid_interval, the CHECK, the guard trigger refuses plain UPDATE/DELETE);
-- no user / no manage_website_catalog refused; each allowed value is saved,
-- read back by page365_inventory_interval_minutes() and audited once (who,
-- from, to, when); a stale screen and a no-op write nothing; grants; the Hub
-- card's next_check_at (a 2-59/5 tick, first at or after last start +
-- interval − 150 s); hide needs 2 missing complete reads AND >= 30 minutes
-- since last seen — 2 reads 10 min apart do not hide, 29 min does not, 31 min
-- does (and the scheduled run then hides it); a product last seen 31 min ago
-- but missing only once is not hidden; no other setting changed.
-- The start cadence itself (each interval starts on time, never early, no
-- overlap, nightly full unchanged) is page365-inventory-fetch's
-- scheduleDecision, tested in src/test/page365-interval.test.ts.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.pid(p_sku text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.website_products WHERE sku = p_sku $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_sku text) RETURNS integer LANGUAGE sql AS $$
  SELECT sum(v.stock_qty)::integer FROM public.website_product_variants v WHERE v.product_id = pg_temp.pid(p_sku) $$;
CREATE OR REPLACE FUNCTION pg_temp.st(p_sku text) RETURNS text LANGUAGE sql AS $$
  SELECT status::text FROM public.website_products WHERE sku = p_sku $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id = p_run AND coalesce(code, hub_sku) = p_code LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.cat(p_run uuid, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((pg_temp.item(p_run, p_code)).category, '(absent)') $$;
CREATE OR REPLACE FUNCTION pg_temp.v(vid bigint, vname text, code text, avail integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', vid, 'name', vname, 'code', code, 'price_jpy', 10000, 'full_price_jpy', NULL, 'available', avail) $$;
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'error', NULL,
    'detail', jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(pg_temp.v(pid * 10, NULL, split_part(name, ' ', 1), avail)))) $$;
-- One run as page365-inventory-fetch does it (see the PR 3c tests).
CREATE OR REPLACE FUNCTION pg_temp.run(p_source text, p_kind text, p_details jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES (p_source, p_kind, jsonb_array_length(p_details), jsonb_array_length(p_details)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name' FROM jsonb_array_elements(p_details) x;
  IF p_kind = 'quick' THEN PERFORM public.page365_inventory_plan_quick(v_run); END IF;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_details) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', d->>'error');
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.catalogue(p_extra jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT (SELECT jsonb_agg(pg_temp.p(800000 + g, 'IF' || g || ' Ring K18', 1)) FROM generate_series(1, 40) g) || p_extra $$;
CREATE OR REPLACE FUNCTION pg_temp.audits() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.audit_logs WHERE action = 'set_page365_inventory_interval' $$;
CREATE OR REPLACE FUNCTION pg_temp.setv(p_minutes integer, p_expected integer DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.set_page365_inventory_interval(p_minutes, p_expected) $$;
-- Age "last seen" of a product, as if its last complete read began that long ago.
CREATE OR REPLACE FUNCTION pg_temp.seen_ago(p_sku text, p_age interval) RETURNS void LANGUAGE sql AS $$
  UPDATE public.page365_product_presence SET last_seen_at = now() - p_age WHERE website_product_id = pg_temp.pid(p_sku) $$;

-- Two staff users: one with manage_website_catalog, one without.
INSERT INTO public.perm(user_id, key) SELECT '99999999-0000-0000-0000-000000000002', 'manage_website_catalog'
 WHERE NOT EXISTS (SELECT 1 FROM public.perm WHERE user_id = '99999999-0000-0000-0000-000000000002' AND key = 'manage_website_catalog');
DELETE FROM public.perm WHERE user_id = '99999999-0000-0000-0000-000000000003';
INSERT INTO public.profiles(user_id, full_name)
SELECT '99999999-0000-0000-0000-000000000002', 'Catalog Staff'
 WHERE NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = '99999999-0000-0000-0000-000000000002');

DELETE FROM public.page365_inventory_runs;
DELETE FROM public.page365_product_presence;
DELETE FROM public.staff_notifications;
DELETE FROM public.audit_logs;
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = false WHERE page365_sync_disabled;
SELECT set_config('test.uid', '', false);
UPDATE public.website_products SET status = 'archived';

CREATE TEMP TABLE other_settings AS
SELECT md5(string_agg(key || '=' || coalesce(value::text, '') || '|' || coalesce(updated_at::text, ''), E'\n' ORDER BY key)) AS h
  FROM public.system_settings WHERE key NOT IN ('page365_inventory_interval_minutes', 'page365_inventory_auto_apply');

-- A. The setting -------------------------------------------------------------
SELECT pg_temp.eq('A: seeded 30', (SELECT value FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes'), '30'::jsonb);
SELECT pg_temp.eq('A: reader says 30', public.page365_inventory_interval_minutes(), 30);
SELECT pg_temp.eq('A: no user refused', pg_temp.setv(5)->>'error', 'user_identity_required');
SELECT pg_temp.eq('A: get without a user refused', public.get_page365_inventory_interval()->>'error', 'user_identity_required');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000003', false);
SELECT pg_temp.eq('A: non-catalog user refused (set)', pg_temp.setv(5)->>'error', 'permission_denied');
SELECT pg_temp.eq('A: non-catalog user refused (get)', public.get_page365_inventory_interval()->>'error', 'permission_denied');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('A: 15 refused',   pg_temp.setv(15)->>'error', 'invalid_interval');
SELECT pg_temp.eq('A: 0 refused',    pg_temp.setv(0)->>'error', 'invalid_interval');
SELECT pg_temp.eq('A: 60 refused',   pg_temp.setv(60)->>'error', 'invalid_interval');
SELECT pg_temp.eq('A: -5 refused',   pg_temp.setv(-5)->>'error', 'invalid_interval');
SELECT pg_temp.eq('A: NULL refused', pg_temp.setv(NULL)->>'error', 'invalid_interval');
SELECT pg_temp.eq('A: still 30 after refusals', public.page365_inventory_interval_minutes(), 30);
SELECT pg_temp.eq('A: refusals write no audit', pg_temp.audits(), 0::bigint);
SELECT pg_temp.eq('A: same value -> no change', (pg_temp.setv(30)->>'changed')::boolean, false);
SELECT pg_temp.eq('A: no-op writes no audit', pg_temp.audits(), 0::bigint);

DO $$ BEGIN
  UPDATE public.system_settings SET value = '5'::jsonb WHERE key = 'page365_inventory_interval_minutes';
  RAISE EXCEPTION 'FAIL A: plain UPDATE was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  RAISE NOTICE 'ok  A: plain UPDATE refused by the guard (%)', left(SQLERRM, 60);
END $$;
DO $$ BEGIN
  DELETE FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes';
  RAISE EXCEPTION 'FAIL A: DELETE was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
  RAISE NOTICE 'ok  A: DELETE refused by the guard';
END $$;
DO $$ BEGIN
  PERFORM set_config('app.allow_page365_interval_change', 'on', true);
  UPDATE public.system_settings SET value = '15'::jsonb WHERE key = 'page365_inventory_interval_minutes';
  RAISE EXCEPTION 'FAIL A: 15 got past the CHECK';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  A: CHECK refuses 15 even past the guard';
END $$;
DO $$ BEGIN
  PERFORM set_config('app.allow_page365_interval_change', 'on', true);
  UPDATE public.system_settings SET value = '"5"'::jsonb WHERE key = 'page365_inventory_interval_minutes';
  RAISE EXCEPTION 'FAIL A: a JSON string got past the CHECK';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'ok  A: CHECK refuses a JSON string';
END $$;

-- Each allowed value: saved, read back, audited once (who, from, to, when).
SELECT pg_temp.eq('A: set 5',  (pg_temp.setv(5, 30)->>'minutes')::integer, 5);
SELECT pg_temp.eq('A: reader 5', public.page365_inventory_interval_minutes(), 5);
SELECT pg_temp.eq('A: stored as JSON number 5', (SELECT value FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes'), '5'::jsonb);
SELECT pg_temp.eq('A: audited once', pg_temp.audits(), 1::bigint);
SELECT pg_temp.eq('A: audit who', (SELECT performed_by_user_id FROM public.audit_logs WHERE action = 'set_page365_inventory_interval'),
  '99999999-0000-0000-0000-000000000002'::uuid);
SELECT pg_temp.eq('A: audit from -> to', (SELECT (old_value_json->>'minutes') || '->' || (new_value_json->>'minutes')
  FROM public.audit_logs WHERE action = 'set_page365_inventory_interval'), '30->5');
SELECT pg_temp.eq('A: audit when', (SELECT created_at IS NOT NULL AND created_at <= now() FROM public.audit_logs
  WHERE action = 'set_page365_inventory_interval'), true);
SELECT pg_temp.eq('A: setting stamped with the user', (SELECT updated_by_user_id FROM public.system_settings
  WHERE key = 'page365_inventory_interval_minutes'), '99999999-0000-0000-0000-000000000002'::uuid);
SELECT pg_temp.eq('A: stale screen refused', pg_temp.setv(10, 30)->>'error', 'stale');
SELECT pg_temp.eq('A: stale writes nothing', public.page365_inventory_interval_minutes(), 5);
SELECT pg_temp.eq('A: set 10', (pg_temp.setv(10, 5)->>'minutes')::integer, 10);
SELECT pg_temp.eq('A: reader 10', public.page365_inventory_interval_minutes(), 10);
SELECT pg_temp.eq('A: set 20', (pg_temp.setv(20)->>'minutes')::integer, 20);
SELECT pg_temp.eq('A: reader 20', public.page365_inventory_interval_minutes(), 20);
SELECT pg_temp.eq('A: set 30', (pg_temp.setv(30)->>'minutes')::integer, 30);
SELECT pg_temp.eq('A: reader 30', public.page365_inventory_interval_minutes(), 30);
SELECT pg_temp.eq('A: four changes, four audits', pg_temp.audits(), 4::bigint);
SELECT pg_temp.eq('A: get shows minutes + who', (SELECT (j->>'minutes') || '|' || (j->>'updated_by_name')
  FROM (SELECT public.get_page365_inventory_interval() j) x), '30|Catalog Staff');

-- Grants.
SELECT pg_temp.eq('grant: browser cannot read the service reader',
  has_function_privilege('authenticated', 'public.page365_inventory_interval_minutes()', 'EXECUTE'), false);
SELECT pg_temp.eq('grant: anon cannot set', has_function_privilege('anon', 'public.set_page365_inventory_interval(integer,integer)', 'EXECUTE'), false);
SELECT pg_temp.eq('grant: staff can set (permission checked inside)',
  has_function_privilege('authenticated', 'public.set_page365_inventory_interval(integer,integer)', 'EXECUTE'), true);
SELECT pg_temp.eq('grant: service role reads the interval',
  has_function_privilege('service_role', 'public.page365_inventory_interval_minutes()', 'EXECUTE'), true);

-- B. Next check (Hub card) -----------------------------------------------------
-- Expected tick, computed independently: first minute m ≡ 2 (mod 5), seconds 0,
-- at or after greatest(now, last + interval − 150 s).
CREATE OR REPLACE FUNCTION pg_temp.want_tick(p_from timestamptz) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT min(t) FROM generate_series(date_trunc('minute', p_from), date_trunc('minute', p_from) + interval '6 minutes', interval '1 minute') t
   WHERE t >= p_from AND extract(minute FROM t)::integer % 5 = 2 $$;
SELECT pg_temp.eq('B: no scheduled run -> next tick from now',
  (public.get_page365_inventory_interval()->>'next_check_at')::timestamptz, pg_temp.want_tick(now()));
DO $$
DECLARE m integer; ago integer; got timestamptz; want timestamptz; last timestamptz;
BEGIN
  FOREACH m IN ARRAY ARRAY[5, 10, 20, 30] LOOP
    PERFORM set_config('app.allow_page365_interval_change', 'on', true);
    UPDATE public.system_settings SET value = to_jsonb(m) WHERE key = 'page365_inventory_interval_minutes';
    PERFORM set_config('app.allow_page365_interval_change', '', true);
    FOREACH ago IN ARRAY ARRAY[0, 1, 4, 9, 19, 29, 45] LOOP
      DELETE FROM public.page365_inventory_runs;
      last := now() - make_interval(mins => ago);
      INSERT INTO public.page365_inventory_runs(source, kind, status, created_at) VALUES ('schedule', 'quick', 'failed', last);
      got  := (public.get_page365_inventory_interval()->>'next_check_at')::timestamptz;
      want := pg_temp.want_tick(greatest(now(), last + make_interval(secs => m * 60 - 150)));
      IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL B: interval % last % min ago: got % want %', m, ago, got, want; END IF;
      IF extract(minute FROM got)::integer % 5 <> 2 OR extract(second FROM got) <> 0 THEN
        RAISE EXCEPTION 'FAIL B: % is not a 2-59/5 tick', got;
      END IF;
      IF got < now() THEN RAISE EXCEPTION 'FAIL B: next check % is in the past', got; END IF;
      -- Never early: never before (interval − 2.5 min) after the last start.
      IF got < last + make_interval(secs => m * 60 - 150) THEN RAISE EXCEPTION 'FAIL B: % min early', m; END IF;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'ok  B: next_check_at for 5/10/20/30 × 7 ages';
END $$;
DELETE FROM public.page365_inventory_runs;
SELECT pg_temp.eq('B: back to 30', (pg_temp.setv(30)->>'ok')::boolean, true);

-- C. Time-safe hide ------------------------------------------------------------
--   IH  on Page365, then gone                   -> hidden only when 2 missing AND >= 30 min
--   IK  on Page365, then gone once, 31 min ago  -> never hidden (only 1 missing read)
INSERT INTO public.website_products(sku, status, origin, metals)
SELECT s, 'active', 'JAPAN', ARRAY['K18'] FROM unnest(ARRAY['IH','IK','IS']) s;
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, 2, 10000 FROM public.website_products WHERE sku IN ('IH','IK','IS');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('C: switch on', (public.set_page365_inventory_auto_apply(true, NULL)->>'enabled')::boolean, true);
SELECT set_config('test.uid', '', false);
CREATE TEMP TABLE r(k text PRIMARY KEY, id uuid);
CREATE TEMP TABLE l AS SELECT jsonb_build_array(pg_temp.p(810001, 'IH Ring K18', 2), pg_temp.p(810002, 'IK Ring K18', 2),
                                                pg_temp.p(810003, 'IS Ring K18', 2)) AS j;

INSERT INTO r VALUES ('S', pg_temp.run('schedule', 'full', pg_temp.catalogue((SELECT j FROM l))));
SELECT pg_temp.eq('C: seen', (SELECT count(*) FROM public.page365_product_presence
  WHERE website_product_id IN (pg_temp.pid('IH'), pg_temp.pid('IK'), pg_temp.pid('IS'))), 3::bigint);
-- 5-minute cadence: IH gone, two complete reads right after (as at 5 and 10 minutes).
INSERT INTO r VALUES ('M1', pg_temp.run('schedule', 'quick', pg_temp.catalogue((SELECT j FROM l) - 0)));
SELECT public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='M1'));
INSERT INTO r VALUES ('M2', pg_temp.run('schedule', 'quick', pg_temp.catalogue((SELECT j FROM l) - 0)));
SELECT pg_temp.eq('C: M2 IH missing twice', (pg_temp.item((SELECT id FROM r WHERE k='M2'), 'IH')).missing_runs, 2);
SELECT pg_temp.eq('C: M2 two missing reads < 30 min -> NOT hide', pg_temp.cat((SELECT id FROM r WHERE k='M2'), 'IH'), 'hub_only');
SELECT pg_temp.eq('C: M2 closes applied', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='M2'))->>'state', 'applied');
SELECT pg_temp.eq('C: IH still published', pg_temp.st('IH'), 'active');
SELECT pg_temp.eq('C: IH stock untouched', pg_temp.stock('IH'), 2);

-- 29 minutes since last seen: still not.
SELECT pg_temp.seen_ago('IH', interval '29 minutes');
INSERT INTO r VALUES ('M3', pg_temp.run('schedule', 'quick', pg_temp.catalogue((SELECT j FROM l) - 0)));
SELECT pg_temp.eq('C: M3 missing 3 times', (pg_temp.item((SELECT id FROM r WHERE k='M3'), 'IH')).missing_runs, 3);
SELECT pg_temp.eq('C: M3 29 min -> NOT hide', pg_temp.cat((SELECT id FROM r WHERE k='M3'), 'IH'), 'hub_only');
SELECT public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='M3'));
SELECT pg_temp.eq('C: IH still published after 29 min', pg_temp.st('IH'), 'active');

-- IK gone once; both IH and IK last seen 31 minutes ago.
SELECT pg_temp.seen_ago('IH', interval '31 minutes');
SELECT pg_temp.seen_ago('IK', interval '31 minutes');
INSERT INTO r VALUES ('M4', pg_temp.run('schedule', 'quick', pg_temp.catalogue(((SELECT j FROM l) - 0) - 0)));
SELECT pg_temp.eq('C: M4 IH 31 min + missing 4 -> hide', pg_temp.cat((SELECT id FROM r WHERE k='M4'), 'IH'), 'hide');
SELECT pg_temp.eq('C: M4 IK 31 min but missing once -> NOT hide', pg_temp.cat((SELECT id FROM r WHERE k='M4'), 'IK'), 'hub_only');
SELECT pg_temp.eq('C: M4 IK missing once', (pg_temp.item((SELECT id FROM r WHERE k='M4'), 'IK')).missing_runs, 1);
SELECT pg_temp.eq('C: M4 IS still seen', pg_temp.cat((SELECT id FROM r WHERE k='M4'), 'IS'), 'no_change');
SELECT pg_temp.eq('C: M4 hides 1', (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='M4'))->>'hidden')::integer, 1);
SELECT pg_temp.eq('C: IH hidden (draft)', pg_temp.st('IH'), 'draft');
SELECT pg_temp.eq('C: IH stock 0', pg_temp.stock('IH'), 0);
SELECT pg_temp.eq('C: IK still published', pg_temp.st('IK'), 'active');
SELECT pg_temp.eq('C: IS untouched', pg_temp.stock('IS'), 2);

-- D. Nothing else moved -------------------------------------------------------
SELECT pg_temp.eq('D: no other setting changed (the switch aside, turned on in C)',
  (SELECT md5(string_agg(key || '=' || coalesce(value::text, '') || '|' || coalesce(updated_at::text, ''), E'\n' ORDER BY key))
     FROM public.system_settings WHERE key NOT IN ('page365_inventory_interval_minutes', 'page365_inventory_auto_apply')),
  (SELECT h FROM other_settings));

\echo ALL PR 3d CHECKS PASSED
