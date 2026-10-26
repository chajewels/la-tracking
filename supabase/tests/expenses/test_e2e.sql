\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'

-- Phase 8: end-to-end rehearsal — one month walked the way the owner will after go-live, on a fresh copy after Phases 1–8.
-- June 2026 (ledger start 1 June, rate 0.42 anchored before the start):
--   opening balances → sales + payments in yen and pesos → an approved expense → a Square card order with its fee →
--   the Square payout → a yen→peso remittance → post → import the SMBC statement → reconcile SMBC and count cash →
--   readiness → close June → statements agree with the trial balance → a July correction to a June payment rolls into July.
INSERT INTO public.customers (id, full_name, country) VALUES
  ('c0000000-0000-0000-0000-00000000000a', 'Tokyo customer', 'Japan'), ('c0000000-0000-0000-0000-00000000000b', 'Manila customer', 'Philippines');
INSERT INTO public.layaway_accounts (id, customer_id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('10000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a', 'E2E-JP', 'JPY', 200000, 80000, 120000, 'active', '2026-06-03'),
  ('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000b', 'E2E-PH', 'PHP', 42000,  21000, 21000,  'active', '2026-06-12');
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 80000, 'JPY', '2026-06-03', 'sumitomo'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 21000, 'PHP', '2026-06-12', 'bdo');
INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, total_due_amount, paid_amount, currency, status) VALUES
  ('10000000-0000-0000-0000-000000000001', 1, '2026-06-03', 80000, 80000, 'JPY', 'paid'),
  ('10000000-0000-0000-0000-000000000001', 2, '2026-07-03', 60000, 0,     'JPY', 'pending'),
  ('10000000-0000-0000-0000-000000000001', 3, '2026-08-03', 60000, 0,     'JPY', 'pending'),
  ('10000000-0000-0000-0000-000000000002', 1, '2026-07-12', 21000, 0,     'PHP', 'pending');
