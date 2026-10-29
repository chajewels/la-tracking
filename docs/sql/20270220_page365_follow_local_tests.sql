-- ============================================================================
-- Page365 follow (code / name / photos) + Catalog delete (2026-10-29) — LOCAL
-- behaviour tests. Local Postgres only. Sequence: see
-- docs/sql/20270220_page365_follow_local_stub.sql (stub, seed, migration twice,
-- then this file). Every check RAISEs on failure; the last line prints
-- ALL PAGE365-FOLLOW CHECKS PASSED.
--
-- Covers plan §5: re-code (stranded N1073 -> N9140 shape), blocked re-code and
-- its single bell, slug of a never-published vs an ever-published product,
-- first_published_at (trigger + backfill), name follow (never completed vs
-- completed, one bell), photo order / removal / empty list / staff photos,
-- price never copied, delete (hub_only rows, live claims, normal linked
-- product, the index), reviews restored BOTH ways on re-land, a switched-off
-- product and a partial read untouched, the link backfill and the one-time
-- name pass.
--
-- 2026-10-29, fix/page365-follow-simultaneous-code-name (migration
-- 20270221100000_page365_follow_recode_name.sql, applied after 20270220100000
-- in the sequence): §0b a listing re-coded + renamed on Page365 BEFORE the
-- follow release (the live N1073 -> N9140 shape, seeded from history) is
-- renamed AND its name followed by the first read after the release (never
-- completed), or renamed + kept + ONE bell (completed); §4c the regression
-- matrix — code-only, name-only, simultaneous, staff-completed + simultaneous,
-- duplicate-code conflict + simultaneous — and the repair of a product a read
-- between the two releases already left with the hybrid "new code + old
-- words" name. On a database with only 20270220100000 applied, §0b FAILS at
-- "0b: ... AND the new Page365 name followed" — that is the bug.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.prod(p_sku text) RETURNS public.website_products LANGUAGE sql AS $$
  SELECT * FROM public.website_products WHERE sku = p_sku ORDER BY created_at LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.byp(p_pid bigint) RETURNS public.website_products LANGUAGE sql AS $$
  SELECT * FROM public.website_products WHERE page365_product_id = p_pid ORDER BY created_at LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_pid bigint) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id = p_run AND page365_product_id = p_pid LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.bells(p_type text, p_pid uuid DEFAULT NULL) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.staff_notifications WHERE type = p_type
     AND (p_pid IS NULL OR metadata->>'website_product_id' = p_pid::text) $$;
CREATE OR REPLACE FUNCTION pg_temp.fails(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
-- A cash order to hang item lines on (the stub keeps the live FK to cash_orders).
CREATE OR REPLACE FUNCTION pg_temp.co() RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.cash_orders(invoice_number, customer_id) VALUES ('T' || substr(gen_random_uuid()::text, 1, 8), gen_random_uuid()) RETURNING id $$;
-- A one-variant listing: code = first word of the name.
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer DEFAULT 1, photos jsonb DEFAULT '[]'::jsonb,
                                     price integer DEFAULT 50000) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name,
    'detail', jsonb_build_object('name', name, 'price_jpy', price, 'full_price_jpy', NULL, 'photos', photos,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', split_part(name, ' ', 1),
        'price_jpy', price, 'full_price_jpy', NULL, 'available', avail)))) $$;
CREATE OR REPLACE FUNCTION pg_temp.ph(VARIADIC ids bigint[]) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'version', '1', 'url', 'https://assets.page365.net/p/' || id || '.jpg',
                                               'position', ord - 1) ORDER BY ord), '[]'::jsonb)
    FROM unnest(ids) WITH ORDINALITY AS t(id, ord) $$;
CREATE OR REPLACE FUNCTION pg_temp.run(p_list jsonb, p_fail bigint[] DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  -- Each read stands alone here (a read that lists < 80 % of the previous one is 'partial' by design).
  DELETE FROM public.page365_inventory_runs;
  UPDATE public.page365_product_presence
     SET first_seen_at = first_seen_at - interval '31 minutes', last_seen_at = last_seen_at - interval '31 minutes';
  INSERT INTO public.page365_inventory_runs(source, kind, page365_count, products_total)
  VALUES ('manual', 'full', jsonb_array_length(p_list), jsonb_array_length(p_list)) RETURNING id INTO v_run;
  INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name)
  SELECT v_run, (x->>'pid')::bigint, x->>'list_name' FROM jsonb_array_elements(p_list) x;
  LOOP
    FOR r IN SELECT * FROM public.page365_inventory_claim(v_run, 100) LOOP
      SELECT x INTO d FROM jsonb_array_elements(p_list) x WHERE (x->>'pid')::bigint = r.o_page365_product_id;
      IF r.o_page365_product_id = ANY (p_fail) THEN PERFORM public.page365_inventory_store_product(r.o_id, NULL, 'HTTP 500');
      ELSE PERFORM public.page365_inventory_store_product(r.o_id, d->'detail', NULL); END IF;
    END LOOP;
    EXIT WHEN (public.page365_inventory_finish(v_run)->>'ok')::boolean;
  END LOOP;
  PERFORM pg_sleep(0.01);
  RETURN v_run;
END $$;

-- The publish guard (origin + category) is the Catalog's business, not this file's: tests insert published rows directly.
ALTER TABLE public.website_products DISABLE TRIGGER trg_page365_draft_publish_guard;

-- 0. What the migration did to the seed -------------------------------------------------
SELECT pg_temp.eq('0: the three backfill candidates are linked',
  (SELECT array_agg(sku ORDER BY sku) FROM public.website_products WHERE page365_product_id IS NOT NULL AND sku IN ('N1616','R7828','R3341')),
  ARRAY['N1616','R3341','R7828']);
SELECT pg_temp.eq('0: 8C100 (not in Page365) never linked', (pg_temp.prod('8C100')).page365_product_id, NULL::bigint);
SELECT pg_temp.eq('0: N4020 (website sample, switched off) never linked', (pg_temp.prod('N4020')).page365_product_id, NULL::bigint);
SELECT pg_temp.eq('0: one-time pass UPDATED the never-completed name', (pg_temp.prod('SA100')).name, 'SA100 Ring Diamond [Preloved]');
SELECT pg_temp.eq('0: ... and cleared its name_ja, ja_pending set',
  ((pg_temp.prod('SA100')).name_ja IS NULL AND (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = (pg_temp.prod('SA100')).id)), true);
SELECT pg_temp.eq('0: one-time pass KEPT the staff-completed name', (pg_temp.prod('SB200')).name, 'SB200 Necklace Blue Topaz 1.2ct');
SELECT pg_temp.eq('0: ... an identical name untouched', (pg_temp.prod('SC300')).name, 'SC300 Bracelet Pearl 18cm');
SELECT pg_temp.eq('0: ONE summary bell, no per-product bell', pg_temp.bells('page365_names_followed_summary'), 1::bigint);
SELECT pg_temp.eq('0: no name_changed bell from the pass', pg_temp.bells('page365_name_changed'), 0::bigint);
SELECT pg_temp.eq('0: seen_names of SA100 holds both Page365 texts',
  (SELECT cardinality(seen_names) FROM public.page365_listing_names WHERE website_product_id = (pg_temp.prod('SA100')).id), 2);
