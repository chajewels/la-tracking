-- ============================================================================
-- Page365 inventory PR 3 (schedule) — LOCAL behaviour tests (2026-09-30).
-- Local Postgres only: run after the stubs and all five migrations (see
-- docs/sql/20260930_page365_inventory_schedule_local_stub.sql for the order).
-- Every check RAISEs on failure; the last line prints ALL PR 3 CHECKS PASSED.
--
-- Covers: the switch (seeded off, left off by the migration, guarded against
-- direct writes, changed only by manage_website_catalog through the RPC,
-- audited, stale-click refusal); switch OFF -> a scheduled run applies
-- nothing; switch ON -> decreases applied, increases never, a product switched
-- to "Don't sync with Page365" (before or after the fetch) skipped,
-- compare-and-set skip when stock moved, audit per row and per run, exactly
-- one bell, idempotent close; a partial run applies nothing and raises one
-- failure bell; window passed / superseded / manual runs apply nothing; the
-- lease (one reader at a time, lapses, only while fetching); retention (old
-- unapplied runs deleted, applied runs keep their audit rows / applied items /
-- product rows, never a fetching run, never the latest ready run, never
-- audit_logs); grants; the cron job.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_sku text) RETURNS integer LANGUAGE sql AS $$
  SELECT v.stock_qty FROM public.website_products p JOIN public.website_product_variants v ON v.product_id=p.id WHERE p.sku=p_sku ORDER BY v.id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id=p_run AND coalesce(code, hub_sku)=p_code ORDER BY page365_variant_id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer, err text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'error', err,
    'detail', CASE WHEN err IS NULL THEN jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', split_part(name, ' ', 1),
                                                      'price_jpy', 10000, 'full_price_jpy', NULL, 'available', avail))) END) $$;
