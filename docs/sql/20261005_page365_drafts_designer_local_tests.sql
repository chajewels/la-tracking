-- ============================================================================
-- Page365 "Create drafts" for designer pieces (fix, 2026-09-26) — LOCAL
-- behaviour tests. Local Postgres only. Run after the stubs and every earlier
-- Page365 migration, then this one (no new stub is needed):
--
--   (the PR 3d sequence from docs/sql/20261003_page365_interval_local_tests.sql, then)
--   $P supabase/migrations/20261005100000_page365_drafts_designer.sql
--   $P supabase/migrations/20261005100000_page365_drafts_designer.sql   # re-run is safe
--   $P docs/sql/20261005_page365_drafts_designer_local_tests.sql
--
-- Every check RAISEs on failure; the last line prints ALL DESIGNER DRAFT CHECKS PASSED.
--
-- Covers, with the owner's own Page365 text: wallets (W3356 …), a key case,
-- a bag and a belt are drafted as item_kind 'other' with no stamp; a watch as
-- 'watch'; branded jewelry printed "750WG" / "K18YG/WG" / "SV925" is drafted
-- as jewelry with that stamp; a plain K18 ring is drafted exactly as before;
-- jewelry with no printed stamp ("SV" only) still FAILS no_metal — and every
-- skipped or failed row now keeps its reason in result_note (no_metal,
-- not_fresh, code_is_a_word), while a drafted row keeps draft_created.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.prod(p_sku text) RETURNS public.website_products LANGUAGE sql AS $$
  SELECT * FROM public.website_products WHERE sku = p_sku $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id = p_run AND code = p_code LIMIT 1 $$;
-- A one-variant listing whose code is the first word of its name.
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, category text, code text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name, 'category', category,
    'detail', jsonb_build_object('name', name, 'price_jpy', 50000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL,
        'code', coalesce(code, split_part(name, ' ', 1)), 'price_jpy', 50000, 'full_price_jpy', NULL, 'available', 1)))) $$;

