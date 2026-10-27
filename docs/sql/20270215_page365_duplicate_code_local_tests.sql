-- ============================================================================
-- Page365 duplicate code → match by name (2026-10-27) — LOCAL behaviour tests.
-- Local Postgres only. Run after the stubs and every earlier Page365
-- migration, then this one (no new stub is needed):
--
--   (the auto-land sequence from docs/sql/20261005_page365_auto_land_local_tests.sql, then)
--   $P supabase/migrations/20270215100000_page365_duplicate_code_by_name.sql
--   $P supabase/migrations/20270215100000_page365_duplicate_code_by_name.sql   # re-run is safe
--   $P docs/sql/20270215_page365_duplicate_code_local_tests.sql
--
-- Every check RAISEs on failure; the last line prints ALL DUPLICATE-CODE CHECKS PASSED.
--
-- Covers, with the owner's own Page365 text (N5245, N1045, R1111): a code on two
-- listings follows the listing whose 4 words after the code match the Hub name
-- (scheduled auto-apply decreases it to 0; an edited Hub name still resolves
-- and increases); the other listing stays flagged; a tie, a low score and a
-- variant-only code stay flagged and ring ONE bell, not again on the next
-- read, again only after the code was resolved in between; a partial read
-- never rings; a code with no Hub product stays flagged with no bell; a
-- "Don't sync with Page365" product is still never touched; products that are
-- not duplicated behave exactly as before.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.prod(p_sku text) RETURNS public.website_products LANGUAGE sql AS $$
  SELECT * FROM public.website_products WHERE sku = p_sku ORDER BY created_at LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_sku text) RETURNS integer LANGUAGE sql AS $$
  SELECT sum(v.stock_qty)::integer FROM public.website_product_variants v WHERE v.product_id = (pg_temp.prod(p_sku)).id $$;
CREATE OR REPLACE FUNCTION pg_temp.row(p_run uuid, p_pid bigint) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id = p_run AND page365_product_id = p_pid LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.bells(p_code text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.staff_notifications WHERE type = 'page365_duplicate_code' AND metadata->>'code' = p_code $$;
-- A one-variant listing: code = first word of the name.
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer DEFAULT 1) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name,
    'detail', jsonb_build_object('name', name, 'price_jpy', 50000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', split_part(name, ' ', 1),
        'price_jpy', 50000, 'full_price_jpy', NULL, 'available', avail)))) $$;
-- A two-variant listing: codes on the variant names.
CREATE OR REPLACE FUNCTION pg_temp.pv(pid bigint, name text, v1 text, v2 text, avail integer DEFAULT 1) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name,
    'detail', jsonb_build_object('name', name, 'price_jpy', 50000, 'full_price_jpy', NULL, 'photos', '[]'::jsonb,
      'variants', jsonb_build_array(
        jsonb_build_object('id', pid * 10 + 1, 'name', v1, 'code', split_part(v1, ' ', 1), 'price_jpy', 50000,
                           'full_price_jpy', NULL, 'available', avail),
        jsonb_build_object('id', pid * 10 + 2, 'name', v2, 'code', split_part(v2, ' ', 1), 'price_jpy', 50000,
                           'full_price_jpy', NULL, 'available', avail)))) $$;
