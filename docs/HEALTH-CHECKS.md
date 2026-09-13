## NEW HEALTH CHECKS (15-21, added in Phase 5 — 2026-03-29)

  Check 15: total_paid drift — SUM(payments) matches account.total_paid
  Check 16: allocation ceiling breach — no row over-allocated
  Check 17: inflated schedule rows — no pending/overdue rows with inflated total_due_amount
  Check 18: zero remaining not paid — all zero-remaining rows marked paid
  Check 19: wrongful forfeit — no zero-balance forfeited accounts
  Check 20: carried amount on paid row — no unconsumed carry on paid rows
  Check 21: double carry — no account has carry on multiple rows

## PERIODIC HEALTH QUERIES

```sql
-- Detect stale partially_paid rows (run periodically)
SELECT la.invoice_number, ls.installment_number
FROM layaway_schedule ls
JOIN layaway_accounts la ON la.id = ls.account_id
LEFT JOIN (
  SELECT schedule_id, SUM(allocated_amount) AS allocated
  FROM payment_allocations pa2
  JOIN payments p ON p.id = pa2.payment_id
  WHERE p.voided_at IS NULL
  GROUP BY schedule_id
) pa ON pa.schedule_id = ls.id
WHERE ls.status = 'partially_paid'
  AND COALESCE(pa.allocated, 0) >= (
    ls.base_installment_amount
    + COALESCE(ls.penalty_amount, 0)
    + COALESCE(ls.carried_amount, 0)
  ) - 0.005
  AND la.invoice_number NOT LIKE 'TEST-%';
-- Expected result: 0 rows. If rows appear, update db_status to paid.
```


## EMAIL DELIVERY HEALTH (added 2026-09-13)

Not part of the numbered system-health checks; a separate daily verdict.

- RPC: `email_delivery_report(p_hours integer DEFAULT 24)` → jsonb
  `{ expected{...}, expected_total, sent, failed, suppressed, storefront{sent,failed},
     last_sent_at, refusal_streak_started_at, newest_error, newest_request_id,
     status: ok | degraded | refused | silent }`. Staff roles only (checked inside).
- Cron: `email-health-check` `50 0 * * *` UTC → `/functions/v1/email-health-check`
  (Vault key `email_queue_service_role_key`). Writes `system_settings.email_health_status`,
  raises `staff_notifications.type = 'email_delivery_outage'` when status ≠ ok (20h cooldown).
- Per-send alert: `staff_notifications.type = 'email_send_refused'`, raised by
  `_shared/email-log.ts` on the first refused attempt in 24h.
- Hub surfaces: sidebar footer pill, Dashboard banner, Settings → General → Email delivery.

Ad-hoc queries:

    -- verdict now
    SELECT public.email_delivery_report(24);

    -- refusals by day and channel, last 14 days
    SELECT created_at::date AS day, channel, count(*) FILTER (WHERE status='sent') AS sent,
           count(*) FILTER (WHERE status IN ('failed','dlq')) AS refused
      FROM email_send_log WHERE created_at >= now() - interval '14 days'
     GROUP BY 1,2 ORDER BY 1 DESC, 2;

    -- newest refusal with the Lovable request_id for a support ticket
    SELECT created_at, channel, template_name, request_id, left(error_message, 200)
      FROM email_send_log WHERE status IN ('failed','dlq') ORDER BY created_at DESC LIMIT 5;

    -- last time the cron fired
    SELECT runid, status, start_time, return_message FROM cron.job_run_details
     WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='email-health-check')
     ORDER BY start_time DESC LIMIT 3;