SELECT pg_temp.eq('0: seed active products are stamped first_published', (pg_temp.prod('SC300')).first_published_at IS NOT NULL, true);

-- 0b. Re-coded + renamed on Page365 BEFORE the follow release (the live N1073 -> N9140 shape) ------------------
-- The migration seeded the memory from the FULL history: the NEW Page365 text is already "last seen",
-- the Hub name is still the OLD text, and the one-time pass skipped both (unmatched before step a3 existed).
SELECT pg_temp.eq('0b: history seed - last_p365_name is already the NEW Page365 text',
  (SELECT last_p365_name FROM public.page365_listing_names WHERE website_product_id = (pg_temp.prod('SD400')).id),
  'SD9140 Necklace Tiffany 3.30g Paloma [Preloved]');
SELECT pg_temp.eq('0b: ... seen_names holds the old and the new text',
  (SELECT cardinality(seen_names) FROM public.page365_listing_names WHERE website_product_id = (pg_temp.prod('SD400')).id), 2);
SELECT pg_temp.eq('0b: ... the one-time pass could not touch an unmatched listing: Hub still SD400 / old text',
  (pg_temp.prod('SD400')).sku || '|' || (pg_temp.prod('SD400')).name, 'SD400|SD400 Necklace Tiffany 3.50g');
SELECT pg_temp.eq('0b: ... same for the completed one', (pg_temp.prod('SE500')).sku || '|' || (pg_temp.prod('SE500')).name, 'SE500|SE500 Ring Blue Topaz 1.2ct');
SELECT pg_temp.eq('0b: ... no name bell yet', pg_temp.bells('page365_name_changed'), 0::bigint);
-- The first complete read after the release (every seed listing, so nothing is "missing").
CREATE OR REPLACE FUNCTION pg_temp.seed_read() RETURNS uuid LANGUAGE sql AS $$
  SELECT pg_temp.run(jsonb_build_array(
    pg_temp.p(811001, 'N1616 Necklace K18 Diamond Pave'), pg_temp.p(811002, 'R7828 Ring PT900 Sapphire Halo'),
    pg_temp.p(811003, 'R3341 Ring K18 Ruby Solitaire'), pg_temp.p(811004, 'N4020 Website sample necklace'),
    pg_temp.p(811005, 'SA100 Ring Diamond [Preloved]'), pg_temp.p(811006, 'SB200 Necklace B.T 1.2ct'),
    pg_temp.p(811007, 'SC300 Bracelet Pearl 18cm'),
    pg_temp.p(811008, 'SD9140 Necklace Tiffany 3.30g Paloma [Preloved]', 1), pg_temp.p(811009, 'SE9500 Ring B.T 1.2ct [Preloved]'))) $$;
CREATE TEMP TABLE r0b AS SELECT pg_temp.seed_read() AS id;
SELECT pg_temp.eq('0b: SIMULTANEOUS code + name, never completed: renamed to the new code', (pg_temp.byp(811008)).sku, 'SD9140');
SELECT pg_temp.eq('0b: ... AND the new Page365 name followed (not the old words behind the new code)',
  (pg_temp.byp(811008)).name, 'SD9140 Necklace Tiffany 3.30g Paloma [Preloved]');
SELECT pg_temp.eq('0b: ... ja_pending set (name_ja was NULL already)',
  (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = (pg_temp.byp(811008)).id), true);
SELECT pg_temp.eq('0b: ... never public -> slug from the new code + new name', (pg_temp.byp(811008)).slug, 'sd9140-necklace-tiffany-3-30g-paloma-preloved');
SELECT pg_temp.eq('0b: ... still ONE product for the listing', (SELECT count(*) FROM public.website_products WHERE page365_product_id = 811008), 1::bigint);
SELECT pg_temp.eq('0b: ... matched / code_followed, stock proposal = Page365 available (1)',
  (SELECT match_result || '/' || coalesce(result_note, '-') || '/' || proposed_stock FROM public.page365_inventory_items
    WHERE run_id = (SELECT id FROM r0b) AND page365_product_id = 811008), 'matched/code_followed/1');
SELECT pg_temp.eq('0b: ... still a draft (never auto-published), stock untouched by finish',
  (SELECT wp.status::text || '/' || v.stock_qty FROM public.website_products wp JOIN public.website_product_variants v ON v.product_id = wp.id
    WHERE wp.page365_product_id = 811008), 'draft/0');
SELECT pg_temp.eq('0b: ... audited: code followed, then name followed (recoded)',
  (SELECT string_agg(action, ',' ORDER BY action) FROM public.audit_logs WHERE entity_id = (pg_temp.byp(811008)).id
    AND action IN ('page365_code_followed', 'page365_name_followed')), 'page365_code_followed,page365_name_followed');
SELECT pg_temp.eq('0b: SIMULTANEOUS, staff-completed: renamed to the new code', (pg_temp.byp(811009)).sku, 'SE9500');
SELECT pg_temp.eq('0b: ... the completed name is KEPT (code word swapped only)', (pg_temp.byp(811009)).name, 'SE9500 Ring Blue Topaz 1.2ct');
SELECT pg_temp.eq('0b: ... name_ja kept, code word swapped', (pg_temp.byp(811009)).name_ja, 'SE9500 リング ブルートパーズ');
SELECT pg_temp.eq('0b: ... ONE bell naming the PREVIOUS Page365 text, not the new one twice',
  (SELECT metadata->>'page365_old' || ' -> ' || (metadata->>'page365_new') FROM public.staff_notifications
    WHERE type = 'page365_name_changed' AND metadata->>'website_product_id' = (pg_temp.byp(811009)).id::text),
  'SE500 Ring B.T 1.2ct -> SE9500 Ring B.T 1.2ct [Preloved]');
SELECT pg_temp.eq('0b: ... the never-completed one rang nothing', pg_temp.bells('page365_name_changed', (pg_temp.byp(811008)).id), 0::bigint);
SELECT pg_temp.eq('0b: ... no recode_blocked bell (no other product owns the codes)', pg_temp.bells('page365_recode_blocked'), 0::bigint);
SELECT pg_temp.seed_read();
SELECT pg_temp.eq('0b: a second read changes nothing',
  (pg_temp.byp(811008)).name || '|' || (pg_temp.byp(811009)).name, 'SD9140 Necklace Tiffany 3.30g Paloma [Preloved]|SE9500 Ring Blue Topaz 1.2ct');
