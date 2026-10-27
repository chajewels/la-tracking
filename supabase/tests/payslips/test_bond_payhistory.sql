-- Phase 2: migration 20270204100000 (cash advances, employee ID, hire date, cash bond, pay settings history,
-- April-May 2026) on top of 20270201 + 20270202 and the seed (payslips issued the old way).
\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'
\set C '00000000-0000-0000-0000-00000000000c'
\set L '00000000-0000-0000-0000-0000000000a1'
\set F '00000000-0000-0000-0000-00000000000f'

-- More people (superuser setup): Cris (inactive CSR with April entries), Nina, Mae and Ola (new CSRs with hire dates).
INSERT INTO public.profiles (user_id, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Maria Cris de Guzman'),
  ('00000000-0000-0000-0000-0000000000d1', 'Nina Ramos'),
  ('00000000-0000-0000-0000-0000000000d2', 'Mae Lopez'),
  ('00000000-0000-0000-0000-0000000000d3', 'Ola Santos');
INSERT INTO public.timesheet_profiles (user_id, template_type, job_title, basic_salary, allowance, active) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'csr', 'CSR', 12000, 2000, false),
  ('00000000-0000-0000-0000-0000000000d1', 'csr', 'CSR', 10000, 2000, true),
  ('00000000-0000-0000-0000-0000000000d2', 'csr', 'CSR', 10000, 2000, true),
  ('00000000-0000-0000-0000-0000000000d3', 'csr', 'CSR', 10000, 2000, true);
INSERT INTO public.timesheet_entries (user_id, work_date, am_in, pm_out) VALUES
  ('00000000-0000-0000-0000-0000000000c1', DATE '2026-04-01', '2026-04-01 11:00+08', '2026-04-01 17:00+08');

-- pl(basic, allowance, capped, allowance_paid, commission_total): a consistent CSR payload (cap not reached).
CREATE FUNCTION pg_temp.pl(b numeric, a numeric, capped numeric, ap numeric, cm numeric DEFAULT 0) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'timesheet', jsonb_build_object('days_worked', 20, 'total_hours', 160, 'daily_pay_sum', capped, 'basic_salary', b,
                                    'capped_gross', capped, 'monthly_allowance', a, 'forfeited_weeks', 0,
                                    'allowance_paid', ap, 'net', capped + ap),
    'commission', jsonb_build_object('role_won', CASE WHEN cm > 0 THEN 'Closer' END, 'earnings', cm, 'top_sales_tier', 0,
                                     'top_sales_bonus', 0, 'total', cm),
    'timesheet_net_php', capped + ap, 'commission_php', cm, 'total_php', capped + ap + cm) $$;
CREATE FUNCTION pg_temp.la(d500 int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('timesheet', jsonb_build_object('days_at_500', d500, 'days_at_300', 0, 'total_hours', d500 * 8, 'net', 500 * d500),
    'commission', jsonb_build_object('role_won', NULL, 'earnings', 0, 'top_sales_tier', 0, 'top_sales_bonus', 0, 'total', 0),
    'timesheet_net_php', 500 * d500, 'commission_php', 0, 'total_php', 500 * d500) $$;
GRANT EXECUTE ON FUNCTION pg_temp.pl(numeric, numeric, numeric, numeric, numeric), pg_temp.la(int) TO authenticated;
CREATE TEMP TABLE ctx (k text PRIMARY KEY, v text);
GRANT SELECT, INSERT, UPDATE ON ctx TO authenticated;
INSERT INTO ctx VALUES ('this_month', to_char(date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date), 'YYYY-MM-DD')),
                       ('today', ((now() AT TIME ZONE 'Asia/Tokyo')::date)::text);

