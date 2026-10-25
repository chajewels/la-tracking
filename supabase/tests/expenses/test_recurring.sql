\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Phase 3: recurring bills + prepaid amortisation. Runs after stubs + Phase 1 + 2 + 2b + 3 migrations.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_recurring_bills(); ASSERT r->>'error' = 'permission_denied', 'finance cannot list bills';
  r := public.upsert_recurring_bill('{"name":"x"}'); ASSERT r->>'error' = 'permission_denied', 'finance cannot add bills';
  r := public.generate_recurring_now(); ASSERT r->>'error' = 'permission_denied', 'finance cannot generate';
  ASSERT (SELECT count(*) FROM public.expense_recurring_bills) = 0, 'RLS hides bills from finance';
  RAISE NOTICE 'R1 permissions OK';
END $t$;

-- Staff (manage_expenses by override) manages templates.
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; cat uuid; bill uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE name = 'Tax accountant and legal fees';
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Tax accountant', 'category_id', cat, 'description', 'Monthly accounting fee',
         'currency', 'JPY', 'amount', 33000, 'payment_method', 'bank_transfer', 'paid_from', '1101', 'frequency', 'monthly', 'due_day', 25, 'starts_on', '2026-06-10'));
  ASSERT r->>'ok' = 'true', 'create bill: ' || r::text;
  bill := (r->'bill'->>'id')::uuid;
  ASSERT r->'bill'->>'next_due_on' = '2026-06-25', 'first due = due day in the start month when not yet passed: ' || (r->'bill'->>'next_due_on');
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Late start', 'category_id', cat, 'description', 'x', 'currency', 'JPY', 'amount', 100,
         'frequency', 'monthly', 'due_day', 5, 'starts_on', '2026-06-10'));
  ASSERT r->'bill'->>'next_due_on' = '2026-07-05', 'due day already passed -> next month: ' || (r->'bill'->>'next_due_on');
  r := public.set_recurring_bill_active((r->'bill'->>'id')::uuid, false); ASSERT r->>'ok' = 'true', 'deactivate';

  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Bad', 'category_id', cat, 'description', 'x', 'currency', 'JPY', 'amount', 100.5, 'frequency', 'monthly', 'due_day', 5, 'starts_on', '2026-09-10'));
  ASSERT r->>'error' = 'invalid_amount', 'yen must be whole';
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Bad', 'category_id', cat, 'description', 'x', 'currency', 'JPY', 'amount', 100, 'frequency', 'weekly', 'due_day', 5, 'starts_on', '2026-09-10'));
  ASSERT r->>'error' = 'invalid_frequency', 'weekly refused';
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Bad', 'category_id', cat, 'description', 'x', 'currency', 'JPY', 'amount', 100, 'frequency', 'monthly', 'due_day', 31, 'starts_on', '2026-09-10'));
  ASSERT r->>'error' = 'invalid_due_day', 'due day 31 refused';
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Bad', 'category_id', cat, 'description', 'x', 'currency', 'JPY', 'amount', 100, 'frequency', 'monthly', 'due_day', 5, 'starts_on', '2026-09-10', 'paid_from', '1200'));
  ASSERT r->>'error' = 'invalid_account', 'receivable is not a paying account';
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Bad', 'category_id', (SELECT id FROM public.expense_categories WHERE system_key = 'payroll'), 'description', 'x', 'currency', 'JPY', 'amount', 100, 'frequency', 'monthly', 'due_day', 5, 'starts_on', '2026-09-10'));
  ASSERT r->>'error' = 'category_booked_automatically', 'payroll category refused';
  r := public.upsert_recurring_bill(jsonb_build_object('name', 'Bad', 'category_id', cat, 'description', 'x', 'currency', 'JPY', 'amount', 100, 'frequency', 'monthly', 'due_day', 5, 'starts_on', '2026-09-10', 'spread_months', 40));
  ASSERT r->>'error' = 'invalid_spread', 'spread over 36 refused';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'expense_recurring_bill') = 3, 'template writes audited';
  r := public.upsert_recurring_bill(jsonb_build_object('id', bill, 'name', 'Tax accountant', 'category_id', cat, 'description', 'Monthly accounting fee',
         'currency', 'JPY', 'amount', 33000, 'payment_method', 'bank_transfer', 'paid_from', '1101', 'frequency', 'monthly', 'due_day', 25, 'starts_on', '2026-06-10', 'ends_on', '2026-06-20'));
  ASSERT r->'bill'->>'active' = 'false', 'ends_on before the next due deactivates the bill: ' || r::text;
  r := public.upsert_recurring_bill(jsonb_build_object('id', bill, 'name', 'Tax accountant', 'category_id', cat, 'description', 'Monthly accounting fee',
         'currency', 'JPY', 'amount', 33000, 'payment_method', 'bank_transfer', 'paid_from', '1101', 'frequency', 'monthly', 'due_day', 25, 'starts_on', '2026-06-10'));
  ASSERT r->'bill'->>'active' = 'false', 'clearing ends_on does not silently reactivate';
  r := public.set_recurring_bill_active(bill, true); ASSERT r->>'ok' = 'true', 'reactivate by hand';
  RAISE NOTICE 'R2 templates OK';
