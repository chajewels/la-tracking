-- ============================================================================
-- Page365 hide-follow (PR 3b) — LOCAL behaviour tests (2026-10-01).
-- Local Postgres only: run after the stubs and all six migrations (see
-- docs/sql/20261001_page365_hide_follow_local_stub.sql for the order).
-- Every check RAISEs on failure; the last line prints ALL PR 3b CHECKS PASSED.
--
-- Covers: seen is recorded only by COMPLETE reads (on the code matched); not
-- proposed after 1 missing read, proposed after 2 in a row; a partial read
-- neither proposes, counts nor records seen, and a partial scheduled read
-- hides nothing; never a product never seen (Hub-only) nor one whose code
-- changed since it was seen; never a product switched to "Don't sync with
-- Page365" (at the read, or switched after it); never one already unpublished;
-- switch OFF -> a scheduled read hides nothing; manual hide: permission,
-- compare-and-set skip, stock 0 + draft, audit per product and per run, one
-- bell per run, second press no-op, superseded refused; switch ON -> the
-- scheduled read hides by itself, one combined bell, run records the count;
-- back in Page365 flagged, never re-published automatically (increase not
-- applied either), hide mark cleared once staff re-publish; orders untouched.
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
  -- Runs are ordered by created_at; keep them strictly apart.
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;
-- The Page365 catalogue: always the anchor N4020 plus 40 Page365-only fillers
-- (so dropping a few codes never trips the > 20 % shrink guard), plus the
-- given codes. Product ids follow the code, so a code keeps its Page365 id.
CREATE OR REPLACE FUNCTION pg_temp.catalogue(p_codes text[], p_err text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_agg(pg_temp.p(4000 + abs(hashtext(c)) % 900000, c || ' Ring', 1, CASE WHEN c = p_err THEN 'read error' END))
    FROM unnest(ARRAY['N4020'] || (SELECT array_agg('PG' || g) FROM generate_series(1, 40) g) || p_codes) AS t(c) $$;
CREATE OR REPLACE FUNCTION pg_temp.bells(p_type text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.staff_notifications WHERE type = p_type $$;
CREATE OR REPLACE FUNCTION pg_temp.audits(p_action text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.audit_logs WHERE action = p_action $$;
CREATE OR REPLACE FUNCTION pg_temp.seen(p_sku text) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT last_seen_at FROM public.page365_product_presence WHERE website_product_id = pg_temp.pid(p_sku) $$;

-- Users: U1 has no catalogue permission, U2 has manage_website_catalog.
INSERT INTO public.perm(user_id, key) SELECT '99999999-0000-0000-0000-000000000002', 'manage_website_catalog'
 WHERE NOT EXISTS (SELECT 1 FROM public.perm WHERE user_id = '99999999-0000-0000-0000-000000000002' AND key = 'manage_website_catalog');

-- Only this file's products and runs are in play: earlier test products are
-- archived (out of Page365 matching), and nothing is remembered as seen.
DELETE FROM public.page365_inventory_runs;
DELETE FROM public.page365_product_presence;
DELETE FROM public.staff_notifications;  -- earlier test files' bells
DELETE FROM public.audit_logs;           -- and audit rows (local db only)
UPDATE public.website_products SET status = 'archived';
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = false WHERE page365_sync_disabled;
SELECT set_config('test.uid', '', false);
SELECT pg_temp.eq('switch starts off', (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'false');

--   N4020  always on Page365                      -> never touched
--   ZH1    seen, then gone                        -> manual hide; back later; re-published by staff
--   ZH2    seen, gone once, back                  -> never proposed (1 missing read only)
--   ZH3    Hub-only, never on Page365             -> never proposed
--   ZH4    seen, gone, switched off BEFORE reads  -> not_synced, never proposed
--   ZH5    seen, gone, a sale after the read      -> manual: changed_since_fetch; later auto-hidden
--   ZH6    seen, gone, staff unpublished it       -> never proposed (not published)
--   ZH7    seen, gone                             -> auto-hidden (switch on)
--   ZH8    seen, gone, switched off AFTER the read-> auto skips sync_disabled
--   ZH9    seen as ZH9, then SKU edited to ZH9X   -> never proposed (not seen on that code)
INSERT INTO public.website_products(sku, status, origin, metals)
SELECT s, 'active', 'JAPAN', ARRAY['K18'] FROM unnest(ARRAY['N4020','ZH1','ZH2','ZH3','ZH4','ZH5','ZH6','ZH7','ZH8','ZH9']) s;
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, CASE sku WHEN 'ZH3' THEN 2 WHEN 'ZH5' THEN 3 ELSE 1 END, 10000
  FROM public.website_products WHERE sku IN ('N4020','ZH1','ZH2','ZH3','ZH4','ZH5','ZH6','ZH7','ZH8','ZH9');
INSERT INTO public.website_categories(id, slug, name) VALUES ('40000000-0000-0000-0000-00000000b301', 'zh-rings', 'ZH rings')
ON CONFLICT DO NOTHING;
INSERT INTO public.website_category_products(category_id, product_id)
SELECT '40000000-0000-0000-0000-00000000b301', pg_temp.pid('ZH1');
-- A live web order on ZH7 (the website already took its piece): must survive.
CREATE TEMP TABLE order_probe AS SELECT count(*) AS n FROM public.page365_stock_lines;

CREATE TEMP TABLE r(k text PRIMARY KEY, id uuid);

-- A. Complete read: everything but ZH3 (Hub-only) is on Page365 -----------------
INSERT INTO r VALUES ('A', pg_temp.run('manual', pg_temp.catalogue(ARRAY['ZH1','ZH2','ZH4','ZH5','ZH6','ZH7','ZH8','ZH9'])));
SELECT pg_temp.eq('A: ready', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='A')), 'ready');
SELECT pg_temp.eq('A: seen recorded for matched products', (SELECT count(*) FROM public.page365_product_presence), 9::bigint);
SELECT pg_temp.eq('A: Hub-only ZH3 never recorded as seen', pg_temp.seen('ZH3'), NULL::timestamptz);
SELECT pg_temp.eq('A: seen on the code matched', (SELECT code FROM public.page365_product_presence WHERE website_product_id = pg_temp.pid('ZH9')), 'ZH9');
SELECT pg_temp.eq('A: ZH3 Hub-only (1)', pg_temp.cat((SELECT id FROM r WHERE k='A'), 'ZH3'), 'hub_only');
SELECT pg_temp.eq('A: no hide proposals', (SELECT count(*) FROM public.page365_inventory_items WHERE category = 'hide'), 0::bigint);

-- Between A and B: ZH4 switched to "Don't sync", ZH9's SKU edited.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'ZH4';
SELECT set_config('test.uid', '', false);
UPDATE public.website_products SET sku = 'ZH9X' WHERE sku = 'ZH9';

-- B. Complete read: ZH1, ZH2, ZH4..ZH8 gone (missing once) ---------------------
INSERT INTO r VALUES ('B', pg_temp.run('manual', pg_temp.catalogue(ARRAY[]::text[])));
SELECT pg_temp.eq('B: ready', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='B')), 'ready');
SELECT pg_temp.eq('B: ZH1 missing once is NOT proposed', pg_temp.cat((SELECT id FROM r WHERE k='B'), 'ZH1'), 'hub_only');
SELECT pg_temp.eq('B: ZH1 missing_runs 1', (pg_temp.item((SELECT id FROM r WHERE k='B'), 'ZH1')).missing_runs, 1);
SELECT pg_temp.eq('B: never-seen ZH3 missing twice is NOT proposed', pg_temp.cat((SELECT id FROM r WHERE k='B'), 'ZH3'), 'hub_only');
SELECT pg_temp.eq('B: ZH3 missing_runs 2', (pg_temp.item((SELECT id FROM r WHERE k='B'), 'ZH3')).missing_runs, 2);
SELECT pg_temp.eq('B: switched-off ZH4 is not_synced', pg_temp.cat((SELECT id FROM r WHERE k='B'), 'ZH4'), 'not_synced');
SELECT pg_temp.eq('B: no hide proposals', (SELECT count(*) FROM public.page365_inventory_items WHERE category = 'hide'), 0::bigint);
SELECT pg_temp.eq('B: N4020 still seen', pg_temp.cat((SELECT id FROM r WHERE k='B'), 'N4020'), 'no_change');

