\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set F '00000000-0000-0000-0000-00000000000f'
\set S '00000000-0000-0000-0000-000000000005'

-- Phase 4: emailed bills. Runs after stubs + Phases 1, 2, 2b, 3, 4 migrations.
-- The service role has no JWT sub (auth.uid() IS NULL) — that is how the RPCs recognise it.

-- Signed-in users cannot call the service-role RPCs; finance cannot read the list.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; BEGIN
  BEGIN
    r := public.expenses_email_record('{"gmail_message_id":"m1","status":"skipped"}');
    RAISE EXCEPTION 'admin should not be able to execute the service RPC (grant revoked)';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  r := public.get_email_bills(30);
  ASSERT r->>'ok' IS NULL AND jsonb_array_length(r->'messages') = 0 AND r->>'enabled' = 'false', 'admin reads an empty list, feature off: ' || r::text;
  RAISE NOTICE 'E1 grants OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'F', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.get_email_bills(30); ASSERT r->>'error' = 'permission_denied', 'finance denied';
  r := public.email_bill_dismiss('x'); ASSERT r->>'error' = 'permission_denied', 'finance cannot dismiss';
  r := public.set_email_bills_enabled(true); ASSERT r->>'error' = 'permission_denied', 'finance cannot enable';
  RAISE NOTICE 'E2 permissions OK';
END $t$;

