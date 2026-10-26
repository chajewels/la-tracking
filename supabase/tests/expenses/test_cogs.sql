\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Phase 5: real cost of goods. Runs on a fresh copy after stubs + Phases 1–5 (sets its own ledger start).

-- Fixtures: a variant with a cost and one without; plans / orders with first payments in 2026-06.
INSERT INTO public.website_product_variants (id, cost_basis, stock_qty) VALUES
  ('50000000-0000-0000-0000-000000000001', 12000, 3),
  ('50000000-0000-0000-0000-000000000002', NULL, 2);
INSERT INTO public.layaway_accounts (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('10000000-0000-0000-0000-000000000001', 'LA-ITEMS',   'JPY', 60000, 20000, 40000, 'active', '2026-06-01'),
  ('10000000-0000-0000-0000-000000000002', 'LA-NOCOST',  'PHP', 20000, 5000, 15000, 'active', '2026-06-02'),
  ('10000000-0000-0000-0000-000000000003', 'LA-MANUAL',  'JPY', 90000, 30000, 60000, 'active', '2026-06-03'),
  ('10000000-0000-0000-0000-000000000004', 'LA-PRE',     'JPY', 50000, 50000, 0, 'completed', '2026-03-01'),
  ('10000000-0000-0000-0000-000000000005', 'LA-TEST',    'JPY', 999, 999, 0, 'completed', '2026-06-01');
UPDATE public.layaway_accounts SET is_test = true WHERE invoice_number = 'LA-TEST';
INSERT INTO public.payments (account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('10000000-0000-0000-0000-000000000001', 20000, 'JPY', '2026-06-01', 'Rakuten Bank'),
  ('10000000-0000-0000-0000-000000000002', 5000,  'PHP', '2026-06-02', 'bdo'),
  ('10000000-0000-0000-0000-000000000003', 30000, 'JPY', '2026-06-03', 'cash'),
  ('10000000-0000-0000-0000-000000000004', 50000, 'JPY', '2026-03-01', 'cash'),
  ('10000000-0000-0000-0000-000000000005', 999,   'JPY', '2026-06-01', 'cash');
INSERT INTO public.cash_orders (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, item_description) VALUES
  ('30000000-0000-0000-0000-000000000001', 'CO-1', 'JPY', 25000, 25000, 0, 'completed', '2026-06-10', 'Gold chain 18K');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('30000000-0000-0000-0000-000000000001', 25000, 'JPY', '2026-06-10', 'cash');

-- C1 item snapshot: lives in the finance-only sale_item_costs table, copied from the variant at insert
-- (a client cannot set it), immutable; a variant that gets its cost later fills the snapshot (catch-up).
DO $t$ DECLARE lid uuid; BEGIN
  INSERT INTO public.layaway_account_items (account_id, variant_id, title, quantity) VALUES
    ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Ring with cost', 2) RETURNING id INTO lid;
  ASSERT (SELECT cost_jpy FROM public.sale_item_costs WHERE item_id = lid) = 12000, 'snapshot from variant';
  ASSERT (SELECT quantity FROM public.sale_item_costs WHERE item_id = lid) = 2, 'quantity copied';
  ASSERT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name IN ('layaway_account_items', 'cash_order_items') AND column_name = 'cost_jpy'), 'no cost column on the customer-readable tables';
  INSERT INTO public.layaway_account_items (account_id, variant_id, title, quantity) VALUES
    ('10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 'Ring without cost', 1);
  ASSERT (SELECT count(*) FROM public.sale_item_costs WHERE sale_id = '10000000-0000-0000-0000-000000000002') = 0, 'no cost on the variant -> no snapshot';
  UPDATE public.website_product_variants SET cost_basis = 99999 WHERE id = '50000000-0000-0000-0000-000000000001';
  ASSERT (SELECT cost_jpy FROM public.sale_item_costs WHERE item_id = lid) = 12000, 'later cost-basis change does not touch the snapshot';
  UPDATE public.website_product_variants SET cost_basis = 12000 WHERE id = '50000000-0000-0000-0000-000000000001';
  UPDATE public.layaway_account_items SET quantity = 3 WHERE id = lid;
  ASSERT (SELECT quantity FROM public.sale_item_costs WHERE item_id = lid) = 3, 'quantity follows the line';
  UPDATE public.layaway_account_items SET quantity = 2 WHERE id = lid;
  ASSERT (SELECT cost_jpy FROM public.gl_sale_costs() WHERE sale_type = 'layaway' AND sale_id = '10000000-0000-0000-0000-000000000001') = 24000, 'sale cost = Σ unit cost × qty';
  ASSERT (SELECT cost_source FROM public.gl_sale_costs() WHERE sale_type = 'layaway' AND sale_id = '10000000-0000-0000-0000-000000000001') = 'items', 'source items';
  ASSERT (SELECT cost_jpy FROM public.gl_sale_costs() WHERE sale_type = 'layaway' AND sale_id = '10000000-0000-0000-0000-000000000002') IS NULL, 'a costless line leaves the sale missing';
  UPDATE public.website_product_variants SET cost_basis = 5000 WHERE id = '50000000-0000-0000-0000-000000000002';
  ASSERT (SELECT cost_jpy FROM public.gl_sale_costs() WHERE sale_type = 'layaway' AND sale_id = '10000000-0000-0000-0000-000000000002') = 5000, 'variant gets a cost later -> existing line is costed (catch-up / backfill path)';
  UPDATE public.website_product_variants SET cost_basis = NULL WHERE id = '50000000-0000-0000-0000-000000000002';
  ASSERT (SELECT cost_jpy FROM public.gl_sale_costs() WHERE sale_type = 'layaway' AND sale_id = '10000000-0000-0000-0000-000000000002') = 5000, 'snapshot survives the variant losing its cost';
  DELETE FROM public.sale_item_costs WHERE sale_id = '10000000-0000-0000-0000-000000000002';
  ASSERT (SELECT gl_account_code FROM public.expense_categories WHERE name LIKE 'Inventory purchases%') = '1300', 'purchases now go to inventory';
  ASSERT (SELECT gl_account_code FROM public.expense_categories WHERE system_key = 'trade_in') = '1310', 'trade-in buybacks to trade-in inventory';
  ASSERT (SELECT count(*) FROM public.gl_accounts WHERE code IN ('1104','1195','2700','2750','2800','2900','6950')) = 7, 'accountant accounts seeded';
  RAISE NOTICE 'C1 item snapshot / remap OK';
END $t$;

-- C2 permissions: staff and finance see nothing and cannot set; admin can.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_sales_costs('2026-06-01'); ASSERT r->>'error' = 'permission_denied', 'staff list';
  r := public.get_inventory_valuation(); ASSERT r->>'error' = 'permission_denied', 'staff valuation';
  r := public.fc_real_profit(); ASSERT r->>'error' = 'permission_denied', 'staff profit';
  ASSERT (SELECT count(*) FROM public.sale_item_costs) = 0, 'RLS hides item cost snapshots from staff';
  BEGIN
    INSERT INTO public.sale_item_costs (item_table, item_id, sale_type, sale_id, cost_jpy) VALUES ('cash_order_items', gen_random_uuid(), 'cash_order', '30000000-0000-0000-0000-000000000001', 1);
    RAISE EXCEPTION 'snapshot table write should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', 1000); ASSERT r->>'ok' = 'true', 'the stub staff user holds a manage_expenses override, so setting is allowed (D6: manage_expenses sets)';
  ASSERT (SELECT count(*) FROM public.sale_costs) = 0, 'RLS still hides sale costs without view_ledger';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', NULL); ASSERT r->>'cleared' = 'true', 'cleared again';
  RAISE NOTICE 'C2 permissions OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_sales_costs('2026-06-01'); ASSERT r->>'error' = 'permission_denied', 'finance has no view_ledger';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', 1000); ASSERT r->>'error' = 'permission_denied', 'finance cannot set';
  r := public.import_sale_costs('[{"invoice_number":"LA-MANUAL","cost_jpy":1}]'); ASSERT r->>'error' = 'permission_denied', 'finance cannot import';
  BEGIN
    INSERT INTO public.sale_costs (sale_type, sale_id, cost_jpy) VALUES ('layaway', '10000000-0000-0000-0000-000000000003', 1);
    RAISE EXCEPTION 'table write should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'C2b table writes revoked OK';
