-- ============================================================================
-- Page365 inventory fetch — LOCAL behaviour tests (2026-09-27). Local Postgres
-- only: run after the stubs and both migrations (see the stub's header). Every
-- check RAISEs on failure; the last line prints ALL INVENTORY CHECKS PASSED.
--
-- Covers: the stock formula incl. website holds (web cash pending, unpaid web
-- layaway; confirmed/paid holds not subtracted); a website-reserved piece is
-- never put back on sale; per-variant codes (E1053 / E2057 under one
-- listing); duplicates / no code / new / ambiguous / Hub-only flags and the
-- 2-run count; #195 invoice holds excluded; compare-and-set skips a row whose
-- stock moved; increases only when named as one; never below zero; partial
-- runs (a product error, a > 20 % count drop) refuse apply and move nothing;
-- superseded runs refuse; resumable claims; whitelisted storage (reviews never
-- stored); photo order, staff photos kept first, hotlink replaced, dedupe on
-- re-copy, version change replaced in place.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_sku text) RETURNS integer LANGUAGE sql AS $$
  SELECT v.stock_qty FROM public.website_products p JOIN public.website_product_variants v ON v.product_id=p.id WHERE p.sku=p_sku ORDER BY v.id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.vid(p_sku text) RETURNS uuid LANGUAGE sql AS $$
  SELECT v.id FROM public.website_products p JOIN public.website_product_variants v ON v.product_id=p.id WHERE p.sku=p_sku ORDER BY v.id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.item(p_run uuid, p_code text) RETURNS public.page365_inventory_items LANGUAGE sql AS $$
  SELECT * FROM public.page365_inventory_items WHERE run_id=p_run AND code=p_code ORDER BY page365_variant_id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.cat(p_run uuid, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT match_result||'/'||category||'/'||coalesce(proposed_stock::text,'-') FROM public.page365_inventory_items WHERE run_id=p_run AND code=p_code ORDER BY page365_variant_id LIMIT 1 $$;

-- A run built exactly as the edge function builds it: run -> products -> claim
-- -> store each detail -> finish. p_details: [{pid, list_name, detail|null, error|null}]
CREATE OR REPLACE FUNCTION pg_temp.run(p_details jsonb, p_count integer DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(page365_count, products_total)
  VALUES (coalesce(p_count, jsonb_array_length(p_details)), jsonb_array_length(p_details)) RETURNING id INTO v_run;
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
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, variants jsonb, photos jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name,
    'detail', jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL, 'photos', photos, 'variants', variants,
                                 'review', jsonb_build_object('customer_name', 'Jane Buyer', 'body', 'lovely'))) $$;
CREATE OR REPLACE FUNCTION pg_temp.v(id bigint, code text, avail integer, price integer DEFAULT 10000) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', id, 'name', NULL, 'code', code, 'price_jpy', price, 'full_price_jpy', NULL, 'available', avail) $$;
CREATE OR REPLACE FUNCTION pg_temp.apply(p_run uuid, d uuid[], i uuid[]) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.page365_inventory_apply(p_run, d, i) $$;

