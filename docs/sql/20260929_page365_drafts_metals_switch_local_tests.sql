-- ============================================================================
-- Page365 drafts (PR 4) — LOCAL tests for the two post-PR 2 rules (2026-09-29).
-- Local Postgres only. Run AFTER docs/sql/20260928_page365_inventory_drafts_local_tests.sql
-- on the same database (see docs/sql/20260928_page365_inventory_drafts_local_stub.sql
-- for the order). Every check RAISEs on failure; the last line prints
-- ALL METAL + SWITCH CHECKS PASSED.
--
-- Covers:
--   * A metal stamp is required ONLY for jewelry: a watch / other item saves
--     and publishes without one; jewelry without one is refused by the CHECK,
--     by website_publish_products and by the Page365 draft guard; the karat
--     bridge still refills jewelry from karat, never a watch, and clears karat
--     when there is no stamp; a watch that drops its stamp stays stamp-less.
--   * "Create drafts": a listing Page365 calls a watch is drafted as a watch
--     with no stamp; a jewelry listing without a stamp still fails no_metal;
--     "Watch" is never a sku.
--   * "Don't sync with Page365": a code whose Hub product is switched off is
--     never drafted (switched on before the fetch -> not_synced; switched on
--     after the fetch -> refused live), and a draft is created with the switch off.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refused(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt; EXCEPTION WHEN check_violation OR invalid_text_representation THEN RAISE NOTICE 'ok  %', label; RETURN; END;
  RAISE EXCEPTION 'FAIL %: not refused', label;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.run(p_details jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  -- Newer than every earlier run (the drafts tests stamp one a second ahead),
  -- so this run is never 'superseded'; count never below an earlier run's.
  INSERT INTO public.page365_inventory_runs(page365_count, products_total, created_at)
  VALUES (greatest(jsonb_array_length(p_details), (SELECT max(page365_count) FROM public.page365_inventory_runs)),
          jsonb_array_length(p_details),
          greatest(now(), (SELECT max(created_at) + interval '1 second' FROM public.page365_inventory_runs)))
  RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name, list_category)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name', x->>'cat' FROM jsonb_array_elements(p_details) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_details) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL);
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  RETURN v_run;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, code text, cat text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'cat', cat,
    'detail', jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', code,
                                                      'price_jpy', 88000, 'full_price_jpy', NULL, 'available', 1)))) $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.page365_inventory_items WHERE run_id = p_run AND code = p_code $$;
