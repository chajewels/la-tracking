-- Cron run-history cleanup — owner-approved plan 2026-10-03 09:30 JST
-- (investigation: Project doc claude/db-load-investigation-2026-10-03.md).
--
-- cron.job_run_details (one row per pg_cron run) had never been cleaned:
-- runid 1 .. ~1.75M since 2026-03-20, 6.5 GB of the 6.8 GB database, about
-- 5 GB of it dead space. Nothing in the Hub reads it (git grep origin/main:
-- 0 hits in src/ and supabase/functions; no public function references it).
-- Every time-based read of it scans the whole file (47–101 s on 2026-10-03).
--
-- This file:
--   1. keeps the last 7 days of run history (owner decision), drops the rest;
--   2. schedules cron-run-history-cleanup daily at 19:19 UTC (03:19 PHT),
--      outside the 00:00–00:55 UTC ordering chain and every busy minute.
--
-- Method: LOCK + copy the rows to keep + TRUNCATE + re-insert. postgres may
-- TRUNCATE cron.job_run_details but cannot VACUUM FULL it (owner is
-- supabase_admin, postgres is not in pg_maintain). TRUNCATE gives the disk back
-- at commit and writes almost no WAL; a DELETE of ~1.75M rows would write GBs
-- of full-page images and free no disk. TRUNCATE without RESTART IDENTITY, so
-- cron.runid_seq continues and a job running right now still finds its row.
--
-- Run the WHOLE file as ONE transaction. pg_cron's own inserts wait on the
-- lock for the few seconds this takes (they queue, they do not fail). If
-- lock_timeout fires, nothing changed — wait 3 minutes and run it once more.

SET LOCAL lock_timeout = '15s';

DO $pre$
BEGIN
  IF to_regclass('cron.job_run_details') IS NULL
     OR to_regprocedure('cron.schedule(text,text,text)') IS NULL
     OR to_regprocedure('cron.unschedule(text)') IS NULL THEN
    RAISE EXCEPTION 'cron_history_cleanup: pg_cron missing';
  END IF;
  IF NOT has_table_privilege('cron.job_run_details', 'TRUNCATE')
     OR NOT has_table_privilege('cron.job_run_details', 'INSERT') THEN
    RAISE EXCEPTION 'cron_history_cleanup: no TRUNCATE/INSERT privilege on cron.job_run_details';
  END IF;
END
$pre$;

LOCK TABLE cron.job_run_details IN ACCESS EXCLUSIVE MODE;

-- runid comes from cron.runid_seq, so the newest rows have the highest runids.
-- Reading only the top 200,000 runids uses the primary key instead of scanning
-- 6.4 GB while the table is locked; the check below proves the window reaches
-- further back than 7 days (on 2026-10-03 the top 63,000 runids already
-- reached 2026-06-29, and the last 7 days held 13,566 rows).
DO $window$
DECLARE
  v_max   bigint := (SELECT max(runid) FROM cron.job_run_details);
  v_edge  timestamptz;
BEGIN
  SELECT start_time INTO v_edge
    FROM cron.job_run_details
   WHERE runid <= v_max - 200000 AND start_time IS NOT NULL
   ORDER BY runid DESC
   LIMIT 1;
  IF v_edge IS NOT NULL AND v_edge >= now() - interval '7 days' THEN
    RAISE EXCEPTION 'cron_history_cleanup: the 200,000-runid window does not reach back 7 days (edge %) — stop and re-plan', v_edge;
  END IF;
END
$window$;

CREATE TEMP TABLE _cron_keep ON COMMIT DROP AS
  SELECT *
    FROM cron.job_run_details
   WHERE runid > (SELECT max(runid) FROM cron.job_run_details) - 200000
     AND (start_time >= now() - interval '7 days'
          OR status IN ('starting', 'connecting', 'sending', 'running'));

DO $count$
DECLARE
  v_keep bigint := (SELECT count(*) FROM _cron_keep);
BEGIN
  IF v_keep < 1000 OR v_keep > 100000 THEN
    RAISE EXCEPTION 'cron_history_cleanup: % rows to keep is outside 1,000–100,000 — stop and re-plan', v_keep;
  END IF;
END
$count$;

TRUNCATE cron.job_run_details;

INSERT INTO cron.job_run_details SELECT * FROM _cron_keep;

-- Daily cleanup, plain SQL (no edge function, no key). Rows that never got an
-- end_time (a run that died) go once they are older than 7 days too.
SELECT cron.unschedule('cron-run-history-cleanup')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-run-history-cleanup');
SELECT cron.schedule('cron-run-history-cleanup', '19 19 * * *', $cron$
  DELETE FROM cron.job_run_details
   WHERE end_time < now() - interval '7 days'
      OR (end_time IS NULL AND start_time < now() - interval '7 days');
$cron$);

-- Self-check — any failure aborts the whole file and nothing is changed.
DO $self$
DECLARE
  v_rows   bigint := (SELECT count(*) FROM cron.job_run_details);
  v_keep   bigint := (SELECT count(*) FROM _cron_keep);
  v_oldest timestamptz := (SELECT min(start_time) FROM cron.job_run_details
                            WHERE status NOT IN ('starting', 'connecting', 'sending', 'running'));
  v_size   bigint := pg_relation_size('cron.job_run_details');
BEGIN
  IF v_rows <> v_keep THEN
    RAISE EXCEPTION 'self-check failed: % rows after re-insert, expected %', v_rows, v_keep;
  END IF;
  IF v_oldest < now() - interval '7 days 1 hour' THEN
    RAISE EXCEPTION 'self-check failed: oldest kept run %', v_oldest;
  END IF;
  IF v_size > 200 * 1024 * 1024 THEN
    RAISE EXCEPTION 'self-check failed: table still % bytes', v_size;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'cron-run-history-cleanup'
                    AND schedule = '19 19 * * *' AND active) THEN
    RAISE EXCEPTION 'self-check failed: cron-run-history-cleanup not scheduled';
  END IF;
  RAISE NOTICE 'cron_history_cleanup: kept % runs (oldest %), table now % bytes, cleanup job scheduled 19:19 UTC',
    v_rows, v_oldest, v_size;
END
$self$;