-- Catalogue ---------------------------------------------------------------
INSERT INTO public.website_products(id, sku, name, status) VALUES
 ('10000000-0000-0000-0000-000000000001','ZI9101','Decrease piece','active'),
 ('10000000-0000-0000-0000-000000000002','ZI9102','Increase piece','active'),
 ('10000000-0000-0000-0000-000000000003','ZI9103','Web-reserved piece','active'),
 ('10000000-0000-0000-0000-000000000004','ZI9104','Invoice-held piece','active'),
 ('10000000-0000-0000-0000-000000000005','E1053','Earring A','active'),
 ('10000000-0000-0000-0000-000000000006','E2057','Earring B','draft'),
 ('10000000-0000-0000-0000-000000000007','N4020','Tiffany','active'),
 ('10000000-0000-0000-0000-000000000008','ZI9106','Two sizes','active'),
 ('10000000-0000-0000-0000-000000000009','ZI9200','Hub only','active'),
 ('10000000-0000-0000-0000-000000000010','ZI9201','Archived hub only','archived'),
 ('10000000-0000-0000-0000-000000000011','ZI9107','Layaway reserved','active'),
 ('10000000-0000-0000-0000-000000000012','ZI9108','Confirmed web sale','active'),
 ('10000000-0000-0000-0000-000000000013','ZI9109','CAS piece','active'),
 ('10000000-0000-0000-0000-000000000014','ZI9110','Photo piece','active');
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy)
SELECT id, s, pr FROM (VALUES
 ('10000000-0000-0000-0000-000000000001'::uuid,3,10000), ('10000000-0000-0000-0000-000000000002'::uuid,0,10000),
 ('10000000-0000-0000-0000-000000000003'::uuid,0,10000), ('10000000-0000-0000-0000-000000000004'::uuid,1,10000),
 ('10000000-0000-0000-0000-000000000005'::uuid,1,74980), ('10000000-0000-0000-0000-000000000006'::uuid,1,81980),
 ('10000000-0000-0000-0000-000000000007'::uuid,1,72980), ('10000000-0000-0000-0000-000000000008'::uuid,1,10000),
 ('10000000-0000-0000-0000-000000000008'::uuid,1,10000), ('10000000-0000-0000-0000-000000000009'::uuid,2,10000),
 ('10000000-0000-0000-0000-000000000010'::uuid,0,10000), ('10000000-0000-0000-0000-000000000011'::uuid,0,10000),
 ('10000000-0000-0000-0000-000000000012'::uuid,0,10000), ('10000000-0000-0000-0000-000000000013'::uuid,2,10000),
 ('10000000-0000-0000-0000-000000000014'::uuid,1,9000)) t(id,s,pr);

-- Website holds: a pending web cash order on ZI9103 (qty 1), an unpaid live web
-- layaway on ZI9107, and on ZI9108 only CONFIRMED/finished web sales (completed
-- cash, paid layaway, released layaway, Hub-channel pending) — none subtract.
INSERT INTO public.cash_orders(id, invoice_number, customer_id, status, source_channel) VALUES
 ('20000000-0000-0000-0000-000000000001','W1', gen_random_uuid(), 'pending',   'web'),
 ('20000000-0000-0000-0000-000000000002','W2', gen_random_uuid(), 'completed', 'web'),
 ('20000000-0000-0000-0000-000000000003','H1', gen_random_uuid(), 'pending',   'hub');
INSERT INTO public.cash_order_items(cash_order_id, variant_id, quantity) VALUES
 ('20000000-0000-0000-0000-000000000001', pg_temp.vid('ZI9103'), 1),
 ('20000000-0000-0000-0000-000000000002', pg_temp.vid('ZI9108'), 1),
 ('20000000-0000-0000-0000-000000000003', pg_temp.vid('ZI9108'), 1);
INSERT INTO public.layaway_accounts(id, invoice_number, customer_id, status, source_channel, total_paid, stock_released_at) VALUES
 ('30000000-0000-0000-0000-000000000001','L1', gen_random_uuid(), 'active', 'web', 0, NULL),
 ('30000000-0000-0000-0000-000000000002','L2', gen_random_uuid(), 'active', 'web', 5000, NULL),
 ('30000000-0000-0000-0000-000000000003','L3', gen_random_uuid(), 'forfeited', 'web', 0, now());
INSERT INTO public.layaway_account_items(account_id, variant_id, quantity) VALUES
 ('30000000-0000-0000-0000-000000000001', pg_temp.vid('ZI9107'), 1),
 ('30000000-0000-0000-0000-000000000002', pg_temp.vid('ZI9108'), 1),
 ('30000000-0000-0000-0000-000000000003', pg_temp.vid('ZI9108'), 1);

SELECT pg_temp.eq('web holds: pending web cash', public.page365_web_holds(pg_temp.vid('ZI9103')), 1);
SELECT pg_temp.eq('web holds: unpaid web layaway', public.page365_web_holds(pg_temp.vid('ZI9107')), 1);
SELECT pg_temp.eq('web holds: completed/paid/released/hub never subtract', public.page365_web_holds(pg_temp.vid('ZI9108')), 0);

-- A #195 invoice hold on ZI9104.
INSERT INTO public.page365_stock_lines(page365_no, line_no, line_name, first_word, quantity, variant_id, match_result, stock_state)
VALUES (90001, 1, 'ZI9104 held', 'ZI9104', 1, pg_temp.vid('ZI9104'), 'matched', 'held');