SELECT pg_temp.eq('0b: ... and rings nothing again', pg_temp.bells('page365_name_changed'), 1::bigint);
SELECT pg_temp.eq('0b: ... one code_followed audit row each (idempotent)',
  (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_code_followed'), 2::bigint);
-- (d) the index
SELECT pg_temp.eq('(d) index exists and is partial',
  (SELECT indexdef LIKE '%(website_product_id)%WHERE (website_product_id IS NOT NULL)%' FROM pg_indexes
    WHERE indexname = 'idx_page365_inventory_items_product'), true);
CREATE OR REPLACE FUNCTION pg_temp.plan_uses_index() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j json;
BEGIN
  SET LOCAL enable_seqscan = off;
  EXECUTE 'EXPLAIN (FORMAT JSON) SELECT 1 FROM public.page365_inventory_items WHERE website_product_id = ''00000000-0000-0000-0000-000000000001''' INTO j;
  RETURN j::text LIKE '%idx_page365_inventory_items_product%';
END $$;
SELECT pg_temp.eq('(d) the SET NULL lookup by website_product_id uses it', pg_temp.plan_uses_index(), true);

-- Only this file's products and runs from here.
DELETE FROM public.staff_notifications; DELETE FROM public.audit_logs;
UPDATE public.website_products SET status = 'archived';

-- 1. first_published_at: trigger + backfill ------------------------------------------------
INSERT INTO public.website_products(sku, name, status, origin, metals) VALUES
  ('FP1', 'FP1 Ring draft', 'draft', 'JAPAN', ARRAY['K18']);
SELECT pg_temp.eq('1: a new draft is NOT stamped', (pg_temp.prod('FP1')).first_published_at, NULL::timestamptz);
UPDATE public.website_products SET status = 'active' WHERE sku = 'FP1';
SELECT pg_temp.eq('1: the first time it is active it is stamped', (pg_temp.prod('FP1')).first_published_at IS NOT NULL, true);
CREATE TEMP TABLE fp AS SELECT first_published_at AS t FROM public.website_products WHERE sku = 'FP1';
UPDATE public.website_products SET status = 'draft' WHERE sku = 'FP1';
SELECT pg_temp.eq('1: hiding it never clears the stamp', (pg_temp.prod('FP1')).first_published_at, (SELECT t FROM fp));
UPDATE public.website_products SET first_published_at = NULL WHERE sku = 'FP1';
SELECT pg_temp.eq('1: ... nor can an UPDATE set it back to NULL', (pg_temp.prod('FP1')).first_published_at, (SELECT t FROM fp));
-- backfill (re-running the migration is the way to run its UPDATE again)
ALTER TABLE public.website_products DISABLE TRIGGER trg_website_products_first_published;
INSERT INTO public.website_products(sku, name, status, origin, metals) VALUES
  ('FPA', 'FPA Ring active, never stamped', 'active', 'JAPAN', ARRAY['K18']),
  ('FPB', 'FPB Ring draft with an order line', 'draft', 'JAPAN', ARRAY['K18']),
  ('FPC', 'FPC Ring draft hidden by hide-follow', 'draft', 'JAPAN', ARRAY['K18']),
  ('FPD', 'FPD Ring plain draft', 'draft', 'JAPAN', ARRAY['K18']);
ALTER TABLE public.website_products ENABLE TRIGGER trg_website_products_first_published;
INSERT INTO public.cash_order_items(cash_order_id, website_product_id, quantity, code, name, unit_price)
VALUES (pg_temp.co(), (pg_temp.prod('FPB')).id, 1, 'FPB', 'FPB Ring', 1000);
INSERT INTO public.audit_logs(entity_type, entity_id, action, new_value_json)
VALUES ('website_product', (pg_temp.prod('FPC')).id, 'page365_inventory_hidden', '{}'::jsonb);
\i supabase/migrations/20270220100000_page365_follow_and_catalog_delete.sql
-- A re-run of 20270220100000 CREATE OR REPLACEs page365_follow_names back to its own body: the fix
-- migration must always follow it (the documented sequence) — re-apply it here as live would.
\i supabase/migrations/20270221100000_page365_follow_recode_name.sql
SELECT pg_temp.eq('1: backfill - active, never stamped -> stamped', (pg_temp.prod('FPA')).first_published_at IS NOT NULL, true);
SELECT pg_temp.eq('1: backfill - draft with an order line -> stamped', (pg_temp.prod('FPB')).first_published_at IS NOT NULL, true);
SELECT pg_temp.eq('1: backfill - hidden by hide-follow -> stamped', (pg_temp.prod('FPC')).first_published_at IS NOT NULL, true);
SELECT pg_temp.eq('1: backfill - a plain draft stays NULL (never public)', (pg_temp.prod('FPD')).first_published_at, NULL::timestamptz);
DELETE FROM public.cash_order_items WHERE code = 'FPB'; DELETE FROM public.staff_notifications; DELETE FROM public.audit_logs;
UPDATE public.website_products SET status = 'archived';

-- 2. RE-CODE (the stranded N1073 -> N9140 shape) ---------------------------------------------
-- Never published (draft, stamp NULL), linked to listing 820001, stock 0.
INSERT INTO public.website_products(sku, slug, name, status, origin, metals, page365_product_id, page365_variant_id) VALUES
  ('RC1001', 'rc1001-necklace-tiffany-3-50g', 'RC1001 Necklace Tiffany 3.50g', 'draft', 'UNKNOWN', ARRAY['K18'], 820001, 8200010),
  -- Published once: slug must never move
  ('RC2001', 'rc2001-ring-old', 'RC2001 Ring Old', 'active', 'JAPAN', ARRAY['K18'], 820002, 8200020),
  -- Blocked: another Hub product already owns the new code
  ('RC3001', 'rc3001-ring', 'RC3001 Ring X', 'active', 'JAPAN', ARRAY['K18'], 820003, 8200030),
  ('RC3002', 'rc3002-other', 'RC3002 Ring Other', 'active', 'JAPAN', ARRAY['K18'], NULL, NULL),
  -- Switched off
  ('RD1001', 'rd1001-ring', 'RD1001 Ring Off', 'active', 'JAPAN', ARRAY['K18'], 820005, 8200050);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'RD1001';
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, CASE sku WHEN 'RC1001' THEN 0 ELSE 1 END, 50000 FROM public.website_products WHERE sku LIKE 'RC%' OR sku = 'RD1001';
-- the Page365 name each was last seen under (what the migration seeds from history)
INSERT INTO public.page365_listing_names(website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names)
SELECT id, page365_product_id, page365_variant_id, name, ARRAY[name] FROM public.website_products WHERE page365_product_id IN (820001, 820002, 820003, 820005);

CREATE TEMP TABLE r2 AS SELECT pg_temp.run(jsonb_build_array(
  pg_temp.p(820001, 'RC9140 Necklace Tiffany 3.30g Paloma [Preloved]', 1),
  pg_temp.p(820002, 'RC2002 Ring Newer', 1),
  pg_temp.p(820003, 'RC3002 Ring Other', 1),
  pg_temp.p(820005, 'RD9001 Ring Off Renamed', 1))) AS id;
SELECT pg_temp.eq('2: stranded product renamed to the new code', (pg_temp.byp(820001)).sku, 'RC9140');
SELECT pg_temp.eq('2: ... name code swapped, then the never-completed name followed Page365',
  (pg_temp.byp(820001)).name, 'RC9140 Necklace Tiffany 3.30g Paloma [Preloved]');
SELECT pg_temp.eq('2: ... still ONE product for that listing, not landed a second time',
  (SELECT count(*) FROM public.website_products WHERE page365_product_id = 820001), 1::bigint);
SELECT pg_temp.eq('2: ... matched (no already_landed), proposal made',
  (SELECT match_result||'/'||coalesce(result_note,'-') FROM public.page365_inventory_items WHERE run_id = (SELECT id FROM r2) AND page365_product_id = 820001),
  'matched/code_followed');
SELECT pg_temp.eq('2: ... stock proposal is Page365 available (1)',
  (pg_temp.item((SELECT id FROM r2), 820001)).proposed_stock, 1);
SELECT pg_temp.eq('2: never published -> slug regenerated from new code + name',
  (pg_temp.byp(820001)).slug, 'rc9140-necklace-tiffany-3-30g-paloma-preloved');
SELECT pg_temp.eq('2: audit row for the code', (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_code_followed'
  AND entity_id = (pg_temp.byp(820001)).id), 1::bigint);
SELECT pg_temp.eq('2: published once -> sku follows, slug UNCHANGED', (pg_temp.byp(820002)).sku || ' ' || (pg_temp.byp(820002)).slug, 'RC2002 rc2001-ring-old');
SELECT pg_temp.eq('2: blocked: other piece owns the code -> nothing renamed', (pg_temp.byp(820003)).sku, 'RC3001');
SELECT pg_temp.eq('2: blocked: ONE bell', pg_temp.bells('page365_recode_blocked', (pg_temp.byp(820003)).id), 1::bigint);
SELECT pg_temp.eq('2: blocked: item says why', (pg_temp.item((SELECT id FROM r2), 820003)).result_note, 'code_exists_other_piece');
SELECT pg_temp.eq('2: switched-off product: no rename, no name change',
  (pg_temp.byp(820005)).sku || '|' || (pg_temp.byp(820005)).name, 'RD1001|RD1001 Ring Off');
-- second read: nothing rings again
SELECT pg_temp.run(jsonb_build_array(
  pg_temp.p(820001, 'RC9140 Necklace Tiffany 3.30g Paloma [Preloved]', 1), pg_temp.p(820002, 'RC2002 Ring Newer', 1),
  pg_temp.p(820003, 'RC3002 Ring Other', 1), pg_temp.p(820005, 'RD9001 Ring Off Renamed', 1)));
SELECT pg_temp.eq('2: blocked bell does not ring again on the next read', pg_temp.bells('page365_recode_blocked'), 1::bigint);
SELECT pg_temp.eq('2: re-code is idempotent (one audit row)', (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_code_followed'
  AND entity_id = (pg_temp.byp(820001)).id), 1::bigint);

-- 3. A partial read changes nothing ---------------------------------------------------------
INSERT INTO public.website_products(sku, slug, name, status, origin, metals, page365_product_id, page365_variant_id)
VALUES ('PR1001', 'pr1001-ring', 'PR1001 Ring Plain', 'active', 'JAPAN', ARRAY['K18'], 820006, 8200060);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku = 'PR1001';
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(820006, 'PR2002 Ring Plain', 1), pg_temp.p(820007, 'ZZ0001 Other', 1)), ARRAY[820007::bigint]);
SELECT pg_temp.eq('3: partial read: no re-code', (pg_temp.byp(820006)).sku, 'PR1001');
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(820006, 'PR2002 Ring Plain', 1)));
SELECT pg_temp.eq('3: the next complete read follows it', (pg_temp.byp(820006)).sku, 'PR2002');

