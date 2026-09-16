-- The loyalty self-healing sweep gets its own cron, because it used to have no
-- way of running at all.
--
-- MEASURED BEFORE WRITING THIS (live, 2026-09-16):
--   layaway accounts in scope for daily-reconciliation ......... 493
--   accounts it actually reconciles per night .................. ~120
--   seconds per account ....................................... 1.56
--   run length, 7 of the last 8 nights ........................ 185.1 – 186.3 s
--   system_settings.last_daily_reconciliation ................. 2026-05-19
--   loyalty_award_missing / _failed notifications in 90 days ... 1
--
-- The sweep was the last block of daily-reconciliation, after a loop over all
-- 493 accounts. 493 x 1.56 s is ~769 s of work against a ~185 s ceiling, so the
-- loop never finishes and nothing after it ever executes. The sweep was not
-- occasionally skipped; it was unreachable. One notification in ninety days is
-- what that looks like from the outside.
--
-- SCHEDULE: 00:35 UTC = 08:35 PHT. Chosen against the live cron table rather
-- than picked: :00 reminders, :05 penalties, :10 forfeit, :20 reconciliation,
-- :25 loyalty inactivity, :45 fx, :50 email health, :55 portal tokens, plus
-- hourly jobs at :07, :40 and the */30 alert evaluation at :00/:30. :35 is the
-- only free minute in the morning chain. It sits AFTER the loyalty inactivity
-- check, which is where CLAUDE.md's ordering rule puts loyalty work — last,
-- on reconciled data.
--
-- AUTH: Vault-backed service key, per CLAUDE.md CRON AUTH RULE. An embedded
-- key drifts out of sync with the runtime env value and silently 401s at every
-- tick — which is a second way to build a job that never runs.

SELECT cron.unschedule('loyalty-award-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'loyalty-award-sweep');

SELECT cron.schedule(
  'loyalty-award-sweep',
  '35 0 * * *',
  $job$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/loyalty-award-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{}'::jsonb
  );
  $job$
);

-- Verification after applying:
--   -- expect one row, '35 0 * * *', active
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'loyalty-award-sweep';
--   -- expect no other job at minute 35
--   SELECT jobname, schedule FROM cron.job WHERE active AND schedule LIKE '35 %';
--   -- after the first fire, expect a value (not null) whose `remaining` says
--   -- whether the budget was exhausted
--   SELECT value FROM system_settings WHERE key = 'last_loyalty_award_sweep';