-- One read as page365-inventory-fetch does it (list -> claim -> store -> finish).
-- p_fail: pids whose detail read errors (a partial read).
CREATE OR REPLACE FUNCTION pg_temp.run(p_source text, p_list jsonb, p_fail bigint[] DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  UPDATE public.page365_product_presence
     SET first_seen_at = first_seen_at - interval '31 minutes', last_seen_at = last_seen_at - interval '31 minutes';
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES (p_source, 'full', jsonb_array_length(p_list), jsonb_array_length(p_list)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name' FROM jsonb_array_elements(p_list) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_list) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      IF r.o_page365_product_id = ANY (p_fail) THEN
        PERFORM public.page365_inventory_store_product(r.o_id, NULL, 'HTTP 500');
      ELSE
        PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL);
      END IF;
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;

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

-- 0. The helpers ---------------------------------------------------------------
SELECT pg_temp.eq('0: words drop the code, keep 4, upper-case',
  array_to_string(public.page365_name_words('N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct', 'N5245'), ' '),
  'NECKLACE PT850/950 5.20G DIAMOND');
SELECT pg_temp.eq('0: words split on U+3000 and NBSP',
  array_to_string(public.page365_name_words(E'N5245　Necklace PT850  K18', 'n5245'), ' '), 'NECKLACE PT850 K18');
SELECT pg_temp.eq('0: words of a code-only name', cardinality(public.page365_name_words('N5245', 'N5245')), 0);
SELECT pg_temp.eq('0: words of NULL', cardinality(public.page365_name_words(NULL, 'N5245')), 0);
SELECT pg_temp.eq('0: N5245 own piece scores 4', public.page365_name_score(
  'N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]',
  'N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]', 'N5245'), 4);
SELECT pg_temp.eq('0: N5245 K18 Ruby piece scores 2', public.page365_name_score(
  'N5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]',
  'N5245 Necklace K18g 5.28g Diamond 0.32ct Ruby 0.51ct Venetian 45cm [Preloved]', 'N5245'), 2);
SELECT pg_temp.eq('0: order does not matter', public.page365_name_score(
  'X1 Ring K18 Diamond Halo', 'X1 Halo Diamond K18 Ring', 'X1'), 4);
SELECT pg_temp.eq('0: a repeated Hub word counts once', public.page365_name_score(
  'W1465 Watch Bvlgari Bvlgari Collection', 'W1465 Watch Bvlgari Collection Quartz', 'W1465'), 3);

-- Hub side (published): DP5245 1 in stock (N5245's twin), DE1 1 (edited name),
-- DT1 1 (tie), DL1 1 (low score), DS2 1 (switched off), DV1 1 (variant code),
-- PLAIN 3 (not duplicated).
INSERT INTO public.website_products(sku, name, status, origin, metals) VALUES
  ('DP5245', 'DP5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]', 'active', 'JAPAN', ARRAY['PT950']),
  ('DE1',    'DE1 Ring PT900 10.0g Sapphire 2.44ct Diamond 0.79ct Halo Cocktail Sz# 11 [Preloved]', 'active', 'JAPAN', ARRAY['PT900']),
  ('DT1',    'DT1 Ring K18 2.0g Diamond Halo', 'active', 'JAPAN', ARRAY['K18']),
  ('DL1',    'DL1 Ring PT900 Sapphire Oval Halo', 'active', 'JAPAN', ARRAY['PT900']),
  ('DS2',    'DS2 Ring K18 3.0g Ruby Halo', 'active', 'JAPAN', ARRAY['K18']),
  ('DV1',    'DV1 12.0mm', 'active', 'JAPAN', ARRAY['K18']),
  ('PLAIN',  'PLAIN Ring K18 Plain Band', 'active', 'JAPAN', ARRAY['K18']);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, CASE sku WHEN 'PLAIN' THEN 3 ELSE 1 END, 50000 FROM public.website_products
 WHERE sku IN ('DP5245','DE1','DT1','DL1','DS2','DV1','PLAIN');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'DS2';
SELECT pg_temp.eq('switch turned on',
  (public.set_page365_inventory_auto_apply(true, (SELECT (value #>> '{}')::boolean FROM public.system_settings
                                                    WHERE key = 'page365_inventory_auto_apply'))->>'enabled')::boolean, true);
SELECT set_config('test.uid', '', false);

CREATE TEMP TABLE cat AS SELECT jsonb_build_array(
  pg_temp.p(810001, 'DP5245 Necklace PT850/950 5.20g Diamond 0.563, 0.85ct Square Halo 45cm [Preloved]', 0),
  pg_temp.p(810002, 'DP5245 Necklace K18g 5.28g Diamond 0.32ct Ruby 0.51ct Venetian 45cm [Preloved]', 0),
  pg_temp.p(810003, 'DE1 Ring PT900 10.0g Sapp 2.44ct Dia 0.79ct Halo Cocktail Sz# 11 [Preloved]', 2),
  pg_temp.p(810004, 'DE1 Necklace K18 5.0g Ruby 45cm', 1),
  pg_temp.p(810005, 'DT1 Ring K18 2.0g Diamond Halo', 0),
  pg_temp.p(810006, 'DT1 Ring K18 2.0g Diamond Solitaire', 0),
  pg_temp.p(810007, 'DL1 Bracelet K18 Chain 18cm', 0),
  pg_temp.p(810008, 'DL1 Earrings K14 Hoop Gold', 0),
  pg_temp.p(810009, 'DS2 Ring K18 3.0g Ruby Halo', 0),
  pg_temp.p(810010, 'DS2 Necklace PT 1.0g Plain', 0),
  pg_temp.pv(810011, 'Necklace K18 SSP White Pearl 45cm Pinslide', 'DV1 12.0mm', 'DV2 10.0mm', 0),
  pg_temp.pv(810012, 'Necklace K18 Akoya Pearl 42cm', 'DV1 8.0mm', 'DV3 7.0mm', 0),
  pg_temp.p(810013, 'DN1 Ring K18 Only In Page365', 1),
  pg_temp.p(810014, 'DN1 Necklace K18 Only In Page365', 1),
  pg_temp.p(810015, 'PLAIN Ring K18 Plain Band', 1)) AS j;
CREATE TEMP TABLE r(k text PRIMARY KEY, id uuid);

-- A. A partial read rings no bell -------------------------------------------------
INSERT INTO r VALUES ('A', pg_temp.run('schedule', (SELECT j FROM cat), ARRAY[810015::bigint]));
SELECT pg_temp.eq('A: partial', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='A')), 'partial');
SELECT pg_temp.eq('A: no duplicate bell from a partial read',
  (SELECT count(*) FROM public.staff_notifications WHERE type = 'page365_duplicate_code'), 0::bigint);
SELECT pg_temp.eq('A: partial applies nothing',
  public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='A'))->>'state', 'not_ready');
