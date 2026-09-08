-- Daily JPY->PHP rate fetch. Vault-backed auth per CLAUDE.md CRON AUTH RULE:
-- the service key is resolved at fire time from vault.decrypted_secrets, never
-- embedded in the job body.
--
-- 00:45 UTC = 08:45 PHT — after the account pipeline (reminders -> penalties ->
-- forfeit -> reconciliation -> loyalty -> cash expiry, 00:00..00:30 UTC), so it
-- never competes with it.
SELECT cron.unschedule('daily-fx-rate')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-fx-rate');

SELECT cron.schedule(
  'daily-fx-rate',
  '45 0 * * *',
  $$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/fetch-fx-rate',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
