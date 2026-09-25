-- ============================================================================
-- Page365 inventory PR 2 — LOCAL behaviour tests (2026-09-28). Local Postgres
-- only: run after the stubs, the seed and all three migrations (see
-- docs/sql/20260928_page365_inventory_pr2_local_stub.sql). Every check RAISEs
-- on failure; the last line prints ALL PR 2 CHECKS PASSED.
--
-- Covers: the cut-over (held -> absorbed, audited, stock untouched); an
-- absorbed line returns nothing on cancel / delete; invoice import in
-- inventory_sync records the match and NEVER moves stock (page365_master),
-- still flags unmatched lines and skips services; cancel / revive of such an
-- order moves nothing; the "Don't sync with Page365" switch (guarded to
-- manage_website_catalog, audited) keeps an invoice import from moving stock
-- even in 'invoice' mode; the 'invoice' rollback still takes and returns
-- stock exactly as #195; the fetch: not_synced rows are never proposed, never
-- applied (also when the switch is flipped AFTER the fetch), photos never
-- recorded; unpaid imported invoices are subtracted while
-- page365_hold_unpaid_invoices is true and not when false; absorbed /
-- page365_master lines no longer exclude a variant; 'invoice' mode excludes a
-- held variant exactly as PR 1 did.
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
  SELECT * FROM public.page365_inventory_items WHERE run_id=p_run AND coalesce(code, hub_sku)=p_code ORDER BY page365_variant_id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.cat(p_run uuid, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT match_result||'/'||category||'/'||coalesce(proposed_stock::text,'-') FROM public.page365_inventory_items
   WHERE run_id=p_run AND coalesce(code, hub_sku)=p_code ORDER BY page365_variant_id LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.line(p_no bigint) RETURNS public.page365_stock_lines LANGUAGE sql AS $$
  SELECT * FROM public.page365_stock_lines WHERE page365_no=p_no ORDER BY line_no LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.mode(p text) RETURNS void LANGUAGE sql AS $$
  UPDATE public.system_settings SET value = to_jsonb(p) WHERE key = 'page365_stock_mode' $$;
CREATE OR REPLACE FUNCTION pg_temp.run(p_details jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_run uuid; r record; d jsonb;
BEGIN
  INSERT INTO public.page365_inventory_runs(page365_count, products_total)
  VALUES (jsonb_array_length(p_details), jsonb_array_length(p_details)) RETURNING id INTO v_run;
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
CREATE OR REPLACE FUNCTION pg_temp.p(pid bigint, name text, avail integer, photos jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('pid', pid, 'list_name', name,
    'detail', jsonb_build_object('name', name, 'price_jpy', 10000, 'full_price_jpy', NULL, 'photos', photos,
      'variants', jsonb_build_array(jsonb_build_object('id', pid * 10, 'name', NULL, 'code', split_part(name, ' ', 1),
                                                      'price_jpy', 10000, 'full_price_jpy', NULL, 'available', avail)))) $$;

-- Apply one row (as a decrease unless the fetch called it an increase):
-- 'applied', 'changed_since_fetch', or the skip reason.
CREATE OR REPLACE FUNCTION pg_temp.apply_one(p_run uuid, p_id uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb; inc boolean;
BEGIN
  SELECT category = 'increase' INTO inc FROM public.page365_inventory_items WHERE id = p_id;
  r := public.page365_inventory_apply(p_run, CASE WHEN inc THEN '{}'::uuid[] ELSE ARRAY[p_id] END,
                                             CASE WHEN inc THEN ARRAY[p_id] ELSE '{}'::uuid[] END);
  IF NOT (r->>'ok')::boolean THEN RETURN 'refused:' || (r->>'reason'); END IF;
  IF (r->>'applied')::int = 1 THEN RETURN 'applied'; END IF;
  IF (r->>'changed_since_fetch')::int = 1 THEN RETURN 'changed_since_fetch'; END IF;
  RETURN r->'skipped_items'->0->>'reason';
END $$;

-- Users: U1 has no catalogue permission, U2 has manage_website_catalog.
INSERT INTO public.perm(user_id, key) VALUES ('99999999-0000-0000-0000-000000000002', 'manage_website_catalog');

-- 1. The cut-over --------------------------------------------------------
SELECT pg_temp.eq('mode seeded inventory_sync', (SELECT value #>> '{}' FROM public.system_settings WHERE key='page365_stock_mode'), 'inventory_sync');
SELECT pg_temp.eq('hold-unpaid seeded true', (SELECT value #>> '{}' FROM public.system_settings WHERE key='page365_hold_unpaid_invoices'), 'true');
SELECT pg_temp.eq('no held line left', (SELECT count(*) FROM public.page365_stock_lines WHERE stock_state='held'), 0::bigint);
SELECT pg_temp.eq('both held lines absorbed', (SELECT count(*) FROM public.page365_stock_lines WHERE stock_state='absorbed'), 2::bigint);
SELECT pg_temp.eq('released line left as is', (SELECT count(*) FROM public.page365_stock_lines WHERE stock_state='released'), 1::bigint);
SELECT pg_temp.eq('one audit row per absorbed line', (SELECT count(*) FROM public.audit_logs WHERE action='page365_stock_absorbed'), 2::bigint);
SELECT pg_temp.eq('cut-over moved no stock (ZP2001)', pg_temp.stock('ZP2001'), 3);
SELECT pg_temp.eq('cut-over moved no stock (ZP2002)', pg_temp.stock('ZP2002'), 3);
SELECT pg_temp.eq('switch defaults off', (SELECT bool_or(page365_sync_disabled) FROM public.website_products), false);

-- 2. Absorbed lines give nothing back ------------------------------------
UPDATE public.cash_orders SET status='cancelled' WHERE id='60000000-0000-0000-0000-000000000003';
SELECT pg_temp.eq('cancel of an absorbed order returns nothing', pg_temp.stock('ZP2001'), 3);
SELECT pg_temp.eq('absorbed line stays absorbed', (pg_temp.line(80003)).stock_state, 'absorbed');
DELETE FROM public.cash_orders WHERE id='60000000-0000-0000-0000-000000000003';
SELECT pg_temp.eq('delete of an absorbed order returns nothing', pg_temp.stock('ZP2001'), 3);
UPDATE public.cash_orders SET status='expired' WHERE id='60000000-0000-0000-0000-000000000001';
SELECT pg_temp.eq('expiry of an absorbed order returns nothing', pg_temp.stock('ZP2001'), 3);
UPDATE public.cash_orders SET status='pending' WHERE id='60000000-0000-0000-0000-000000000001';
SELECT pg_temp.eq('revive of an absorbed order takes nothing', pg_temp.stock('ZP2001'), 3);
SELECT pg_temp.eq('revive raises no rehold flag', (pg_temp.line(80001)).flag, NULL::text);

-- 3. Invoice import in inventory_sync: record only ------------------------
INSERT INTO public.website_products(id, sku, name, status) VALUES
 ('40000000-0000-0000-0000-000000000003','ZP2003','Record-only piece','active'),
 ('40000000-0000-0000-0000-000000000004','ZP2004','Not synced piece','active'),
 ('40000000-0000-0000-0000-000000000005','ZP2005','Rollback piece','active'),
 ('40000000-0000-0000-0000-000000000006','ZP2006','Not synced, Hub only','active'),
 ('40000000-0000-0000-0000-000000000007','ZP2007','Hub only','active');
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) VALUES
 ('40000000-0000-0000-0000-000000000003', 2, 10000), ('40000000-0000-0000-0000-000000000004', 1, 10000),
 ('40000000-0000-0000-0000-000000000005', 2, 10000), ('40000000-0000-0000-0000-000000000006', 1, 10000),
 ('40000000-0000-0000-0000-000000000007', 1, 10000);
INSERT INTO public.page365_drafts(id, page365_no, payload) VALUES
 ('50000000-0000-0000-0000-000000000004', 80004,
  '{"items":[{"kind":"product","name":"ZP2003 Ring","quantity":1},{"kind":"product","name":"NOPE999 Ring","quantity":1},{"kind":"service","name":"Resize fee","quantity":1}]}');
INSERT INTO public.cash_orders(id, invoice_number, customer_id, status, page365_no) VALUES
 ('60000000-0000-0000-0000-000000000004','80004', gen_random_uuid(), 'pending', 80004);
SELECT set_config('t.r4', public.page365_apply_stock('cash','60000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','{}',NULL)::text, false);
SELECT pg_temp.eq('sync import: mode reported', current_setting('t.r4')::jsonb->>'mode', 'inventory_sync');
SELECT pg_temp.eq('sync import: held 0', (current_setting('t.r4')::jsonb->>'held')::int, 0);
SELECT pg_temp.eq('sync import: recorded 1', (current_setting('t.r4')::jsonb->>'recorded')::int, 1);
SELECT pg_temp.eq('sync import: flagged 1', (current_setting('t.r4')::jsonb->>'flagged')::int, 1);
SELECT pg_temp.eq('sync import: service skipped', (current_setting('t.r4')::jsonb->>'services')::int, 1);
SELECT pg_temp.eq('sync import: stock untouched', pg_temp.stock('ZP2003'), 2);
SELECT pg_temp.eq('sync import: page365_master', (pg_temp.line(80004)).stock_state, 'page365_master');
SELECT pg_temp.eq('sync import: variant recorded', (pg_temp.line(80004)).variant_id, pg_temp.vid('ZP2003'));
SELECT pg_temp.eq('sync import: stock_seen recorded', (pg_temp.line(80004)).stock_seen, 2);
SELECT pg_temp.eq('sync import: matched line not flagged', (pg_temp.line(80004)).flag, NULL::text);
SELECT pg_temp.eq('sync import: unmatched still flagged',
  (SELECT flag FROM public.page365_stock_lines WHERE page365_no=80004 AND line_no=2), 'unmatched');
SELECT pg_temp.eq('sync import: bell wording',
  (SELECT body FROM public.staff_notifications WHERE metadata->>'page365_no'='80004' ORDER BY created_at DESC LIMIT 1),
  '1 line(s) on Page365 invoice 80004 did not match one website product.');
SELECT pg_temp.eq('sync import: second apply claims nothing',
  (public.page365_apply_stock('cash','60000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000004','{}',NULL)->>'already_claimed')::int, 3);
UPDATE public.cash_orders SET status='cancelled' WHERE id='60000000-0000-0000-0000-000000000004';
SELECT pg_temp.eq('cancel of a record-only order returns nothing', pg_temp.stock('ZP2003'), 2);
UPDATE public.cash_orders SET status='pending' WHERE id='60000000-0000-0000-0000-000000000004';
SELECT pg_temp.eq('revive of a record-only order takes nothing', pg_temp.stock('ZP2003'), 2);

-- 4. The switch: guarded, audited ----------------------------------------
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000001', false);
DO $$ BEGIN
  UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'ZP2004';
  RAISE EXCEPTION 'FAIL switch: a user without manage_website_catalog flipped it';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok  switch: refused without manage_website_catalog';
END $$;
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku IN ('ZP2004', 'ZP2006');
SELECT pg_temp.eq('switch: catalogue staff can flip it', (SELECT count(*) FROM public.website_products WHERE page365_sync_disabled), 2::bigint);
SELECT pg_temp.eq('switch: each flip audited with the actor',
  (SELECT count(*) FROM public.audit_logs WHERE action='page365_sync_switched' AND performed_by_user_id='99999999-0000-0000-0000-000000000002'), 2::bigint);
UPDATE public.website_products SET name = 'Not synced piece.' WHERE sku = 'ZP2004';
SELECT pg_temp.eq('switch: other edits are not audited as flips',
  (SELECT count(*) FROM public.audit_logs WHERE action='page365_sync_switched'), 2::bigint);
SELECT set_config('test.uid', '', false);

-- 5. Switched off: an import never moves stock, even in 'invoice' mode ------
SELECT pg_temp.mode('invoice');
INSERT INTO public.page365_drafts(id, page365_no, payload) VALUES
 ('50000000-0000-0000-0000-000000000005', 80005, '{"items":[{"kind":"product","name":"ZP2004 Necklace","quantity":1}]}'),
 ('50000000-0000-0000-0000-000000000006', 80006, '{"items":[{"kind":"product","name":"ZP2005 Ring","quantity":1}]}');
INSERT INTO public.layaway_accounts(id, invoice_number, customer_id, status, page365_no) VALUES
 ('70000000-0000-0000-0000-000000000005','80005', gen_random_uuid(), 'active', 80005);
INSERT INTO public.cash_orders(id, invoice_number, customer_id, status, page365_no) VALUES
 ('60000000-0000-0000-0000-000000000006','80006', gen_random_uuid(), 'pending', 80006);
SELECT set_config('t.r5', public.page365_apply_stock('layaway','70000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000005','{}',NULL)::text, false);
SELECT pg_temp.eq('switched off: sync_off 1', (current_setting('t.r5')::jsonb->>'sync_off')::int, 1);
SELECT pg_temp.eq('switched off: held 0 even in invoice mode', (current_setting('t.r5')::jsonb->>'held')::int, 0);
SELECT pg_temp.eq('switched off: stock untouched', pg_temp.stock('ZP2004'), 1);
SELECT pg_temp.eq('switched off: match recorded, state none', (pg_temp.line(80005)).match_result || '/' || (pg_temp.line(80005)).stock_state, 'matched/none');

-- 6. Rollback: 'invoice' mode takes and returns stock exactly as #195 -------
SELECT pg_temp.eq('rollback: held 1', (public.page365_apply_stock('cash','60000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000006','{}',NULL)->>'held')::int, 1);
SELECT pg_temp.eq('rollback: stock taken', pg_temp.stock('ZP2005'), 1);
SELECT pg_temp.eq('rollback: line held', (pg_temp.line(80006)).stock_state, 'held');

-- 7. 'invoice' mode fetch still excludes a held variant (PR 1 behaviour) -----
SELECT set_config('t.runI', pg_temp.run(jsonb_build_array(
  pg_temp.p(5, 'ZP2005 Ring', 1)))::text, false);
SELECT pg_temp.eq('invoice mode: held variant excluded', pg_temp.cat(current_setting('t.runI')::uuid, 'ZP2005'), 'matched/excluded/1');
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('invoice mode: apply refuses the held variant',
  (pg_temp.apply_one(current_setting('t.runI')::uuid, (pg_temp.item(current_setting('t.runI')::uuid, 'ZP2005')).id)) , 'invoice_hold');
SELECT set_config('test.uid', '', false);
UPDATE public.cash_orders SET status='cancelled' WHERE id='60000000-0000-0000-0000-000000000006';
SELECT pg_temp.eq('rollback: cancel returns the piece', pg_temp.stock('ZP2005'), 2);
SELECT pg_temp.mode('inventory_sync');

-- 8. The fetch in inventory_sync ------------------------------------------
-- ZP2001: an ABSORBED line on a live unpaid cash order (80001, pending) ->
--         no longer excluded; its piece is an unpaid invoice hold.
-- ZP2003: a page365_master line on a live unpaid cash order (80004).
-- ZP2004: switched off -> not_synced, never proposed, no photos.
-- ZP2006: switched off and absent from Page365 -> not_synced (never "missing").
-- ZP2007: absent from Page365 -> hub_only.
SELECT set_config('t.runA', pg_temp.run(jsonb_build_array(
  pg_temp.p(1, 'ZP2001 Ring', 3),
  pg_temp.p(2, 'ZP2002 Ring', 3),
  pg_temp.p(3, 'ZP2003 Ring', 2),
  pg_temp.p(4, 'ZP2004 Necklace', 0, '[{"id":4001,"version":"1","url":"https://assets.page365.net/photos/original/4001.jpeg?1","position":0}]'),
  pg_temp.p(5, 'ZP2005 Ring', 2)))::text, false);
SELECT pg_temp.eq('fetch: absorbed variant not excluded; unpaid invoice held', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2001'), 'matched/decrease/2');
SELECT pg_temp.eq('fetch: absorbed on live unpaid order counts as an invoice hold', (pg_temp.item(current_setting('t.runA')::uuid, 'ZP2001')).invoice_holds, 1);
SELECT pg_temp.eq('fetch: record-only unpaid invoice held', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2003'), 'matched/decrease/1');
SELECT pg_temp.eq('fetch: released line on a dead order holds nothing', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2002'), 'matched/no_change/3');
SELECT pg_temp.eq('fetch: switched-off product not_synced, never proposed', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2004'), 'matched/not_synced/-');
SELECT pg_temp.eq('fetch: switched-off product has no photos to copy', (pg_temp.item(current_setting('t.runA')::uuid, 'ZP2004')).photos_to_copy, 0);
SELECT pg_temp.eq('fetch: switched-off product never a price difference', (pg_temp.item(current_setting('t.runA')::uuid, 'ZP2004')).price_differs, false);
SELECT pg_temp.eq('fetch: switched-off Hub-only listed as not_synced', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2006'), 'hub_only/not_synced/-');
SELECT pg_temp.eq('fetch: normal Hub-only still hub_only', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2007'), 'hub_only/hub_only/-');
SELECT pg_temp.eq('fetch: cancelled rollback order holds nothing', pg_temp.cat(current_setting('t.runA')::uuid, 'ZP2005'), 'matched/no_change/2');

-- 9. Apply refuses switched-off products, also when flipped AFTER the fetch --
SELECT set_config('test.uid', '99999999-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('apply: not_synced row refused', pg_temp.apply_one(current_setting('t.runA')::uuid, (pg_temp.item(current_setting('t.runA')::uuid, 'ZP2004')).id), 'sync_disabled');
UPDATE public.website_products SET page365_sync_disabled = true WHERE sku = 'ZP2003';
SELECT pg_temp.eq('apply: switch flipped after the fetch is refused', pg_temp.apply_one(current_setting('t.runA')::uuid, (pg_temp.item(current_setting('t.runA')::uuid, 'ZP2003')).id), 'sync_disabled');
SELECT pg_temp.eq('apply: switched-off stock untouched', pg_temp.stock('ZP2003'), 2);
SELECT pg_temp.eq('apply: a synced decrease still applies', pg_temp.apply_one(current_setting('t.runA')::uuid, (pg_temp.item(current_setting('t.runA')::uuid, 'ZP2001')).id), 'applied');
SELECT pg_temp.eq('apply: synced stock written', pg_temp.stock('ZP2001'), 2);
UPDATE public.website_products SET page365_sync_disabled = false WHERE sku = 'ZP2003';
SELECT set_config('test.uid', '', false);

-- 10. Photos never recorded for a switched-off product ---------------------
SELECT pg_temp.eq('photo: switched-off refused',
  public.page365_inventory_record_photo((pg_temp.item(current_setting('t.runA')::uuid, 'ZP2004')).id, 4001, '1',
    'https://hub.example/storage/v1/object/public/promotions/website/page365/4/4001-1.jpeg', NULL, 0, NULL), 'sync_disabled');
SELECT pg_temp.eq('photo: no media row written', (SELECT count(*) FROM public.website_product_media WHERE variant_id = pg_temp.vid('ZP2004')), 0::bigint);
SELECT pg_temp.eq('photo: a synced product still records',
  public.page365_inventory_record_photo((pg_temp.item(current_setting('t.runA')::uuid, 'ZP2002')).id, 2001, '1',
    'https://hub.example/storage/v1/object/public/promotions/website/page365/2/2001-1.jpeg', NULL, 0, NULL), 'inserted');
SELECT pg_temp.eq('photo: second copy is a no-op',
  public.page365_inventory_record_photo((pg_temp.item(current_setting('t.runA')::uuid, 'ZP2002')).id, 2001, '1',
    'https://hub.example/storage/v1/object/public/promotions/website/page365/2/2001-1.jpeg', NULL, 0, NULL), 'exists');

-- 11. page365_hold_unpaid_invoices = false: no invoice subtraction ----------
UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = 'page365_hold_unpaid_invoices';
SELECT set_config('t.runB', pg_temp.run(jsonb_build_array(
  pg_temp.p(1, 'ZP2001 Ring', 3),
  pg_temp.p(3, 'ZP2003 Ring', 2)))::text, false);
SELECT pg_temp.eq('hold off: absorbed piece proposed at Page365 qty', pg_temp.cat(current_setting('t.runB')::uuid, 'ZP2001'), 'matched/increase/3');
SELECT pg_temp.eq('hold off: record-only piece proposed at Page365 qty', pg_temp.cat(current_setting('t.runB')::uuid, 'ZP2003'), 'matched/no_change/2');
UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'page365_hold_unpaid_invoices';

-- 12. Paid order: its piece is no longer an invoice hold ------------------
UPDATE public.cash_orders SET status='completed' WHERE id='60000000-0000-0000-0000-000000000004';
SELECT pg_temp.eq('paid order: no invoice hold', public.page365_invoice_holds(pg_temp.vid('ZP2003')), 0);

SELECT 'ALL PR 2 CHECKS PASSED' AS result;
