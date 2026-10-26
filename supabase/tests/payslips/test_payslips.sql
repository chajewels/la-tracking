\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'
\set C '00000000-0000-0000-0000-00000000000c'
\set L '00000000-0000-0000-0000-0000000000a1'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Figures used below: a CSR payslip (Kaila, ₱12,000 basic) and a Live Admin payslip (Jose).
CREATE TEMP TABLE fx (k text PRIMARY KEY, v jsonb);
INSERT INTO fx VALUES
  ('csr', '{"timesheet":{"days_worked":22,"total_hours":176.5,"daily_pay_sum":12400,"basic_salary":12000,
            "capped_gross":12000,"monthly_allowance":2000,"forfeited_weeks":1,"allowance_paid":1500,"net":13500,
            "hack":999},
           "commission":{"role_won":"Closer","earnings":"2500.50","top_sales_tier":1,"top_sales_bonus":500,"total":3000.5,
            "evil":"x"},
           "timesheet_net_php":13500,"commission_php":3000.5,"total_php":16500.5,"staff_name":"Someone Else"}'),
  ('la',  '{"timesheet":{"days_at_500":10,"days_at_300":4,"total_hours":61,"net":6200},
           "commission":{"role_won":null,"earnings":0,"top_sales_tier":0,"top_sales_bonus":0,"total":0},
           "timesheet_net_php":6200,"commission_php":0,"total_php":6200}');
GRANT SELECT ON fx TO authenticated;

-- P1 shape after the migration (applied twice by the runner).
DO $t$ BEGIN
  ASSERT (SELECT public FROM storage.buckets WHERE id = 'payslip-proofs') = false, 'bucket must be private';
  ASSERT (SELECT file_size_limit FROM storage.buckets WHERE id = 'payslip-proofs') = 10485760, '10 MB';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE '%payslip proofs') = 2, 'two storage policies';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('payslips', 'staff_payroll_details') AND cmd <> 'SELECT') = 0, 'no write policies';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('payslips', 'staff_payroll_details')) = 2, 'one read policy each';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslips', 'INSERT'), 'authenticated cannot insert';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslips', 'UPDATE'), 'authenticated cannot update';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslips', 'DELETE'), 'authenticated cannot delete';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslips', 'TRUNCATE'), 'authenticated cannot truncate';
  ASSERT NOT has_table_privilege('anon', 'public.payslips', 'SELECT'), 'anon cannot read';
  ASSERT NOT has_table_privilege('anon', 'public.staff_payroll_details', 'SELECT'), 'anon cannot read details';
  ASSERT NOT has_function_privilege('anon', 'public.get_payslip_book(date)', 'EXECUTE'), 'anon cannot call the book';
  ASSERT NOT has_function_privilege('authenticated', 'public.payslip_figure(jsonb, boolean)', 'EXECUTE'), 'helper is internal';
  RAISE NOTICE 'P1 shape OK';
END $t$;

-- P2 permission: admin yes, can_view_all yes, other staff / CSR / finance no, nobody can probe others, anon no.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT r->>'ok' = 'true' AND (r->>'can_manage')::boolean AND (r->>'php_jpy_rate')::numeric = 0.42, 'admin book: ' || r::text;
  ASSERT jsonb_array_length(r->'details') = 4, 'details row for every active timesheet profile: ' || r::text;
  ASSERT public.can_manage_payslips('00000000-0000-0000-0000-00000000000a'), 'admin gate';
  ASSERT NOT public.can_manage_payslips('00000000-0000-0000-0000-00000000000b'), 'gate never answers for someone else';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT r->>'ok' = 'true', 'can_view_all book: ' || r::text;
END $t$;
DO $t$
DECLARE r jsonb; u text; who text[] := ARRAY['00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000f',
                                             '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000a1'];
BEGIN
  FOREACH u IN ARRAY who LOOP
    PERFORM set_config('request.jwt.claim.sub', u, false);
    r := public.get_payslip_book(DATE '2026-09-01');
    ASSERT r->>'error' = 'permission_denied', 'book ' || u || ': ' || r::text;
    r := public.save_staff_payroll_details(u::uuid, 'x', DATE '1990-01-01');
    ASSERT r->>'error' = 'permission_denied', 'details ' || u || ': ' || r::text;
    r := public.finalize_payslip(u::uuid, DATE '2026-09-01', '{}');
    ASSERT r->>'error' = 'permission_denied', 'finalize ' || u || ': ' || r::text;
    r := public.record_payslip_payment(gen_random_uuid(), 1, 1, DATE '2026-10-01', 'x/y');
    ASSERT r->>'error' = 'permission_denied', 'pay ' || u || ': ' || r::text;
    r := public.void_payslip(gen_random_uuid(), 'because');
    ASSERT r->>'error' = 'permission_denied', 'void ' || u || ': ' || r::text;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', false);
  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT r->>'error' = 'permission_denied', 'no identity: ' || r::text;
  RAISE NOTICE 'P2 permission OK (admin, can_view_all yes; csr, finance, staff, live admin, no identity no)';