-- Staff photo + a spreadsheet hotlink on ZI9110.
INSERT INTO public.website_product_media(variant_id, url, alt, sort) VALUES
 (pg_temp.vid('ZI9110'), 'https://hub.example/storage/v1/object/public/promotions/website/staff-1.jpg', 'staff', 0),
 (pg_temp.vid('ZI9110'), 'https://assets.page365.net/photos/original/555.jpeg?111', 'hotlink', 1);

-- Run 1 -------------------------------------------------------------------
SELECT set_config('t.run1', pg_temp.run(jsonb_build_array(
  pg_temp.p(1, 'ZI9101 Ring', jsonb_build_array(pg_temp.v(11,'ZI9101',1))),
  pg_temp.p(2, 'ZI9102 Ring', jsonb_build_array(pg_temp.v(21,'ZI9102',2, 12000))),
  pg_temp.p(3, 'ZI9103 Ring', jsonb_build_array(pg_temp.v(31,'ZI9103',1))),
  pg_temp.p(4, 'ZI9104 Ring', jsonb_build_array(pg_temp.v(41,'ZI9104',0))),
  pg_temp.p(5, 'E1053 Earrings K18', jsonb_build_array(pg_temp.v(51,'E1053',0,74980), pg_temp.v(52,'E2057',1,81980))),
  pg_temp.p(6, 'N4020 Necklace Tiffany', jsonb_build_array(pg_temp.v(61,'N4020',0,72980))),
  pg_temp.p(7, 'ZI9105 dup', jsonb_build_array(pg_temp.v(71,'ZI9105',1))),
  pg_temp.p(8, 'ZI9105 dup again', jsonb_build_array(pg_temp.v(81,'ZI9105',1))),
  pg_temp.p(9, 'Necklace no code', jsonb_build_array(pg_temp.v(91,NULL,1))),
  pg_temp.p(10, 'ZI9999 brand new', jsonb_build_array(pg_temp.v(101,'ZI9999',1))),
  pg_temp.p(11, 'ZI9106 two sizes', jsonb_build_array(pg_temp.v(111,'ZI9106',0))),
  pg_temp.p(12, 'ZI9107 layaway', jsonb_build_array(pg_temp.v(121,'ZI9107',1))),
  pg_temp.p(13, 'ZI9108 confirmed', jsonb_build_array(pg_temp.v(131,'ZI9108',0))),
  pg_temp.p(14, 'ZI9109 cas', jsonb_build_array(pg_temp.v(141,'ZI9109',1))),
  pg_temp.p(15, 'ZI9110 photos', jsonb_build_array(pg_temp.v(151,'ZI9110',1, 9500)),
    '[{"id":555,"version":"111","url":"https://assets.page365.net/photos/original/555.jpeg?111","position":0},
      {"id":556,"version":"222","url":"https://assets.page365.net/photos/original/556.jpeg?222","position":1},
      {"id":557,"version":"333","url":"https://assets.page365.net/photos/original/557.jpeg?333","position":1}]'::jsonb)
))::text, false);