-- The function (service role, uid NULL) records messages and makes drafts.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
DO $t$ DECLARE r jsonb; cat uuid; e uuid; BEGIN
  r := public.expenses_email_context();
  ASSERT r->>'enabled' = 'false' AND r->>'mailbox' = 'sales@chajewelsjp.com' AND jsonb_array_length(r->'categories') > 20, 'context: ' || left(r::text, 200);
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'categories') c WHERE c->>'name' LIKE 'Staff payroll%'), 'payroll never offered as an email category';

  r := public.expenses_email_run('{"phase":"start","trigger":"cron"}');
  ASSERT r->>'ok' = 'true' AND r->>'run_id' IS NOT NULL, 'run start: ' || r::text;

  r := public.expenses_email_record(jsonb_build_object('gmail_message_id', 'msg-news', 'thread_id', 't1', 'mailbox', 'sales@chajewelsjp.com',
         'from_email', 'news@example.com', 'subject', 'Weekly newsletter', 'received_at', '2026-10-25T01:00:00Z', 'status', 'skipped',
         'confidence', '0.95', 'extracted', '{"is_bill":false,"why":"Newsletter"}'::jsonb));
  ASSERT r->>'ok' = 'true', 'record skipped: ' || r::text;
  r := public.expenses_email_record(jsonb_build_object('gmail_message_id', 'msg-usd', 'mailbox', 'sales@chajewelsjp.com', 'from_email', 'billing@vercel.com',
         'subject', 'Your receipt', 'received_at', '2026-10-25T02:00:00Z', 'status', 'needs_review', 'confidence', '0.7',
         'extracted', '{"is_bill":true,"currency":"OTHER","amount":20,"why":"Billed in another currency"}'::jsonb,
         'attachments', '[{"name":"receipt.pdf","mime":"application/pdf","size":1234,"path":"email/msg-usd/receipt.pdf"}]'::jsonb));
  ASSERT (SELECT jsonb_array_length(attachments) FROM public.expense_email_messages WHERE gmail_message_id = 'msg-usd') = 1, 'attachments stored';
  ASSERT r->>'ok' = 'true', 'record needs_review: ' || r::text;
  r := public.expenses_email_record(jsonb_build_object('gmail_message_id', 'msg-bad', 'status', 'nonsense'));
  ASSERT r->>'error' = 'invalid_status', 'bad status refused';

  SELECT id INTO cat FROM public.expense_categories WHERE name = 'Photoroom';
  e := gen_random_uuid();
  r := public.expenses_create_email_draft(jsonb_build_object('gmail_message_id', 'msg-pr', 'id', e, 'expense_date', '2026-10-24', 'category_id', cat,
         'vendor_name', 'Photoroom', 'description', 'Photoroom Pro October', 'currency', 'JPY', 'amount', '1800', 'payment_method', 'card',
         'receipt_path', e::text || '/1-receipt.pdf', 'details', '{"from":"billing@photoroom.com","confidence":0.9}'::jsonb));
  ASSERT r->>'ok' = 'true', 'email draft: ' || r::text;
  ASSERT r->'expense'->>'status' = 'draft' AND r->'expense'->>'source' = 'email' AND r->'expense'->>'source_ref' = 'msg-pr', 'draft shape';
  ASSERT (r->'expense'->>'id')::uuid = e AND r->'expense'->>'receipt_path' = e::text || '/1-receipt.pdf', 'pre-generated id + receipt path kept';
  ASSERT (SELECT count(*) FROM public.expense_vendors WHERE lower(name) = 'photoroom') = 1, 'vendor created once';
  ASSERT r->'expense'->'details'->>'kind' = 'email_bill' AND r->'expense'->'details'->>'from' = 'billing@photoroom.com', 'details merged';
  r := public.expenses_email_record(jsonb_build_object('gmail_message_id', 'msg-pr', 'mailbox', 'sales@chajewelsjp.com', 'from_email', 'billing@photoroom.com',
         'subject', 'Your Photoroom receipt', 'received_at', '2026-10-24T09:00:00Z', 'status', 'drafted', 'confidence', '0.9', 'expense_id', e));
  ASSERT r->>'ok' = 'true', 'record drafted';
  r := public.expenses_create_email_draft(jsonb_build_object('gmail_message_id', 'msg-pr', 'expense_date', '2026-10-24', 'category_id', cat,
         'description', 'dup', 'currency', 'JPY', 'amount', '1800'));
  ASSERT r->>'error' = 'already_generated', 'one draft per message';
  r := public.expenses_email_record(jsonb_build_object('gmail_message_id', 'msg-pr', 'mailbox', 'x', 'status', 'skipped'));
  ASSERT r->>'unchanged' = 'true', 'a drafted message is never downgraded by a re-run';

  r := public.expenses_create_email_draft(jsonb_build_object('gmail_message_id', 'msg-nocat', 'expense_date', '2026-10-24', 'category_id', NULL,
         'description', 'Unknown vendor bill', 'currency', 'PHP', 'amount', '1500.50'));
  ASSERT r->>'ok' = 'true', 'draft without category: ' || r::text;
  ASSERT (SELECT c.system_key FROM public.expense_categories c WHERE c.id = (r->'expense'->>'category_id')::uuid) = 'uncategorised', 'falls back to the holding category';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(public.expenses_email_context()->'categories') c WHERE c->>'name' LIKE 'Needs a category%'), 'holding category never offered to the reader';
  ASSERT (r->'expense'->>'amount_jpy')::numeric = round(1500.50 / 0.42), 'PHP converted by the Phase 1 trigger';
  r := public.expenses_create_email_draft(jsonb_build_object('gmail_message_id', 'msg-badpath', 'id', gen_random_uuid(), 'expense_date', '2026-10-24',
         'description', 'x', 'currency', 'JPY', 'amount', '10', 'receipt_path', 'email/other/receipt.pdf'));
  ASSERT r->>'error' = 'invalid_receipt_path', 'receipt must live under the draft id';
  r := public.expenses_create_email_draft(jsonb_build_object('gmail_message_id', 'msg-payroll', 'expense_date', '2026-10-24',
         'category_id', (SELECT id FROM public.expense_categories WHERE system_key = 'payroll'), 'description', 'x', 'currency', 'JPY', 'amount', '10'));
  ASSERT r->>'error' = 'category_booked_automatically', 'payroll refused';

  r := public.expenses_email_run(jsonb_build_object('phase', 'finish', 'run_id', (SELECT id FROM public.expense_email_runs LIMIT 1), 'looked_at', 4, 'drafted', 2, 'skipped', 1, 'needs_review', 1));
  ASSERT r->>'ok' = 'true' AND (r->>'housekept')::int = 0, 'run finish: ' || r::text;
  ASSERT (SELECT finished_at IS NOT NULL AND drafted = 2 FROM public.expense_email_runs LIMIT 1), 'run row updated';
  RAISE NOTICE 'E3 service recording OK';