END $t$;

-- C3 admin: list, set, clear, validation, import.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; m jsonb; BEGIN
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'ledger start: ' || r::text;
  r := public.get_sales_costs('2026-06-01');
  ASSERT jsonb_array_length(r->'sales') = 4, 'four sales booked in June (test plan excluded): ' || r::text;
  ASSERT (r->>'missing_count')::int = 3, 'items plan has a cost, three missing: ' || r::text;
  ASSERT (r->>'can_set') = 'true', 'admin can set';
  SELECT x INTO m FROM jsonb_array_elements(r->'sales') x WHERE x->>'invoice_number' = 'CO-1';
  ASSERT m->'items'->0->>'title' = 'Gold chain 18K', 'cash order description shown as an item';
  SELECT x INTO m FROM jsonb_array_elements(r->'sales') x WHERE x->>'invoice_number' = 'LA-ITEMS';
  ASSERT (m->>'cost_jpy')::numeric = 24000 AND m->>'cost_source' = 'items', 'items cost shown';

  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', 45000.5); ASSERT r->>'error' = 'invalid_amount', 'whole yen only';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', -1); ASSERT r->>'error' = 'invalid_amount', 'no negatives';
  r := public.set_sale_cost('order', '10000000-0000-0000-0000-000000000003', 1); ASSERT r->>'error' = 'invalid_sale', 'type checked';
  r := public.set_sale_cost('layaway', gen_random_uuid(), 1); ASSERT r->>'error' = 'not_found', 'unknown sale';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000005', 1); ASSERT r->>'error' = 'not_found', 'test plans are not costed';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', 45000, 'supplier invoice 77'); ASSERT r->>'ok' = 'true', 'set: ' || r::text;
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'sale_cost' AND action = 'set_sale_cost' AND performed_by_user_id = '00000000-0000-0000-0000-00000000000a') = 1, 'audited';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'sale_cost' AND action = 'clear_sale_cost') = 1, 'clearing audited too (C2)';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000001', 20000); ASSERT r->>'ok' = 'true', 'manual overrides items';
  SELECT x INTO m FROM jsonb_array_elements(public.get_sales_costs('2026-06-01')->'sales') x WHERE x->>'invoice_number' = 'LA-ITEMS';
  ASSERT (m->>'cost_jpy')::numeric = 20000 AND m->>'cost_source' = 'manual', 'manual wins over items: ' || m::text;
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000001', NULL); ASSERT r->>'ok' = 'true' AND r->>'cleared' = 'true', 'cleared';
  SELECT x INTO m FROM jsonb_array_elements(public.get_sales_costs('2026-06-01')->'sales') x WHERE x->>'invoice_number' = 'LA-ITEMS';
  ASSERT (m->>'cost_jpy')::numeric = 24000 AND m->>'cost_source' = 'items', 'back to items after clearing';

  r := public.import_sale_costs('[{"invoice_number":"CO-1","cost_jpy":"¥9,000"},{"invoice_number":"LA-MANUAL","cost_jpy":"46000","note":"corrected"},{"invoice_number":"NOPE","cost_jpy":"1"},{"invoice_number":"LA-NOCOST","cost_jpy":"abc"},{"invoice_number":"LA-TEST","cost_jpy":"5"}]');
  ASSERT r->>'ok' = 'true' AND (r->>'set')::int = 1 AND (r->>'replaced')::int = 1, 'import counts: ' || r::text;
  ASSERT r->'not_found' = '["NOPE", "LA-TEST"]'::jsonb, 'not found (test plan is invisible): ' || r::text;
  ASSERT r->'invalid' = '["LA-NOCOST"]'::jsonb, 'invalid amount reported: ' || r::text;
  ASSERT (SELECT cost_jpy FROM public.sale_costs WHERE sale_type = 'cash_order') = 9000, 'currency symbols and commas stripped';
  ASSERT (SELECT cost_jpy FROM public.sale_costs WHERE sale_type = 'layaway' AND sale_id = '10000000-0000-0000-0000-000000000003') = 46000, 'replaced';
  r := public.import_sale_costs('[]'); ASSERT r->>'error' = 'invalid_rows', 'empty import refused';
  RAISE NOTICE 'C3 set / clear / import OK';