-- Q1 shape, existing rows unchanged, generated columns.
DO $t$ DECLARE i int; BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM public.seed_snapshot s JOIN public.payslips p ON p.id = s.id
     WHERE (to_jsonb(p) - ARRAY['employee_id','hire_date','cash_advances','cash_advance_php','is_final_pay','cash_bond_held_php',
                                'cash_bond_released_php','cash_bond_source_payslip_id','net_pay_php','amount_due_php']) <> s.row),
    'existing rows: every old column unchanged';
  ASSERT (SELECT bool_and(net_pay_php = total_php AND amount_due_php = total_php AND cash_advances = '[]'::jsonb
                          AND cash_advance_php = 0 AND cash_bond_held_php = 0 AND cash_bond_released_php = 0
                          AND NOT is_final_pay AND employee_id IS NULL AND hire_date IS NULL
                          AND cash_bond_source_payslip_id IS NULL) FROM public.payslips), 'existing rows read the defaults';
  ASSERT (SELECT n FROM public.seed_audit) = (SELECT count(*) FROM public.audit_logs), 'the migration wrote no audit rows (no row trigger, no update)';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'finalize_payslip') = 2, '3- and 4-argument finalize';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'save_staff_payroll_details') = 2, '3- and 5-argument save';
  ASSERT (SELECT attgenerated FROM pg_attribute WHERE attrelid = 'public.payslips'::regclass AND attname = 'amount_due_php') = 's', 'generated';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('payslip_cash_advances', 'timesheet_pay_settings') AND cmd <> 'SELECT') = 0, 'no write policies';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'Payslip managers can upload cash advance proofs') = 1, 'storage policy';
  FOREACH i IN ARRAY ARRAY[1] LOOP
    ASSERT NOT has_table_privilege('authenticated', 'public.payslip_cash_advances', 'INSERT'), 'no insert';
    ASSERT NOT has_table_privilege('authenticated', 'public.payslip_cash_advances', 'UPDATE'), 'no update';
    ASSERT NOT has_table_privilege('authenticated', 'public.payslip_cash_advances', 'DELETE'), 'no delete';
    ASSERT NOT has_table_privilege('authenticated', 'public.timesheet_pay_settings', 'INSERT'), 'no insert (settings)';
    ASSERT NOT has_table_privilege('anon', 'public.timesheet_pay_settings', 'SELECT'), 'anon cannot read settings';
    ASSERT NOT has_table_privilege('anon', 'public.payslip_cash_advances', 'SELECT'), 'anon cannot read advances';
  END LOOP;
  RAISE NOTICE 'Q1 shape + existing rows unchanged OK';
END $t$;

-- Q1b the freeze trigger with generated columns: a payment and a void on pre-existing rows still work;
-- edits to the new columns are refused.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; k uuid; j uuid; path text; BEGIN
  SELECT id INTO k FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-00000000000c';
  SELECT id INTO j FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
  path := k::text || '/remit.jpg';
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', path);
  r := public.record_payslip_payment(k, 39287, 16500.5, DATE '2026-10-05', path);
  ASSERT r->>'ok' = 'true' AND (r->'payslip'->>'amount_due_php')::numeric = 16500.5, 'payment on a pre-existing payslip: ' || r::text;
  r := public.void_payslip(j, 'Re-issue with employee ID');
  ASSERT r->>'ok' = 'true', 'void a pre-existing payslip: ' || r::text;
  RAISE NOTICE 'Q1b payment + void through the patched freeze trigger OK';
END $t$;
RESET ROLE;
DO $t$ DECLARE k uuid; BEGIN
  SELECT id INTO k FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-00000000000c';
  BEGIN UPDATE public.payslips SET cash_advance_php = 1 WHERE id = k; RAISE EXCEPTION 'advance edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET status = 'void', voided_by = gen_random_uuid(), voided_at = now(), void_reason = 'abc',
               cash_bond_held_php = 1 WHERE id = k; RAISE EXCEPTION 'void + bond edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET employee_id = 'X' WHERE id = k; RAISE EXCEPTION 'snapshot edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'Q1c new payslip columns frozen OK';
END $t$;

