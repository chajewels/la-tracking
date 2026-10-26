\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Phase 6: provider fees, clearing, transfers, peso revaluation. Fresh copy after stubs + Phases 1–6 (own ledger start).

-- Fixtures: a card (Square) cash order, a COD cash order, a peso layaway, Square payment payloads with fees.
INSERT INTO public.cash_orders (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('30000000-0000-0000-0000-000000000001', 'CO-SQ',  'JPY', 30000, 30000, 0, 'completed', '2026-06-05'),
  ('30000000-0000-0000-0000-000000000002', 'CO-COD', 'JPY', 20000, 20000, 0, 'completed', '2026-06-08'),
  ('30000000-0000-0000-0000-000000000003', 'CO-TEST','JPY', 999,   999,   0, 'completed', '2026-06-08');
UPDATE public.cash_orders SET is_test = true WHERE invoice_number = 'CO-TEST';
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('30000000-0000-0000-0000-000000000001', 30000, 'JPY', '2026-06-05', 'square'),
  ('30000000-0000-0000-0000-000000000002', 20000, 'JPY', '2026-06-08', 'cod'),
  ('30000000-0000-0000-0000-000000000003', 999,   'JPY', '2026-06-08', 'square');
INSERT INTO public.square_payments (id, cash_order_id, environment, test, status, amount_jpy, captured_at, last_payload) VALUES
  ('70000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'production', false, 'captured', 30000, '2026-06-05 02:00+00',
   '{"processing_fee":[{"amount_money":{"amount":975,"currency":"JPY"},"type":"INITIAL"}]}'),
  ('70000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', 'production', false, 'captured', 999, '2026-06-08 02:00+00',
   '{"processing_fee":[{"amount_money":{"amount":32,"currency":"JPY"}}]}'),
  ('70000000-0000-0000-0000-000000000003', NULL, 'sandbox', true, 'captured', 5000, '2026-06-09 02:00+00',
   '{"processing_fee":[{"amount_money":{"amount":160,"currency":"JPY"}}]}');
INSERT INTO public.layaway_accounts (id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('10000000-0000-0000-0000-000000000001', 'LA-PHP', 'PHP', 100000, 42000, 58000, 'active', '2026-06-10');
INSERT INTO public.payments (account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('10000000-0000-0000-0000-000000000001', 42000, 'PHP', '2026-06-10', 'bdo');

-- X1 rate history: seeded from the setting; a Settings change is logged + audited; dated rates; gl_rate_at.
DO $t$ DECLARE n int; BEGIN
  ASSERT (SELECT count(*) FROM public.php_jpy_rate_history) = 1, 'seeded once from the live setting';
  ASSERT (SELECT rate FROM public.php_jpy_rate_history LIMIT 1) = 0.42, 'seed rate 0.42';
  UPDATE public.system_settings SET value = '"0.42"'::jsonb WHERE key = 'php_jpy_rate';
  ASSERT (SELECT count(*) FROM public.php_jpy_rate_history) = 1, 'same rate -> no new row';
  UPDATE public.system_settings SET value = '"0.40"'::jsonb WHERE key = 'php_jpy_rate';
  ASSERT (SELECT rate FROM public.php_jpy_rate_history ORDER BY effective_from DESC LIMIT 1) = 0.40, 'change logged for today';
  SELECT count(*) INTO n FROM public.audit_logs WHERE entity_type = 'system_setting' AND action = 'set_php_jpy_rate';
  ASSERT n = 1, 'audited: ' || n;
  UPDATE public.system_settings SET value = '"0.42"'::jsonb WHERE key = 'php_jpy_rate';
  ASSERT public.gl_rate_at(DATE '2026-06-30') = 0.42 OR public.gl_rate_at(DATE '2026-06-30') = (SELECT rate FROM public.php_jpy_rate_history ORDER BY effective_from LIMIT 1), 'rate before any dated row = earliest / live';
  RAISE NOTICE 'X1 rate history OK';
END $t$;

-- X2 permissions.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-06-20","amount_received_jpy":1}'); ASSERT r->>'error' = 'permission_denied', 'staff settlement';
  r := public.record_fund_transfer('{}'); ASSERT r->>'error' = 'permission_denied', 'staff transfer';
  r := public.get_clearing_summary(); ASSERT r->>'error' = 'permission_denied', 'staff summary';
  r := public.get_fx_revaluation(); ASSERT r->>'error' = 'permission_denied', 'staff fx';
  r := public.get_rate_history(); ASSERT r->>'error' = 'permission_denied', 'staff rates';
  r := public.set_php_jpy_rate(0.5); ASSERT r->>'error' = 'permission_denied', 'staff rate';
  ASSERT (SELECT count(*) FROM public.php_jpy_rate_history) = 0 AND (SELECT count(*) FROM public.provider_settlements) = 0 AND (SELECT count(*) FROM public.fund_transfers) = 0, 'RLS hides everything from staff';
  BEGIN
    INSERT INTO public.provider_settlements (provider, received_on, amount_received_jpy, bank_account) VALUES ('square', '2026-06-20', 1, '1101');
    RAISE EXCEPTION 'table write should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'X2 permissions OK';
END $t$;

-- X3 admin: Square fee from the payload; settlements clear the clearing account; validation; void.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; sid uuid; BEGIN
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'ledger start: ' || r::text;
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post: ' || r::text;
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'square_fee' AND status = 'posted') = 1, 'one Square fee (test order and sandbox row excluded)';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'square_fee' AND l.account_code = '6300') = 975, 'fee to 6300';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1130') = 30000 - 975, 'Square clearing = net of fee';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1140') = 20000, 'COD receivable open';

  r := public.record_provider_settlement('{"provider":"nope","received_on":"2026-06-20","amount_received_jpy":"1","bank_account":"1101"}'); ASSERT r->>'error' = 'invalid_provider', 'provider checked';
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-05-20","amount_received_jpy":"1","bank_account":"1101"}'); ASSERT r->>'error' = 'invalid_date', 'before the start';
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-06-20","amount_received_jpy":"29025"}'); ASSERT r->>'error' = 'invalid_account', 'bank required when money received';
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-06-20","amount_received_jpy":"29025","bank_account":"1130"}'); ASSERT r->>'error' = 'invalid_account', 'clearing is not a bank';
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-06-20","amount_received_jpy":"0","fees_jpy":"0"}'); ASSERT r->>'error' = 'invalid_amount', 'empty settlement refused';
  r := public.record_provider_settlement('{"provider":"square","received_on":"2026-06-20","amount_received_jpy":"¥29,025","bank_account":"1101","reference":"SQ-PAYOUT-1"}');
  ASSERT r->>'ok' = 'true', 'Square payout: ' || r::text;
  r := public.record_provider_settlement('{"provider":"cod_carrier","received_on":"2026-06-25","amount_received_jpy":"19450","fees_jpy":"550","bank_account":"1102","reference":"YAMATO-JUN","note":"COD handling"}');
  ASSERT r->>'ok' = 'true', 'courier remittance: ' || r::text;
  sid := (r->'settlement'->>'id')::uuid;
  r := public.record_provider_settlement('{"provider":"paidy","received_on":"2026-06-20","fees_jpy":"550","adjustments_jpy":"-100"}');
  ASSERT r->>'ok' = 'true', 'fee-only statement needs no bank: ' || r::text;
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post settlements: ' || r::text;
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1130') = 0, 'Square clearing cleared';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1101') = 29025, 'SMBC received the payout';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1140') = 0, 'COD receivable cleared: 19450 cash + 550 charges';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'settlement_fee' AND l.account_code = '5400') = 550, 'courier charge to 5400 (D2)';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'settlement_fee' AND l.account_code = '6300') = 550, 'Paidy statement fee to 6300';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'settlement_adjustment' AND l.account_code = '6900') = 100, 'negative adjustment to 6900';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1131') = -650, 'Paidy clearing negative until the capture arrives (statement before payments)';

  r := public.void_provider_settlement(sid, 'x'); ASSERT r->>'error' = 'reason_required', 'reason';
  r := public.void_provider_settlement(sid, 'wrong month'); ASSERT r->>'ok' = 'true', 'voided';
  r := public.void_provider_settlement(sid, 'again'); ASSERT r->>'error' = 'already_voided', 'once';
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 2, 'void reverses payout + fee: ' || r::text;
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1140') = 20000, 'COD receivable open again';

  r := public.get_clearing_summary(6);
  ASSERT jsonb_array_length(r->'providers') = 4, 'four providers';
  ASSERT (SELECT (x->>'balance_jpy')::numeric FROM jsonb_array_elements(r->'providers') x WHERE x->>'provider' = 'square') = 0, 'square balance 0';
  ASSERT (SELECT (x->>'captured_jpy')::numeric FROM jsonb_array_elements(r->'providers') x WHERE x->>'provider' = 'square') = 30000, 'captured gross';
  ASSERT (SELECT (x->>'fees_jpy')::numeric FROM jsonb_array_elements(r->'providers') x WHERE x->>'provider' = 'square') = 975, 'fees';
  ASSERT (SELECT (x->>'payouts_jpy')::numeric FROM jsonb_array_elements(r->'providers') x WHERE x->>'provider' = 'square') = 29025, 'payouts';
  ASSERT (SELECT (x->>'balance_jpy')::numeric FROM jsonb_array_elements(r->'providers') x WHERE x->>'provider' = 'cod_carrier') = 20000, 'cod open';
  ASSERT (SELECT x->>'oldest_open' FROM jsonb_array_elements(r->'providers') x WHERE x->>'provider' = 'cod_carrier') = '2026-06-08', 'oldest open COD capture';
  ASSERT jsonb_array_length(r->'settlements') = 3, 'settlements listed (voided included)';
  RAISE NOTICE 'X3 fees / settlements OK';
