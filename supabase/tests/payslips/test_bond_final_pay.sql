-- Phase 6: migration 20270208100000 (cash bond released ONLY on Final pay, owner 2026-10-27 17:54) applied
-- twice on top of the Phase 5 database and the pre8_* snapshots taken just before it.
\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'

CREATE FUNCTION pg_temp.pl(capped numeric, ap numeric) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'timesheet', jsonb_build_object('days_worked', 20, 'total_hours', 160, 'daily_pay_sum', capped, 'basic_salary', 10000,
                                    'capped_gross', capped, 'monthly_allowance', 2000, 'forfeited_weeks', 0,
                                    'allowance_paid', ap, 'net', capped + ap),
    'commission', jsonb_build_object('role_won', NULL, 'earnings', 0, 'top_sales_tier', 0, 'top_sales_bonus', 0, 'total', 0),
    'timesheet_net_php', capped + ap, 'commission_php', 0, 'total_php', capped + ap) $$;
GRANT EXECUTE ON FUNCTION pg_temp.pl(numeric, numeric) TO authenticated;

-- A new CSR hired July 2026 (superuser setup).
INSERT INTO public.profiles (user_id, full_name) VALUES ('00000000-0000-0000-0000-0000000000f7', 'Pia Santos');
INSERT INTO public.timesheet_profiles (user_id, template_type, job_title, basic_salary, allowance, active) VALUES
  ('00000000-0000-0000-0000-0000000000f7', 'csr', 'CSR', 10000, 2000, true);

-- F1 shape: the release line changed, nothing else; every existing row unchanged; grants kept.
DO $t$ DECLARE src text; BEGIN
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'public.payslip_issue(uuid,date,jsonb,boolean,text,uuid)'::regprocedure;
  ASSERT position('IF FOUND AND v_final THEN' IN src) > 0, 'release only on final pay';
  ASSERT position('interval ''1 month'')::date OR v_final' IN src) = 0, 'month + 1 release gone';
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre8_payslips s JOIN public.payslips p ON p.id = s.id WHERE to_jsonb(p) <> s.row),
    'payslips unchanged';
  ASSERT (SELECT count(*) FROM public.pre8_payslips) = (SELECT count(*) FROM public.payslips), 'no payslip added or removed';
  ASSERT (SELECT n FROM public.pre8_audit) = (SELECT count(*) FROM public.audit_logs), 'the migration wrote no audit rows';
  ASSERT NOT has_function_privilege('authenticated', 'public.payslip_issue(uuid,date,jsonb,boolean,text,uuid)', 'EXECUTE'),
    'clients still cannot call payslip_issue';
  ASSERT has_function_privilege('authenticated', 'public.finalize_payslip(uuid,date,jsonb,boolean)', 'EXECUTE'), 'finalize 4 grant';
  RAISE NOTICE 'F1 shape + existing rows unchanged OK';
END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- F2 hire month holds; the next months release NOTHING; the bond stays pending.
DO $t$ DECLARE r jsonb; pia uuid := '00000000-0000-0000-0000-0000000000f7'; jul uuid; BEGIN
  r := public.save_staff_payroll_details(pia, 'Manila', DATE '1999-05-05', 'CJ-307', DATE '2026-07-05');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip(pia, DATE '2026-07-01', pg_temp.pl(8000, 2000), false);
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 5000, r::text;
  jul := (r->'payslip'->>'id')::uuid;
  r := public.finalize_payslip(pia, DATE '2026-08-01', pg_temp.pl(8000, 2000), false);
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 0, 'August (hire month + 1): no release: ' || r::text;
  ASSERT r->'payslip'->>'cash_bond_source_payslip_id' IS NULL, r::text;
  ASSERT (r->'payslip'->>'amount_due_php')::numeric = 10000, r::text;
  r := public.finalize_payslip(pia, DATE '2026-09-01', pg_temp.pl(8000, 2000), false);
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 0, 'September: no release: ' || r::text;
  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'details') d
                  WHERE d->>'user_id' = pia::text AND (d->'cash_bond_pending'->>'source_payslip_id')::uuid = jul
                    AND (d->'cash_bond_pending'->>'amount')::numeric = 5000), 'bond still pending: ' || (r->'details')::text;
  RAISE NOTICE 'F2 no automatic release OK';
END $t$;

-- F3 a "Final pay" payslip releases the held bond, once; the hire-month payslip can then not be corrected.
DO $t$ DECLARE r jsonb; pia uuid := '00000000-0000-0000-0000-0000000000f7'; jul uuid; BEGIN
  SELECT id INTO jul FROM public.payslips WHERE user_id = pia AND pay_month = DATE '2026-07-01' AND status <> 'void';
  r := public.finalize_payslip(pia, DATE '2026-10-01', pg_temp.pl(8000, 2000), true);
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 5000, 'final pay releases: ' || r::text;
  ASSERT (r->'payslip'->>'cash_bond_source_payslip_id')::uuid = jul, r::text;
  ASSERT (r->'payslip'->>'amount_due_php')::numeric = 15000, r::text;
  r := public.correct_payslip(jul, pg_temp.pl(8000, 2000), false, 'try after release');
  ASSERT r->>'error' = 'bond_already_released', r::text;
  RAISE NOTICE 'F3 final pay releases OK';
END $t$;

RESET ROLE;
\echo 'ALL BOND FINAL-PAY TESTS PASSED'
