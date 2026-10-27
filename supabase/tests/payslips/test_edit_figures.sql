-- Phase 5: migration 20270207100000 (Edit figures + cash bond on salary only) applied twice on top of the
-- Phase 4 database and the pre7_* snapshots taken just before it.
\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set C '00000000-0000-0000-0000-00000000000c'

CREATE FUNCTION pg_temp.pl(b numeric, a numeric, capped numeric, ap numeric, cm numeric DEFAULT 0) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'timesheet', jsonb_build_object('days_worked', 20, 'total_hours', 160, 'daily_pay_sum', capped, 'basic_salary', b,
                                    'capped_gross', capped, 'monthly_allowance', a, 'forfeited_weeks', 0,
                                    'allowance_paid', ap, 'net', capped + ap),
    'commission', jsonb_build_object('role_won', CASE WHEN cm > 0 THEN 'Closer' END, 'earnings', cm, 'top_sales_tier', 0,
                                     'top_sales_bonus', 0, 'total', cm),
    'timesheet_net_php', capped + ap, 'commission_php', cm, 'total_php', capped + ap + cm) $$;
GRANT EXECUTE ON FUNCTION pg_temp.pl(numeric, numeric, numeric, numeric, numeric) TO authenticated;
CREATE TEMP TABLE ctx (k text PRIMARY KEY, v text);
GRANT SELECT, INSERT, UPDATE ON ctx TO authenticated;
INSERT INTO ctx VALUES ('today', ((now() AT TIME ZONE 'Asia/Tokyo')::date)::text);

-- Three new CSRs (superuser setup): Mia (hired September 2026), Noa (no hire date), Ora (manual figures).
INSERT INTO public.profiles (user_id, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000f4', 'Mia Lopez'),
  ('00000000-0000-0000-0000-0000000000f5', 'Noa Garcia'),
  ('00000000-0000-0000-0000-0000000000f6', 'Ora Dela Cruz');
INSERT INTO public.timesheet_profiles (user_id, template_type, job_title, basic_salary, allowance, active) VALUES
  ('00000000-0000-0000-0000-0000000000f4', 'csr', 'CSR', 10000, 2000, true),
  ('00000000-0000-0000-0000-0000000000f5', 'csr', 'CSR', 10000, 2000, true),
  ('00000000-0000-0000-0000-0000000000f6', 'csr', 'CSR', 10000, 2000, true);

-- E1 shape; every existing row unchanged apart from the two new empty columns.
DO $t$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre7_payslips s JOIN public.payslips p ON p.id = s.id
                      WHERE (to_jsonb(p) - ARRAY['correction_reason', 'corrected_from_payslip_id']) <> s.row
                         OR p.correction_reason IS NOT NULL OR p.corrected_from_payslip_id IS NOT NULL),
    'payslips unchanged';
  ASSERT (SELECT count(*) FROM public.pre7_payslips) = (SELECT count(*) FROM public.payslips), 'no payslip added or removed';
  ASSERT (SELECT n FROM public.pre7_audit) = (SELECT count(*) FROM public.audit_logs), 'the migration wrote no audit rows';
  ASSERT NOT has_function_privilege('authenticated', 'public.payslip_issue(uuid,date,jsonb,boolean,text,uuid)', 'EXECUTE'),
    'clients cannot call payslip_issue';
  ASSERT has_function_privilege('authenticated', 'public.correct_payslip(uuid,jsonb,boolean,text)', 'EXECUTE'), 'correct grant';
  ASSERT has_function_privilege('authenticated', 'public.finalize_payslip(uuid,date,jsonb,boolean,text)', 'EXECUTE'), 'finalize 5 grant';
  ASSERT NOT has_function_privilege('anon', 'public.correct_payslip(uuid,jsonb,boolean,text)', 'EXECUTE'), 'anon cannot correct';
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_proof_path')
         NOT LIKE '%(id)::text%', 'proof CHECK by shape';
  ASSERT (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass
           AND conname IN ('payslips_proof_path', 'payslips_proof_path_2', 'payslips_correction_reason', 'payslips_corrected_needs_reason')) = 4,
    'constraints present once';
  RAISE NOTICE 'E1 shape + existing rows unchanged OK';