END $t$;

-- Generation: latest due cycle only, idempotent, voided draft regenerates, ends_on.
RESET ROLE;
DO $t$ DECLARE r jsonb; bill uuid; d1 uuid; BEGIN
  SELECT id INTO bill FROM public.expense_recurring_bills WHERE name = 'Tax accountant';
  r := public.expenses_generate_recurring('2026-06-20', NULL);
  ASSERT (r->>'created')::int = 0, 'nothing due yet: ' || r::text;
  r := public.expenses_generate_recurring('2026-08-30', NULL);
  ASSERT (r->>'created')::int = 1, 'three cycles passed -> ONE draft (no backlog): ' || r::text;
  SELECT id INTO d1 FROM public.expenses WHERE source = 'recurring' AND source_ref = bill::text || ':2026-08-25';
  ASSERT d1 IS NOT NULL, 'draft dated at the latest due date (25 Aug)';
  ASSERT (SELECT count(*) FROM public.expenses WHERE source = 'recurring') = 1, 'one draft';
  ASSERT (SELECT status FROM public.expenses WHERE id = d1) = 'draft', 'is a draft';
  ASSERT (SELECT paid_from FROM public.expenses WHERE id = d1) = '1101', 'paid_from copied';
  ASSERT (SELECT details->>'bill_name' FROM public.expenses WHERE id = d1) = 'Tax accountant', 'details carry the bill';
  ASSERT (SELECT next_due_on FROM public.expense_recurring_bills WHERE id = bill) = '2026-09-25', 'schedule advanced past as-of';
  ASSERT (SELECT last_generated_on FROM public.expense_recurring_bills WHERE id = bill) = '2026-08-25', 'last generated recorded';
  r := public.expenses_generate_recurring('2026-08-30', NULL);
  ASSERT (r->>'created')::int = 0 AND (r->>'skipped')::int = 0, 'idempotent: ' || r::text;
  r := public.expenses_generate_recurring('2026-09-26', NULL);
  ASSERT (r->>'created')::int = 1, 'September cycle: ' || r::text;
  ASSERT (SELECT count(*) FROM public.expenses WHERE source = 'recurring') = 2, 'two drafts now';
  RAISE NOTICE 'R3 generation OK';
END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; bill uuid; cat uuid; BEGIN
  SELECT id, category_id INTO bill, cat FROM public.expense_recurring_bills WHERE name = 'Tax accountant';
  r := public.upsert_recurring_bill(jsonb_build_object('id', bill, 'name', 'Tax accountant', 'category_id', cat, 'description', 'Monthly accounting fee',
         'currency', 'JPY', 'amount', 33000, 'payment_method', 'bank_transfer', 'paid_from', '1101', 'frequency', 'monthly', 'due_day', 28, 'starts_on', '2026-06-10'));
  ASSERT r->'bill'->>'next_due_on' = '2026-10-28', 'schedule edit anchors after the last generated cycle (25 Sep), never before: ' || (r->'bill'->>'next_due_on');
  RESET ROLE;
  r := public.expenses_generate_recurring('2026-10-29', NULL);
  ASSERT (SELECT count(*) FROM public.expenses WHERE source_ref LIKE bill::text || ':2026-0%') = 2, 'no old cycle regenerated after the edit';
  SET ROLE authenticated;
  RAISE NOTICE 'R3b schedule edit OK';
END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; bill uuid; d uuid; BEGIN
  SELECT id INTO bill FROM public.expense_recurring_bills WHERE name = 'Tax accountant';
  SELECT id INTO d FROM public.expenses WHERE source_ref = bill::text || ':2026-09-25';
  r := public.void_expense(d, 'Bill did not arrive'); ASSERT r->>'ok' = 'true', 'void draft';
  r := public.generate_recurring_now(bill, '2026-09-25');
  ASSERT r->>'ok' = 'true', 'voided cycle can be regenerated by hand: ' || r::text;
  r := public.generate_recurring_now(bill, '2026-09-25');
  ASSERT r->>'error' = 'already_generated', 'but not twice';
  r := public.generate_recurring_now(bill, '2026-05-01');
  ASSERT r->>'error' = 'invalid_date', 'before the start refused';
  r := public.generate_recurring_now();
  ASSERT r->>'ok' = 'true', 'generate now (all) works for admin: ' || r::text;
  RAISE NOTICE 'R4 catch-up OK';
