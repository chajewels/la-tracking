-- ============================================================================
-- Page365 inventory drafts — LOCAL behaviour tests (2026-09-28). Local Postgres
-- only: run after the stubs and the three migrations (see the stub's header).
-- Every check RAISEs on failure; the last line prints ALL DRAFT CHECKS PASSED.
--
-- Covers: drafts are status 'draft' and origin UNKNOWN; sku = code; price and
-- stock from the fetch (sold pieces only when asked for); a listing carrying
-- two codes gives two single-variant products; category mapped only from a
-- jewelry-type Page365 category and only to ONE Hub category; metal stamps only
-- as printed; description only if clean; reviews never stored; idempotency
-- (second press, code made by hand since the fetch, next fetch sees the draft
-- as a matched piece); "Necklace …" never becomes a sku; banned gold wording
-- fails the row, not the call; photos copied in Page365 order with no
-- duplicates; bulk publish blocks on origin / category / brand and names what
-- is missing; the guard trigger stops a Page365 draft going live around it but
-- leaves Hub-made products alone; permission, superseded run; audit rows.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;

CREATE OR REPLACE FUNCTION pg_temp.run(p_details jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(page365_count, products_total)
  -- page365_count never below an earlier run's, so the > 20 % drop rule (PR 1) stays out of these tests.
  VALUES (greatest(jsonb_array_length(p_details), (SELECT max(page365_count) FROM public.page365_inventory_runs)),
          jsonb_array_length(p_details)) RETURNING id INTO v_run;
  -- As page365-inventory-fetch "start" writes them: list name, category, description.
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name, list_category_id, list_category, list_description)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name', (x->>'cat_id')::bigint, x->>'cat', x->>'desc' FROM jsonb_array_elements(p_details) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_details) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL);
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  RETURN v_run;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, variants jsonb, cat text, descr text, photos jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'cat_id', 1, 'cat', cat, 'desc', descr,
    'detail', jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL, 'photos', photos, 'variants', variants,
                                 'review', jsonb_build_object('customer_name', 'Jane Buyer', 'body', 'lovely'))) $$;