-- 4. NAME follow ----------------------------------------------------------------------------
INSERT INTO public.website_products(sku, slug, name, name_ja, status, origin, metals, page365_product_id, page365_variant_id) VALUES
  ('RN1', 'rn1-ring', 'RN1 Ring Diamond [Used]', 'RN1 リング', 'active', 'JAPAN', ARRAY['K18'], 830101, 8301010),
  ('RN2', 'rn2-ring', 'RN2 Ring Blue Topaz 1.0ct', 'RN2 リング', 'active', 'JAPAN', ARRAY['K18'], 830102, 8301020);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku IN ('RN1','RN2');
INSERT INTO public.page365_listing_names(website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names) VALUES
  ((pg_temp.prod('RN1')).id, 830101, 8301010, 'RN1 Ring Diamond [Used]', ARRAY['RN1 Ring Diamond [Used]']),
  ((pg_temp.prod('RN2')).id, 830102, 8301020, 'RN2 Ring B.T 1.0ct', ARRAY['RN2 Ring B.T 1.0ct']);
DELETE FROM public.staff_notifications;
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(830101, 'RN1 Ring Diamond [Preloved]', 1), pg_temp.p(830102, 'RN2 Ring B.T 1.0ct [Preloved]', 1)));
SELECT pg_temp.eq('4: never completed -> Page365''s new name copied', (pg_temp.prod('RN1')).name, 'RN1 Ring Diamond [Preloved]');
SELECT pg_temp.eq('4: ... name_ja cleared, ja_pending set',
  ((pg_temp.prod('RN1')).name_ja IS NULL AND (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = (pg_temp.prod('RN1')).id)), true);
SELECT pg_temp.eq('4: ... never public? it was active -> slug unchanged', (pg_temp.prod('RN1')).slug, 'rn1-ring');
SELECT pg_temp.eq('4: completed name is NEVER cut back', (pg_temp.prod('RN2')).name, 'RN2 Ring Blue Topaz 1.0ct');
SELECT pg_temp.eq('4: ... and its name_ja is kept', (pg_temp.prod('RN2')).name_ja, 'RN2 リング');
SELECT pg_temp.eq('4: ... ONE bell, with Page365 old -> new',
  (SELECT metadata->>'page365_old' || ' -> ' || (metadata->>'page365_new') FROM public.staff_notifications WHERE type = 'page365_name_changed'),
  'RN2 Ring B.T 1.0ct -> RN2 Ring B.T 1.0ct [Preloved]');
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(830101, 'RN1 Ring Diamond [Preloved]', 1), pg_temp.p(830102, 'RN2 Ring B.T 1.0ct [Preloved]', 1)));
SELECT pg_temp.eq('4: the same difference never rings twice', pg_temp.bells('page365_name_changed'), 1::bigint);
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(830101, 'RN1 Ring Diamond [Used]', 1), pg_temp.p(830102, 'RN2 Ring B.T 1.0ct [Preloved]', 1)));
SELECT pg_temp.eq('4: a flip BACK on Page365 (text seen before) is followed too', (pg_temp.prod('RN1')).name, 'RN1 Ring Diamond [Used]');

-- 4b. Japanese names: the fetch tick reads and writes through two RPCs
CREATE OR REPLACE FUNCTION pg_temp.rn1_pending() RETURNS boolean LANGUAGE sql AS $$
  SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = (pg_temp.prod('RN1')).id $$;
SELECT pg_temp.eq('4b: the followed name is listed as pending a Japanese name',
  (SELECT bool_or(o_name = 'RN1 Ring Diamond [Used]') FROM public.page365_pending_ja_names(20)), true);
SELECT pg_temp.eq('4b: the limit is honoured', (SELECT count(*) FROM public.page365_pending_ja_names(1)), 1::bigint);
SELECT pg_temp.eq('4b: a stale English name is not overwritten (stays pending)',
  public.page365_set_name_ja((pg_temp.prod('RN1')).id, 'RN1 Ring Diamond [Preloved]', 'リング'), false);
