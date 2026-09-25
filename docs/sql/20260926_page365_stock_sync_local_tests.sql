-- ============================================================================
-- Page365 stock sync — LOCAL behaviour tests (2026-09-26). Local Postgres only:
-- run after docs/sql/20260926_page365_stock_sync_local_stub.sql and the
-- migration (see the stub's header). Every check RAISEs on failure; the last
-- line prints ALL BEHAVIOUR CHECKS PASSED.
--
-- Covers: first-word matching incl. case/spacing (U+3000, NBSP, tab); exactly
-- one product + one variant; resize/service and CSR-marked service skipped;
-- re-apply never reduces twice; not-enough-stock flags and the order stands;
-- cancel / hourly expiry / forfeit / final forfeit / delete give back; revive
-- and extension re-take, or flag rehold_failed when the piece sold meanwhile;
-- a refused (paid) delete moves nothing; ordinary and pre-feature orders never
-- move stock; web orders are left to the web RPCs; resolve needs the
-- permission and a note and never moves stock; browser roles cannot apply or
-- write the ledger; no stock ever goes negative.
-- ============================================================================

\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;
CREATE OR REPLACE FUNCTION pg_temp.stock(p_sku text) RETURNS integer LANGUAGE sql AS $$
  SELECT v.stock_qty FROM public.website_products p JOIN public.website_product_variants v ON v.product_id=p.id WHERE p.sku=p_sku LIMIT 1 $$;
CREATE OR REPLACE FUNCTION pg_temp.line(p_no bigint, p_line int) RETURNS text LANGUAGE sql AS $$
  SELECT match_result||'/'||stock_state||'/'||coalesce(flag,'-') FROM public.page365_stock_lines WHERE page365_no=p_no AND line_no=p_line $$;

-- Catalogue
INSERT INTO public.website_products(id, sku, status) VALUES
 ('00000000-0000-0000-0000-000000000001','ZT9001','active'),
 ('00000000-0000-0000-0000-000000000002','ZT9002','active'),
 ('00000000-0000-0000-0000-000000000003','ZT9003','active'),
 ('00000000-0000-0000-0000-000000000004','zt9004','archived'),   -- D7 + lower-case code
 ('00000000-0000-0000-0000-000000000005','ZT9005','active'),
 ('00000000-0000-0000-0000-000000000006','ZT9006','active'),
 ('00000000-0000-0000-0000-000000000016','zt9006','active'),     -- case collision
 ('00000000-0000-0000-0000-000000000007','ZT9007','draft'),      -- D7
 ('00000000-0000-0000-0000-000000000011','R11 55','active');     -- inner space: never answers to "R11"
INSERT INTO public.website_product_variants(product_id, stock_qty) VALUES
 ('00000000-0000-0000-0000-000000000001',2),
 ('00000000-0000-0000-0000-000000000002',0),
 ('00000000-0000-0000-0000-000000000003',3),('00000000-0000-0000-0000-000000000003',3),
 ('00000000-0000-0000-0000-000000000004',5),
 ('00000000-0000-0000-0000-000000000006',1),('00000000-0000-0000-0000-000000000016',1),
 ('00000000-0000-0000-0000-000000000007',1),
 ('00000000-0000-0000-0000-000000000011',9);

-- Draft for Page365 invoice 1001
INSERT INTO public.page365_drafts(id, page365_no, payload) VALUES
 ('d0000000-0000-0000-0000-000000001001', 1001, jsonb_build_object('items', jsonb_build_array(
   jsonb_build_object('kind','product','name','ZT9001 Test ring','quantity',1),
   jsonb_build_object('kind','product','name','ZT9002 Test earrings','quantity',1),
   jsonb_build_object('kind','product','name','Necklace test','quantity',1),
   jsonb_build_object('kind','service','name','Resize # 12','quantity',1),
   jsonb_build_object('kind','product','name', E'\u3000 zt9004\u3000ring K18','quantity',2),
   jsonb_build_object('kind','product','name','ZT9003 ring (sizes)','quantity',1),
   jsonb_build_object('kind','product','name','ZT9005 no variant','quantity',1),
   jsonb_build_object('kind','product','name','ZT9006 dup code','quantity',1),
   jsonb_build_object('kind','product','name','R11 thing','quantity',1),
   jsonb_build_object('kind','product','name','ZT9007 CSR marked service','quantity',1)))),
 ('d0000000-0000-0000-0000-000000009999', 9999, '{"items":[{"kind":"product","name":"ZT9001 x","quantity":1}]}');

-- Matcher (fetch preview), no stock change
SELECT pg_temp.eq('match ZT9001', (SELECT o_match_result||':'||o_stock_qty FROM public.page365_match_line('zt9001 lower')), 'matched:2');
SELECT pg_temp.eq('match Necklace', (SELECT o_match_result FROM public.page365_match_line('Necklace K18')), 'unmatched');
SELECT pg_temp.eq('match R11', (SELECT o_match_result FROM public.page365_match_line('R11 55 thing')), 'unmatched');
SELECT pg_temp.eq('preview moved nothing', pg_temp.stock('ZT9001'), 2);

-- Hub cash order imported from 1001
INSERT INTO public.cash_orders(id, invoice_number, customer_id, page365_no) VALUES
 ('c0000000-0000-0000-0000-000000001001','1001','aaaaaaaa-0000-0000-0000-000000000001',1001);
DO $$ BEGIN PERFORM public.page365_apply_stock('shopify','c0000000-0000-0000-0000-000000001001','d0000000-0000-0000-0000-000000001001');
  RAISE EXCEPTION 'FAIL bad kind did not raise'; EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF; RAISE NOTICE 'ok  bad order kind raises'; END $$;
DO $$ BEGIN PERFORM public.page365_apply_stock('cash','c0000000-0000-0000-0000-000000001001','d0000000-0000-0000-0000-000000009999');
  RAISE EXCEPTION 'FAIL draft mismatch did not raise'; EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF; RAISE NOTICE 'ok  draft for another invoice raises: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM public.page365_apply_stock('cash','c0000000-0000-0000-0000-000000001001','d0000000-0000-0000-0000-00000000dead');
  RAISE EXCEPTION 'FAIL missing draft did not raise'; EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF; RAISE NOTICE 'ok  missing draft raises'; END $$;
SELECT pg_temp.eq('nothing claimed by failed calls', (SELECT count(*)::int FROM public.page365_stock_lines), 0);

SELECT public.page365_apply_stock('cash','c0000000-0000-0000-0000-000000001001','d0000000-0000-0000-0000-000000001001', ARRAY[10], NULL) AS r1 \gset
SELECT pg_temp.eq('apply held', (:'r1'::jsonb->>'held')::int, 2);
SELECT pg_temp.eq('apply flagged', (:'r1'::jsonb->>'flagged')::int, 6);
SELECT pg_temp.eq('apply services', (:'r1'::jsonb->>'services')::int, 2);
SELECT pg_temp.eq('L1 ZT9001', pg_temp.line(1001,1), 'matched/held/-');
SELECT pg_temp.eq('L2 sold on web', pg_temp.line(1001,2), 'matched/none/insufficient_stock');
SELECT pg_temp.eq('L3 Necklace', pg_temp.line(1001,3), 'unmatched/none/unmatched');
SELECT pg_temp.eq('L4 resize skipped', pg_temp.line(1001,4), 'not_a_product/none/-');
SELECT pg_temp.eq('L5 spacing+case+archived', pg_temp.line(1001,5), 'matched/held/-');
SELECT pg_temp.eq('L6 two sizes', pg_temp.line(1001,6), 'ambiguous_variant/none/ambiguous_variant');
SELECT pg_temp.eq('L7 no variant', pg_temp.line(1001,7), 'no_variant/none/no_variant');
SELECT pg_temp.eq('L8 case collision', pg_temp.line(1001,8), 'ambiguous_sku/none/ambiguous_sku');
SELECT pg_temp.eq('L9 R11', pg_temp.line(1001,9), 'unmatched/none/unmatched');
SELECT pg_temp.eq('L10 CSR service', pg_temp.line(1001,10), 'not_a_product/none/-');
SELECT pg_temp.eq('stock ZT9001 2->1', pg_temp.stock('ZT9001'), 1);
SELECT pg_temp.eq('stock zt9004 5->3', pg_temp.stock('zt9004'), 3);
SELECT pg_temp.eq('stock ZT9002 stays 0', pg_temp.stock('ZT9002'), 0);
SELECT pg_temp.eq('stock ZT9007 untouched (service)', pg_temp.stock('ZT9007'), 1);
SELECT pg_temp.eq('stock_seen recorded', (SELECT stock_seen FROM public.page365_stock_lines WHERE page365_no=1001 AND line_no=2), 0);
SELECT pg_temp.eq('one bell', (SELECT count(*)::int FROM public.staff_notifications WHERE type='page365_stock_flag'), 1);
SELECT pg_temp.eq('bell carries cash_order_id', (SELECT metadata->>'cash_order_id' FROM public.staff_notifications WHERE type='page365_stock_flag'), 'c0000000-0000-0000-0000-000000001001');
SELECT pg_temp.eq('storefront notified', (SELECT count(*)::int FROM public.revalidations) >= 2, true);

-- NEVER TWICE
SELECT public.page365_apply_stock('cash','c0000000-0000-0000-0000-000000001001','d0000000-0000-0000-0000-000000001001') AS r2 \gset
SELECT pg_temp.eq('re-apply claims nothing', (:'r2'::jsonb->>'already_claimed')::int, 10);
SELECT pg_temp.eq('re-apply held 0', (:'r2'::jsonb->>'held')::int, 0);
SELECT pg_temp.eq('re-apply no second bell', (SELECT count(*)::int FROM public.staff_notifications), 1);
SELECT pg_temp.eq('ZT9001 still 1', pg_temp.stock('ZT9001'), 1);

-- Unrelated status change does nothing; cancel returns stock
UPDATE public.cash_orders SET invoice_number='1001' WHERE id='c0000000-0000-0000-0000-000000001001';
UPDATE public.cash_orders SET status='cancelled' WHERE id='c0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('cancel ZT9001 1->2', pg_temp.stock('ZT9001'), 2);
SELECT pg_temp.eq('cancel zt9004 3->5', pg_temp.stock('zt9004'), 5);
SELECT pg_temp.eq('cancel ZT9002 unchanged', pg_temp.stock('ZT9002'), 0);
SELECT pg_temp.eq('L1 released', pg_temp.line(1001,1), 'matched/released/-');
UPDATE public.cash_orders SET status='expired' WHERE id='c0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('dead->dead no double return', pg_temp.stock('ZT9001'), 2);

-- Revive takes again
UPDATE public.cash_orders SET status='pending' WHERE id='c0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('revive ZT9001 2->1', pg_temp.stock('ZT9001'), 1);
SELECT pg_temp.eq('revive zt9004 5->3', pg_temp.stock('zt9004'), 3);
SELECT pg_temp.eq('revive leaves never-held line alone', pg_temp.line(1001,2), 'matched/none/insufficient_stock');
-- Hourly expiry (D3) returns
UPDATE public.cash_orders SET status='expired' WHERE id='c0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('expire ZT9001 1->2', pg_temp.stock('ZT9001'), 2);
-- The piece sells on the website meanwhile; revive flags, never raises, never negative
UPDATE public.website_product_variants SET stock_qty=0 WHERE product_id='00000000-0000-0000-0000-000000000001';
UPDATE public.cash_orders SET status='pending' WHERE id='c0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('revive status stands', (SELECT status::text FROM public.cash_orders WHERE id='c0000000-0000-0000-0000-000000001001'), 'pending');
SELECT pg_temp.eq('L1 rehold_failed', pg_temp.line(1001,1), 'matched/released/rehold_failed');
SELECT pg_temp.eq('ZT9001 stays 0', pg_temp.stock('ZT9001'), 0);
SELECT pg_temp.eq('L5 reheld', pg_temp.line(1001,5), 'matched/held/-');
SELECT pg_temp.eq('second bell (rehold)', (SELECT count(*)::int FROM public.staff_notifications), 2);

-- Delete (unpaid) returns what is held; line 1 was never re-held so nothing for it
UPDATE public.website_product_variants SET stock_qty=0 WHERE product_id='00000000-0000-0000-0000-000000000004';
DELETE FROM public.cash_orders WHERE id='c0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('delete returns zt9004 0->2', pg_temp.stock('zt9004'), 2);
SELECT pg_temp.eq('delete: ZT9001 still 0', pg_temp.stock('ZT9001'), 0);
SELECT pg_temp.eq('ledger kept, orphaned', (SELECT count(*)::int FROM public.page365_stock_lines WHERE page365_no=1001 AND cash_order_id IS NULL), 10);

-- Re-import after a delete re-claims (stock was given back, so this is still once)
UPDATE public.website_product_variants SET stock_qty=2 WHERE product_id='00000000-0000-0000-0000-000000000001';
INSERT INTO public.layaway_accounts(id, invoice_number, customer_id, page365_no) VALUES
 ('a0000000-0000-0000-0000-000000001001','1001','aaaaaaaa-0000-0000-0000-000000000001',1001);
SELECT public.page365_apply_stock('layaway','a0000000-0000-0000-0000-000000001001','d0000000-0000-0000-0000-000000001001') AS r3 \gset
SELECT pg_temp.eq('re-import held (L1, L5, L10)', (:'r3'::jsonb->>'held')::int, 3);
SELECT pg_temp.eq('re-import ZT9001 2->1', pg_temp.stock('ZT9001'), 1);
SELECT pg_temp.eq('re-import zt9004 2->0', pg_temp.stock('zt9004'), 0);
SELECT pg_temp.eq('re-import L10 now product (no service list)', pg_temp.line(1001,10), 'matched/held/-');
SELECT pg_temp.eq('ZT9007 1->0', pg_temp.stock('ZT9007'), 0);
SELECT pg_temp.eq('lines point at the layaway', (SELECT count(*)::int FROM public.page365_stock_lines WHERE account_id='a0000000-0000-0000-0000-000000001001'), 10);

-- Layaway lifecycle (D4): forfeit returns, extension re-holds, final_forfeited returns
UPDATE public.layaway_accounts SET status='overdue' WHERE id='a0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('overdue moves nothing', pg_temp.stock('ZT9001'), 1);
UPDATE public.layaway_accounts SET status='forfeited' WHERE id='a0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('forfeit ZT9001 1->2', pg_temp.stock('ZT9001'), 2);
SELECT pg_temp.eq('forfeit ZT9007 0->1', pg_temp.stock('ZT9007'), 1);
UPDATE public.layaway_accounts SET status='extension_active' WHERE id='a0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('extension ZT9001 2->1', pg_temp.stock('ZT9001'), 1);
UPDATE public.layaway_accounts SET status='final_forfeited' WHERE id='a0000000-0000-0000-0000-000000001001';
SELECT pg_temp.eq('final_forfeited ZT9001 1->2', pg_temp.stock('ZT9001'), 2);
SELECT pg_temp.eq('final_forfeited zt9004 0->2', pg_temp.stock('zt9004'), 2);

-- Paid order delete is refused and moves no stock
INSERT INTO public.page365_drafts(id, page365_no, payload) VALUES
 ('d0000000-0000-0000-0000-000000002002', 2002, '{"items":[{"kind":"product","name":"ZT9001 ring","quantity":1}]}');
INSERT INTO public.cash_orders(id, invoice_number, customer_id, page365_no, total_paid) VALUES
 ('c0000000-0000-0000-0000-000000002002','2002','aaaaaaaa-0000-0000-0000-000000000001',2002, 0);
SELECT public.page365_apply_stock('cash','c0000000-0000-0000-0000-000000002002','d0000000-0000-0000-0000-000000002002') \gset r4_
SELECT pg_temp.eq('2002 took ZT9001 2->1', pg_temp.stock('ZT9001'), 1);
UPDATE public.cash_orders SET total_paid=100 WHERE id='c0000000-0000-0000-0000-000000002002';
DO $$ BEGIN DELETE FROM public.cash_orders WHERE id='c0000000-0000-0000-0000-000000002002';
  RAISE EXCEPTION 'FAIL paid delete allowed'; EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF; END $$;
SELECT pg_temp.eq('refused delete moved nothing', pg_temp.stock('ZT9001'), 1);
SELECT pg_temp.eq('refused delete: still held', pg_temp.line(2002,1), 'matched/held/-');
-- completed is alive: nothing moves
UPDATE public.cash_orders SET status='completed' WHERE id='c0000000-0000-0000-0000-000000002002';
SELECT pg_temp.eq('completed keeps stock taken', pg_temp.stock('ZT9001'), 1);

-- Ordinary staff orders never move stock; a pre-feature Page365 order neither
INSERT INTO public.cash_orders(id, invoice_number, customer_id) VALUES ('c0000000-0000-0000-0000-000000000077','77','aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.cash_orders(id, invoice_number, customer_id, page365_no) VALUES ('c0000000-0000-0000-0000-000000000078','78','aaaaaaaa-0000-0000-0000-000000000001',7878);
INSERT INTO public.layaway_accounts(id, invoice_number, customer_id) VALUES ('a0000000-0000-0000-0000-000000000079','79','aaaaaaaa-0000-0000-0000-000000000001');
SELECT sum(stock_qty) AS before_total FROM public.website_product_variants \gset
UPDATE public.cash_orders SET status='cancelled' WHERE id IN ('c0000000-0000-0000-0000-000000000077','c0000000-0000-0000-0000-000000000078');
UPDATE public.cash_orders SET status='pending'   WHERE id IN ('c0000000-0000-0000-0000-000000000077','c0000000-0000-0000-0000-000000000078');
UPDATE public.layaway_accounts SET status='forfeited' WHERE id='a0000000-0000-0000-0000-000000000079';
DELETE FROM public.cash_orders WHERE id IN ('c0000000-0000-0000-0000-000000000077','c0000000-0000-0000-0000-000000000078');
DELETE FROM public.layaway_accounts WHERE id='a0000000-0000-0000-0000-000000000079';
SELECT pg_temp.eq('ordinary/pre-feature orders moved nothing', (SELECT sum(stock_qty) FROM public.website_product_variants), :'before_total'::bigint);

-- Website checkout pattern is unchanged (still a plain conditional decrement the trigger never sees)
INSERT INTO public.cash_orders(id, invoice_number, customer_id, source_channel) VALUES ('c0000000-0000-0000-0000-0000000000e1','W1','aaaaaaaa-0000-0000-0000-000000000001','web');
UPDATE public.website_product_variants SET stock_qty = stock_qty - 1 WHERE product_id='00000000-0000-0000-0000-000000000011' AND stock_qty >= 1;
UPDATE public.cash_orders SET status='cancelled' WHERE id='c0000000-0000-0000-0000-0000000000e1';
SELECT pg_temp.eq('web order: trigger leaves stock to the web RPCs', pg_temp.stock('R11 55'), 8);

-- Resolve
SELECT pg_temp.eq('resolve without login', (public.resolve_page365_stock_flag((SELECT id FROM public.page365_stock_lines WHERE page365_no=1001 AND line_no=3), 'x'))->>'reason', 'forbidden');
SELECT set_config('test.uid','11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.user_roles VALUES ('11111111-0000-0000-0000-000000000001','csr');
SELECT pg_temp.eq('resolve without permission', (public.resolve_page365_stock_flag((SELECT id FROM public.page365_stock_lines WHERE page365_no=1001 AND line_no=3), 'x'))->>'reason', 'forbidden');
INSERT INTO public.perm VALUES ('11111111-0000-0000-0000-000000000001','manage_website_catalog');
SELECT pg_temp.eq('resolve empty note', (public.resolve_page365_stock_flag((SELECT id FROM public.page365_stock_lines WHERE page365_no=1001 AND line_no=3), '  '))->>'reason', 'note_required');
SELECT sum(stock_qty) AS before_resolve FROM public.website_product_variants \gset
SELECT pg_temp.eq('resolve ok', (public.resolve_page365_stock_flag((SELECT id FROM public.page365_stock_lines WHERE page365_no=1001 AND line_no=3), 'Adjusted on Page365'))->>'ok', 'true');
SELECT pg_temp.eq('resolve twice', (public.resolve_page365_stock_flag((SELECT id FROM public.page365_stock_lines WHERE page365_no=1001 AND line_no=3), 'again'))->>'reason', 'not_open');
SELECT pg_temp.eq('resolve moved no stock', (SELECT sum(stock_qty) FROM public.website_product_variants), :'before_resolve'::bigint);
SELECT pg_temp.eq('resolve audited', (SELECT count(*)::int FROM public.audit_logs WHERE action='page365_stock_flag_resolved'), 1);

-- Browser roles
SET ROLE authenticated;
DO $$ BEGIN PERFORM public.page365_apply_stock('cash','c0000000-0000-0000-0000-000000002002','d0000000-0000-0000-0000-000000002002');
  RAISE EXCEPTION 'FAIL authenticated could apply'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok  authenticated cannot apply'; END $$;
DO $$ BEGIN INSERT INTO public.page365_stock_lines(page365_no,line_no,line_name,quantity,match_result) VALUES (1,1,'x',1,'pending');
  RAISE EXCEPTION 'FAIL authenticated could insert'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok  authenticated cannot write the ledger'; END $$;
SELECT pg_temp.eq('staff reads the ledger', (SELECT count(*)::int > 0 FROM public.page365_stock_lines), true);
SELECT set_config('test.uid','22222222-0000-0000-0000-000000000002', false);
SELECT pg_temp.eq('non-staff reads nothing', (SELECT count(*)::int FROM public.page365_stock_lines), 0);
RESET ROLE;
SELECT pg_temp.eq('no negative stock anywhere', (SELECT count(*)::int FROM public.website_product_variants WHERE stock_qty < 0), 0);
\echo ALL BEHAVIOUR CHECKS PASSED