END $t$;

-- Matching to an open recurring draft.
DO $t$ DECLARE r jsonb; cat uuid; bill uuid; d uuid; BEGIN
  SELECT id INTO cat FROM public.expense_categories WHERE name = 'Lovable, Firebase, Vercel, Claude and other dev tools';
  INSERT INTO public.expense_recurring_bills (name, category_id, description, currency, amount, frequency, due_day, starts_on, next_due_on, paid_from)
  VALUES ('Lovable', cat, 'Lovable Pro monthly', 'JPY', 3600, 'monthly', 20, '2026-09-01', '2026-10-20', '1102') RETURNING id INTO bill;
  r := public.expenses_generate_recurring('2026-10-21', NULL);
  SELECT id INTO d FROM public.expenses WHERE source = 'recurring' AND source_ref = bill::text || ':2026-10-20';
  ASSERT d IS NOT NULL, 'recurring draft exists';
  r := public.expenses_email_match_recurring('Lovable', NULL, 3600, 'JPY', '2026-10-22');
  ASSERT (r->'match'->>'id')::uuid = d, 'matched by vendor name + amount + date window: ' || r::text;
  r := public.expenses_email_match_recurring('Somebody', cat, 3620, 'JPY', '2026-10-25');
  ASSERT (r->'match'->>'id')::uuid = d, 'matched by category within 1%';
  r := public.expenses_email_match_recurring('Lovable', NULL, 4000, 'JPY', '2026-10-22');
  ASSERT r->'match' = 'null'::jsonb, 'amount off by more than 1% does not match';
  r := public.expenses_email_match_recurring('Lovable', NULL, 3600, 'JPY', '2026-11-15');
  ASSERT r->'match' = 'null'::jsonb, 'outside the 7-day window does not match';
  r := public.expenses_email_attach_to_draft(d, d::text || '/1-lovable.pdf', 3600, '{"gmail_message_id":"msg-lov","subject":"Lovable receipt"}');
  ASSERT r->>'ok' = 'true' AND r->'expense'->>'receipt_path' = d::text || '/1-lovable.pdf', 'receipt attached to the recurring draft: ' || r::text;
  ASSERT r->'expense'->'details'->'email'->>'gmail_message_id' = 'msg-lov', 'email noted on the draft';
  r := public.expenses_email_attach_to_draft(d, 'email/msg-lov/x.pdf', NULL, '{}');
  ASSERT r->>'error' = 'invalid_receipt_path', 'path must be under the draft';
  RAISE NOTICE 'E4 matching OK';
END $t$;

