-- Media cut-out worker: sleep when there is no work, wake on real work.
-- Owner decision 2026-10-03 10:27 JST ("the every minute cut work must stop";
-- design A). Plan + investigation: Project doc
-- claude/media-cutout-worker-sleep-plan-2026-10-03.md.
--
-- Before: pg_cron 'media-cutout-worker' called the edge function every minute,
-- 1,440 times a day, even with nothing to do (on 2026-10-03: 557 photos all
-- 'waiting' for unpublished products, nothing queued or in flight).
--
-- After:
--   * the minute job first asks media_cutout_has_work(). With work it calls the
--     worker exactly as before. Without work it switches ITSELF off
--     (cron.alter_job active=false): no worker call, no run, no log row.
--   * WAKE: any statement that leaves a cut-out row queued / submitted / ready /
--     processing switches the minute job back on (statement triggers below).
--     Publishing a product already moves its photos waiting → queued
--     (media_cutout_follow_product_publish), so publishing wakes it; a new photo
--     on a published product, a re-cut, an own upload, "allow one more" and the
--     worker's own submitted/ready steps do too. Changing the switch or the
--     monthly limit wakes it if that leaves work.
--   * a DAILY CHECK (19:44 UTC = 03:44 PHT) calls the worker once for
--     housekeeping (files of photos no product uses are removed after 30 days),
--     the publish backstop, and the month rollover when the limit was reached.
--   * "Run now" on Website → Photos is unchanged (it calls the worker directly).
--
-- Lost-wake guard (advisory key 7700000000000002; ...001 is the email queue):
--   waker  = pg_advisory_xact_lock_shared — wakers never wait on each other and
--            hold it until their transaction commits;
--   sleeper = pg_try_advisory_xact_lock — never waits; if a waker is still in
--            flight it stays awake this minute. Holding the lock it re-checks the
--            queue (now seeing every committed wake) before switching off.
-- A wake that fails is caught and logged as a WARNING: it can never block
-- saving a product, a photo or a cut-out row.
--
-- has_work mirrors media_cutout_submit_batch / media_cutout_poll_batch /
-- media_cutout_process_batch and the worker's mode-off path
-- (finishOwnCutoutsOnly). If they change, this function must change with them.
--
-- Run the WHOLE file as ONE transaction.

SET LOCAL lock_timeout = '15s';

DO $pre$
BEGIN
  IF to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') IS NULL
     OR to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'media_cutout_sleep: pg_cron (with alter_job) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker') THEN
    RAISE EXCEPTION 'media_cutout_sleep: cron job media-cutout-worker missing';
  END IF;
  IF to_regclass('public.website_media_cutouts') IS NULL
     OR to_regclass('public.website_media_cutout_lease') IS NULL
     OR to_regclass('public.website_media_cutout_usage') IS NULL THEN
    RAISE EXCEPTION 'media_cutout_sleep: media cut-out tables missing';
  END IF;
  IF to_regprocedure('public.media_cutout_mode()') IS NULL
     OR to_regprocedure('public.media_cutout_cap()') IS NULL
     OR to_regprocedure('public.media_cutout_month()') IS NULL
     OR to_regprocedure('public.media_cutout_url_published(text)') IS NULL
     OR to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'media_cutout_sleep: a media cut-out helper function is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'media_cutout_sleep: Vault secret email_queue_service_role_key missing — do not create a second key';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-daily-check') THEN
    RAISE EXCEPTION 'media_cutout_sleep: media-cutout-daily-check already exists — stop and re-plan';
  END IF;
END
$pre$;

-- When the worker went to sleep / woke, and the last daily check (Photos card).
ALTER TABLE public.website_media_cutout_lease
  ADD COLUMN IF NOT EXISTS worker_slept_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_woke_at  timestamptz,
  ADD COLUMN IF NOT EXISTS daily_check_at  timestamptz;

-- ---------------------------------------------------------------------------
-- 1. Is there anything the worker can actually do right now (or soon)?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_has_work()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text := public.media_cutout_mode();
  v_left integer;
