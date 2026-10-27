-- Phase 4: migration 20270206100000 (bonuses) applied twice on top of the Phase 3 database and the pre6_*
-- snapshots taken just before it.
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

-- Three new CSRs (superuser setup): Bea (no hire date), Gia (hired September 2026), Lia (advances vs bonuses).
INSERT INTO public.profiles (user_id, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'Bea Cruz'),
  ('00000000-0000-0000-0000-0000000000e2', 'Gia Reyes'),
  ('00000000-0000-0000-0000-0000000000e3', 'Lia Santos');
INSERT INTO public.timesheet_profiles (user_id, template_type, job_title, basic_salary, allowance, active) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'csr', 'CSR', 10000, 2000, true),
  ('00000000-0000-0000-0000-0000000000e2', 'csr', 'CSR', 10000, 2000, true),
  ('00000000-0000-0000-0000-0000000000e3', 'csr', 'CSR', 10000, 2000, true);

-- B1 shape; every existing row unchanged apart from the new empty columns.
DO $t$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre6_payslips s JOIN public.payslips p ON p.id = s.id
                      WHERE (to_jsonb(p) - ARRAY['bonuses', 'bonus_php']) <> s.row OR p.bonuses <> '[]'::jsonb OR p.bonus_php <> 0),
    'payslips unchanged, no bonuses';
  ASSERT (SELECT count(*) FROM public.pre6_payslips) = (SELECT count(*) FROM public.payslips), 'no payslip added or removed';
  ASSERT (SELECT n FROM public.pre6_audit) = (SELECT count(*) FROM public.audit_logs), 'the migration wrote no audit rows';
  ASSERT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_total')
         LIKE '%bonus_php%', 'the total rule includes bonuses';
  ASSERT (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_total') = 1, 'one total rule';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslip_bonuses', 'INSERT'), 'no insert';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslip_bonuses', 'UPDATE'), 'no update';
  ASSERT NOT has_table_privilege('authenticated', 'public.payslip_bonuses', 'DELETE'), 'no delete';
  ASSERT NOT has_table_privilege('anon', 'public.payslip_bonuses', 'SELECT'), 'anon cannot read';
  ASSERT NOT has_function_privilege('anon', 'public.add_payslip_bonus(uuid,date,date,text,numeric,text)', 'EXECUTE'), 'anon cannot add';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'Payslip managers can upload bonus proofs') = 1, 'storage policy';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payslip_bonuses' AND cmd <> 'SELECT') = 0, 'no write policies';
  RAISE NOTICE 'B1 shape + existing rows unchanged OK';
END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- B2 add: every refusal, then two bonuses and a voided one for Bea in September.
DO $t$ DECLARE r jsonb; d date := (SELECT v::date FROM ctx WHERE k = 'today');
  bea uuid := '00000000-0000-0000-0000-0000000000e1'; BEGIN
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'christmas', 1000, 'x');
  ASSERT r->>'error' = 'invalid_category', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'performance', 0, 'x');
  ASSERT r->>'error' = 'invalid_amount', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'performance', 10.005, 'x');
  ASSERT r->>'error' = 'invalid_amount', '3 decimals: ' || r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', d + 1, 'performance', 100, 'x');
  ASSERT r->>'error' = 'invalid_bonus_date', 'future: ' || r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-03-31', 'performance', 100, 'x');
  ASSERT r->>'error' = 'invalid_bonus_date', 'before April: ' || r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'performance', 100, '   ');
  ASSERT r->>'error' = 'bonus_note_required', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'performance', 100, repeat('x', 201));
  ASSERT r->>'error' = 'note_too_long', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-03-01', DATE '2026-09-30', 'performance', 100, 'x');
  ASSERT r->>'error' = 'invalid_month', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-15', DATE '2026-09-30', 'performance', 100, 'x');
  ASSERT r->>'error' = 'invalid_month', 'not a 1st: ' || r::text;
  r := public.add_payslip_bonus(gen_random_uuid(), DATE '2026-09-01', DATE '2026-09-30', 'performance', 100, 'x');
  ASSERT r->>'error' = 'staff_not_found', r::text;

  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'performance', 1500, ' Q3 targets ');
  ASSERT r->>'ok' = 'true' AND r->'bonus'->>'note' = 'Q3 targets' AND r->'bonus'->>'category' = 'performance', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-20', 'holiday', 500.25, 'Fiesta');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-20', 'holiday', 999, 'Typed twice');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.void_payslip_bonus((r->'bonus'->>'id')::uuid, 'no');
  ASSERT r->>'error' = 'reason_required', r::text;
  r := public.void_payslip_bonus((SELECT id FROM public.payslip_bonuses WHERE note = 'Typed twice'), 'Entered twice');
  ASSERT r->>'ok' = 'true' AND r->'bonus'->>'status' = 'void', r::text;
  r := public.void_payslip_bonus((SELECT id FROM public.payslip_bonuses WHERE note = 'Typed twice'), 'Again');
  ASSERT r->>'error' = 'bonus_already_void', r::text;
  ASSERT (SELECT jsonb_array_length(public.get_payslip_book(DATE '2026-09-01')->'bonuses')) = 3, 'book lists all statuses';
  ASSERT (public.get_payslip_book(DATE '2026-09-01')->'features'->>'bonuses')::boolean, 'features.bonuses';
  RAISE NOTICE 'B2 add / refusals / void OK';
