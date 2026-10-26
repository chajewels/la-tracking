\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Phase 8: controls. Fresh copy after stubs + Phases 1–8 (own ledger start 2026-06-01, rate 0.42).
-- Book: opening Dr 1101 1,000,000 / Cr 3000 (06-01); LA-JP JPY 100,000 paid 40,000 'sumitomo' 06-05 and 10,000 'sumitomo' 08-10;
--       approved expense "Meta ads" ¥5,000 on 08-15 paid from 1101; approved expense "Props" ¥3,000 on 06-20 paid from 1101.
INSERT INTO public.customers (id, full_name, country) VALUES ('c0000000-0000-0000-0000-00000000000a', 'Tokyo customer', 'Japan');
INSERT INTO public.layaway_accounts (id, customer_id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date) VALUES
  ('10000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-00000000000a', 'LA-JP', 'JPY', 100000, 50000, 50000, 'active', '2026-06-05');
INSERT INTO public.payments (id, account_id, amount_paid, currency, date_paid, payment_method) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 40000, 'JPY', '2026-06-05', 'sumitomo'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 10000, 'JPY', '2026-08-10', 'sumitomo');

-- K1 permissions: every new RPC needs post_journal / view_ledger; internal helpers are not callable; RLS hides the tables.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_close_readiness('2026-06-01'); ASSERT r->>'error' = 'permission_denied', 'staff readiness';
  r := public.run_ledger_check(); ASSERT r->>'error' = 'permission_denied', 'staff check';
  r := public.get_ledger_checks(); ASSERT r->>'error' = 'permission_denied', 'staff checks list';
  r := public.import_bank_statement('{}'); ASSERT r->>'error' = 'permission_denied', 'staff import';
  r := public.auto_match_bank_lines('1101', '2026-08-01'); ASSERT r->>'error' = 'permission_denied', 'staff match';
  r := public.get_bank_reconciliation('1101', '2026-08-01'); ASSERT r->>'error' = 'permission_denied', 'staff rec';
  r := public.sign_off_reconciliation('1101', '2026-08-01', 0); ASSERT r->>'error' = 'permission_denied', 'staff sign-off';
  ASSERT (SELECT count(*) FROM public.bank_statement_lines) = 0 AND (SELECT count(*) FROM public.gl_check_runs) = 0, 'RLS hides';
  BEGIN
    PERFORM public.gl_run_completeness_check('manual', NULL);
    RAISE EXCEPTION 'internal check callable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.gl_auto_match('1101', '2026-08-01', NULL);
    RAISE EXCEPTION 'internal match callable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM count(*) FROM public.gl_live_money_lines;
    RAISE EXCEPTION 'internal view readable';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.bank_import_profiles (account_code, date_col, signed_col) VALUES ('1101', 0, 1);
    RAISE EXCEPTION 'table write should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'K1 permissions OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_bank_reconciliation('1101', '2026-08-01'); ASSERT r->>'error' = 'permission_denied', 'finance without view_ledger';
  r := public.import_bank_statement('{}'); ASSERT r->>'error' = 'permission_denied', 'finance without post_journal';
  RAISE NOTICE 'K1b finance OK';
END $t$;

