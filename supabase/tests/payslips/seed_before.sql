-- Phase 2 seed, run AFTER 20270201 + 20270202 and BEFORE 20270204: payslips issued the old way, so the new
-- migration's ADD COLUMNs meet existing rows (which must come out unchanged).
\set ON_ERROR_STOP 1
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
DO $s$ DECLARE r jsonb; BEGIN
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000a1', 'Cebu City', DATE '1998-11-02');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01',
    '{"timesheet":{"days_worked":22,"total_hours":176.5,"daily_pay_sum":12400,"basic_salary":12000,"capped_gross":12000,
       "monthly_allowance":2000,"forfeited_weeks":1,"allowance_paid":1500,"net":13500},
      "commission":{"role_won":"Closer","earnings":2500.5,"top_sales_tier":1,"top_sales_bonus":500,"total":3000.5},
      "timesheet_net_php":13500,"commission_php":3000.5,"total_php":16500.5}');
  ASSERT r->>'ok' = 'true', 'seed kaila: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', DATE '2026-09-01',
    '{"timesheet":{"days_at_500":10,"days_at_300":4,"total_hours":61,"net":6200},
      "commission":{"role_won":null,"earnings":0,"top_sales_tier":0,"top_sales_bonus":0,"total":0},
      "timesheet_net_php":6200,"commission_php":0,"total_php":6200}');
  ASSERT r->>'ok' = 'true', 'seed jose: ' || r::text;
END $s$;
RESET ROLE;
CREATE TABLE public.seed_snapshot AS SELECT id, to_jsonb(p) AS row FROM public.payslips p;
CREATE TABLE public.seed_audit AS SELECT count(*) AS n FROM public.audit_logs;