-- Q2 pay settings history.
SET ROLE authenticated;
DO $t$ DECLARE r jsonb; u text; BEGIN
  FOREACH u IN ARRAY ARRAY['00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-00000000000c'] LOOP
    PERFORM set_config('request.jwt.claim.sub', u, false);
    r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', NULL, 4000, NULL);
    ASSERT r->>'error' = 'permission_denied', 'admin only, ' || u || ': ' || r::text;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-03-01', NULL, 4000, NULL);
  ASSERT r->>'error' = 'invalid_month', 'March: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-15', NULL, 4000, NULL);
  ASSERT r->>'error' = 'invalid_month', 'not first: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b',
         (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date) + interval '13 months')::date, NULL, 4000, NULL);
  ASSERT r->>'error' = 'invalid_month', 'too far ahead: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-0000000000a1', DATE '2026-04-01', NULL, 4000, NULL);
  ASSERT r->>'error' = 'not_csr', 'live admin: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', NULL, NULL, NULL);
  ASSERT r->>'error' = 'invalid_amount', 'both null: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', -1, 4000, NULL);
  ASSERT r->>'error' = 'invalid_amount', 'negative: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', NULL, 4000.555, NULL);
  ASSERT r->>'error' = 'invalid_amount', '3 decimals: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000c', DATE '2026-08-01', NULL, 6000, NULL);
  ASSERT r->>'error' = 'payslips_issued' AND r->>'month' = '2026-09-01', 'Kaila has a September payslip: ' || r::text;

  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', NULL, 4000, '  April-May allowance ');
  ASSERT r->>'ok' = 'true' AND (r->>'profile_synced')::boolean, 'April, latest in force: ' || r::text;
  ASSERT r->'setting'->>'note' = 'April-May allowance', 'note trimmed';
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-06-01', 15000, 6000, NULL);
  ASSERT r->>'ok' = 'true' AND (r->>'profile_synced')::boolean, 'June: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', NULL, 4000, 'again');
  ASSERT r->>'ok' = 'true' AND NOT (r->>'profile_synced')::boolean, 'April again is not the latest: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b',
         (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date) + interval '2 months')::date, 16000, NULL, 'raise');
  ASSERT r->>'ok' = 'true' AND NOT (r->>'profile_synced')::boolean, 'a future month does not touch the profile: ' || r::text;
  ASSERT (SELECT count(*) FROM public.timesheet_pay_settings WHERE user_id = '00000000-0000-0000-0000-00000000000b') = 3, 'upsert on (user, month)';
  RAISE NOTICE 'Q2 pay settings RPC OK';
END $t$;
RESET ROLE;
DO $t$ BEGIN
  ASSERT (SELECT basic_salary = 15000 AND allowance = 6000 FROM public.timesheet_profiles WHERE user_id = '00000000-0000-0000-0000-00000000000b'),
    'profile synced to the setting in force this month';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'timesheet_pay_setting') = 4, 'one audit row per save';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_type = 'timesheet_pay_setting'
                      AND new_value_json::text ~ '(4000|6000|15000|16000|allowance|raise)'), 'audit has no amounts or notes';
  BEGIN DELETE FROM public.timesheet_pay_settings; RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN TRUNCATE public.timesheet_pay_settings; RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'Q2b profile sync, audit, never deleted OK';
END $t$;
SET ROLE authenticated;
DO $t$ BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
  ASSERT (SELECT count(*) FROM public.timesheet_pay_settings) = 3, 'finance reads all';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  ASSERT (SELECT count(*) FROM public.timesheet_pay_settings) = 3, 'can_view_all reads all (and her own)';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
  ASSERT (SELECT count(*) FROM public.timesheet_pay_settings) = 0, 'other staff read only their own (none)';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  BEGIN
    INSERT INTO public.timesheet_pay_settings (user_id, effective_from, allowance) VALUES (gen_random_uuid(), DATE '2026-05-01', 1);
    RAISE EXCEPTION 'direct insert should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'Q2c pay settings read audience OK';
END $t$;