END $t$;

-- C4 ledger: cogs_sale posts for costed sales only, balanced, in yen; change re-posts; missing posts nothing.
DO $t$ DECLARE r jsonb; jr record; BEGIN
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post: ' || r::text;
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'cogs_sale' AND kind = 'auto' AND status = 'posted') = 3, 'three costed sales (items 24000, manual 46000, cash 9000)';
  ASSERT (SELECT sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'cogs_sale' AND j.status = 'posted' AND l.account_code = '5100') = 79000, 'Dr 5100 total';
  ASSERT (SELECT sum(l.credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'cogs_sale' AND j.status = 'posted' AND l.account_code = '1300') = 79000, 'Cr 1300 total';
  SELECT * INTO jr FROM public.gl_journals WHERE source_type = 'cogs_sale' AND description LIKE '%LA-MANUAL' AND status = 'posted';
  ASSERT jr.entry_date = '2026-06-03', 'dated at the sale (first payment)';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals WHERE source_type = 'cogs_sale' AND description LIKE '%LA-NOCOST'), 'no cost -> no journal';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals WHERE source_type = 'cogs_sale' AND description LIKE '%LA-PRE'), 'before the ledger start -> nothing';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 0 AND (r->>'reversed')::int = 0, 'idempotent: ' || r::text;

  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000003', 50000); ASSERT r->>'ok' = 'true', 'change';
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 1 AND (r->>'posted')::int = 1, 'change -> reversal + repost: ' || r::text;
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '5100') = 83000, '5100 balance after the change';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1300') = -83000, '1300 balance mirrors';

  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000002', 7000); ASSERT r->>'ok' = 'true', 'PHP plan gets a yen cost';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 1, 'late cost posts once';
  r := public.get_sales_costs('2026-06-01'); ASSERT (r->>'missing_count')::int = 0, 'nothing missing now: ' || r::text;
  ASSERT (r->>'cost_jpy')::numeric = 90000, 'month cost total 24000 + 50000 + 7000 + 9000';
  RAISE NOTICE 'C4 cogs_sale postings OK';