CREATE OR REPLACE FUNCTION pg_temp.reason(p_res jsonb, p_list text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT x->>'reason' FROM jsonb_array_elements(p_res->p_list) x WHERE x->>'code' = p_code LIMIT 1 $$;

SELECT set_config('test.uid', '30000000-0000-0000-0000-000000000001', false);   -- catalog staff (drafts tests)

-- 1. The database rule ------------------------------------------------------
SELECT pg_temp.eq('existing products are all jewelry', (SELECT count(*) FROM public.website_products WHERE item_kind <> 'jewelry'), 0::bigint);
INSERT INTO public.website_products(sku, slug, name, item_kind, metals) VALUES ('W9001', 'w9001', 'Rolex Datejust', 'watch', '{}');
SELECT pg_temp.eq('a watch saves without a stamp', (SELECT cardinality(metals) FROM public.website_products WHERE sku = 'W9001'), 0);
INSERT INTO public.website_products(sku, slug, name, item_kind, metals) VALUES ('O9001', 'o9001', 'Jewelry box', 'other', '{}');
SELECT pg_temp.eq('an other item saves without a stamp', (SELECT item_kind FROM public.website_products WHERE sku = 'O9001'), 'other');
SELECT pg_temp.refused('jewelry without a stamp is refused',
  $$INSERT INTO public.website_products(sku, slug, name, item_kind, metals) VALUES ('J9001', 'j9001', 'Ring', 'jewelry', '{}')$$);
SELECT pg_temp.refused('an unknown kind is refused',
  $$INSERT INTO public.website_products(sku, slug, name, item_kind, metals) VALUES ('J9002', 'j9002', 'Ring', 'bag', '{K18}')$$);
SELECT pg_temp.refused('a stamp outside the list is still refused, watch or not',
  $$INSERT INTO public.website_products(sku, slug, name, item_kind, metals) VALUES ('W9002', 'w9002', 'Watch', 'watch', '{GOLD}')$$);
-- The karat bridge.
INSERT INTO public.website_products(sku, slug, name, item_kind, metals, karat) VALUES ('J9003', 'j9003', 'Ring', 'jewelry', '{}', 'K18');
SELECT pg_temp.eq('jewelry: a karat-only writer still fills metals', (SELECT metals FROM public.website_products WHERE sku = 'J9003'), ARRAY['K18']);
INSERT INTO public.website_products(sku, slug, name, item_kind, metals, karat) VALUES ('W9003', 'w9003', 'Watch', 'watch', '{}', 'K18');
SELECT pg_temp.eq('watch: karat never refills metals', (SELECT cardinality(metals) FROM public.website_products WHERE sku = 'W9003'), 0);
SELECT pg_temp.eq('watch: karat cleared with no stamp', (SELECT karat::text FROM public.website_products WHERE sku = 'W9003'), NULL::text);
UPDATE public.website_products SET item_kind = 'watch', metals = '{}' WHERE sku = 'J9003';
SELECT pg_temp.eq('jewelry -> watch can drop its stamp', (SELECT cardinality(metals) FROM public.website_products WHERE sku = 'J9003'), 0);
SELECT pg_temp.eq('... and karat goes with it', (SELECT karat::text FROM public.website_products WHERE sku = 'J9003'), NULL::text);
SELECT pg_temp.refused('watch -> jewelry without a stamp is refused',
  $$UPDATE public.website_products SET item_kind = 'jewelry' WHERE sku = 'J9003'$$);
UPDATE public.website_products SET metals = '{PT900,K18}' WHERE sku = 'W9001';
SELECT pg_temp.eq('a watch may carry stamps (karat = first)', (SELECT karat::text FROM public.website_products WHERE sku = 'W9001'), 'PT900');
UPDATE public.website_products SET metals = '{}' WHERE sku = 'W9001';

-- 2. The publish check ------------------------------------------------------
INSERT INTO public.website_product_variants(product_id, price_jpy, stock_qty) SELECT id, 880000, 1 FROM public.website_products WHERE sku = 'W9001';
UPDATE public.website_products SET origin = 'BRAND', brand = 'Rolex', status = 'draft' WHERE sku = 'W9001';
INSERT INTO public.website_category_products(category_id, product_id) SELECT '40000000-0000-0000-0000-000000000001', id FROM public.website_products WHERE sku = 'W9001';
SELECT pg_temp.eq('publish_missing: a complete watch needs nothing (no metal)',
  public.website_product_publish_missing((SELECT id FROM public.website_products WHERE sku = 'W9001')), ARRAY[]::text[]);
SELECT pg_temp.eq('bulk publish: the watch goes live without a stamp',
  (public.website_publish_products(ARRAY[(SELECT id FROM public.website_products WHERE sku = 'W9001')])->>'published')::int, 1);
SELECT pg_temp.eq('... status active', (SELECT status::text FROM public.website_products WHERE sku = 'W9001'), 'active');

-- 3. Create drafts: watches, and the switch -----------------------------------
-- Z9100 exists in the Hub and is switched off BEFORE the fetch.
INSERT INTO public.website_products(sku, slug, name, metals) VALUES ('Z9100', 'z9100', 'Sample necklace', '{K18}');
INSERT INTO public.website_product_variants(product_id, price_jpy, stock_qty) SELECT id, 10000, 1 FROM public.website_products WHERE sku = 'Z9100';
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'Z9100';

DO $t$
DECLARE v_run uuid; v_res jsonb;
BEGIN
  v_run := pg_temp.run(jsonb_build_array(
    pg_temp.p(9101, 'W9101 Watch Rolex Datejust 36mm Steel', 'W9101', 'SUPPLIER LISTINGS - BRANDED PRELOVED'),
    pg_temp.p(9102, 'W9102 Omega Seamaster 300m', 'W9102', 'WATCHES'),
    pg_temp.p(9103, 'R9103 Ring Diamond 0.3ct', 'R9103', 'Rings MIJ'),
    pg_temp.p(9104, 'Watch Seiko 5 automatic', 'WATCH', 'SUPPLIER LISTINGS - JEWELRY'),
    pg_temp.p(9105, 'Z9100 Sample necklace K18', 'Z9100', 'Necklace MIJ'),
    pg_temp.p(9106, 'Z9106 Pendant K18 1.2g', 'Z9106', 'Pendant MIJ'),
    pg_temp.p(9107, 'Z9107 Ring K18 2.2g', 'Z9107', 'Rings MIJ')));
  PERFORM pg_temp.eq('fetch: switched-off Z9100 is not_synced, never new',
    (SELECT category FROM public.page365_inventory_items WHERE id = pg_temp.item(v_run, 'Z9100')), 'not_synced');

  -- Z9106 is made by hand AFTER the fetch and switched off straight away.
  INSERT INTO public.website_products(sku, slug, name, metals) VALUES ('Z9106', 'z9106', 'Pendant', '{K18}');
  UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'Z9106';

  v_res := public.page365_inventory_create_drafts(v_run, ARRAY[
    pg_temp.item(v_run, 'W9101'), pg_temp.item(v_run, 'W9102'), pg_temp.item(v_run, 'R9103'), pg_temp.item(v_run, 'WATCH'),
    pg_temp.item(v_run, 'Z9100'), pg_temp.item(v_run, 'Z9106'), pg_temp.item(v_run, 'Z9107')]);
  PERFORM pg_temp.eq('drafts: created = W9101, W9102, Z9107', (v_res->>'created')::int, 3);
  PERFORM pg_temp.eq('watch by name: item_kind watch', (SELECT item_kind FROM public.website_products WHERE sku = 'W9101'), 'watch');
  PERFORM pg_temp.eq('watch by name: no stamp needed', (SELECT cardinality(metals) FROM public.website_products WHERE sku = 'W9101'), 0);
  PERFORM pg_temp.eq('watch by Page365 category: item_kind watch', (SELECT item_kind FROM public.website_products WHERE sku = 'W9102'), 'watch');
  PERFORM pg_temp.eq('jewelry without a stamp still fails no_metal', pg_temp.reason(v_res, 'failed_items', 'R9103'), 'no_metal');
  PERFORM pg_temp.eq('"Watch …" never becomes a sku', pg_temp.reason(v_res, 'failed_items', 'WATCH'), 'code_is_a_word');
  PERFORM pg_temp.eq('switch on before the fetch: sync_disabled', pg_temp.reason(v_res, 'skipped_items', 'Z9100'), 'sync_disabled');
  PERFORM pg_temp.eq('switch on after the fetch: sync_disabled (read live)', pg_temp.reason(v_res, 'skipped_items', 'Z9106'), 'sync_disabled');
  PERFORM pg_temp.eq('no second Z9106 product', (SELECT count(*)::int FROM public.website_products WHERE sku LIKE 'Z9106%'), 1);
  PERFORM pg_temp.eq('Z9106 row notes why', (SELECT result_note FROM public.page365_inventory_items WHERE id = pg_temp.item(v_run, 'Z9106')), 'sync_disabled');
  PERFORM pg_temp.eq('a new draft is created with the switch off', (SELECT page365_sync_disabled FROM public.website_products WHERE sku = 'Z9107'), false);
  PERFORM pg_temp.eq('jewelry draft keeps its printed stamp and kind', (SELECT item_kind || '/' || metals[1] FROM public.website_products WHERE sku = 'Z9107'), 'jewelry/K18');
  PERFORM pg_temp.eq('audit carries the kind',
    (SELECT new_value_json->>'item_kind' FROM public.audit_logs WHERE action = 'page365_draft_created' AND new_value_json->>'sku' = 'W9101'), 'watch');

  -- A watch draft publishes without a stamp once origin + category are set; the
  -- Page365 draft guard applies the same jewelry-only rule.
  UPDATE public.website_products SET origin = 'BRAND', brand = 'Rolex' WHERE sku = 'W9101';
  INSERT INTO public.website_category_products(category_id, product_id)
  SELECT '40000000-0000-0000-0000-000000000001', id FROM public.website_products WHERE sku = 'W9101';
  UPDATE public.website_products SET status = 'active' WHERE sku = 'W9101';
  PERFORM pg_temp.eq('draft guard: a watch draft goes live without a stamp', (SELECT status::text FROM public.website_products WHERE sku = 'W9101'), 'active');
END
$t$;

SELECT 'ALL METAL + SWITCH CHECKS PASSED' AS result;
