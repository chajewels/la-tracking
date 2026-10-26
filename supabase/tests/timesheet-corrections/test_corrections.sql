\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'
\set C '00000000-0000-0000-0000-00000000000c'
\set L '00000000-0000-0000-0000-0000000000a1'
\set F '00000000-0000-0000-0000-00000000000f'

-- Kaila (C) already has 2026-10-19 with a legacy note, and nothing on 2026-10-20.
INSERT INTO public.timesheet_entries (user_id, work_date, am_in, am_out, pm_in, pm_out, note) VALUES
  (:'C', DATE '2026-10-19', '2026-10-19 09:00+08', '2026-10-19 12:00+08', '2026-10-19 13:00+08', '2026-10-19 18:00+08', 'legacy note');

-- T1 shape (the runner applied the migration twice).
DO $t$ BEGIN
  ASSERT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'timesheet_corrections') = 1, 'one read policy';
  ASSERT (SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = 'timesheet_corrections') = 'SELECT', 'read only';
  ASSERT NOT has_table_privilege('authenticated', 'public.timesheet_corrections', 'INSERT'), 'no insert';
  ASSERT NOT has_table_privilege('authenticated', 'public.timesheet_corrections', 'UPDATE'), 'no update';
  ASSERT NOT has_table_privilege('authenticated', 'public.timesheet_corrections', 'DELETE'), 'no delete';
  ASSERT NOT has_table_privilege('authenticated', 'public.timesheet_corrections', 'TRUNCATE'), 'no truncate';
  ASSERT NOT has_table_privilege('anon', 'public.timesheet_corrections', 'SELECT'), 'anon cannot read';
  ASSERT (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_timesheet_entries_lock_corrected') = 1, 'one lock trigger';
  ASSERT (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.timesheet_corrections'::regclass AND NOT tgisinternal) = 2, 'two guard triggers';
  RAISE NOTICE 'T1 shape OK';
END $t$;

-- T2 the gate: admin yes, can_view_all yes, other staff / finance / live admin no, no identity no, anon no.
SET ROLE authenticated;
DO $t$
DECLARE r jsonb; u text;
BEGIN
  FOREACH u IN ARRAY ARRAY['00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000f',
                           '00000000-0000-0000-0000-0000000000a1', ''] LOOP
    PERFORM set_config('request.jwt.claim.sub', u, false);
    r := public.correct_timesheet_day('00000000-0000-0000-0000-00000000000c', DATE '2026-10-20',
           NULL, NULL, NULL, NULL, 'Forgot to punch');
    ASSERT r->>'error' = 'permission_denied', 'denied for "' || u || '": ' || r::text;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  ASSERT public.can_correct_timesheet('00000000-0000-0000-0000-00000000000a'), 'admin gate';
  ASSERT NOT public.can_correct_timesheet('00000000-0000-0000-0000-00000000000b'), 'never answers for someone else';
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
  ASSERT public.can_correct_timesheet('00000000-0000-0000-0000-00000000000b'), 'can_view_all gate';
  ASSERT NOT EXISTS (SELECT 1 FROM public.timesheet_corrections), 'nothing written';
  RAISE NOTICE 'T2 gate OK (admin, can_view_all yes; csr, finance, live admin, no identity no)';
END $t$;
RESET ROLE;
SET ROLE anon;
DO $t$ BEGIN
  BEGIN
    PERFORM public.correct_timesheet_day('00000000-0000-0000-0000-00000000000c', DATE '2026-10-20', NULL, NULL, NULL, NULL, 'xxx');
    RAISE EXCEPTION 'anon should not call it';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM count(*) FROM public.timesheet_corrections;
    RAISE EXCEPTION 'anon should not read';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'T2b anon refused OK';
END $t$;
RESET ROLE;

-- T3-T6 validation (as Brenda).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $t$ DECLARE r jsonb; k uuid := '00000000-0000-0000-0000-00000000000c'; BEGIN
  r := public.correct_timesheet_day('00000000-0000-0000-0000-00000000000f', DATE '2026-10-20', NULL, NULL, NULL, NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'staff_not_found', 'no timesheet profile: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', NULL, NULL, NULL, NULL, '  ab  ');
  ASSERT r->>'error' = 'comment_required', 'short comment: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', NULL, NULL, NULL, NULL, NULL);
  ASSERT r->>'error' = 'comment_required', 'no comment: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', NULL, NULL, NULL, NULL, repeat('x', 501));
  ASSERT r->>'error' = 'comment_required', 'long comment: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-05-31', NULL, NULL, NULL, NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_date', 'before June 2026: ' || r::text;
  r := public.correct_timesheet_day(k, (now() AT TIME ZONE 'Asia/Manila')::date + 1, NULL, NULL, NULL, NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_date', 'tomorrow: ' || r::text;
  RAISE NOTICE 'T3-T4 comment and date rules OK';

  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-19 09:00+08', NULL, NULL, NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_punch' AND r->>'field' = 'am_in', 'am_in on another day: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 09:00+08', NULL, NULL, '2026-10-21 07:00+08', 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_punch' AND r->>'field' = 'pm_out', 'pm_out next day after 06:00: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 09:00+08', '2026-10-21 01:00+08', NULL, NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_punch' AND r->>'field' = 'am_out', 'only pm_out may cross midnight: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 09:00+08', '2026-10-20 08:00+08', NULL, NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_order' AND r->>'field' = 'am_out', 'am_out before am_in: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 09:00+08', NULL, '2026-10-20 08:30+08', NULL, 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_order' AND r->>'field' = 'pm_in', 'order skips blanks: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 13:00+08', NULL, NULL, '2026-10-20 12:00+08', 'Forgot to punch');
  ASSERT r->>'error' = 'invalid_order', 'pm_out before am_in (not midnight): ' || r::text;
  ASSERT NOT EXISTS (SELECT 1 FROM public.timesheet_corrections), 'refusals write nothing';
  RAISE NOTICE 'T5-T6 punch and order rules OK';
