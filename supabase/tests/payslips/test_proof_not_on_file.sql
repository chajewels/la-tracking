-- Phase 7: migration 20270209100000 ("proof not on file" before June 2026; cash bond returned on Final
-- pay) applied twice on top of the Phase 6 database and the pre9_* snapshots taken just before it.
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

-- Two CSRs (superuser setup): Rae (no hire date, left after May) and Sol (hired April 2026: a Hub bond).
INSERT INTO public.profiles (user_id, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000f8', 'Rae Cruz'),
  ('00000000-0000-0000-0000-0000000000f9', 'Sol Reyes');
INSERT INTO public.timesheet_profiles (user_id, template_type, job_title, basic_salary, allowance, active) VALUES
  ('00000000-0000-0000-0000-0000000000f8', 'csr', 'CSR', 10000, 2000, false),
  ('00000000-0000-0000-0000-0000000000f9', 'csr', 'CSR', 10000, 2000, true);

-- G1 shape; existing rows unchanged apart from the new column (false); grants kept.
DO $t$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre9_payslips s JOIN public.payslips p ON p.id = s.id
                      WHERE (to_jsonb(p) - 'proof_not_on_file') <> s.row OR p.proof_not_on_file),
    'payslips unchanged';
  ASSERT (SELECT count(*) FROM public.pre9_payslips) = (SELECT count(*) FROM public.payslips), 'no payslip added or removed';
  ASSERT (SELECT n FROM public.pre9_audit) = (SELECT count(*) FROM public.audit_logs), 'the migration wrote no audit rows';
  ASSERT (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass
           AND conname IN ('payslips_paid_fields', 'payslips_proof_not_on_file', 'payslips_cash_bond_released')) = 3,
    'constraints present once';
  ASSERT NOT has_function_privilege('authenticated', 'public.payslip_issue(uuid,date,jsonb,boolean,text,uuid)', 'EXECUTE'),
    'payslip_issue stays internal';
  ASSERT has_function_privilege('authenticated', 'public.correct_payslip(uuid,jsonb,boolean,text)', 'EXECUTE'), 'correct grant';
  ASSERT NOT has_function_privilege('anon', 'public.get_payslip_book(date)', 'EXECUTE'), 'anon cannot read the book';
  RAISE NOTICE 'G1 shape + existing rows unchanged OK';
END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- G2 the returned bond: Final pay + reason, added to the amount due, no source payslip.
DO $t$ DECLARE r jsonb; rae uuid := '00000000-0000-0000-0000-0000000000f8'; p jsonb; BEGIN
  r := public.save_staff_payroll_details(rae, 'Laguna', DATE '1997-07-07', 'CJ-308', NULL);
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip(rae, DATE '2026-04-01', pg_temp.pl(8000, 2000), false);
  ASSERT r->>'ok' = 'true', r::text;
  p := pg_temp.pl(8000, 2000) || jsonb_build_object('cash_bond_returned_php', 7333.33);
  r := public.finalize_payslip(rae, DATE '2026-05-01', p, false, 'Cash bond returned on final pay');
  ASSERT r->>'error' = 'invalid_figures' AND r->>'field' = 'cash_bond_returned_php', 'not final pay: ' || r::text;
  r := public.finalize_payslip(rae, DATE '2026-05-01', p, true);
  ASSERT r->>'error' = 'invalid_figures' AND r->>'field' = 'cash_bond_returned_php', 'no reason: ' || r::text;
  r := public.finalize_payslip(rae, DATE '2026-05-01', p, true, 'Cash bond returned on final pay');
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT (r->'payslip'->>'cash_bond_released_php')::numeric = 7333.33, r::text;
  ASSERT r->'payslip'->>'cash_bond_source_payslip_id' IS NULL, r::text;
  ASSERT (r->'payslip'->>'amount_due_php')::numeric = 10000 + 7333.33, r::text;
  ASSERT (r->'payslip'->>'is_final_pay')::boolean, r::text;
  r := public.get_payslip_book(DATE '2026-05-01');
  ASSERT (r->'features'->>'bond_returned')::boolean AND (r->'features'->>'proof_not_on_file')::boolean, r::text;
  RAISE NOTICE 'G2 cash bond returned OK';
END $t$;

