\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Fixtures: plans / orders / payments in the live shapes. Dates sit in 2026.
INSERT INTO public.layaway_accounts (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, shipping_fee) VALUES
  ('10000000-0000-0000-0000-000000000001', 'LA-1', 'JPY', 100000, 40000, 60000, 'active', '2026-06-01', 0),
  ('10000000-0000-0000-0000-000000000002', 'LA-2', 'PHP', 10000.50, 3000, 7000.50, 'active', '2026-06-03', 500),
  ('10000000-0000-0000-0000-000000000003', 'LA-3', 'JPY', 50000, 0, 50000, 'active', '2026-06-05', 0),
  ('10000000-0000-0000-0000-000000000004', 'LA-OLD', 'JPY', 80000, 80000, 0, 'completed', '2025-01-10', 0),
  ('10000000-0000-0000-0000-000000000005', 'LA-TEST', 'JPY', 999, 999, 0, 'completed', '2026-06-01', 0),
  ('10000000-0000-0000-0000-000000000006', 'LA-PRE', 'JPY', 60000, 20000, 40000, 'active', '2026-03-01', 0);
UPDATE public.layaway_accounts SET is_test = true WHERE invoice_number = 'LA-TEST';
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 30000, 'JPY', '2026-06-01', 'Rakuten Bank'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 10000, 'JPY', '2026-07-02', 'cash'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 3000, 'PHP', '2026-06-04', 'bdo'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000004', 80000, 'JPY', '2025-01-10', 'cash'),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000005', 999, 'JPY', '2026-06-01', 'cash'),
  ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000006', 20000, 'JPY', '2026-03-05', 'cash');
INSERT INTO public.payment_allocations (payment_id, allocation_type, allocated_amount) VALUES
  ('20000000-0000-0000-0000-000000000002', 'penalty', 1500),
  ('20000000-0000-0000-0000-000000000002', 'installment', 8500);
INSERT INTO public.cash_orders (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, shipping_fee, cod_fee) VALUES
  ('30000000-0000-0000-0000-000000000001', 'CO-1', 'JPY', 25000, 25000, 0, 'completed', '2026-06-10', 1000, 330);
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 25000, 'JPY', '2026-06-10', 'cod');

-- Before the start date is set nothing posts, even for admin.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.gl_post_now();
  ASSERT r->>'started' = 'false' AND r->>'reason' = 'ledger_start_not_set', 'no start: ' || r::text;
  r := public.get_ledger_status();
  ASSERT r->>'ledger_start_date' IS NULL AND (r->>'journal_count')::int = 0, 'status before start: ' || r::text;
  ASSERT (r->>'fiscal_year_start_month')::int = 5, 'fy month';
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-06-01', 'description', 'x', 'lines', '[]'::jsonb));
  ASSERT r->>'error' = 'ledger_start_not_set', 'manual before start: ' || r::text;
  RAISE NOTICE 'L1 gated by start date OK';
END $t$;

-- Permissions.
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_ledger_status();            ASSERT r->>'error' = 'permission_denied', 'finance status';
  r := public.gl_post_now();                  ASSERT r->>'error' = 'permission_denied', 'finance post';
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'error' = 'permission_denied', 'finance start';
  r := public.close_period('2026-06-01');     ASSERT r->>'error' = 'permission_denied', 'finance close';
  ASSERT (SELECT count(*) FROM public.gl_accounts) = 0, 'RLS hides the chart from finance';
  RAISE NOTICE 'L2 permissions OK';
END $t$;

-- Start the ledger on 2026-06-01 and post.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.set_ledger_start('2026-06-15'); ASSERT r->>'error' = 'invalid_date', 'start must be first of month';
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'set start: ' || r::text;
  r := public.get_ledger_status();
  ASSERT r->'pending' = 'null'::jsonb, 'status does not run the engine unless asked: ' || (r->'pending')::text;
  r := public.get_ledger_status(true);
  ASSERT (r->'pending'->>'pending')::int = 7, 'pending before posting (2 sales, 3 payments, CO sale, CO payment; LA-PRE is before the start): ' || r::text;