SELECT pg_temp.eq('A: DP5245 untouched', pg_temp.stock('DP5245'), 1);

-- B. Complete scheduled read --------------------------------------------------------
INSERT INTO r VALUES ('B', pg_temp.run('schedule', (SELECT j FROM cat)));
SELECT pg_temp.eq('B: ready', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='B')), 'ready');
-- N5245's twin: own piece followed, other piece flagged.
SELECT pg_temp.eq('B: DP5245 own listing matched by name',
  (pg_temp.row((SELECT id FROM r WHERE k='B'), 810001)).match_result || '/' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810001)).result_note,
  'matched/matched_by_name');
SELECT pg_temp.eq('B: DP5245 proposed 1 -> 0 (decrease)',
  (pg_temp.row((SELECT id FROM r WHERE k='B'), 810001)).category || ' ' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810001)).seen_stock
    || '->' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810001)).proposed_stock, 'decrease 1->0');
SELECT pg_temp.eq('B: DP5245 other piece stays flagged',
  (pg_temp.row((SELECT id FROM r WHERE k='B'), 810002)).match_result || '/' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810002)).category
    || '/' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810002)).result_note, 'duplicate_in_page365/flagged/duplicate_other_piece');
-- Edited Hub name (Sapp/Dia -> Sapphire/Diamond) still resolves; increase 1 -> 2.
SELECT pg_temp.eq('B: DE1 edited name resolves to the ring',
  (pg_temp.row((SELECT id FROM r WHERE k='B'), 810003)).category || '/' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810003)).result_note,
  'increase/matched_by_name');
-- Tie, low score, variant code: flagged, unresolved, one bell each.
SELECT pg_temp.eq('B: DT1 tie stays flagged', (pg_temp.row((SELECT id FROM r WHERE k='B'), 810005)).result_note
  || '+' || (pg_temp.row((SELECT id FROM r WHERE k='B'), 810006)).result_note, 'duplicate_unresolved+duplicate_unresolved');
SELECT pg_temp.eq('B: DL1 low score stays flagged', (pg_temp.row((SELECT id FROM r WHERE k='B'), 810007)).result_note, 'duplicate_unresolved');
SELECT pg_temp.eq('B: DV1 variant-only code stays flagged',
  (SELECT string_agg(i.result_note, ',') FROM public.page365_inventory_items i
    WHERE i.run_id = (SELECT id FROM r WHERE k='B') AND i.code = 'DV1'), 'duplicate_unresolved,duplicate_unresolved');
SELECT pg_temp.eq('B: one bell DT1', pg_temp.bells('DT1'), 1::bigint);
SELECT pg_temp.eq('B: one bell DL1', pg_temp.bells('DL1'), 1::bigint);
SELECT pg_temp.eq('B: one bell DV1', pg_temp.bells('DV1'), 1::bigint);
SELECT pg_temp.eq('B: no bell for resolved codes', pg_temp.bells('DP5245') + pg_temp.bells('DE1'), 0::bigint);
SELECT pg_temp.eq('B: bell names the code and the Hub piece',
  (SELECT body LIKE 'DT1 is on more than one Page365 listing%DT1 Ring K18 2.0g Diamond Halo%' FROM public.staff_notifications
    WHERE type = 'page365_duplicate_code' AND metadata->>'code' = 'DT1'), true);
SELECT pg_temp.eq('B: bell lists both listings',
  (SELECT jsonb_array_length(metadata->'listings') FROM public.staff_notifications
    WHERE type = 'page365_duplicate_code' AND metadata->>'code' = 'DT1'), 2);