INSERT INTO public.cash_orders (id, customer_id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('30000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a', 'E2E-SQ', 'JPY', 30000, 30000, 0, 'completed', '2026-06-08');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('30000000-0000-0000-0000-000000000001', 30000, 'JPY', '2026-06-08', 'square');
INSERT INTO public.square_payments (id, cash_order_id, environment, test, status, amount_jpy, captured_at, last_payload) VALUES
  ('70000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'production', false, 'captured', 30000, '2026-06-08 02:00+00',
   '{"processing_fee":[{"amount_money":{"amount":975,"currency":"JPY"},"type":"INITIAL"}]}');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- E1 day one: rate anchored, ledger started, opening balances typed from the accountant's figures.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.set_php_jpy_rate(0.42, '2026-03-27'); ASSERT r->>'ok' = 'true', 'rate history dated before the start: ' || r::text;
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'ledger start: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('kind', 'opening', 'entry_date', '2026-06-01', 'description', 'Opening balances (accountant, provisional)',
         'lines', '[{"a":"1101","side":"dr","amt":"2000000","cur":"JPY"},{"a":"1111","side":"dr","amt":"100000","cur":"PHP"},{"a":"1300","side":"dr","amt":"500000","cur":"JPY"},
                    {"a":"2700","side":"cr","amt":"300000","cur":"JPY"},{"a":"3000","side":"cr","amt":"1000000","cur":"JPY"},{"a":"3100","side":"cr","amt":"1438095","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'opening journal: ' || r::text;
  ASSERT (r->'journal'->>'total_jpy')::numeric = 2000000 + round(100000 / 0.42) + 500000, 'opening balanced in yen (₱100,000 = ¥238,095)';
  RAISE NOTICE 'E1 day one OK';
END $t$;

-- E2 the month's business: expense, Square fee, payout, remittance; everything posts once.
DO $t$ DECLARE r jsonb; e uuid; cat uuid := (SELECT id FROM public.expense_categories WHERE name = 'Meta and Google ads'); BEGIN
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-15', 'category_id', cat, 'description', 'Meta ads June', 'currency', 'JPY', 'amount', 25000, 'payment_method', 'bank_transfer'));
  ASSERT r->>'ok' = 'true', 'expense draft'; e := (r->'expense'->>'id')::uuid;
  r := public.approve_expense(e); ASSERT r->>'ok' = 'true', 'approved';
  r := public.set_expense_paid_from(e, '1101'); ASSERT r->>'ok' = 'true', 'paid from SMBC';
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-06-20","amount_received_jpy":"29025","bank_account":"1101","reference":"SQ-JUN"}');
  ASSERT r->>'ok' = 'true', 'Square payout: ' || r::text;
  r := public.record_fund_transfer('{"transfer_on":"2026-06-25","from_account":"1101","from_amount":"100000","from_currency":"JPY","to_account":"1111","to_amount":"41500","to_currency":"PHP","fee_amount":"880","fee_currency":"JPY","reference":"REMIT-JUN"}');
  ASSERT r->>'ok' = 'true', 'remittance: ' || r::text;
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true' AND (r->>'failed')::int = 0, 'post: ' || r::text;
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE status = 'posted' AND kind = 'auto') = (SELECT count(DISTINCT (source_type, source_id)) FROM public.gl_journals WHERE status = 'posted' AND kind = 'auto'), 'one journal per event';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'square_fee') = 1 AND (SELECT count(*) FROM public.gl_journals WHERE source_type = 'settlement_payout') = 1 AND (SELECT count(*) FROM public.gl_journals WHERE source_type = 'fund_transfer') = 1, 'fee, payout, transfer posted';
  ASSERT (SELECT sum(l.debit_jpy - l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1130') = 0, 'Square clearing cleared by the payout';
  ASSERT (SELECT sum(l.debit - l.credit) FROM public.gl_journal_lines l WHERE l.account_code = '1101') = 2000000 + 80000 - 25000 + 29025 - 100000, 'SMBC native';
  ASSERT (SELECT sum(l.debit - l.credit) FROM public.gl_journal_lines l WHERE l.account_code = '1111') = 100000 + 21000 + 41500, 'BDO native ₱';
  r := public.run_ledger_check(); ASSERT (r->>'errors')::int = 0, 'nightly check clean after posting: ' || (r->'issues')::text;
  RAISE NOTICE 'E2 business posted OK';
END $t$;

-- E3 reconcile SMBC for June from the bank's CSV lines; count the cash drawer.
DO $t$ DECLARE r jsonb; rec jsonb; fee uuid; BEGIN
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('e', 64), 'file_name', 'smbc-2026-06.csv',
         'profile', '{"delimiter":",","header_rows":1,"date_col":0,"date_format":"ymd","description_col":1,"in_col":2,"out_col":3,"balance_col":4,"encoding":"shift_jis"}'::jsonb,
         'lines', '[{"booked_on":"2026-06-03","description":"振込 タナカ","amount":"80000","balance_after":"2080000"},
                    {"booked_on":"2026-06-15","description":"META PLATFORMS IRELAND","amount":"-25000","balance_after":"2055000"},
                    {"booked_on":"2026-06-22","description":"SQUARE INC","amount":"29025","balance_after":"2084025"},
                    {"booked_on":"2026-06-25","description":"海外送金 BDO","amount":"-100000","balance_after":"1984025"},
                    {"booked_on":"2026-06-30","description":"振込手数料","amount":"-440","balance_after":"1983585"}]'::jsonb));
  ASSERT r->>'ok' = 'true' AND (r->>'inserted')::int = 5 AND (r->>'auto_matched')::int = 4, 'four of five matched on amount and date (payout 2 days late is inside ±3): ' || r::text;
  rec := public.get_bank_reconciliation('1101', '2026-06-01');
  ASSERT jsonb_array_length(rec->'unmatched_statement') = 1 AND jsonb_array_length(rec->'unmatched_ledger') = 0, 'only the bank fee is left: ' || (rec - 'imports' - 'profile')::text;
  fee := (rec->'unmatched_statement'->0->>'id')::uuid;
  r := public.sign_off_reconciliation('1101', '2026-06-01', 1983585);
  ASSERT r->>'error' = 'difference_remains' AND (r->>'difference')::numeric = -440, 'the fee is in the bank but not in the Hub';
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-06-30', 'description', 'Bank transfer fee June',
         'lines', '[{"a":"6300","side":"dr","amt":"440","cur":"JPY"},{"a":"1101","side":"cr","amt":"440","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'fee booked';
  r := public.auto_match_bank_lines('1101', '2026-06-01'); ASSERT (r->>'matched')::int = 1, 'the new journal line matches the fee: ' || r::text;
  r := public.sign_off_reconciliation('1101', '2026-06-01', 1983585, 'June statement');
  ASSERT r->>'ok' = 'true', 'SMBC reconciled: ' || r::text;
  r := public.sign_off_reconciliation('1010', '2026-06-01', 0, 'Drawer counted 30 June'); ASSERT r->>'ok' = 'true', 'cash counted';
  r := public.sign_off_reconciliation('1111', '2026-06-01', 162500, 'BDO app balance');
  ASSERT r->>'error' = 'unmatched_ledger_lines' AND (r->>'count')::int = 2, 'a bank account cannot be signed off on the balance alone — its lines must be matched: ' || r::text;
  RAISE NOTICE 'E3 reconciliation OK';
END $t$;

-- E4 readiness, close, and the statements the 税理士 receives.
DO $t$ DECLARE r jsonb; s jsonb; tb jsonb; l jsonb; BEGIN
  r := public.get_close_readiness('2026-06-01');
  ASSERT (r->>'errors')::int = 0 AND (r->>'can_close')::boolean, 'ready: ' || r::text;
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'unreconciled_accounts') x WHERE x->>'code' = '1101') = 0, 'SMBC reconciled';
  r := public.close_period('2026-06-01', 'June 2026 to the 税理士');
  ASSERT r->>'ok' = 'true', 'closed: ' || (r - 'period')::text;
  s := public.get_statements('2026-06-01', '2026-06-30');
  tb := public.get_trial_balance('2026-06-01', '2026-06-30');
  ASSERT (s->'balance_sheet'->'totals'->>'check')::numeric = 0, 'A = L + E';
  ASSERT (s->'cash_flow'->>'difference')::numeric = 0, 'cash flow ties to the cash change';
  l := (SELECT x FROM jsonb_array_elements(s->'income_statement'->'lines') x WHERE x->>'key' = 'net_profit');
  ASSERT (l->>'cur')::numeric = (SELECT sum((x->>'credit_jpy')::numeric - (x->>'debit_jpy')::numeric) FROM jsonb_array_elements(tb->'rows') x WHERE x->>'kind' IN ('revenue', 'cogs', 'expense')), 'net profit = trial balance P&L';
  ASSERT (SELECT (x->>'cur')::numeric FROM jsonb_array_elements(s->'income_statement'->'lines') x WHERE x->>'key' = 'sales_export') = round(42000 / 0.42), 'export sales = the peso plan';
  ASSERT (SELECT (x->>'cur')::numeric FROM jsonb_array_elements(s->'income_statement'->'lines') x WHERE x->>'key' = 'sales_domestic') = 200000 + 30000, 'domestic = yen plan + card order';
  ASSERT (SELECT (x->>'cur')::numeric FROM jsonb_array_elements(s->'income_statement'->'lines') x WHERE x->>'key' = 'sga_fees') = 975 + 440 + 880, 'fees: Square + bank transfer fee + remittance fee';
  ASSERT (s->'ageing'->'forecast'->'next_30'->>'jpy')::numeric = 60000 AND (s->'ageing'->'forecast'->'next_30'->>'php')::numeric = 21000, 'July collections forecast';
  ASSERT (s->>'journal_count')::int = (tb->>'journal_count')::int AND (s->>'journal_count')::int >= 9, 'journal count agrees';
  r := public.get_journal_export('2026-06-01', '2026-06-30');
  ASSERT (r->>'total_rows')::int = (SELECT count(*) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.entry_date BETWEEN '2026-06-01' AND '2026-06-30') AND (r->>'truncated')::boolean = false, 'journal CSV complete';
  RAISE NOTICE 'E4 close + statements OK';
