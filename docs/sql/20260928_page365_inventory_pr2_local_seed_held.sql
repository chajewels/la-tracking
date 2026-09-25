-- ============================================================================
-- Page365 inventory PR 2 — LOCAL seed (2026-09-28). NEVER RUN THIS ON LIVE.
--
-- Builds the state live is in BEFORE PR 2: Page365 invoices imported under
-- #195, so page365_stock_lines holds real 'held' lines (and one 'released'
-- line), each made by the #195 page365_apply_stock itself. Run after the #195
-- and PR 1 migrations and BEFORE 20260928100000_page365_inventory_pr2.sql —
-- see docs/sql/20260928_page365_inventory_pr2_local_stub.sql for the order.
-- ============================================================================
\set ON_ERROR_STOP 1
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes''';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
END
$guard$;

INSERT INTO public.website_products(id, sku, name, status) VALUES
 ('40000000-0000-0000-0000-000000000001','ZP2001','Absorbed piece','active'),
 ('40000000-0000-0000-0000-000000000002','ZP2002','Released piece','active');
INSERT INTO public.website_product_variants(product_id, stock_qty, price_jpy) VALUES
 ('40000000-0000-0000-0000-000000000001', 5, 10000),
 ('40000000-0000-0000-0000-000000000002', 3, 10000);

INSERT INTO public.page365_drafts(id, page365_no, payload) VALUES
 ('50000000-0000-0000-0000-000000000001', 80001, '{"items":[{"kind":"product","name":"ZP2001 Ring K18","quantity":1}]}'),
 ('50000000-0000-0000-0000-000000000002', 80002, '{"items":[{"kind":"product","name":"ZP2002 Ring K18","quantity":1}]}'),
 ('50000000-0000-0000-0000-000000000003', 80003, '{"items":[{"kind":"product","name":"ZP2001 Ring K18","quantity":1}]}');
INSERT INTO public.cash_orders(id, invoice_number, customer_id, status, page365_no) VALUES
 ('60000000-0000-0000-0000-000000000001','80001', gen_random_uuid(), 'pending', 80001),
 ('60000000-0000-0000-0000-000000000003','80003', gen_random_uuid(), 'pending', 80003);
INSERT INTO public.layaway_accounts(id, invoice_number, customer_id, status, page365_no) VALUES
 ('70000000-0000-0000-0000-000000000002','80002', gen_random_uuid(), 'active', 80002);

SELECT public.page365_apply_stock('cash',    '60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '{}', NULL);
SELECT public.page365_apply_stock('layaway', '70000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', '{}', NULL);
SELECT public.page365_apply_stock('cash',    '60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003', '{}', NULL);
-- The layaway is cancelled under #195: its line is released, its piece back.
UPDATE public.layaway_accounts SET status = 'cancelled' WHERE id = '70000000-0000-0000-0000-000000000002';

DO $check$
BEGIN
  IF (SELECT count(*) FROM public.page365_stock_lines WHERE stock_state = 'held') <> 2
     OR (SELECT count(*) FROM public.page365_stock_lines WHERE stock_state = 'released') <> 1
     OR (SELECT v.stock_qty FROM public.website_product_variants v WHERE v.product_id = '40000000-0000-0000-0000-000000000001') <> 3
     OR (SELECT v.stock_qty FROM public.website_product_variants v WHERE v.product_id = '40000000-0000-0000-0000-000000000002') <> 3 THEN
    RAISE EXCEPTION 'seed: the #195 state is not as expected';
  END IF;
  RAISE NOTICE 'seed: 2 held lines (ZP2001 5 -> 3), 1 released line (ZP2002 back to 3)';
END
$check$;