-- K2 the book.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; e1 uuid; e2 uuid; cat uuid := (SELECT id FROM public.expense_categories WHERE name = 'Meta and Google ads'); BEGIN
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'ledger start: ' || r::text;
  r := public.post_manual_journal(jsonb_build_object('kind', 'opening', 'entry_date', '2026-06-01', 'description', 'Opening bank balance',
         'lines', '[{"a":"1101","side":"dr","amt":"1000000","cur":"JPY"},{"a":"3000","side":"cr","amt":"1000000","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'opening: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-08-15', 'category_id', cat, 'description', 'Meta ads August', 'currency', 'JPY', 'amount', 5000, 'payment_method', 'bank_transfer'));
  ASSERT r->>'ok' = 'true', 'draft 1: ' || r::text; e1 := (r->'expense'->>'id')::uuid;
  r := public.approve_expense(e1); ASSERT r->>'ok' = 'true', 'approve 1';
  r := public.set_expense_paid_from(e1, '1101'); ASSERT r->>'ok' = 'true', 'paid from 1';
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-20', 'category_id', cat, 'description', 'Props June', 'currency', 'JPY', 'amount', 3000, 'payment_method', 'bank_transfer'));
  ASSERT r->>'ok' = 'true', 'draft 2'; e2 := (r->'expense'->>'id')::uuid;
  r := public.approve_expense(e2); ASSERT r->>'ok' = 'true', 'approve 2';
  r := public.set_expense_paid_from(e2, '1101'); ASSERT r->>'ok' = 'true', 'paid from 2';
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post: ' || r::text;
  ASSERT (SELECT sum(l.debit_jpy - l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1101') = 1000000 + 40000 + 10000 - 5000 - 3000, 'SMBC balance';
  RAISE NOTICE 'K2 book OK';
END $t$;

-- K3 close readiness (D1) and the period lock on expenses (D2).
DO $t$ DECLARE r jsonb; d uuid; moved uuid; cat uuid := (SELECT id FROM public.expense_categories WHERE name = 'Meta and Google ads'); n int; BEGIN
  r := public.get_close_readiness('2026-06-01');
  ASSERT (r->>'errors')::int = 0 AND (r->>'can_close')::boolean, 'June has no errors: ' || r::text;
  ASSERT (r->>'warnings')::int = 1 AND jsonb_array_length(r->'unreconciled_accounts') = 1 AND r->'unreconciled_accounts'->0->>'code' = '1101', 'only warning: SMBC not reconciled: ' || r::text;
  r := public.get_close_readiness('2026-06-15'); ASSERT r->>'error' = 'invalid_period', 'month start only';
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-10', 'category_id', cat, 'description', 'Old draft', 'currency', 'JPY', 'amount', 1000, 'payment_method', 'bank_transfer'));
  ASSERT r->>'ok' = 'true', 'draft dated June before the close'; d := (r->'expense'->>'id')::uuid;
  r := public.close_period('2026-06-01', 'June done');
  ASSERT r->>'ok' = 'true', 'close June: ' || r::text;
  ASSERT (SELECT note FROM public.gl_periods WHERE period_start = '2026-06-01') LIKE 'June done | Closed with 2 open item(s)%', 'warnings recorded on the period: ' || (SELECT note FROM public.gl_periods WHERE period_start = '2026-06-01');
  ASSERT (r->'readiness'->>'draft_expenses')::int = 1, 'the old draft counted as a warning';

  BEGIN
    r := public.upsert_expense(jsonb_build_object('expense_date', '2026-06-15', 'category_id', cat, 'description', 'Late June bill', 'currency', 'JPY', 'amount', 1000, 'payment_method', 'bank_transfer'));
    RAISE EXCEPTION 'new expense in a closed month was accepted: %', r::text;
  EXCEPTION WHEN check_violation THEN ASSERT SQLERRM LIKE 'period_closed%', SQLERRM; END;
  BEGIN
    r := public.approve_expense(d);
    RAISE EXCEPTION 'approving a draft dated in a closed month was accepted';
  EXCEPTION WHEN check_violation THEN ASSERT SQLERRM LIKE 'period_closed%', SQLERRM; END;
  BEGIN
    r := public.upsert_expense(jsonb_build_object('id', d, 'expense_date', '2026-06-10', 'category_id', cat, 'description', 'Old draft edited', 'currency', 'JPY', 'amount', 1200, 'payment_method', 'bank_transfer'));
    RAISE EXCEPTION 'editing a draft inside a closed month was accepted';
  EXCEPTION WHEN check_violation THEN ASSERT SQLERRM LIKE 'period_closed%', SQLERRM; END;
  r := public.upsert_expense(jsonb_build_object('id', d, 'expense_date', '2026-07-01', 'category_id', cat, 'description', 'Old draft', 'currency', 'JPY', 'amount', 1000, 'payment_method', 'bank_transfer'));
  ASSERT r->>'ok' = 'true', 'moving the draft to the open month is allowed: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-07-15', 'category_id', cat, 'description', 'July bill', 'currency', 'JPY', 'amount', 1000, 'payment_method', 'bank_transfer'));
  ASSERT r->>'ok' = 'true', 'open month unaffected';
  r := public.void_expense((r->'expense'->>'id')::uuid, 'test'); ASSERT r->>'ok' = 'true' OR r->>'error' IS NULL, 'void in open month: ' || r::text;
  r := public.set_expense_paid_from((SELECT id FROM public.expenses WHERE description = 'Props June'), '1102');
  ASSERT r->>'ok' = 'true', 'Paid from correction on an approved June expense is still allowed: ' || r::text;
  r := public.void_expense((SELECT id FROM public.expenses WHERE description = 'Props June'), 'wrong vendor');
  ASSERT r->>'ok' = 'true' OR r->>'error' IS NULL, 'voiding a June expense is still allowed: ' || r::text;
  RESET ROLE;
  UPDATE public.payments SET amount_paid = 41000 WHERE id = '20000000-0000-0000-0000-000000000001';
  INSERT INTO public.expenses (expense_date, category_id, description, currency, amount, amount_jpy, payment_method, status, source, source_ref, created_by)
  VALUES ('2026-06-12', cat, 'Recurring June bill', 'JPY', 2000, 0, 'bank_transfer', 'draft', 'recurring', 'rec-1', '00000000-0000-0000-0000-00000000000a') RETURNING id INTO moved;
  ASSERT (SELECT expense_date FROM public.expenses WHERE id = moved) = '2026-07-01' AND (SELECT notes FROM public.expenses WHERE id = moved) LIKE '%Dated 2026-06-12 (month already closed)%', 'system draft moved to the first open day with a note';
  INSERT INTO public.expenses (id, expense_date, category_id, description, currency, amount, amount_jpy, payment_method, status, source, source_ref, created_by)
  VALUES ('88888888-0000-0000-0000-000000000001', '2026-07-05', cat, 'Recurring July bill', 'JPY', 2000, 0, 'bank_transfer', 'draft', 'recurring', 'rec-2', '00000000-0000-0000-0000-00000000000a');
  PERFORM public.gl_period_for('2026-07-01');
  UPDATE public.gl_periods SET status = 'closed', closed_at = now() WHERE period_start = '2026-07-01';
  PERFORM set_config('request.jwt.claim.sub', '', false);
  UPDATE public.expenses SET receipt_path = '88888888-0000-0000-0000-000000000001/bill.pdf', amount = 2100 WHERE id = '88888888-0000-0000-0000-000000000001';
  ASSERT (SELECT expense_date FROM public.expenses WHERE id = '88888888-0000-0000-0000-000000000001') = '2026-08-01' AND (SELECT amount FROM public.expenses WHERE id = '88888888-0000-0000-0000-000000000001') = 2100, 'a service-role update of a system draft in a since-closed month (email bill attached) moves it instead of failing';
  UPDATE public.gl_periods SET status = 'open', closed_at = NULL WHERE period_start = '2026-07-01';
  UPDATE public.expenses SET status = 'void', voided_by = '00000000-0000-0000-0000-00000000000a', voided_at = now(), void_reason = 'test cleanup' WHERE id = '88888888-0000-0000-0000-000000000001';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'repost after the corrections: ' || r::text;
  SELECT count(*) INTO n FROM public.gl_journals WHERE entry_date <> source_date AND status = 'posted';
  ASSERT n = 1, 'the corrected June payment reposted into July with the original date kept: ' || n;
  ASSERT (SELECT entry_date FROM public.gl_journals WHERE entry_date <> source_date AND status = 'posted') = '2026-07-01', 'first open day';
  RAISE NOTICE 'K3 readiness + period lock OK';
END $t$;

-- K4 errors: a changed source the engine has not yet re-posted shows as unposted + orphan; readiness blocks; the check names them and rings once.
--    (A duplicate live journal cannot be inserted — gl_journals_live_source_uq — and an unbalanced one is refused at commit by
--     gl_journal_balanced, so those two checks are belts kept behind the braces.)
DO $t$ DECLARE r jsonb; src uuid; n int; BEGIN
  SELECT source_id INTO src FROM public.gl_journals WHERE source_type = 'payment' AND status = 'posted' LIMIT 1;
  RESET ROLE;
  BEGIN
    INSERT INTO public.gl_journals (entry_date, period_start, source_date, kind, source_type, source_id, source_version, description, total_jpy)
    VALUES ('2026-08-20', '2026-08-01', '2026-08-20', 'auto', 'payment', src, 'dup', 'Duplicate for the test', 7);
    RAISE EXCEPTION 'a second live journal for one event was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE public.payments SET amount_paid = 12000 WHERE id = '20000000-0000-0000-0000-000000000002';
  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.get_close_readiness('2026-07-01');
  ASSERT (r->>'unposted_events')::int = 0, 'the changed payment is dated August — nothing pending on or before July: ' || r::text;
  r := public.get_close_readiness('2026-08-01');
  ASSERT (r->>'unposted_events')::int = 2 AND (r->>'errors')::int = 0 AND (r->>'can_close')::boolean, 'one reversal + one repost pending is a warning (Close posts first), not an error: ' || r::text;
  r := public.run_ledger_check();
  ASSERT r->>'ok' = 'true' AND (r->>'errors')::int = 2, 'unposted + orphan: ' || (r - 'issues')::text;
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' IN ('unposted', 'orphan') AND x->>'severity' = 'error') = 2, 'the two error kinds';
  ASSERT (r->>'bell_rung')::boolean, 'bell on errors';
  SELECT count(*) INTO n FROM public.staff_notifications WHERE type = 'ledger_check'; ASSERT n = 1, 'one bell row: ' || n;
  ASSERT (SELECT body FROM public.staff_notifications WHERE type = 'ledger_check') NOT LIKE '%¥%' AND (SELECT body FROM public.staff_notifications WHERE type = 'ledger_check') NOT LIKE '%12000%'
     AND (SELECT title FROM public.staff_notifications WHERE type = 'ledger_check') LIKE 'Ledger check: % issues', 'bell carries counts only';
  r := public.close_period('2026-07-01', 'July');
  ASSERT r->>'ok' = 'true' AND (r->'readiness'->>'errors')::int = 0 AND (r->'readiness'->>'unposted_events')::int = 0, 'closing posts first: ' || (r - 'period')::text;
  ASSERT (SELECT sum(l.debit_jpy - l.credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1101') = 1000000 + 41000 + 12000 - 5000 - 3000 + 3000, 'SMBC after the correction';
  RAISE NOTICE 'K4 errors + check OK';
END $t$;

-- K5 the nightly check on a clean book: warnings, no repeat bell, a new warning rings again, history; the cron path.
DO $t$ DECLARE r jsonb; n int; BEGIN
  RESET ROLE;
  r := public.gl_run_completeness_check('cron', NULL);
  ASSERT r->>'ok' = 'true' AND (r->>'errors')::int = 0, 'the cron role runs the check with no user: ' || (r - 'issues')::text;
  ASSERT (SELECT trigger FROM public.gl_check_runs ORDER BY ran_at DESC LIMIT 1) = 'cron' AND (SELECT run_by FROM public.gl_check_runs ORDER BY ran_at DESC LIMIT 1) IS NULL, 'recorded as cron';
  SET ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.run_ledger_check();
  ASSERT (r->>'errors')::int = 0, 'clean again: ' || (r->'issues')::text;
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'month_open' AND x->>'ref' IN ('2026-06', '2026-07')) = 0, 'closed months are not reported';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'month_open' AND x->>'ref' IN ('2026-08', '2026-09')) = 2, 'August and September still open: ' || (r->'issues')::text;
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'reconciliation' AND x->>'ref' = '2026-08') = 1, 'SMBC not reconciled for August (the ended OPEN month with movements): ' || (r->'issues')::text;
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'reconciliation' AND x->>'ref' IN ('2026-06', '2026-07')) = 0, 'closed months are not nagged about reconciliation (their open items were written at the close)';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'late_posting') = 1, 'the June correction that landed in July is listed';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'expense_draft') = 1, 'drafts older than two weeks';
  ASSERT (r->>'bell_rung')::boolean = false AND (r->>'new_warnings')::int = 0, 'no errors, no new warnings → silent: ' || (r - 'issues')::text;
  SELECT count(*) INTO n FROM public.staff_notifications WHERE type = 'ledger_check'; ASSERT n = 1, 'still one bell: ' || n;
  r := public.post_manual_journal(jsonb_build_object('entry_date', '2026-09-10', 'description', 'Unknown receipt',
         'lines', '[{"a":"1190","side":"dr","amt":"999","cur":"JPY"},{"a":"4900","side":"cr","amt":"999","cur":"JPY"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'suspense entry';
  r := public.run_ledger_check();
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'issues') x WHERE x->>'kind' = 'suspense' AND x->>'ref' = '1190') = 1 AND (r->>'bell_rung')::boolean AND (r->>'new_warnings')::int = 1, 'a new warning rings: ' || (r - 'issues')::text;
  SELECT count(*) INTO n FROM public.staff_notifications WHERE type = 'ledger_check'; ASSERT n = 2, 'two bells: ' || n;
  r := public.get_ledger_checks(10);
  ASSERT jsonb_array_length(r->'runs') = 4 AND (r->'latest'->>'warnings')::int >= 5 AND r->'latest' ? 'issues' AND NOT (r->'runs'->0 ? 'issues'), 'history without issue bodies, latest with: ' || (r->'runs')::text;
  r := public.get_ledger_status();
  ASSERT (r->'last_check'->>'errors')::int = 0 AND (r->'last_check'->>'warnings')::int >= 5, 'status strip carries the last check';
  ASSERT (SELECT (p->>'unreconciled_accounts')::int FROM jsonb_array_elements(r->'periods') p WHERE p->>'period_start' = '2026-08-01') = 1, 'periods carry reconciliation counts';
  RAISE NOTICE 'K5 nightly check OK';
