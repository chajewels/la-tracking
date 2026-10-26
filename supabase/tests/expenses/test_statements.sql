\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Phase 7: statements and the 税理士 pack. Fresh copy after stubs + Phases 1–7 (own ledger start 2026-06-01, rate 0.42).
-- Fixture book (yen; peso at 0.42 → ₱1 = ¥2.381):
--   opening 2026-06-01   Dr 1101 1,000,000 / Cr 3000
--   LA-JP   JPY 100,000 (Japan customer)   paid 40,000 'sumitomo' 06-05, 10,000 'sumitomo' 08-10 → sale June, receivable 50,000
--   LA-PH   PHP 50,000 (Philippines)       paid ₱20,000 'bdo' 07-10 → export sale ¥119,048, receivable ₱30,000
--   LA-MIX  PHP 10,000 (Japan customer!)   paid ₱10,000 'bdo' 08-01 → export ¥23,810; the D3 currency check row
--   LA-JP2  JPY 60,000 (Japan)             paid 60,000 'rakuten' 09-12 → domestic
--   manual: 07-10 equipment 50,000; 07-20 loan 200,000; 08-15 marketing 30,000; 09-01 inventory on credit 80,000; 06-20 office 5,000
--   schedule LA-JP: 07-05 40,000 paid; 08-05 30,000 paid 10,000; 09-05 30,000 pending.  LA-PH: 11-15 ₱15,000; 12-15 ₱15,000.
--   cash order CO-1 JPY 20,000 pending since 08-20 (no payment yet).
INSERT INTO public.customers (id, full_name, country) VALUES
  ('c0000000-0000-0000-0000-00000000000a', 'Tokyo customer', 'Japan'),
  ('c0000000-0000-0000-0000-00000000000b', 'Manila customer', 'Philippines');
INSERT INTO public.layaway_accounts (id, customer_id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('10000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a', 'LA-JP',  'JPY', 100000, 50000, 50000, 'active', '2026-06-05'),
  ('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000b', 'LA-PH',  'PHP', 50000,  20000, 30000, 'active', '2026-07-10'),
  ('10000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-00000000000a', 'LA-MIX', 'PHP', 10000,  10000, 0,     'completed', '2026-08-01'),
  ('10000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-00000000000a', 'LA-JP2', 'JPY', 60000,  60000, 0,     'completed', '2026-09-12');
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 40000, 'JPY', '2026-06-05', 'sumitomo'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 10000, 'JPY', '2026-08-10', 'sumitomo'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 20000, 'PHP', '2026-07-10', 'bdo'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003', 10000, 'PHP', '2026-08-01', 'bdo'),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', 60000, 'JPY', '2026-09-12', 'rakuten');
INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, total_due_amount, paid_amount, currency, status) VALUES
  ('10000000-0000-0000-0000-000000000001', 1, '2026-07-05', 40000, 40000, 'JPY', 'paid'),
  ('10000000-0000-0000-0000-000000000001', 2, '2026-08-05', 30000, 10000, 'JPY', 'partially_paid'),
  ('10000000-0000-0000-0000-000000000001', 3, '2026-09-05', 30000, 0,     'JPY', 'pending'),
  ('10000000-0000-0000-0000-000000000002', 1, '2026-11-15', 15000, 0,     'PHP', 'pending'),
  ('10000000-0000-0000-0000-000000000002', 2, '2026-12-15', 15000, 0,     'PHP', 'pending');