END $t$;

-- T7 first correction on a day with no entry creates it; history + audit.
DO $t$ DECLARE r jsonb; k uuid := '00000000-0000-0000-0000-00000000000c'; cid uuid; BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM public.timesheet_entries WHERE user_id = k AND work_date = DATE '2026-10-20'), 'no entry yet';
  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 09:00+08', '2026-10-20 12:00+08',
         '2026-10-20 13:00+08', '2026-10-20 00:00+08', '  Forgot to punch out; confirmed on chat  ');
  ASSERT r->>'ok' = 'true', 'midnight pm_out on the work date is end of day: ' || r::text;
  cid := (r->'correction'->>'id')::uuid;
  ASSERT (r->'entry'->>'pm_out')::timestamptz = '2026-10-20 00:00+08', 'entry returned';
  ASSERT (SELECT count(*) FROM public.timesheet_entries WHERE user_id = k AND work_date = DATE '2026-10-20') = 1, 'entry created';
  ASSERT r->'correction'->>'comment' = 'Forgot to punch out; confirmed on chat', 'comment trimmed';
  ASSERT r->'correction'->'old_punches' = '{"am_in":null,"am_out":null,"pm_in":null,"pm_out":null}'::jsonb, 'old all null';
  ASSERT (r->'correction'->'new_punches'->>'am_in')::timestamptz = '2026-10-20 09:00+08', 'new punches stored';
  ASSERT (r->'correction'->>'corrected_by')::uuid = '00000000-0000-0000-0000-00000000000b', 'corrector recorded';
  ASSERT (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'timesheet_correction' AND entity_id = cid) = 1, 'one audit row';
  ASSERT (SELECT new_value_json FROM public.audit_logs WHERE entity_id = cid)
         = jsonb_build_object('user_id', k, 'work_date', '2026-10-20'), 'audit has user_id + work_date only';
  ASSERT (SELECT old_value_json FROM public.audit_logs WHERE entity_id = cid) IS NULL, 'no old values in audit';

  r := public.correct_timesheet_day(k, DATE '2026-10-20', '2026-10-20 09:00+08', NULL, NULL, '2026-10-21 02:00+08', 'Late shift ended at 2am');
  ASSERT r->>'ok' = 'true', 'next-day pm_out before 06:00: ' || r::text;

  r := public.correct_timesheet_day(k, DATE '2026-10-19', '2026-10-19 10:00+08', '2026-10-19 12:00+08',
         '2026-10-19 13:00+08', '2026-10-19 18:00+08', 'Started at 10, not 9');
  ASSERT r->>'ok' = 'true', 'second day: ' || r::text;
  ASSERT (r->'correction'->'old_punches'->>'am_in')::timestamptz = '2026-10-19 09:00+08', 'old punches read from the entry';
  RESET ROLE;
  ASSERT (SELECT note FROM public.timesheet_entries WHERE user_id = k AND work_date = DATE '2026-10-19') = 'legacy note', 'note untouched';
  SET ROLE authenticated;

  r := public.correct_timesheet_day('00000000-0000-0000-0000-0000000000a1', DATE '2026-10-20', '2026-10-20 00:30+09', NULL, NULL, NULL, 'Tokyo timezone');
  ASSERT r->>'ok' = 'true', 'punch checked in the PROFILE timezone (Tokyo 00:30 = Manila 23:30 the day before): ' || r::text;
  r := public.correct_timesheet_day('00000000-0000-0000-0000-00000000000b', DATE '2026-10-20', '2026-10-20 09:00+08', NULL, NULL, '2026-10-20 18:00+08', 'Own day');
  ASSERT r->>'ok' = 'true', 'Brenda corrects her own day: ' || r::text;
  ASSERT (SELECT count(*) FROM public.timesheet_corrections) = 5, 'five history rows';
  RAISE NOTICE 'T7 create, history, audit OK';