END $t$;

-- X4 transfers: JPY -> PHP remittance at the bank's rate with a fee; same-currency move; validation; void.
DO $t$ DECLARE r jsonb; tid uuid; j record; BEGIN
  r := public.record_fund_transfer('{"transfer_on":"2026-06-15","from_account":"1101","from_amount":"100000","from_currency":"JPY","to_account":"1111","to_amount":"38000","to_currency":"PHP","fee_amount":"880","fee_currency":"JPY","reference":"REMIT-1"}');
  ASSERT r->>'ok' = 'true', 'remittance: ' || r::text;
  tid := (r->'transfer'->>'id')::uuid;
  r := public.record_fund_transfer('{"transfer_on":"2026-06-16","from_account":"1102","from_amount":"50000","from_currency":"JPY","to_account":"1010","to_amount":"50000","to_currency":"JPY"}');
  ASSERT r->>'ok' = 'true', 'bank to cash: ' || r::text;
  r := public.record_fund_transfer('{"transfer_on":"2026-06-16","from_account":"1102","from_amount":"50000","from_currency":"JPY","to_account":"1010","to_amount":"49000","to_currency":"JPY"}');
  ASSERT r->>'error' = 'amounts_differ', 'same currency must match (fee aside)';
  r := public.record_fund_transfer('{"transfer_on":"2026-06-16","from_account":"1102","from_amount":"50000","from_currency":"JPY","to_account":"1102","to_amount":"50000","to_currency":"JPY"}');
  ASSERT r->>'error' = 'invalid_account', 'same account refused';
  r := public.record_fund_transfer('{"transfer_on":"2026-06-16","from_account":"1102","from_amount":"50000","from_currency":"JPY","to_account":"1200","to_amount":"50000","to_currency":"JPY"}');
  ASSERT r->>'error' = 'invalid_account', 'receivable is not a money account';
  r := public.record_fund_transfer('{"transfer_on":"2026-06-16","from_account":"1102","from_amount":"50000.5","from_currency":"JPY","to_account":"1010","to_amount":"50000.5","to_currency":"JPY"}');
  ASSERT r->>'error' = 'invalid_amount', 'whole yen';
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post transfers: ' || r::text;
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'fund_transfer' AND description LIKE '%REMIT-1' AND status = 'posted';
  ASSERT j.total_jpy = 100000, 'remittance journal balances at 100000 yen: ' || j.total_jpy;
  ASSERT (SELECT l.debit FROM public.gl_journal_lines l WHERE l.journal_id = j.id AND l.account_code = '1111') = 38000, 'BDO receives 38000 pesos';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l WHERE l.journal_id = j.id AND l.account_code = '1111') = round(38000 / 0.42), 'peso leg carried at the Hub rate';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l WHERE l.journal_id = j.id AND l.account_code = '6300') = 880, 'bank fee to 6300';
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l WHERE l.journal_id = j.id AND l.account_code = '6800') = 100000 - round(38000 / 0.42) - 880, 'FX difference to 6800';
  ASSERT (SELECT sum(l.debit_jpy) - sum(l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1010') = 50000, 'cash received';
  r := public.void_fund_transfer(tid, 'duplicate'); ASSERT r->>'ok' = 'true', 'void transfer';
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 1, 'reversed: ' || r::text;
  ASSERT (SELECT sum(l.debit) - sum(l.credit) FROM public.gl_journal_lines l WHERE l.account_code = '1111' AND l.currency = 'PHP') = 42000, 'BDO pesos back to the layaway payment alone after the void';
  r := public.record_fund_transfer('{"transfer_on":"2026-06-15","from_account":"1101","from_amount":"100000","from_currency":"JPY","to_account":"1111","to_amount":"38000","to_currency":"PHP","fee_amount":"880","fee_currency":"JPY","reference":"REMIT-1b"}');
  ASSERT r->>'ok' = 'true', 're-recorded';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 1, 'posted again';
  RAISE NOTICE 'X4 transfers OK';
END $t$;

-- X5 peso revaluation: month ends, a rate change, the increment logic, no churn on an unchanged month.
DO $t$ DECLARE r jsonb; n int; bdo_native numeric; bdo_carry numeric; BEGIN
  SELECT sum(l.debit - l.credit), sum(l.debit_jpy - l.credit_jpy) INTO bdo_native, bdo_carry FROM public.gl_journal_lines l WHERE l.account_code = '1111' AND l.currency = 'PHP';
  ASSERT bdo_native = 42000 + 38000, 'BDO pesos: 42000 payment + 38000 remittance: ' || bdo_native;
  ASSERT bdo_carry = round(42000 / 0.42) + round(38000 / 0.42), 'carrying yen at 0.42';
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post (revaluation at the unchanged rate): ' || r::text;
  SELECT count(*) INTO n FROM public.gl_journals WHERE source_type = 'fx_revaluation' AND status = 'posted';
  ASSERT n = 0, 'same rate -> no revaluation journals: ' || n;

  r := public.set_php_jpy_rate(0.40, '2026-07-31'); ASSERT r->>'ok' = 'true', 'dated rate: ' || r::text;
  ASSERT (SELECT rate FROM public.php_jpy_rate_history WHERE effective_from = '2026-07-31') = 0.40, 'history row';
  ASSERT (public.get_fx_revaluation('2026-06-01')->>'rate_used')::numeric = 0.42 AND (public.get_fx_revaluation('2026-08-01')->>'rate_used')::numeric = 0.40, 'rate in effect per month end';
  ASSERT (public.get_rate_history()->>'current')::numeric = 0.42, 'live setting untouched by a dated rate';
  r := public.get_fx_revaluation('2026-07-01');
  ASSERT (r->>'rate_used')::numeric = 0.40, 'July uses 0.40';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'rows') x WHERE x->>'account' = '4100'), 'revenue (a P&L account with peso lines) is never revalued: ' || r::text;
  ASSERT (SELECT (x->>'native_php')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'account' = '1111') = 42000 + 38000 + 38000, 'July balance as the books stood then: the voided transfer is still in June, its reversal is dated today';
  ASSERT (SELECT (x->>'increment_jpy')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'account' = '1111') = round(118000 / 0.40) - (SELECT (x->>'carrying_jpy')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'account' = '1111'), 'July increment = target − carrying (June cumulative 0)';
  ASSERT (SELECT (x->>'previous_cumulative_jpy')::numeric FROM jsonb_array_elements(r->'rows') x WHERE x->>'account' = '1111') = 0, 'June cumulative 0 (same rate)';
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post revaluation: ' || r::text;
  SELECT count(*) INTO n FROM public.gl_journals WHERE source_type = 'fx_revaluation' AND status = 'posted';
  ASSERT n = 2, 'July: BDO (1111) and the peso receivable (1200) revalued — one journal each: ' || n;
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'fx_revaluation' AND j.entry_date = '2026-07-31' AND l.account_code = '1111') > 0, 'BDO up (pesos worth more yen at 0.40)';
  ASSERT (SELECT sum(l.credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'fx_revaluation' AND l.account_code = '4950') > 0, 'gain on the asset side';
  ASSERT (SELECT sum(l.credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'fx_revaluation' AND l.account_code = '4950') = (SELECT sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals j ON j.id = l.journal_id WHERE j.source_type = 'fx_revaluation' AND l.account_code IN ('1111', '1200')), 'both peso assets gained at 0.40; gain = Σ asset debits';
  ASSERT NOT EXISTS (SELECT 1 FROM public.gl_journals WHERE source_type = 'fx_revaluation' AND entry_date > '2026-07-31'), 'August onwards: no further change at a steady rate';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 0 AND (r->>'reversed')::int = 0, 'idempotent: ' || r::text;

  r := public.set_php_jpy_rate(0.42, '2026-07-31'); ASSERT r->>'ok' = 'true', 'rate corrected back';
  r := public.gl_post_now(); ASSERT (r->>'reversed')::int = 2 AND (r->>'posted')::int = 0, 'correcting the rate reverses the revaluation: ' || r::text;
  r := public.get_rate_history(); ASSERT jsonb_array_length(r->'history') >= 2, 'history listed';
  RAISE NOTICE 'X5 revaluation OK';
END $t$;

-- X6 fee categories are automatic now.
DO $t$ DECLARE r jsonb; cat uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'square_fees';
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-20', 'category_id', cat, 'description', 'Square fees by hand', 'currency', 'JPY', 'amount', '975', 'payment_method', 'other'));
  ASSERT r->>'error' = 'category_booked_automatically' OR r->>'ok' IS NULL, 'manual Square fee refused: ' || r::text;
  RAISE NOTICE 'X6 fee categories OK';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'X6 fee categories OK';
END $t$;
RESET ROLE;
SET ROLE anon;
DO $t$ BEGIN
  BEGIN PERFORM public.get_clearing_summary(); RAISE EXCEPTION 'anon should not execute';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'X7 anon denied OK';
END $t$;
RESET ROLE;
SELECT 'ALL CLEARING TESTS PASSED' AS result;