-- One complete run (claim -> store -> finish), as the edge function does it.
CREATE OR REPLACE FUNCTION pg_temp.run(p_source text, p_details jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(source, page365_count, products_total)
  VALUES (p_source, jsonb_array_length(p_details), jsonb_array_length(p_details)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name' FROM jsonb_array_elements(p_details) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_details) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', d->>'error');
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  RETURN v_run;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.catalogue(a1 int, a2 int, a3 int, a4 int, a5 int, err4 text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(pg_temp.p(3001, 'ZS3001 Ring', a1), pg_temp.p(3002, 'ZS3002 Ring', a2), pg_temp.p(3003, 'ZS3003 Ring', a3),
                           pg_temp.p(3004, 'ZS3004 Ring', a4, err4), pg_temp.p(3005, 'ZS3005 Ring', a5)) $$;
CREATE OR REPLACE FUNCTION pg_temp.bells(p_type text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.staff_notifications WHERE type = p_type $$;
CREATE OR REPLACE FUNCTION pg_temp.audits(p_action text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.audit_logs WHERE action = p_action $$;

-- Users: U1 has no catalogue permission, U2 has manage_website_catalog.
INSERT INTO public.perm(user_id, key) SELECT '99999999-0000-0000-0000-000000000002', 'manage_website_catalog'
 WHERE NOT EXISTS (SELECT 1 FROM public.perm WHERE user_id = '99999999-0000-0000-0000-000000000002' AND key = 'manage_website_catalog');

-- Only this file's products and runs are in play.
DELETE FROM public.page365_inventory_runs;
INSERT INTO public.website_products(sku) VALUES ('ZS3001'), ('ZS3002'), ('ZS3003'), ('ZS3004'), ('ZS3005');
INSERT INTO public.website_product_variants(product_id, stock_qty)
SELECT id, CASE sku WHEN 'ZS3001' THEN 5 WHEN 'ZS3002' THEN 2 WHEN 'ZS3003' THEN 3 WHEN 'ZS3004' THEN 4 ELSE 6 END
  FROM public.website_products WHERE sku IN ('ZS3001','ZS3002','ZS3003','ZS3004','ZS3005');

-- 1. The switch -------------------------------------------------------------
SELECT pg_temp.eq('switch seeded and left off', (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'false');
DO $$ BEGIN
  UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'page365_inventory_auto_apply';
  RAISE EXCEPTION 'FAIL direct write of the switch was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE '%changed only from the Hub%' THEN RAISE; END IF;
  RAISE NOTICE 'ok  direct UPDATE of the switch refused';
END $$;
DO $$ BEGIN
  DELETE FROM public.system_settings WHERE key = 'page365_inventory_auto_apply';
  RAISE EXCEPTION 'FAIL delete of the switch was allowed';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE '%changed only from the Hub%' THEN RAISE; END IF;
  RAISE NOTICE 'ok  DELETE of the switch refused';
END $$;
SELECT set_config('test.uid', '', false);
SELECT pg_temp.eq('set without a user refused', public.set_page365_inventory_auto_apply(true, NULL)->>'error', 'user_identity_required');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000001', false);
SELECT pg_temp.eq('set without the permission refused', public.set_page365_inventory_auto_apply(true, NULL)->>'error', 'permission_denied');
SELECT pg_temp.eq('get without the permission refused', public.get_page365_inventory_auto_apply()->>'error', 'permission_denied');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('get reads off', (public.get_page365_inventory_auto_apply()->>'enabled')::boolean, false);
SELECT pg_temp.eq('stale click refused', public.set_page365_inventory_auto_apply(false, true)->>'error', 'stale');
SELECT pg_temp.eq('same state: no change, no audit', (public.set_page365_inventory_auto_apply(false, false)->>'changed')::boolean, false);
SELECT pg_temp.eq('no switch audit yet', pg_temp.audits('set_page365_inventory_auto_apply'), 0::bigint);
SELECT set_config('test.uid', '', false);

-- 2. Switch OFF: a scheduled run applies nothing ------------------------------
--    Page365: 3001 has 2 (decrease 5->2), 3002 has 5 (increase 2->5),
--    3003 has 1 (decrease 3->1), 3004 has 4 (no change), 3005 has 1 (decrease 6->1).
CREATE TEMP TABLE r(k text PRIMARY KEY, id uuid);
INSERT INTO r VALUES ('off', pg_temp.run('schedule', pg_temp.catalogue(2, 5, 1, 4, 1)));
SELECT pg_temp.eq('off: run ready', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='off')), 'ready');
SELECT pg_temp.eq('off: 3001 proposed a decrease', (pg_temp.item((SELECT id FROM r WHERE k='off'), 'ZS3001')).category, 'decrease');
SELECT pg_temp.eq('off: closes as off', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='off'))->>'state', 'off');
SELECT pg_temp.eq('off: 3001 untouched', pg_temp.stock('ZS3001'), 5);
SELECT pg_temp.eq('off: 3005 untouched', pg_temp.stock('ZS3005'), 6);
SELECT pg_temp.eq('off: rows still for review', (pg_temp.item((SELECT id FROM r WHERE k='off'), 'ZS3001')).status, 'review');
SELECT pg_temp.eq('off: no auto audit', pg_temp.audits('page365_inventory_auto_applied'), 0::bigint);
SELECT pg_temp.eq('off: no run audit while off', pg_temp.audits('page365_inventory_auto_apply'), 0::bigint);
SELECT pg_temp.eq('off: no bell', pg_temp.bells('page365_inventory_auto_applied') + pg_temp.bells('page365_inventory_run_failed'), 0::bigint);
SELECT pg_temp.eq('off: recorded on the run', (SELECT auto_apply_state || '/' || auto_applied FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='off')), 'off/0');
SELECT pg_temp.eq('off: closing twice is a no-op', (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='off'))->>'already')::boolean, true);

-- Turn it on, as a catalogue user.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('switch turned on', (public.set_page365_inventory_auto_apply(true, false)->>'enabled')::boolean, true);
SELECT pg_temp.eq('switch audited once', pg_temp.audits('set_page365_inventory_auto_apply'), 1::bigint);
SELECT pg_temp.eq('audit names the user', (SELECT performed_by_user_id FROM public.audit_logs WHERE action = 'set_page365_inventory_auto_apply'),
                  '99999999-0000-0000-0000-000000000002'::uuid);
SELECT pg_temp.eq('audit old -> new', (SELECT (old_value_json->>'enabled') || '->' || (new_value_json->>'enabled') FROM public.audit_logs
                  WHERE action = 'set_page365_inventory_auto_apply'), 'false->true');