SELECT pg_temp.eq('run 1 ready', (SELECT status FROM public.page365_inventory_runs WHERE id = current_setting('t.run1')::uuid), 'ready');
SELECT pg_temp.eq('decrease', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9101'), 'matched/decrease/1');
SELECT pg_temp.eq('increase', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9102'), 'matched/increase/2');
SELECT pg_temp.eq('web-reserved piece is not put back on sale', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9103'), 'matched/no_change/0');
SELECT pg_temp.eq('invoice hold excluded', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9104'), 'matched/excluded/0');
SELECT pg_temp.eq('E1053 variant code', pg_temp.cat(current_setting('t.run1')::uuid, 'E1053'), 'matched/decrease/0');
SELECT pg_temp.eq('E2057 variant code (same listing)', pg_temp.cat(current_setting('t.run1')::uuid, 'E2057'), 'matched/no_change/1');
SELECT pg_temp.eq('E2057 matched its own Hub product',
  (pg_temp.item(current_setting('t.run1')::uuid, 'E2057')).website_product_id, '10000000-0000-0000-0000-000000000006'::uuid);
SELECT pg_temp.eq('N4020 sold out on Page365 -> 0', pg_temp.cat(current_setting('t.run1')::uuid, 'N4020'), 'matched/decrease/0');
SELECT pg_temp.eq('duplicate code flagged', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9105'), 'duplicate_in_page365/flagged/-');
SELECT pg_temp.eq('no code flagged', (SELECT match_result||'/'||category FROM public.page365_inventory_items
   WHERE run_id = current_setting('t.run1')::uuid AND page365_variant_id = 91), 'no_code/flagged');
SELECT pg_temp.eq('new in Page365 listed', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9999'), 'unmatched/new/-');
SELECT pg_temp.eq('Hub product with 2 variants flagged', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9106'), 'ambiguous_variant/flagged/-');
SELECT pg_temp.eq('unpaid web layaway subtracts', pg_temp.cat(current_setting('t.run1')::uuid, 'ZI9107'), 'matched/no_change/0');
SELECT pg_temp.eq('price difference reported', (pg_temp.item(current_setting('t.run1')::uuid, 'ZI9102')).price_differs, true);
SELECT pg_temp.eq('equal price not reported', (pg_temp.item(current_setting('t.run1')::uuid, 'ZI9101')).price_differs, false);
SELECT pg_temp.eq('hub-only flagged once', (SELECT missing_runs FROM public.page365_inventory_items
   WHERE run_id = current_setting('t.run1')::uuid AND kind = 'hub_only' AND hub_sku = 'ZI9200'), 1);
SELECT pg_temp.eq('archived hub product not listed', (SELECT count(*)::int FROM public.page365_inventory_items
   WHERE run_id = current_setting('t.run1')::uuid AND hub_sku = 'ZI9201'), 0);
SELECT pg_temp.eq('photos to copy counted (hotlink counts: not yet copied)', (pg_temp.item(current_setting('t.run1')::uuid, 'ZI9110')).photos_to_copy, 3);
SELECT pg_temp.eq('fetch moved no stock', pg_temp.stock('ZI9101'), 3);

-- Reviews are never stored: only whitelisted keys reach the run tables.
SELECT pg_temp.eq('no review text anywhere', (SELECT count(*)::int FROM public.page365_inventory_products
   WHERE run_id = current_setting('t.run1')::uuid AND (row_to_json(page365_inventory_products)::text ILIKE '%Jane Buyer%'
      OR row_to_json(page365_inventory_products)::text ILIKE '%lovely%')), 0);
SELECT pg_temp.eq('photo keys whitelisted', (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM public.page365_inventory_products p,
   jsonb_array_elements(p.photos) ph, jsonb_object_keys(ph) k WHERE p.run_id = current_setting('t.run1')::uuid), 'id,position,url,version');

-- Apply -------------------------------------------------------------------
SELECT pg_temp.eq('no user -> forbidden', pg_temp.apply(current_setting('t.run1')::uuid,
   ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'ZI9101')).id], NULL)->>'reason', 'forbidden');
SELECT set_config('test.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
SELECT pg_temp.eq('no permission -> forbidden', pg_temp.apply(current_setting('t.run1')::uuid,
   ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'ZI9101')).id], NULL)->>'reason', 'forbidden');
INSERT INTO public.perm VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'manage_website_catalog');

-- CAS: someone buys ZI9109 on the website between fetch and apply.
UPDATE public.page365_inventory_items SET proposed_stock = 1, category = 'decrease'
 WHERE run_id = current_setting('t.run1')::uuid AND code = 'ZI9109';   -- seen 2, Page365 1
UPDATE public.website_product_variants SET stock_qty = 1 WHERE id = pg_temp.vid('ZI9109');

SELECT set_config('t.res', pg_temp.apply(current_setting('t.run1')::uuid,
  ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'ZI9101')).id,
        (pg_temp.item(current_setting('t.run1')::uuid,'N4020')).id,
        (pg_temp.item(current_setting('t.run1')::uuid,'ZI9109')).id,
        (pg_temp.item(current_setting('t.run1')::uuid,'ZI9102')).id,   -- an increase sent as a decrease
        (pg_temp.item(current_setting('t.run1')::uuid,'ZI9104')).id,   -- excluded
        (pg_temp.item(current_setting('t.run1')::uuid,'ZI9999')).id],  -- new, not a stock change
  NULL)::text, false);