END $t$;
RESET ROLE;
SET ROLE anon;
DO $t$ BEGIN
  BEGIN
    PERFORM public.get_payslip_book(DATE '2026-09-01');
    RAISE EXCEPTION 'anon should not call the book';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM count(*) FROM public.payslips;
    RAISE EXCEPTION 'anon should not read payslips';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'P2b anon refused OK';
END $t$;
RESET ROLE;

-- P3 staff details: validation, upsert, audit names the fields only.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $t$ DECLARE r jsonb; n int; BEGIN
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000f', 'Somewhere', DATE '1990-01-01');
  ASSERT r->>'error' = 'staff_not_found', 'no timesheet profile: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', repeat('a', 501), DATE '1990-01-01');
  ASSERT r->>'error' = 'invalid_address', 'long address: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', 'Manila', (now() AT TIME ZONE 'Asia/Tokyo')::date + 1);
  ASSERT r->>'error' = 'invalid_date_of_birth', 'future dob: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', 'Manila', DATE '1899-12-31');
  ASSERT r->>'error' = 'invalid_date_of_birth', 'pre-1900 dob: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '  12 Rizal St, Quezon City  ', NULL);
  ASSERT r->>'ok' = 'true' AND r->'changed' = '["address"]'::jsonb, 'address only: ' || r::text;
  ASSERT (SELECT address FROM public.staff_payroll_details WHERE user_id = '00000000-0000-0000-0000-00000000000c') = '12 Rizal St, Quezon City', 'trimmed';
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14');
  ASSERT r->'changed' = '["date_of_birth"]'::jsonb, 'dob only: ' || r::text;
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000c', '12 Rizal St, Quezon City', DATE '1995-03-14');
  ASSERT r->>'ok' = 'true' AND r->'changed' = '[]'::jsonb, 'no change: ' || r::text;
  SELECT count(*) INTO n FROM public.audit_logs WHERE entity_type = 'staff_payroll_details' AND entity_id = '00000000-0000-0000-0000-00000000000c';
  ASSERT n = 2, 'two audit rows (no row for the no-op save), got ' || n;
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_type = 'staff_payroll_details'
                      AND (coalesce(new_value_json::text, '') || coalesce(old_value_json::text, '')) ~ '(Rizal|1995)'), 'audit never holds the values';
  ASSERT (SELECT new_value_json->'changed_fields' FROM public.audit_logs WHERE entity_type = 'staff_payroll_details'
           ORDER BY created_at, (new_value_json->>'created') DESC LIMIT 1) = '["address"]'::jsonb, 'first audit names the field';
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-00000000000b', 'Pasig City', DATE '1992-07-01');
  ASSERT r->>'ok' = 'true', 'Brenda details: ' || r::text;
  RAISE NOTICE 'P3 staff details OK';
END $t$;