INSERT INTO public.cash_orders (id, customer_id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('30000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a', 'CO-1', 'JPY', 20000, 0, 20000, 'pending', '2026-08-20');

-- T1 Japanese names: seeded for every account; editable (admin only); length checked; an omitted name_ja is kept.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  ASSERT (SELECT count(*) FROM public.gl_accounts WHERE name_ja IS NULL) = 0, 'every account has a 勘定科目 name';
  ASSERT (SELECT name_ja FROM public.gl_accounts WHERE code = '4100') = '売上高' AND (SELECT name_ja FROM public.gl_accounts WHERE code = '1195') = '仮払金', 'seed values';
  r := public.upsert_gl_account('{"code":"6200","name":"Marketing","name_ja":"広告費"}'); ASSERT r->>'ok' = 'true', 'edit name_ja: ' || r::text;
  ASSERT (SELECT name_ja FROM public.gl_accounts WHERE code = '6200') = '広告費', 'name_ja changed';
  r := public.upsert_gl_account('{"code":"6200","name":"Marketing"}'); ASSERT r->>'ok' = 'true', 'edit without name_ja';
  ASSERT (SELECT name_ja FROM public.gl_accounts WHERE code = '6200') = '広告費', 'omitted name_ja is kept';
  r := public.upsert_gl_account(jsonb_build_object('code', '6200', 'name', 'Marketing', 'name_ja', repeat('あ', 61))); ASSERT r->>'error' = 'invalid_name_ja', 'too long';
  r := public.upsert_gl_account('{"code":"6210","name":"Influencers","kind":"expense","name_ja":"販促費"}'); ASSERT r->>'ok' = 'true', 'new account with name_ja: ' || r::text;
  ASSERT (SELECT name_ja FROM public.gl_accounts WHERE code = '6210') = '販促費', 'stored on insert';
  r := public.upsert_gl_account('{"code":"6200","name":"Marketing","name_ja":"広告宣伝費"}'); ASSERT r->>'ok' = 'true', 'restored';
  RAISE NOTICE 'T1 name_ja OK';
END $t$;

-- T2 permissions: everything needs view_ledger; thresholds need admin_settings.
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_statements('2026-07-01', '2026-09-30'); ASSERT r->>'error' = 'permission_denied', 'staff statements';
  r := public.get_receivable_ageing(); ASSERT r->>'error' = 'permission_denied', 'staff ageing';
  r := public.get_journal_export('2026-07-01', '2026-09-30'); ASSERT r->>'error' = 'permission_denied', 'staff export';
  r := public.set_statement_flags(10, 50000); ASSERT r->>'error' = 'permission_denied', 'staff flags';
  r := public.upsert_gl_account('{"code":"6200","name":"Marketing","name_ja":"x"}'); ASSERT r->>'error' = 'permission_denied', 'staff name_ja';
  BEGIN
    PERFORM public.gl_statement_flags();
    RAISE EXCEPTION 'internal helper should not be executable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'T2 permissions OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_statements('2026-07-01', '2026-09-30'); ASSERT r->>'error' = 'permission_denied', 'finance without view_ledger';
  r := public.set_statement_flags(10, 50000); ASSERT r->>'error' = 'permission_denied', 'finance is not admin';
  RAISE NOTICE 'T2b finance OK';
END $t$;

-- T3 the book: start the ledger, post the sales/payments, add the manual entries.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'ledger start: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('kind', 'opening', 'entry_date', '2026-06-01', 'description', 'Opening bank balance',
         'lines', '[{"a":"1101","side":"dr","amt":"1000000","cur":"JPY"},{"a":"3000","side":"cr","amt":"1000000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'opening: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-06-20', 'description', 'Office supplies June',
         'lines', '[{"a":"6600","side":"dr","amt":"5000","cur":"JPY"},{"a":"1101","side":"cr","amt":"5000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'june office: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-07-10', 'description', 'Camera',
         'lines', '[{"a":"1500","side":"dr","amt":"50000","cur":"JPY"},{"a":"1101","side":"cr","amt":"50000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'equipment: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-07-20', 'description', 'Bank loan drawn',
         'lines', '[{"a":"1101","side":"dr","amt":"200000","cur":"JPY"},{"a":"2700","side":"cr","amt":"200000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'loan: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-08-15', 'description', 'Meta ads August',
         'lines', '[{"a":"6200","side":"dr","amt":"30000","cur":"JPY"},{"a":"1101","side":"cr","amt":"30000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'marketing: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-09-01', 'description', 'Pieces bought on account',
         'lines', '[{"a":"1300","side":"dr","amt":"80000","cur":"JPY"},{"a":"2100","side":"cr","amt":"80000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'inventory: ' || r::text;
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post: ' || r::text;
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'layaway_sale' AND status = 'posted') = 4, 'four sales posted';
  RAISE NOTICE 'T3 book OK';