END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- E2 the cash bond is half of the timesheet net (commission and bonuses excluded); released next month.
DO $t$ DECLARE r jsonb; mia uuid := '00000000-0000-0000-0000-0000000000f4'; BEGIN
  r := public.save_staff_payroll_details(mia, 'Quezon City', DATE '2000-02-02', 'CJ-301', DATE '2026-09-10');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.add_payslip_bonus(mia, DATE '2026-09-01', DATE '2026-09-20', 'performance', 1000, 'KPI');
  ASSERT r->>'ok' = 'true', r::text;
  -- timesheet 9,000.55 + commission 3,000 + bonus 1,000; half the timesheet = 4,500.27 (odd centavo stays paid).
  r := public.finalize_payslip(mia, DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000.55, 2000, 3000), false);
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 4500.27, r::text;
  ASSERT (r->'payslip'->>'total_php')::numeric = 13000.55, r::text;
  ASSERT (r->'payslip'->>'amount_due_php')::numeric = 13000.55 - 4500.27, r::text;
  ASSERT r->'payslip'->>'correction_reason' IS NULL, 'no reason on a normal finalize';
  r := public.finalize_payslip(mia, DATE '2026-10-01', pg_temp.pl(10000, 2000, 8000, 2000), false);
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 4500.27, r::text;
  RAISE NOTICE 'E2 bond = half of timesheet pay OK';
END $t$;

-- E3 5-argument finalize: reason, manual basic/allowance, typed bond and its refusals.
DO $t$ DECLARE r jsonb; ora uuid := '00000000-0000-0000-0000-0000000000f6'; p jsonb; BEGIN
  r := public.save_staff_payroll_details(ora, 'Cavite', DATE '1998-03-03', 'CJ-303', NULL);
  ASSERT r->>'ok' = 'true', r::text;
  -- 4-argument: the typed basic is refused, and so is a typed bond.
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(12000, 2000, 9000, 2000), false);
  ASSERT r->>'error' = 'pay_settings_mismatch', r::text;
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(10000, 2000, 9000, 2000) || '{"cash_bond_held_php": 100}', false);
  ASSERT r->>'error' = 'invalid_figures' AND r->>'field' = 'cash_bond_held_php', r::text;
  -- 5-argument: reason required (3..500).
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(12000, 2000, 9000, 2000), false, ' x ');
  ASSERT r->>'error' = 'reason_required', r::text;
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(12000, 2000, 9000, 2000), false, NULL);
  ASSERT r->>'error' = 'reason_required', r::text;
  -- arithmetic still checked.
  p := pg_temp.pl(12000, 2000, 9000, 2000); p := jsonb_set(p, '{timesheet,net}', '1');
  r := public.finalize_payslip(ora, DATE '2026-09-01', p, false, 'Paper sheet says 12k basic');
  ASSERT r->>'error' = 'invalid_totals', r::text;
  -- typed bond on final pay is refused; a bond above the pay is refused.
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(12000, 2000, 9000, 2000) || '{"cash_bond_held_php": 100}', true, 'Paper sheet');
  ASSERT r->>'error' = 'invalid_figures', r::text;
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(12000, 2000, 9000, 2000) || '{"cash_bond_held_php": 11000.01}', false, 'Paper sheet');
  ASSERT r->>'error' = 'bond_exceeds_pay', r::text;
  r := public.finalize_payslip(ora, DATE '2026-09-01', pg_temp.pl(12000, 2000, 9000, 2000) || '{"cash_bond_held_php": 5000}', false,
                               '  Paper sheet says 12k basic  ');
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT r->'payslip'->>'correction_reason' = 'Paper sheet says 12k basic', r::text;
  ASSERT (r->'payslip'->'timesheet'->>'basic_salary')::numeric = 12000, r::text;
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 5000, r::text;
  ASSERT r->'payslip'->>'corrected_from_payslip_id' IS NULL, r::text;
  INSERT INTO ctx VALUES ('ora_sep', r->'payslip'->>'id');
  RAISE NOTICE 'E3 finalize with a reason OK';
END $t$;