END $t$;
DO $t$ DECLARE r jsonb; j record; BEGIN
  r := public.gl_post_now();
  ASSERT (r->>'posted')::int = 7 AND (r->>'reversed')::int = 0, 'first posting: ' || r::text;
  r := public.gl_post_now();
  ASSERT (r->>'posted')::int = 0 AND (r->>'reversed')::int = 0, 'idempotent second run: ' || r::text;
  ASSERT (SELECT count(*) FROM public.gl_journals) = 7, 'seven journals';
  ASSERT (SELECT count(*) FROM public.gl_posting_runs) = 2, 'two runs recorded';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'layaway_sale' AND source_id = '10000000-0000-0000-0000-000000000001';
  ASSERT j.entry_date = '2026-06-01' AND j.total_jpy = 100000, 'LA-1 sale dated at first payment, full price: ' || j.total_jpy;
  ASSERT (SELECT sum(credit_jpy) FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4100') = 100000, 'LA-1 Cr Sales';
  ASSERT (SELECT sum(debit_jpy) FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1200') = 100000, 'LA-1 Dr receivable';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'layaway_sale' AND source_id = '10000000-0000-0000-0000-000000000002';
  ASSERT j.entry_date = '2026-06-04', 'LA-2 sale dated at its first payment';
  ASSERT (SELECT debit_jpy FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1200') = round(10000.50 / 0.42), 'PHP converted at the one rate: ' || (SELECT debit_jpy FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1200');
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4300') = 500, 'shipping split out';
  ASSERT (SELECT fx_php_per_jpy FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1200') = 0.42, 'rate recorded';
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines WHERE journal_id = j.id) = 0, 'PHP journal balanced after rounding';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000001';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '1102', 'Rakuten Bank spelling -> 1102';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000002';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '1010', 'JPY cash -> 1010';
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4400') = 1500, 'penalty allocation -> 4400';
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1200') = 8500, 'rest reduces the receivable';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000003';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '1111', 'bdo -> 1111';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'cash_order_sale';
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4300') = 1330, 'shipping + COD fee -> 4300';
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4100') = 23670, 'cash order sales net of fees';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'cash_payment';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '1140', 'cod -> carrier receivable';

  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journal_lines WHERE account_id = '10000000-0000-0000-0000-000000000005'), 'test plan excluded';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journal_lines WHERE account_id = '10000000-0000-0000-0000-000000000004'), 'plan before start excluded';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journal_lines WHERE account_id = '10000000-0000-0000-0000-000000000003'), 'zero-payment plan is not a sale';
  RAISE NOTICE 'L3 E1/E2/E4 postings OK';
END $t$;

-- Trial balance ties.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_trial_balance('2026-06-01', '2026-06-30');
  ASSERT (SELECT sum((x->>'debit_jpy')::numeric) - sum((x->>'credit_jpy')::numeric) FROM jsonb_array_elements(r->'rows') x) = 0, 'TB debits = credits';
  ASSERT (SELECT (x->>'closing_jpy')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'code' = '1200') = 100000 + round(10000.50/0.42) - 30000 - round(3000/0.42), 'receivable closing June: ' || r::text;
  r := public.get_trial_balance('2026-07-01', '2026-07-31');
  ASSERT (SELECT (x->>'opening_jpy')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'code' = '1200') = 100000 + round(10000.50/0.42) - 30000 - round(3000/0.42), 'July opening = June closing';
  ASSERT (SELECT (x->>'credit_jpy')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'code' = '4400') = 1500, 'penalty income in July';
  r := public.get_chart_of_accounts(NULL);
  ASSERT (SELECT (x->>'balance_jpy')::numeric FROM jsonb_array_elements(r->'accounts') x WHERE x->>'code' = '4100') = 100000 + round(9500.50/0.42) + 1 + 23670, 'sales balance (the 1-yen rounding difference of LA-2 sits on its largest credit line) (credit-normal): ' || (SELECT x->>'balance_jpy' FROM jsonb_array_elements(r->'accounts') x WHERE x->>'code' = '4100');
  r := public.get_ledger('2026-06-01', '2026-07-31', '1200', NULL, NULL, NULL, 50, 0);
  ASSERT (r->>'total')::int = 5, 'ledger filter by account: ' || (r->>'total');
  ASSERT jsonb_array_length(r->'journals'->0->'lines') >= 2, 'lines attached';
  r := public.get_ledger('2026-06-01', '2026-07-31', NULL, NULL, NULL, 'la-2', 50, 0);
  ASSERT (r->>'total')::int = 2, 'ledger search by invoice: ' || (r->>'total');
  RAISE NOTICE 'L4 trial balance / ledger reads OK';