END $t$;

-- T4 income statement Jul–Sep 2026: sections, domestic / export split, totals tie to the trial balance, comparisons unavailable before the start.
DO $t$ DECLARE r jsonb; l jsonb; tb jsonb; BEGIN
  r := public.get_statements('2026-07-01', '2026-09-30');
  ASSERT r->>'error' IS NULL, 'statements: ' || r::text;
  ASSERT (r->'comparisons'->'prior'->>'available')::boolean = false AND r->'comparisons'->'prior'->>'from' = '2026-04-01' AND r->'comparisons'->'prior'->>'to' = '2026-06-30', 'prior quarter named but before the ledger start: ' || (r->'comparisons')::text;
  ASSERT (r->'comparisons'->'prior_year'->>'available')::boolean = false AND r->'comparisons'->'prior_year'->>'to' = '2025-09-30', 'prior year named';
  ASSERT r->>'fiscal_year_start' = '2026-04-01' AND (r->>'fiscal_year_start_month')::int = 4, 'April–March';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sales');
  ASSERT (l->>'cur')::numeric = 60000 + round(50000 / 0.42) + round(10000 / 0.42), 'sales = domestic 60,000 + export ₱60,000: ' || l::text;
  ASSERT l->'prior' = 'null'::jsonb AND l->'delta' = 'null'::jsonb AND (l->>'flag')::boolean = false, 'no prior → no delta, no flag';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sales_export');
  ASSERT (l->>'cur')::numeric = round(50000 / 0.42) + round(10000 / 0.42) AND l->>'label_ja' = '輸出売上高', 'export = peso sales: ' || l::text;
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sales_domestic');
  ASSERT (l->>'cur')::numeric = 60000, 'domestic = yen sales: ' || l::text;
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'revenue_total');
  ASSERT (l->>'cur')::numeric = 60000 + round(50000 / 0.42) + round(10000 / 0.42), '営業収益';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'gross_profit');
  ASSERT (l->>'cur')::numeric = 60000 + round(50000 / 0.42) + round(10000 / 0.42), 'no cost of goods → gross = revenue';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sga_marketing');
  ASSERT (l->>'cur')::numeric = 30000 AND l->>'label_ja' = '広告宣伝費', 'marketing line';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sga_total');
  ASSERT (l->>'cur')::numeric = 30000, '販管費 total';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'net_profit');
  ASSERT (l->>'cur')::numeric = 60000 + round(50000 / 0.42) + round(10000 / 0.42) - 30000, '当期純利益: ' || l::text;
  ASSERT (SELECT x->>'cur' FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'ordinary_profit') = l->>'cur', 'no non-operating items → ordinary = net';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' IN ('revenue_other', 'cogs_misc', 'sga_misc')) = 0, 'catch-all lines hidden when empty';
  tb := public.get_trial_balance('2026-07-01', '2026-09-30');
  ASSERT (l->>'cur')::numeric = (SELECT sum((x->>'credit_jpy')::numeric - (x->>'debit_jpy')::numeric) FROM jsonb_array_elements(tb->'rows') x WHERE x->>'kind' IN ('revenue', 'cogs', 'expense')), 'net profit ties to the trial balance';
  ASSERT (r->'income_statement'->>'operating_margin_pct')::numeric = round((60000 + round(50000 / 0.42) + round(10000 / 0.42) - 30000) / (60000 + round(50000 / 0.42) + round(10000 / 0.42)) * 100, 1), 'margin';
  ASSERT (r->>'journal_count')::int = (tb->>'journal_count')::int, 'journal count';
  ASSERT jsonb_array_length(r->'outside_hub') = 2 AND r->'outside_hub'->0->>'label_ja' = '役員報酬', 'booked-outside-the-Hub note';
  RAISE NOTICE 'T4 income statement OK';