CREATE OR REPLACE FUNCTION pg_temp.v(id bigint, vname text, code text, avail integer, price integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', id, 'name', vname, 'code', code, 'price_jpy', price, 'full_price_jpy', NULL, 'available', avail) $$;
CREATE OR REPLACE FUNCTION pg_temp.ph(id bigint, pos integer) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', id, 'version', '17', 'url', 'https://assets.page365.net/p/' || id || '.jpg?17', 'position', pos) $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.page365_inventory_items WHERE run_id = p_run AND code = p_code $$;
CREATE OR REPLACE FUNCTION pg_temp.prod(p_sku text) RETURNS public.website_products LANGUAGE sql AS $$
  SELECT * FROM public.website_products WHERE sku = p_sku $$;
CREATE OR REPLACE FUNCTION pg_temp.reason(p_res jsonb, p_list text, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT x->>'reason' FROM jsonb_array_elements(p_res->p_list) x WHERE x->>'code' = p_code LIMIT 1 $$;

-- The PR 1 tests may leave a run mid-read; close it so these runs can start.
UPDATE public.page365_inventory_runs SET status = 'failed' WHERE status = 'fetching';

-- Staff with the catalog permission, and one without.
INSERT INTO public.perm VALUES ('30000000-0000-0000-0000-000000000001', 'manage_website_catalog');
SELECT set_config('test.uid', '30000000-0000-0000-0000-000000000001', false);

INSERT INTO public.website_categories(id, slug, name) VALUES
 ('40000000-0000-0000-0000-000000000001', 'rings', 'Rings'),
 ('40000000-0000-0000-0000-000000000002', 'necklaces', 'Necklaces'),
 ('40000000-0000-0000-0000-000000000003', 'pendant', 'Pendant'),
 ('40000000-0000-0000-0000-000000000004', 'pendants', 'Pendants'),
 ('40000000-0000-0000-0000-000000000005', 'earrings', 'Earrings');

-- Helpers ------------------------------------------------------------------
SELECT pg_temp.eq('category: Rings MIJ -> Rings', public.page365_category_for('Rings MIJ'), '40000000-0000-0000-0000-000000000001'::uuid);
SELECT pg_temp.eq('category: Necklace MIJ -> Necklaces', public.page365_category_for('Necklace MIJ'), '40000000-0000-0000-0000-000000000002'::uuid);
SELECT pg_temp.eq('category: two Hub pendant categories -> none', public.page365_category_for('Pendant MIJ'), NULL::uuid);
SELECT pg_temp.eq('category: supplier listing -> none', public.page365_category_for('SUPPLIER LISTINGS - JEWELRY'), NULL::uuid);
SELECT pg_temp.eq('category: branded preloved -> none', public.page365_category_for('- BRANDED PRELOVED'), NULL::uuid);
SELECT pg_temp.eq('category: no Hub bracelet category -> none', public.page365_category_for('Bracelet MIJ'), NULL::uuid);
SELECT pg_temp.eq('metals: as printed, in order', public.page365_metals_from_text('R1 Ring PT900/K18 3.1g K18'), ARRAY['PT900','K18']);
SELECT pg_temp.eq('metals: 0.750ct is not a stamp', public.page365_metals_from_text('Diamond 0.750ct'), ARRAY[]::text[]);
SELECT pg_temp.eq('metals: [750] in brackets is', public.page365_metals_from_text('Chain [750] 45cm'), ARRAY['750']);
SELECT pg_temp.eq('description: phone refused', public.page365_clean_description('Call 090-1234-5678'), NULL::text);
SELECT pg_temp.eq('description: email refused', public.page365_clean_description('mail a@b.jp'), NULL::text);
SELECT pg_temp.eq('description: html refused', public.page365_clean_description('<b>K18</b>'), NULL::text);
SELECT pg_temp.eq('description: blank lines collapsed',
  public.page365_clean_description(E'K18 2.1g\r\n\r\n\r\n\r\nDiamond 0.3ct  '), E'K18 2.1g\n\nDiamond 0.3ct');

-- A fetch --------------------------------------------------------------------
DO $t$
DECLARE
  v_run uuid; v_run2 uuid; v_res jsonb; v_p public.website_products; v_n integer; v_it public.page365_inventory_items;
  v_ids uuid[];
BEGIN
  v_run := pg_temp.run(jsonb_build_array(
    pg_temp.p(9001, 'R7001 Ring K18 2.1g Diamond 0.3ct [New]', jsonb_build_array(pg_temp.v(1, NULL, 'R7001', 2, 50000)),
              'Rings MIJ', E'K18 2.1g \nDiamond 0.3ct\n', jsonb_build_array(pg_temp.ph(503, 2), pg_temp.ph(501, 0), pg_temp.ph(502, 1))),
    pg_temp.p(9002, 'N7002 Necklace PT900 Pearl 45cm', jsonb_build_array(pg_temp.v(2, NULL, 'N7002', 0, 30000)),
              'SUPPLIER LISTINGS - PEARLS', 'Order at https://shop.example'),
    pg_temp.p(9003, 'E7003/E7004 Earrings K18', jsonb_build_array(
                pg_temp.v(3, 'E7003 Earrings K18 Hoop', 'E7003', 1, 20000),
                pg_temp.v(4, 'E7004 Earrings K18 Stud', 'E7004', 1, 21000)), 'Earrings MIJ', NULL),
    pg_temp.p(9005, 'X7005 Bangle K18', jsonb_build_array(pg_temp.v(5, NULL, 'X7005', 1, 90000)), 'SUPPLIER LISTINGS - JEWELRY', NULL),
    pg_temp.p(9006, 'Necklace K18 SSP Pearl', jsonb_build_array(pg_temp.v(6, NULL, 'NECKLACE', 1, 40000)), 'SUPPLIER LISTINGS - PEARLS', NULL),
    pg_temp.p(9007, 'B7007 Bracelet leather 18cm', jsonb_build_array(pg_temp.v(7, NULL, 'B7007', 1, 5000)), 'Bracelet MIJ', NULL),
    pg_temp.p(9008, 'P7008 Pendant K18 Japan gold', jsonb_build_array(pg_temp.v(8, NULL, 'P7008', 1, 15000)), 'Pendant MIJ', NULL),
    pg_temp.p(9009, 'R7009 Ring K18 Preloved [Preloved]', jsonb_build_array(pg_temp.v(9, NULL, 'R7009', 1, 60000)), '- BRANDED PRELOVED', NULL)
  ));
  PERFORM pg_temp.eq('run ready', (SELECT status FROM public.page365_inventory_runs WHERE id = v_run), 'ready');
  PERFORM pg_temp.eq('all nine codes are new', (SELECT count(*)::integer FROM public.page365_inventory_items
                                                    WHERE run_id = v_run AND category = 'new'), 9);

  -- X7005 is made by hand after the fetch.
  INSERT INTO public.website_products(sku, slug, name, status) VALUES ('X7005 hand', 'x7005-hand', 'Hand made', 'draft');

  -- No permission -> refused, nothing written.
  PERFORM set_config('test.uid', '30000000-0000-0000-0000-000000000009', false);
  v_res := public.page365_inventory_create_drafts(v_run, ARRAY[pg_temp.item(v_run, 'R7001')]);
  PERFORM pg_temp.eq('no permission refused', v_res->>'reason', 'forbidden');
  PERFORM set_config('test.uid', '30000000-0000-0000-0000-000000000001', false);

  SELECT array_agg(id) INTO v_ids FROM public.page365_inventory_items WHERE run_id = v_run AND category = 'new';
  v_res := public.page365_inventory_create_drafts(v_run, v_ids);
  PERFORM pg_temp.eq('created', (v_res->>'created')::integer, 5);
  PERFORM pg_temp.eq('skipped', (v_res->>'skipped')::integer, 1);
  PERFORM pg_temp.eq('failed', (v_res->>'failed')::integer, 3);
  PERFORM pg_temp.eq('X7005 skipped: code exists', pg_temp.reason(v_res, 'skipped_items', 'X7005'), 'code_exists');
  PERFORM pg_temp.eq('NECKLACE never a sku', pg_temp.reason(v_res, 'failed_items', 'NECKLACE'), 'code_is_a_word');
  PERFORM pg_temp.eq('B7007 no metal', pg_temp.reason(v_res, 'failed_items', 'B7007'), 'no_metal');
  PERFORM pg_temp.eq('P7008 banned gold wording fails the row',
    pg_temp.reason(v_res, 'failed_items', 'P7008') LIKE 'Forbidden gold terminology%', true);
  PERFORM pg_temp.eq('no NECKLACE product', (SELECT count(*)::integer FROM public.website_products WHERE sku = 'NECKLACE'), 0);

  v_p := pg_temp.prod('R7001');
  PERFORM pg_temp.eq('R7001 is a draft', v_p.status, 'draft');
  PERFORM pg_temp.eq('R7001 origin not guessed', v_p.origin, 'UNKNOWN');
  PERFORM pg_temp.eq('R7001 name from Page365', v_p.name, 'R7001 Ring K18 2.1g Diamond 0.3ct [New]');
  PERFORM pg_temp.eq('R7001 metals as printed', v_p.metals, ARRAY['K18']);
  PERFORM pg_temp.eq('R7001 condition New', v_p.condition, 'New');
  PERFORM pg_temp.eq('R7001 description cleaned', v_p.description_en, E'K18 2.1g\nDiamond 0.3ct');
  PERFORM pg_temp.eq('R7001 price is the Page365 yen price',
    (SELECT price_jpy FROM public.website_product_variants WHERE product_id = v_p.id), 50000);
  PERFORM pg_temp.eq('R7001 stock is Page365 available',
    (SELECT stock_qty FROM public.website_product_variants WHERE product_id = v_p.id), 2);
  PERFORM pg_temp.eq('R7001 category Rings',
    (SELECT category_id FROM public.website_category_products WHERE product_id = v_p.id), '40000000-0000-0000-0000-000000000001'::uuid);
  PERFORM pg_temp.eq('R7001 slug', v_p.slug, 'r7001-ring-k18-2-1g-diamond-0-3ct-new');
  SELECT * INTO v_it FROM public.page365_inventory_items WHERE id = pg_temp.item(v_run, 'R7001');
  PERFORM pg_temp.eq('R7001 item now matched to the draft', v_it.match_result || '/' || v_it.status || '/' || v_it.result_note,
                     'matched/applied/draft_created');
  PERFORM pg_temp.eq('R7001 item photos to copy', v_it.photos_to_copy, 3);

  v_p := pg_temp.prod('N7002');
  PERFORM pg_temp.eq('N7002 sold piece created with 0 when asked',
    (SELECT stock_qty FROM public.website_product_variants WHERE product_id = v_p.id), 0);
  PERFORM pg_temp.eq('N7002 description with a link not copied', v_p.description_en, NULL::text);
  PERFORM pg_temp.eq('N7002 supplier listing uncategorised',
    (SELECT count(*)::integer FROM public.website_category_products WHERE product_id = v_p.id), 0);
  PERFORM pg_temp.eq('N7002 needs origin + category',
    (SELECT x->'needs' FROM jsonb_array_elements(v_res->'created_items') x WHERE x->>'code' = 'N7002'), '["origin", "category"]'::jsonb);

  PERFORM pg_temp.eq('E7003/E7004 one product per code',
    (SELECT count(*)::integer FROM public.website_products WHERE sku IN ('E7003','E7004') AND page365_product_id = 9003), 2);
  PERFORM pg_temp.eq('E7004 single variant at its own price',
    (SELECT string_agg(v.price_jpy::text, ',') FROM public.website_product_variants v JOIN public.website_products p ON p.id = v.product_id
      WHERE p.sku = 'E7004'), '21000');
  PERFORM pg_temp.eq('E7004 named by its variant', (pg_temp.prod('E7004')).name, 'E7004 Earrings K18 Stud');
  PERFORM pg_temp.eq('R7009 preloved from Page365 label', (pg_temp.prod('R7009')).condition, 'Preloved');
  PERFORM pg_temp.eq('no review text anywhere', (SELECT count(*)::integer FROM public.website_products
     WHERE coalesce(description_en, '') ILIKE '%Jane%' OR name ILIKE '%Jane%'), 0);
  PERFORM pg_temp.eq('no review stored on the run', (SELECT count(*)::integer FROM public.page365_inventory_products
     WHERE run_id = v_run AND (photos::text ILIKE '%Jane%' OR coalesce(list_description, '') ILIKE '%Jane%')), 0);
  PERFORM pg_temp.eq('audit row per draft', (SELECT count(*)::integer FROM public.audit_logs WHERE action = 'page365_draft_created'), 5);

  -- Idempotent: the same press again creates nothing.
  v_res := public.page365_inventory_create_drafts(v_run, v_ids);
  PERFORM pg_temp.eq('second press creates nothing', (v_res->>'created')::integer, 0);
  PERFORM pg_temp.eq('second press: already created', pg_temp.reason(v_res, 'skipped_items', 'R7001'), 'already_created');
  PERFORM pg_temp.eq('still one R7001', (SELECT count(*)::integer FROM public.website_products WHERE sku = 'R7001'), 1);

  -- Photos through the PR 1 recorder, in Page365 order, no duplicates.
  FOR v_n IN 0..2 LOOP
    PERFORM public.page365_inventory_record_photo(pg_temp.item(v_run, 'R7001'), (501 + v_n)::bigint, '17',
      'https://x.supabase.co/storage/v1/object/public/promotions/website/page365/9001/' || (501 + v_n) || '-17.jpeg',
      'https://assets.page365.net/p/' || (501 + v_n) || '.jpg?17', v_n, '30000000-0000-0000-0000-000000000001');
  END LOOP;
  PERFORM pg_temp.eq('photos in Page365 order, first = main',
    (SELECT string_agg(m.page365_photo_id::text || '@' || m.sort, ',' ORDER BY m.sort) FROM public.website_product_media m
      JOIN public.website_product_variants v ON v.id = m.variant_id WHERE v.product_id = (pg_temp.prod('R7001')).id),
    '501@0,502@1,503@2');
  PERFORM pg_temp.eq('re-copy reports exists',
    public.page365_inventory_record_photo(pg_temp.item(v_run, 'R7001'), 501, '17',
      'https://x.supabase.co/storage/v1/object/public/promotions/website/page365/9001/501-17.jpeg',
      'https://assets.page365.net/p/501.jpg?17', 0, NULL), 'exists');
  PERFORM pg_temp.eq('no duplicate photos', (SELECT count(*)::integer FROM public.website_product_media m
      JOIN public.website_product_variants v ON v.id = m.variant_id WHERE v.product_id = (pg_temp.prod('R7001')).id), 3);

  -- Publish -------------------------------------------------------------------
  v_res := public.website_publish_products(ARRAY[(pg_temp.prod('R7001')).id, (pg_temp.prod('N7002')).id]);
  PERFORM pg_temp.eq('nothing published without origin', (v_res->>'published')::integer, 0);
  PERFORM pg_temp.eq('R7001 blocked: origin',
    (SELECT x->'missing' FROM jsonb_array_elements(v_res->'blocked_items') x WHERE x->>'sku' = 'R7001'), '["origin"]'::jsonb);
  PERFORM pg_temp.eq('N7002 blocked: origin, category',
    (SELECT x->'missing' FROM jsonb_array_elements(v_res->'blocked_items') x WHERE x->>'sku' = 'N7002'), '["origin", "category"]'::jsonb);

  -- The dialog route: a direct status change on a Page365 draft is refused.
  BEGIN
    UPDATE public.website_products SET status = 'active' WHERE sku = 'R7001';
    RAISE EXCEPTION 'FAIL guard: R7001 went active without origin';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.eq('guard names what is missing', SQLERRM, 'Cannot publish R7001: set origin first.');
  END;
  BEGIN
    UPDATE public.website_products SET origin = 'BRAND', status = 'active' WHERE sku = 'R7009';
    RAISE EXCEPTION 'FAIL guard: branded without brand';
  EXCEPTION WHEN check_violation THEN
    PERFORM pg_temp.eq('guard: brand + category', SQLERRM, 'Cannot publish R7009: set brand, category first.');
  END;
  -- Hub-made products are not the guard's business.
  UPDATE public.website_products SET status = 'active' WHERE sku = 'X7005 hand';
  PERFORM pg_temp.eq('Hub-made product publishes as before', (pg_temp.prod('X7005 hand')).status, 'active');

  UPDATE public.website_products SET origin = 'JAPAN' WHERE sku = 'R7001';
  UPDATE public.website_products SET origin = 'OTHER' WHERE sku = 'N7002';
  v_res := public.website_publish_products(ARRAY[(pg_temp.prod('R7001')).id, (pg_temp.prod('N7002')).id]);
  PERFORM pg_temp.eq('R7001 published', (v_res->'published_items'->0->>'sku'), 'R7001');
  PERFORM pg_temp.eq('R7001 active', (pg_temp.prod('R7001')).status, 'active');
  PERFORM pg_temp.eq('N7002 still blocked on category',
    (SELECT x->'missing' FROM jsonb_array_elements(v_res->'blocked_items') x WHERE x->>'sku' = 'N7002'), '["category"]'::jsonb);
  PERFORM pg_temp.eq('N7002 still a draft', (pg_temp.prod('N7002')).status, 'draft');
  INSERT INTO public.website_category_products(category_id, product_id) VALUES ('40000000-0000-0000-0000-000000000002', (pg_temp.prod('N7002')).id);
  v_res := public.website_publish_products(ARRAY[(pg_temp.prod('N7002')).id, (pg_temp.prod('R7001')).id]);
  PERFORM pg_temp.eq('N7002 published once categorised', (pg_temp.prod('N7002')).status, 'active');
  PERFORM pg_temp.eq('R7001 again: not a draft', (v_res->'skipped_items'->0->>'reason'), 'not_a_draft');
  PERFORM pg_temp.eq('publish audited', (SELECT count(*)::integer FROM public.audit_logs WHERE action = 'website_product_published'), 2);

  PERFORM set_config('test.uid', '30000000-0000-0000-0000-000000000009', false);
  PERFORM pg_temp.eq('publish without permission', public.website_publish_products(ARRAY[(pg_temp.prod('E7003')).id])->>'reason', 'forbidden');
  PERFORM set_config('test.uid', '30000000-0000-0000-0000-000000000001', false);

  -- The next fetch: the draft is an ordinary matched piece, never "new" again.
  v_run2 := pg_temp.run(jsonb_build_array(
    pg_temp.p(9001, 'R7001 Ring K18 2.1g Diamond 0.3ct [New]', jsonb_build_array(pg_temp.v(1, NULL, 'R7001', 1, 50000)), 'Rings MIJ', NULL)));
  PERFORM pg_temp.eq('next fetch matches the draft',
    (SELECT match_result || '/' || category FROM public.page365_inventory_items WHERE run_id = v_run2 AND code = 'R7001'), 'matched/decrease');
  -- One transaction gives both runs the same now(); the second is later in life.
  UPDATE public.page365_inventory_runs SET created_at = created_at + interval '1 second' WHERE id = v_run2;
  v_res := public.page365_inventory_create_drafts(v_run, ARRAY[pg_temp.item(v_run, 'B7007')]);
  PERFORM pg_temp.eq('older run superseded', v_res->>'reason', 'superseded');
  v_res := public.page365_inventory_create_drafts(v_run2, ARRAY[pg_temp.item(v_run2, 'R7001')]);
  PERFORM pg_temp.eq('matched row is not new', pg_temp.reason(v_res, 'skipped_items', 'R7001'), 'not_new');
END
$t$;

DO $$ BEGIN RAISE NOTICE 'ALL DRAFT CHECKS PASSED'; END $$;