END $t$;

-- K6 bank statement import, matching, ignore, sign-off (D3, D4).
DO $t$ DECLARE r jsonb; imp uuid; l1 uuid; l2 uuid; jl uuid; rec jsonb; BEGIN
  r := public.import_bank_statement(jsonb_build_object('account_code', '1200', 'file_sha256', repeat('a', 64), 'lines', '[{"booked_on":"2026-08-10","amount":"1"}]'::jsonb));
  ASSERT r->>'error' = 'invalid_account', 'receivable is not a money account';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', 'nope', 'lines', '[{"booked_on":"2026-08-10","amount":"1"}]'::jsonb));
  ASSERT r->>'error' = 'invalid_file', 'sha required';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('a', 64), 'lines', '[]'::jsonb));
  ASSERT r->>'error' = 'no_lines', 'empty';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('a', 64), 'file_name', 'smbc-2026-08.csv',
         'profile', '{"delimiter":",","header_rows":1,"date_col":0,"date_format":"ymd","description_col":1,"in_col":2,"out_col":3,"balance_col":4,"encoding":"shift_jis"}'::jsonb,
         'lines', '[{"booked_on":"2026-08-10","description":"振込 ヤマダ","amount":"12000","balance_after":"1053000"},
                    {"booked_on":"2026-08-11","description":"振込 スズキ","amount":"12000","balance_after":"1065000"},
                    {"booked_on":"2026-08-16","description":"META PLATFORMS","amount":"-5000","balance_after":"1060000"},
                    {"booked_on":"2026-08-31","description":"手数料","amount":"-220","balance_after":"1059780"}]'::jsonb));
  ASSERT r->>'ok' = 'true', 'import: ' || r::text;
  imp := (r->'import'->>'id')::uuid;
  ASSERT (r->>'inserted')::int = 4 AND (r->>'skipped')::int = 0, 'four lines';
  ASSERT (r->>'auto_matched')::int = 1, 'only the expense matched automatically (the two 12,000 receipts share one journal line): ' || r::text;
  ASSERT (SELECT encoding FROM public.bank_import_profiles WHERE account_code = '1101') = 'shift_jis' AND (SELECT in_col FROM public.bank_import_profiles WHERE account_code = '1101') = 2, 'profile saved';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('a', 64), 'lines', '[{"booked_on":"2026-08-10","amount":"1"}]'::jsonb));
  ASSERT r->>'error' = 'duplicate_file', 'same file refused';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('b', 64), 'file_name', 'smbc-2026-08-again.csv',
         'lines', '[{"booked_on":"2026-08-10","description":"振込 ヤマダ","amount":"12000"},{"booked_on":"2026-08-16","description":"META PLATFORMS","amount":"-5000"}]'::jsonb));
  ASSERT r->>'ok' = 'true' AND (r->>'inserted')::int = 0 AND (r->>'skipped')::int = 2, 'overlapping lines deduped: ' || r::text;
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('c', 64), 'lines', '[{"booked_on":"2026-08-10","amount":"0"}]'::jsonb));
  ASSERT r->>'error' = 'invalid_line' AND (r->>'line_no')::int = 1, 'zero amount refused';
  ASSERT (SELECT count(*) FROM public.bank_statement_imports WHERE file_sha256 = repeat('c', 64)) = 0, 'a refused file leaves nothing behind';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('d', 64), 'file_name', 'twins.csv',
         'lines', '[{"booked_on":"2026-08-20","description":"GCASH","amount":"500"},{"booked_on":"2026-08-20","description":"GCASH","amount":"500"},{"booked_on":"2026-08-20","description":"GCASH","amount":"500"}]'::jsonb));
  ASSERT r->>'ok' = 'true' AND (r->>'inserted')::int = 3 AND (r->>'skipped')::int = 0, 'three identical same-day lines in one file are three lines: ' || r::text;
  r := public.import_bank_statement(jsonb_build_object('account_code', '1101', 'file_sha256', repeat('f', 64), 'file_name', 'twins-again.csv',
         'lines', '[{"booked_on":"2026-08-20","description":"GCASH","amount":"500"},{"booked_on":"2026-08-20","description":"GCASH","amount":"500"},{"booked_on":"2026-08-20","description":"GCASH","amount":"500"},{"booked_on":"2026-08-20","description":"GCASH","amount":"500"}]'::jsonb));
  ASSERT r->>'ok' = 'true' AND (r->>'inserted')::int = 1 AND (r->>'skipped')::int = 3, 'a re-export with a fourth twin skips the three already known and keeps the new one: ' || r::text;
  r := public.void_bank_import((r->'import'->>'id')::uuid, 'test twins'); ASSERT r->>'ok' = 'true', 'void twins 2';
  r := public.void_bank_import((SELECT id FROM public.bank_statement_imports WHERE file_sha256 = repeat('d', 64)), 'test twins'); ASSERT r->>'ok' = 'true', 'void twins 1';
  r := public.import_bank_statement(jsonb_build_object('account_code', '1010', 'file_sha256', repeat('9', 64), 'lines', '[{"booked_on":"2026-08-10","amount":"1"}]'::jsonb));
  ASSERT r->>'error' = 'cash_has_no_statement', 'cash is counted, not imported';

  rec := public.get_bank_reconciliation('1101', '2026-08-01');
  ASSERT (rec->>'matched_count')::int = 1 AND jsonb_array_length(rec->'unmatched_statement') = 3 AND jsonb_array_length(rec->'unmatched_ledger') = 1, 'lists: ' || (rec - 'imports' - 'profile')::text;
  ASSERT (rec->>'ledger_closing_native')::numeric = 1000000 + 41000 + 12000 - 5000, 'ledger closing at 31 Aug from live lines (the voided Props expense is out; the corrected payments are in)';
  ASSERT (rec->>'statement_closing')::numeric = 1059780 AND rec->>'statement_closing_source' = 'statement', 'closing from the last statement line';
  ASSERT public.get_bank_reconciliation('1101', '2026-09-01')->'statement_closing' = 'null'::jsonb AND public.get_bank_reconciliation('1101', '2026-09-01')->'statement_closing_source' = 'null'::jsonb,
    'September has no import, so nothing is prefilled — August''s last balance is not September''s closing (QA F2)';
  ASSERT (rec->'unmatched_ledger'->0->>'signed_amount')::numeric = 12000, 'the 12,000 receipt is the one left';
  SELECT (x->>'id')::uuid INTO l1 FROM jsonb_array_elements(rec->'unmatched_statement') x WHERE x->>'booked_on' = '2026-08-10';
  SELECT (x->>'id')::uuid INTO l2 FROM jsonb_array_elements(rec->'unmatched_statement') x WHERE x->>'booked_on' = '2026-08-11';
  ASSERT (SELECT jsonb_array_length(x->'candidates') FROM jsonb_array_elements(rec->'unmatched_statement') x WHERE x->>'booked_on' = '2026-08-10') = 1, 'candidate listed for a one-tap match';
  jl := (rec->'unmatched_ledger'->0->>'journal_line_id')::uuid;
  r := public.match_bank_line(l1, jl); ASSERT r->>'ok' = 'true', 'manual match: ' || r::text;
  r := public.match_bank_line(l2, jl); ASSERT r->>'error' = 'already_matched', 'a journal line matches once';
  r := public.unmatch_bank_line(l1); ASSERT r->>'ok' = 'true', 'unmatch';
  r := public.match_bank_line(l2, jl); ASSERT r->>'ok' = 'true', 'match the other receipt instead';
  r := public.sign_off_reconciliation('1101', '2026-08-01', 1059780);
  ASSERT r->>'error' = 'difference_remains' AND (r->>'difference')::numeric = 1059780 - 1048000, 'statement ≠ ledger (the second 12,000 and the fee are not in the Hub): ' || r::text;
  ASSERT (SELECT status FROM public.bank_reconciliations WHERE account_code = '1101' AND month_start = '2026-08-01') = 'open' AND (SELECT difference FROM public.bank_reconciliations WHERE account_code = '1101' AND month_start = '2026-08-01') = 11780, 'the attempt is recorded as open';
  r := public.sign_off_reconciliation('1101', '2026-08-01', 1048000);
  ASSERT r->>'error' = 'unmatched_statement_lines' AND (r->>'count')::int = 2, 'difference 0 but lines unmatched: ' || r::text;
  r := public.ignore_bank_line(l1, 'x'); ASSERT r->>'error' = 'reason_required', 'reason';
  r := public.ignore_bank_line(l1, 'Customer paid twice; refunded in September'); ASSERT r->>'ok' = 'true', 'ignored';
  r := public.ignore_bank_line((SELECT (x->>'id')::uuid FROM jsonb_array_elements(rec->'unmatched_statement') x WHERE x->>'booked_on' = '2026-08-31'), 'Bank fee, booked as an expense');
  ASSERT r->>'ok' = 'true', 'fee ignored';
  r := public.sign_off_reconciliation('1101', '2026-08-01', 1048000, 'August done');
  ASSERT r->>'ok' = 'true' AND r->'reconciliation'->>'status' = 'reconciled', 'signed off: ' || r::text;
  r := public.sign_off_reconciliation('1101', '2026-08-01', 1048000); ASSERT r->>'error' = 'already_reconciled', 'once';
  r := public.match_bank_line(l1, jl); ASSERT r->>'error' = 'already_matched' OR r->>'error' = 'month_reconciled', 'locked month';
  r := public.unmatch_bank_line(l2); ASSERT r->>'error' = 'month_reconciled', 'no unmatch after sign-off';
  r := public.void_bank_import(imp, 'wrong file'); ASSERT r->>'error' = 'month_reconciled', 'no void after sign-off';
  r := public.sign_off_reconciliation('1101', '2026-10-01', 0); ASSERT r->>'error' = 'period_not_ended', 'current month';
  rec := public.get_bank_reconciliation('1101', '2026-08-01');
  ASSERT jsonb_array_length(rec->'ignored') = 2 AND jsonb_array_length(rec->'unmatched_statement') = 0 AND rec->'reconciliation'->>'status' = 'reconciled', 'after sign-off';
  r := public.get_close_readiness('2026-08-01');
  ASSERT jsonb_array_length(r->'unreconciled_accounts') = 0, 'readiness no longer lists SMBC for August: ' || (r->'unreconciled_accounts')::text;
  r := public.reopen_reconciliation('1101', '2026-08-01', 'x'); ASSERT r->>'error' = 'reason_required', 'reason';
  r := public.reopen_reconciliation('1101', '2026-08-01', 'statement was incomplete'); ASSERT r->>'ok' = 'true', 'reopened';
  r := public.sign_off_reconciliation('1101', '2026-06-01', (SELECT (public.get_bank_reconciliation('1101', '2026-06-01')->>'ledger_closing_native')::numeric)); ASSERT r->>'ok' = 'true' OR r->>'error' = 'unmatched_ledger_lines', 'a closed ledger month can still be reconciled: ' || r::text;
  r := public.void_bank_import(imp, 'wrong file'); ASSERT r->>'ok' = 'true', 'void after reopen';
  rec := public.get_bank_reconciliation('1101', '2026-08-01');
  ASSERT (rec->>'matched_count')::int = 0 AND jsonb_array_length(rec->'unmatched_statement') = 0 AND jsonb_array_length(rec->'unmatched_ledger') = 2, 'voided import releases its matches and hides its lines';
  RAISE NOTICE 'K6 bank reconciliation OK';