END $t$;
RESET ROLE;

-- T8 the history is permanent even for a privileged role.
DO $t$ BEGIN
  BEGIN UPDATE public.timesheet_corrections SET comment = 'rewritten'; RAISE EXCEPTION 'update should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM public.timesheet_corrections; RAISE EXCEPTION 'delete should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN TRUNCATE public.timesheet_corrections; RAISE EXCEPTION 'truncate should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  ASSERT (SELECT count(*) FROM public.timesheet_corrections) = 5, 'history intact';
  RAISE NOTICE 'T8 history locked OK';
END $t$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ BEGIN
  BEGIN INSERT INTO public.timesheet_corrections (user_id, work_date, old_punches, new_punches, comment, corrected_by)
        VALUES (gen_random_uuid(), current_date, '{}', '{}', 'abc', gen_random_uuid());
        RAISE EXCEPTION 'direct insert should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'T8b direct insert refused OK';
END $t$;

-- T9 the day lock.
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ BEGIN
  BEGIN
    UPDATE public.timesheet_entries SET pm_out = '2026-10-20 20:00+08' WHERE work_date = DATE '2026-10-20';
    RAISE EXCEPTION 'staff update of a corrected day should fail';
  EXCEPTION WHEN check_violation THEN
    ASSERT SQLERRM = 'day_locked', 'message is day_locked: ' || SQLERRM;
  END;
  BEGIN
    INSERT INTO public.timesheet_entries (user_id, work_date, am_in) VALUES (auth.uid(), DATE '2026-10-20', '2026-10-20 08:00+08')
    ON CONFLICT (user_id, work_date) DO UPDATE SET am_in = EXCLUDED.am_in;
    RAISE EXCEPTION 'staff upsert of a corrected day should fail';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO public.timesheet_entries (user_id, work_date, am_in) VALUES (auth.uid(), DATE '2026-10-21', '2026-10-21 09:00+08')
  ON CONFLICT (user_id, work_date) DO UPDATE SET am_in = EXCLUDED.am_in;
  UPDATE public.timesheet_entries SET pm_out = '2026-10-21 18:00+08' WHERE work_date = DATE '2026-10-21';
  ASSERT (SELECT pm_out FROM public.timesheet_entries WHERE work_date = DATE '2026-10-21') = '2026-10-21 18:00+08', 'uncorrected day still writable';
  RAISE NOTICE 'T9 staff locked out of corrected days only OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'A', false);
