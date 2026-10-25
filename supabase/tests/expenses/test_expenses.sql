\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- T1/T2 shape after the migration (applied twice by the runner).
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM public.expense_categories) = 28, 'expected 28 categories';
  ASSERT (SELECT count(DISTINCT group_key) FROM public.expense_categories) = 8, 'expected 8 groups';
  ASSERT (SELECT count(*) FROM public.role_permissions WHERE permission_key IN ('manage_expenses','approve_expenses')) = 10, 'expected 10 permission rows';
  ASSERT (SELECT count(*) FROM public.role_permissions WHERE permission_key IN ('manage_expenses','approve_expenses') AND is_allowed) = 2, 'only admin allowed';
  ASSERT (SELECT public FROM storage.buckets WHERE id = 'expense-receipts') = false, 'bucket must be private';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname='storage' AND policyname LIKE '%expense receipts') = 2, 'two storage policies';
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename IN ('expenses','expense_vendors','expense_categories') AND cmd <> 'SELECT') = 0, 'no write policies';
  RAISE NOTICE 'T1-T2 shape OK';
END $t$;

-- T3 finance user has no expense rights.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_expense_book(current_date);
  ASSERT r->>'error' = 'permission_denied', 'finance get: ' || r::text;
  r := public.upsert_expense('{"expense_date":"2026-10-20","category_id":"00000000-0000-0000-0000-000000000000","description":"x","currency":"JPY","amount":"1"}');
  ASSERT r->>'error' = 'permission_denied', 'finance upsert: ' || r::text;
  ASSERT (SELECT count(*) FROM public.expense_categories) = 0, 'finance must not read categories';
  BEGIN
    INSERT INTO public.expenses (expense_date, category_id, description, currency, amount, amount_jpy)
    VALUES (current_date, gen_random_uuid(), 'x', 'JPY', 1, 1);
    RAISE EXCEPTION 'direct insert should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'T3 finance denied OK';
END $t$;

-- T4-T6 admin creates drafts.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; cat uuid; e1 uuid; e2 uuid; v uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'photoroom';
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',cat,'description','Photoroom Oct',
         'currency','JPY','amount','15000','payment_method','card'));
  ASSERT r->>'ok' = 'true', 'jpy create: ' || r::text;
  ASSERT (r->'expense'->>'amount_jpy')::numeric = 15000 AND r->'expense'->>'fx_php_per_jpy' IS NULL AND r->'expense'->>'status' = 'draft', 'jpy values: ' || r::text;
  e1 := (r->'expense'->>'id')::uuid;
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_id = e1 AND action = 'upsert_expense') = 1, 'audit on create';

  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-21','category_id',cat,'description','Payroll test PHP',
         'currency','PHP','amount','10000','new_vendor_name','Vercel'));
  ASSERT r->>'ok' = 'true', 'php create: ' || r::text;
  ASSERT (r->'expense'->>'amount_jpy')::numeric = 23810, 'PHP 10000 / 0.42 must be 23810: ' || r::text;
  ASSERT (r->'expense'->>'fx_php_per_jpy')::numeric = 0.42, 'rate stored';
  v := (r->'expense'->>'vendor_id')::uuid;
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_id = v AND action = 'create_expense_vendor') = 1, 'vendor audit';

  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-22','category_id',cat,'description','reuse vendor',
         'currency','JPY','amount','500','new_vendor_name','  vercel '));
  ASSERT (r->'expense'->>'vendor_id')::uuid = v, 'vendor reused case-insensitively: ' || r::text;
  ASSERT (SELECT count(*) FROM public.expense_vendors) = 1, 'one vendor only';

  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',cat,'description','x','currency','JPY','amount','100.5'));
  ASSERT r->>'error' = 'invalid_amount', 'jpy decimal: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',gen_random_uuid(),'description','x','currency','JPY','amount','1'));
  ASSERT r->>'error' = 'invalid_category', 'bad category: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date','2019-12-31','category_id',cat,'description','x','currency','JPY','amount','1'));
  ASSERT r->>'error' = 'invalid_date', 'old date: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',cat,'description','x','currency','USD','amount','1'));
  ASSERT r->>'error' = 'invalid_currency', 'usd: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date','not-a-date','category_id',cat,'description','x','currency','JPY','amount','1'));
  ASSERT r->>'error' = 'invalid_input', 'bad date text: ' || r::text;
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',cat,'description','','currency','JPY','amount','1'));
  ASSERT r->>'error' = 'invalid_description', 'empty description: ' || r::text;
  RAISE NOTICE 'T4-T6 create/convert/validate OK';
END $t$;

-- T7 staff with manage override: can create, cannot approve.
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; cat uuid; e uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'bonus';
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-23','category_id',cat,'description','staff entry','currency','JPY','amount','1000'));
  ASSERT r->>'ok' = 'true', 'staff create: ' || r::text;
  e := (r->'expense'->>'id')::uuid;
  r := public.approve_expense(e);
  ASSERT r->>'error' = 'permission_denied', 'staff approve: ' || r::text;
  r := public.void_expense(e, 'nope');
  ASSERT r->>'error' = 'permission_denied', 'staff void: ' || r::text;
  ASSERT (SELECT can_manage FROM (SELECT (public.get_expense_book(current_date)->>'can_manage')::boolean AS can_manage) q), 'staff can_manage';
  RAISE NOTICE 'T7 override OK';
