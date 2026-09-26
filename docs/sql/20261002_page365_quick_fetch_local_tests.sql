-- ============================================================================
-- Page365 quick fetch + automatic increases (PR 3c) — LOCAL behaviour tests
-- (2026-10-02). Local Postgres only. Run after the stubs and all seven
-- earlier migrations, then this one (no new stub is needed):
--
--   (the PR 3b sequence from docs/sql/20261001_page365_hide_follow_local_stub.sql, then)
--   $P supabase/migrations/20261002100000_page365_quick_fetch.sql
--   $P supabase/migrations/20261002100000_page365_quick_fetch.sql   # re-run is safe
--   $P docs/sql/20261002_page365_quick_fetch_local_tests.sql
--
-- Every check RAISEs on failure; the last line prints ALL PR 3c CHECKS PASSED.
--
-- Covers: a quick run opens pages ONLY for listings that can hold a Hub
-- product (list code; a variant code seen in an earlier read; a Hub product
-- drafted from the listing) and never for a switched-off product; the rest
-- are 'listed', never claimed; hide-follow presence from a quick read (a
-- product gone from the list is missing; 2 in a row -> hidden); the shrink
-- guard on the LIST count; a detail error still makes the read partial;
-- switch ON -> a scheduled quick read applies decreases AND increases
-- (compare-and-set skip, never below 0, never N4020 "Don't sync"), one bell
-- naming both, audit direction; switch OFF / partial -> nothing; the nightly
-- full read (page365_inventory_next_kind); Create drafts refuses a stale
-- (not freshly read) row, uses the fresh quantity and photos, skips a listing
-- gone from Page365, only on a full run, not superseded by quick runs; the
-- fresh read never rewrites a stock row; one reader (reader lease).
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
-- A listing: pid, list name, variants (NULL = one variant named by the code),
-- availability for that single variant, a read error, photos.
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer, err text DEFAULT NULL,
                                     variants jsonb DEFAULT NULL, photos integer DEFAULT 0) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'error', err,
    'detail', CASE WHEN err IS NULL THEN jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL,
      'photos', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', pid * 100 + g, 'version', '1',
                   'url', 'https://assets.page365.net/x/' || pid || '-' || g || '.jpg?1', 'position', g)), '[]'::jsonb)
                   FROM generate_series(1, photos) g),
      'variants', coalesce(variants, jsonb_build_array(pg_temp.v(pid * 10, NULL, split_part(name, ' ', 1), avail)))) END) $$;