-- Q3 employee ID + hire date (5-argument save); the 3-argument save still works and keeps them.
DO $t$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', 'x', DATE '1990-01-01', 'CJ-1', NULL);
  ASSERT r->>'error' = 'permission_denied', 'csr: ' || r::text;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14', 'CJ 001', NULL);
  ASSERT r->>'error' = 'invalid_employee_id', 'space: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14', repeat('A', 31), NULL);
  ASSERT r->>'error' = 'invalid_employee_id', '31 characters: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14', 'CJ-001', DATE '2019-12-31');
  ASSERT r->>'error' = 'invalid_hire_date', 'before 2020: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14', 'CJ-001',
         ((now() AT TIME ZONE 'Asia/Tokyo')::date + interval '1 year 1 day')::date);
  ASSERT r->>'error' = 'invalid_hire_date', 'over a year ahead: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14', '  CJ-001 ', NULL);
  ASSERT r->>'ok' = 'true' AND r->'changed' = '["employee_id"]'::jsonb, 'employee id only: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000b', 'Pasig City', DATE '1992-07-01', 'cj-001', NULL);
  ASSERT r->>'error' = 'employee_id_taken', 'case-insensitive unique: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000b', 'Pasig City', DATE '1992-07-01', 'CJ-002', DATE '2024-01-15');
  ASSERT r->>'ok' = 'true', 'Brenda: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', 'Quezon City', DATE '1995-03-14');
  ASSERT r->>'ok' = 'true' AND r->'changed' = '["address"]'::jsonb, 'old 3-argument save: ' || r::text;
  ASSERT (SELECT employee_id FROM public.staff_payroll_details WHERE user_id = '00000000-0000-0000-0000-00000000000c') = 'CJ-001',
    'the 3-argument save keeps the employee ID';
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', 'Quezon City', DATE '1995-03-14', '', NULL);
  ASSERT r->'changed' = '["employee_id"]'::jsonb, 'empty clears: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', 'Quezon City', DATE '1995-03-14', 'CJ-001', NULL);
  ASSERT r->>'ok' = 'true', 'set again';
  RAISE NOTICE 'Q3 employee ID + hire date OK';
END $t$;

-- Q4 finalize: April floor, inactive staff, pay_settings_mismatch, details_missing, old 3-argument call.
DO $t$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-03-01', pg_temp.pl(15000, 4000, 9000, 4000), false);
  ASSERT r->>'error' = 'invalid_month', 'March refused: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-05-01', pg_temp.pl(15000, 6000, 9000, 6000), false);
  ASSERT r->>'error' = 'pay_settings_mismatch', 'May allowance was 4000: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-05-01', pg_temp.pl(14000, 4000, 9000, 4000), false);
  ASSERT r->>'error' = 'pay_settings_mismatch', 'basic falls back to the profile (15000): ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-05-01', pg_temp.pl(15000, 4000, 9000, 4000), false);
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'employee_id' = 'CJ-002' AND r->'payslip'->>'hire_date' = '2024-01-15',
    'May with the settings in force; employee ID + hire date snapshotted: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-06-01', pg_temp.pl(15000, 4000, 9000, 4000), false);
  ASSERT r->>'error' = 'pay_settings_mismatch', 'June allowance is 6000: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-04-01', pg_temp.pl(15000, 4000, 9000, 4000), false);
  ASSERT r->>'ok' = 'true', 'April allowed: ' || r::text;
  r := public.set_timesheet_pay_setting('00000000-0000-0000-0000-00000000000b', DATE '2026-05-01', NULL, 4500, NULL);
  ASSERT r->>'error' = 'payslips_issued', 'May is issued now: ' || r::text;

  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', DATE '2026-08-01', pg_temp.la(10), false);
  ASSERT r->>'error' = 'details_missing', 'no employee ID: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000a1', 'Cebu City', DATE '1998-11-02', 'LA-7', NULL);
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', DATE '2026-08-01', pg_temp.la(10));
  ASSERT r->>'ok' = 'true' AND NOT (r->'payslip'->>'is_final_pay')::boolean, 'old 3-argument finalize still works: ' || r::text;

  r := public.get_payslip_book(DATE '2026-04-01');
  ASSERT r->'features' = '{"cash_advances": true, "employee_id": true, "cash_bond": true, "pay_history": true, "from_april": true}'::jsonb, 'features: ' || r::text;
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'details') d WHERE d->>'user_id' = '00000000-0000-0000-0000-0000000000c1'
                  AND (d->>'active')::boolean = false), 'inactive Cris listed in April (entries in the window)';
  ASSERT jsonb_array_length(r->'pay_settings') = 3, 'pay settings of the listed staff: ' || (r->'pay_settings')::text;
  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'details') d WHERE d->>'user_id' = '00000000-0000-0000-0000-0000000000c1'),
    'inactive Cris not listed in September';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'details') d WHERE d->>'user_id' = '00000000-0000-0000-0000-00000000000c'
                  AND d->>'employee_id' = 'CJ-001'), 'employee_id in details';

  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000c1', 'Taguig', DATE '1999-01-01', 'CJ-009', NULL);
  ASSERT r->>'ok' = 'true', 'inactive staff details';
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000c1', DATE '2026-04-01', pg_temp.pl(12000, 2000, 444.44, 0), false);
  ASSERT r->>'ok' = 'true', 'inactive profile can be finalized: ' || r::text;
  RAISE NOTICE 'Q4 finalize floor, inactive, pay settings, details OK';