END $t$;

-- C5 forfeiture returns the piece: cogs_return dated on the close.
RESET ROLE;
UPDATE public.layaway_accounts SET status = 'forfeited', forfeited_at = '2026-08-15 03:00+00', remaining_balance = 60000 WHERE invoice_number = 'LA-MANUAL';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post after forfeiture: ' || r::text;
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'cogs_return' AND status = 'posted') = 1, 'one return';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'cogs_return' AND l.account_code = '1300') = 50000, 'piece back at its cost';
  ASSERT (SELECT entry_date FROM public.gl_journals WHERE source_type = 'cogs_return') = '2026-08-15', 'dated at the forfeiture';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1300') = -40000, '1300 after the return: −(24000 + 7000 + 9000)';
END $t$;
RESET ROLE;
UPDATE public.layaway_accounts SET forfeited_at = NULL, updated_at = '2026-09-01 03:00+00' WHERE invoice_number = 'LA-MANUAL';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 0 AND (r->>'posted')::int = 0, 'a moved updated_at on a legacy forfeited plan does not churn cogs_return: ' || r::text;
  RAISE NOTICE 'C5 cogs_return OK';
END $t$;

-- C6 purchases to inventory; trade-ins received and resold.
DO $t$ DECLARE r jsonb; cat uuid; e uuid; t uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE name LIKE 'Inventory purchases%';
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-20', 'category_id', cat, 'description', 'Gold from supplier', 'currency', 'JPY', 'amount', '300000', 'payment_method', 'bank_transfer', 'paid_from', '1102'));
  ASSERT r->>'ok' = 'true', 'purchase draft: ' || r::text;
  e := (r->'expense'->>'id')::uuid;
  r := public.approve_expense(e); ASSERT r->>'ok' = 'true', 'approved: ' || r::text;