END $t$;

-- T5 balance sheet at 2026-09-30 (and at 2026-06-30): sections, equity includes the profit to date, A = L + E.
DO $t$ DECLARE r jsonb; bs jsonb; l jsonb; php_rec numeric := round(50000 / 0.42) - round(20000 / 0.42); BEGIN
  r := public.get_statements('2026-07-01', '2026-09-30');
  bs := r->'balance_sheet';
  ASSERT bs->>'as_of' = '2026-09-30' AND bs->>'prior_as_of' = '2026-06-30', 'dates';
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'code' = '1101');
  ASSERT (l->>'cur')::numeric = 1000000 + 40000 - 5000 + 10000 - 50000 + 200000 - 30000 AND (l->>'prior')::numeric = 1000000 + 40000 - 5000, 'SMBC balances: ' || l::text;
  ASSERT l->>'section' = 'current_assets' AND l->>'group' = 'cash' AND l->>'label_ja' = '普通預金 三井住友', 'cash grouping + 勘定科目';
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'code' = '1200');
  ASSERT (l->>'cur')::numeric = 50000 + php_rec AND (l->>'prior')::numeric = 60000 AND l->>'group' = 'receivables', 'receivable: ' || l::text;
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'code' = '1500');
  ASSERT (l->>'cur')::numeric = 50000 AND l->>'section' = 'fixed_assets', 'equipment is a fixed asset';
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'code' = '2700');
  ASSERT (l->>'cur')::numeric = 200000 AND l->>'section' = 'current_liabilities', 'short-term loan positive on the liability side';
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'code' = '3000');
  ASSERT (l->>'cur')::numeric = 1000000 AND l->>'section' = 'equity', 'capital';
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'key' = 'current_fy_profit');
  ASSERT (l->>'cur')::numeric = 100000 - 5000 + 60000 + round(50000 / 0.42) + round(10000 / 0.42) - 30000 AND (l->>'prior')::numeric = 95000, 'profit since 1 April (all of it, the ledger started in June): ' || l::text;
  l := (SELECT x FROM jsonb_array_elements(bs->'lines') x WHERE x->>'key' = 'retained_prior_years');
  ASSERT (l->>'cur')::numeric = 0, 'nothing before this fiscal year';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(bs->'lines') x WHERE x->>'code' = '2750') = 0, 'accounts with no balance are not listed';
  ASSERT (bs->'totals'->>'check')::numeric = 0 AND (bs->'totals'->>'prior_check')::numeric = 0, 'assets = liabilities + equity: ' || (bs->'totals')::text;
  ASSERT (bs->'totals'->>'assets')::numeric = (SELECT sum((x->>'cur')::numeric) FROM jsonb_array_elements(bs->'lines') x WHERE x->>'kind' = 'asset'), 'asset total = listed lines';
  ASSERT (bs->'totals'->>'equity')::numeric = (SELECT sum((x->>'cur')::numeric) FROM jsonb_array_elements(bs->'lines') x WHERE x->>'kind' = 'equity'), 'equity total = capital + profit lines';
  RAISE NOTICE 'T5 balance sheet OK';
END $t$;