END $t$;

-- Q5 cash advances: rules, proof, void, month lock, snapshot, advance_exceeds_pay.
DO $t$
DECLARE r jsonb; m date := (SELECT v::date FROM ctx WHERE k = 'this_month'); d date := (SELECT v::date FROM ctx WHERE k = 'today');
        a1 uuid; a2 uuid; a3 uuid; ps uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d, 100, 'x');
  ASSERT r->>'error' = 'permission_denied', 'csr: ' || r::text;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000f', m, d, 100, 'x');
  ASSERT r->>'error' = 'staff_not_found', r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', DATE '2026-03-01', d, 100, 'x');
  ASSERT r->>'error' = 'invalid_month', 'March: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', (m + interval '1 month')::date, d, 100, 'x');
  ASSERT r->>'error' = 'invalid_month', 'next month: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d + 1, 100, 'x');
  ASSERT r->>'error' = 'invalid_date', 'tomorrow: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, (m - interval '1 month' - interval '1 day')::date, 100, 'x');
  ASSERT r->>'error' = 'invalid_date', 'before last month: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, (m - interval '1 month')::date, 0, 'x');
  ASSERT r->>'error' = 'invalid_amount', 'zero: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d, 1.234, 'x');
  ASSERT r->>'error' = 'invalid_amount', '3 decimals: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d, 100, '   ');
  ASSERT r->>'error' = 'note_required', r::text;
  ASSERT NOT EXISTS (SELECT 1 FROM public.payslip_cash_advances), 'nothing written by a refusal';

  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, (m - interval '1 month')::date, 1000.50, '  Rent ');
  ASSERT r->>'ok' = 'true' AND r->'advance'->>'note' = 'Rent', 'first advance: ' || r::text;
  a1 := (r->'advance'->>'id')::uuid;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d, 500, 'Medicine');
  a2 := (r->'advance'->>'id')::uuid;
  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d, 700, 'Typo');
  a3 := (r->'advance'->>'id')::uuid;
  INSERT INTO ctx VALUES ('a1', a1::text), ('a2', a2::text), ('a3', a3::text);

  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/x.jpg');
  ASSERT r->>'error' = 'proof_missing', 'not uploaded: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a2::text || '/x.jpg');
  ASSERT r->>'error' = 'invalid_proof_path', 'another advance: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/../x.jpg');
  ASSERT r->>'error' = 'invalid_proof_path', 'dot-dot: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/');
  ASSERT r->>'error' = 'invalid_proof_path', 'no file: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/sub/x.jpg');
  ASSERT r->>'error' = 'invalid_proof_path', 'sub-folder: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || gen_random_uuid()::text || '/x.jpg');
    RAISE EXCEPTION 'upload for an unknown advance should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a1::text || '/a/b.jpg');
    RAISE EXCEPTION 'upload into a sub-folder should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a1::text || '/gcash.png');
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/gcash.png');
  ASSERT r->>'ok' = 'true' AND r->'advance'->>'proof_path' = 'advances/' || a1::text || '/gcash.png', 'attach: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/gcash.png');
  ASSERT r->>'error' = 'proof_already_attached', r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a1::text || '/again.png');
    RAISE EXCEPTION 'second upload for an advance with a proof should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  r := public.void_cash_advance(a3, 'no');
  ASSERT r->>'error' = 'reason_required', r::text;
  r := public.void_cash_advance(a3, 'Typed twice');
  ASSERT r->>'ok' = 'true' AND r->'advance'->>'status' = 'void', 'void: ' || r::text;
  r := public.void_cash_advance(a3, 'Typed twice');
  ASSERT r->>'error' = 'already_void', r::text;
  r := public.attach_cash_advance_proof(a3, 'advances/' || a3::text || '/x.jpg');
  ASSERT r->>'error' = 'advance_void', r::text;

  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', m, pg_temp.pl(12000, 2000, 10000, 2000, 1000), false);
  ASSERT r->>'ok' = 'true', 'finalize with advances: ' || r::text;
  ps := (r->'payslip'->>'id')::uuid;
  ASSERT (r->'payslip'->>'cash_advance_php')::numeric = 1500.50, 'sum of active advances: ' || r::text;
  ASSERT jsonb_array_length(r->'payslip'->'cash_advances') = 2, 'void advance excluded';
  ASSERT r->'payslip'->'cash_advances'->0->>'id' = a1::text AND r->'payslip'->'cash_advances'->0->>'note' = 'Rent'
     AND r->'payslip'->'cash_advances'->0->>'proof_path' LIKE 'advances/%', 'ordered by date, with note + proof';
  ASSERT (r->'payslip'->>'net_pay_php')::numeric = 13000 - 1500.50 AND (r->'payslip'->>'amount_due_php')::numeric = 11499.50, 'net + due';
  ASSERT (SELECT count(*) FROM public.payslip_cash_advances WHERE payslip_id = ps) = 2, 'payslip_id set on the active ones';
  ASSERT (SELECT payslip_id FROM public.payslip_cash_advances WHERE id = a3) IS NULL, 'not on the void one';

  r := public.add_cash_advance('00000000-0000-0000-0000-00000000000c', m, d, 100, 'Late');
  ASSERT r->>'error' = 'month_finalized', 'locked: ' || r::text;
  r := public.void_cash_advance(a2, 'Changed my mind');
  ASSERT r->>'error' = 'month_finalized', 'void locked: ' || r::text;
  r := public.attach_cash_advance_proof(a2, 'advances/' || a2::text || '/x.jpg');
  ASSERT r->>'error' = 'month_finalized', 'attach locked: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a2::text || '/x.jpg');
    RAISE EXCEPTION 'upload for a finalized month should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  r := public.void_payslip(ps, 'Wrong advance');
  r := public.void_cash_advance(a2, 'Not taken after all');
  ASSERT r->>'ok' = 'true', 'after voiding the payslip, advances can change again: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', m, pg_temp.pl(12000, 2000, 10000, 2000, 1000), false);
  ASSERT r->>'ok' = 'true' AND (r->'payslip'->>'cash_advance_php')::numeric = 1000.50, 're-issue: ' || r::text;
  ASSERT (SELECT payslip_id FROM public.payslip_cash_advances WHERE id = a1) = (r->'payslip'->>'id')::uuid, 'relinked to the new payslip';

  r := public.add_cash_advance('00000000-0000-0000-0000-0000000000a1', m, d, 99999, 'Too much');
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', m, pg_temp.la(10), false);
  ASSERT r->>'error' = 'advance_exceeds_pay', r::text;
  ASSERT jsonb_array_length((public.get_payslip_book(m))->'cash_advances') = 4, 'book: every advance of the month, all statuses';
  RAISE NOTICE 'Q5 cash advances OK';