-- E4 correct a Finalized payslip: one transaction; advances and bonuses move; audit.
DO $t$ DECLARE r jsonb; noa uuid := '00000000-0000-0000-0000-0000000000f5'; old uuid; nw uuid; adv uuid; BEGIN
  r := public.save_staff_payroll_details(noa, 'Laguna', DATE '1997-04-04', 'CJ-302', NULL);
  ASSERT r->>'ok' = 'true', r::text;
  r := public.add_cash_advance(noa, DATE '2026-09-01', DATE '2026-09-15', 1500, 'Rent');
  ASSERT r->>'ok' = 'true', r::text;
  adv := (r->'advance'->>'id')::uuid;
  r := public.finalize_payslip(noa, DATE '2026-09-01', pg_temp.pl(10000, 2000, 8000, 2000, 1000), false);
  ASSERT r->>'ok' = 'true', r::text;
  old := (r->'payslip'->>'id')::uuid;
  ASSERT (SELECT payslip_id FROM public.payslip_cash_advances WHERE id = adv) = old, 'advance linked to the first one';

  r := public.correct_payslip(old, pg_temp.pl(10000, 2000, 8500, 2000, 1000), false, 'no');
  ASSERT r->>'error' = 'reason_required', r::text;
  r := public.correct_payslip(gen_random_uuid(), pg_temp.pl(10000, 2000, 8500, 2000, 1000), false, 'Missed day');
  ASSERT r->>'error' = 'not_found', r::text;
  -- a refusal inside the re-issue changes nothing.
  r := public.correct_payslip(old, jsonb_set(pg_temp.pl(10000, 2000, 8500, 2000, 1000), '{total_php}', '1'), false, 'Missed day');
  ASSERT r->>'error' = 'invalid_totals', r::text;
  ASSERT (SELECT status FROM public.payslips WHERE id = old) = 'finalized', 'old one untouched after a refusal';

  r := public.correct_payslip(old, pg_temp.pl(10000, 2000, 8500, 2000, 1000), false, 'Missed day 14 Sept');
  ASSERT r->>'ok' = 'true', r::text;
  nw := (r->'payslip'->>'id')::uuid;
  ASSERT r->>'voided_id' = old::text, r::text;
  ASSERT (SELECT status || '|' || void_reason FROM public.payslips WHERE id = old) = 'void|Corrected: Missed day 14 Sept', 'old voided';
  ASSERT (SELECT status FROM public.payslips WHERE id = nw) = 'finalized', 'new finalized';
  ASSERT (SELECT corrected_from_payslip_id FROM public.payslips WHERE id = nw) = old, 'linked to the old one';
  ASSERT (SELECT correction_reason FROM public.payslips WHERE id = nw) = 'Missed day 14 Sept', 'reason stored';
  ASSERT (SELECT timesheet_net_php FROM public.payslips WHERE id = nw) = 10500, 'new figures';
  ASSERT (SELECT cash_advance_php FROM public.payslips WHERE id = nw) = 1500, 'advance carried';
  ASSERT (SELECT payslip_id FROM public.payslip_cash_advances WHERE id = adv) = nw, 'advance moved to the corrected one';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_id = old AND action = 'void_payslip') = 1, 'void audit';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_id = nw AND action = 'correct_payslip'
           AND (new_value_json->>'manual')::boolean AND new_value_json->>'corrected_from' = old::text) = 1, 'correct audit';
  r := public.correct_payslip(old, pg_temp.pl(10000, 2000, 8500, 2000, 1000), false, 'Again');
  ASSERT r->>'error' = 'already_void', r::text;
  INSERT INTO ctx VALUES ('noa_sep', nw::text);
  RAISE NOTICE 'E4 correct a finalized payslip OK';
END $t$;