-- T6 cash flow Jul–Sep: indirect lines sum to the actual change in cash & deposits.
DO $t$ DECLARE r jsonb; cf jsonb; php_rec numeric := round(50000 / 0.42) - round(20000 / 0.42); BEGIN
  r := public.get_statements('2026-07-01', '2026-09-30');
  cf := r->'cash_flow';
  ASSERT (cf->>'cash_open')::numeric = 1035000, 'cash at 30 June: ' || cf::text;
  ASSERT (cf->>'cash_close')::numeric = 1165000 + 60000 + round(20000 / 0.42) + round(10000 / 0.42), 'cash at 30 Sept (SMBC + Rakuten + BDO in yen)';
  ASSERT (cf->>'actual_change')::numeric = (cf->>'cash_close')::numeric - (cf->>'cash_open')::numeric, 'actual change';
  ASSERT (cf->>'difference')::numeric = 0 AND (cf->>'net_change')::numeric = (cf->>'actual_change')::numeric, 'indirect statement ties out: ' || cf::text;
  ASSERT (SELECT (x->>'amount')::numeric FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_receivables') = -(50000 + php_rec - 60000), 'receivables grew → cash used';
  ASSERT (SELECT (x->>'amount')::numeric FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_inventory') = -80000, 'inventory bought';
  ASSERT (SELECT (x->>'amount')::numeric FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_payables') = 80000, 'but on account';
  ASSERT (SELECT (x->>'amount')::numeric FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_equipment') = -50000 AND (SELECT x->>'section' FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_equipment') = 'investing', 'equipment is investing';
  ASSERT (SELECT (x->>'amount')::numeric FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_loans') = 200000 AND (SELECT x->>'section' FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_loans') = 'financing', 'loan is financing';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(cf->'lines') x WHERE x->>'key' = 'd_other_accounts') = 0, 'no stray accounts';
  ASSERT (cf->>'unrealised_fx_on_cash')::numeric = 0, 'no revaluation in a book at one rate';
  RAISE NOTICE 'T6 cash flow OK';
END $t$;

-- T7 ageing at 30 Sept and the D3 currency checks.
DO $t$ DECLARE r jsonb; a jsonb; BEGIN
  a := public.get_receivable_ageing('2026-09-30');
  ASSERT a->>'error' IS NULL, 'ageing: ' || a::text;
  ASSERT (a->'layaway'->'d1_30'->>'total_jpy')::numeric = 30000 AND (a->'layaway'->'d1_30'->>'plans')::int = 1, '5 Sept line is 25 days late: ' || (a->'layaway')::text;
  ASSERT (a->'layaway'->'d31_60'->>'total_jpy')::numeric = 20000 AND (a->'layaway'->'d31_60'->>'lines')::int = 1, 'partially paid 5 Aug line: 20,000 still due, 56 days';
  ASSERT (a->'layaway'->'not_due'->>'php')::numeric = 30000 AND (a->'layaway'->'not_due'->>'total_jpy')::numeric = 2 * round(15000 / 0.42) AND (a->'layaway'->'not_due'->>'plans')::int = 1, 'peso plan not yet due';
  ASSERT (a->'layaway'->'d61_90'->>'lines')::int = 0 AND (a->'layaway'->'d90p'->>'lines')::int = 0, 'empty buckets present as zeros';
  ASSERT (a->'cash_orders'->'d31_60'->>'total_jpy')::numeric = 20000 AND (a->'cash_orders'->'d31_60'->>'orders')::int = 1, 'CO-1 pending 41 days: ' || (a->'cash_orders')::text;
  ASSERT (a->'forecast'->'next_30'->>'lines')::int = 0 AND (a->'forecast'->'next_60'->>'php')::numeric = 15000 AND (a->'forecast'->'next_90'->>'php')::numeric = 15000, '90-day collections forecast: ' || (a->'forecast')::text;
  ASSERT (a->'ledger'->>'layaway_jpy')::numeric = 50000 + round(50000 / 0.42) - round(20000 / 0.42), 'ledger receivable beside the schedule';
  ASSERT a->>'basis' = 'current_open_lines_aged_at_date', 'a past date ages today''s open lines';
  a := public.get_receivable_ageing();
  ASSERT a->>'basis' = 'current' AND (a->'layaway'->'d31_60'->>'total_jpy')::numeric = 30000 AND (a->'layaway'->'d61_90'->>'total_jpy')::numeric = 20000, 'today (26 Oct): 5 Sept is 51 days, 5 Aug is 82 days';
  r := public.get_statements('2026-07-01', '2026-09-30');
  ASSERT r->'ageing'->>'as_of' = '2026-09-30' AND (r->'ageing'->'layaway'->'d1_30'->>'total_jpy')::numeric = 30000, 'statements carry the ageing at `to`';
  ASSERT (r->'currency_checks'->>'count')::int = 1 AND r->'currency_checks'->'rows'->0->>'invoice_number' = 'LA-MIX' AND r->'currency_checks'->'rows'->0->>'country' = 'Japan', 'peso plan for a Japan customer flagged: ' || (r->'currency_checks')::text;
  RAISE NOTICE 'T7 ageing + checks OK';
END $t$;

-- T8 comparisons and flags on Aug–Sep (prior = Jun–Jul, inside the ledger): Δ, Δ %, flag at the thresholds; thresholds editable.
DO $t$ DECLARE r jsonb; l jsonb; n int; BEGIN
  r := public.get_statements('2026-08-01', '2026-09-30');
  ASSERT (r->'comparisons'->'prior'->>'available')::boolean = true AND r->'comparisons'->'prior'->>'from' = '2026-06-01' AND r->'comparisons'->'prior'->>'to' = '2026-07-31', 'two months back: ' || (r->'comparisons')::text;
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sales');
  ASSERT (l->>'cur')::numeric = 60000 + round(10000 / 0.42) AND (l->>'prior')::numeric = 100000 + round(50000 / 0.42), 'current vs prior sales: ' || l::text;
  ASSERT (l->>'delta')::numeric = (l->>'cur')::numeric - (l->>'prior')::numeric AND (l->>'delta_pct')::numeric = round(((l->>'cur')::numeric - (l->>'prior')::numeric) / (l->>'prior')::numeric * 100, 1), 'Δ and Δ %';
  ASSERT (l->>'flag')::boolean = true, 'a ¥135,238 drop is flagged (≥ ¥100,000)';
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sga_marketing');
  ASSERT (l->>'cur')::numeric = 30000 AND (l->>'prior')::numeric = 0 AND l->'delta_pct' = 'null'::jsonb AND (l->>'flag')::boolean = false, 'from zero: no % and ¥30,000 is under the yen threshold: ' || l::text;
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sga_office');
  ASSERT (l->>'cur')::numeric = 0 AND (l->>'prior')::numeric = 5000 AND (l->>'delta_pct')::numeric = -100 AND (l->>'flag')::boolean = true, 'office −100 % is flagged by the % rule';
  ASSERT (r->'flags'->>'pct')::numeric = 15 AND (r->'flags'->>'jpy')::numeric = 100000, 'default thresholds';
  r := public.set_statement_flags(15.55, 100000); ASSERT r->>'error' = 'invalid_pct', 'one decimal at most';
  r := public.set_statement_flags(15, 100.5); ASSERT r->>'error' = 'invalid_amount', 'whole yen';
  r := public.set_statement_flags(-1, 100000); ASSERT r->>'error' = 'invalid_pct', 'negative';
  r := public.set_statement_flags(5, 1000); ASSERT r->>'ok' = 'true', 'thresholds saved: ' || r::text;
  SELECT count(*) INTO n FROM public.audit_logs WHERE entity_type = 'gl_setting' AND action = 'set_statement_flags'; ASSERT n = 1, 'audited: ' || n;
  r := public.get_statements('2026-08-01', '2026-09-30');
  l := (SELECT x FROM jsonb_array_elements(r->'income_statement'->'lines') x WHERE x->>'key' = 'sga_marketing');
  ASSERT (l->>'flag')::boolean = true AND (r->'flags'->>'jpy')::numeric = 1000, 'lower threshold flags the ¥30,000 line';
  r := public.set_statement_flags(15, 100000); ASSERT r->>'ok' = 'true', 'restored';
  r := public.get_statements('2026-09-05', '2026-09-30');
  ASSERT r->'comparisons'->'prior'->>'from' = '2026-08-10' AND r->'comparisons'->'prior'->>'to' = '2026-09-04', 'unaligned range: same number of days before: ' || (r->'comparisons')::text;
  r := public.get_statements('2026-09-30', '2026-09-01'); ASSERT r->>'error' = 'invalid_range', 'reversed range';
  RAISE NOTICE 'T8 comparisons + flags OK';
END $t$;

-- T9 journal export: flat rows with 勘定科目 and the tax flag; paging; reversal marked.
DO $t$ DECLARE r jsonb; x jsonb; n int; BEGIN
  r := public.get_journal_export('2026-07-01', '2026-09-30');
  ASSERT r->>'error' IS NULL, 'export: ' || r::text;
  SELECT count(*) INTO n FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.entry_date BETWEEN '2026-07-01' AND '2026-09-30';
  ASSERT (r->>'total_rows')::int = n AND (r->>'returned')::int = n AND (r->>'truncated')::boolean = false, 'all lines in one page: ' || n;
  x := (SELECT e FROM jsonb_array_elements(r->'rows') e WHERE e->>'account_code' = '4100' AND e->>'memo' = 'LA-PH');
  ASSERT x->>'tax_flag' = 'export' AND x->>'currency' = 'PHP' AND (x->>'native_amount')::numeric = 50000 AND (x->>'credit_jpy')::numeric = round(50000 / 0.42) AND (x->>'rate')::numeric = 0.42 AND x->>'account_name_ja' = '売上高', 'peso sale line: ' || x::text;
  x := (SELECT e FROM jsonb_array_elements(r->'rows') e WHERE e->>'account_code' = '4100' AND e->>'memo' = 'LA-JP2');
  ASSERT x->>'tax_flag' = 'domestic' AND (x->>'credit_jpy')::numeric = 60000, 'yen sale line is domestic';
  x := (SELECT e FROM jsonb_array_elements(r->'rows') e WHERE e->>'account_code' = '1200' AND e->>'memo' = 'LA-JP2' AND e->>'source_type' = 'layaway_sale');
  ASSERT x->>'tax_flag' = '' AND x->>'kind' = 'auto' AND x->>'source_type' = 'layaway_sale' AND (x->>'reversed')::boolean = false, 'receivable line carries no tax flag: ' || x::text;
  ASSERT (SELECT bool_and((e->>'journal_no')::bigint <= (lead_no)::bigint) FROM (SELECT e, lead(e->>'journal_no') OVER () AS lead_no FROM jsonb_array_elements(r->'rows') e) s WHERE lead_no IS NOT NULL), 'ordered by journal number';
  r := public.get_journal_export('2026-07-01', '2026-09-30', n - 1);
  ASSERT (r->>'returned')::int = 1 AND (r->>'truncated')::boolean = false AND (r->>'offset')::int = n - 1, 'last page';
  r := public.get_journal_export('2026-07-01', '2026-09-30', -1); ASSERT r->>'error' = 'invalid_offset', 'offset checked';
  RESET ROLE;
  UPDATE public.payments SET voided_at = now() WHERE id = '20000000-0000-0000-0000-000000000002';
  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 1, 'voided payment reversed: ' || r::text;
  r := public.get_journal_export('2026-07-01', '2026-09-30');
  x := (SELECT e FROM jsonb_array_elements(r->'rows') e WHERE e->>'source_type' = 'payment' AND e->>'account_code' = '1101' AND (e->>'debit_jpy')::numeric = 10000);
  ASSERT (x->>'reversed')::boolean = true AND x->>'status' = 'reversed', 'original marked reversed: ' || x::text;
  r := public.get_journal_export(current_date, current_date);
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'rows') e WHERE e->>'kind' = 'reversal' AND (e->>'reversed')::boolean) = 2, 'reversal journal (two lines) dated today, marked';
  r := public.get_statements('2026-07-01', '2026-09-30');
  ASSERT (r->'cash_flow'->>'difference')::numeric = 0 AND (r->'balance_sheet'->'totals'->>'check')::numeric = 0, 'still balanced after the reversal';
  RAISE NOTICE 'T9 export OK';
END $t$;

SELECT 'ALL STATEMENTS TESTS PASSED' AS result;