END $t$;
RESET ROLE;
DO $t$ DECLARE a1 uuid := (SELECT v::uuid FROM ctx WHERE k = 'a1'); BEGIN
  BEGIN UPDATE public.payslip_cash_advances SET amount_php = 1 WHERE id = a1; RAISE EXCEPTION 'amount edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslip_cash_advances SET proof_path = 'advances/' || id::text || '/other.png' WHERE id = a1; RAISE EXCEPTION 'proof change should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslip_cash_advances SET status = 'void', void_reason = 'abc', voided_by = gen_random_uuid(), voided_at = now(), note = 'changed' WHERE id = a1;
    RAISE EXCEPTION 'void + note edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslip_cash_advances SET status = 'active', void_reason = NULL, voided_by = NULL, voided_at = NULL WHERE status = 'void';
    RAISE EXCEPTION 'un-void should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM public.payslip_cash_advances WHERE id = a1; RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN TRUNCATE public.payslip_cash_advances; RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'Q5b advance row locks OK';
END $t$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ BEGIN
  BEGIN
    INSERT INTO public.payslip_cash_advances (user_id, pay_month, advance_date, amount_php, note, created_by)
    VALUES (gen_random_uuid(), DATE '2026-09-01', DATE '2026-09-01', 1, 'x', gen_random_uuid());
    RAISE EXCEPTION 'direct insert should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
  ASSERT (SELECT count(*) FROM public.payslip_cash_advances) = 0, 'finance reads no advances (payslip gate only)';
  RAISE NOTICE 'Q5c advance direct writes + read gate OK';
