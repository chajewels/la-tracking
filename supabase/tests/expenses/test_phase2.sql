\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- stand-in for the live table (baseline columns)
CREATE TABLE IF NOT EXISTS public.timesheet_monthly_history (
  month_key text NOT NULL PRIMARY KEY, csr_net numeric DEFAULT 0 NOT NULL, liveadmin_net numeric DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL);
INSERT INTO public.timesheet_monthly_history (month_key, csr_net, liveadmin_net) VALUES ('2026-05', 50000, 12000);
GRANT SELECT ON public.timesheet_monthly_history TO authenticated;

\i :migration2
\i :migration2

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.book_payroll_month('2026-09-01', current_date, '[{"name":"A","template":"csr","net":"1000"}]');
  ASSERT r->>'error' = 'permission_denied', 'finance book: ' || r::text;
  r := public.get_booked_months('payroll');
  ASSERT r->>'error' = 'permission_denied', 'finance read: ' || r::text;
  RAISE NOTICE 'P1 finance denied OK';
END $t$;

SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.book_payroll_month('2026-09-01', current_date, '[{"name":"A","template":"csr","net":"1000"}]');
  ASSERT r->>'error' = 'permission_denied', 'manage-only cannot book: ' || r::text;
  r := public.get_booked_months('payroll');
  ASSERT r->>'ok' = 'true', 'manage-only can read: ' || r::text;
  RAISE NOTICE 'P2 manage-only OK';
END $t$;

SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; e uuid; lines jsonb; BEGIN
  lines := '[{"user_id":"00000000-0000-0000-0000-000000000001","name":"Ana","template":"csr","total_hours":"160","net":"12000"},
            {"user_id":"00000000-0000-0000-0000-000000000002","name":"Brenda","template":"csr","total_hours":"150","net":"11500.50"},
            {"user_id":"00000000-0000-0000-0000-000000000003","name":"Kaila","template":"live_admin","total_hours":"40","net":"7500"}]';
  r := public.book_payroll_month('2026-09-15', '2026-10-01', lines);
  ASSERT r->>'error' = 'invalid_month', 'not first of month: ' || r::text;
  r := public.book_payroll_month(date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date + 40)::date, current_date, lines);
  ASSERT r->>'error' = 'invalid_month', 'future month: ' || r::text;
  r := public.book_payroll_month('2026-09-01', current_date + 1, lines);
  ASSERT r->>'error' = 'invalid_paid_on', 'paid tomorrow: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-08-31', lines);
  ASSERT r->>'error' = 'invalid_paid_on', 'paid before the month: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-01', '[{"name":"X","template":"csr","net":"abc"}]');
  ASSERT r->>'error' = 'invalid_lines', 'non-numeric net gives a refusal, not a raw error: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-01', '[{"name":"X","template":"csr","net":"1","user_id":"not-a-uuid"}]');
  ASSERT r->>'error' = 'invalid_lines', 'bad uuid: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-01', (SELECT jsonb_agg(jsonb_build_object('name','N'||i,'template','csr','net','1')) FROM generate_series(1,501) i));
  ASSERT r->>'error' = 'invalid_lines', 'over 500 lines: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-01', '[]');
  ASSERT r->>'error' = 'invalid_lines', 'empty lines: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-01', '[{"name":"X","template":"boss","net":"1"}]');
  ASSERT r->>'error' = 'invalid_lines', 'bad template: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-01', '[{"name":"X","template":"csr","net":"-5"}]');
  ASSERT r->>'error' = 'invalid_lines', 'negative net: ' || r::text;

  r := public.book_payroll_month('2026-09-01', '2026-10-01', lines);
  ASSERT r->>'ok' = 'true', 'book: ' || r::text;
  e := (r->'expense'->>'id')::uuid;
  ASSERT r->'expense'->>'status' = 'approved', 'approved at once';
  ASSERT (r->'expense'->>'amount')::numeric = 31000.50, 'sum: ' || (r->'expense'->>'amount');
  ASSERT (r->'expense'->>'amount_jpy')::numeric = round(31000.50/0.42), 'jpy: ' || (r->'expense'->>'amount_jpy');
  ASSERT r->'expense'->>'description' = 'Staff payroll — September 2026 (3 people)', 'desc: ' || (r->'expense'->>'description');
  ASSERT r->'expense'->>'source_ref' = '2026-09' AND r->'expense'->>'source' = 'payroll', 'source';
  ASSERT (r->'expense'->'details'->>'csr_net')::numeric = 23500.50 AND (r->'expense'->'details'->>'liveadmin_net')::numeric = 7500, 'details split';
  ASSERT jsonb_array_length(r->'expense'->'details'->'lines') = 3, 'lines kept';
  ASSERT jsonb_typeof(r->'expense'->'details'->'lines'->0->'net') = 'number', 'lines canonical (numbers, not strings)';
  ASSERT (r->'expense'->'details'->'lines'->0) ? 'user_id' AND NOT ((r->'expense'->'details'->'lines'->0) ? 'extra'), 'known keys only';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_id = e) = 2, 'two audit rows (create + approve)';
  ASSERT (SELECT csr_net FROM public.timesheet_monthly_history WHERE month_key = '2026-09') = 23500.50, 'history written';
  ASSERT (SELECT count(*) FROM public.timesheet_monthly_history) = 2, 'history rows';

  r := public.book_payroll_month('2026-09-01', '2026-10-02', lines);
  ASSERT r->>'error' = 'already_booked', 'double booking: ' || r::text;

  r := public.void_expense(e, 'Wrong figures, re-booking');
  ASSERT r->>'ok' = 'true', 'void booking: ' || r::text;
  r := public.book_payroll_month('2026-09-01', '2026-10-02', '[{"name":"Ana","template":"csr","net":"12000"}]');
  ASSERT r->>'ok' = 'true', 're-book after void: ' || r::text;
  ASSERT r->'expense'->>'description' = 'Staff payroll — September 2026 (1 person)', 'singular';
  ASSERT (SELECT csr_net FROM public.timesheet_monthly_history WHERE month_key = '2026-09') = 12000, 'history refreshed on re-book';

  r := public.get_booked_months('payroll');
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'months') m WHERE m->>'month_key' = '2026-09') = 2, 'void + approved both listed for 2026-09: ' || r::text;
  ASSERT (SELECT m->>'status' FROM jsonb_array_elements(r->'months') m WHERE m->>'month_key' = '2026-09' ORDER BY (m->>'approved_at') DESC NULLS LAST, (m->>'voided_at') NULLS FIRST LIMIT 1) IS NOT NULL, 'ordering sane';
  r := public.get_booked_months('bonus');
  ASSERT r->>'error' = 'invalid_source', 'bad source';
  RAISE NOTICE 'P3 payroll booking OK';