SELECT pg_temp.eq('4b: ... still pending, name_ja untouched', pg_temp.rn1_pending() AND (pg_temp.prod('RN1')).name_ja IS NULL, true);
SELECT pg_temp.eq('4b: the current name is written and ja_pending cleared',
  public.page365_set_name_ja((pg_temp.prod('RN1')).id, 'RN1 Ring Diamond [Used]', 'RN1 リング ダイヤ'), true);
SELECT pg_temp.eq('4b: ... name_ja set, no longer pending', (pg_temp.prod('RN1')).name_ja || '|' || pg_temp.rn1_pending()::text, 'RN1 リング ダイヤ|false');
SELECT pg_temp.eq('4b: authenticated cannot call them',
  has_function_privilege('authenticated', 'public.page365_set_name_ja(uuid,text,text)', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.page365_pending_ja_names(integer)', 'EXECUTE'), false);

-- 4c. REGRESSION MATRIX — code-only, name-only, simultaneous, completed + simultaneous, blocked + simultaneous ----
-- Steady state after the release: the memory holds the PREVIOUS Page365 text (what a follow leaves behind).
INSERT INTO public.website_products(sku, slug, name, name_ja, status, origin, metals, page365_product_id, page365_variant_id) VALUES
  ('RG1', 'rg1-ring', 'RG1 Ring Plain', 'RG1 リング', 'active', 'JAPAN', ARRAY['K18'], 870001, 8700010),
  ('RG2', 'rg2-ring', 'RG2 Ring Plain', 'RG2 リング', 'active', 'JAPAN', ARRAY['K18'], 870002, 8700020),
  ('RG3', 'rg3-ring', 'RG3 Ring Plain', 'RG3 リング', 'active', 'JAPAN', ARRAY['K18'], 870003, 8700030),
  ('RG4', 'rg4-ring', 'RG4 Ring Blue Topaz', 'RG4 リング', 'active', 'JAPAN', ARRAY['K18'], 870004, 8700040),
  ('RG5', 'rg5-ring', 'RG5 Ring Plain', 'RG5 リング', 'active', 'JAPAN', ARRAY['K18'], 870005, 8700050),
  ('RG9005', 'rg9005-other', 'RG9005 Ring Other', NULL, 'active', 'JAPAN', ARRAY['K18'], NULL, NULL);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku LIKE 'RG%';
INSERT INTO public.page365_listing_names(website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names) VALUES
  ((pg_temp.prod('RG1')).id, 870001, 8700010, 'RG1 Ring Plain', ARRAY['RG1 Ring Plain']),
  ((pg_temp.prod('RG2')).id, 870002, 8700020, 'RG2 Ring Plain', ARRAY['RG2 Ring Plain']),
  ((pg_temp.prod('RG3')).id, 870003, 8700030, 'RG3 Ring Plain', ARRAY['RG3 Ring Plain']),
  ((pg_temp.prod('RG4')).id, 870004, 8700040, 'RG4 Ring B.T', ARRAY['RG4 Ring B.T']),
  ((pg_temp.prod('RG5')).id, 870005, 8700050, 'RG5 Ring Plain', ARRAY['RG5 Ring Plain']);
DELETE FROM public.staff_notifications; DELETE FROM public.audit_logs;
CREATE OR REPLACE FUNCTION pg_temp.rg_read() RETURNS uuid LANGUAGE sql AS $$
  SELECT pg_temp.run(jsonb_build_array(
    pg_temp.p(870001, 'RG9001 Ring Plain', 1),                 -- code-only
    pg_temp.p(870002, 'RG2 Ring Plain [Preloved]', 1),         -- name-only
    pg_temp.p(870003, 'RG9003 Ring Plain [Preloved]', 1),      -- simultaneous, never completed
    pg_temp.p(870004, 'RG9004 Ring B.T [Preloved]', 1),        -- simultaneous, staff completed
    pg_temp.p(870005, 'RG9005 Ring Plain [Preloved]', 1))) $$; -- simultaneous, new code owned by another Hub product
CREATE TEMP TABLE r4c AS SELECT pg_temp.rg_read() AS id;
CREATE OR REPLACE FUNCTION pg_temp.ln(p_pid bigint) RETURNS public.page365_listing_names LANGUAGE sql AS $$
  SELECT * FROM public.page365_listing_names WHERE page365_product_id = p_pid $$;
-- code-only
SELECT pg_temp.eq('4c code-only: sku and name code word follow, rest kept', (pg_temp.byp(870001)).sku || '|' || (pg_temp.byp(870001)).name, 'RG9001|RG9001 Ring Plain');
SELECT pg_temp.eq('4c code-only: name_ja code word swapped, kept', (pg_temp.byp(870001)).name_ja, 'RG9001 リング');
SELECT pg_temp.eq('4c code-only: no bell, not ja_pending, memory moved to the new text',
  pg_temp.bells('page365_name_changed', (pg_temp.byp(870001)).id)::text || '|' || (pg_temp.ln(870001)).ja_pending::text || '|' || (pg_temp.ln(870001)).last_p365_name,
  '0|false|RG9001 Ring Plain');
SELECT pg_temp.eq('4c code-only: public once -> slug unchanged', (pg_temp.byp(870001)).slug, 'rg1-ring');
-- name-only
SELECT pg_temp.eq('4c name-only: sku unchanged, name followed', (pg_temp.byp(870002)).sku || '|' || (pg_temp.byp(870002)).name, 'RG2|RG2 Ring Plain [Preloved]');
SELECT pg_temp.eq('4c name-only: name_ja cleared, ja_pending', ((pg_temp.byp(870002)).name_ja IS NULL)::text || '|' || (pg_temp.ln(870002)).ja_pending::text, 'true|true');
SELECT pg_temp.eq('4c name-only: no code audit, one name audit',
  (SELECT string_agg(action, ',' ORDER BY action) FROM public.audit_logs WHERE entity_id = (pg_temp.byp(870002)).id AND action LIKE 'page365_%followed'), 'page365_name_followed');
-- simultaneous, never completed
SELECT pg_temp.eq('4c simultaneous: sku follows AND the whole new name follows', (pg_temp.byp(870003)).sku || '|' || (pg_temp.byp(870003)).name, 'RG9003|RG9003 Ring Plain [Preloved]');
SELECT pg_temp.eq('4c simultaneous: name_ja cleared, ja_pending, no bell',
  ((pg_temp.byp(870003)).name_ja IS NULL)::text || '|' || (pg_temp.ln(870003)).ja_pending::text || '|' || pg_temp.bells('page365_name_changed', (pg_temp.byp(870003)).id),
  'true|true|0');
SELECT pg_temp.eq('4c simultaneous: item matched / code_followed', (pg_temp.item((SELECT id FROM r4c), 870003)).match_result || '/' || (pg_temp.item((SELECT id FROM r4c), 870003)).result_note, 'matched/code_followed');
SELECT pg_temp.eq('4c simultaneous: the name audit says it was a re-code read',
  (SELECT new_value_json->>'recoded' FROM public.audit_logs WHERE entity_id = (pg_temp.byp(870003)).id AND action = 'page365_name_followed'), 'true');
-- simultaneous, staff completed
SELECT pg_temp.eq('4c completed + simultaneous: sku follows, completed name KEPT (code word swapped)',
  (pg_temp.byp(870004)).sku || '|' || (pg_temp.byp(870004)).name, 'RG9004|RG9004 Ring Blue Topaz');
SELECT pg_temp.eq('4c completed + simultaneous: name_ja kept (code word swapped), not ja_pending',
  (pg_temp.byp(870004)).name_ja || '|' || (pg_temp.ln(870004)).ja_pending::text, 'RG9004 リング|false');
SELECT pg_temp.eq('4c completed + simultaneous: ONE bell, Page365 old -> new',
  (SELECT metadata->>'page365_old' || ' -> ' || (metadata->>'page365_new') || ' | hub ' || (metadata->>'hub_name') FROM public.staff_notifications
    WHERE type = 'page365_name_changed' AND metadata->>'website_product_id' = (pg_temp.byp(870004)).id::text),
  'RG4 Ring B.T -> RG9004 Ring B.T [Preloved] | hub RG9004 Ring Blue Topaz');
-- simultaneous, new code owned by another Hub product (duplicate-code protection)
SELECT pg_temp.eq('4c blocked + simultaneous: the linked product is NOT renamed (sku, name, name_ja)',
  (pg_temp.byp(870005)).sku || '|' || (pg_temp.byp(870005)).name || '|' || (pg_temp.byp(870005)).name_ja, 'RG5|RG5 Ring Plain|RG5 リング');
SELECT pg_temp.eq('4c blocked + simultaneous: the other Hub product is NOT touched either', (pg_temp.prod('RG9005')).name, 'RG9005 Ring Other');
SELECT pg_temp.eq('4c blocked + simultaneous: ONE recode_blocked bell, no name bell for either',
  pg_temp.bells('page365_recode_blocked', (pg_temp.byp(870005)).id)::text || '|' || pg_temp.bells('page365_name_changed', (pg_temp.byp(870005)).id)
    || '|' || pg_temp.bells('page365_name_changed', (pg_temp.prod('RG9005')).id), '1|0|0');
SELECT pg_temp.eq('4c blocked + simultaneous: the item says why', (pg_temp.item((SELECT id FROM r4c), 870005)).result_note, 'code_exists_other_piece');
SELECT pg_temp.eq('4c blocked + simultaneous: the linked product''s memory is untouched', (pg_temp.ln(870005)).last_p365_name || '|' || cardinality((pg_temp.ln(870005)).seen_names), 'RG5 Ring Plain|1');
-- a second identical read: stable, silent
SELECT pg_temp.rg_read();
SELECT pg_temp.eq('4c second read: names stable',
  (pg_temp.byp(870001)).name || '|' || (pg_temp.byp(870002)).name || '|' || (pg_temp.byp(870003)).name || '|' || (pg_temp.byp(870004)).name || '|' || (pg_temp.byp(870005)).name,
  'RG9001 Ring Plain|RG2 Ring Plain [Preloved]|RG9003 Ring Plain [Preloved]|RG9004 Ring Blue Topaz|RG5 Ring Plain');
SELECT pg_temp.eq('4c second read: no bell rings twice', pg_temp.bells('page365_name_changed')::text || '|' || pg_temp.bells('page365_recode_blocked'), '1|1');
SELECT pg_temp.eq('4c second read: audits not repeated',
  (SELECT count(*) FROM public.audit_logs WHERE action IN ('page365_code_followed', 'page365_name_followed')), 5::bigint);
-- a THIRD read where Page365 changes the name AGAIN (no code change): the ordinary rule still applies after a re-code
SELECT pg_temp.run(jsonb_build_array(
  pg_temp.p(870001, 'RG9001 Ring Plain', 1), pg_temp.p(870002, 'RG2 Ring Plain [Preloved]', 1),
  pg_temp.p(870003, 'RG9003 Ring Plain [Preloved] Resized', 1), pg_temp.p(870004, 'RG9004 Ring B.T [Preloved] Resized', 1),
  pg_temp.p(870005, 'RG9005 Ring Plain [Preloved]', 1)));
SELECT pg_temp.eq('4c later name-only change after a re-code: followed (never completed) / kept + second distinct bell (completed)',
  (pg_temp.byp(870003)).name || '|' || (pg_temp.byp(870004)).name || '|' || pg_temp.bells('page365_name_changed', (pg_temp.byp(870004)).id),
  'RG9003 Ring Plain [Preloved] Resized|RG9004 Ring Blue Topaz|2');

-- 4d. REPAIR: a read BETWEEN the two releases already left the hybrid "new code + old words" name --------------------
-- (step a3 renamed it, step h saw Page365-now = last seen and skipped; every later read matches it by the new code).
INSERT INTO public.website_products(sku, slug, name, status, origin, metals, page365_product_id, page365_variant_id) VALUES
  ('SH9001', 'sh1-ring', 'SH9001 Ring Old Rest', 'active', 'JAPAN', ARRAY['K18'], 880001, 8800010),
  ('SH9002', 'sh2-ring', 'SH9002 Ring Blue Topaz', 'active', 'JAPAN', ARRAY['K18'], 880002, 8800020);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku IN ('SH9001', 'SH9002');
INSERT INTO public.page365_listing_names(website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names) VALUES
  ((pg_temp.prod('SH9001')).id, 880001, 8800010, 'SH9001 Ring New Rest', ARRAY['SH1 Ring Old Rest', 'SH9001 Ring New Rest']),
  ((pg_temp.prod('SH9002')).id, 880002, 8800020, 'SH9002 Ring B.T [Preloved]', ARRAY['SH2 Ring B.T', 'SH9002 Ring B.T [Preloved]']);
DELETE FROM public.staff_notifications;
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(880001, 'SH9001 Ring New Rest', 1), pg_temp.p(880002, 'SH9002 Ring B.T [Preloved]', 1)));
SELECT pg_temp.eq('4d: an ordinary read cannot see the stuck hybrid (matched by code, Page365 = last seen)',
  (pg_temp.byp(880001)).name, 'SH9001 Ring Old Rest');