END $t$;

-- T8-T10 receipts, approval lock, rate freeze, void.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; e uuid; BEGIN
  SELECT id INTO e FROM public.expenses WHERE description = 'Payroll test PHP';
  r := public.attach_expense_receipt(e, gen_random_uuid()::text || '/r.pdf');
  ASSERT r->>'error' = 'invalid_receipt_path', 'foreign path: ' || r::text;
  r := public.attach_expense_receipt(e, e::text || '/../x.pdf');
  ASSERT r->>'error' = 'invalid_receipt_path', 'dotdot path: ' || r::text;
  r := public.attach_expense_receipt(e, e::text || '/1729830000-invoice.pdf');
  ASSERT r->>'ok' = 'true', 'attach: ' || r::text;

  RESET ROLE;
  UPDATE public.system_settings SET value = '"0.40"' WHERE key = 'php_jpy_rate';
  SET ROLE authenticated;
  r := public.approve_expense(e);
  ASSERT r->>'ok' = 'true', 'approve: ' || r::text;
  ASSERT (r->'expense'->>'amount_jpy')::numeric = 25000 AND (r->'expense'->>'fx_php_per_jpy')::numeric = 0.40,
         'approval re-reads the rate (10000/0.40 = 25000): ' || r::text;

  RESET ROLE;
  UPDATE public.system_settings SET value = '"0.42"' WHERE key = 'php_jpy_rate';
  SET ROLE authenticated;
  ASSERT (SELECT amount_jpy FROM public.expenses WHERE id = e) = 25000, 'approved amount frozen after rate change';

  r := public.upsert_expense(jsonb_build_object('id', e, 'expense_date','2026-10-21','category_id',
         (SELECT category_id FROM public.expenses WHERE id = e),'description','edit','currency','PHP','amount','1'));
  ASSERT r->>'error' = 'not_draft', 'edit approved: ' || r::text;
  r := public.attach_expense_receipt(e, e::text || '/other.pdf');
  ASSERT r->>'error' = 'not_draft', 'receipt on approved: ' || r::text;
  r := public.approve_expense(e);
  ASSERT r->>'error' = 'not_draft', 'double approve: ' || r::text;
  r := public.void_expense(e, '  ');
  ASSERT r->>'error' = 'reason_required', 'void no reason: ' || r::text;
  r := public.void_expense(e, 'Entered twice');
  ASSERT r->>'ok' = 'true' AND r->'expense'->>'status' = 'void', 'void: ' || r::text;
  r := public.void_expense(e, 'again');
  ASSERT r->>'error' = 'already_void', 'void twice: ' || r::text;
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_id = e) = 4, 'create + attach + approve + void audited';
  RAISE NOTICE 'T8-T10 lock/freeze/void OK';
END $t$;

-- T11 the trigger protects rows even from a privileged writer.
RESET ROLE;
DO $t$ DECLARE e uuid; d uuid; BEGIN
  SELECT id INTO e FROM public.expenses WHERE description = 'Photoroom Oct';
  UPDATE public.expenses SET status = 'approved', approved_by = '00000000-0000-0000-0000-00000000000a', approved_at = now() WHERE id = e;
  BEGIN
    UPDATE public.expenses SET amount = 1 WHERE id = e;
    RAISE EXCEPTION 'approved amount change should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    DELETE FROM public.expenses WHERE id = e;
    RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT id INTO d FROM public.expenses WHERE description = 'Payroll test PHP';
  BEGIN
    UPDATE public.expenses SET notes = 'x' WHERE id = d;
    RAISE EXCEPTION 'void change should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'T11 trigger guard OK';
END $t$;

-- T12 one booking per source reference.
DO $t$ DECLARE cat uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'payroll';
  INSERT INTO public.expenses (expense_date, category_id, description, currency, amount, amount_jpy, source, source_ref)
  VALUES ('2026-10-31', cat, 'Payroll Oct', 'PHP', 50000, 0, 'payroll', '2026-10');
  BEGIN
    INSERT INTO public.expenses (expense_date, category_id, description, currency, amount, amount_jpy, source, source_ref)
    VALUES ('2026-10-31', cat, 'Payroll Oct again', 'PHP', 50000, 0, 'payroll', '2026-10');
    RAISE EXCEPTION 'duplicate source_ref should fail';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  ASSERT (SELECT amount_jpy FROM public.expenses WHERE source_ref = '2026-10') = 119048, 'service insert converted (50000/0.42)';
  RAISE NOTICE 'T12 source_ref unique OK';
END $t$;