SELECT pg_temp.eq('value stored as JSON true', (SELECT value FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'true'::jsonb);
SELECT set_config('test.uid', '', false);

-- 3. Switch ON: decreases only ------------------------------------------------
INSERT INTO r VALUES ('on', pg_temp.run('schedule', pg_temp.catalogue(2, 5, 1, 4, 1)));
-- After the fetch: 3003 is switched to "Don't sync with Page365", and a website
-- sale moves 3005 (6 -> 7 here, any move counts).
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'ZS3003';
SELECT set_config('test.uid', '', false);
UPDATE public.website_product_variants SET stock_qty = 7 WHERE product_id = (SELECT id FROM public.website_products WHERE sku = 'ZS3005');
CREATE TEMP TABLE res AS SELECT public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='on')) AS j;
SELECT pg_temp.eq('on: state applied', (SELECT j->>'state' FROM res), 'applied');
SELECT pg_temp.eq('on: exactly one applied', (SELECT (j->>'applied')::int FROM res), 1);
SELECT pg_temp.eq('on: decrease 3001 applied 5 -> 2', pg_temp.stock('ZS3001'), 2);
SELECT pg_temp.eq('on: row marked auto-applied', (SELECT status || '/' || result_note FROM public.page365_inventory_items
                  WHERE id = (pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3001')).id), 'applied/auto_applied');
SELECT pg_temp.eq('on: auto rows have no staff user', (pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3001')).applied_by, NULL::uuid);
SELECT pg_temp.eq('on: increase 3002 NEVER applied', pg_temp.stock('ZS3002'), 2);
SELECT pg_temp.eq('on: increase still waits for staff', (pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3002')).status, 'review');
SELECT pg_temp.eq('on: switched-off 3003 untouched', pg_temp.stock('ZS3003'), 3);
SELECT pg_temp.eq('on: switched-off 3003 note', (pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3003')).result_note, 'sync_disabled');
SELECT pg_temp.eq('on: switched-off 3003 stays under review', (pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3003')).status, 'review');
SELECT pg_temp.eq('on: moved 3005 not overwritten', pg_temp.stock('ZS3005'), 7);
SELECT pg_temp.eq('on: moved 3005 changed_since_fetch', (pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3005')).status, 'changed_since_fetch');
SELECT pg_temp.eq('on: 3004 unchanged', pg_temp.stock('ZS3004'), 4);
SELECT pg_temp.eq('on: one audit per applied row', pg_temp.audits('page365_inventory_auto_applied'), 1::bigint);
SELECT pg_temp.eq('on: audit row is the 3001 variant, 5 -> 2',
  (SELECT (old_value_json->>'stock_qty') || '->' || (new_value_json->>'stock_qty') || ' ' || (new_value_json->>'source')
     FROM public.audit_logs WHERE action = 'page365_inventory_auto_applied'), '5->2 schedule');
SELECT pg_temp.eq('on: one run audit', pg_temp.audits('page365_inventory_auto_apply'), 1::bigint);
SELECT pg_temp.eq('on: one bell', pg_temp.bells('page365_inventory_auto_applied'), 1::bigint);
SELECT pg_temp.eq('on: bell names the code', (SELECT body LIKE '%ZS3001%' FROM public.staff_notifications WHERE type = 'page365_inventory_auto_applied'), true);
SELECT pg_temp.eq('on: run records 1 applied / 1 changed / 1 skipped',
  (SELECT auto_apply_state || '/' || auto_applied || '/' || auto_apply_changed || '/' || auto_apply_skipped
     FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='on')), 'applied/1/1/1');
SELECT pg_temp.eq('on: second close is a no-op', (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='on'))->>'already')::boolean, true);
SELECT pg_temp.eq('on: still one bell', pg_temp.bells('page365_inventory_auto_applied'), 1::bigint);
SELECT pg_temp.eq('on: still one applied audit', pg_temp.audits('page365_inventory_auto_applied'), 1::bigint);
-- Staff can still apply the increase by hand from the scheduled run.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('staff applies the increase by hand',
  (public.page365_inventory_apply((SELECT id FROM r WHERE k='on'), '{}'::uuid[],
      ARRAY[(pg_temp.item((SELECT id FROM r WHERE k='on'), 'ZS3002')).id])->>'applied')::int, 1);
SELECT set_config('test.uid', '', false);
SELECT pg_temp.eq('manual increase landed 2 -> 5', pg_temp.stock('ZS3002'), 5);

-- 4. Switched off BEFORE the fetch: not_synced, never applied ------------------
--    Page365 now: 3001 has 1 (2 -> 1), 3003 has 0 (would be 3 -> 0).
INSERT INTO r VALUES ('ns', pg_temp.run('schedule', pg_temp.catalogue(1, 5, 0, 4, 7)));
SELECT pg_temp.eq('ns: 3003 is not_synced', (pg_temp.item((SELECT id FROM r WHERE k='ns'), 'ZS3003')).category, 'not_synced');
SELECT pg_temp.eq('ns: applied only 3001', (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='ns'))->>'applied')::int, 1);
SELECT pg_temp.eq('ns: 3001 2 -> 1', pg_temp.stock('ZS3001'), 1);
SELECT pg_temp.eq('ns: switched-off 3003 still 3', pg_temp.stock('ZS3003'), 3);

-- 5. A partial read applies NOTHING and raises one failure bell ----------------
INSERT INTO r VALUES ('partial', pg_temp.run('schedule', pg_temp.catalogue(0, 5, 0, 4, 7, 'HTTP 503')));
SELECT pg_temp.eq('partial: run partial', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='partial')), 'partial');
SELECT pg_temp.eq('partial: 3001 was a decrease on paper', (pg_temp.item((SELECT id FROM r WHERE k='partial'), 'ZS3001')).category, 'decrease');
SELECT pg_temp.eq('partial: closes not_ready', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='partial'))->>'state', 'not_ready');
SELECT pg_temp.eq('partial: 3001 untouched', pg_temp.stock('ZS3001'), 1);
SELECT pg_temp.eq('partial: one failure bell', pg_temp.bells('page365_inventory_run_failed'), 1::bigint);
SELECT pg_temp.eq('partial: close again, still one bell',
  (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='partial'))->>'already')::boolean
    AND pg_temp.bells('page365_inventory_run_failed') = 1, true);
-- A failed (list-level) scheduled run: one bell too.
INSERT INTO public.page365_inventory_runs(source, status, error, finished_at) VALUES ('schedule', 'failed', 'list page 1: HTTP 502', now())
RETURNING id \gset failed_
SELECT pg_temp.eq('failed: closes not_ready', public.page365_inventory_auto_apply_run(:'failed_id')->>'state', 'not_ready');
SELECT pg_temp.eq('failed: second failure bell', pg_temp.bells('page365_inventory_run_failed'), 2::bigint);

-- 6. Out of window / superseded / manual: nothing ------------------------------
INSERT INTO r VALUES ('late', pg_temp.run('schedule', pg_temp.catalogue(0, 5, 0, 4, 7)));
UPDATE public.page365_inventory_runs SET created_at = now() - interval '40 minutes' WHERE id = (SELECT id FROM r WHERE k='late');
SELECT pg_temp.eq('late: window_passed', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='late'))->>'state', 'window_passed');
SELECT pg_temp.eq('late: 3001 untouched', pg_temp.stock('ZS3001'), 1);
INSERT INTO r VALUES ('old', pg_temp.run('schedule', pg_temp.catalogue(0, 5, 0, 4, 7)));
INSERT INTO r VALUES ('newer', pg_temp.run('manual', pg_temp.catalogue(0, 5, 0, 4, 7)));
SELECT pg_temp.eq('superseded: nothing', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='old'))->>'state', 'superseded');
SELECT pg_temp.eq('superseded: 3001 untouched', pg_temp.stock('ZS3001'), 1);
SELECT pg_temp.eq('manual run is never auto-applied', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='newer'))->>'reason', 'not_scheduled');
SELECT pg_temp.eq('manual run: 3001 untouched', pg_temp.stock('ZS3001'), 1);
SELECT pg_temp.eq('manual run: no state written', (SELECT auto_apply_state FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='newer')), NULL::text);
SELECT pg_temp.eq('still one auto-applied bell per applying run (2)', pg_temp.bells('page365_inventory_auto_applied'), 2::bigint);