SELECT pg_temp.eq('applied 2', (current_setting('t.res')::jsonb->>'applied')::int, 2);
SELECT pg_temp.eq('changed since fetch 1', (current_setting('t.res')::jsonb->>'changed_since_fetch')::int, 1);
SELECT pg_temp.eq('skipped 3', (current_setting('t.res')::jsonb->>'skipped')::int, 3);
SELECT pg_temp.eq('decrease written', pg_temp.stock('ZI9101'), 1);
SELECT pg_temp.eq('N4020 now 0', pg_temp.stock('N4020'), 0);
SELECT pg_temp.eq('CAS left the website sale alone', pg_temp.stock('ZI9109'), 1);
SELECT pg_temp.eq('increase not applied as a decrease', pg_temp.stock('ZI9102'), 0);
SELECT pg_temp.eq('excluded never written', pg_temp.stock('ZI9104'), 1);
SELECT pg_temp.eq('direction mismatch noted, row still reviewable',
  (SELECT status||'/'||result_note FROM public.page365_inventory_items WHERE id = (pg_temp.item(current_setting('t.run1')::uuid,'ZI9102')).id),
  'review/direction_mismatch');
SELECT pg_temp.eq('changed row marked', (pg_temp.item(current_setting('t.run1')::uuid,'ZI9109')).status, 'changed_since_fetch');
SELECT pg_temp.eq('audit row per applied variant', (SELECT count(*)::int FROM public.audit_logs WHERE action = 'page365_inventory_applied'), 2);
SELECT pg_temp.eq('audit row per call', (SELECT count(*)::int FROM public.audit_logs WHERE action = 'page365_inventory_apply'), 1);

-- The increase, ticked as an increase.
SELECT pg_temp.eq('increase with tick applied', (pg_temp.apply(current_setting('t.run1')::uuid, NULL,
   ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'ZI9102')).id])->>'applied')::int, 1);
SELECT pg_temp.eq('increase written', pg_temp.stock('ZI9102'), 2);
-- Re-apply: nothing changes.
SELECT pg_temp.eq('re-apply skipped', pg_temp.apply(current_setting('t.run1')::uuid,
   ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'ZI9101')).id], NULL)->'skipped_items'->0->>'reason', 'already_applied');
SELECT pg_temp.eq('still 1', pg_temp.stock('ZI9101'), 1);
SELECT pg_temp.eq('same id in both lists refused', pg_temp.apply(current_setting('t.run1')::uuid,
   ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'E1053')).id], ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'E1053')).id])->>'reason',
   'id_in_both_lists');
-- Never below zero, even with a tampered proposal (CHECK constraints are the backstop).
DO $$ BEGIN
  UPDATE public.page365_inventory_items SET proposed_stock = -1 WHERE id = (pg_temp.item(current_setting('t.run1')::uuid,'E1053')).id;
  RAISE EXCEPTION 'FAIL negative proposal accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  negative proposal refused by CHECK'; END $$;

-- Photos --------------------------------------------------------------------
-- Page365 order (position, then list order): 555, 556, 557. Staff photo stays sort 0.
SELECT set_config('t.pi', (pg_temp.item(current_setting('t.run1')::uuid,'ZI9110')).id::text, false);
SELECT pg_temp.eq('bad url refused', public.page365_inventory_record_photo(current_setting('t.pi')::uuid, 556, '222',
   'https://evil.example/x.jpg', NULL, 1, NULL), 'bad_url');
SELECT pg_temp.eq('hotlink replaced in place', public.page365_inventory_record_photo(current_setting('t.pi')::uuid, 555, '111',
   'https://hub.example/storage/v1/object/public/promotions/website/page365/15/555-111.jpeg',
   'https://assets.page365.net/photos/original/555.jpeg?111', 0, NULL), 'replaced_hotlink');
SELECT pg_temp.eq('second photo inserted', public.page365_inventory_record_photo(current_setting('t.pi')::uuid, 556, '222',
   'https://hub.example/storage/v1/object/public/promotions/website/page365/15/556-222.jpeg',
   'https://assets.page365.net/photos/original/556.jpeg?222', 1, NULL), 'inserted');
SELECT pg_temp.eq('third photo inserted', public.page365_inventory_record_photo(current_setting('t.pi')::uuid, 557, '333',
   'https://hub.example/storage/v1/object/public/promotions/website/page365/15/557-333.jpeg',
   'https://assets.page365.net/photos/original/557.jpeg?333', 2, NULL), 'inserted');