END $t$;

-- ends_on + quarterly / yearly math.
RESET ROLE;
DO $t$ DECLARE r jsonb; cat uuid; q uuid; y uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE name = 'Email sending and domains';
  INSERT INTO public.expense_recurring_bills (name, category_id, description, currency, amount, frequency, due_day, starts_on, ends_on, next_due_on)
  VALUES ('Quarterly thing', cat, 'q', 'JPY', 3000, 'quarterly', 1, '2026-01-01', '2026-06-30', public.recurring_first_due('2026-01-01', 1::smallint)) RETURNING id INTO q;
  INSERT INTO public.expense_recurring_bills (name, category_id, description, currency, amount, frequency, due_day, starts_on, spread_months, next_due_on)
  VALUES ('Domain yearly', cat, 'Domain renewal', 'JPY', 12000, 'yearly', 15, '2026-06-01', 12, public.recurring_first_due('2026-06-01', 15::smallint)) RETURNING id INTO y;
  ASSERT public.recurring_next_due('2026-01-01', 'quarterly') = '2026-04-01' AND public.recurring_next_due('2026-06-15', 'yearly') = '2027-06-15', 'interval math';
  r := public.expenses_generate_recurring('2026-10-20', NULL);
  ASSERT (SELECT count(*) FROM public.expenses WHERE source_ref LIKE q::text || ':%') = 0, 'quarterly bill whose last cycle (1 Apr) is long past: ended, no stale draft';
  ASSERT (SELECT active FROM public.expense_recurring_bills WHERE id = q) = false, 'bill ended';
  INSERT INTO public.expense_recurring_bills (name, category_id, description, currency, amount, frequency, due_day, starts_on, ends_on, next_due_on)
  VALUES ('Quarterly current', cat, 'q2', 'JPY', 3000, 'quarterly', 1, '2026-04-01', '2026-10-31', public.recurring_first_due('2026-04-01', 1::smallint));
  r := public.expenses_generate_recurring('2026-10-20', NULL);
  ASSERT (SELECT count(*) FROM public.expenses WHERE description = 'q2' AND expense_date = '2026-10-01') = 1, 'current cycle of an ending bill is drafted';
  ASSERT (SELECT active FROM public.expense_recurring_bills WHERE name = 'Quarterly current') = false, 'and the bill ends since the next cycle is past ends_on';
  ASSERT (SELECT prepaid_months FROM public.expenses WHERE source_ref = y::text || ':2026-06-15') = 12, 'yearly draft carries the 12-month spread';
  RAISE NOTICE 'R5 frequencies / ends_on OK';
END $t$;

-- Prepaid: approve the yearly draft; the ledger posts 1400 then releases 1/12 at each month end.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; y uuid; e uuid; j record; BEGIN
  r := public.set_ledger_start('2026-06-01'); ASSERT r->>'ok' = 'true', 'ledger start: ' || r::text;
  SELECT id INTO y FROM public.expense_recurring_bills WHERE name = 'Domain yearly';
  SELECT id INTO e FROM public.expenses WHERE source_ref = y::text || ':2026-06-15';
  r := public.set_expense_prepaid(e, 1); ASSERT r->>'error' = 'invalid_spread', 'spread must be 2..36';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
  r := public.set_expense_prepaid(e, 10); ASSERT r->>'error' = 'permission_denied', 'approve-only / finance cannot set the spread';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.set_expense_prepaid(e, 10); ASSERT r->>'ok' = 'true', 'change the spread on a draft: ' || r::text;
  r := public.set_expense_paid_from(e, '1102'); ASSERT r->>'ok' = 'true', 'paid from';
  r := public.approve_expense(e); ASSERT r->>'ok' = 'true', 'approve: ' || r::text;
  r := public.set_expense_prepaid(e, 12); ASSERT r->>'error' = 'not_draft', 'spread locked after approval';
  r := public.gl_post_now(); ASSERT r->>'ok' = 'true', 'post: ' || r::text;
  ASSERT (SELECT bool_and(l.debit = l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'expense_amortisation' AND l.debit > 0), 'JPY releases are whole yen in the native column too';
  SELECT * INTO j FROM public.gl_journals WHERE source_type = 'expense' AND source_id = e AND kind = 'auto' AND status = 'posted';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND debit > 0) = '1400', 'prepaid payment -> 1400';
  ASSERT (SELECT account_code FROM public.gl_journal_lines WHERE journal_id = j.id AND credit > 0) = '1102', 'paid from Rakuten';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'expense_amortisation' AND kind = 'auto' AND status = 'posted')
         = (SELECT count(*) FROM generate_series(0, 9) k WHERE (date '2026-06-01' + ((k + 1) || ' months')::interval - interval '1 day')::date <= (now() AT TIME ZONE 'Asia/Tokyo')::date),
         'one release per month end up to today';
  ASSERT (SELECT entry_date FROM public.gl_journals WHERE source_type = 'expense_amortisation' ORDER BY entry_date LIMIT 1) = '2026-06-30', 'first release at the June month end';
  ASSERT (SELECT sum(debit) FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'expense_amortisation' AND l.account_code = '6500') = 1200 * (SELECT count(*) FROM public.gl_journals WHERE source_type = 'expense_amortisation'), 'each release = 12000 / 10';
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'expense_amortisation') = 0, 'releases balanced';
  r := public.gl_post_now(); ASSERT (r->>'posted')::int = 0 AND (r->>'reversed')::int = 0, 'idempotent: ' || r::text;
  r := public.void_expense(e, 'Wrong bill'); ASSERT r->>'ok' = 'true', 'void approved prepaid';
  r := public.gl_post_now();
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type IN ('expense', 'expense_amortisation') AND source_id IS NOT NULL AND kind = 'auto' AND status = 'posted') = 0, 'void reverses the payment and every release';
  RAISE NOTICE 'R6 prepaid ledger OK';