DO $t$ BEGIN
  UPDATE public.timesheet_entries SET pm_out = '2026-10-20 19:00+08'
   WHERE user_id = '00000000-0000-0000-0000-00000000000c' AND work_date = DATE '2026-10-20';
  ASSERT (SELECT pm_out FROM public.timesheet_entries WHERE user_id = '00000000-0000-0000-0000-00000000000c'
           AND work_date = DATE '2026-10-20') = '2026-10-20 19:00+08', 'admin can still write a corrected day';
  RAISE NOTICE 'T9b admin allowed OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $t$ BEGIN
  UPDATE public.timesheet_entries SET pm_out = '2026-10-20 19:30+08' WHERE user_id = auth.uid() AND work_date = DATE '2026-10-20';
  ASSERT (SELECT pm_out FROM public.timesheet_entries WHERE user_id = auth.uid() AND work_date = DATE '2026-10-20')
         = '2026-10-20 19:30+08', 'can_view_all can still write her own corrected day';
  RAISE NOTICE 'T9c can_view_all allowed OK';
END $t$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
DO $t$ BEGIN
  UPDATE public.timesheet_entries SET note = 'service touch'
   WHERE user_id = '00000000-0000-0000-0000-00000000000c' AND work_date = DATE '2026-10-20';
  ASSERT (SELECT note FROM public.timesheet_entries WHERE user_id = '00000000-0000-0000-0000-00000000000c'
           AND work_date = DATE '2026-10-20') = 'service touch', 'service path (auth.uid() null) allowed';
  RAISE NOTICE 'T9d service allowed OK';
END $t$;

-- T10 who reads which corrections.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'C', false);
DO $t$ DECLARE r jsonb; BEGIN
  ASSERT (SELECT count(*) FROM public.timesheet_corrections) = 3, 'Kaila reads only her three';
  ASSERT NOT EXISTS (SELECT 1 FROM public.timesheet_corrections WHERE user_id <> auth.uid()), 'own rows only';
  r := public.get_timesheet_corrections(DATE '2026-10-01');
  ASSERT r->>'ok' = 'true' AND (r->>'can_correct')::boolean = false, 'book: ' || r::text;
  ASSERT jsonb_array_length(r->'corrections') = 3, 'RPC returns own only: ' || r::text;
  ASSERT r->'corrections'->0->>'corrected_by_name' = 'Brendalyn Bumagat', 'corrector name';
  ASSERT (r->'corrections'->0->>'work_date') = '2026-10-19', 'ordered by day';
  ASSERT (SELECT count(*) FROM jsonb_array_elements(r->'corrections') e WHERE e->>'work_date' = '2026-10-20') = 2, 'two on the 20th';
  ASSERT (SELECT e->>'comment' FROM jsonb_array_elements(r->'corrections') WITH ORDINALITY x(e, i)
           WHERE e->>'work_date' = '2026-10-20' ORDER BY i LIMIT 1) = 'Late shift ended at 2am', 'newest first within a day';
  RAISE NOTICE 'T10 staff read own OK';
END $t$;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $t$ DECLARE r jsonb; BEGIN
  ASSERT (SELECT count(*) FROM public.timesheet_corrections) = 5, 'the gate reads all';
  r := public.get_timesheet_corrections(DATE '2026-10-15');
  ASSERT (r->>'can_correct')::boolean AND jsonb_array_length(r->'corrections') = 5 AND r->>'from' = '2026-10-01'
         AND r->>'to' = '2026-10-31', 'gate book: ' || r::text;
  r := public.get_timesheet_corrections(DATE '2026-09-01');
  ASSERT jsonb_array_length(r->'corrections') = 0 AND r->>'to' = '2026-10-01', 'September window ends Oct 1: ' || r::text;
  RAISE NOTICE 'T10b gate reads all + month window OK';
END $t$;
RESET ROLE;

\echo 'ALL TIMESHEET CORRECTION TESTS PASSED'