END $t$;

-- Q6 cash bond.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$
DECLARE r jsonb; d date := (SELECT v::date FROM ctx WHERE k = 'today'); aug uuid; sep uuid; sep2 uuid; b jsonb;
BEGIN
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000d1', 'Makati', DATE '2000-02-02', 'CJ-101', DATE '2026-08-10');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d1', DATE '2026-09-01', pg_temp.pl(10000, 2000, 8000, 2000), false);
  ASSERT r->>'error' = 'cash_bond_order' AND r->>'first_month' = '2026-08-01', 'second month before the first: ' || r::text;
  r := public.add_cash_advance('00000000-0000-0000-0000-0000000000d1', DATE '2026-08-01', d, 1000, 'Transport');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d1', DATE '2026-08-01', pg_temp.pl(10000, 2000, 8000.03, 2000), false);
  ASSERT r->>'ok' = 'true', 'first month: ' || r::text;
  aug := (r->'payslip'->>'id')::uuid;
  ASSERT (r->'payslip'->>'net_pay_php')::numeric = 9000.03, 'net after advances';
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 4500.01, 'held = floor(net/2) to the centavo: ' || r::text;
  ASSERT (r->'payslip'->>'amount_due_php')::numeric = 4500.02, 'the odd centavo stays in the paid half';
  b := (SELECT d2 FROM jsonb_array_elements((public.get_payslip_book(DATE '2026-09-01'))->'details') d2
         WHERE d2->>'user_id' = '00000000-0000-0000-0000-0000000000d1');
  ASSERT b->'cash_bond_pending'->>'source_payslip_id' = aug::text AND (b->'cash_bond_pending'->>'amount')::numeric = 4500.01
     AND (b->>'first_month_issued')::boolean, 'pending in the book: ' || b::text;

  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d1', DATE '2026-09-01', pg_temp.pl(10000, 2000, 8000, 2000), false);
  sep := (r->'payslip'->>'id')::uuid;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 4500.01 AND r->'payslip'->>'cash_bond_source_payslip_id' = aug::text,
    'second month releases exactly the held amount: ' || r::text;
  ASSERT (r->'payslip'->>'amount_due_php')::numeric = 10000 + 4500.01, 'released is added';
  ASSERT (SELECT p2->>'cash_bond_source_month' FROM jsonb_array_elements((public.get_payslip_book(DATE '2026-09-01'))->'payslips') p2
           WHERE p2->>'id' = sep::text) = '2026-08-01', 'the book names the source month of a release';
  b := (SELECT d2 FROM jsonb_array_elements((public.get_payslip_book(DATE '2026-09-01'))->'details') d2
         WHERE d2->>'user_id' = '00000000-0000-0000-0000-0000000000d1');
  ASSERT b->'cash_bond_pending' = 'null'::jsonb, 'nothing pending once released: ' || b::text;

  r := public.void_payslip(sep, 'Hours corrected');
  b := (SELECT d2 FROM jsonb_array_elements((public.get_payslip_book(DATE '2026-09-01'))->'details') d2
         WHERE d2->>'user_id' = '00000000-0000-0000-0000-0000000000d1');
  ASSERT b->'cash_bond_pending'->>'source_payslip_id' = aug::text, 'voiding the releasing payslip makes the bond pending again';
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d1', DATE '2026-09-01', pg_temp.pl(10000, 2000, 8100, 2000), false);
  sep2 := (r->'payslip'->>'id')::uuid;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 4500.01, 're-issue releases again: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d1', (SELECT v::date FROM ctx WHERE k = 'this_month'),
         pg_temp.pl(10000, 2000, 8000, 2000), true);
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 0 AND (r->'payslip'->>'is_final_pay')::boolean,
    'already released: a later final pay releases nothing: ' || r::text;

  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000d2', 'Pasay', DATE '2001-03-03', 'CJ-102', DATE '2026-09-05');
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d2', DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 4500, 'Mae first month held: ' || r::text;
  PERFORM public.void_payslip((r->'payslip'->>'id')::uuid, 'Wrong hours');
  b := (SELECT d2 FROM jsonb_array_elements((public.get_payslip_book(DATE '2026-09-01'))->'details') d2
         WHERE d2->>'user_id' = '00000000-0000-0000-0000-0000000000d2');
  ASSERT b->'cash_bond_pending' = 'null'::jsonb AND NOT (b->>'first_month_issued')::boolean, 'voided first month: nothing pending: ' || b::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d2', DATE '2026-10-01', pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT r->>'error' = 'cash_bond_order', 'first month void again: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d2', DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000, 2000), true);
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 0 AND (r->'payslip'->>'amount_due_php')::numeric = 9000,
    'first-and-final month holds nothing: ' || r::text;

  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000d3', 'Manila', DATE '2002-04-04', 'CJ-103', DATE '2026-08-20');
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d3', DATE '2026-08-01', pg_temp.pl(10000, 2000, 7000.01, 2000), false);
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 4500, 'Ola held floor(9000.01/2) = 4500.00: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d3', (SELECT v::date FROM ctx WHERE k = 'this_month'),
         pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 0, 'not month + 1 and not final pay: no release: ' || r::text;
  PERFORM public.void_payslip((r->'payslip'->>'id')::uuid, 'Leaving: final pay');
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000d3', (SELECT v::date FROM ctx WHERE k = 'this_month'),
         pg_temp.pl(10000, 2000, 7000, 2000), true);
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 4500 AND (r->'payslip'->>'is_final_pay')::boolean,
    'final pay releases early: ' || r::text;
  RAISE NOTICE 'Q6 cash bond OK (held, odd centavo, release, void + re-issue, first-and-final, order, final pay)';