-- 7. The lease: one reader at a time -------------------------------------------
INSERT INTO public.page365_inventory_runs(source) VALUES ('schedule') RETURNING id \gset lease_
SELECT pg_temp.eq('lease: A takes it', public.page365_inventory_lease(:'lease_id', 'schedule:A', 120), true);
SELECT pg_temp.eq('lease: manual B waits', public.page365_inventory_lease(:'lease_id', 'manual:B', 120), false);
SELECT pg_temp.eq('lease: A renews', public.page365_inventory_lease(:'lease_id', 'schedule:A', 120), true);
SELECT public.page365_inventory_release(:'lease_id', 'manual:B');
SELECT pg_temp.eq('lease: B cannot release A', public.page365_inventory_lease(:'lease_id', 'manual:B', 120), false);
SELECT public.page365_inventory_release(:'lease_id', 'schedule:A');
SELECT pg_temp.eq('lease: after release B takes it', public.page365_inventory_lease(:'lease_id', 'manual:B', 120), true);
UPDATE public.page365_inventory_runs SET lease_until = now() - interval '1 second' WHERE id = :'lease_id';
SELECT pg_temp.eq('lease: a lapsed lease is taken over', public.page365_inventory_lease(:'lease_id', 'schedule:C', 120), true);
SELECT pg_temp.eq('lease: fetching run cannot be auto-applied', public.page365_inventory_auto_apply_run(:'lease_id')->>'reason', 'still_fetching');
UPDATE public.page365_inventory_runs SET status = 'failed', error = 'test', finished_at = now() WHERE id = :'lease_id';
SELECT pg_temp.eq('lease: only while fetching', public.page365_inventory_lease(:'lease_id', 'schedule:D', 120), false);
SELECT pg_temp.eq('lease: empty holder refused', public.page365_inventory_lease((SELECT id FROM r WHERE k='on'), '', 120), false);

