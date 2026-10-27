-- Phase 3: migration 20270205100000 (a 2nd proof file on the payment and on each cash advance), applied twice
-- on top of the Phase 2 database (after test_bond_payhistory.sql) and the pre5_* snapshots taken just before it.
\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set C '00000000-0000-0000-0000-00000000000c'

CREATE FUNCTION pg_temp.pl(b numeric, a numeric, capped numeric, ap numeric, cm numeric DEFAULT 0) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'timesheet', jsonb_build_object('days_worked', 20, 'total_hours', 160, 'daily_pay_sum', capped, 'basic_salary', b,
                                    'capped_gross', capped, 'monthly_allowance', a, 'forfeited_weeks', 0,
                                    'allowance_paid', ap, 'net', capped + ap),
    'commission', jsonb_build_object('role_won', NULL, 'earnings', cm, 'top_sales_tier', 0, 'top_sales_bonus', 0, 'total', cm),
    'timesheet_net_php', capped + ap, 'commission_php', cm, 'total_php', capped + ap + cm) $$;
GRANT EXECUTE ON FUNCTION pg_temp.pl(numeric, numeric, numeric, numeric, numeric) TO authenticated;
CREATE TEMP TABLE ctx (k text PRIMARY KEY, v text);
GRANT SELECT, INSERT, UPDATE ON ctx TO authenticated;
INSERT INTO ctx VALUES ('this_month', to_char(date_trunc('month', (now() AT TIME ZONE 'Asia/Tokyo')::date), 'YYYY-MM-DD')),
                       ('today', ((now() AT TIME ZONE 'Asia/Tokyo')::date)::text);

-- S1 shape; every existing row unchanged apart from the new empty column.
DO $t$ BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre5_payslips s JOIN public.payslips p ON p.id = s.id
                      WHERE (to_jsonb(p) - 'proof_path_2') <> s.row OR p.proof_path_2 IS NOT NULL), 'payslips unchanged';
  ASSERT (SELECT count(*) FROM public.pre5_payslips) = (SELECT count(*) FROM public.payslips), 'no payslip added or removed';
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre5_advances s JOIN public.payslip_cash_advances a ON a.id = s.id
                      WHERE (to_jsonb(a) - 'proof_path_2') <> s.row OR a.proof_path_2 IS NOT NULL), 'advances unchanged';
  ASSERT (SELECT n FROM public.pre5_audit) = (SELECT count(*) FROM public.audit_logs), 'the migration wrote no audit rows';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname = 'record_payslip_payment') = 2, '5- and 6-argument record';
  ASSERT to_regprocedure('public.attach_payslip_proof(uuid,text)') IS NOT NULL, 'attach_payslip_proof';
  ASSERT NOT has_function_privilege('anon', 'public.attach_payslip_proof(uuid,text)', 'EXECUTE'), 'anon cannot attach';
  ASSERT NOT has_function_privilege('anon', 'public.record_payslip_payment(uuid,integer,numeric,date,text,text)', 'EXECUTE'), 'anon cannot record';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage'
           AND policyname IN ('Payslip managers can upload payslip proofs', 'Payslip managers can upload cash advance proofs')) = 2, 'both upload policies';
  RAISE NOTICE 'S1 shape + existing rows unchanged OK';
END $t$;

-- Four finalized payslips to work with (from Phase 2).
CREATE TEMP TABLE fin AS
  SELECT id, row_number() OVER (ORDER BY pay_month, created_at) AS n FROM public.payslips WHERE status = 'finalized';
GRANT SELECT ON fin TO authenticated;
DO $t$ BEGIN ASSERT (SELECT count(*) FROM fin) >= 3, 'need 3 finalized payslips: ' || (SELECT count(*) FROM fin); END $t$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);

