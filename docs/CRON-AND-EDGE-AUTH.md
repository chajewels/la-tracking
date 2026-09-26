<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## TIMEZONE STANDARD — NON-NEGOTIABLE (updated 2026-04-25)

  Canonical timezone: PHT (Asia/Manila, UTC+8)
  All date comparisons use PHT midnight as the day boundary.

  Frontend: import getPHTToday() from src/lib/date-utils.ts
    NEVER use: new Date().toISOString().split('T')[0]
    NEVER use: Asia/Tokyo — that is JST (UTC+9), not PHT
    ALWAYS use: getPHTToday() for any "today" date string

  Edge functions (Deno):
    NEVER use: new Date().toISOString().split('T')[0]
    ALWAYS use: Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Manila'
    }).format(new Date())

  Display timestamps:
    ALWAYS use: formatPHTDisplay() from date-utils.ts
    Show 'PHT' suffix on all displayed timestamps
    RefreshControl "Last updated" must show PHT time

  Cron jobs (all times are UTC, PHT = UTC+8):
  Jobs run in strict dependency order every morning:

    daily-send-reminders:          00:00 UTC = 08:00 PHT ✅
    daily-penalty-engine:          00:05 UTC = 08:05 PHT ✅
    daily-auto-forfeit:            00:10 UTC = 08:10 PHT ✅
    daily-reconciliation:          00:20 UTC = 08:20 PHT ✅
    loyalty-inactivity-check:      00:25 UTC = 08:25 PHT ✅
    loyalty-award-sweep:           00:35 UTC = 08:35 PHT ✅  — recovers missed loyalty awards; split out of daily-reconciliation 2026-09-16 (see below)
    auto-expire-cash-orders:       40 * * * * (hourly at :40) ✅  — the ONLY web/cash order expiry path since 2026-09-13; the SQL cron expire_transfer_orders() is gone
    web-payment-reminder-sweep:    13 * * * * (hourly at :13) ⏳ scheduled by migration 20261004100000 — one payment reminder before a confirmed web order's deadline; returns early while web_payment_reminders_mode is off (docs/WEB-PAYMENT-REMINDERS.md)
    web-reservation-expiring-bell: 13 * * * * (hourly at :13) ⏳ same migration — PURE SQL (SELECT web_reservation_expiring_bells()), no HTTP, no Vault; one staff bell per web reservation unconfirmed 48–72h
    web-reservation-sweep:         23 * * * * (hourly at :23) ⏳ scheduled by migration 20260924100000 — reserve-first: 72h unconfirmed reservations auto-cancelled + one sales@ reminder at 24h (docs/RESERVE-FIRST.md)
    page365-inventory-schedule:    2-59/5 * * * * (every 5 min) ⏳ scheduled by migration 20260930100000 — Page365 inventory read every 30 min (ticks in between finish it); applies decreases only when page365_inventory_auto_apply is on (docs/PAGE365-IMPORT.md "SCHEDULE"). Touches no account data.
    daily-fx-rate:                 00:45 UTC = 08:45 PHT ✅
    portal-token-check:            00:55 UTC = 08:55 PHT ✅  — portal links approaching expiry; Vault-backed, independent of the chain
    deactivate-expired-promotions: every hour            ✅
    loyalty-notification-queue:    every hour            ✅
    fc-alert-evaluation:           every 30 minutes      ✅
    process-email-queue:           NO CRON — see below      ⚠️
    cleanup-loyalty-images:        Sun 03:00 UTC = Sun 11:00 PHT ✅

  process-email-queue HAS NO CRON (verified against cron.job 2026-09-14 — the
  former "every 5 seconds" entry is gone and this line was stale). It is kicked
  over HTTP by send-transactional-email after that function enqueues onto pgmq
  `transactional_emails`. Consequence when diagnosing: silence from this
  pipeline means nothing is calling it, NOT that it is healthy. Its last
  activity of any kind was 2026-09-09 14:08 (164 consecutive refusals — see
  docs/FIXED-BUGS.md Bug #270).

  ORDERING RULE — never violate this sequence:
    1. Reminders fire first (before penalties)
    2. Penalty engine runs after reminders
    3. Auto-forfeit runs after penalty engine
    4. Reconciliation runs after forfeitures
    5. Loyalty inactivity check runs last
       (needs fully reconciled account data)
    6. The loyalty award sweep (00:35) runs after that, and is DELIBERATELY
       ITS OWN JOB rather than a tail block of daily-reconciliation. It used to
       be the last block of that function, after a loop over every active
       account — a loop which cannot finish in one run at current volume. The
       loop's own predicate (status IN active / overdue / extension_active /
       final_settlement, no test filter) selects 535 accounts at ~1.56s each
       against a hard ~185s ceiling; before the 2026-09-17 time-box it simply
       died after ~120, and everything sequenced after it was unreachable
       rather than merely skipped — the sweep produced ONE staff notification
       in ninety days. It is now time-boxed and resumes from a
       reconciliation_log cursor, so the 535 drain over about SIX runs
       (measured 2026-09-17: evaluated 91, remaining 444, budget_exhausted
       true). Do NOT confuse 535 with the 493 the account audit reports: that
       is the same status set filtered to total_paid > 0, because
       audit_account only means anything once money has landed. 535 is the
       sweep's population and the number `remaining` counts down from. A job
       whose independence matters must not be a continuation of another job's
       request. Never move it back inline.
    6. daily-reconciliation must never be scheduled
       before 00:15 UTC

  daily-fx-rate is INDEPENDENT of that chain — it writes only
  fx_rates and touches no account data. It sits at 00:45 UTC so it
  never competes with the pipeline. fx_rates.jpy_php = PHP per 1 JPY
  (same direction as system_settings.php_jpy_rate); the `website`
  edge function derives price_php = round(price_jpy * jpy_php) at
  read time and NEVER stores a peso price.

  RACE CONDITION RULE (RETIRED 2026-05-20):
    The duplicate daily-payment-reminders cron was removed
    2026-05-20 — daily-send-reminders is now the sole reminder
    cron. The 2-minute offset rule no longer applies. NEVER
    re-add a second cron pointing at /send-reminders — see
    EMAIL SENDING — LOVABLE WORKSPACE RATE LIMIT for why.

  CRON AUTH RULE (added 2026-06-05):
    Any pg_cron job calling a service-role-gated edge function MUST
    use the Vault-backed service key — never an embedded key.
    Pattern: the cron body resolves the key at fire time via
      (SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'email_queue_service_role_key')
    and passes it as `Authorization: Bearer <key>` to pg_net's
    outbound POST. Embedded keys (anon, dashboard-pasted service
    role) drift out of sync with the runtime
    `SUPABASE_SERVICE_ROLE_KEY` env value over time (Supabase's
    `sb_secret_*` rollout, key rotations, security passes that
    tighten gates) and silently 401 at every tick.
    Canonical adopters: loyalty-sheet-reconcile, process-email-queue,
    fc-alert-evaluation, daily-penalty-engine, daily-auto-forfeit.
    When adding a new cron, copy the Vault pattern from one of
    those; do not hand-edit the Authorization header to anything
    else. See `docs/LOYALTY-OPERATIONS.md` for the full SQL snippet.

  EDGE FUNCTION SERVICE-ROLE AUTH PATTERN (locked — added 2026-06-06):
    Inside a service-role-gated edge function, identify the caller
    via JWT claims, NOT string equality:
      if (parseJwtClaims(token)?.role !== "service_role") { return 401; }
    Run behind gateway `verify_jwt = true` in `supabase/config.toml`
    so the signature is validated before the handler executes.
    NEVER write `token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`:
    Vault-stored keys and env-injected keys are both valid
    same-project `service_role` JWTs but may not be string-identical
    (different issuance times, different signing rotations) — the
    equality check rejects legitimate Vault-backed cron callers and
    breaks the nightly suite. Shared helper:
    `supabase/functions/_shared/jwt-claims.ts` (`parseJwtClaims`).
    Root-caused as Bug #168 (2026-06-06, commit `04a7f47`).

    SHARED-HELPER CONVENTION (locked — added 2026-07-05):
    NEW edge functions, and any existing function being edited for
    other reasons, MUST use _shared/cors.ts (corsHeaders/corsPreflight/
    jsonResponse) and _shared/handler.ts (requireAuth/requirePermission)
    instead of inline copies. The fleet converges opportunistically —
    no dedicated migration batches.

    NEVER accept the anon key as an internal-bypass credential, and
    NEVER allow a missing Authorization header to skip the gate
    (added 2026-06-06 after Bug #170):
      - `SUPABASE_ANON_KEY` is shipped in every browser bundle —
        treating an `isInternalKey = (token === SUPABASE_ANON_KEY)`
        match as authorization is equivalent to no auth at all. Any
        caller can copy the anon key out of the public bundle and
        mint the bypass header.
      - An `if (authHeader) { …gate… }` wrapper is NOT a gate — a
        request with no Authorization header skips the entire check
        and reaches the handler. The Authorization header MUST be
        mandatory; reject with 401 when missing or malformed before
        any other work.
      - For functions that mutate account/financial state via a user
        action (System Health "fix" entry points, admin-only repair
        RPCs, etc.), pair the JWT validation with a real role or
        permission check (`hasPermission(user.id, '<permission_key>')`)
        — `getUser()` succeeding only proves the caller has *some*
        valid session, not the right to mutate. Reject with 403 on
        permission failure.
      Root-caused as Bug #170 (2026-06-06, commit `28bc07e`,
      deployed 2026-06-06 09:15 UTC).

    Service-role-only functions using this claims gate (added
    2026-06-07, commit `b1e41d3`): `sync-loyalty-to-sheet` —
    callers are loyalty edge functions (`adjust-loyalty-points`,
    `award-loyalty-points`, `loyalty-inactivity-check`,
    `loyalty-sheet-reconcile`, `process-loyalty-redemption`) +
    `customer-portal`; all send `Bearer` env service role key.
    `append-cash-receipt` — caller is `review-payment-submission`
    (internal only). Both also `verify_jwt = true` in
    `supabase/config.toml`.

    User-permission-gated edge functions (staff frontend callers
    only, no service-role path): `fix-account-status` — requires
    valid user JWT + `hasPermission(user.id, 'system_health')`.
    `system-health-check` — requires valid user JWT + `user_roles`
    IN (`admin`, `staff`, `finance`, `csr`).
    `get-page365-order` — requires valid user JWT + `user_roles`
    IN (`admin`, `staff`, `finance`, `csr`). Only caller:
    `InvoiceGeneratorSheet.tsx` (`invoke`). Reads the Google Drive
    CSV mirror by invoice number — it does NOT call Page365. Left
    untouched by the 2026-09-19 import work; the two coexist.
    `page365-fetch-order` — requires valid user JWT + `user_roles`
    IN (`admin`, `staff`, `finance`, `csr`), `verify_jwt = true`.
    Link in, parsed draft out; never writes an order.
    Never reintroduce an `isInternalKey` or anon-key bypass on
    any of these.

    `verify-portal-pin` — public-facing endpoint, **no**
    `verify_jwt = true` (intentional). Auth handled internally
    by `resolvePortalAuth`. PIN data lives in `customer_pins`
    table — NOT `customers`. `customers` is queried for `id` +
    `mobile_number` only. PIN hashing: PBKDF2-SHA256, 100,000
    iterations, 16-byte salt, format
    `pbkdf2:{saltHex}:{hashHex}`. Legacy SHA-256 hashes migrate
    on next successful login. Never revert to SHA-256. Never
    move PIN columns back to `customers`.

    `customer_pins` table (added 2026-06-07, Bug #177): RLS
    enabled, no SELECT policy for `authenticated`. Only
    `service_role` can read (via RLS bypass).
    `portal_pin_hash`, `portal_pin_attempts`,
    `portal_pin_locked_until` were DROPPED from `customers` on
    2026-06-07. Do not add PIN columns back to `customers`
    under any circumstances.

    `fix-account-totals` — service-role-only gate. No frontend
    or edge-function callers. Manually-triggered admin utility
    that rewrites `total_paid`, `remaining_balance`, schedule
    `paid_amount`, and allocation records across active accounts;
    must stay behind the service-role claims gate +
    `verify_jwt = true`.