-- No Hub product: flagged, no note, no bell.
SELECT pg_temp.eq('B: DN1 (no Hub product) flagged without a note',
  (pg_temp.row((SELECT id FROM r WHERE k='B'), 810013)).category || '/' || coalesce((pg_temp.row((SELECT id FROM r WHERE k='B'), 810013)).result_note, '-'),
  'flagged/-');
SELECT pg_temp.eq('B: DN1 no bell', pg_temp.bells('DN1'), 0::bigint);
SELECT pg_temp.eq('B: DN1 never lands', (SELECT count(*) FROM public.website_products WHERE sku = 'DN1'), 0::bigint);
-- "Don't sync with Page365": resolved by name but still never proposed.
SELECT pg_temp.eq('B: DS2 resolved but not_synced', (pg_temp.row((SELECT id FROM r WHERE k='B'), 810009)).category, 'not_synced');
-- Not duplicated: unchanged behaviour (3 -> 1).
SELECT pg_temp.eq('B: PLAIN normal decrease, no note',
  (pg_temp.row((SELECT id FROM r WHERE k='B'), 810015)).category || '/' || coalesce((pg_temp.row((SELECT id FROM r WHERE k='B'), 810015)).result_note, '-'),
  'decrease/-');
-- Hide-follow never sees a resolved or flagged duplicate as Hub-only.
SELECT pg_temp.eq('B: no Hub-only row for duplicated codes',
  (SELECT count(*) FROM public.page365_inventory_items i WHERE i.run_id = (SELECT id FROM r WHERE k='B') AND i.kind = 'hub_only'
     AND i.hub_sku IN ('DP5245','DE1','DT1','DL1','DS2','DV1')), 0::bigint);

-- C. The scheduled closer applies the resolved rows ----------------------------------
SELECT pg_temp.eq('C: auto-apply ran', public.page365_inventory_auto_apply_run((SELECT id FROM r WHERE k='B'))->>'state', 'applied');
SELECT pg_temp.eq('C: DP5245 now 0 (the N5245 bug)', pg_temp.stock('DP5245'), 0);
SELECT pg_temp.eq('C: DE1 now 2', pg_temp.stock('DE1'), 2);
SELECT pg_temp.eq('C: PLAIN now 1', pg_temp.stock('PLAIN'), 1);
SELECT pg_temp.eq('C: DT1 / DL1 / DV1 untouched', pg_temp.stock('DT1') + pg_temp.stock('DL1') + pg_temp.stock('DV1'), 3);
SELECT pg_temp.eq('C: DS2 untouched', pg_temp.stock('DS2'), 1);
SELECT pg_temp.eq('C: DP5245 still published', (pg_temp.prod('DP5245')).status::text, 'active');

-- D. The next read: still unresolved -> no second bell ---------------------------------
INSERT INTO r VALUES ('D', pg_temp.run('schedule', (SELECT j FROM cat)));
SELECT pg_temp.eq('D: ready', (SELECT status FROM public.page365_inventory_runs WHERE id = (SELECT id FROM r WHERE k='D')), 'ready');
SELECT pg_temp.eq('D: still one bell DT1', pg_temp.bells('DT1'), 1::bigint);
SELECT pg_temp.eq('D: still one bell DL1', pg_temp.bells('DL1'), 1::bigint);
SELECT pg_temp.eq('D: DP5245 now no_change at 0', (pg_temp.row((SELECT id FROM r WHERE k='D'), 810001)).category, 'no_change');

-- E. DT1's second listing renamed in Page365 (own code) -> resolved; then back -> rings again.
INSERT INTO r VALUES ('E', pg_temp.run('schedule', (SELECT j FROM cat) - 5
  || jsonb_build_array(pg_temp.p(810006, 'DT9 Ring K18 2.0g Diamond Solitaire', 0))));
SELECT pg_temp.eq('E: DT1 no longer a duplicate -> matched normally',
  (pg_temp.row((SELECT id FROM r WHERE k='E'), 810005)).match_result || '/' || coalesce((pg_temp.row((SELECT id FROM r WHERE k='E'), 810005)).result_note, '-'),
  'matched/-');
INSERT INTO r VALUES ('F', pg_temp.run('schedule', (SELECT j FROM cat)));
SELECT pg_temp.eq('F: DT1 unresolved again -> a new bell', pg_temp.bells('DT1'), 2::bigint);

SELECT 'ALL DUPLICATE-CODE CHECKS PASSED' AS result;