SELECT pg_temp.eq('re-copy is a no-op', public.page365_inventory_record_photo(current_setting('t.pi')::uuid, 556, '222',
   'https://hub.example/storage/v1/object/public/promotions/website/page365/15/556-222.jpeg',
   'https://assets.page365.net/photos/original/556.jpeg?222', 1, NULL), 'exists');
SELECT pg_temp.eq('gallery order: staff first, then Page365 order',
  (SELECT string_agg(coalesce(page365_photo_id::text, 'staff'), ',' ORDER BY sort, page365_photo_id NULLS FIRST)
     FROM public.website_product_media WHERE variant_id = pg_temp.vid('ZI9110')), 'staff,555,556,557');
SELECT pg_temp.eq('staff photo untouched', (SELECT sort||'|'||url FROM public.website_product_media
   WHERE variant_id = pg_temp.vid('ZI9110') AND page365_photo_id IS NULL),
   '0|https://hub.example/storage/v1/object/public/promotions/website/staff-1.jpg');
SELECT pg_temp.eq('no duplicate rows', (SELECT count(*)::int FROM public.website_product_media WHERE variant_id = pg_temp.vid('ZI9110')), 4);
SELECT pg_temp.eq('audit row per copied photo', (SELECT count(*)::int FROM public.audit_logs WHERE action = 'page365_photo_copied'), 3);

-- Without staff photos the first Page365 photo is the main one (sort 0).
SELECT public.page365_inventory_record_photo((pg_temp.item(current_setting('t.run1')::uuid,'ZI9101')).id, 700, 'a',
   'https://hub.example/storage/v1/object/public/promotions/website/page365/1/700-a.jpeg', NULL, 0, NULL);
SELECT pg_temp.eq('first Page365 photo is main', (SELECT sort FROM public.website_product_media WHERE page365_photo_id = 700), 0);

-- Run 2: a re-fetch. Copied photos count as done; a new version must re-copy;
-- Hub-only counts a second run.
SELECT set_config('t.run2', pg_temp.run(jsonb_build_array(
  pg_temp.p(1, 'ZI9101 Ring', jsonb_build_array(pg_temp.v(11,'ZI9101',1))),
  pg_temp.p(15, 'ZI9110 photos', jsonb_build_array(pg_temp.v(151,'ZI9110',1, 9500)),
    '[{"id":555,"version":"111","url":"https://assets.page365.net/photos/original/555.jpeg?111","position":0},
      {"id":556,"version":"999","url":"https://assets.page365.net/photos/original/556.jpeg?999","position":1},
      {"id":557,"version":"333","url":"https://assets.page365.net/photos/original/557.jpeg?333","position":2}]'::jsonb)
), 15)::text, false);
SELECT pg_temp.eq('re-fetch: only the replaced photo is to copy', (pg_temp.item(current_setting('t.run2')::uuid, 'ZI9110')).photos_to_copy, 1);
SELECT pg_temp.eq('replaced version refreshed in place', public.page365_inventory_record_photo(
   (pg_temp.item(current_setting('t.run2')::uuid,'ZI9110')).id, 556, '999',
   'https://hub.example/storage/v1/object/public/promotions/website/page365/15/556-999.jpeg',
   'https://assets.page365.net/photos/original/556.jpeg?999', 1, NULL), 'replaced');
SELECT pg_temp.eq('still no duplicate rows', (SELECT count(*)::int FROM public.website_product_media WHERE variant_id = pg_temp.vid('ZI9110')), 4);
SELECT pg_temp.eq('hub-only second run counted', (SELECT missing_runs FROM public.page365_inventory_items
   WHERE run_id = current_setting('t.run2')::uuid AND kind = 'hub_only' AND hub_sku = 'ZI9200'), 2);
SELECT pg_temp.eq('old run superseded', pg_temp.apply(current_setting('t.run1')::uuid,
   ARRAY[(pg_temp.item(current_setting('t.run1')::uuid,'E1053')).id], NULL)->>'reason', 'superseded');

-- Outage: one product fails twice -> partial -> apply refuses, nothing moves,
-- and a partial read never lists Hub-only products.
SELECT set_config('t.run3', pg_temp.run(jsonb_build_array(
  pg_temp.p(1, 'ZI9101 Ring', jsonb_build_array(pg_temp.v(11,'ZI9101',0))),
  jsonb_build_object('pid', 2, 'list_name', 'ZI9102 Ring', 'detail', NULL, 'error', 'HTTP 503')
), 15)::text, false);
SELECT pg_temp.eq('partial run', (SELECT status FROM public.page365_inventory_runs WHERE id = current_setting('t.run3')::uuid), 'partial');
SELECT pg_temp.eq('failed product retried once', (SELECT attempts FROM public.page365_inventory_products
   WHERE run_id = current_setting('t.run3')::uuid AND page365_product_id = 2), 2);