-- P. A PARTIAL scheduled read (a product could not be read). ZH2 is back in it.
INSERT INTO r VALUES ('P', pg_temp.run('schedule', pg_temp.catalogue(ARRAY['ZH2'], 'PG1')));
SELECT pg_temp.eq('P: partial', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='P')), 'partial');
SELECT pg_temp.eq('P: no hide proposals from a partial read', (SELECT count(*) FROM public.page365_inventory_items
                  WHERE run_id = (SELECT id FROM r WHERE k='P') AND category = 'hide'), 0::bigint);
SELECT pg_temp.eq('P: a partial read records no seen', pg_temp.seen('ZH2') < (SELECT created_at FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='P')), true);
SELECT pg_temp.eq('P: closes not_ready, hides nothing', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='P'))->>'hidden', '0');
SELECT pg_temp.eq('P: one failure bell, no hide bell', pg_temp.bells('page365_inventory_run_failed') * 10 + pg_temp.bells('page365_inventory_hidden'), 10::bigint);

-- Between B and C: staff unpublish ZH6.
UPDATE public.website_products SET status = 'draft' WHERE sku = 'ZH6';

-- C. Complete scheduled read, switch OFF: ZH2 back; the rest gone twice --------
INSERT INTO r VALUES ('C', pg_temp.run('schedule', pg_temp.catalogue(ARRAY['ZH2'])));
SELECT pg_temp.eq('C: ready', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='C')), 'ready');
SELECT pg_temp.eq('C: the partial read did not break the row (ZH1 missing_runs 2)', (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).missing_runs, 2);
SELECT pg_temp.eq('C: ZH1 gone twice -> hide', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH1'), 'hide');
SELECT pg_temp.eq('C: ZH1 hide proposes 0 from 1', (SELECT seen_stock || '->' || proposed_stock FROM public.page365_inventory_items
                  WHERE id = (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).id), '1->0');
SELECT pg_temp.eq('C: ZH5 gone twice -> hide', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH5'), 'hide');
SELECT pg_temp.eq('C: ZH7 gone twice -> hide', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH7'), 'hide');
SELECT pg_temp.eq('C: ZH8 gone twice -> hide', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH8'), 'hide');
SELECT pg_temp.eq('C: ZH2 back after one miss -> matched, no hide', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH2'), 'no_change');
SELECT pg_temp.eq('C: never-seen ZH3 (missing 3) never proposed', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH3'), 'hub_only');
SELECT pg_temp.eq('C: switched-off ZH4 never proposed', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH4'), 'not_synced');
SELECT pg_temp.eq('C: unpublished ZH6 never proposed', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH6'), 'hub_only');
SELECT pg_temp.eq('C: re-coded ZH9X never proposed', pg_temp.cat((SELECT id FROM r WHERE k='C'), 'ZH9X'), 'hub_only');
SELECT pg_temp.eq('C: exactly 4 proposals', (SELECT count(*) FROM public.page365_inventory_items
                  WHERE run_id = (SELECT id FROM r WHERE k='C') AND category = 'hide'), 4::bigint);
SELECT pg_temp.eq('C: switch OFF -> closes off', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='C'))->>'state', 'off');
SELECT pg_temp.eq('C: switch OFF -> nothing hidden (ZH1 still active, 1)', pg_temp.st('ZH1') || '/' || pg_temp.stock('ZH1'), 'active/1');
SELECT pg_temp.eq('C: switch OFF -> rows wait for staff', (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).status, 'review');
SELECT pg_temp.eq('C: no hide audit, no hide bell', pg_temp.audits('page365_inventory_hidden') + pg_temp.bells('page365_inventory_hidden'), 0::bigint);

-- Staff Apply on C. A website sale moved ZH5 (3 -> 2) after the read.
UPDATE public.website_product_variants SET stock_qty = 2 WHERE product_id = pg_temp.pid('ZH5');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000001', false);
SELECT pg_temp.eq('manual: no permission refused', public.page365_inventory_hide((SELECT id FROM r WHERE k='C'),
  ARRAY[(pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).id])->>'reason', 'forbidden');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('manual: nothing selected refused', public.page365_inventory_hide((SELECT id FROM r WHERE k='C'), ARRAY[]::uuid[])->>'reason', 'nothing_selected');
SELECT pg_temp.eq('manual: partial run refused', public.page365_inventory_hide((SELECT id FROM r WHERE k='P'),
  ARRAY[(pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).id])->>'reason', 'run_not_ready');
SELECT pg_temp.eq('manual: older run superseded', public.page365_inventory_hide((SELECT id FROM r WHERE k='B'),
  ARRAY[(pg_temp.item((SELECT id FROM r WHERE k='B'), 'ZH1')).id])->>'reason', 'superseded');
CREATE TEMP TABLE res AS SELECT public.page365_inventory_hide((SELECT id FROM r WHERE k='C'), ARRAY[
  (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).id, (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH5')).id,
  (pg_temp.item((SELECT id FROM r WHERE k='C'), 'N4020')).id]) AS j;
SELECT pg_temp.eq('manual: 1 hidden / 1 changed / 1 skipped',
  (SELECT (j->>'hidden') || '/' || (j->>'changed_since_fetch') || '/' || (j->>'skipped') FROM res), '1/1/1');
SELECT pg_temp.eq('manual: a non-hide row is refused as not_a_hide', (SELECT j->'skipped_items'->0->>'reason' FROM res), 'not_a_hide');
SELECT pg_temp.eq('manual: ZH1 now draft with 0 stock', pg_temp.st('ZH1') || '/' || pg_temp.stock('ZH1'), 'draft/0');
SELECT pg_temp.eq('manual: ZH1 row applied/hidden by the user',
  (SELECT status || '/' || result_note || '/' || applied_by FROM public.page365_inventory_items
    WHERE id = (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).id), 'applied/hidden/99999999-0000-0000-0000-000000000002');
SELECT pg_temp.eq('manual: ZH1 hide mark', (SELECT hidden_source FROM public.page365_product_presence WHERE website_product_id = pg_temp.pid('ZH1')), 'manual');
SELECT pg_temp.eq('manual: moved ZH5 NOT hidden (compare-and-set)', pg_temp.st('ZH5') || '/' || pg_temp.stock('ZH5'), 'active/2');
SELECT pg_temp.eq('manual: moved ZH5 changed_since_fetch', (pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH5')).status, 'changed_since_fetch');
SELECT pg_temp.eq('manual: N4020 untouched', pg_temp.st('N4020') || '/' || pg_temp.stock('N4020'), 'active/1');
SELECT pg_temp.eq('manual: one audit per hidden product', pg_temp.audits('page365_inventory_hidden'), 1::bigint);
SELECT pg_temp.eq('manual: audit is ZH1 active -> draft',
  (SELECT (old_value_json->>'status') || '->' || (new_value_json->>'status') || ' ' || (new_value_json->>'sku') || ' ' || performed_by_user_id
     FROM public.audit_logs WHERE action = 'page365_inventory_hidden'), 'active->draft ZH1 99999999-0000-0000-0000-000000000002');
SELECT pg_temp.eq('manual: one run audit', pg_temp.audits('page365_inventory_hide'), 1::bigint);
SELECT pg_temp.eq('manual: one bell', pg_temp.bells('page365_inventory_hidden'), 1::bigint);
SELECT pg_temp.eq('manual: run counts 1 hidden', (SELECT hidden_count FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='C')), 1);
SELECT pg_temp.eq('manual: second press is a no-op', public.page365_inventory_hide((SELECT id FROM r WHERE k='C'),
  ARRAY[(pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH1')).id])->>'hidden', '0');
-- A second hide on the same run (ZH7) hides, but raises no second bell.
SELECT pg_temp.eq('manual: another row, same run', public.page365_inventory_hide((SELECT id FROM r WHERE k='C'),
  ARRAY[(pg_temp.item((SELECT id FROM r WHERE k='C'), 'ZH7')).id])->>'hidden', '1');
SELECT pg_temp.eq('manual: still one bell for the run', pg_temp.bells('page365_inventory_hidden'), 1::bigint);
SELECT pg_temp.eq('manual: run counts 2 hidden', (SELECT hidden_count FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='C')), 2);
SELECT set_config('test.uid', '', false);
-- Put ZH7 back (as if staff had not done it) for the automatic test below.
UPDATE public.website_products SET status = 'active' WHERE sku = 'ZH7';
UPDATE public.website_product_variants SET stock_qty = 1 WHERE product_id = pg_temp.pid('ZH7');
UPDATE public.page365_product_presence SET hidden_at = NULL, hidden_source = NULL, hidden_run_id = NULL, hidden_by = NULL
 WHERE website_product_id = pg_temp.pid('ZH7');

-- Turn the switch on.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('switch turned on', (public.set_page365_inventory_auto_apply(true, false)->>'enabled')::boolean, true);
SELECT set_config('test.uid', '', false);

-- D. Complete scheduled read, switch ON: still gone; ZH8 switched off AFTER it.
INSERT INTO r VALUES ('D', pg_temp.run('schedule', pg_temp.catalogue(ARRAY['ZH2'])));
SELECT pg_temp.eq('D: ZH5 proposed again (fresh snapshot)', pg_temp.cat((SELECT id FROM r WHERE k='D'), 'ZH5'), 'hide');
SELECT pg_temp.eq('D: ZH1 already a draft -> not proposed', pg_temp.cat((SELECT id FROM r WHERE k='D'), 'ZH1'), 'hub_only');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'ZH8';
SELECT set_config('test.uid', '', false);
CREATE TEMP TABLE res_d AS SELECT public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='D')) AS j;
SELECT pg_temp.eq('D: applied, 2 hidden, 1 skipped', (SELECT (j->>'state') || '/' || (j->>'hidden') || '/' || (j->>'hide_skipped') FROM res_d), 'applied/2/1');
SELECT pg_temp.eq('D: ZH5 hidden automatically', pg_temp.st('ZH5') || '/' || pg_temp.stock('ZH5'), 'draft/0');
SELECT pg_temp.eq('D: ZH7 hidden automatically', pg_temp.st('ZH7') || '/' || pg_temp.stock('ZH7'), 'draft/0');
SELECT pg_temp.eq('D: ZH7 row auto_hidden, no staff user',
  (SELECT status || '/' || result_note || '/' || coalesce(applied_by::text, 'none') FROM public.page365_inventory_items
    WHERE id = (pg_temp.item((SELECT id FROM r WHERE k='D'), 'ZH7')).id), 'applied/auto_hidden/none');
SELECT pg_temp.eq('D: ZH8 switched off after the read NOT hidden', pg_temp.st('ZH8') || '/' || pg_temp.stock('ZH8'), 'active/1');
SELECT pg_temp.eq('D: ZH8 note sync_disabled, still under review',
  (SELECT status || '/' || result_note FROM public.page365_inventory_items WHERE id = (pg_temp.item((SELECT id FROM r WHERE k='D'), 'ZH8')).id), 'review/sync_disabled');
SELECT pg_temp.eq('D: never-seen ZH3 untouched', pg_temp.st('ZH3') || '/' || pg_temp.stock('ZH3'), 'active/2');
SELECT pg_temp.eq('D: switched-off ZH4 untouched', pg_temp.st('ZH4') || '/' || pg_temp.stock('ZH4'), 'active/1');
SELECT pg_temp.eq('D: re-coded ZH9X untouched', pg_temp.st('ZH9X') || '/' || pg_temp.stock('ZH9X'), 'active/1');
SELECT pg_temp.eq('D: N4020 untouched', pg_temp.st('N4020') || '/' || pg_temp.stock('N4020'), 'active/1');
SELECT pg_temp.eq('D: run records 2 hidden', (SELECT hidden_count FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='D')), 2);
SELECT pg_temp.eq('D: exactly one more bell (two in all)', pg_temp.bells('page365_inventory_hidden'), 2::bigint);
SELECT pg_temp.eq('D: the bell names both', (SELECT body LIKE '%ZH5%' AND body LIKE '%ZH7%' AND body LIKE '%automatically%'
  FROM public.staff_notifications WHERE type = 'page365_inventory_hidden' AND metadata->>'run_id' = (SELECT id FROM r WHERE k='D')::text), true);
SELECT pg_temp.eq('D: no separate decrease bell', pg_temp.bells('page365_inventory_auto_applied'), 0::bigint);
SELECT pg_temp.eq('D: run audit counts the hides', (SELECT (new_value_json->>'hidden')::int FROM public.audit_logs
  WHERE action = 'page365_inventory_auto_apply' AND entity_id = (SELECT id FROM r WHERE k='D')), 2);
SELECT pg_temp.eq('D: per-product audits now 4', pg_temp.audits('page365_inventory_hidden'), 4::bigint);
SELECT pg_temp.eq('D: second close is a no-op', (public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='D'))->>'already')::boolean, true);
SELECT pg_temp.eq('D: still two bells', pg_temp.bells('page365_inventory_hidden'), 2::bigint);
SELECT pg_temp.eq('D: orders/holds untouched', (SELECT count(*) FROM public.page365_stock_lines), (SELECT n FROM order_probe));

-- E. ZH1 comes back in Page365 (switch still on) -----------------------------
INSERT INTO r VALUES ('E', pg_temp.run('schedule', pg_temp.catalogue(ARRAY['ZH1','ZH2'])));
SELECT pg_temp.eq('E: ZH1 flagged back in Page365', (pg_temp.item((SELECT id FROM r WHERE k='E'), 'ZH1')).back_in_page365, true);
SELECT pg_temp.eq('E: ZH1 proposed as an increase 0 -> 1', (SELECT category || ' ' || seen_stock || '->' || proposed_stock
  FROM public.page365_inventory_items WHERE id = (pg_temp.item((SELECT id FROM r WHERE k='E'), 'ZH1')).id), 'increase 0->1');
SELECT pg_temp.eq('E: ZH2 (never hidden) not flagged', (pg_temp.item((SELECT id FROM r WHERE k='E'), 'ZH2')).back_in_page365, false);
SELECT pg_temp.eq('E: auto close applies', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='E'))->>'state', 'applied');
SELECT pg_temp.eq('E: NOT re-published, stock NOT raised', pg_temp.st('ZH1') || '/' || pg_temp.stock('ZH1'), 'draft/0');
SELECT pg_temp.eq('E: hide mark kept while a draft', (SELECT hidden_at IS NOT NULL FROM public.page365_product_presence WHERE website_product_id = pg_temp.pid('ZH1')), true);

-- Staff re-publish ZH1 (the Catalog bulk Publish), then the next read clears the mark.
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('staff re-publish', (public.website_publish_products(ARRAY[pg_temp.pid('ZH1')])->>'published')::int, 1);
SELECT set_config('test.uid', '', false);
INSERT INTO r VALUES ('F', pg_temp.run('manual', pg_temp.catalogue(ARRAY['ZH1','ZH2'])));
SELECT pg_temp.eq('F: re-published ZH1 no longer flagged', (pg_temp.item((SELECT id FROM r WHERE k='F'), 'ZH1')).back_in_page365, false);
SELECT pg_temp.eq('F: hide mark cleared', (SELECT hidden_at FROM public.page365_product_presence WHERE website_product_id = pg_temp.pid('ZH1')), NULL::timestamptz);
SELECT pg_temp.eq('F: follow never failed', pg_temp.audits('page365_inventory_follow_failed'), 0::bigint);

-- Switch back off (leave the database as found).
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('switch turned off', (public.set_page365_inventory_auto_apply(false, true)->>'enabled')::boolean, false);
SELECT set_config('test.uid', '', false);

-- Grants.
SELECT pg_temp.eq('hide_item not callable by the browser', has_function_privilege('authenticated', 'public.page365_inventory_hide_item(uuid,uuid,uuid,text)', 'EXECUTE'), false);
SELECT pg_temp.eq('follow not callable by the browser', has_function_privilege('authenticated', 'public.page365_inventory_follow(uuid)', 'EXECUTE'), false);
SELECT pg_temp.eq('hide RPC callable by signed-in staff', has_function_privilege('authenticated', 'public.page365_inventory_hide(uuid,uuid[])', 'EXECUTE'), true);
SELECT pg_temp.eq('hide RPC not callable by anon', has_function_privilege('anon', 'public.page365_inventory_hide(uuid,uuid[])', 'EXECUTE'), false);

SELECT 'ALL PR 3b CHECKS PASSED' AS result;
