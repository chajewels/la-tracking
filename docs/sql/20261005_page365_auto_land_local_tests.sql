-- ============================================================================
-- Page365 auto-land (2026-09-26, replaces "Create drafts") — LOCAL behaviour
-- tests. Local Postgres only. Run after the stubs and every earlier Page365
-- migration, then this one (no new stub is needed):
--
--   (the PR 3d sequence from docs/sql/20261003_page365_interval_local_tests.sql, then)
--   $P supabase/migrations/20261005100000_page365_auto_land.sql
--   $P supabase/migrations/20261005100000_page365_auto_land.sql   # re-run is safe
--   $P docs/sql/20261005_page365_auto_land_local_tests.sql
--
-- Every check RAISEs on failure; the last line prints ALL AUTO-LAND CHECKS PASSED.
--
-- Covers, with the owner's own Page365 text: a complete read lands every new
-- in-stock code as an UNPUBLISHED product — wallets, a key case, a bag and a
-- belt as ACCESSORY, a watch as WATCH, branded 750WG / K18YG/WG / SV925 / SV
-- jewelry with the stamp read (SV = SILVER); a jewelry piece with no stamp
-- lands "incomplete — needs metal" and cannot be published (bulk publish,
-- the guard trigger and the CHECK) until the stamp is set; a sold-out new code
-- does not land (reason kept); a "Don't sync with Page365" product and an
-- existing Hub product are untouched; a second read lands nothing twice;
-- nothing is published and no existing stock moves; a partial read lands
-- nothing; a QUICK read opens a listing it never read before and lands it,
-- and still skips known Page365-only listings.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.prod(p_sku text) RETURNS public.website_products LANGUAGE sql AS $$
  SELECT * FROM public.website_products WHERE sku = p_sku ORDER BY created_at LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_sku text) RETURNS integer LANGUAGE sql AS $$
  SELECT sum(v.stock_qty)::integer FROM public.website_product_variants v WHERE v.product_id = (pg_temp.prod(p_sku)).id $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id = p_run AND code = p_code LIMIT 1 $$;
-- A one-variant listing: code = first word of the name.
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, category text, avail integer DEFAULT 1,
                                     price integer DEFAULT 50000, photos integer DEFAULT 2) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'category', category,
    'detail', jsonb_build_object('name', name, 'price_jpy', price, 'full_price_jpy', NULL,
      'photos', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', pid * 100 + g, 'version', '1',
                   'url', 'https://assets.page365.net/x/' || pid || '-' || g || '.jpg?1', 'position', g)), '[]'::jsonb)
                   FROM generate_series(1, photos) g),
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', split_part(name, ' ', 1),
        'price_jpy', price, 'full_price_jpy', NULL, 'available', avail)))) $$;
-- One read as page365-inventory-fetch does it (list -> [plan quick] -> claim -> store -> finish).
-- p_fail: pids whose detail read errors twice (a partial read).
CREATE TEMP TABLE finished(run_id uuid PRIMARY KEY, result jsonb);
CREATE OR REPLACE FUNCTION pg_temp.run(p_kind text, p_list jsonb, p_fail bigint[] DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb; v_fin jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES ('manual', p_kind, jsonb_array_length(p_list), jsonb_array_length(p_list)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name, list_category)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name', x->>'category' FROM jsonb_array_elements(p_list) x;
  IF p_kind = 'quick' THEN PERFORM public.page365_inventory_plan_quick(v_run); END IF;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_list) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      IF r.o_page365_product_id = ANY (p_fail) THEN
        PERFORM public.page365_inventory_store_product(r.o_id, NULL, 'HTTP 500');
      ELSE
        PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL);
      END IF;
    END LOOP;
    v_fin := public.page365_inventory_finish(v_run);
    EXIT WHEN (v_fin->>'ok')::boolean;
  END LOOP;
  INSERT INTO finished VALUES (v_run, v_fin);
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;