-- G3 a Hub-held bond waiting refuses a typed return (it is released by itself on Final pay).
DO $t$ DECLARE r jsonb; sol uuid := '00000000-0000-0000-0000-0000000000f9'; BEGIN
  r := public.save_staff_payroll_details(sol, 'Batangas', DATE '1996-06-06', 'CJ-309', DATE '2026-04-03');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip(sol, DATE '2026-04-01', pg_temp.pl(8000, 2000), false);
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 5000, r::text;
  r := public.finalize_payslip(sol, DATE '2026-05-01', pg_temp.pl(8000, 2000) || jsonb_build_object('cash_bond_returned_php', 100),
                               true, 'try a typed return');
  ASSERT r->>'error' = 'bond_pending_in_hub', r::text;
  RAISE NOTICE 'G3 bond_pending_in_hub OK';
END $t$;

RESET ROLE;

-- G4 "proof not on file": allowed before June 2026 (the one-time owner data step), with no proof file.
DO $t$ DECLARE apr uuid; jun uuid; ok boolean;
  rae uuid := '00000000-0000-0000-0000-0000000000f8'; BEGIN
  SELECT id INTO apr FROM public.payslips WHERE user_id = rae AND pay_month = DATE '2026-04-01' AND status = 'finalized';
  UPDATE public.payslips
     SET status = 'paid', jpy_sent = round(amount_due_php / 0.405932)::int, php_received = amount_due_php,
         php_per_jpy = round(amount_due_php / round(amount_due_php / 0.405932), 6), paid_on = DATE '2026-05-05',
         proof_not_on_file = true, paid_by = '00000000-0000-0000-0000-00000000000a', paid_at = now()
   WHERE id = apr;
  ASSERT (SELECT status = 'paid' AND proof_path IS NULL AND proof_not_on_file FROM public.payslips WHERE id = apr), 'april paid';
  -- a proof file AND the flag together: refused.
  ok := false;
  BEGIN
    UPDATE public.payslips SET proof_path = apr::text || '/x.jpg' WHERE id = apr;
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'paid payslip stays locked';
  -- a June payslip cannot be paid without proof.
  SELECT id INTO jun FROM public.payslips WHERE status = 'finalized' AND pay_month >= DATE '2026-06-01' LIMIT 1;
  IF jun IS NOT NULL THEN
    ok := false;
    BEGIN
      UPDATE public.payslips
         SET status = 'paid', jpy_sent = 100, php_received = 40, php_per_jpy = 0.4, paid_on = pay_month + 5,
             proof_not_on_file = true, paid_by = '00000000-0000-0000-0000-00000000000a', paid_at = now()
       WHERE id = jun;
    EXCEPTION WHEN check_violation THEN ok := true; END;
    ASSERT ok, 'June onwards needs a proof';
  END IF;
  -- no proof and no flag: refused.
  ok := false;
  BEGIN
    UPDATE public.payslips
       SET status = 'paid', jpy_sent = 100, php_received = 40, php_per_jpy = 0.4, paid_on = DATE '2026-06-05',
           paid_by = '00000000-0000-0000-0000-00000000000a', paid_at = now()
     WHERE user_id = rae AND pay_month = DATE '2026-05-01' AND status = 'finalized';
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'paid needs a proof or the flag';
  -- a new payslip cannot start with the flag.
  ok := false;
  BEGIN
    UPDATE public.payslips SET proof_not_on_file = true WHERE user_id = rae AND pay_month = DATE '2026-05-01' AND status = 'finalized';
  EXCEPTION WHEN check_violation THEN ok := true; END;
  ASSERT ok, 'the flag alone is refused';
  RAISE NOTICE 'G4 proof not on file OK';
END $t$;

-- G5 correcting a "proof not on file" Paid payslip keeps it Paid with the flag.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; apr uuid; rae uuid := '00000000-0000-0000-0000-0000000000f8'; BEGIN
  SELECT id INTO apr FROM public.payslips WHERE user_id = rae AND pay_month = DATE '2026-04-01' AND status = 'paid';
  r := public.correct_payslip(apr, pg_temp.pl(8100, 2000), false, 'Hours fixed from the paper sheet');
  ASSERT r->>'ok' = 'true', r::text;
  ASSERT r->'payslip'->>'status' = 'paid' AND (r->'payslip'->>'proof_not_on_file')::boolean
         AND r->'payslip'->>'proof_path' IS NULL AND r->'payslip'->>'paid_on' = '2026-05-05', r::text;
  RAISE NOTICE 'G5 correct keeps proof not on file OK';
END $t$;
RESET ROLE;

\echo 'ALL PROOF-NOT-ON-FILE TESTS PASSED'