-- The fix migration's one-time pass (re-run here = also proves the file is re-runnable).
\i supabase/migrations/20270221100000_page365_follow_recode_name.sql
SELECT pg_temp.eq('4d: the pass repairs the never-completed hybrid to Page365''s text', (pg_temp.byp(880001)).name, 'SH9001 Ring New Rest');
SELECT pg_temp.eq('4d: ... ja_pending', (pg_temp.ln(880001)).ja_pending, true);
SELECT pg_temp.eq('4d: ... the completed one is kept', (pg_temp.byp(880002)).name, 'SH9002 Ring Blue Topaz');
SELECT pg_temp.eq('4d: ... one summary bell, no per-product bell',
  pg_temp.bells('page365_names_followed_summary')::text || '|' || pg_temp.bells('page365_name_changed'), '1|0');
SELECT pg_temp.eq('4d: ... the pass audit row says once', (SELECT new_value_json->>'once' FROM public.audit_logs
  WHERE entity_id = (pg_temp.byp(880001)).id AND action = 'page365_name_followed'), 'true');
SELECT pg_temp.eq('4d: ... stock / price untouched', (SELECT stock_qty || '/' || price_jpy FROM public.website_product_variants WHERE product_id = (pg_temp.byp(880001)).id), '1/50000');
\i supabase/migrations/20270221100000_page365_follow_recode_name.sql
SELECT pg_temp.eq('4d: a second pass finds no difference (no second summary bell)', pg_temp.bells('page365_names_followed_summary'), 1::bigint);