-- P4 finalize: month rules, details_missing, known keys only, snapshot copied server-side, totals, already_issued.
DO $t$ DECLARE r jsonb; p jsonb := (SELECT v FROM fx WHERE k = 'csr'); id uuid; BEGIN
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-05-01', p);
  ASSERT r->>'error' = 'invalid_month', 'before June 2026: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-15', p);
  ASSERT r->>'error' = 'invalid_month', 'not first of month: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c',
         (date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date) + interval '1 month')::date, p);
  ASSERT r->>'error' = 'invalid_month', 'future month: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000f', DATE '2026-09-01', p);
  ASSERT r->>'error' = 'staff_not_found', 'no profile: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', DATE '2026-09-01', (SELECT v FROM fx WHERE k = 'la'));
  ASSERT r->>'error' = 'details_missing', 'live admin without details: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-000000000005', DATE '2026-09-01', p);
  ASSERT r->>'error' = 'name_missing', 'no profiles row: ' || r::text;

  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', jsonb_set(p, '{total_php}', '16500'));
  ASSERT r->>'error' = 'invalid_totals', 'total must be the sum: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', jsonb_set(p, '{timesheet,net}', '13400'));
  ASSERT r->>'error' = 'invalid_totals', 'net must be gross + allowance: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', jsonb_set(p, '{timesheet,total_hours}', '-1'));
  ASSERT r->>'error' = 'invalid_figures' AND r->>'field' = 'total_hours', 'negative: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', jsonb_set(p, '{timesheet,total_hours}', '"1e3"'));
  ASSERT r->>'error' = 'invalid_figures', 'exponent text: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', jsonb_set(p, '{timesheet,days_worked}', '2.5'));
  ASSERT r->>'error' = 'invalid_figures' AND r->>'field' = 'days_worked', 'fractional days: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', p - 'commission');
  ASSERT r->>'error' = 'invalid_figures', 'missing commission: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', jsonb_set(p, '{commission,top_sales_tier}', '3'));
  ASSERT r->>'error' = 'invalid_figures', 'tier 3: ' || r::text;
  ASSERT NOT EXISTS (SELECT 1 FROM public.payslips), 'nothing written by a refusal';

  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', p);
  ASSERT r->>'ok' = 'true', 'finalize: ' || r::text;
  id := (r->'payslip'->>'id')::uuid;
  ASSERT r->'payslip'->>'staff_name' = 'Kaila Cruz', 'name from profiles, not the payload: ' || r::text;
  ASSERT r->'payslip'->>'job_title' = 'CSR' AND r->'payslip'->>'template_type' = 'csr', 'job + template copied';
  ASSERT r->'payslip'->>'address' = '12 Rizal St, Quezon City' AND r->'payslip'->>'date_of_birth' = '1995-03-14', 'details copied';
  ASSERT NOT (r->'payslip'->'timesheet' ? 'hack') AND NOT (r->'payslip'->'commission' ? 'evil'), 'unknown keys dropped';
  ASSERT (r->'payslip'->'commission'->>'earnings')::numeric = 2500.50, 'numeric string accepted';
  ASSERT (r->'payslip'->>'total_php')::numeric = 16500.50 AND r->'payslip'->>'status' = 'finalized', 'totals stored';
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', p);
  ASSERT r->>'error' = 'already_issued', 'second payslip for the month: ' || r::text;

  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000b', DATE '2026-09-01',
         (SELECT v FROM fx WHERE k = 'la'));
  ASSERT r->>'error' = 'invalid_figures', 'a CSR profile needs the CSR keys (Live Admin keys refused): ' || r::text;
  RAISE NOTICE 'P4 finalize OK';
END $t$;

-- P4b the Live Admin keys and a Live Admin payslip.
DO $t$ DECLARE r jsonb; p jsonb := (SELECT v FROM fx WHERE k = 'la'); BEGIN
  r := public.save_staff_payroll_details('00000000-0000-0000-0000-0000000000a1', 'Cebu City', DATE '1998-11-02');
  ASSERT r->>'ok' = 'true', 'jose details';
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', DATE '2026-09-01', jsonb_set(p, '{timesheet,net}', '6300'));
  ASSERT r->>'error' = 'invalid_totals', 'live admin net must be 500 x + 300 y: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-0000000000a1', DATE '2026-09-01', p);
  ASSERT r->>'ok' = 'true' AND (r->'payslip'->>'total_php')::numeric = 6200, 'live admin finalize: ' || r::text;
  ASSERT r->'payslip'->'commission'->'role_won' = 'null'::jsonb, 'no role';
  RAISE NOTICE 'P4b live admin OK';
END $t$;