INSERT INTO public.perm(user_id, key) SELECT '99999999-0000-0000-0000-000000000002', 'manage_website_catalog'
 WHERE NOT EXISTS (SELECT 1 FROM public.perm WHERE user_id = '99999999-0000-0000-0000-000000000002' AND key = 'manage_website_catalog');

-- Only this file's runs are in play; earlier products are archived out of the way.
DELETE FROM public.page365_inventory_runs;
DELETE FROM public.page365_product_presence;
DELETE FROM public.audit_logs;
UPDATE public.website_products SET status = 'archived' WHERE status <> 'archived';

-- Hub side: an existing published product (LX100, 3 in stock) and a product
-- switched to "Don't sync with Page365" (DS100, 1 in stock).
INSERT INTO public.website_products(sku, status, origin, metals) VALUES ('LX100', 'active', 'JAPAN', ARRAY['K18']),
                                                                     ('DS100', 'active', 'JAPAN', ARRAY['K18']);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, CASE sku WHEN 'LX100' THEN 3 ELSE 1 END, 10000 FROM public.website_products WHERE sku IN ('LX100', 'DS100');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'DS100';
SELECT set_config('test.uid', '', false);

CREATE TEMP TABLE cat AS SELECT jsonb_build_array(
  pg_temp.p(910001, 'W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
  pg_temp.p(910002, 'W1451 Wallet Louis Vuitton Porte 2 Cult Vertical Pass Case [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
  pg_temp.p(910003, 'W2497 Key Case Louis Vuitton Monogram Multicle 4 [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
  pg_temp.p(910004, 'SB022 Bag Burberry Shoulder bag [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
  pg_temp.p(910005, 'B2948 Belt Louis Vuitton Belt - LV Dimension Reversible 85/34 [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
  pg_temp.p(910006, 'WT100 Rolex Datejust 36mm [Preloved]', 'SUPPLIER LISTINGS - WATCH'),
  pg_temp.p(910007, 'R1072 Ring Gucci 750WG 3.12g Icon Sz# 11 [Preloved]', 'SUPPLIER LISTINGS - BRANDED PRELOVED'),
  pg_temp.p(910008, 'N3876 Necklace K18YG/WG 1.90g Ruby 0.44ct Diamond 0.07ct Top 40cm [Preloved]', 'SUPPLIER LISTINGS - JEWELRY'),
  pg_temp.p(910009, 'N1337 Necklace SV925 Tahiti SSP 9.5-10.0mm 45cm [Preloved]', 'SUPPLIER LISTINGS - PEARLS'),
  pg_temp.p(910010, 'N3178 Necklace SV 8.50g Emerald 48cm [Preloved]', 'SUPPLIER LISTINGS - JEWELRY'),
  pg_temp.p(910011, 'NS100 Necklace Spinel 17mm 100cm Necktie', 'Necklace Made in Japan'),
  pg_temp.p(910012, 'SO100 Ring K18 2.0g Diamond', 'Rings Made in Japan', 0),
  pg_temp.p(910013, 'LX100 Ring K18 Existing', 'Rings Made in Japan', 3),
  pg_temp.p(910014, 'DS100 Ring K18 Switched off', 'Rings Made in Japan', 5),
  pg_temp.p(910015, 'Necklace K18 SSP White Pearl 45cm', 'SUPPLIER LISTINGS - PEARLS')) AS j;

-- A. A partial read lands nothing -----------------------------------------------
DO $a$
DECLARE v_run uuid := pg_temp.run('full', (SELECT j FROM cat), ARRAY[910015::bigint]);
BEGIN
  PERFORM pg_temp.eq('A: the read is partial', (SELECT status FROM public.page365_inventory_runs WHERE id = v_run), 'partial');
  PERFORM pg_temp.eq('A: nothing landed', (SELECT count(*) FROM public.page365_landings)::integer, 0);
  PERFORM pg_temp.eq('A: no product created', (SELECT count(*) FROM public.website_products WHERE sku = 'W3356')::integer, 0);
END $a$;

-- B. A complete FULL read lands every new in-stock code, unpublished --------------
CREATE TEMP TABLE r AS SELECT pg_temp.run('full', (SELECT j FROM cat)) AS id;
DO $b$
DECLARE
  v_run uuid := (SELECT id FROM r);
  v_fin jsonb := (SELECT result FROM finished WHERE run_id = (SELECT id FROM r));
  v_p   public.website_products;
BEGIN
  PERFORM pg_temp.eq('B: ready', v_fin->>'status', 'ready');
  PERFORM pg_temp.eq('B: 11 landed', (v_fin->'landed'->>'landed')::integer, 11);

  FOREACH v_p IN ARRAY ARRAY[pg_temp.prod('W3356'), pg_temp.prod('W1451'), pg_temp.prod('W2497'), pg_temp.prod('SB022'),
                             pg_temp.prod('B2948')] LOOP
    PERFORM pg_temp.eq('B: ' || v_p.sku || ' lands as an unpublished ACCESSORY', v_p.item_kind || '/' || v_p.status::text, 'accessory/draft');
    PERFORM pg_temp.eq('B: ' || v_p.sku || ' no stamp', cardinality(v_p.metals), 0);
  END LOOP;
  PERFORM pg_temp.eq('B: W3356 price, preloved, origin never guessed',
    (SELECT v.price_jpy FROM public.website_product_variants v WHERE v.product_id = (pg_temp.prod('W3356')).id)::text
      || ' ' || (pg_temp.prod('W3356')).condition || ' ' || (pg_temp.prod('W3356')).origin, '50000 Preloved UNKNOWN');
  PERFORM pg_temp.eq('B: W3356 stock = Page365 available', pg_temp.stock('W3356'), 1);
  PERFORM pg_temp.eq('B: watch', (pg_temp.prod('WT100')).item_kind || '/' || (pg_temp.prod('WT100')).status::text, 'watch/draft');
  PERFORM pg_temp.eq('B: 750WG', array_to_string((pg_temp.prod('R1072')).metals, ','), '750');
  PERFORM pg_temp.eq('B: K18YG/WG', array_to_string((pg_temp.prod('N3876')).metals, ','), 'K18');
  PERFORM pg_temp.eq('B: SV925', array_to_string((pg_temp.prod('N1337')).metals, ','), 'SILVER925');
  PERFORM pg_temp.eq('B: SV = Silver', array_to_string((pg_temp.prod('N3178')).metals, ','), 'SILVER');
  PERFORM pg_temp.eq('B: SV karat bridge', (pg_temp.prod('N3178')).karat::text, 'SILVER');
  PERFORM pg_temp.eq('B: category from "Necklace Made in Japan"? (only if one Hub category) — never an error', (pg_temp.prod('N3178')).id IS NOT NULL, true);

  -- Incomplete still lands.
  PERFORM pg_temp.eq('B: NS100 lands as jewelry with no stamp',
    (pg_temp.prod('NS100')).item_kind || '/' || (pg_temp.prod('NS100')).status::text || '/' || cardinality((pg_temp.prod('NS100')).metals),
    'jewelry/draft/0');
  PERFORM pg_temp.eq('B: NS100 flagged needs metal', 'metal' = ANY (public.website_product_publish_missing((pg_temp.prod('NS100')).id)), true);

  -- Not landed, each with its reason on the row.
  PERFORM pg_temp.eq('B: sold-out new code does not land', (pg_temp.prod('SO100')).id IS NULL, true);
  PERFORM pg_temp.eq('B: sold-out reason kept', (pg_temp.item(v_run, 'SO100')).result_note, 'sold_out');
  PERFORM pg_temp.eq('B: name without a code: reason kept', (pg_temp.item(v_run, 'NECKLACE')).result_note, 'code_is_a_word');
  PERFORM pg_temp.eq('B: every new row has a reason or landed',
    (SELECT count(*) FROM public.page365_inventory_items WHERE run_id = v_run AND kind = 'page365'
        AND (category = 'new' OR result_note = 'landed') AND result_note IS NULL)::integer, 0);

  -- Existing products and "Don't sync" untouched; nothing published.
  PERFORM pg_temp.eq('B: existing LX100 not duplicated', (SELECT count(*) FROM public.website_products WHERE sku = 'LX100')::integer, 1);
  PERFORM pg_temp.eq('B: existing LX100 stock unchanged by landing', pg_temp.stock('LX100'), 3);
  PERFORM pg_temp.eq('B: DS100 not duplicated', (SELECT count(*) FROM public.website_products WHERE sku = 'DS100')::integer, 1);
  PERFORM pg_temp.eq('B: DS100 stock untouched', pg_temp.stock('DS100'), 1);
  PERFORM pg_temp.eq('B: DS100 row is not_synced', (pg_temp.item(v_run, 'DS100')).category, 'not_synced');
  PERFORM pg_temp.eq('B: nothing landed is published',
    (SELECT count(*) FROM public.page365_landings l JOIN public.website_products wp ON wp.id = l.product_id
      WHERE wp.status::text <> 'draft')::integer, 0);

  -- Recorded: landings (photo backlog), item matched, audit.
  PERFORM pg_temp.eq('B: 11 landings', (SELECT count(*) FROM public.page365_landings)::integer, 11);
  PERFORM pg_temp.eq('B: photos pending for the copier',
    (SELECT count(*) FROM public.page365_landings WHERE photos_done_at IS NULL AND photos_total = 2)::integer, 11);
  PERFORM pg_temp.eq('B: item matched to the landed variant', (pg_temp.item(v_run, 'W3356')).match_result || '/'
    || (pg_temp.item(v_run, 'W3356')).result_note, 'matched/landed');
  PERFORM pg_temp.eq('B: audited once per product',
    (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_product_landed')::integer, 11);
END $b$;

-- C. Publishing an incomplete landed product is blocked until it is fixed --------
DO $c$
DECLARE
  v_ns  uuid := (pg_temp.prod('NS100')).id;
  v_cat uuid;
  v_res jsonb;
  v_ok  boolean;
BEGIN
  INSERT INTO public.website_categories(name, slug) VALUES ('Test Necklaces', 'test-necklaces-land') RETURNING id INTO v_cat;
  INSERT INTO public.website_category_products(category_id, product_id, sort_order) VALUES (v_cat, v_ns, 0);
  UPDATE public.website_products SET origin = 'JAPAN' WHERE id = v_ns;
  PERFORM pg_temp.eq('C: only the metal is missing', public.website_product_publish_missing(v_ns), ARRAY['metal']);

  PERFORM set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
  v_res := public.website_publish_products(ARRAY[v_ns]);
  PERFORM pg_temp.eq('C: bulk publish blocks it', (v_res->>'blocked')::integer, 1);
  PERFORM pg_temp.eq('C: blocked for the metal', v_res->'blocked_items'->0->'missing'->>0, 'metal');
  PERFORM set_config('test.uid', '', false);

  v_ok := true;
  BEGIN
    UPDATE public.website_products SET status = 'active' WHERE id = v_ns;
  EXCEPTION WHEN check_violation THEN v_ok := false;
  END;
  PERFORM pg_temp.eq('C: a direct publish is refused', v_ok, false);
  -- The CHECK alone refuses it too (a Hub-made jewelry product, no guard trigger path).
  v_ok := true;
  BEGIN
    INSERT INTO public.website_products(sku, status, origin, metals) VALUES ('HUBNOSTAMP', 'active', 'JAPAN', '{}');
  EXCEPTION WHEN check_violation THEN v_ok := false;
  END;
  PERFORM pg_temp.eq('C: CHECK refuses published jewelry without a stamp', v_ok, false);
  PERFORM pg_temp.eq('C: still a draft', (pg_temp.prod('NS100')).status::text, 'draft');

  -- Fixed: staff set the stamp; publishing now works.
  UPDATE public.website_products SET metals = ARRAY['K18'] WHERE id = v_ns;
  PERFORM set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
  v_res := public.website_publish_products(ARRAY[v_ns]);
  PERFORM set_config('test.uid', '', false);
  PERFORM pg_temp.eq('C: published once fixed', (v_res->>'published')::integer, 1);
  PERFORM pg_temp.eq('C: now active', (pg_temp.prod('NS100')).status::text, 'active');
  -- An accessory needs no stamp to publish.
  PERFORM pg_temp.eq('C: an accessory never needs a stamp',
    'metal' = ANY (public.website_product_publish_missing((pg_temp.prod('W3356')).id)), false);
END $c$;

-- D. The next reads land nothing twice; stock of a landed draft follows Page365 --
DO $d$
DECLARE v_run uuid; v_fin jsonb;
BEGIN
  v_run := pg_temp.run('full', (SELECT j FROM cat));
  v_fin := (SELECT result FROM finished WHERE run_id = v_run);
  PERFORM pg_temp.eq('D: second full read lands nothing', (v_fin->'landed'->>'landed')::integer, 0);
  PERFORM pg_temp.eq('D: W3356 now a matched piece', (pg_temp.item(v_run, 'W3356')).match_result, 'matched');
  PERFORM pg_temp.eq('D: one W3356', (SELECT count(*) FROM public.website_products WHERE sku = 'W3356')::integer, 1);
  PERFORM pg_temp.eq('D: still 11 landings', (SELECT count(*) FROM public.page365_landings)::integer, 11);
END $d$;

-- E. QUICK reads: a listing never read before is opened and lands ----------------
DO $e$
DECLARE v_run uuid; v_fin jsonb;
BEGIN
  v_run := pg_temp.run('quick', (SELECT j FROM cat) || jsonb_build_array(
    pg_temp.p(910020, 'W9901 Wallet Chanel Coco Mark Coin Case [Preloved]', 'SUPPLIER LISTINGS - BRANDS', 1),
    pg_temp.p(910021, 'SO200 Ring K18 new but sold', 'Rings Made in Japan', 0)));
  v_fin := (SELECT result FROM finished WHERE run_id = v_run);
  PERFORM pg_temp.eq('E: quick read ready', v_fin->>'status', 'ready');
  PERFORM pg_temp.eq('E: the never-read listing was opened',
    (SELECT status FROM public.page365_inventory_products WHERE run_id = v_run AND page365_product_id = 910020), 'fetched');
  PERFORM pg_temp.eq('E: a known Page365-only listing (sold out) is not opened',
    (SELECT status FROM public.page365_inventory_products WHERE run_id = v_run AND page365_product_id = 910012), 'listed');
  PERFORM pg_temp.eq('E: the name-without-code listing is not reopened',
    (SELECT status FROM public.page365_inventory_products WHERE run_id = v_run AND page365_product_id = 910015), 'listed');
  PERFORM pg_temp.eq('E: a landed product''s listing is opened (stock follows)',
    (SELECT status FROM public.page365_inventory_products WHERE run_id = v_run AND page365_product_id = 910001), 'fetched');
  PERFORM pg_temp.eq('E: W9901 landed within one quick read', (pg_temp.prod('W9901')).item_kind || '/' || (pg_temp.prod('W9901')).status::text,
    'accessory/draft');
  PERFORM pg_temp.eq('E: a new sold-out code opened but not landed', (pg_temp.prod('SO200')).id IS NULL, true);
  PERFORM pg_temp.eq('E: its reason kept', (pg_temp.item(v_run, 'SO200')).result_note, 'sold_out');
END $e$;

-- F. The Create drafts path is gone -----------------------------------------------
SELECT pg_temp.eq('F: create_drafts dropped', to_regprocedure('public.page365_inventory_create_drafts(uuid,uuid[])') IS NULL, true);
SELECT pg_temp.eq('F: refresh_product dropped', to_regprocedure('public.page365_inventory_refresh_product(uuid,jsonb,text)') IS NULL, true);

SELECT 'ALL AUTO-LAND CHECKS PASSED' AS result;