-- Owner: Make expense from a needs_review row; dismiss; enable.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ DECLARE r jsonb; cat uuid; BEGIN
  r := public.get_email_bills(30);
  ASSERT jsonb_array_length(r->'messages') = 3, 'three messages recorded (news, usd, photoroom; nocat was created without a record row): ' || jsonb_array_length(r->'messages');
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'messages') m WHERE m->>'status' = 'drafted' AND m->>'expense_status' = 'draft') = 1, 'drafted row joins its expense';
  ASSERT r->'last_run'->>'drafted' = '2', 'last run shown';
  SELECT id INTO cat FROM public.expense_categories WHERE name = 'Lovable, Firebase, Vercel, Claude and other dev tools';
  r := public.email_bill_make_expense('msg-usd', jsonb_build_object('expense_date', '2026-10-25', 'category_id', cat, 'vendor_name', 'Vercel',
         'description', 'Vercel Pro October (USD 20)', 'currency', 'JPY', 'amount', '3100', 'payment_method', 'card', 'paid_from', '1102'));
  ASSERT r->>'ok' = 'true', 'make expense: ' || r::text;
  ASSERT r->'expense'->>'source' = 'email' AND r->'expense'->>'source_ref' = 'msg-usd' AND r->'expense'->>'paid_from' = '1102', 'made by hand still an email expense';
  ASSERT jsonb_array_length(r->'attachments') = 1, 'stored attachments returned for the client to copy';
  ASSERT (SELECT status FROM public.expense_email_messages WHERE gmail_message_id = 'msg-usd') = 'drafted', 'message now drafted';
  r := public.email_bill_make_expense('msg-usd', '{}'); ASSERT r->>'error' = 'already_generated', 'not twice';
  r := public.email_bill_dismiss('msg-news'); ASSERT r->>'ok' = 'true', 'dismiss';
  ASSERT (SELECT status FROM public.expense_email_messages WHERE gmail_message_id = 'msg-news') = 'dismissed', 'dismissed';
  r := public.email_bill_dismiss('msg-pr'); ASSERT r->>'error' = 'already_generated', 'cannot dismiss a drafted one';
  BEGIN
    r := public.approve_expense((SELECT id FROM public.expenses WHERE source_ref = 'msg-nocat'));
    RAISE EXCEPTION 'an uncategorised email draft must not be approvable';
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT (SELECT status FROM public.expenses WHERE source_ref = 'msg-nocat') = 'draft', 'still a draft';
  r := public.upsert_expense(jsonb_build_object('id', (SELECT id FROM public.expenses WHERE source_ref = 'msg-nocat'), 'expense_date', '2026-10-24', 'category_id', cat,
         'description', 'Unknown vendor bill', 'currency', 'PHP', 'amount', '1500.50', 'payment_method', 'other'));
  ASSERT r->>'ok' = 'true', 'owner moves it to a real category: ' || r::text;
  ASSERT r->'expense'->>'source' = 'email' AND r->'expense'->>'source_ref' = 'msg-nocat', 'edit keeps the email source';
  r := public.approve_expense((SELECT id FROM public.expenses WHERE source_ref = 'msg-nocat')); ASSERT r->>'ok' = 'true', 'now approvable';
  r := public.set_email_bills_enabled(true); ASSERT r->>'ok' = 'true', 'enable';
  r := public.get_email_bills(30); ASSERT r->>'enabled' = 'true', 'enabled shown';
  RAISE NOTICE 'E5 owner actions OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'S', false);
DO $t$ DECLARE r jsonb; BEGIN
  r := public.email_bill_dismiss('msg-usd'); ASSERT r->>'error' = 'already_generated' OR r->>'error' IS NULL, 'manage-only staff can act (here: already drafted)';
  r := public.set_email_bills_enabled(false); ASSERT r->>'error' = 'permission_denied', 'enable is admin only';
  RAISE NOTICE 'E6 staff scope OK';
END $t$;

-- Housekeeping deletes only old skipped rows.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
DO $t$ DECLARE r jsonb; BEGIN
  UPDATE public.expense_email_messages SET created_at = now() - interval '100 days';
  r := public.expenses_email_run(jsonb_build_object('phase', 'finish', 'run_id', gen_random_uuid()));
  ASSERT (r->>'housekept')::int = 0, 'no skipped rows left (news was dismissed): ' || r::text;
  PERFORM public.expenses_email_record(jsonb_build_object('gmail_message_id', 'msg-old', 'mailbox', 'x', 'status', 'skipped'));
  UPDATE public.expense_email_messages SET created_at = now() - interval '100 days' WHERE gmail_message_id = 'msg-old';
  r := public.expenses_email_run(jsonb_build_object('phase', 'finish', 'run_id', gen_random_uuid()));
  ASSERT (r->>'housekept')::int = 1, 'old skipped row removed';
  ASSERT (SELECT count(*) FROM public.expense_email_messages WHERE status = 'drafted') = 2, 'drafted rows are kept forever';
  RAISE NOTICE 'E7 housekeeping OK';
END $t$;
SELECT 'ALL EMAIL BILL TESTS PASSED' AS result;