-- 5. PRICE is shown, never copied ----------------------------------------------------------------
CREATE TEMP TABLE r5 AS SELECT pg_temp.run(jsonb_build_array(pg_temp.p(830101, 'RN1 Ring Diamond [Used]', 1, '[]'::jsonb, 77000))) AS id;
SELECT pg_temp.eq('5: price_differs is flagged', (pg_temp.item((SELECT id FROM r5), 830101)).price_differs, true);
SELECT pg_temp.eq('5: the Hub price is untouched',
  (SELECT price_jpy FROM public.website_product_variants WHERE product_id = (pg_temp.prod('RN1')).id), 50000);

-- 6. PHOTOS in Page365's order ----------------------------------------------------------------------
INSERT INTO public.website_products(sku, slug, name, status, origin, metals, page365_product_id, page365_variant_id)
VALUES ('RP1', 'rp1-ring', 'RP1 Ring Photos', 'active', 'JAPAN', ARRAY['K18'], 840001, 8400010);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku = 'RP1';
INSERT INTO public.website_product_media(variant_id, url, alt, sort, page365_photo_id, page365_photo_version)
SELECT v.id, u, 'x', s, pid, CASE WHEN pid IS NULL THEN NULL ELSE '1' END
  FROM public.website_product_variants v, (VALUES ('https://cdn.example/staff.jpg', 0, NULL::bigint),
       ('https://x/a.jpg', 1, 8400101::bigint), ('https://x/b.jpg', 2, 8400102::bigint)) m(u, s, pid)
 WHERE v.product_id = (pg_temp.prod('RP1')).id;
CREATE OR REPLACE FUNCTION pg_temp.order_of_rp1() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(coalesce(m.page365_photo_id::text, 'staff'), ',' ORDER BY m.sort) FROM public.website_product_media m
   JOIN public.website_product_variants v ON v.id = m.variant_id WHERE v.product_id = (pg_temp.prod('RP1')).id $$;
SELECT pg_temp.eq('6: before', pg_temp.order_of_rp1(), 'staff,8400101,8400102');
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(840001, 'RP1 Ring Photos', 1, pg_temp.ph(8400102, 8400101))));
SELECT pg_temp.eq('6: re-ordered to Page365 order after the staff photo', pg_temp.order_of_rp1(), 'staff,8400102,8400101');
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(840001, 'RP1 Ring Photos', 1, pg_temp.ph(8400102))));
SELECT pg_temp.eq('6: a photo removed on Page365 is deleted, the staff photo never', pg_temp.order_of_rp1(), 'staff,8400102');
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(840001, 'RP1 Ring Photos', 1, '[]'::jsonb)));
SELECT pg_temp.eq('6: an EMPTY photo list deletes nothing', pg_temp.order_of_rp1(), 'staff,8400102');
SELECT pg_temp.eq('6: photo changes are audited', (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_photos_followed') >= 2, true);

-- 7. DELETE: hub_only rows (the real cause), claims, a normal linked product -------------------------
INSERT INTO public.website_products(sku, slug, name, status, origin, metals) VALUES
  ('DH1', 'dh1', 'DH1 Hub only one', 'active', 'JAPAN', ARRAY['K18']),
  ('DH2', 'dh2', 'DH2 Hub only two', 'active', 'JAPAN', ARRAY['K18']);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku IN ('DH1','DH2');
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(840001, 'RP1 Ring Photos', 1)));
SELECT pg_temp.eq('7: DH1 and DH2 each own a kind=hub_only row',
  (SELECT count(*) FROM public.page365_inventory_items WHERE kind = 'hub_only' AND website_product_id IN ((pg_temp.prod('DH1')).id, (pg_temp.prod('DH2')).id)) >= 2, true);
SELECT pg_temp.eq('7: a plain delete reproduces the live failure (CHECK page365_inventory_item_kind)',
  pg_temp.fails('DELETE FROM public.website_products WHERE sku = ''DH1''') LIKE '%page365_inventory_item_kind%', true);
CREATE TEMP TABLE d1 AS SELECT public.delete_website_product_atomic((pg_temp.prod('DH1')).id, 'test') AS j;
SELECT pg_temp.eq('(a) delete succeeds', (SELECT (j->>'ok')::boolean FROM d1), true);
SELECT pg_temp.eq('(a) ... it reports the hub_only rows it removed', (SELECT (j->>'hub_only_removed')::int >= 1 FROM d1), true);
SELECT pg_temp.eq('(a) ... DH1 is gone', (SELECT count(*) FROM public.website_products WHERE sku = 'DH1'), 0::bigint);
SELECT pg_temp.eq('(a) ... ONLY its own hub_only rows went: DH2''s remain',
  (SELECT count(*) FROM public.page365_inventory_items WHERE kind = 'hub_only' AND website_product_id = (pg_temp.prod('DH2')).id) >= 1, true);
SELECT pg_temp.eq('(a) ... audited', (SELECT count(*) FROM public.audit_logs WHERE action = 'website_product_deleted'), 1::bigint);
SELECT pg_temp.eq('(a) a Hub-only product leaves no detached review rows', (SELECT count(*) FROM public.product_review_detached), 0::bigint);

-- (b) claims
INSERT INTO public.website_products(sku, slug, name, status, origin, metals) VALUES ('DC1', 'dc1', 'DC1 Claimed', 'active', 'JAPAN', ARRAY['K18']);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku = 'DC1';
CREATE OR REPLACE FUNCTION pg_temp.claim(p_status text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.website_live_claims(code, product_variant_id, status)
  SELECT 'DC1', v.id, p_status::public.website_claim_status FROM public.website_product_variants v WHERE v.product_id = (pg_temp.prod('DC1')).id $$;
SELECT pg_temp.claim('held');
SELECT pg_temp.eq('(b) a HELD claim refuses the delete, plain words',
  pg_temp.fails('SELECT public.delete_website_product_atomic((SELECT id FROM public.website_products WHERE sku = ''DC1''), NULL)'),
  'This piece has an active live-selling claim.');
SELECT pg_temp.eq('(b) ... nothing changed', (SELECT count(*) FROM public.website_products WHERE sku = 'DC1'), 1::bigint);
DELETE FROM public.website_live_claims; SELECT pg_temp.claim('paid');
SELECT pg_temp.eq('(b) a PAID claim refuses', pg_temp.fails('SELECT public.delete_website_product_atomic((SELECT id FROM public.website_products WHERE sku = ''DC1''), NULL)'),
  'This piece has an active live-selling claim.');
DELETE FROM public.website_live_claims; SELECT pg_temp.claim('layaway');
SELECT pg_temp.eq('(b) a LAYAWAY claim refuses', pg_temp.fails('SELECT public.delete_website_product_atomic((SELECT id FROM public.website_products WHERE sku = ''DC1''), NULL)'),
  'This piece has an active live-selling claim.');
DELETE FROM public.website_live_claims; SELECT pg_temp.claim('expired'); SELECT pg_temp.claim('released');
CREATE TEMP TABLE d2 AS SELECT public.delete_website_product_atomic((pg_temp.prod('DC1')).id, NULL) AS j;
SELECT pg_temp.eq('(b) only expired / released claims: cleared, delete succeeds', (SELECT (j->>'claims_cleared')::int FROM d2), 2);
SELECT pg_temp.eq('(b) ... product and its claims are gone',
  (SELECT count(*) FROM public.website_products WHERE sku = 'DC1') + (SELECT count(*) FROM public.website_live_claims), 0::bigint);

-- (c) a normal linked product: page365 item rows survive with NULL links; order lines keep their copy
INSERT INTO public.website_products(sku, slug, name, status, origin, metals, page365_product_id, page365_variant_id)
VALUES ('DN1', 'dn1', 'DN1 Linked normal', 'active', 'JAPAN', ARRAY['K18'], 850001, 8500010);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku = 'DN1';
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(850001, 'DN1 Linked normal', 1)));
INSERT INTO public.cash_order_items(cash_order_id, website_product_id, variant_id, quantity, code, name, unit_price)
SELECT pg_temp.co(), p.id, v.id, 1, 'DN1', 'DN1 Linked normal', 123456 FROM public.website_products p
  JOIN public.website_product_variants v ON v.product_id = p.id WHERE p.sku = 'DN1';