END $t$;

-- PHP prepaid splits sum exactly in both currencies.
DO $t$ DECLARE r jsonb; e uuid; BEGIN
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-07-03', 'category_id', (SELECT id FROM public.expense_categories WHERE name = 'Rent, utilities, internet and phone'),
         'description', 'Office insurance (annual)', 'currency', 'PHP', 'amount', 10000.01, 'payment_method', 'bank_transfer'));
  e := (r->'expense'->>'id')::uuid;
  r := public.set_expense_prepaid(e, 3); ASSERT r->>'ok' = 'true', 'spread 3';
  r := public.set_expense_paid_from(e, '1111'); r := public.approve_expense(e); ASSERT r->>'ok' = 'true', 'approve PHP prepaid';
  RESET ROLE;
  UPDATE public.system_settings SET value = '"0.40"'::jsonb WHERE key = 'php_jpy_rate';
  SET ROLE authenticated;
  r := public.gl_post_now();
  ASSERT (SELECT l.debit_jpy FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'expense' AND g.source_id = e AND g.kind = 'auto' AND l.account_code = '1400') = (SELECT amount_jpy FROM public.expenses WHERE id = e), 'the 1400 debit uses the yen frozen at approval, not the rate at posting time';
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines l WHERE l.account_code = '1400' AND l.expense_id = e) = 0, '1400 clears exactly after the three releases even though the rate changed';
  RESET ROLE;
  UPDATE public.system_settings SET value = '"0.42"'::jsonb WHERE key = 'php_jpy_rate';
  SET ROLE authenticated;
  ASSERT (SELECT sum(l.debit) FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'expense_amortisation' AND g.status = 'posted' AND l.expense_id = e AND l.debit > 0) = 10000.01, 'native shares sum to the amount';
  ASSERT (SELECT sum(l.debit_jpy) FROM public.gl_journal_lines l JOIN public.gl_journals g ON g.id = l.journal_id WHERE g.source_type = 'expense_amortisation' AND g.status = 'posted' AND l.expense_id = e AND l.debit > 0)
         = (SELECT amount_jpy FROM public.expenses WHERE id = e), 'yen shares sum to the posted yen';
  ASSERT (SELECT count(*) FROM public.gl_journals WHERE source_type = 'expense_amortisation' AND status = 'posted' AND source_id IN (SELECT md5(e::text || ':' || m)::uuid FROM unnest(ARRAY['2026-07','2026-08','2026-09']) m)) = 3, 'three releases, Jul-Sep';
  ASSERT (SELECT sum(debit_jpy) - sum(credit_jpy) FROM public.gl_journal_lines) = 0, 'ledger balanced';
  r := public.upsert_expense(jsonb_build_object('expense_date', '2026-07-03', 'category_id', (SELECT id FROM public.expense_categories WHERE name = 'Photoroom'),
         'description', 'Tiny app', 'currency', 'PHP', 'amount', 5, 'payment_method', 'card'));
  r := public.set_expense_prepaid((r->'expense'->>'id')::uuid, 12);
  ASSERT r->>'error' = 'amount_too_small_to_spread', 'a spread that would produce zero-yen months is refused: ' || r::text;
  RAISE NOTICE 'R7 PHP prepaid split OK';
END $t$;
RESET ROLE;
DO $t$ BEGIN
  BEGIN DELETE FROM public.expense_recurring_bills; RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'R8 never deleted OK';
END $t$;
SELECT 'ALL RECURRING TESTS PASSED' AS result;