SELECT pg_temp.eq('partial refuses apply', pg_temp.apply(current_setting('t.run3')::uuid,
   ARRAY[(pg_temp.item(current_setting('t.run3')::uuid,'ZI9101')).id], NULL)->>'reason', 'run_not_ready');
SELECT pg_temp.eq('partial moved nothing', pg_temp.stock('ZI9101'), 1);
SELECT pg_temp.eq('partial lists no hub-only', (SELECT count(*)::int FROM public.page365_inventory_items
   WHERE run_id = current_setting('t.run3')::uuid AND kind = 'hub_only'), 0);

-- A bad detail (non-integer available) is an error, never a guessed 0.
SELECT set_config('t.run4', pg_temp.run(jsonb_build_array(
  jsonb_build_object('pid', 1, 'list_name', 'ZI9101 Ring', 'detail', jsonb_build_object('name','ZI9101 Ring','photos','[]'::jsonb,
     'variants', jsonb_build_array(jsonb_build_object('id', 11, 'code', 'ZI9101', 'available', 'lots'))))
), 15)::text, false);
SELECT pg_temp.eq('bad detail -> partial', (SELECT status FROM public.page365_inventory_runs WHERE id = current_setting('t.run4')::uuid), 'partial');

-- Count drop > 20 % against the last ready run (run 2 said 15; this says 5).
SELECT set_config('t.run5', pg_temp.run(jsonb_build_array(
  pg_temp.p(1, 'ZI9101 Ring', jsonb_build_array(pg_temp.v(11,'ZI9101',0)))), 5)::text, false);
SELECT pg_temp.eq('count drop -> partial', (SELECT status FROM public.page365_inventory_runs WHERE id = current_setting('t.run5')::uuid), 'partial');

-- Resumable claim: a crashed call's claim is taken again after 3 minutes.
INSERT INTO public.page365_inventory_runs(id, page365_count, products_total) VALUES ('40000000-0000-0000-0000-000000000001', 1, 1);
INSERT INTO public.page365_inventory_products(run_id, page365_product_id, list_name) VALUES ('40000000-0000-0000-0000-000000000001', 1, 'X');
SELECT pg_temp.eq('first claim', (SELECT count(*)::int FROM public.page365_inventory_claim('40000000-0000-0000-0000-000000000001', 10)), 1);
SELECT pg_temp.eq('fresh claim not re-taken', (SELECT count(*)::int FROM public.page365_inventory_claim('40000000-0000-0000-0000-000000000001', 10)), 0);
UPDATE public.page365_inventory_products SET claimed_at = now() - interval '4 minutes' WHERE run_id = '40000000-0000-0000-0000-000000000001';
SELECT pg_temp.eq('stale claim re-taken', (SELECT count(*)::int FROM public.page365_inventory_claim('40000000-0000-0000-0000-000000000001', 10)), 1);
SELECT pg_temp.eq('finish waits for open products', public.page365_inventory_finish('40000000-0000-0000-0000-000000000001')->>'reason', 'not_done');

-- One fetching run at a time (the resumable run above is still fetching).
DO $$ BEGIN
  INSERT INTO public.page365_inventory_runs(page365_count) VALUES (1);
  RAISE EXCEPTION 'FAIL a second fetching run was accepted';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok  one fetching run at a time'; END $$;

-- Browser roles.
SELECT pg_temp.eq('authenticated cannot finish', has_function_privilege('authenticated','public.page365_inventory_finish(uuid)','EXECUTE'), false);
SELECT pg_temp.eq('authenticated cannot record photos', has_function_privilege('authenticated',
   'public.page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)','EXECUTE'), false);
SELECT pg_temp.eq('no negative stock anywhere', (SELECT count(*)::int FROM public.website_product_variants WHERE stock_qty < 0), 0);

DO $$ BEGIN RAISE NOTICE 'ALL INVENTORY CHECKS PASSED'; END $$;
