-- Phase 2: after 20270204100000 the correction floor is 2026-04-01 (owner 2026-10-27, decision L); nothing else moved.
\set ON_ERROR_STOP 1
\set B '00000000-0000-0000-0000-00000000000b'
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'B', false);
DO $t$ DECLARE r jsonb; k uuid := '00000000-0000-0000-0000-00000000000c'; BEGIN
  r := public.correct_timesheet_day(k, DATE '2026-03-31', NULL, NULL, NULL, NULL, 'Paper sheet');
  ASSERT r->>'error' = 'invalid_date', 'March still refused: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-04-01', '2026-04-01 11:00+08', NULL, NULL, '2026-04-01 17:00+08', 'Paper sheet');
  ASSERT r->>'ok' = 'true', '1 April allowed: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-05-31', '2026-05-31 11:00+08', NULL, NULL, '2026-06-01 00:00+08', 'Paper sheet');
  ASSERT r->>'ok' = 'true', '31 May allowed (midnight PM out): ' || r::text;
  r := public.correct_timesheet_day(k, (now() AT TIME ZONE 'Asia/Manila')::date + 1, NULL, NULL, NULL, NULL, 'Paper sheet');
  ASSERT r->>'error' = 'invalid_date', 'tomorrow still refused: ' || r::text;
  r := public.correct_timesheet_day(k, DATE '2026-04-02', '2026-04-02 09:00+08', '2026-04-02 08:00+08', NULL, NULL, 'Paper sheet');
  ASSERT r->>'error' = 'invalid_order', 'order rule unchanged: ' || r::text;
  ASSERT (SELECT count(*) FROM public.timesheet_corrections) = 2, 'two April/May corrections';
  RAISE NOTICE 'T11 April floor OK (March refused, 1 Apr + 31 May allowed, other rules unchanged)';
END $t$;
RESET ROLE;
\echo 'ALL APRIL CORRECTION TESTS PASSED'