END $t$;

-- B3 proofs: slot 1, slot 2, never 3; path and storage rules.
DO $t$ DECLARE r jsonb; b1 uuid := (SELECT id FROM public.payslip_bonuses WHERE note = 'Q3 targets');
  bv uuid := (SELECT id FROM public.payslip_bonuses WHERE note = 'Typed twice'); BEGIN
  r := public.attach_payslip_bonus_proof(b1, 'bonuses/' || b1::text || '/memo.pdf');
  ASSERT r->>'error' = 'proof_missing', r::text;
  r := public.attach_payslip_bonus_proof(b1, 'advances/' || b1::text || '/memo.pdf');
  ASSERT r->>'error' = 'invalid_proof_path', 'wrong folder: ' || r::text;
  r := public.attach_payslip_bonus_proof(b1, 'bonuses/' || b1::text || '/a/b.pdf');
  ASSERT r->>'error' = 'invalid_proof_path', 'sub-folder: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'bonuses/' || gen_random_uuid()::text || '/x.pdf');
    RAISE EXCEPTION 'upload for an unknown bonus should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'bonuses/' || bv::text || '/x.pdf');
    RAISE EXCEPTION 'upload for a void bonus should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'bonuses/' || b1::text || '/1-memo.pdf');
  r := public.attach_payslip_bonus_proof(b1, 'bonuses/' || b1::text || '/1-memo.pdf');
  ASSERT r->>'ok' = 'true' AND r->'bonus'->>'proof_path_2' IS NULL, 'slot 1: ' || r::text;
  r := public.attach_payslip_bonus_proof(b1, 'bonuses/' || b1::text || '/1-memo.pdf');
  ASSERT r->>'error' = 'invalid_proof_path', 'the 1st file again: ' || r::text;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'bonuses/' || b1::text || '/2-kpi.png');
  r := public.attach_payslip_bonus_proof(b1, 'bonuses/' || b1::text || '/2-kpi.png');
  ASSERT r->>'ok' = 'true' AND r->'bonus'->>'proof_path_2' = 'bonuses/' || b1::text || '/2-kpi.png', 'slot 2: ' || r::text;
  r := public.attach_payslip_bonus_proof(b1, 'bonuses/' || b1::text || '/2-kpi.png');
  ASSERT r->>'error' = 'bonus_proofs_full', 'a 3rd: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'bonuses/' || b1::text || '/3.png');
    RAISE EXCEPTION 'upload for a bonus with both proofs should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  r := public.attach_payslip_bonus_proof(bv, 'bonuses/' || bv::text || '/x.pdf');
  ASSERT r->>'error' = 'bonus_void', r::text;
  RAISE NOTICE 'B3 bonus proofs OK';
END $t$;