-- 8. Retention -----------------------------------------------------------------
-- An open (fetching) old run, an old run where nothing was applied ('off'),
-- and an old run where something was ('on').
INSERT INTO public.page365_inventory_runs(source, created_at) VALUES ('manual', now() - interval '30 days') RETURNING id \gset open_
UPDATE public.page365_inventory_runs SET created_at = now() - interval '20 days'
 WHERE id IN ((SELECT id FROM r WHERE k='off'), (SELECT id FROM r WHERE k='on'));
CREATE TEMP TABLE before_audit AS SELECT count(*) AS n, md5(string_agg(id::text, ',' ORDER BY id)) AS h FROM public.audit_logs;
CREATE TEMP TABLE kept_item AS SELECT id, inventory_product_id FROM public.page365_inventory_items
 WHERE run_id = (SELECT id FROM r WHERE k='on') AND status = 'applied';
CREATE TEMP TABLE ret AS SELECT public.page365_inventory_retention(14) AS j;
SELECT pg_temp.eq('retention: unapplied old run deleted', (SELECT count(*) FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='off')), 0::bigint);
SELECT pg_temp.eq('retention: its items went with it', (SELECT count(*) FROM public.page365_inventory_items WHERE run_id = (SELECT id FROM r WHERE k='off')), 0::bigint);
SELECT pg_temp.eq('retention: applied old run kept', (SELECT count(*) FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='on')), 1::bigint);
SELECT pg_temp.eq('retention: applied old run marked pruned', (SELECT pruned_at IS NOT NULL FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='on')), true);
SELECT pg_temp.eq('retention: every applied item kept (auto + manual = 2)', (SELECT count(*) FROM public.page365_inventory_items
                  WHERE run_id = (SELECT id FROM r WHERE k='on') AND id IN (SELECT id FROM kept_item)), 2::bigint);
SELECT pg_temp.eq('retention: only applied items left on that run', (SELECT count(*) FROM public.page365_inventory_items
                  WHERE run_id = (SELECT id FROM r WHERE k='on') AND status <> 'applied'), 0::bigint);
SELECT pg_temp.eq('retention: product rows of applied items kept', (SELECT count(*) FROM public.page365_inventory_products
                  WHERE id IN (SELECT inventory_product_id FROM kept_item)), 2::bigint);
SELECT pg_temp.eq('retention: other product rows of that run gone', (SELECT count(*) FROM public.page365_inventory_products
                  WHERE run_id = (SELECT id FROM r WHERE k='on')), 2::bigint);