-- S2 recording a payment with two files.
DO $t$ DECLARE r jsonb; k uuid := (SELECT id FROM fin WHERE n = 1); p1 text; p2 text; b jsonb; BEGIN
  b := public.get_payslip_book((SELECT pay_month FROM public.payslips WHERE id = k));
  ASSERT (b->'features'->>'second_proof')::boolean, 'features.second_proof: ' || (b->'features')::text;
  p1 := k::text || '/1-bdo.jpg';
  p2 := k::text || '/2-bdo.jpg';
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', p1);
  r := public.record_payslip_payment(k, 35000, 14000, (SELECT pay_month FROM public.payslips WHERE id = k), p1, p1);
  ASSERT r->>'error' = 'invalid_proof_path', 'the same file twice: ' || r::text;
  r := public.record_payslip_payment(k, 35000, 14000, (SELECT pay_month FROM public.payslips WHERE id = k), p1, p2);
  ASSERT r->>'error' = 'proof_missing', '2nd not uploaded: ' || r::text;
  r := public.record_payslip_payment(k, 35000, 14000, (SELECT pay_month FROM public.payslips WHERE id = k), p1,
                                     gen_random_uuid()::text || '/x.jpg');
  ASSERT r->>'error' = 'invalid_proof_path', '2nd under another payslip: ' || r::text;
  ASSERT (SELECT status FROM public.payslips WHERE id = k) = 'finalized', 'refusals change nothing';
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', p2);
  r := public.record_payslip_payment(k, 35000, 14000, (SELECT pay_month FROM public.payslips WHERE id = k), p1, p2);
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'proof_path' = p1 AND r->'payslip'->>'proof_path_2' = p2
     AND r->'payslip'->>'status' = 'paid', 'two files: ' || r::text;
  r := public.attach_payslip_proof(k, p2);
  ASSERT r->>'error' = 'second_proof_attached', 'a 3rd file: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', k::text || '/3.jpg');
    RAISE EXCEPTION 'upload for a payslip with both files should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'S2 payment with two files OK';
END $t$;

-- S3 one file through the 5-argument call, the 2nd added later.
DO $t$ DECLARE r jsonb; k uuid := (SELECT id FROM fin WHERE n = 2); m date; p1 text; late text; BEGIN
  m := (SELECT pay_month FROM public.payslips WHERE id = k);
  p1 := k::text || '/remit.jpg';
  late := k::text || '/late-receipt.pdf';
  r := public.attach_payslip_proof(k, late);
  ASSERT r->>'error' = 'not_paid', 'before the payment: ' || r::text;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', p1);
  r := public.record_payslip_payment(k, 30000, 12000, m, p1);
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'proof_path_2' IS NULL, '5-argument call, one file: ' || r::text;
  r := public.attach_payslip_proof(k, p1);
  ASSERT r->>'error' = 'invalid_proof_path', 'the first file again: ' || r::text;
  r := public.attach_payslip_proof(k, late);
  ASSERT r->>'error' = 'proof_missing', 'not uploaded: ' || r::text;
  r := public.attach_payslip_proof(k, k::text || '/../x.pdf');
  ASSERT r->>'error' = 'invalid_proof_path', 'dot-dot: ' || r::text;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', late); -- paid with no 2nd file: allowed
  r := public.attach_payslip_proof(k, late);
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'proof_path_2' = late AND r->'payslip'->>'proof_path' = p1
     AND (r->'payslip'->>'php_received')::numeric = 12000, 'added later: ' || r::text;
  r := public.attach_payslip_proof(k, late);
  ASSERT r->>'error' = 'second_proof_attached', 'only once: ' || r::text;
  r := public.attach_payslip_proof(gen_random_uuid(), late);
  ASSERT r->>'error' = 'not_found', r::text;
  r := public.void_payslip(k, 'Wrong month');
  ASSERT r->>'ok' = 'true' AND r->'payslip'->>'proof_path_2' = late, 'a paid payslip with 2 files can still be voided: ' || r::text;
  r := public.attach_payslip_proof((SELECT id FROM fin WHERE n = 3), late);
  ASSERT r->>'error' = 'not_paid', 'finalized: ' || r::text;
  RAISE NOTICE 'S3 one file, then the 2nd later OK';
END $t$;

-- S4 the gate.
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.attach_payslip_proof((SELECT id FROM fin WHERE n = 1), 'x/y.jpg');
  ASSERT r->>'error' = 'permission_denied', r::text;
  r := public.record_payslip_payment((SELECT id FROM fin WHERE n = 3), 1, 1, DATE '2026-10-01', 'a', 'b');
  ASSERT r->>'error' = 'permission_denied', r::text;
  RAISE NOTICE 'S4 gate OK';
END $t$;
RESET ROLE;