BEGIN
  -- Staff-uploaded own cut-outs are finished in every mode (finishOwnCutoutsOnly).
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state IN ('ready', 'processing') AND own_cutout_url IS NOT NULL) THEN
    RETURN true;
  END IF;
  IF v_mode = 'off' THEN
    RETURN false;
  END IF;
  -- In flight: results to collect (poll), cut-outs to build (process), stuck
  -- builds to recover (process_batch resets 'processing' after 5 minutes).
  -- Retry back-off (next_attempt_at in the future) counts: stay awake for it.
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state IN ('submitted', 'ready', 'processing')) THEN
    RETURN true;
  END IF;
  -- Something submit_batch would send, under the monthly limit.
  v_left := greatest(0, public.media_cutout_cap() - coalesce(
              (SELECT provider_calls FROM public.website_media_cutout_usage
                WHERE month = public.media_cutout_month()), 0));
  IF v_left = 0 THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.website_media_cutouts c
     WHERE c.job_state = 'queued'
       AND c.orphaned_at IS NULL
       AND c.own_cutout_url IS NULL
       AND (v_mode = 'on' OR c.test_batch IS NOT NULL)
       AND c.status NOT IN ('ok', 'auto_fixed', 'approved', 'kept_original')
       AND (c.status <> 'rejected' OR c.recut_allowed)
       AND c.paid_calls < c.paid_call_limit
       AND c.hold_reason IS NULL
       AND public.media_cutout_url_published(c.source_url));
END
$function$;

-- ---------------------------------------------------------------------------
-- 2. Call the worker once — the exact request the cron sent before (Vault key
--    at fire time, CRON AUTH RULE).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_call_worker()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/media-cutout-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"tick"}'::jsonb
  );
$function$;

-- ---------------------------------------------------------------------------
-- 3. WAKE: switch the minute job on (no-op when already on). Never raises.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_wake()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job    bigint;
  v_active boolean;
BEGIN
  -- Shared: wakers never wait on each other; held until this transaction ends,
  -- so a sleeper cannot switch off between our check and our commit.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(7700000000000002);
  SELECT jobid, active INTO v_job, v_active FROM cron.job WHERE jobname = 'media-cutout-worker';
  IF v_job IS NULL OR v_active THEN
    RETURN;
  END IF;
  PERFORM cron.alter_job(v_job, active := true);
  UPDATE public.website_media_cutout_lease SET worker_woke_at = now() WHERE id = 1;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'media_cutout_wake: % (saved; the daily check wakes the worker)', SQLERRM;
END
$function$;

CREATE OR REPLACE FUNCTION public.media_cutout_wake_on_work()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM media_cutout_new_rows
              WHERE job_state IN ('queued', 'submitted', 'ready', 'processing')) THEN
    PERFORM public.media_cutout_wake();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'media_cutout_wake_on_work: % (row saved)', SQLERRM;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS trg_media_cutout_wake_ins ON public.website_media_cutouts;
CREATE TRIGGER trg_media_cutout_wake_ins
  AFTER INSERT ON public.website_media_cutouts
  REFERENCING NEW TABLE AS media_cutout_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.media_cutout_wake_on_work();
DROP TRIGGER IF EXISTS trg_media_cutout_wake_upd ON public.website_media_cutouts;
CREATE TRIGGER trg_media_cutout_wake_upd
  AFTER UPDATE ON public.website_media_cutouts
  REFERENCING NEW TABLE AS media_cutout_new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.media_cutout_wake_on_work();

-- The switch or the monthly limit changed: wake if that leaves work.
CREATE OR REPLACE FUNCTION public.media_cutout_wake_on_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.media_cutout_has_work() THEN
    PERFORM public.media_cutout_wake();
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'media_cutout_wake_on_settings: % (setting saved)', SQLERRM;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS trg_media_cutout_settings_wake ON public.system_settings;
CREATE TRIGGER trg_media_cutout_settings_wake
  AFTER INSERT OR UPDATE ON public.system_settings
  FOR EACH ROW
  WHEN (NEW.key IN ('media_cutout_mode', 'media_cutout_monthly_cap'))
  EXECUTE FUNCTION public.media_cutout_wake_on_settings();

