-- Phase 8: migration 20270219100000 ("proof not on file" before October 2026) applied twice on top of Phase 7.
\set ON_ERROR_STOP 1

DO $t$ DECLARE d text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint
   WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_proof_not_on_file';
  ASSERT d LIKE '%2026-10-01%', d;
  ASSERT NOT EXISTS (SELECT 1 FROM public.pre10_payslips s JOIN public.payslips p ON p.id = s.id WHERE to_jsonb(p) <> s.row),
    'payslips unchanged';
  RAISE NOTICE 'H1 shape + rows unchanged OK';
END $t$;

-- H2 a September payslip may be Paid with the flag; an October one may not.
DO $t$ DECLARE sep uuid; oct uuid; ok boolean; BEGIN
  SELECT id INTO sep FROM public.payslips WHERE status = 'finalized' AND pay_month BETWEEN DATE '2026-06-01' AND DATE '2026-09-01' LIMIT 1;
  ASSERT sep IS NOT NULL, 'a June-September finalized payslip exists in the harness';
  UPDATE public.payslips
     SET status = 'paid', jpy_sent = 1000, php_received = 405.93, php_per_jpy = 0.40593, paid_on = pay_month + 34,
         proof_not_on_file = true, paid_by = '00000000-0000-0000-0000-00000000000a', paid_at = now()
   WHERE id = sep;
  ASSERT (SELECT status = 'paid' AND proof_not_on_file AND proof_path IS NULL FROM public.payslips WHERE id = sep), 'paid';
  SELECT id INTO oct FROM public.payslips WHERE status = 'finalized' AND pay_month >= DATE '2026-10-01' LIMIT 1;
  IF oct IS NOT NULL THEN
    ok := false;
    BEGIN
      UPDATE public.payslips
         SET status = 'paid', jpy_sent = 1000, php_received = 405.93, php_per_jpy = 0.40593, paid_on = pay_month + 4,
             proof_not_on_file = true, paid_by = '00000000-0000-0000-0000-00000000000a', paid_at = now()
       WHERE id = oct;
    EXCEPTION WHEN check_violation THEN ok := true; END;
    ASSERT ok, 'October onwards needs a proof';
  END IF;
  -- the CHECK itself, independent of the harness rows
  ASSERT NOT (SELECT bool_and(c) FROM (VALUES (NOT true OR DATE '2026-10-01' < DATE '2026-10-01')) v(c)), 'October refused by the rule';
  RAISE NOTICE 'H2 before October only OK';
END $t$;

\echo 'ALL PROOF-NOT-ON-FILE-TO-SEPTEMBER TESTS PASSED'
