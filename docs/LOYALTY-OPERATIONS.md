# Loyalty operations runbook

Operational guidance for loyalty subsystems. Locked rules and invariants
live in CLAUDE.md; this doc covers the "how do I use this in practice"
side. Add new sections here as new operational topics arise.

## Sheet backup sync — operational guide (added 2026-06-05)

The Google Sheet backup of `loyalty_transactions` is maintained by two
complementary paths. See CLAUDE.md "SHEET SYNC ARCHITECTURE —
NON-NEGOTIABLE (added 2026-06-05)" for the locked invariants; this
section covers operational mechanics.

### Manual trigger (SQL Editor)

Force a reconciler run without waiting for the next cron tick — useful
after a SQL backfill, or to verify the function still responds:

```sql
SELECT net.http_post(
  url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/loyalty-sheet-reconcile',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
  ),
  body := jsonb_build_object('window_days', 30, 'max_rows', 100)
);
```

Inspect the response (~5 seconds later — substitute the request_id
returned by the POST above):

```sql
SELECT created, id, response_body, status_code
FROM net._http_response
WHERE id = <request_id>;
```

Expected body shape:
`{"processed": N, "succeeded": N, "failed": 0, "remaining": M, "window_days": 30, "max_rows": 100}`

### Monitoring queries

**Sync coverage — run anytime:**

```sql
SELECT
  COUNT(*)                                           AS total_rows,
  COUNT(synced_to_sheet_at)                          AS synced_rows,
  COUNT(*) FILTER (WHERE synced_to_sheet_at IS NULL) AS unsynced_rows
FROM public.loyalty_transactions;
```

Healthy steady state: `unsynced_rows = 0`, or a small number that drops
to 0 within an hour.

**Unsynced row inspection — when unsynced_rows > 0:**

```sql
SELECT id, transaction_type, customer_id, account_id, points_change,
       created_at, AGE(NOW(), created_at) AS age, notes
FROM public.loyalty_transactions
WHERE synced_to_sheet_at IS NULL
ORDER BY created_at DESC;
```

If rows are <1 hour old, the next cron tick will catch them. If rows
are >24 hours old, something is wrong — see Debugging stuck rows below.

**Cron job status:**

```sql
SELECT jobid, schedule, jobname, active
FROM cron.job
WHERE jobname = 'loyalty-sheet-reconcile';
```

Expected: `schedule = '7 * * * *'`, `active = true`.

**Last 5 cron runs:**

```sql
SELECT runid, start_time, end_time, status, return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'loyalty-sheet-reconcile')
ORDER BY start_time DESC
LIMIT 5;
```

Expected `status = 'succeeded'` on all 5. If any are `failed`, inspect
`return_message` for the error.

### Debugging stuck rows

If `synced_to_sheet_at IS NULL` for rows >24 hours old:

1. **Run the manual trigger above.** If it returns `processed > 0`, the
   row was probably outside the 30-day window in prior runs — bump
   `window_days` in the body to pick it up. If it returns `failed > 0`,
   inspect the `failures` array in the response body.

2. **Test `sync-loyalty-to-sheet` directly** to isolate downstream
   issues (Apps Script webhook broken, sheet permissions, etc.):

```sql
SELECT net.http_post(
  url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/sync-loyalty-to-sheet',
  headers := jsonb_build_object('Content-Type', 'application/json'),
  body := jsonb_build_object(
    'tab', 'Transactions',
    'action', 'append',
    'row', jsonb_build_object('test', true)
  )
);
```

   If this returns non-200, the issue is downstream — not the reconciler.

3. **Force re-emit a specific row** by clearing its marker. Use this
   intentionally after fixing an underlying issue, never as a workaround
   for a real sync failure:

```sql
UPDATE public.loyalty_transactions
SET synced_to_sheet_at = NULL
WHERE id = '<uuid>';
```

   The next cron tick (or manual trigger) picks it up.

### Operational caveats

- **30-day window** is intentional. Rows older than 30 days that never
  synced stay NULL forever — avoids thrashing on permanent failures.
  Override via `window_days` in the manual trigger body if you genuinely
  need to re-emit an ancient row.
- **100-row max per run** paces the fan-out so a large backlog doesn't
  hammer the Apps Script webhook. A backlog of N rows drains in
  ceil(N/100) hours.
- **Idempotent.** Running the reconciler twice in a row is safe — the
  second run sees zero unsynced rows and returns `processed: 0`.
- **Auth.** The reconciler is intentionally unauthenticated (see
  CLAUDE.md invariant 3). The Vault-backed cron pattern stays compatible
  with Supabase's `sb_secret_*` key-format rollout because the
  reconciler doesn't validate the bearer token. Do NOT add auth checks
  to `loyalty-sheet-reconcile` without first solving the Vault-vs-env
  divergence — this was deliberately removed at commit `0e845e2` after
  the initial deploy's strict pattern broke the cron.