INSERT INTO public.web_order_draft_lines(variant_id, website_product_id, code, name, unit_price)
SELECT v.id, p.id, 'DN1', 'DN1 Linked normal', 123456 FROM public.website_products p
  JOIN public.website_product_variants v ON v.product_id = p.id WHERE p.sku = 'DN1';
CREATE TEMP TABLE n_before AS SELECT count(*) AS n FROM public.page365_inventory_items WHERE page365_product_id = 850001;
CREATE TEMP TABLE d3 AS SELECT public.delete_website_product_atomic((pg_temp.prod('DN1')).id, NULL) AS j;
SELECT pg_temp.eq('(c) delete of a normal linked product succeeds', (SELECT (j->>'ok')::boolean FROM d3), true);
SELECT pg_temp.eq('(c) its kind=page365 rows stay, links NULL',
  (SELECT count(*) FROM public.page365_inventory_items WHERE page365_product_id = 850001 AND kind = 'page365'
      AND website_product_id IS NULL AND variant_id IS NULL), (SELECT n FROM n_before));
SELECT pg_temp.eq('(c) the order line keeps code / name / price, link cleared',
  (SELECT code||'|'||name||'|'||unit_price||'|'||(website_product_id IS NULL)::text FROM public.cash_order_items WHERE code = 'DN1'),
  'DN1|DN1 Linked normal|123456|true');
SELECT pg_temp.eq('(c) the draft line too', (SELECT code||'|'||unit_price||'|'||(website_product_id IS NULL)::text FROM public.web_order_draft_lines WHERE code = 'DN1'), 'DN1|123456|true');
SELECT pg_temp.eq('(c) the counts are reported', (SELECT (j->>'order_lines_unlinked')::int FROM d3), 2);

-- 8. Delete + re-land + reviews restored BOTH ways ------------------------------------------------------
INSERT INTO public.website_products(sku, slug, name, status, origin, metals, page365_product_id, page365_variant_id)
VALUES ('RV1', 'rv1', 'RV1 Reviewed ring', 'active', 'JAPAN', ARRAY['K18'], 860001, 8600010);
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) SELECT id, 1, 50000 FROM public.website_products WHERE sku = 'RV1';
INSERT INTO public.product_reviews(id, website_product_id, body_original) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', (pg_temp.prod('RV1')).id, 'both link kinds'),
  ('aaaaaaaa-0000-0000-0000-00000000000b', (pg_temp.prod('RV1')).id, 'primary link only'),
  ('aaaaaaaa-0000-0000-0000-00000000000c', NULL, 'join-table link only');
INSERT INTO public.product_review_products(review_id, website_product_id) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a', (pg_temp.prod('RV1')).id), ('aaaaaaaa-0000-0000-0000-00000000000c', (pg_temp.prod('RV1')).id);
SELECT pg_temp.run(jsonb_build_array(pg_temp.p(860001, 'RV1 Reviewed ring', 1)));
SELECT public.delete_website_product_atomic((pg_temp.prod('RV1')).id, 'stale');
SELECT pg_temp.eq('8: three reviews remembered by listing', (SELECT count(*) FROM public.product_review_detached WHERE page365_product_id = 860001), 3::bigint);
SELECT pg_temp.eq('8: ... A both, B primary only, C link only',
  (SELECT string_agg(right(review_id::text, 1) || was_linked::int || was_primary::int, ',' ORDER BY review_id) FROM public.product_review_detached),
  'a11,b01,c10');
SELECT pg_temp.eq('8: the reviews themselves survive', (SELECT count(*) FROM public.product_reviews WHERE body_original IS NOT NULL), 3::bigint);
SELECT pg_temp.eq('8: ... links cleared by the delete',
  (SELECT count(*) FROM public.product_review_products) + (SELECT count(*) FROM public.product_reviews WHERE website_product_id IS NOT NULL), 0::bigint);
CREATE TEMP TABLE r8 AS SELECT pg_temp.run(jsonb_build_array(pg_temp.p(860001, 'RV1 Reviewed ring', 1, pg_temp.ph(86000101)))) AS id;
SELECT pg_temp.eq('8: the next read lands a FRESH UNPUBLISHED draft with Page365''s code',
  (SELECT status::text||'|'||sku FROM public.website_products WHERE page365_product_id = 860001), 'draft|RV1');
SELECT pg_temp.eq('8: ... never public (stamp NULL)', (pg_temp.byp(860001)).first_published_at, NULL::timestamptz);
SELECT pg_temp.eq('8: product-page links restored (product_review_products): A and C',
  (SELECT string_agg(right(review_id::text, 1), ',' ORDER BY review_id) FROM public.product_review_products WHERE website_product_id = (pg_temp.byp(860001)).id), 'a,c');
SELECT pg_temp.eq('8: primary links restored (product_reviews.website_product_id): A and B',
  (SELECT string_agg(right(id::text, 1), ',' ORDER BY id) FROM public.product_reviews WHERE website_product_id = (pg_temp.byp(860001)).id), 'a,b');
SELECT pg_temp.eq('8: consumed detached rows removed', (SELECT count(*) FROM public.product_review_detached), 0::bigint);

-- 9. Grants ------------------------------------------------------------------------------------------------
SELECT pg_temp.eq('9: anon cannot delete', has_function_privilege('anon', 'public.delete_website_product_atomic(uuid,text)', 'EXECUTE'), false);
SELECT pg_temp.eq('9: authenticated can (guarded inside)', has_function_privilege('authenticated', 'public.delete_website_product_atomic(uuid,text)', 'EXECUTE'), true);
SELECT pg_temp.eq('9: follow functions are service_role only',
  has_function_privilege('authenticated', 'public.page365_inventory_follow_listing(uuid)', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.page365_follow_names(uuid,boolean)', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.page365_restore_reviews(uuid,bigint,bigint)', 'EXECUTE'), false);

SELECT 'ALL PAGE365-FOLLOW CHECKS PASSED' AS result;