CREATE TEMP TABLE claims(run_id uuid PRIMARY KEY, n integer);
-- One run as page365-inventory-fetch does it: queue the list, plan a quick
-- run, claim -> store -> finish. Records how many pages were opened.
CREATE OR REPLACE FUNCTION pg_temp.run(p_source text, p_kind text, p_details jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb; v_n integer := 0;
BEGIN
  -- PR 3d: scheduled reads are >= 30 min apart in these scenarios. Hide now also
  -- needs the product last seen >= 30 min before the read, so age "seen" as a
  -- 30-minute interval would (runs themselves keep their times: auto-apply windows).
  UPDATE public.page365_product_presence
     SET first_seen_at = first_seen_at - interval '31 minutes', last_seen_at = last_seen_at - interval '31 minutes';
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES (p_source, p_kind, jsonb_array_length(p_details), jsonb_array_length(p_details)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name' FROM jsonb_array_elements(p_details) x;
  IF p_kind = 'quick' THEN PERFORM public.page365_inventory_plan_quick(v_run); END IF;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      v_n := v_n + 1;
      SELECT x INTO d FROM jsonb_array_elements(p_details) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', d->>'error');
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  INSERT INTO claims VALUES (v_run, v_n);
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.opened(p_run uuid) RETURNS integer LANGUAGE sql AS $$
  SELECT n FROM claims WHERE run_id = p_run $$;
CREATE OR REPLACE FUNCTION pg_temp.opened_names(p_run uuid) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(split_part(list_name, ' ', 1), ',' ORDER BY list_name) FROM public.page365_inventory_products
   WHERE run_id = p_run AND status <> 'listed' $$;
-- The catalogue: 40 Page365-only fillers plus the given listings.
CREATE OR REPLACE FUNCTION pg_temp.catalogue(p_extra jsonb, p_fillers integer DEFAULT 40) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce((SELECT jsonb_agg(pg_temp.p(500000 + g, 'PQ' || g || ' Ring K18', 1, NULL, NULL, 1))
                     FROM generate_series(1, p_fillers) g), '[]'::jsonb) || p_extra $$;
CREATE OR REPLACE FUNCTION pg_temp.bells(p_type text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.staff_notifications WHERE type = p_type $$;
CREATE OR REPLACE FUNCTION pg_temp.runrow(p_run uuid) RETURNS public.page365_inventory_runs LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_runs WHERE id = p_run $$;

INSERT INTO public.perm(user_id, key) SELECT '99999999-0000-0000-0000-000000000002', 'manage_website_catalog'
 WHERE NOT EXISTS (SELECT 1 FROM public.perm WHERE user_id = '99999999-0000-0000-0000-000000000002' AND key = 'manage_website_catalog');

-- Only this file's products and runs are in play.
DELETE FROM public.page365_inventory_runs;
DELETE FROM public.page365_product_presence;
DELETE FROM public.staff_notifications;
DELETE FROM public.audit_logs;
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = false WHERE page365_sync_disabled;
SELECT set_config('test.uid', '', false);
UPDATE public.website_products SET status = 'archived';
SELECT pg_temp.eq('switch starts off', (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'false');
SELECT pg_temp.eq('existing runs default to full', (SELECT column_default FROM information_schema.columns
  WHERE table_name = 'page365_inventory_runs' AND column_name = 'kind'), '''full''::text');

--   QN4020 "Don't sync with Page365"; Page365 has 5, Hub 1   -> never opened by a quick read, never touched
--   QD     Hub 3, Page365 1                                   -> automatic decrease
--   QI     Hub 0, Page365 2                                   -> automatic INCREASE
--   QS     Hub 1, Page365 3, a website sale after the read    -> compare-and-set skip
--   QH     on Page365, then gone                              -> hidden after 2 complete reads
--   QM1    a VARIANT code under listing "SET100 ..."          -> opened because an earlier read saw QM1 there
--   QC     a VARIANT code under listing "CHARM ...", drafted from that listing (page365_product_id)
--          and never seen in any read                         -> opened because the Hub product points at it
INSERT INTO public.website_products(sku, status, origin, metals)
SELECT s, 'active', 'JAPAN', ARRAY['K18'] FROM unnest(ARRAY['QN4020','QD','QI','QS','QH','QM1','QC']) s;
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, CASE sku WHEN 'QD' THEN 3 WHEN 'QI' THEN 0 ELSE 1 END, 10000
  FROM public.website_products WHERE sku IN ('QN4020','QD','QI','QS','QH','QM1','QC');
UPDATE public.website_products SET page365_product_id = 700700 WHERE sku = 'QC';
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'QN4020';
SELECT set_config('test.uid', '', false);

CREATE TEMP TABLE listings AS SELECT jsonb_build_array(
  pg_temp.p(600001, 'QN4020 Necklace K18', 5),
  pg_temp.p(600002, 'QD Ring K18', 1),
  pg_temp.p(600003, 'QI Ring K18', 2),
  pg_temp.p(600004, 'QS Ring K18', 3),
  pg_temp.p(600005, 'QH Ring K18', 1),
  pg_temp.p(600006, 'SET100 Earrings K18', NULL, NULL,
            jsonb_build_array(pg_temp.v(60000601, 'QM1 Hoop', 'QM1', 1), pg_temp.v(60000602, 'QX9 Stud', 'QX9', 1)))) AS j;
CREATE TEMP TABLE charm AS SELECT jsonb_build_array(
  pg_temp.p(700700, 'CHARM Pendant K18', NULL, NULL,
            jsonb_build_array(pg_temp.v(70070001, 'QC Heart', 'QC', 1), pg_temp.v(70070002, 'QZ8 Star', 'QZ8', 1)))) AS j;
CREATE TEMP TABLE r(k text PRIMARY KEY, id uuid);

-- F. Nightly-style FULL read, CHARM not listed yet: every page opened --------
INSERT INTO r VALUES ('F', pg_temp.run('schedule', 'full', pg_temp.catalogue((SELECT j FROM listings))));
SELECT pg_temp.eq('F: full, ready', (pg_temp.runrow((SELECT id FROM r WHERE k='F'))).status, 'ready');
SELECT pg_temp.eq('F: every page opened', pg_temp.opened((SELECT id FROM r WHERE k='F')), 46);
SELECT pg_temp.eq('F: nothing listed-only', (SELECT count(*) FROM public.page365_inventory_products
  WHERE run_id = (SELECT id FROM r WHERE k='F') AND status = 'listed'), 0::bigint);
SELECT pg_temp.eq('F: fillers are New in Page365', (SELECT count(*) FROM public.page365_inventory_items
  WHERE run_id = (SELECT id FROM r WHERE k='F') AND category = 'new'), 41::bigint);  -- 40 fillers + QX9
SELECT pg_temp.eq('F: QN4020 not_synced', pg_temp.cat((SELECT id FROM r WHERE k='F'), 'QN4020'), 'not_synced');
SELECT pg_temp.eq('F: QC hub-only (its listing is not on Page365 yet)', pg_temp.cat((SELECT id FROM r WHERE k='F'), 'QC'), 'hub_only');
-- A switched-OFF run closes 'off' and applies nothing.
SELECT pg_temp.eq('F: switch off -> nothing applied', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='F'))->>'state', 'off');
SELECT pg_temp.eq('F: QD untouched while off', pg_temp.stock('QD'), 3);
SELECT pg_temp.eq('F: QI untouched while off', pg_temp.stock('QI'), 0);

-- Turn the switch on.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('switch turned on', (public.set_page365_inventory_auto_apply(true, false)->>'enabled')::boolean, true);
SELECT set_config('test.uid', '', false);

-- Q1. Scheduled QUICK read: QH gone from the list, CHARM listed now ----------
INSERT INTO r VALUES ('Q1', pg_temp.run('schedule', 'quick',
  pg_temp.catalogue((SELECT j FROM listings) - 4 || (SELECT j FROM charm))));
SELECT pg_temp.eq('Q1: quick, ready', (pg_temp.runrow((SELECT id FROM r WHERE k='Q1'))).status, 'ready');
SELECT pg_temp.eq('Q1: pages opened only for Hub listings', pg_temp.opened_names((SELECT id FROM r WHERE k='Q1')), 'CHARM,QD,QI,QS,SET100');
SELECT pg_temp.eq('Q1: 5 pages opened', pg_temp.opened((SELECT id FROM r WHERE k='Q1')), 5);
SELECT pg_temp.eq('Q1: products_total = pages to open', (pg_temp.runrow((SELECT id FROM r WHERE k='Q1'))).products_total, 5);
SELECT pg_temp.eq('Q1: 41 listed-only (40 fillers + QN4020)', (pg_temp.runrow((SELECT id FROM r WHERE k='Q1'))).listed_total, 41);
SELECT pg_temp.eq('Q1: page365_count is the LIST count', (pg_temp.runrow((SELECT id FROM r WHERE k='Q1'))).page365_count, 46);
SELECT pg_temp.eq('Q1: QN4020 page never opened', (SELECT status FROM public.page365_inventory_products
  WHERE run_id = (SELECT id FROM r WHERE k='Q1') AND page365_product_id = 600001), 'listed');
SELECT pg_temp.eq('Q1: QN4020 not listed as missing (never opened)', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QN4020'), '(absent)');
SELECT pg_temp.eq('Q1: QM1 matched through the earlier read', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QM1'), 'no_change');
SELECT pg_temp.eq('Q1: QC matched through the drafted link', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QC'), 'no_change');
SELECT pg_temp.eq('Q1: QH missing once', (pg_temp.item((SELECT id FROM r WHERE k='Q1'), 'QH')).missing_runs, 1);
SELECT pg_temp.eq('Q1: QH not hidden yet', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QH'), 'hub_only');
SELECT pg_temp.eq('Q1: QD decrease', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QD'), 'decrease');
SELECT pg_temp.eq('Q1: QI increase', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QI'), 'increase');
SELECT pg_temp.eq('Q1: QS increase', pg_temp.cat((SELECT id FROM r WHERE k='Q1'), 'QS'), 'increase');
SELECT pg_temp.eq('Q1: presence recorded from the quick read', (SELECT last_seen_run_id FROM public.page365_product_presence
  WHERE website_product_id = pg_temp.pid('QD')), (SELECT id FROM r WHERE k='Q1'));
-- A website sale on QS after the read.
UPDATE public.website_product_variants SET stock_qty = 0 WHERE product_id = pg_temp.pid('QS');
CREATE TEMP TABLE res_q1 AS SELECT public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='Q1')) AS j;
SELECT pg_temp.eq('Q1: applied', (SELECT j->>'state' FROM res_q1), 'applied');
SELECT pg_temp.eq('Q1: two applied', (SELECT (j->>'applied')::integer FROM res_q1), 2);
SELECT pg_temp.eq('Q1: one of them an increase', (SELECT (j->>'increased')::integer FROM res_q1), 1);
SELECT pg_temp.eq('Q1: QD decreased 3 -> 1', pg_temp.stock('QD'), 1);
SELECT pg_temp.eq('Q1: QI INCREASED 0 -> 2', pg_temp.stock('QI'), 2);
SELECT pg_temp.eq('Q1: QS sold since the read -> skipped, not overwritten', pg_temp.stock('QS'), 0);
SELECT pg_temp.eq('Q1: QS changed_since_fetch', (pg_temp.item((SELECT id FROM r WHERE k='Q1'), 'QS')).status, 'changed_since_fetch');
SELECT pg_temp.eq('Q1: QN4020 untouched', pg_temp.stock('QN4020'), 1);
SELECT pg_temp.eq('Q1: run auto_increased', (pg_temp.runrow((SELECT id FROM r WHERE k='Q1'))).auto_increased, 1);
SELECT pg_temp.eq('Q1: run auto_applied', (pg_temp.runrow((SELECT id FROM r WHERE k='Q1'))).auto_applied, 2);
SELECT pg_temp.eq('Q1: increase audited as increase', (SELECT count(*) FROM public.audit_logs
  WHERE action = 'page365_inventory_auto_applied' AND new_value_json->>'direction' = 'increase'), 1::bigint);
SELECT pg_temp.eq('Q1: one bell', pg_temp.bells('page365_inventory_auto_applied'), 1::bigint);
SELECT pg_temp.eq('Q1: bell names both directions', (SELECT body FROM public.staff_notifications
  WHERE type = 'page365_inventory_auto_applied') LIKE '1 decrease(s) and 1 increase(s)%Down: QD. Up: QI.', true);
SELECT pg_temp.eq('Q1: bell title', (SELECT title FROM public.staff_notifications WHERE type = 'page365_inventory_auto_applied'),
  'Page365 stock updated automatically');
SELECT pg_temp.eq('Q1: second close is a no-op', (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='Q1'))->>'already')::boolean, true);

-- Q2. Quick read, QH still gone -> missing 2 complete reads in a row -> hidden
INSERT INTO r VALUES ('Q2', pg_temp.run('schedule', 'quick',
  pg_temp.catalogue((SELECT j FROM listings) - 4 || (SELECT j FROM charm))));
SELECT pg_temp.eq('Q2: QH proposed hide', pg_temp.cat((SELECT id FROM r WHERE k='Q2'), 'QH'), 'hide');
SELECT pg_temp.eq('Q2: close applies', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='Q2'))->>'hidden', '1');
SELECT pg_temp.eq('Q2: QH stock 0', pg_temp.stock('QH'), 0);
SELECT pg_temp.eq('Q2: QH unpublished', pg_temp.st('QH'), 'draft');
SELECT pg_temp.eq('Q2: QN4020 still untouched', pg_temp.stock('QN4020'), 1);
SELECT pg_temp.eq('Q2: QN4020 still published', pg_temp.st('QN4020'), 'active');

-- Q3. Quick read whose LIST shrank by more than 20 % -> partial, nothing applied
UPDATE public.website_product_variants SET stock_qty = 5 WHERE product_id = pg_temp.pid('QD');
INSERT INTO r VALUES ('Q3', pg_temp.run('schedule', 'quick',
  pg_temp.catalogue((SELECT j FROM listings) - 4 || (SELECT j FROM charm), 10)));
SELECT pg_temp.eq('Q3: shrink guard on the list count -> partial', (pg_temp.runrow((SELECT id FROM r WHERE k='Q3'))).status, 'partial');
SELECT pg_temp.eq('Q3: closes not_ready', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='Q3'))->>'state', 'not_ready');
SELECT pg_temp.eq('Q3: QD untouched', pg_temp.stock('QD'), 5);

-- Q4. Quick read with one opened page failing -> partial, nothing applied ----
INSERT INTO r VALUES ('Q4', pg_temp.run('schedule', 'quick',
  pg_temp.catalogue(jsonb_build_array(pg_temp.p(600003, 'QI Ring K18', 2, 'read error'))
                    || ((SELECT j FROM listings) - 4 - 2) || (SELECT j FROM charm))));
SELECT pg_temp.eq('Q4: a page error -> partial', (pg_temp.runrow((SELECT id FROM r WHERE k='Q4'))).status, 'partial');
SELECT pg_temp.eq('Q4: closes not_ready', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='Q4'))->>'state', 'not_ready');
SELECT pg_temp.eq('Q4: QD untouched', pg_temp.stock('QD'), 5);

-- Q5. Switch OFF: a complete quick read applies nothing ----------------------
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('switch turned off', (public.set_page365_inventory_auto_apply(false, true)->>'enabled')::boolean, false);
SELECT set_config('test.uid', '', false);
INSERT INTO r VALUES ('Q5', pg_temp.run('schedule', 'quick',
  pg_temp.catalogue((SELECT j FROM listings) - 4 || (SELECT j FROM charm))));
SELECT pg_temp.eq('Q5: ready', (pg_temp.runrow((SELECT id FROM r WHERE k='Q5'))).status, 'ready');
SELECT pg_temp.eq('Q5: QD proposed decrease', pg_temp.cat((SELECT id FROM r WHERE k='Q5'), 'QD'), 'decrease');
SELECT pg_temp.eq('Q5: switch off -> off', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='Q5'))->>'state', 'off');
SELECT pg_temp.eq('Q5: QD untouched', pg_temp.stock('QD'), 5);
SELECT pg_temp.eq('Q5: still one auto bell', pg_temp.bells('page365_inventory_auto_applied'), 1::bigint);

-- N. The nightly full read ---------------------------------------------------
SELECT pg_temp.eq('N: default hour 2 (02:00 PHT = 03:00 JST)',
  (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_full_hour_pht'), '2');
DO $n$
DECLARE v_full uuid := (SELECT id FROM r WHERE k='F');
BEGIN
  UPDATE public.page365_inventory_runs SET created_at = now() - interval '2 minutes' WHERE id = v_full;
  PERFORM pg_temp.eq('N: a scheduled full read since the boundary -> quick', public.page365_inventory_next_kind(), 'quick');
  UPDATE public.page365_inventory_runs SET created_at = now() - interval '25 hours' WHERE id = v_full;
  PERFORM pg_temp.eq('N: none since the last boundary -> full', public.page365_inventory_next_kind(), 'full');
  UPDATE public.page365_inventory_runs SET created_at = now() - interval '2 minutes', status = 'failed' WHERE id = v_full;
  PERFORM pg_temp.eq('N: the nightly read failed outright -> full again', public.page365_inventory_next_kind(), 'full');
  UPDATE public.page365_inventory_runs SET status = 'ready', source = 'manual' WHERE id = v_full;
  PERFORM pg_temp.eq('N: a staff Full fetch does not replace the nightly one', public.page365_inventory_next_kind(), 'full');
  UPDATE public.page365_inventory_runs SET source = 'schedule', created_at = now() - interval '1 hour' WHERE id = v_full;
  -- Quick runs never count as the nightly full read.
  UPDATE public.page365_inventory_runs SET created_at = now() - interval '25 hours' WHERE id = v_full;
  PERFORM pg_temp.eq('N: quick runs never count as the full read', public.page365_inventory_next_kind(), 'full');
  UPDATE public.page365_inventory_runs SET created_at = now() - interval '3 hours' WHERE id = v_full;
END $n$;

-- D. Create drafts reads FRESH ------------------------------------------------
DO $d$
DECLARE
  v_full  uuid := (SELECT id FROM r WHERE k='F');
  v_quick uuid := (SELECT id FROM r WHERE k='Q5');
  v_pq1   uuid;  v_pq2 uuid;  v_set uuid;
  v_i1    uuid := (pg_temp.item((SELECT id FROM r WHERE k='F'), 'PQ1')).id;
  v_i2    uuid := (pg_temp.item((SELECT id FROM r WHERE k='F'), 'PQ2')).id;
  v_res   jsonb;
BEGIN
  SELECT id INTO v_pq1 FROM public.page365_inventory_products WHERE run_id = v_full AND page365_product_id = 500001;
  SELECT id INTO v_pq2 FROM public.page365_inventory_products WHERE run_id = v_full AND page365_product_id = 500002;
  SELECT id INTO v_set FROM public.page365_inventory_products WHERE run_id = v_full AND page365_product_id = 600006;
  -- The full read is from last night.
  UPDATE public.page365_inventory_products SET fetched_at = now() - interval '3 hours' WHERE run_id = v_full;
  PERFORM set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);

  v_res := public.page365_inventory_create_drafts(v_quick, ARRAY[v_i1]);
  PERFORM pg_temp.eq('D: a quick run is refused', v_res->>'reason', 'not_full_fetch');
  v_res := public.page365_inventory_create_drafts(v_full, ARRAY[v_i1]);
  PERFORM pg_temp.eq('D: not superseded by the quick runs since', (v_res->>'ok')::boolean, true);
  PERFORM pg_temp.eq('D: not read fresh -> skipped', v_res->'skipped_items'->0->>'reason', 'not_fresh');
  PERFORM pg_temp.eq('D: nothing created', (v_res->>'created')::integer, 0);

  -- The fresh read: 7 on Page365 now, 3 photos.
  PERFORM set_config('test.uid', '', false);
  PERFORM pg_temp.eq('D: refresh on a quick run refused', public.page365_inventory_refresh_product(
    (SELECT id FROM public.page365_inventory_products WHERE run_id = v_quick AND page365_product_id = 600002),
    pg_temp.p(600002, 'QD Ring K18', 9)->'detail', NULL)->>'result', 'not_a_full_run');
  PERFORM pg_temp.eq('D: refreshed', public.page365_inventory_refresh_product(v_pq1,
    pg_temp.p(500001, 'PQ1 Ring K18', 7, NULL, NULL, 3)->'detail', NULL)->>'result', 'refreshed');
  PERFORM pg_temp.eq('D: fresh quantity on the row', (pg_temp.item(v_full, 'PQ1')).page365_available, 7);
  PERFORM pg_temp.eq('D: fresh photos on the listing', (SELECT jsonb_array_length(photos) FROM public.page365_inventory_products WHERE id = v_pq1), 3);
  PERFORM pg_temp.eq('D: listing gone -> marked', public.page365_inventory_refresh_product(v_pq2, NULL, 'gone')->>'result', 'gone');
  PERFORM pg_temp.eq('D: a read error changes nothing', public.page365_inventory_refresh_product(v_set, NULL, 'HTTP 500')->>'result', 'error');
  -- The fresh read of a listing with a STOCK row never rewrites that row.
  PERFORM public.page365_inventory_refresh_product(v_set, pg_temp.p(600006, 'SET100 Earrings K18', NULL, NULL,
    jsonb_build_array(pg_temp.v(60000601, 'QM1 Hoop', 'QM1', 9), pg_temp.v(60000602, 'QX9 Stud', 'QX9', 4)))->'detail', NULL);
  PERFORM pg_temp.eq('D: matched QM1 row untouched', (pg_temp.item(v_full, 'QM1')).page365_available, 1);
  PERFORM pg_temp.eq('D: new QX9 row refreshed', (pg_temp.item(v_full, 'QX9')).page365_available, 4);

  PERFORM set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
  v_res := public.page365_inventory_create_drafts(v_full, ARRAY[v_i1, v_i2]);
  PERFORM pg_temp.eq('D: one created', (v_res->>'created')::integer, 1);
  PERFORM pg_temp.eq('D: gone one skipped', v_res->'skipped_items'->0->>'reason', 'gone_from_page365');
  PERFORM pg_temp.eq('D: draft has the FRESH quantity', pg_temp.stock('PQ1'), 7);
  PERFORM pg_temp.eq('D: draft photos from the fresh read', (v_res->'created_items'->0->>'photos')::integer, 3);
  PERFORM pg_temp.eq('D: a draft', pg_temp.st('PQ1'), 'draft');

  -- A newer FULL read supersedes it.
  PERFORM set_config('test.uid', '', false);
  PERFORM pg_temp.run('manual', 'full', pg_temp.catalogue((SELECT j FROM listings)));
  PERFORM set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
  v_res := public.page365_inventory_create_drafts(v_full, ARRAY[(pg_temp.item(v_full, 'PQ3')).id]);
  PERFORM pg_temp.eq('D: superseded by a newer full read', v_res->>'reason', 'superseded');
  PERFORM set_config('test.uid', '', false);
END $d$;

-- L. One reader ---------------------------------------------------------------
DO $l$
DECLARE v_run uuid;
BEGIN
  PERFORM pg_temp.eq('L: refresh takes the reader lease', public.page365_inventory_reader_lease('refresh:a', 60), true);
  PERFORM pg_temp.eq('L: a second refresh waits', public.page365_inventory_reader_lease('refresh:b', 60), false);
  PERFORM pg_temp.eq('L: the holder renews', public.page365_inventory_reader_lease('refresh:a', 60), true);
  PERFORM public.page365_inventory_reader_release('refresh:a');
  INSERT INTO public.page365_inventory_runs(source, kind) VALUES ('schedule', 'quick') RETURNING id INTO v_run;
  PERFORM pg_temp.eq('L: run lease taken', public.page365_inventory_lease(v_run, 'schedule:x', 60), true);
  PERFORM pg_temp.eq('L: refresh waits while a run is being read', public.page365_inventory_reader_lease('refresh:a', 60), false);
  PERFORM public.page365_inventory_release(v_run, 'schedule:x');
  PERFORM pg_temp.eq('L: free again', public.page365_inventory_reader_lease('refresh:a', 60), true);
  PERFORM public.page365_inventory_reader_release('refresh:a');
  PERFORM pg_temp.eq('L: plan_quick refuses a full run', public.page365_inventory_plan_quick(
    (SELECT id FROM r WHERE k='F'))->>'reason', 'not_a_quick_fetching_run');
  DELETE FROM public.page365_inventory_runs WHERE id = v_run;
END $l$;

SELECT 'ALL PR 3c CHECKS PASSED' AS result;