-- S5 direct writes: a paid payslip only ever gets its 2nd file, once; nothing else.
DO $t$ DECLARE k uuid := (SELECT id FROM fin WHERE n = 1); BEGIN
  BEGIN UPDATE public.payslips SET proof_path_2 = k::text || '/other.jpg' WHERE id = k;
    RAISE EXCEPTION 'replacing the 2nd file should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET php_received = 1 WHERE id = k; RAISE EXCEPTION 'paid figures edit should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET proof_path_2 = NULL WHERE id = k; RAISE EXCEPTION 'removing the 2nd file should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE public.payslips SET proof_path_2 = gen_random_uuid()::text || '/x.jpg', proof_path = proof_path
         WHERE id = (SELECT id FROM fin WHERE n = 3);
    RAISE EXCEPTION 'a 2nd file on a finalized payslip should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'S5 direct writes refused OK';
END $t$;

-- S6 cash advances: slot 1, slot 2, never a 3rd; the snapshot carries both.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$
DECLARE r jsonb; d date := (SELECT v::date FROM ctx WHERE k = 'today'); m date := (SELECT v::date FROM ctx WHERE k = 'this_month');
        u uuid := '00000000-0000-0000-0000-0000000000d2'; a1 uuid; snap jsonb;
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.payslips WHERE user_id = u AND pay_month = m AND status <> 'void'), 'Mae has no payslip this month';
  r := public.add_cash_advance(u, m, d, 1000, 'Fare');
  ASSERT r->>'ok' = 'true', r::text;
  a1 := (r->'advance'->>'id')::uuid;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a1::text || '/1-gcash.png');
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/1-gcash.png');
  ASSERT r->>'ok' = 'true' AND r->'advance'->>'proof_path_2' IS NULL, 'slot 1: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/1-gcash.png');
  ASSERT r->>'error' = 'invalid_proof_path', 'the first file again: ' || r::text;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a1::text || '/2-receipt.pdf'); -- a slot is free
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/2-receipt.pdf');
  ASSERT r->>'ok' = 'true' AND r->'advance'->>'proof_path' = 'advances/' || a1::text || '/1-gcash.png'
     AND r->'advance'->>'proof_path_2' = 'advances/' || a1::text || '/2-receipt.pdf', 'slot 2: ' || r::text;
  r := public.attach_cash_advance_proof(a1, 'advances/' || a1::text || '/2-receipt.pdf');
  ASSERT r->>'error' = 'proof_already_attached', 'a 3rd: ' || r::text;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('payslip-proofs', 'advances/' || a1::text || '/3.png');
    RAISE EXCEPTION 'upload for an advance with both proofs should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  r := public.finalize_payslip(u, m, pg_temp.pl(10000, 2000, 7000, 2000), false);
  ASSERT r->>'ok' = 'true', 'finalize: ' || r::text;
  snap := (SELECT x FROM jsonb_array_elements(r->'payslip'->'cash_advances') x WHERE x->>'id' = a1::text);
  ASSERT snap->>'proof_path' = 'advances/' || a1::text || '/1-gcash.png'
     AND snap->>'proof_path_2' = 'advances/' || a1::text || '/2-receipt.pdf', 'snapshot carries both: ' || snap::text;
  RAISE NOTICE 'S6 cash advance proofs (two, never three) + snapshot OK';
END $t$;
RESET ROLE;

DO $t$ DECLARE a uuid := (SELECT id FROM public.payslip_cash_advances WHERE note = 'Fare'); BEGIN
  BEGIN UPDATE public.payslip_cash_advances SET proof_path_2 = 'advances/' || a::text || '/z.jpg' WHERE id = a;
    RAISE EXCEPTION 'replacing an advance''s 2nd proof should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'S6b advance 2nd proof frozen OK';
END $t$;

-- S7 audit: one row per write, the slot named.
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE action = 'attach_payslip_proof') = 1, 'one attach_payslip_proof row';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE action = 'attach_cash_advance_proof' AND new_value_json->>'slot' = '2') = 1, 'slot 2 row';
  ASSERT (SELECT new_value_json ? 'proof_path_2' FROM public.audit_logs WHERE action = 'record_payslip_payment'
           ORDER BY created_at DESC, id DESC LIMIT 1), 'record names the 2nd file field';
  ASSERT NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE performed_by_user_id IS NULL), 'actor always recorded';
  RAISE NOTICE 'S7 audit OK';
END $t$;

\echo 'ALL SECOND PROOF TESTS PASSED'