-- ---------------------------------------------------------------------------
-- 4. The minute job: work → call the worker; no work → switch itself off.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_minute_check()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job bigint;
BEGIN
  IF public.media_cutout_has_work() THEN
    PERFORM public.media_cutout_call_worker();
    RETURN 'tick';
  END IF;
  -- Never wait: a wake still in flight means stay awake this minute.
  IF NOT pg_catalog.pg_try_advisory_xact_lock(7700000000000002) THEN
    RETURN 'busy';
  END IF;
  -- Re-check holding the lock: every wake that got the lock before us has
  -- committed, so its rows are visible now.
  IF public.media_cutout_has_work() THEN
    PERFORM public.media_cutout_call_worker();
    RETURN 'tick';
  END IF;
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'media-cutout-worker';
  IF v_job IS NULL THEN
    RETURN 'no-job';
  END IF;
  PERFORM cron.alter_job(v_job, active := false);
  UPDATE public.website_media_cutout_lease SET worker_slept_at = now() WHERE id = 1;
  RETURN 'asleep';
END
$function$;

-- ---------------------------------------------------------------------------
-- 5. The daily check: one full tick (housekeeping, publish backstop, month
--    rollover), then wake if anything is left.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_daily_check()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.media_cutout_call_worker();
  IF public.media_cutout_has_work() THEN
    PERFORM public.media_cutout_wake();
  END IF;
  UPDATE public.website_media_cutout_lease SET daily_check_at = now() WHERE id = 1;
  RETURN 'checked';
END
$function$;

-- ---------------------------------------------------------------------------
-- 6. Photos card: is the worker awake or asleep?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_media_cutout_worker_state()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_active boolean;
  v_lease  public.website_media_cutout_lease%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT active INTO v_active FROM cron.job WHERE jobname = 'media-cutout-worker';
  SELECT * INTO v_lease FROM public.website_media_cutout_lease WHERE id = 1;
  RETURN jsonb_build_object(
    'scheduled',      v_active IS NOT NULL,
    'awake',          coalesce(v_active, false),
    'slept_at',       v_lease.worker_slept_at,
    'woke_at',        v_lease.worker_woke_at,
    'daily_check_at', v_lease.daily_check_at);
END
$function$;

-- Only the cron (postgres) and the triggers run these; the Photos card reads state.
REVOKE ALL ON FUNCTION public.media_cutout_has_work()          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_cutout_call_worker()       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_cutout_wake()              FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_cutout_wake_on_work()      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_cutout_wake_on_settings()  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_cutout_minute_check()      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.media_cutout_daily_check()       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_media_cutout_worker_state()  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_media_cutout_worker_state() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.media_cutout_has_work()          FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.media_cutout_call_worker()       FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.media_cutout_wake()              FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.media_cutout_minute_check()      FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.media_cutout_daily_check()       FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Schedules. The minute job keeps its name and minute; only its command
--    changes. The daily check is new (19:44 UTC: outside the 00:00–00:55 UTC
--    chain, not on a page365 (2-59/5), newsletter (*/10) or :40 minute).
-- ---------------------------------------------------------------------------
SELECT cron.schedule('media-cutout-worker', '* * * * *', $cron$SELECT public.media_cutout_minute_check();$cron$);
SELECT cron.schedule('media-cutout-daily-check', '44 19 * * *', $cron$SELECT public.media_cutout_daily_check();$cron$);

-- Self-check — any failure aborts the whole file and nothing is changed.
DO $self$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker'
                    AND schedule = '* * * * *'
                    AND command = 'SELECT public.media_cutout_minute_check();') THEN
    RAISE EXCEPTION 'self-check failed: media-cutout-worker command not updated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-daily-check'
                    AND schedule = '44 19 * * *' AND active) THEN
    RAISE EXCEPTION 'self-check failed: media-cutout-daily-check not scheduled';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('trg_media_cutout_wake_ins', 'trg_media_cutout_wake_upd', 'trg_media_cutout_settings_wake')
         AND NOT tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'self-check failed: wake triggers missing';
  END IF;
  IF has_function_privilege('anon', 'public.media_cutout_minute_check()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_cutout_wake()', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check failed: internal functions are callable by clients';
  END IF;
  RAISE NOTICE 'media_cutout_sleep: minute job now checks before calling; has_work = %; daily check 19:44 UTC',
    public.media_cutout_has_work();
END
$self$;