END $t$;
RESET ROLE;
INSERT INTO public.trade_ins (id, date_trade, old_invoice_number, new_invoice_number, item_code, item_description, trade_amount)
VALUES ('60000000-0000-0000-0000-000000000001', '2026-06-25', '19001', '19050', 'TI-1', 'Old 18K bracelet', 40000);
INSERT INTO public.trade_ins (date_trade, old_invoice_number, item_code, item_description, trade_amount, resale_status, resold_at)
VALUES ('2026-02-01', '18000', 'TI-OLD', 'Before the start', 10000, 'Sold', '2026-03-01 00:00+09');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; t uuid := '60000000-0000-0000-0000-000000000001'; BEGIN
  ASSERT (SELECT resold_at FROM public.trade_ins WHERE item_code = 'TI-OLD') = '2026-03-01 00:00+09', 'an explicit resold_at is kept';
  ASSERT (SELECT resold_at FROM public.trade_ins WHERE item_code = 'TI-1') IS NULL, 'in stock has no resold_at';
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post purchases / trade-ins: ' || r::text;
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'expense' AND l.account_code = '1300') = 300000, 'purchase debits inventory, not cost';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'expense' AND l.account_code = '5100'), 'nothing to 5100 from the purchase';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'trade_in_received' AND status = 'posted') = 1, 'one trade-in received (the old one is before the start)';
  ASSERT (SELECT l.credit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'trade_in_received' AND l.account_code = '4100') = 40000, 'revenue grossed up by the trade credit';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'trade_in_received' AND l.account_code = '1310') = 40000, 'trade-in inventory up';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals WHERE source_type = 'trade_in_resold'), 'nothing resold yet in the window';
END $t$;
RESET ROLE;
INSERT INTO public.layaway_accounts (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('10000000-0000-0000-0000-000000000007', 'LA-RESALE', 'JPY', 55000, 55000, 0, 'completed', '2026-07-10');
INSERT INTO public.payments (account_id, amount_paid, currency, date_paid, payment_method) VALUES ('10000000-0000-0000-0000-000000000007', 55000, 'JPY', '2026-07-10', 'cash');
UPDATE public.trade_ins SET resale_status = 'Sold', resale_amount = 55000, resold_invoice_number = 'LA-RESALE', resold_at = '2026-01-01 00:00+09' WHERE id = '60000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; m jsonb; t uuid := '60000000-0000-0000-0000-000000000001'; BEGIN
  ASSERT (SELECT resold_at FROM public.trade_ins WHERE id = t) >= '2026-10-01', 'resold_at is stamped by the trigger on the flip, not taken from the client';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 3, 'resale posts 5500 plus the new plan''s sale and payment, no cogs_sale: ' || r::text;
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'trade_in_resold' AND l.account_code = '5500') = 40000, 'cost of the resold trade-in';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1310') = 0, '1310 back to zero';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals WHERE source_type = 'cogs_sale' AND description LIKE '%LA-RESALE'), 'no 5100 for the resold piece (would double count 5500)';
  SELECT x INTO m FROM jsonb_array_elements(public.get_sales_costs('2026-07-01')->'sales') x WHERE x->>'invoice_number' = 'LA-RESALE';
  ASSERT (m->>'cost_jpy')::numeric = 40000 AND m->>'cost_source' = 'trade_in', 'resold plan shown as covered by the trade-in: ' || m::text;
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000007', 1000); ASSERT r->>'ok' = 'true', 'a manual cost may still be stored';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 0, 'but the trade-in link still wins (no cogs_sale)';
  r := public.set_sale_cost('layaway', '10000000-0000-0000-0000-000000000007', NULL);