-- P5 payment: validation, proof path + storage rules, php_per_jpy stored.
DO $t$ DECLARE r jsonb; id uuid; path text; today date := (now() AT TIME ZONE 'Asia/Tokyo')::date; BEGIN
  SELECT p.id INTO id FROM public.payslips p WHERE p.user_id = '00000000-0000-0000-0000-00000000000c' AND p.status = 'finalized';
  path := id::text || '/1730000000-remittance.jpg';
  r := public.record_payslip_payment(id, 0, 16500.5, today, path);
  ASSERT r->>'error' = 'invalid_jpy_sent', 'zero yen: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 0, today, path);
  ASSERT r->>'error' = 'invalid_php_received', 'zero pesos: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16500.555, today, path);
  ASSERT r->>'error' = 'invalid_php_received', 'three decimals: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, today + 1, path);
  ASSERT r->>'error' = 'invalid_paid_on', 'future date: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, DATE '2026-08-31', path);
  ASSERT r->>'error' = 'invalid_paid_on', 'before the pay month: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, today, '  ');
  ASSERT r->>'error' = 'proof_required', 'no proof: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, today, gen_random_uuid()::text || '/x.jpg');
  ASSERT r->>'error' = 'invalid_proof_path', 'another folder: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, today, id::text || '/../x.jpg');
  ASSERT r->>'error' = 'invalid_proof_path', 'dot-dot: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, today, id::text || '/');
  ASSERT r->>'error' = 'invalid_proof_path', 'no file name: ' || r::text;
  r := public.record_payslip_payment(id, 39287, 16400, today, path);
  ASSERT r->>'error' = 'proof_missing', 'not uploaded yet: ' || r::text;

  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', gen_random_uuid()::text || '/x.jpg');
    RAISE EXCEPTION 'upload into a folder that is not a payslip should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', id::text || '/');
    RAISE EXCEPTION 'upload without a file name should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', path);

  r := public.record_payslip_payment(id, 39287, 16400, today, path);
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'status' = 'paid', 'pay: ' || r::text;
  ASSERT (r->'payslip'->>'php_per_jpy')::numeric = round(16400::numeric / 39287, 6), 'actual rate stored: ' || r::text;
  ASSERT (r->'payslip'->>'php_per_jpy')::numeric = 0.417441, 'rate value: ' || r::text;
  ASSERT (r->'payslip'->>'total_php')::numeric = 16500.50, 'payslip total untouched by the payment';
  r := public.record_payslip_payment(id, 39287, 16400, today, path);
  ASSERT r->>'error' = 'not_finalized' AND r->>'status' = 'paid', 'pay twice: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', id::text || '/again.jpg');
    RAISE EXCEPTION 'upload onto a paid payslip should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  ASSERT (SELECT count(*) FROM storage.objects WHERE bucket_id = 'payslip-proofs') = 1, 'gate reads the proof';
  RAISE NOTICE 'P5 payment OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ DECLARE id uuid; BEGIN
  ASSERT (SELECT count(*) FROM public.payslips) = 0, 'csr reads no payslips (not even her own)';
  ASSERT (SELECT count(*) FROM public.staff_payroll_details) = 0, 'csr reads no details';
  ASSERT (SELECT count(*) FROM storage.objects WHERE bucket_id = 'payslip-proofs') = 0, 'csr reads no proofs';
  RAISE NOTICE 'P5b other staff see nothing OK';
END $t$;
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ DECLARE id uuid; BEGIN
  RESET ROLE;
  SELECT p.id INTO id FROM public.payslips p WHERE p.user_id = '00000000-0000-0000-0000-0000000000a1';
  SET ROLE authenticated;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', id::text || '/x.jpg');
    RAISE EXCEPTION 'csr upload should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'P5c csr cannot upload OK';
END $t$;
RESET ROLE;