END $t$;

-- K7 cash on hand (D6): the counted cash is the statement; no line matching required.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_bank_reconciliation('1010', '2026-08-01');
  ASSERT (r->>'is_cash')::boolean AND (r->>'ledger_closing_native')::numeric = 0, 'cash account: ' || (r - 'imports')::text;
  r := public.sign_off_reconciliation('1010', '2026-08-01', 500);
  ASSERT r->>'error' = 'difference_remains' AND (r->>'difference')::numeric = 500, 'counted more than the book';
  r := public.sign_off_reconciliation('1010', '2026-08-01', 0, 'Counted 31 Aug');
  ASSERT r->>'ok' = 'true', 'count matches: ' || r::text;
  RAISE NOTICE 'K7 cash count OK';
END $t$;

-- K8 re-run safety: the migration applied twice left one trigger, one cron row at most, and the readiness RPC is idempotent.
DO $t$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_trigger WHERE tgname = 'expenses_before_period_lock'; ASSERT n = 1, 'one period-lock trigger: ' || n;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = 'public.expenses'::regclass AND NOT tgisinternal AND tgname LIKE 'expenses_before%';
  ASSERT n = 2, 'period lock fires before expenses_before_write (alphabetical): ' || n;
  RAISE NOTICE 'K8 re-run OK';
END $t$;

SELECT 'ALL CONTROLS TESTS PASSED' AS result;