-- B4 the gate.
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.add_payslip_bonus('00000000-0000-0000-0000-0000000000e1', DATE '2026-09-01', DATE '2026-09-30', 'performance', 1, 'x');
  ASSERT r->>'error' = 'permission_denied', r::text;
  r := public.void_payslip_bonus((SELECT id FROM public.payslip_bonuses LIMIT 1), 'abc');
  ASSERT r->>'error' = 'permission_denied', r::text;
  ASSERT NOT EXISTS (SELECT 1 FROM public.payslip_bonuses), 'RLS: a CSR reads no bonuses';
  RAISE NOTICE 'B4 gate OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- B5 finalize: bonuses are earnings; advances and net pay follow; the snapshot and links; the month locks.
DO $t$ DECLARE r jsonb; d date := (SELECT v::date FROM ctx WHERE k = 'today'); p jsonb;
  bea uuid := '00000000-0000-0000-0000-0000000000e1'; BEGIN
  r := public.save_staff_payroll_details(bea, 'Taguig', DATE '1999-01-01', 'CJ-201', NULL);
  ASSERT r->>'ok' = 'true', r::text;
  r := public.add_cash_advance(bea, DATE '2026-09-01', d, 1000, 'Rent');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip(bea, DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000, 2000, 250), false);
  ASSERT r->>'ok' = 'true', 'finalize: ' || r::text;
  p := r->'payslip';
  ASSERT (p->>'timesheet_net_php')::numeric = 9000 AND (p->>'commission_php')::numeric = 250, 'parts unchanged: ' || p::text;
  ASSERT (p->>'bonus_php')::numeric = 2000.25 AND (p->>'total_php')::numeric = 11250.25, 'bonuses added to earnings: ' || p::text;
  ASSERT (p->>'net_pay_php')::numeric = 10250.25 AND (p->>'amount_due_php')::numeric = 10250.25, 'net = earnings - advances: ' || p::text;
  ASSERT jsonb_array_length(p->'bonuses') = 2, 'void bonus left out';
  ASSERT p->'bonuses'->0->>'note' = 'Fiesta' AND p->'bonuses'->1->>'note' = 'Q3 targets', 'ordered by date';
  ASSERT p->'bonuses'->1->>'proof_path_2' LIKE 'bonuses/%/2-kpi.png', 'snapshot carries both proofs';
  ASSERT (SELECT count(*) FROM public.payslip_bonuses WHERE payslip_id = (p->>'id')::uuid) = 2, 'active bonuses linked';
  ASSERT (SELECT payslip_id FROM public.payslip_bonuses WHERE note = 'Typed twice') IS NULL, 'void bonus not linked';
  r := public.add_payslip_bonus(bea, DATE '2026-09-01', DATE '2026-09-30', 'holiday', 100, 'Late');
  ASSERT r->>'error' = 'bonus_month_finalized', r::text;
  r := public.void_payslip_bonus((SELECT id FROM public.payslip_bonuses WHERE note = 'Fiesta'), 'Too late');
  ASSERT r->>'error' = 'bonus_month_finalized', r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name)
    VALUES ('payslip-proofs', 'bonuses/' || (SELECT id FROM public.payslip_bonuses WHERE note = 'Fiesta')::text || '/x.pdf');
    RAISE EXCEPTION 'upload after finalize should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- void + re-issue relinks the same bonuses.
  r := public.void_payslip((p->>'id')::uuid, 'Hours corrected');
  ASSERT r->>'ok' = 'true', r::text;
  r := public.finalize_payslip(bea, DATE '2026-09-01', pg_temp.pl(10000, 2000, 7100, 2000, 250), false);
  ASSERT (r->'payslip'->>'bonus_php')::numeric = 2000.25 AND (r->'payslip'->>'total_php')::numeric = 11350.25, 're-issue: ' || r::text;
  ASSERT (SELECT count(*) FROM public.payslip_bonuses WHERE payslip_id = (r->'payslip'->>'id')::uuid) = 2, 'relinked';
  RAISE NOTICE 'B5 finalize with bonuses, lock, void + re-issue OK';
END $t$;