END $t$;
RESET ROLE;
UPDATE public.trade_ins SET resale_status = 'In stock' WHERE id = '60000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; t uuid := '60000000-0000-0000-0000-000000000001'; BEGIN
  ASSERT (SELECT resold_at FROM public.trade_ins WHERE id = t) IS NULL AND (SELECT resold_invoice_number FROM public.trade_ins WHERE id = t) IS NULL, 'back in stock clears resold_at and the resale link';
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 1 AND (r->>'posted')::int = 0, 'un-selling reverses the 5500 only (LA-RESALE now cost missing): ' || r::text;
  RAISE NOTICE 'C6 purchases / trade-ins OK';
END $t$;

-- C7 valuation + real profit.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_inventory_valuation();
  ASSERT (r->>'stock_units')::int = 5 AND (r->>'stock_units_with_cost')::int = 3 AND (r->>'variants_in_stock_without_cost')::int = 1, 'stock counts: ' || r::text;
  ASSERT (r->>'stock_at_cost_jpy')::numeric = 36000, 'stock at cost 3 × 12000';
  ASSERT (r->>'ledger_inventory_jpy')::numeric = 260000, '1300 = 300000 purchased − 40000 still sold';
  ASSERT (r->>'website_minus_ledger_jpy')::numeric = 36000 - 260000, 'partial website stock vs ledger (informational only)';
  ASSERT (r->>'trade_ins_in_stock')::int = 1 AND (r->>'trade_ins_in_stock_jpy')::numeric = 40000, 'trade-ins in stock';
  r := public.fc_real_profit('2026-06-01', NULL);
  ASSERT r->>'ledger_started' = 'true' AND (r->>'sales_total')::int = 5 AND (r->>'sales_with_cost')::int = 4, 'profit counts (LA-RESALE lost its cost when un-sold): ' || r::text;
  ASSERT (r->>'cogs_jpy')::numeric = (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_accounts a ON a.code = l.account_code WHERE a.kind = 'cogs'), 'cost of sales = cogs account balances (reversals land today)';
  ASSERT (r->>'cogs_jpy')::numeric = 40000, 'cogs: 24000 + 50000 + 7000 + 9000 − 50000 returned (the 46000 and the trade-in resale are reversed)';
  ASSERT (r->>'gross_profit_jpy')::numeric = (r->>'revenue_jpy')::numeric - (r->>'cogs_jpy')::numeric, 'gross = revenue − cogs';
  ASSERT (r->>'revenue_jpy')::numeric > 0, 'revenue from the sale events';
  ASSERT (r->>'inventory_jpy')::numeric = 300000, '1300 + 1310 balance';
  RAISE NOTICE 'C7 valuation / profit OK';
END $t$;

-- C8 never deleted / anon.
RESET ROLE;
SET ROLE anon;
DO $t$ BEGIN
  BEGIN PERFORM public.get_sales_costs('2026-06-01'); RAISE EXCEPTION 'anon should not execute';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'C8 anon denied OK';
END $t$;
RESET ROLE;
SELECT 'ALL COGS TESTS PASSED' AS result;