END $t$;

DO $t$ DECLARE r jsonb; lines jsonb; BEGIN
  lines := '[{"name":"Ana","role_won":"Closer","earn":"3000","bonus":"500","total":"3500","top_sales":true,"extra":"dropped"},
            {"name":"Cris","role_won":null,"earn":"0","bonus":"300","total":"300"}]';
  r := public.book_commission_month('2026-09-01', '2026-10-05', lines);
  ASSERT r->>'ok' = 'true', 'commission book: ' || r::text;
  ASSERT (r->'expense'->>'amount')::numeric = 3800, 'commission sum';
  ASSERT r->'expense'->>'description' = 'Sales commission — September 2026 (2 agents)', 'desc: ' || (r->'expense'->>'description');
  ASSERT (r->'expense'->'details'->'lines'->0->>'top_sales')::boolean AND NOT ((r->'expense'->'details'->'lines'->0) ? 'extra'), 'top_sales kept, extras dropped';
  ASSERT (SELECT c.system_key FROM public.expenses e JOIN public.expense_categories c ON c.id = e.category_id WHERE e.id = (r->'expense'->>'id')::uuid) = 'commission', 'category';
  r := public.book_commission_month('2026-09-01', '2026-10-05', lines);
  ASSERT r->>'error' = 'already_booked', 'commission twice';
  r := public.book_commission_month('2026-08-01', '2026-09-05', '[{"name":"Ana","total":"0"}]');
  ASSERT r->>'error' = 'invalid_lines', 'zero total line';
  ASSERT (SELECT count(*) FROM public.timesheet_monthly_history) = 2, 'commission does not touch history';

  r := public.get_expense_book('2026-10-15');
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'expenses') x WHERE x->>'source' IN ('payroll','commission') AND x->>'status' = 'approved') = 2, 'both approved bookings in October book';
  RAISE NOTICE 'P4 commission booking OK';
END $t$;

-- the booked row is locked like any approved expense; details locked too
RESET ROLE;
DO $t$ DECLARE e uuid; BEGIN
  SELECT id INTO e FROM public.expenses WHERE source = 'commission' AND status = 'approved';
  BEGIN
    UPDATE public.expenses SET details = '{}' WHERE id = e;
    RAISE EXCEPTION 'details change on approved should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.timesheet_monthly_history (month_key) VALUES ('2026-05');
    RAISE EXCEPTION 'duplicate month_key should fail (primary key)';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'P5 locks OK';
END $t$;
SELECT 'ALL PHASE 2 TESTS PASSED' AS result;