-- E5 correct a Paid payslip: the payment and both proofs are copied; a 2nd proof can still be added later.
DO $t$ DECLARE r jsonb; cur uuid := (SELECT v::uuid FROM ctx WHERE k = 'noa_sep'); nw uuid; nw2 uuid;
  d date := (SELECT v::date FROM ctx WHERE k = 'today'); BEGIN
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', cur::text || '/gcash.png');
  r := public.record_payslip_payment(cur, 25000, 10950.50, d, cur::text || '/gcash.png');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.correct_payslip(cur, pg_temp.pl(10000, 2000, 9000, 2000, 1000), false, 'Allowance typo');
  ASSERT r->>'ok' = 'true', r::text;
  nw := (r->'payslip'->>'id')::uuid;
  ASSERT r->'payslip'->>'status' = 'paid', r::text;
  ASSERT (r->'payslip'->>'jpy_sent')::int = 25000 AND (r->'payslip'->>'php_received')::numeric = 10950.50, r::text;
  ASSERT r->'payslip'->>'proof_path' = cur::text || '/gcash.png', 'proof stays in the folder it was uploaded to';
  ASSERT (r->'payslip'->>'paid_on')::date = d, r::text;
  ASSERT (r->'payslip'->>'php_per_jpy')::numeric = round(10950.50 / 25000, 6), r::text;
  -- the 2nd proof on the corrected payslip goes to its own folder.
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', nw::text || '/bank.pdf');
  r := public.attach_payslip_proof(nw, nw::text || '/bank.pdf');
  ASSERT r->>'ok' = 'true', r::text;
  -- corrected again: both proofs (two folders) are copied.
  r := public.correct_payslip(nw, pg_temp.pl(10000, 2000, 9100, 2000, 1000), false, 'Second fix');
  ASSERT r->>'ok' = 'true', r::text;
  nw2 := (r->'payslip'->>'id')::uuid;
  ASSERT r->'payslip'->>'proof_path' = cur::text || '/gcash.png' AND r->'payslip'->>'proof_path_2' = nw::text || '/bank.pdf', r::text;
  ASSERT (SELECT count(*) FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-0000000000f5'
           AND pay_month = DATE '2026-09-01' AND status <> 'void') = 1, 'one live payslip for the month';
  RAISE NOTICE 'E5 correct a paid payslip OK';
END $t$;

-- E6 a bond already released cannot be corrected; the releasing one can, and it releases again.
DO $t$ DECLARE r jsonb; mia uuid := '00000000-0000-0000-0000-0000000000f4'; sep uuid; oct uuid; BEGIN
  SELECT id INTO sep FROM public.payslips WHERE user_id = mia AND pay_month = DATE '2026-09-01' AND status <> 'void';
  SELECT id INTO oct FROM public.payslips WHERE user_id = mia AND pay_month = DATE '2026-10-01' AND status <> 'void';
  r := public.correct_payslip(sep, pg_temp.pl(10000, 2000, 7000.55, 2000, 3000), false, 'Bond fix');
  ASSERT r->>'error' = 'bond_already_released', r::text;
  r := public.correct_payslip(oct, pg_temp.pl(10000, 2000, 8200, 2000), false, 'October fix');
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 4500.27 AND r->'payslip'->>'cash_bond_source_payslip_id' = sep::text, r::text;
  RAISE NOTICE 'E6 bond order OK';
END $t$;

-- E7 gate: a CSR cannot correct or finalize with a reason.
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.correct_payslip((SELECT v::uuid FROM ctx WHERE k = 'ora_sep'), pg_temp.pl(10000, 2000, 1, 0), false, 'Sneaky');
  ASSERT r->>'error' = 'permission_denied', r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000f6', DATE '2026-10-01', pg_temp.pl(10000, 2000, 1, 0), false, 'Sneaky');
  ASSERT r->>'error' = 'permission_denied', r::text;
  RAISE NOTICE 'E7 gate OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- E8 book: features.edit_figures and the new columns.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT (r->'features'->>'edit_figures')::boolean, r->>'features';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'payslips') e
                  WHERE e->>'correction_reason' = 'Second fix' AND e->>'corrected_from_payslip_id' IS NOT NULL), 'columns in the book';
  RAISE NOTICE 'E8 book OK';
END $t$;

RESET ROLE;

-- E9 the locks still hold for direct writes.
DO $t$ DECLARE p uuid := (SELECT v::uuid FROM ctx WHERE k = 'ora_sep'); BEGIN
  BEGIN UPDATE public.payslips SET correction_reason = 'changed' WHERE id = p; RAISE EXCEPTION 'reason edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET total_php = total_php + 1, timesheet_net_php = timesheet_net_php + 1 WHERE id = p;
    RAISE EXCEPTION 'figure edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.payslips (user_id, pay_month, status, staff_name, address, date_of_birth, template_type, timesheet,
                                     commission, timesheet_net_php, commission_php, total_php, finalized_by, corrected_from_payslip_id)
        VALUES (gen_random_uuid(), DATE '2026-09-01', 'finalized', 'X', 'Y', DATE '2000-01-01', 'csr', '{}', '{}', 0, 0, 0, gen_random_uuid(), p);
    RAISE EXCEPTION 'corrected without a reason should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET proof_path = '../x' WHERE id = p; RAISE EXCEPTION 'bad path should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'E9 locks OK';
END $t$;

\echo 'ALL EDIT-FIGURES TESTS PASSED'