END $t$;

-- Source changes: void, edit, forfeit, reactivate, unknown spelling, store credit, expense, refunds.
RESET ROLE;
UPDATE public.payments SET voided_at = now() WHERE id = '20000000-0000-0000-0000-000000000003';
UPDATE public.payments SET amount_paid = 12000 WHERE id = '20000000-0000-0000-0000-000000000002';
UPDATE public.layaway_accounts SET total_paid = 42000, remaining_balance = 58000 WHERE id = '10000000-0000-0000-0000-000000000001';
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000003', 5000, 'JPY', '2026-08-01', 'Mystery Wallet'),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000003', 2000, 'JPY', '2026-08-02', 'loyalty_redemption');
UPDATE public.layaway_accounts SET total_paid = 7000, remaining_balance = 43000 WHERE id = '10000000-0000-0000-0000-000000000003';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; j record; BEGIN
  r := public.get_ledger_status();
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'unmapped_methods') x WHERE x->>'spelling' = 'mystery wallet') = 1, 'unknown spelling listed: ' || (r->'unmapped_methods')::text;
  r := public.gl_post_now();
  ASSERT (r->>'reversed')::int = 3 AND (r->>'posted')::int = 4, 'void + edit + LA-2 sale (its only payment voided) reversed; edit + LA-3 sale + 2 payments posted: ' || r::text;
  ASSERT (SELECT status FROM public.gl_journals WHERE source_type = 'layaway_sale' AND source_id = '10000000-0000-0000-0000-000000000002' AND kind = 'auto') = 'reversed', 'LA-2 is no longer a sale once its only payment is voided';
  ASSERT (SELECT status FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000003' AND kind = 'auto') = 'reversed', 'voided payment journal reversed';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE kind = 'reversal') = 3, 'three reversal journals';
  SELECT * INTO j FROM public.gl_journals WHERE kind = 'reversal' AND source_id = '20000000-0000-0000-0000-000000000003';
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1111') = 3000, 'reversal mirrors the original lines';
  ASSERT (SELECT credit_jpy FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '1111') = round(3000/0.42), 'reversal keeps the original yen';
  ASSERT (SELECT total_jpy FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000002' AND status = 'posted' AND kind = 'auto') = 12000, 'edited payment reposted at 12000';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000002') = 3, 'old + reversal + new';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000006' AND kind = 'auto';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '1190', 'unknown spelling -> suspense';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000007';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '4160', 'loyalty redemption -> contra revenue';
  ASSERT (SELECT entry_date FROM public.gl_journals WHERE source_type = 'layaway_sale' AND source_id = '10000000-0000-0000-0000-000000000003' AND status = 'posted' AND kind = 'auto') = '2026-08-01', 'LA-3 became a sale at its first payment';

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.set_payment_method_map('Mystery Wallet', '1122', 'bank');
  ASSERT r->>'ok' = 'true' AND (r->'repost'->>'reversed')::int = 1 AND (r->'repost'->>'posted')::int = 1, 'mapping reposts: ' || r::text;
  ASSERT (SELECT account_code FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_id = '20000000-0000-0000-0000-000000000006' AND g.status = 'posted' AND g.kind = 'auto' AND l.debit > 0) = '1122', 'reposted to PayPay';
  RAISE NOTICE 'L5 source changes OK';
END $t$;

-- Cosmetic edits must not churn: a reference number, a category rename, a touch of updated_at.
RESET ROLE;
UPDATE public.payments SET reference_number = 'REF-1' WHERE id = '20000000-0000-0000-0000-000000000001';
UPDATE public.layaway_accounts SET updated_at = now() WHERE id = '10000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.gl_post_now();
  ASSERT (r->>'posted')::int = 0 AND (r->>'reversed')::int = 0, 'memo-only changes do not repost: ' || r::text;
  RAISE NOTICE 'L5b fingerprint stable OK';
END $t$;

-- Forfeiture then reactivation; store credit issued from a cancelled order; expense; refunds.
RESET ROLE;
UPDATE public.layaway_accounts SET status = 'forfeited', forfeited_at = '2026-09-01 03:00+09' WHERE id = '10000000-0000-0000-0000-000000000001';
UPDATE public.layaway_accounts SET status = 'final_forfeited', total_paid = 20000, remaining_balance = 40000 WHERE id = '10000000-0000-0000-0000-000000000006';
INSERT INTO public.store_credit_lots (id, currency, original_amount, remaining_amount, source_type, source_cash_order_id, issued_at) VALUES
  ('50000000-0000-0000-0000-000000000001', 'JPY', 4000, 4000, 'cancelled_cash', NULL, '2026-09-02 10:00+09'),
  ('50000000-0000-0000-0000-000000000002', 'PHP', 1000, 0, 'manual_admin', NULL, '2026-09-03 10:00+09');
UPDATE public.store_credit_lots SET status = 'voided' WHERE id = '50000000-0000-0000-0000-000000000002';
INSERT INTO public.store_credit_transactions (txn_type, amount, currency, account_id, created_at) VALUES
  ('redeemed', 1500, 'JPY', '10000000-0000-0000-0000-000000000003', '2026-09-04 10:00+09'),
  ('redeemed', 700, 'JPY', NULL, '2026-09-04 11:00+09'),
  ('expired', 300, 'JPY', NULL, '2026-09-04 12:00+09');
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000003', 1500, 'JPY', '2026-09-04', 'store_credit');
INSERT INTO public.square_payments (id, environment) VALUES ('60000000-0000-0000-0000-000000000001', 'production'), ('60000000-0000-0000-0000-000000000002', 'sandbox');
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, cash_order_id, amount_jpy, status, provider_created_at) VALUES
  ('rf_1', '60000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 2000, 'COMPLETED', '2026-09-05 10:00+09'),
  ('rf_2', '60000000-0000-0000-0000-000000000002', NULL, 999, 'COMPLETED', '2026-09-05 10:00+09'),
  ('rf_3', '60000000-0000-0000-0000-000000000001', NULL, 500, 'PENDING', '2026-09-05 10:00+09');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; j record; e uuid; BEGIN
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-09-06', 'category_id', (SELECT id FROM public.expense_categories WHERE name = 'Photoroom'),
         'description', 'Photoroom September', 'currency', 'JPY', 'amount', 3000, 'payment_method', 'card'));
  ASSERT r->>'ok' = 'true', 'expense draft: ' || r::text;
  e := (r->'expense'->>'id')::uuid;
  r := public.gl_post_now();
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'expense') = 0, 'draft expense not posted';
  r := public.approve_expense(e);
  ASSERT r->>'ok' = 'true', 'approve: ' || r::text;
  r := public.gl_post_now();
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'expense' AND source_id = e AND kind = 'auto' AND status = 'posted';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '6500', 'Photoroom -> 6500';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND credit > 0) = '1190', 'card without Paid from -> suspense';
  r := public.get_ledger_status();
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'expenses_without_paid_from') x WHERE (x->>'id')::uuid = e) = 1, 'listed as needing Paid from';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'unmapped_methods') x WHERE x->>'spelling' = 'card') = 0, 'expense methods are not "unmapped spellings"';
  r := public.get_paid_from_accounts();
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'accounts') x WHERE x->>'code' = '1102') = 1 AND (SELECT count(*) FROM jsonb_array_elements(r->'accounts') x WHERE x->>'code' = '1200') = 0, 'paid-from list = cash/bank/clearing only';
  r := public.set_expense_paid_from(e, '1200'); ASSERT r->>'error' = 'invalid_account', 'receivable is not a paying account';
  r := public.set_expense_paid_from(e, '1102'); ASSERT r->>'ok' = 'true', 'paid from Rakuten on an approved row (approve_expenses): ' || r::text;
  r := public.gl_post_now();
  ASSERT (r->>'reversed')::int >= 1, 'changed Paid from reposts';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'expense' AND source_id = e AND kind = 'auto' AND status = 'posted';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND credit > 0) = '1102', 'now paid from Rakuten';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'layaway_close' AND source_id = '10000000-0000-0000-0000-000000000001' AND status = 'posted' AND kind = 'auto';
  ASSERT j.entry_date = '2026-09-01', 'forfeit dated at forfeited_at (JST)';
  ASSERT (SELECT debit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4150') = 58000, 'uncollected remainder reversed';
  ASSERT (SELECT credit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4500') = 42000, 'money kept -> forfeiture income';
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines WHERE journal_id = j.id) = 0, 'forfeit journal balanced';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'store_credit_issue' AND source_id = '50000000-0000-0000-0000-000000000001';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '4150', 'cancellation credit -> sales reversal';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals WHERE source_id = '50000000-0000-0000-0000-000000000002'), 'voided lot never posted';
  ASSERT (SELECT count(*) FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id
           WHERE g.status = 'posted' AND g.kind = 'auto' AND l.account_code = '2300' AND l.debit = 1500) = 1, 'a Hub redemption debits 2300 exactly once (payment row only)';
  ASSERT (SELECT account_code FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'payment' AND g.source_id = '20000000-0000-0000-0000-000000000010' AND g.kind = 'auto' AND l.debit > 0) = '2300', 'store_credit payment -> Dr 2300';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'store_credit_use') = 2, 'only off-Hub redemption and expiry post from transactions';
  ASSERT (SELECT account_code FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'store_credit_use' AND l.credit = 700) = '4100', 'off-Hub redemption -> Sales';
  ASSERT (SELECT account_code FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'store_credit_use' AND l.credit = 300) = '4900', 'expired credit -> other income';

  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'layaway_close' AND source_id = '10000000-0000-0000-0000-000000000006' AND kind = 'auto' AND status = 'posted';
  ASSERT j.id IS NOT NULL AND (SELECT debit FROM public.gl_journal_lines WHERE journal_id = j.id AND account_code = '4150') = 40000, 'plan sold before the ledger start still posts its forfeiture';

  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'square_refund') = 1, 'only the completed production refund';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'square_refund';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND credit > 0) = '1130' AND j.total_jpy = 2000, 'refund out of Square clearing';

  r := public.reverse_journal(j.id, 'test');
  ASSERT r->>'error' = 'auto_journal_follows_source', 'auto journals cannot be hand-reversed';
  RAISE NOTICE 'L6 forfeit / credit / expense / refund OK';