END $t$;

-- E5 after the close: a corrected June payment rolls into July with its June date kept; June figures do not move; the check lists it.
DO $t$ DECLARE r jsonb; s_before jsonb; s_after jsonb; cat uuid := (SELECT id FROM public.expense_categories WHERE name = 'Meta and Google ads'); BEGIN
  s_before := public.get_statements('2026-06-01', '2026-06-30');
  RESET ROLE;
  UPDATE public.payments SET amount_paid = 85000 WHERE id = '20000000-0000-0000-0000-000000000001';
  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  BEGIN
    r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-28', 'category_id', cat, 'description', 'Forgotten June bill', 'currency', 'JPY', 'amount', 1000, 'payment_method', 'bank_transfer'));
    RAISE EXCEPTION 'June is closed; a new June expense must be refused';
  EXCEPTION WHEN check_violation THEN ASSERT SQLERRM LIKE 'period_closed%', SQLERRM; END;
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true' AND (r->>'reversed')::int = 1 AND (r->>'posted')::int = 1 AND (r->>'moved')::int = 1, 'reversal + repost, moved: ' || r::text;
  ASSERT (SELECT entry_date FROM public.gl_journals WHERE source_type = 'payment' AND kind = 'auto' AND status = 'posted' AND source_id = '20000000-0000-0000-0000-000000000001') = '2026-07-01', 'repost on the first open day';
  ASSERT (SELECT source_date FROM public.gl_journals WHERE source_type = 'payment' AND kind = 'auto' AND status = 'posted' AND source_id = '20000000-0000-0000-0000-000000000001') = '2026-06-03', 'original date kept';
  s_after := public.get_statements('2026-06-01', '2026-06-30');
  ASSERT s_after->'balance_sheet'->'totals' = s_before->'balance_sheet'->'totals' AND s_after->'income_statement'->'lines' = s_before->'income_statement'->'lines', 'June as reported to the 税理士 does not change';
  r := public.run_ledger_check();
  ASSERT (r->>'errors')::int = 0 AND (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'late_posting') = 1, 'the roll-forward is reported, nothing is broken: ' || (r->'issues')::text;
  r := public.get_bank_reconciliation('1101', '2026-07-01');
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'unmatched_ledger') x WHERE (x->>'signed_amount')::numeric = 85000) = 1, 'the corrected receipt waits for July''s statement';
  RAISE NOTICE 'E5 correction after close OK';
END $t$;

SELECT 'ALL E2E TESTS PASSED' AS result;