-- P6 void, then re-issue.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; paid uuid; fin uuid; BEGIN
  SELECT id INTO paid FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-00000000000c' AND status = 'paid';
  SELECT id INTO fin FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-0000000000a1' AND status = 'finalized';
  r := public.void_payslip(paid, '  no ');
  ASSERT r->>'error' = 'reason_required', 'short reason: ' || r::text;
  r := public.void_payslip(paid, 'Hours corrected after finalize');
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'status' = 'void', 'void paid: ' || r::text;
  ASSERT (r->'payslip'->>'jpy_sent')::int = 39287, 'void keeps the payment record';
  r := public.void_payslip(paid, 'again please');
  ASSERT r->>'error' = 'already_void', 'void twice: ' || r::text;
  r := public.record_payslip_payment(paid, 1, 1, DATE '2026-10-01', paid::text || '/x.jpg');
  ASSERT r->>'error' = 'not_finalized', 'pay a void: ' || r::text;
  r := public.void_payslip(fin, 'Wrong month');
  ASSERT r->>'ok' = 'true', 'void finalized: ' || r::text;

  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01',
         jsonb_set(jsonb_set((SELECT v FROM fx WHERE k = 'csr'), '{commission,total}', '3500.5'), '{commission,top_sales_bonus}', '1000'));
  ASSERT r->>'error' = 'invalid_totals', 're-issue still checks totals: ' || r::text;
  r := public.finalize_payslip('00000000-0000-0000-0000-00000000000c', DATE '2026-09-01', (SELECT v FROM fx WHERE k = 'csr'));
  ASSERT r->>'ok' = 'true' AND (r->'payslip'->>'id')::uuid <> paid, 're-issue after void: ' || r::text;
  ASSERT (SELECT count(*) FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-00000000000c' AND pay_month = DATE '2026-09-01') = 2, 'void kept + new';

  r := public.get_payslip_book(DATE '2026-09-01');
  ASSERT jsonb_array_length(r->'payslips') = 3, 'book has every status (2 void + 1 finalized): ' || r::text;
  r := public.get_payslip_book(DATE '2026-09-20');
  ASSERT jsonb_array_length(r->'payslips') = 3 AND r->>'month' = '2026-09-01', 'any day reads its month';
  RAISE NOTICE 'P6 void + re-issue OK';
END $t$;
RESET ROLE;

-- P7 row locks hold even for a privileged writer.
DO $t$ DECLARE fin uuid; paid uuid; vd uuid; BEGIN
  SELECT id INTO fin FROM public.payslips WHERE status = 'finalized' AND user_id = '00000000-0000-0000-0000-00000000000c';
  SELECT id INTO vd FROM public.payslips WHERE status = 'void' AND user_id = '00000000-0000-0000-0000-00000000000c';
  BEGIN
    UPDATE public.payslips SET timesheet_net_php = 1, total_php = 1 + commission_php WHERE id = fin;
    RAISE EXCEPTION 'figure edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.payslips SET staff_name = 'Changed' WHERE id = fin;
    RAISE EXCEPTION 'snapshot edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.payslips SET status = 'paid', jpy_sent = 1, php_received = 1, php_per_jpy = 1, paid_on = current_date,
           proof_path = id::text || '/x', paid_by = gen_random_uuid(), paid_at = now(), address = 'elsewhere' WHERE id = fin;
    RAISE EXCEPTION 'payment that also edits the address should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.payslips SET status = 'void', voided_by = gen_random_uuid(), voided_at = now(), void_reason = 'abc',
           commission_php = 0, total_php = timesheet_net_php WHERE id = fin;
    RAISE EXCEPTION 'void that also edits figures should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.payslips SET status = 'finalized', voided_by = NULL, voided_at = NULL, void_reason = NULL WHERE id = vd;
    RAISE EXCEPTION 'un-void should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.payslips SET void_reason = 'rewritten' WHERE id = vd;
    RAISE EXCEPTION 'void edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    DELETE FROM public.payslips WHERE id = vd;
    RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    TRUNCATE public.payslips;
    RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.payslips (user_id, pay_month, status, staff_name, address, date_of_birth, template_type, timesheet,
                                 commission, timesheet_net_php, commission_php, total_php, finalized_by,
                                 jpy_sent, php_received, php_per_jpy, paid_on, proof_path, paid_by, paid_at)
    VALUES (gen_random_uuid(), DATE '2026-09-01', 'paid', 'x', 'x', DATE '1990-01-01', 'csr', '{}', '{}', 1, 0, 1,
            gen_random_uuid(), 1, 1, 1, current_date, 'x/y', gen_random_uuid(), now());
    RAISE EXCEPTION 'insert as paid should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT (SELECT count(*) FROM public.payslips) = 3, 'nothing changed';
  RAISE NOTICE 'P7 row locks OK';
END $t$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ BEGIN
  BEGIN
    UPDATE public.payslips SET status = 'void';
    RAISE EXCEPTION 'direct update should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    DELETE FROM public.staff_payroll_details;
    RAISE EXCEPTION 'direct delete should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.staff_payroll_details (user_id, address) VALUES (gen_random_uuid(), 'x');
    RAISE EXCEPTION 'direct insert should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'P7b direct writes refused OK';
END $t$;
RESET ROLE;

-- P8 audit rows: one per write, real uuids, no figures or personal details.
DO $t$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.audit_logs WHERE entity_type = 'payslip';
  ASSERT n = 6, 'payslip audit rows: 3 finalize (incl. the re-issue) + 1 payment + 2 void = 6, got ' || n;
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'payslip' AND action = 'finalize_payslip') = 3, 'finalize rows';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'payslip' AND action = 'record_payslip_payment') = 1, 'payment row';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'payslip' AND action = 'void_payslip') = 2, 'void rows';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.entity_type = 'payslip'
                      AND NOT EXISTS (SELECT 1 FROM public.payslips p WHERE p.id = a.entity_id)), 'entity_id is the payslip id';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_type IN ('payslip', 'staff_payroll_details')
                      AND (coalesce(new_value_json::text, '') || coalesce(old_value_json::text, ''))
                          ~ '(total_php|jpy_sent|php_received|16500|Rizal|Cebu|1995|1998)'), 'no figures or personal details in audit';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'staff_payroll_details') = 4, 'details rows: kaila x2, brenda, jose';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE performed_by_user_id IS NULL), 'actor always recorded';
  RAISE NOTICE 'P8 audit OK';
END $t$;

\echo 'ALL PAYSLIP TESTS PASSED'