-- One FULL manual read, newest of all, every listing read "fresh" just now.
CREATE TEMP TABLE t_run AS SELECT NULL::uuid AS id;
DO $run$
DECLARE v_run uuid; r record; d jsonb;
  v_list jsonb := jsonb_build_array(
    pg_temp.p(910001, 'W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
    pg_temp.p(910002, 'W1451 Wallet Louis Vuitton Porte 2 Cult Vertical Pass Case [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
    pg_temp.p(910003, 'W2497 Key Case Louis Vuitton Monogram Multicle 4 [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
    pg_temp.p(910004, 'SB022 Bag Burberry Shoulder bag [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
    pg_temp.p(910005, 'B2948 Belt Louis Vuitton Belt - LV Dimension Reversible 85/34 [Preloved]', 'SUPPLIER LISTINGS - BRANDS'),
    pg_temp.p(910006, 'WT100 Rolex Datejust 36mm [Preloved]', 'SUPPLIER LISTINGS - WATCH'),
    pg_temp.p(910007, 'R1072 Ring Gucci 750WG 3.12g Icon Sz# 11 [Preloved]', 'SUPPLIER LISTINGS - BRANDED PRELOVED'),
    pg_temp.p(910008, 'N3876 Necklace K18YG/WG 1.90g Ruby 0.44ct Diamond 0.07ct Top 40cm [Preloved]', 'SUPPLIER LISTINGS - JEWELRY'),
    pg_temp.p(910009, 'N1337 Necklace SV925 Tahiti SSP 9.5-10.0mm 45cm [Preloved]', 'SUPPLIER LISTINGS - PEARLS'),
    pg_temp.p(910010, 'R9001 Ring K18 2.1g Diamond 0.10ct', 'Rings Made in Japan'),
    pg_temp.p(910011, 'N3178 Necklace SV 8.50g Emerald 48cm [Preloved]', 'SUPPLIER LISTINGS - JEWELRY'),
    pg_temp.p(910012, 'NF001 Necklace K18 45cm', 'Necklace Made in Japan'),
    pg_temp.p(910013, 'Necklace K18 SSP White Pearl 45cm', 'SUPPLIER LISTINGS - PEARLS'));
BEGIN
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES ('manual', 'full',
          greatest(jsonb_array_length(v_list), (SELECT max(page365_count) FROM public.page365_inventory_runs)),
          jsonb_array_length(v_list))
  RETURNING id INTO v_run;
  UPDATE public.page365_inventory_runs SET created_at = (SELECT max(created_at) FROM public.page365_inventory_runs) + interval '1 second'
   WHERE id = v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name, list_category)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name', x->>'category' FROM jsonb_array_elements(v_list) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(v_list) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL);
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  PERFORM pg_temp.eq('setup: run ready', (SELECT status FROM public.page365_inventory_runs WHERE id = v_run), 'ready');
  UPDATE t_run SET id = v_run;
END $run$;

-- A. The helpers, on Page365's own text ---------------------------------------
DO $a$
BEGIN
  PERFORM pg_temp.eq('A: wallet -> other', public.page365_item_kind_for('W3356 Wallet Gucci GG Marmont Long Wallet', 'SUPPLIER LISTINGS - BRANDS'), 'other');
  PERFORM pg_temp.eq('A: coin purse -> other', public.page365_item_kind_for('W2068 Coin Purse Louis Vuitton Vernis', NULL), 'other');
  PERFORM pg_temp.eq('A: card holder -> other', public.page365_item_kind_for('C1 Card Holder Hermes', NULL), 'other');
  PERFORM pg_temp.eq('A: watch wins over belt', public.page365_item_kind_for('WT2 Cartier Tank watch leather belt', NULL), 'watch');
  PERFORM pg_temp.eq('A: watch from category', public.page365_item_kind_for('WT100 Rolex Datejust', 'SUPPLIER LISTINGS - WATCH'), 'watch');
  PERFORM pg_temp.eq('A: branded ring stays jewelry', public.page365_item_kind_for('R1072 Ring Gucci 750WG', 'SUPPLIER LISTINGS - BRANDED PRELOVED'), 'jewelry');
  PERFORM pg_temp.eq('A: "bag" inside a word is not a bag', public.page365_item_kind_for('R5 Ring Baguette K18', NULL), 'jewelry');
  PERFORM pg_temp.eq('A: 750WG -> 750', public.page365_metals_from_text('Ring Gucci 750WG 3.12g'), ARRAY['750']);
  PERFORM pg_temp.eq('A: K18YG/WG -> K18 once', public.page365_metals_from_text('Necklace K18YG/WG 1.90g'), ARRAY['K18']);
  PERFORM pg_temp.eq('A: 18KWG -> 18K', public.page365_metals_from_text('Ring 18KWG 4.0g'), ARRAY['18K']);
  PERFORM pg_temp.eq('A: K18g -> K18', public.page365_metals_from_text('Necklace K18g 5.28g'), ARRAY['K18']);
  PERFORM pg_temp.eq('A: Pt900 bare still read', public.page365_metals_from_text('Ring Pt900 K18'), ARRAY['PT900', 'K18']);
  PERFORM pg_temp.eq('A: SV925 -> SILVER925', public.page365_metals_from_text('Necklace SV925 Akoya'), ARRAY['SILVER925']);
  PERFORM pg_temp.eq('A: bare SV is no stamp', public.page365_metals_from_text('Necklace SV 8.50g'), ARRAY[]::text[]);
  PERFORM pg_temp.eq('A: 0.750ct is not 750', public.page365_metals_from_text('Diamond 0.750ct'), ARRAY[]::text[]);
  PERFORM pg_temp.eq('A: a weight is never a stamp', public.page365_metals_from_text('7.50g 750.5g'), ARRAY[]::text[]);
END $a$;

-- B. Create drafts -------------------------------------------------------------
DO $b$
DECLARE
  v_run uuid := (SELECT id FROM t_run);
  v_ids uuid[];
  v_res jsonb;
  v_p   public.website_products;
BEGIN
  -- NF001 was not read fresh (the nightly copy only).
  UPDATE public.page365_inventory_products SET fetched_at = now() - interval '3 hours'
   WHERE run_id = v_run AND page365_product_id = 910012;
  SELECT array_agg(id) INTO v_ids FROM public.page365_inventory_items WHERE run_id = v_run AND kind = 'page365';
  PERFORM pg_temp.eq('B: 13 new rows', cardinality(v_ids), 13);
  PERFORM set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
  v_res := public.page365_inventory_create_drafts(v_run, v_ids);
  PERFORM pg_temp.eq('B: ok', (v_res->>'ok')::boolean, true);
  PERFORM pg_temp.eq('B: 10 created', (v_res->>'created')::integer, 10);
  PERFORM pg_temp.eq('B: 1 skipped (not fresh)', (v_res->>'skipped')::integer, 1);
  PERFORM pg_temp.eq('B: 2 failed (SV only; name is a word)', (v_res->>'failed')::integer, 2);

  FOREACH v_p IN ARRAY ARRAY[pg_temp.prod('W3356'), pg_temp.prod('W1451'), pg_temp.prod('W2497'), pg_temp.prod('SB022'), pg_temp.prod('B2948')] LOOP
    PERFORM pg_temp.eq('B: ' || v_p.sku || ' is an OTHER draft', v_p.item_kind || '/' || v_p.status::text, 'other/draft');
    PERFORM pg_temp.eq('B: ' || v_p.sku || ' has no stamp', cardinality(v_p.metals), 0);
    PERFORM pg_temp.eq('B: ' || v_p.sku || ' drafted note', (pg_temp.item(v_run, v_p.sku)).result_note, 'draft_created');
  END LOOP;
  PERFORM pg_temp.eq('B: W3356 preloved', (pg_temp.prod('W3356')).condition, 'Preloved');
  PERFORM pg_temp.eq('B: W3356 origin left UNKNOWN', (pg_temp.prod('W3356')).origin, 'UNKNOWN');
  PERFORM pg_temp.eq('B: created_items carry item_kind',
    (SELECT e->>'item_kind' FROM jsonb_array_elements(v_res->'created_items') e WHERE e->>'code' = 'W3356'), 'other');
  PERFORM pg_temp.eq('B: watch', (pg_temp.prod('WT100')).item_kind, 'watch');
  PERFORM pg_temp.eq('B: branded ring 750WG', (pg_temp.prod('R1072')).item_kind || ' ' || array_to_string((pg_temp.prod('R1072')).metals, ','), 'jewelry 750');
  PERFORM pg_temp.eq('B: K18YG/WG necklace', array_to_string((pg_temp.prod('N3876')).metals, ','), 'K18');
  PERFORM pg_temp.eq('B: SV925 pearls', array_to_string((pg_temp.prod('N1337')).metals, ','), 'SILVER925');
  -- A plain MIJ ring: exactly as before (jewelry, K18, category from "Rings").
  PERFORM pg_temp.eq('B: plain K18 ring unchanged', (pg_temp.prod('R9001')).item_kind || ' ' || array_to_string((pg_temp.prod('R9001')).metals, ','), 'jewelry K18');

  -- Blocked rows: never created, reason kept on the row.
  PERFORM pg_temp.eq('B: SV-only necklace not created', (pg_temp.prod('N3178')).id IS NULL, true);
  PERFORM pg_temp.eq('B: SV-only necklace reason in the result',
    (SELECT e->>'reason' FROM jsonb_array_elements(v_res->'failed_items') e WHERE e->>'code' = 'N3178'), 'no_metal');
  PERFORM pg_temp.eq('B: SV-only necklace reason stored', (pg_temp.item(v_run, 'N3178')).result_note, 'no_metal');
  PERFORM pg_temp.eq('B: SV-only necklace still under review', (pg_temp.item(v_run, 'N3178')).status, 'review');
  PERFORM pg_temp.eq('B: not fresh -> reason stored', (pg_temp.item(v_run, 'NF001')).result_note, 'not_fresh');
  PERFORM pg_temp.eq('B: name is a word -> reason stored', (pg_temp.item(v_run, 'NECKLACE')).result_note, 'code_is_a_word');
  PERFORM pg_temp.eq('B: no review row left without a reason',
    (SELECT count(*) FROM public.page365_inventory_items WHERE run_id = v_run AND kind = 'page365' AND result_note IS NULL)::integer, 0);

  -- Pressing again: the drafted rows are skipped and keep draft_created.
  v_res := public.page365_inventory_create_drafts(v_run, v_ids);
  PERFORM pg_temp.eq('B: second press creates nothing', (v_res->>'created')::integer, 0);
  PERFORM pg_temp.eq('B: drafted row keeps its note', (pg_temp.item(v_run, 'W3356')).result_note, 'draft_created');
  PERFORM pg_temp.eq('B: one product per code', (SELECT count(*) FROM public.website_products WHERE sku = 'W3356')::integer, 1);
  PERFORM set_config('test.uid', '', false);
END $b$;

SELECT 'ALL DESIGNER DRAFT CHECKS PASSED' AS result;