SELECT pg_temp.eq('retention: chunk log of that run gone', (SELECT count(*) FROM public.page365_inventory_chunks WHERE run_id = (SELECT id FROM r WHERE k='on')), 0::bigint);
SELECT pg_temp.eq('retention: a fetching run is never touched', (SELECT count(*) FROM public.page365_inventory_runs WHERE id = :'open_id'), 1::bigint);
SELECT pg_temp.eq('retention: recent runs untouched', (SELECT count(*) FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='ns')), 1::bigint);
SELECT pg_temp.eq('retention: audit_logs NEVER touched', (SELECT count(*) || md5(string_agg(id::text, ',' ORDER BY id)) FROM public.audit_logs),
                  (SELECT n || h FROM before_audit));
SELECT pg_temp.eq('retention: second pass changes nothing', (public.page365_inventory_retention(14)->>'runs_pruned')::int
                  + (public.page365_inventory_retention(14)->>'runs_deleted')::int, 0);
SELECT pg_temp.eq('retention: never fewer than 7 days', (public.page365_inventory_retention(1)->>'keep_days')::int, 7);
SELECT pg_temp.eq('retention: 7-day floor kept the recent runs', (SELECT count(*) FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='ns')), 1::bigint);
-- The latest ready run is never removed, however old.
DELETE FROM public.page365_inventory_runs WHERE id = :'open_id';
UPDATE public.page365_inventory_runs SET created_at = created_at - interval '60 days';
SELECT public.page365_inventory_retention(14);
SELECT pg_temp.eq('retention: the latest ready run (manual, nothing applied) survives',
                  (SELECT count(*) FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='newer')), 1::bigint);
SELECT pg_temp.eq('retention: ... unpruned', (SELECT pruned_at FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='newer')), NULL::timestamptz);
SELECT pg_temp.eq('retention: the other old unapplied runs are gone', (SELECT count(*) FROM public.page365_inventory_runs
                  WHERE id IN (SELECT id FROM r WHERE k IN ('partial','late','old'))), 0::bigint);
SELECT pg_temp.eq('retention: audit_logs still whole', (SELECT count(*) FROM public.audit_logs), (SELECT n FROM before_audit));

-- 9. Grants and the schedule -------------------------------------------------------
SELECT pg_temp.eq('grant: browser cannot auto-apply', has_function_privilege('authenticated', 'public.page365_inventory_auto_apply_run(uuid)', 'EXECUTE'), false);
SELECT pg_temp.eq('grant: browser cannot run retention', has_function_privilege('authenticated', 'public.page365_inventory_retention(integer)', 'EXECUTE'), false);
SELECT pg_temp.eq('grant: browser cannot take the lease', has_function_privilege('authenticated', 'public.page365_inventory_lease(uuid,text,integer)', 'EXECUTE'), false);
SELECT pg_temp.eq('grant: anon cannot set the switch', has_function_privilege('anon', 'public.set_page365_inventory_auto_apply(boolean,boolean)', 'EXECUTE'), false);
SELECT pg_temp.eq('grant: staff can set the switch', has_function_privilege('authenticated', 'public.set_page365_inventory_auto_apply(boolean,boolean)', 'EXECUTE'), true);
SELECT pg_temp.eq('cron: one job, every 5 minutes offset 2', (SELECT schedule FROM cron.job WHERE jobname = 'page365-inventory-schedule'), '2-59/5 * * * *');
SELECT pg_temp.eq('cron: Vault key, schedule action', (SELECT command LIKE '%vault.decrypted_secrets%' AND command LIKE '%"action":"schedule"%'
                  AND command NOT LIKE '%eyJ%' FROM cron.job WHERE jobname = 'page365-inventory-schedule'), true);

-- Turn it back off through the RPC (audited), as the owner would.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('switch turned off', (public.set_page365_inventory_auto_apply(false, true)->>'enabled')::boolean, false);
SELECT pg_temp.eq('switch audited twice', pg_temp.audits('set_page365_inventory_auto_apply'), 2::bigint);
SELECT set_config('test.uid', '', false);

SELECT 'ALL PR 3 CHECKS PASSED' AS result;