END $t$;

RESET ROLE;
UPDATE public.layaway_accounts SET status = 'active', forfeited_at = NULL WHERE id = '10000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.gl_post_now();
  ASSERT (r->>'reversed')::int = 1 AND (r->>'posted')::int = 0, 'reactivation reverses the forfeit: ' || r::text;
  RESET ROLE;
  UPDATE public.layaway_accounts SET updated_at = now() - interval '1 hour' WHERE id = '10000000-0000-0000-0000-000000000006';
  SET ROLE authenticated;
  r := public.gl_post_now();
  ASSERT (r->>'reversed')::int = 0 AND (r->>'posted')::int = 0, 'touching a final_forfeited plan does not churn: ' || r::text;
  ASSERT (SELECT status FROM public.gl_journals WHERE source_type = 'layaway_close' AND kind = 'auto' AND source_id = '10000000-0000-0000-0000-000000000001') = 'reversed', 'forfeit journal reversed';
  RAISE NOTICE 'L7 reactivation OK';
END $t$;

-- Periods: close order, closed-period posting moves forward, manual journals, reopen.
DO $t$ DECLARE r jsonb; j record; BEGIN
  r := public.close_period('2026-07-01'); ASSERT r->>'error' = 'earlier_period_open' AND r->>'period' = '2026-06-01', 'must close June first: ' || r::text;
  r := public.close_period(date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date)::date); ASSERT r->>'error' = 'period_not_ended', 'current month cannot close';
  r := public.close_period('2026-06-01'); ASSERT r->>'ok' = 'true', 'close June: ' || r::text;
  r := public.close_period('2026-06-01'); ASSERT r->>'error' = 'already_closed', 'twice';
  r := public.close_period('2026-07-01'); ASSERT r->>'ok' = 'true', 'close July';
  ASSERT (SELECT fiscal_year FROM public.gl_periods WHERE period_start = '2026-06-01') = 2027, 'June 2026 belongs to FY2027 (May-Apr)';

  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-06-15', 'description', 'Late entry',
         'lines', '[{"a":"6600","side":"dr","amt":"1000","cur":"JPY"},{"a":"1010","side":"cr","amt":"1000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'error' = 'period_closed', 'manual into closed period refused: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-08-15', 'description', 'Unbalanced',
         'lines', '[{"a":"6600","side":"dr","amt":"1000","cur":"JPY"},{"a":"1010","side":"cr","amt":"900","cur":"JPY"}]'::jsonb));
  ASSERT r->>'error' = 'unbalanced', 'unbalanced refused: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-08-15', 'description', 'Bad account',
         'lines', '[{"a":"9999","side":"dr","amt":"1000","cur":"JPY"},{"a":"1010","side":"cr","amt":"1000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'error' = 'invalid_lines', 'unknown account refused';
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-08-15', 'description', 'Office rent August',
         'lines', '[{"a":"6600","side":"dr","amt":"42000","cur":"PHP","memo":"Rent"},{"a":"1111","side":"cr","amt":"42000","cur":"PHP"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'manual PHP journal: ' || r::text;
  ASSERT (r->'journal'->>'total_jpy')::numeric = round(42000/0.42), 'manual converted';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'gl_journal' AND action = 'post_manual_journal') = 1, 'manual audited';
  r := public.reverse_journal((r->'journal'->>'id')::uuid, 'Posted twice by mistake');
  ASSERT r->>'ok' = 'true', 'manual reversal 2: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-08-16', 'description', 'Rounding case',
         'lines', '[{"a":"6600","side":"dr","amt":"100.3","cur":"PHP"},{"a":"1111","side":"cr","amt":"100","cur":"PHP"},{"a":"1121","side":"cr","amt":"0.3","cur":"PHP"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'rounded PHP journal posts: ' || r::text;
  ASSERT (SELECT min(credit_jpy) FROM public.gl_journal_lines WHERE journal_id = (r->'journal'->>'id')::uuid AND credit > 0) >= 0, 'no negative yen after rounding';
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines WHERE journal_id = (r->'journal'->>'id')::uuid) = 0, 'rounded journal balanced';
  ASSERT r->>'ok' = 'true', 'manual reversal: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('kind', 'opening', 'entry_date', '2026-08-01', 'description', 'Opening',
         'lines', '[{"a":"1102","side":"dr","amt":"1","cur":"JPY"},{"a":"3100","side":"cr","amt":"1","cur":"JPY"}]'::jsonb));
  ASSERT r->>'error' = 'opening_must_be_start_date', 'opening only on the start date';

  r := public.reopen_period('2026-06-01', 'fix'); ASSERT r->>'error' = 'later_period_closed', 'reopen latest first';
  r := public.reopen_period('2026-07-01', 'Accountant adjustment'); ASSERT r->>'ok' = 'true', 'reopen July';
  r := public.reopen_period('2026-07-01', 'again'); ASSERT r->>'error' = 'not_closed', 'reopen twice';
  r := public.set_ledger_start('2026-05-01'); ASSERT r->>'error' = 'ledger_has_journals', 'start date frozen once posted';
  RAISE NOTICE 'L8 periods / manual journals OK';