-- T13 month book.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_expense_book('2026-10-15');
  ASSERT r->>'month' = '2026-10-01', 'month start: ' || (r->>'month');
  ASSERT jsonb_array_length(r->'expenses') = 5, 'october rows: ' || jsonb_array_length(r->'expenses');
  ASSERT jsonb_array_length(r->'categories') = 28 AND jsonb_array_length(r->'vendors') = 1, 'lists';
  ASSERT (r->'expenses'->0->>'category_name') IS NOT NULL, 'joined names';
  ASSERT (r->>'php_jpy_rate')::numeric = 0.42 AND (r->>'can_approve')::boolean, 'rate + rights';
  r := public.get_expense_book('2026-09-01');
  ASSERT jsonb_array_length(r->'expenses') = 0, 'september empty';
  RAISE NOTICE 'T13 month book OK';
END $t$;

-- T14 storage policies.
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ BEGIN
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('expense-receipts', 'x/y.pdf');
    RAISE EXCEPTION 'finance upload should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'T14a finance upload denied OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE d uuid; a uuid; BEGIN
  SELECT id INTO d FROM public.expenses WHERE description = 'reuse vendor';
  SELECT id INTO a FROM public.expenses WHERE description = 'Photoroom Oct';
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('expense-receipts', 'x/y.pdf');
    RAISE EXCEPTION 'upload to a non-expense folder should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('expense-receipts', a::text || '/r.pdf');
    RAISE EXCEPTION 'upload to an approved expense should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('expense-receipts', d::text || '/');
    RAISE EXCEPTION 'upload with no file name should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO storage.objects (bucket_id, name) VALUES ('expense-receipts', d::text || '/1-receipt.pdf');
  RAISE NOTICE 'T14b2 upload path rules OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM storage.objects WHERE bucket_id = 'expense-receipts') = 0, 'finance cannot read receipts';
  RAISE NOTICE 'T14b finance read denied OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM storage.objects WHERE bucket_id = 'expense-receipts') = 1, 'admin reads receipts';
  RAISE NOTICE 'T14c admin read OK';
END $t$;

-- T16 review fixes: manual payroll refused, direct writes revoked, rate_not_set, draft void without rate.
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; cat uuid; bon uuid; e uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'payroll';
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',cat,'description','manual payroll','currency','PHP','amount','1000'));
  ASSERT r->>'error' = 'category_booked_automatically', 'manual payroll: ' || r::text;
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'commission';
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',cat,'description','manual commission','currency','PHP','amount','1000'));
  ASSERT r->>'error' = 'category_booked_automatically', 'manual commission: ' || r::text;
  SELECT id INTO bon FROM public.expense_categories WHERE system_key = 'bonus';
  r := public.upsert_expense(jsonb_build_object('expense_date','2026-10-20','category_id',bon,'description','PHP bonus','currency','PHP','amount','2000'));
  ASSERT r->>'ok' = 'true', 'bonus stays manual: ' || r::text;
  e := (r->'expense'->>'id')::uuid;
  BEGIN
    UPDATE public.expenses SET description = 'hack' WHERE id = e;
    RAISE EXCEPTION 'authenticated direct update should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET ROLE;
  UPDATE public.system_settings SET value = '""' WHERE key = 'php_jpy_rate';
  SET ROLE authenticated;
  r := public.approve_expense(e);
  ASSERT r->>'error' = 'rate_not_set', 'approve without rate: ' || r::text;
  r := public.void_expense(e, 'wrong entry');
  ASSERT r->>'ok' = 'true', 'void PHP draft without rate: ' || r::text;
  ASSERT (r->'expense'->>'amount_jpy')::numeric = 4762, 'void keeps figures (2000/0.42): ' || r::text;
  RESET ROLE;
  UPDATE public.system_settings SET value = '"0.42"' WHERE key = 'php_jpy_rate';
  SET ROLE authenticated;
  RAISE NOTICE 'T16 review fixes OK';
END $t$;

RESET ROLE;
DO $t$ DECLARE cat uuid; e uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE system_key = 'bonus';
  BEGIN
    INSERT INTO public.expenses (expense_date, category_id, description, currency, amount, amount_jpy, status, approved_by, approved_at)
    VALUES ('2026-10-01', cat, 'born approved', 'JPY', 1, 1, 'approved', gen_random_uuid(), now());
    RAISE EXCEPTION 'insert as approved should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    TRUNCATE public.expenses;
    RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT id INTO e FROM public.expenses WHERE description = 'reuse vendor';
  BEGIN
    UPDATE public.expenses SET created_by = gen_random_uuid() WHERE id = e;
    RAISE EXCEPTION 'created_by change should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT NOT has_table_privilege('authenticated', 'public.expenses', 'TRUNCATE'), 'authenticated truncate revoked';
  ASSERT NOT has_table_privilege('anon', 'public.expenses', 'SELECT'), 'anon select revoked';
  RAISE NOTICE 'T17 insert-draft / truncate / creation lock OK';
END $t$;

-- T15 anon cannot call the book.
RESET ROLE;
SET ROLE anon;
DO $t$ BEGIN
  BEGIN
    PERFORM public.get_expense_book(current_date);
    RAISE EXCEPTION 'anon should not execute';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'T15 anon denied OK';
END $t$;
RESET ROLE;
SELECT 'ALL EXPENSE TESTS PASSED' AS result;