END $t$;

-- Q7 timesheet corrections from 2026-04-01.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.correct_timesheet_day('00000000-0000-0000-0000-0000000000c1', DATE '2026-04-02',
         '2026-04-02 11:00+08', NULL, NULL, '2026-04-02 17:00+08', 'Loaded from the paper sheet');
  ASSERT r->>'ok' = 'true', 'April correction: ' || r::text;
  r := public.correct_timesheet_day('00000000-0000-0000-0000-0000000000c1', DATE '2026-03-31',
         '2026-03-31 11:00+08', NULL, NULL, '2026-03-31 17:00+08', 'Too early');
  ASSERT r->>'error' = 'invalid_date', 'March refused: ' || r::text;
  RAISE NOTICE 'Q7 corrections from April OK';
END $t$;
RESET ROLE;

-- Q8 audit: one row per write; no amounts, notes or personal values.
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'payslip_cash_advance' AND action = 'add_cash_advance') = 5, 'add rows';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'payslip_cash_advance' AND action = 'attach_cash_advance_proof') = 1, 'attach row';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'payslip_cash_advance' AND action = 'void_cash_advance') = 2, 'void rows';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs
                      WHERE entity_type IN ('payslip', 'payslip_cash_advance', 'staff_payroll_details', 'timesheet_pay_setting')
                        AND (coalesce(new_value_json::text, '') || coalesce(old_value_json::text, ''))
                            ~ '(1000\.5|99999|4500|Rent|Medicine|Transport|Typed|CJ-|LA-7|gcash|Makati|2026-08-10|amount)'),
    'no amounts, notes, IDs, file names or personal values in audit';
  ASSERT (SELECT new_value_json->>'cash_bond' FROM public.audit_logs a JOIN public.payslips p ON p.id = a.entity_id
           WHERE a.action = 'finalize_payslip' AND p.user_id = '00000000-0000-0000-0000-0000000000d1' AND p.pay_month = DATE '2026-08-01') = 'held',
    'finalize audit names the bond kind only';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE performed_by_user_id IS NULL), 'actor always recorded';
  RAISE NOTICE 'Q8 audit OK';
END $t$;

\echo 'ALL BOND + PAY HISTORY TESTS PASSED'
