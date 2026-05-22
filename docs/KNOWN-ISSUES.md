## Known Issues

  DP payments may be recorded with various payment_type values
  depending on how they were imported. Always check multiple fields
  when identifying DP payments:
    - payment_type === 'downpayment' or 'dp'
    - is_downpayment === true
    - reference_number starts with 'DP-'
    - remarks contains 'down' or 'dp' (case-insensitive)

### Historical / Resolved Investigations

Issue C (filed 2026-05-18 from Phase 6 investigation): email-channel due_today reminder logs apparently stopped on 2026-05-15.

  Symptoms (from 14-day reminder_logs query 2026-05-05 → 2026-05-18):
    - email/due_today: 85 entries, last_seen 2026-05-15
    - system/due_today: 137 entries, last_seen 2026-05-18 (continuing normally)
    - All other email stages (penalty, overdue, due_7_days, due_3_days) continue through 2026-05-18

  Possible causes:
    (a) Coincidence — no email-equipped customers had due_today on 2026-05-16/17/18
        (statistically unlikely given 7.7 emails/day average for 11 prior days)
    (b) Regression — email branch silently failing for due_today only

  Correlation: 2026-05-15 is the same date auto-deploy broke
  (SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF unset). send-reminders is in
  auto-deploy workflow list but Lovable hasn't touched it since 2026-05-15.

  Investigation query designed (per-day per-channel due_today breakdown
  with customer email presence) — pending execution.

  RESOLVED 2026-05-18: confirmed (b) — Supabase Edge Function fetch
  rate limit caused all due_today fetches to fail silently. Fixed as
  Bug #110 same day (see Known Fixed Bugs and Phase 7 changelog).