-- B6 cash bond includes bonuses; B7 advances may use the bonuses.
DO $t$ DECLARE r jsonb; d date := (SELECT v::date FROM ctx WHERE k = 'today');
  gia uuid := '00000000-0000-0000-0000-0000000000e2'; lia uuid := '00000000-0000-0000-0000-0000000000e3'; BEGIN
  r := public.save_staff_payroll_details(gia, 'Pasig', DATE '2000-05-05', 'CJ-202', DATE '2026-09-07');
  r := public.add_payslip_bonus(gia, DATE '2026-09-01', DATE '2026-09-30', 'performance', 1000.01, 'Launch week');
  r := public.finalize_payslip(gia, DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT (r->'payslip'->>'total_php')::numeric = 10000.01, 'earnings: ' || r::text;
  ASSERT (r->'payslip'->>'cash_bond_held_php')::numeric = 5000 AND (r->'payslip'->>'amount_due_php')::numeric = 5000.01,
    'bond = floor(half of net incl. bonuses), odd centavo paid: ' || r::text;

  r := public.save_staff_payroll_details(lia, 'Makati', DATE '2001-06-06', 'CJ-203', NULL);
  r := public.add_cash_advance(lia, DATE '2026-09-01', d, 9500, 'Hospital');
  r := public.finalize_payslip(lia, DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT r->>'error' = 'advance_exceeds_pay', 'without a bonus: ' || r::text;
  r := public.add_payslip_bonus(lia, DATE '2026-09-01', DATE '2026-09-30', 'holiday', 1000, 'Fiesta');
  r := public.finalize_payslip(lia, DATE '2026-09-01', pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT r->>'ok' = 'true' AND (r->'payslip'->>'net_pay_php')::numeric = 500, 'the bonus covers the advance: ' || r::text;
  RAISE NOTICE 'B6 cash bond with bonuses + B7 advances vs bonuses OK';
END $t$;
RESET ROLE;

-- B8 direct writes refused.
DO $t$ DECLARE k uuid := (SELECT id FROM public.payslips WHERE user_id = '00000000-0000-0000-0000-0000000000e1' AND status = 'finalized');
  b uuid := (SELECT id FROM public.payslip_bonuses WHERE note = 'Q3 targets'); BEGIN
  BEGIN UPDATE public.payslips SET bonus_php = 1, total_php = total_php - bonus_php + 1 WHERE id = k;
    RAISE EXCEPTION 'bonus edit on a payslip should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET bonuses = '[]'::jsonb WHERE id = k; RAISE EXCEPTION 'snapshot edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslip_bonuses SET amount_php = 1 WHERE id = b; RAISE EXCEPTION 'amount edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslip_bonuses SET proof_path_2 = NULL WHERE id = b; RAISE EXCEPTION 'proof removal should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM public.payslip_bonuses WHERE id = b; RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN TRUNCATE public.payslip_bonuses; RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO public.payslip_bonuses (user_id, pay_month, bonus_date, category, amount_php, note, created_by, proof_path)
        VALUES (gen_random_uuid(), DATE '2026-09-01', DATE '2026-09-01', 'holiday', 1, 'x', gen_random_uuid(), 'bonuses/x/y');
    RAISE EXCEPTION 'insert with a proof should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'B8 direct writes refused OK';
END $t$;

-- B9 audit: one row per write; no amounts or notes.
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE action = 'add_payslip_bonus') = 5, 'add rows: ' || (SELECT count(*) FROM public.audit_logs WHERE action = 'add_payslip_bonus');
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE action = 'attach_payslip_bonus_proof') = 2, 'attach rows';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE action = 'void_payslip_bonus') = 1, 'void rows';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_type = 'payslip_bonus'
                      AND (coalesce(new_value_json::text, '') || coalesce(old_value_json::text, ''))
                          ~ '(1500|500\.25|1000\.01|Q3|Fiesta|Typed|Launch|memo|kpi|amount)'), 'no amounts, notes or file names';
  ASSERT (SELECT (new_value_json->>'bonuses')::int FROM public.audit_logs a JOIN public.payslips p ON p.id = a.entity_id
           WHERE a.action = 'finalize_payslip' AND p.user_id = '00000000-0000-0000-0000-0000000000e1' AND p.status = 'finalized') = 2,
    'finalize audit counts the bonuses';
  RAISE NOTICE 'B9 audit OK';
END $t$;

\echo 'ALL BONUS TESTS PASSED'
