# Outage diagnosis — 2026-10-28 (read-only, nothing changed)

## What I could see
Log retention available to me only reaches back to **12:44 UTC**. Nothing exists for 12:00–12:44 or for the 05:30–05:45 UTC episode, so I cannot compare the two.

| Check | Result |
|---|---|
| Backend status probe | `backend_unreachable_db: auth→database probe ... context deadline exceeded` |
| Database metrics | "Current database metrics are unavailable" |
| Resource-exhaustion alerts (48 h) | **none** (exhaustion flag false: no memory, connection or CPU alert) |
| Direct SQL (`select 1`) | "connection pooler is unavailable" |
| postgres_logs / auth_logs, any time | **0 rows**. The database and Auth are not writing any logs at all |
| edge_logs 12:44–12:53 | Every REST and Auth call that needs Postgres returned **522** (gateway timed out connecting to the database): website_collections 34, website_categories 14, auth/v1/token 5, product_reviews 5, website_products 5, others 1–3. Only one REST 200 (layaway_accounts at 12:45:26). Storage bucket list returned 429/400 |
| function_edge_logs 12:44–12:53 | One function (id b2f6b68d…, the `website` function, matching its log lines) accounts for 504 ×128, 500 ×62, 503 ×36, 200 ×1. One 401 from another function |
| function_logs | `website api error ... GET /catalog/categories/...` returns an HTML error page from the database host. Workers boot and shut down in waves of about 15 every ~70 s |

## Answers
1. **Database state:** it does not answer. Postgres is either down, restarting or hung. I found no evidence it ran out of memory, disk or connections: there are no alerts, and there are no Postgres log lines to search for "too many connections", OOM, "No space left" or recovery messages. Because nothing is logged at all, the cause is below the database layer (the instance itself), not a slow query.
2. **pg_stat_activity:** I can't query it, because the connection pooler is unavailable.
3. **pg_cron runs (cron.job_run_details):** I can't query that either, for the same reason.
4. **Edge functions:** only the `website` function shows volume: about 227 failed calls in about 9 minutes (about 25 per minute). That is storefront visitors arriving and every request failing. It is not a tight loop, and the volume is too low to overload a database. No other function is busy.
5. **Most likely cause:** the database instance itself is stuck or unreachable at the host level. It is a Small shared 2-core instance, and an episode with the same pattern happened at 05:30. A runaway query or exhausted connections would still leave Postgres logs and a reachable pooler; here we have neither.

## Recommendation only (owner decides; I did nothing)
- **Smallest safe action: one backend restart** (Cloud → restart, or ask me to run it). No code or data changes.
- After it comes back, run these read-only checks before anything else, to catch a trigger: `pg_stat_activity` grouped by state and wait_event, and `cron.job_run_details` for 05:20–05:50 and 12:30–12:45 UTC.
- If it happens a third time, move to a larger instance. The repeated hang on a shared Small instance points to the instance size, though I could not confirm it from metrics.
- The restart doesn't fix itself: if the restart does not bring it back within about 10 minutes, the next step is a platform-side issue for Lovable staff, who would need to check the host for this project's database.