END $t$;

-- A late change inside a CLOSED June lands on 1 July with the original date kept (D6).
RESET ROLE;
UPDATE public.payments SET voided_at = now() WHERE id = '20000000-0000-0000-0000-000000000001';
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', 7000, 'JPY', '2026-06-20', 'paypay');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; j record; BEGIN
  r := public.gl_post_now();
  ASSERT (r->>'moved')::int = 2 AND (r->>'reversed')::int = 2, 'late June payment + LA-1 sale re-dated (its first payment was voided) both moved: ' || r::text;
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'layaway_sale' AND source_id = '10000000-0000-0000-0000-000000000001' AND kind = 'auto' AND status = 'posted';
  ASSERT j.entry_date = '2026-07-01' AND j.source_date = '2026-06-20', 'LA-1 sale now dated at the next payment, posted in July';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'payment' AND source_id = '20000000-0000-0000-0000-000000000008';
  ASSERT j.entry_date = '2026-07-01' AND j.source_date = '2026-06-20', 'posted on the first open day, original date kept';
  r := public.get_ledger_status();
  ASSERT (r->>'moved_count')::int >= 1, 'moved count shown';
  RAISE NOTICE 'L9 closed-period rule OK';
END $t$;

-- Immutability, even for a privileged writer.
RESET ROLE;
DO $t$ DECLARE j uuid; BEGIN
  SELECT id INTO j FROM public.gl_journals WHERE status = 'posted' LIMIT 1;
  BEGIN UPDATE public.gl_journals SET description = 'x' WHERE id = j; RAISE EXCEPTION 'journal edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.gl_journal_lines SET debit = 1 WHERE journal_id = j; RAISE EXCEPTION 'line edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM public.gl_journal_lines WHERE journal_id = j; RAISE EXCEPTION 'line delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM public.gl_journals WHERE id = j; RAISE EXCEPTION 'journal delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN TRUNCATE public.gl_journal_lines; RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.gl_journals (entry_date, period_start, source_date, kind, source_type, description)
    VALUES ('2026-08-01', public.gl_period_for('2026-08-01'), '2026-08-01', 'manual', 'manual', 'one-sided');
    INSERT INTO public.gl_journal_lines (journal_id, line_no, account_code, debit, currency, debit_jpy)
    VALUES ((SELECT id FROM public.gl_journals WHERE description = 'one-sided'), 1, '1010', 5, 'JPY', 5);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'unbalanced direct insert should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'L10 immutability OK';
END $t$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_ledger_status(); ASSERT r->>'error' = 'permission_denied', 'staff (manage_expenses only) cannot see the ledger';
  r := public.set_expense_paid_from((SELECT id FROM public.expenses WHERE status = 'approved' AND source = 'manual' LIMIT 1), '1101');
  ASSERT r->>'error' = 'permission_denied', 'staff cannot change Paid from on an approved row';
  r := public.get_paid_from_accounts(); ASSERT r->>'accounts' IS NOT NULL, 'staff can list paying accounts for the dialog';
  RAISE NOTICE 'L11 staff denied OK';
END $t$;
RESET ROLE;
DO $t$ BEGIN
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines) = 0, 'whole ledger balanced';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals j WHERE j.total_jpy <> (SELECT sum(debit_jpy) FROM public.gl_journal_lines l WHERE l.journal_id = j.id)), 'totals match lines';
END $t$;
SELECT 'ALL LEDGER TESTS PASSED' AS result;
