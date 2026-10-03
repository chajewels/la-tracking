-- ===========================================================================
-- ONE PESO RATE (owner decision 2026-10-03).
--
-- Every peso figure the website shows or quotes now follows the Hub's
-- system_settings.php_jpy_rate — the same rate every Hub calculation uses
-- (CLAUDE.md CURRENCY CONVERSION STANDARD). The daily market rate fetch
-- (pg_cron 'daily-fx-rate' → edge function fetch-fx-rate → fx_rates) is
-- retired: the job is unscheduled here; fx_rates stays as history (never
-- deleted) and nothing reads it any more. No function body is touched.
-- Idempotent.
-- ===========================================================================
SELECT cron.unschedule('daily-fx-rate')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-fx-rate');

COMMENT ON TABLE public.fx_rates IS
  'RETIRED 2026-10-03 (ONE PESO RATE): history of the daily JPY->PHP market rate the website used until then. The website now reads system_settings.php_jpy_rate (the Hub''s rate). Not written, not read; kept as history.';

DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-fx-rate') THEN
    RAISE EXCEPTION 'one-peso-rate: daily-fx-rate is still scheduled';
  END IF;
END
$chk$;
