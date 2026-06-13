# Edge Function Audit — 2026-06-12

Post-mortem audit triggered by the loyalty award outage (Bug #223, 4 days
silent, root cause `4833407`, fixed `233fefc`). Goal: find every other
instance of the same failure class — silently broken internal auth,
unchecked HTTP responses, swallowed try/catch failures, unwired hooks,
and orphan functions.

**Scope:** `supabase/functions/**` plus `supabase/config.toml`. Frontend
references checked only to determine whether a function has a caller.

**Method:** static grep + manual inspection. No live invocation, no DB
queries, no deployed-state introspection.

---

## Severity-ranked finding summary

| Severity | Finding | File:line | Notes |
|---|---|---|---|
| **LIVE-BROKEN** | `process-loyalty-notification-queue` gates internal callers with a local `isServiceRoleCaller()` that requires `parts.length !== 3` (must be a 3-segment JWT) — env-injected `SUPABASE_SERVICE_ROLE_KEY` in non-JWT format fails the check | `process-loyalty-notification-queue/index.ts:33-47, 231` | Same failure class as Bug #223. Cron-only function with `verify_jwt = true`; if Lovable injects an `sb_secret_*` style key, every cron tick 401s silently. |
| **LIVE-BROKEN** | `cleanup-loyalty-images` has the same local `isServiceRoleCaller()` that requires JWT format | `cleanup-loyalty-images/index.ts:56-69, 130` | Cron-only (Sun 03:00 UTC per CLAUDE.md). Same exposure. |
| **LIVE-BROKEN** | `parse-import-docs` has a SECOND inline JWT-decode service check that contradicts the shared `isServiceRole` it already imports | `parse-import-docs/index.ts:159-166` | L137 already correctly uses shared `isServiceRole`; L160-164 then redundantly re-decodes via raw `atob(token.split('.')[1])` and assigns to a local `isServiceRole` variable that **shadows the imported helper**. If the env key isn't a JWT, that local goes false and the function falls into the user-JWT path. Currently the user-JWT path also exists so it doesn't 401, but it bypasses the documented "service role only" intent for whichever code path consumes the local. |
| **OBSERVABILITY-GAP** | 27 of 32 functions with internal `functions/v1/` calls do not check `lpRes.ok` / `.status` anywhere near the fetch | full grep below — see Check 3 detail | Every one of these has the *exact same* silent-401 exposure that produced the Bug #223 4-day outage. Any non-200 from the callee flows through into a body-merge or a try/catch with no surfaced trace. |
| **OBSERVABILITY-GAP** | `process-loyalty-redemption` has 4 inter-function fetches (lines 510, 548, 891, 951) with no response-status check at any site | `process-loyalty-redemption/index.ts:510, 548, 891, 951` | Both approve and void paths emit sheet syncs + transactional emails with zero failure surface. A silent outage here would silently desync the redemption sheet and silently drop the redemption-confirmation email. |
| **OBSERVABILITY-GAP** | `void-payment` calls `revoke-loyalty-points` and `send-transactional-email` without status check | `void-payment/index.ts:270, 336` | A bug in revoke would leave points on a voided payment with no notice. |
| **OBSERVABILITY-GAP** | `auto-forfeit-settlement` calls `revoke-loyalty-points` and `send-transactional-email` without status check | `auto-forfeit-settlement/index.ts:88, 125` | Forfeit-driven point revocation is the same class as the Bug #223 incident — internal hop with no surface. |
| **OBSERVABILITY-GAP** | `join-loyalty-program` calls `award-loyalty-points`, `send-transactional-email`, `sync-loyalty-to-sheet` without status check | `join-loyalty-program/index.ts:231, 272, 306` | Retroactive enrollment award + welcome email + member sheet sync all silently fail. |
| **LATENT-RISK** | `parse-import-docs` → `bulk-import` forwards `Authorization: authHeader` (the original caller's JWT) rather than the service role | `parse-import-docs/index.ts:242` | Works because bulk-import accepts both service-role and user JWT (it checks `isServiceRole(token)` at L110 and routes accordingly). But: if `bulk-import`'s service-role gate ever tightens to require service-role exclusively, this caller breaks; conversely, this lets a customer-portal call (extremely unlikely given the staff-gate above L137) flow into bulk-import as a user. Document the contract or change the caller to use SRK. |
| **WIRING-AT-RISK (cron)** | 17 functions show signs of cron/pg_net invocation but the actual `cron.schedule` rows live in Postgres only — repo has no canonical list | See Check 5 inventory | Asked-for cross-check input. Lovable-managed Supabase Dashboard is the only source of truth for the live cron. |
| **ORPHAN — likely dead** | `bulk-send-setup-invites` — only referenced from `docs/AUTO-DEPLOY.md` and `migrations/20260507000001_bulk_setup_invite_candidates.sql`; zero callers in repo (no frontend, no other edge function, no recent cron note) | `supabase/functions/bulk-send-setup-invites/index.ts` | Confirm with Cynthia whether the Phase B bulk-invite sweep is still operational or has retired. If retired, remove function + config gate. |
| **ORPHAN — likely dead** | `preview-transactional-email` — referenced only by `config.toml` and the FIXED-BUGS log of the security batch that hardened it | `supabase/functions/preview-transactional-email/index.ts` | Looks like an admin/devtool endpoint. Confirm intent. |
| **ORPHAN — confirmed dead per CLAUDE.md** | `restructure-account` — CLAUDE.md Bug #199 batch A note explicitly calls this out: "restructure-account has no UI callers today (orphan function)" | `supabase/functions/restructure-account/index.ts` | Decision was to leave deployed with the matrix gate; this audit just confirms the decision is still current. |
| **EXPECTED ORPHAN (external invoker)** | `auth-email-hook` — Supabase's auth webhook target; no in-repo caller by design | `supabase/functions/auth-email-hook/index.ts` | Not orphan in operational sense; included for completeness. |

---

## Check 1 detail — Service-role gates

### Functions on the FIXED pattern (shared `isServiceRole`, accepts env-injected SRK)

20 functions imported and use the shared helper from `supabase/functions/_shared/jwt-claims.ts`:

```
append-cash-receipt:25, auto-expire-cash-orders:31, auto-forfeit-settlement:37,
award-loyalty-points:52, bulk-import:110, daily-reconciliation:117,
finance-reconciliation:45, fix-account-totals:29, loyalty-inactivity-check:121,
loyalty-sheet-reconcile:45, parse-import-docs:137, penalty-engine:33,
process-email-queue:90, reconcile-account:38, restore-loyalty-points:50,
revoke-loyalty-points:70, send-reminders:113, send-transactional-email:58,
sync-backup-sheets:76, sync-loyalty-to-sheet:159, system-health-v2:73
```

These are the Bug #222 + #223 + `c76806c` sweep targets.

### Functions on the BROKEN pattern (local JWT-only decode)

| Function | Line | Pattern | Live-broken? |
|---|---|---|---|
| `process-loyalty-notification-queue` | L33-47 (def) / L231 (gate) | Local `isServiceRoleCaller(req)`: rejects `parts.length !== 3` → any non-JWT key 401s | YES — cron-only, no fallback path |
| `cleanup-loyalty-images` | L56-69 (def) / L130 (gate) | Identical local helper to above | YES — Sun 03:00 UTC cron |
| `parse-import-docs` | L159-166 | Redundant inline `atob(...)` decode shadowing the imported `isServiceRole` from L137 | PARTIAL — falls back to user-JWT path, so doesn't 401, but the documented service-role-only branch silently goes dead |

The two "LIVE-BROKEN" entries above don't import `isServiceRole`; they duplicate the broken pattern in a private helper. The minimal fix in both is the same as the Bug #223 sweep — replace with `isServiceRole(token)`.

### Note on parse-import-docs L159-166 specifically

```ts
const token = authHeader.replace("Bearer ", "");
let isServiceRole = false;                                    // ← local shadow
try {
  const payload = JSON.parse(atob(token.split('.')[1]));     // ← raw decode, fails on non-JWT
  isServiceRole = payload.role === 'service_role';
} catch (_) {}

if (!isServiceRole) {                                         // ← references the local
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  ...
}
```

The function already imported the shared helper at L1 and used it correctly at L137 (the outer cron-only gate). This second inline block was either added separately and not migrated by the Bug #222 sweep, or pre-dates the sweep and was missed. The shadowing means a service-role caller (env-injected non-JWT key) goes into the user-JWT branch — works only because `supabase.auth.getUser(SRK)` happens to succeed in some environments.

---

## Check 2 detail — Internal call map

### Caller → callee inventory (with Authorization header)

| Caller | Callee | Auth header | Callee gate | Mismatch? |
|---|---|---|---|---|
| `restore-payment:225, 489` | `restore-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `restore-payment:462` | `reconcile-account` | `Bearer SRK` | `isServiceRole` ✅ (post-233fefc) | OK |
| `customer-portal:233` | `sync-loyalty-to-sheet` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `reactivate-account:224, 265` | `send-transactional-email`, `restore-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `add-installment:12`, `delete-installment:12`, `extend-schedule:12` | `reconcile-account` | (verify each) | `isServiceRole` ✅ (post-233fefc) | Need spot-check |
| `daily-reconciliation:181, 258` | `reconcile-account`, `award-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK (post-Bug #223) |
| `award-loyalty-points:506, 653` | `send-transactional-email`, `sync-loyalty-to-sheet` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `submit-payment:302`, `submit-cash-payment:254` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `parse-import-docs:238` | `bulk-import` | `Bearer ${authHeader}` (forwards caller's JWT) | `isServiceRole` OR user JWT | **LATENT** — see L131 finding |
| `send-loyalty-notification:168` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `loyalty-inactivity-check:61, 94` | `send-transactional-email`, `sync-loyalty-to-sheet` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `send-reminders:270, 312` | `send-transactional-email` (×2) | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `loyalty-sheet-reconcile:136` | `sync-loyalty-to-sheet` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `process-loyalty-redemption:510, 548, 891, 951` | `send-transactional-email`, `sync-loyalty-to-sheet` (×2 paths × 2 hops) | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `process-loyalty-notification-queue:168` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `adjust-loyalty-points:242` | `sync-loyalty-to-sheet` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `delete-account:68` | `revoke-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `auto-expire-cash-orders:62` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `manual-forfeit:128, 172` | `send-transactional-email`, `revoke-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `review-payment-submission:819, 861, 995, 1110, 1189, 1320, 1399` | `send-transactional-email`, `award-loyalty-points`, `append-cash-receipt` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `approve-waiver:216` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `penalty-engine:555` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `restore-loyalty-points:169` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `join-loyalty-program:231, 272, 306` | `award-loyalty-points`, `send-transactional-email`, `sync-loyalty-to-sheet` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `void-payment:245, 270, 336` | `reconcile-account`, `send-transactional-email`, `revoke-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `auto-forfeit-settlement:88, 125` | `revoke-loyalty-points`, `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `void-cash-payment:177` | `revoke-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `restore-cash-payment:174` | `restore-loyalty-points` | `Bearer SRK` | `isServiceRole` ✅ | OK |
| `revoke-loyalty-points:225` | `send-transactional-email` | `Bearer SRK` | `isServiceRole` ✅ | OK |

**One row to act on:** parse-import-docs → bulk-import forwards the caller's JWT. Document the contract or switch to SRK.

---

## Check 3 detail — Unchecked HTTP responses

For every function with `functions/v1/` calls, did the code anywhere reference `.ok` or `.status` on the response object?

| Function | Internal fetches | Status checked? |
|---|---:|---|
| add-installment | 1 | ❌ |
| adjust-loyalty-points | 1 | ❌ |
| approve-waiver | 1 | ❌ |
| auto-expire-cash-orders | 1 | ❌ |
| auto-forfeit-settlement | 2 | ❌ |
| award-loyalty-points | 2 | ❌ (sheet sync wraps non-2xx as `console.warn` — see L701, 746, 833) |
| customer-portal | 1 | ❌ |
| daily-reconciliation | 2 | ❌ |
| delete-account | 1 | ❌ |
| delete-installment | 1 | ❌ |
| extend-schedule | 1 | ❌ |
| join-loyalty-program | 3 | ❌ |
| loyalty-inactivity-check | 2 | ❌ |
| loyalty-sheet-reconcile | 1 | ✅ |
| manual-forfeit | 2 | ❌ |
| parse-import-docs | 1 | ✅ |
| penalty-engine | 1 | ❌ |
| process-loyalty-notification-queue | 1 | ❌ |
| process-loyalty-redemption | 4 | ❌ |
| reactivate-account | 2 | ❌ |
| redeem-portal-token | 1 | ❌ |
| restore-cash-payment | 1 | ❌ |
| restore-loyalty-points | 1 | ❌ |
| restore-payment | 3 | ❌ |
| **review-payment-submission** | 7 | ✅ (after `aaca9cd` on 3 award sites; transactional-email + append-cash-receipt sites still unchecked) |
| revoke-loyalty-points | 1 | ❌ |
| send-loyalty-notification | 1 | ❌ |
| send-reminders | 2 | ✅ |
| submit-cash-payment | 1 | ❌ |
| submit-payment | 1 | ❌ |
| void-cash-payment | 1 | ❌ |
| void-payment | 3 | ❌ |

**Net: 27 of 32 callers do not check response status.** Every one of these has the same silent-failure exposure that produced the Bug #223 4-day outage. The minimal fix at each site is the same shape as `aaca9cd`:

```ts
const res = await fetch(...);
const body = await res.json().catch(() => null);
if (!res.ok) {
  // surface body.error ?? `http_${res.status}` somewhere visible
}
```

---

## Check 4 detail — config.toml verify_jwt cross-check

30 functions declare `verify_jwt = true`:

```
append-cash-receipt, auto-expire-cash-orders, auto-forfeit-settlement,
award-loyalty-points, bulk-import, carry-over, cleanup-loyalty-images,
daily-reconciliation, edit-schedule-item, finance-reconciliation,
fix-account-status, fix-account-totals, get-page365-order,
loyalty-inactivity-check, loyalty-sheet-reconcile, parse-import-docs,
penalty-engine, process-email-queue, process-loyalty-notification-queue,
reconcile-account, record-multi-payment, record-payment,
restore-loyalty-points, revoke-loyalty-points, send-reminders,
send-transactional-email, set-portal-pin, sync-backup-sheets,
sync-loyalty-to-sheet, system-health-check
```

Every internal caller in the map above sends `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`. The Supabase gateway will accept that on `verify_jwt = true` because the env-injected SRK *is* a valid project-issued credential for gateway purposes — gateway validates project membership, not the `parseJwtClaims` shape that broke 4833407. **No gateway-level rejection is expected for any in-repo internal call.**

One asymmetry worth flagging: **`process-loyalty-notification-queue` and `cleanup-loyalty-images`** are both `verify_jwt = true` AND on the broken local-JWT decode pattern. Gateway accepts the call; the in-function gate then rejects it. Net result: 401 from the handler, not 401 from the gateway. Same outcome (silent failure), just at a different layer.

---

## Check 5 detail — Expected-wiring inventory (for live cron cross-check)

The repo doesn't contain the canonical cron schedule — that lives in `cron.job` in Postgres. CLAUDE.md L425+ lists the documented schedule, which the live `cron.job` table should match:

| Function | Documented schedule (CLAUDE.md) | Cron-only? | Status |
|---|---|---|---|
| daily-send-reminders / send-reminders | 00:00 UTC daily | YES | Confirmed cron-style |
| daily-penalty-engine / penalty-engine | 00:05 UTC daily | YES | Confirmed cron-style |
| daily-auto-forfeit / auto-forfeit-settlement | 00:10 UTC daily | YES | Confirmed cron-style |
| daily-reconciliation | 00:20 UTC daily | YES | Confirmed cron-style |
| loyalty-inactivity-check | 00:25 UTC daily | YES | Confirmed cron-style |
| auto-expire-cash-orders | 00:30 UTC daily | YES | Confirmed cron-style |
| deactivate-expired-promotions | every hour | unclear | Function not present in repo — investigate |
| loyalty-notification-queue / process-loyalty-notification-queue | every hour | YES | Confirmed cron-style |
| fc-alert-evaluation | every 30 min | YES | Function not present — uses `fc_evaluate_alerts` RPC instead |
| process-email-queue | every 5 seconds | YES | Confirmed cron-style |
| cleanup-loyalty-images | Sun 03:00 UTC | YES | Confirmed cron-style |
| loyalty-sheet-reconcile | hourly :07 UTC | YES | Confirmed cron-style |
| sync-backup-sheets | 0 18 * * * UTC (03:00 JST) | YES | **NOT YET DEPLOYED** per SYSTEM-STATUS.md — cron entry should be added at first deploy |
| finance-reconciliation | unclear from docs | unclear | Has cron-style auth (service-role gate, no body required), no documented schedule. Verify against `cron.job`. |
| fix-account-totals | manual operator-only (admin utility) | NO | Cron-shape auth but not scheduled |
| fix-account-status | admin-only frontend invocation | NO | Frontend-called per Bug #170 |

**Ask of you (or operator with cron.job access):** dump `cron.jobid, jobname, schedule, command` and confirm:
1. Every "cron-only" entry above has a live cron row.
2. No live cron row points at a deleted/missing function.
3. `sync-backup-sheets` cron row exists or is queued for the next deploy.
4. `deactivate-expired-promotions` and `fc-alert-evaluation` are accounted for (likely live but with a different function name or RPC trigger).

### Live reconcile 2026-06-13

Live `cron.job` dump (2026-06-12, authoritative):
- HTTP jobs (Vault-backed Bearer secret `email_queue_service_role_key`):
  send-reminders 00:00 daily · penalty-engine 00:05 daily ·
  auto-forfeit-settlement 00:10 daily · daily-reconciliation 00:20 daily ·
  loyalty-inactivity-check 00:25 daily · auto-expire-cash-orders 00:30 daily ·
  cleanup-loyalty-images Sun 03:00 · process-loyalty-notification-queue hourly ·
  loyalty-sheet-reconcile hourly at :07 · process-email-queue every 5s (gated)
- SQL-only jobs (no edge function call):
  deactivate_expired_promotions hourly · fc_evaluate_alerts every 30 min

**(1) Functions Check 5 expects to be cron-wired but NOT in the live dump:**
- `sync-backup-sheets` — expected per Check 5 row "0 18 * * * UTC (03:00 JST)" and explicitly flagged "NOT YET DEPLOYED". Live confirms still not scheduled. Track as a queued first-deploy item, not a regression.
- `finance-reconciliation` — Check 5 row flagged "unclear from docs… Verify against cron.job". Live confirms NOT scheduled. The function carries cron-shape service-role auth scaffolding but has no live invoker. Either (a) intentional — the schedule will be added when a real caller is identified — or (b) stale scaffolding from an earlier design. Owner decision needed; no operational impact today.

**(2) Live jobs NOT documented in Check 5:** none. All 12 live jobs (10 HTTP + 2 SQL) appear in the Check 5 table.

**(3) Schedule mismatches:** none. Every documented "cron-only=YES" row matches the live schedule minute-for-minute:
  - 00:00 / 00:05 / 00:10 / 00:20 / 00:25 / 00:30 daily ✓
  - Sun 03:00 UTC ✓
  - hourly (process-loyalty-notification-queue) ✓
  - hourly at :07 (loyalty-sheet-reconcile) ✓
  - every 5 seconds (process-email-queue) ✓
  - every 30 minutes (fc_evaluate_alerts SQL) ✓
  - hourly (deactivate_expired_promotions SQL) ✓

Naming reconciliation: live uses the unprefixed function names (`send-reminders`, `penalty-engine`, `auto-forfeit-settlement`) — Check 5 enumerated both `daily-*` and unprefixed variants on those rows, so the live names already match. The "Function not present in repo — investigate" notes on rows 212 (deactivate-expired-promotions) and 214 (fc-alert-evaluation) are RESOLVED: both are intentionally SQL-only cron jobs, not missing edge functions.

**Result:** repo + live cron are in sync. Only outstanding items are the two known gaps in Check 5 column 4 (`sync-backup-sheets` queued, `finance-reconciliation` needs an owner decision).

---

## Check 6 detail — Sync pipelines

### Loyalty sheet sync

- **Writer of marker `loyalty_transactions.synced_to_sheet_at`:** `award-loyalty-points` at L690, L735, L822 (earned / bonus / tier_changed branches).
- **Invoked by:** the fast path is `award-loyalty-points` itself calling `sync-loyalty-to-sheet` over HTTP at L653. The recovery path is `loyalty-sheet-reconcile` (cron `7 * * * *`), which queries `loyalty_transactions WHERE synced_to_sheet_at IS NULL` and replays them through the same sync endpoint.
- **Wired:** YES — both paths are present in the repo. Per CLAUDE.md "SHEET SYNC ARCHITECTURE — NON-NEGOTIABLE" this is documented and load-bearing.
- **Caveat:** `award-loyalty-points` checks the sync response status only via `console.warn` on non-2xx (L701, 746, 833). The marker is written BEFORE the HTTP call, so a non-2xx leaves the marker timestamped but the sheet unsynced — `loyalty-sheet-reconcile` would NOT pick it up because its query filters on `synced_to_sheet_at IS NULL`. **This is a real, latent observability gap.**

Recommend: write the marker only on `res.ok`. Currently the marker race makes the recovery path blind to sync HTTP failures.

### Backup sheet sync

- **Writer:** `sync-backup-sheets` (overwrites all 4 tables daily).
- **Invoked by:** documented cron `0 18 * * *` UTC. Not yet deployed per SYSTEM-STATUS.md.
- **Wired:** function exists; cron pending first deploy.

### Payment tracking sync

- **Writer:** `fill-payment-tracking` (used by frontend).
- **Frontend caller:** `supabase.functions.invoke('fill-payment-tracking', ...)`.
- **Wired:** YES — frontend-invoked, not cron.

---

## Check 7 detail — Orphans + dangling references

### Confirmed dead (recommend removal or explicit retention note)

- **`bulk-send-setup-invites`** — referenced only by `docs/AUTO-DEPLOY.md` and an old migration. No frontend invocation, no internal-function caller. CLAUDE.md says it relates to Phase B portal setup invites which may have completed.
- **`preview-transactional-email`** — referenced only by `config.toml` (security-batch entry) and an older FIXED-BUGS log. Likely admin/devtool; no production caller.
- **`restructure-account`** — CLAUDE.md Bug #199 batch A explicitly documents this as orphan. Kept deployed with matrix gate; intentional retention.

### Cron-invoked (NOT orphans in operational sense, but no in-repo caller)

```
auto-expire-cash-orders, auto-forfeit-settlement, cleanup-loyalty-images,
daily-reconciliation, finance-reconciliation, loyalty-inactivity-check,
loyalty-sheet-reconcile, penalty-engine, process-email-queue,
process-loyalty-notification-queue, send-reminders, sync-backup-sheets
```

### External-invoker (NOT orphans)

- `auth-email-hook` — Supabase auth webhook target.
- `customer-portal` — called by customer portal via direct `fetch` (not the `supabase.functions.invoke` SDK).
- `verify-portal-pin`, `setup-customer-account`, `submit-payment`, `submit-cash-payment`, `edit-payment-submission`, `handle-email-unsubscribe`, `handle-email-suppression` — same pattern (portal direct-fetch).

### Dangling references

None found. (My initial regex flagged `system-health-v`, but that was a regex truncation of `system-health-v2` — the function exists and is called by `SystemHealthCheckPanel.tsx:127` and `UnifiedSystemHealthTab.tsx:273`.)

---

## Recommended fix order

1. **TODAY (live-broken)** — Replace the local `isServiceRoleCaller` in `process-loyalty-notification-queue` and `cleanup-loyalty-images` with the shared `isServiceRole` from `_shared/jwt-claims.ts`. Same single-line fix as `c76806c`. Both are cron-only and silently broken right now if the env key is non-JWT.
2. **TODAY (latent)** — Remove the redundant inline decode block at `parse-import-docs/index.ts:159-166` so the imported shared `isServiceRole` isn't shadowed. Behavior change: the shadowed branch is currently bypassed; making the helper authoritative restores documented behavior.
3. **THIS WEEK (observability gap, system-wide)** — Apply the `lpRes.ok` check pattern from `aaca9cd` at the remaining 27 sites. Highest-impact targets first: `process-loyalty-redemption` (4 hops), `void-payment` (revoke), `auto-forfeit-settlement` (revoke), `join-loyalty-program` (3 hops).
4. **THIS WEEK (sync-marker race)** — In `award-loyalty-points` L690 / L735 / L822, move the `synced_to_sheet_at` UPDATE to AFTER the HTTP success check so `loyalty-sheet-reconcile` can pick up the failure.
5. **WHEN CONVENIENT** — Decide on `bulk-send-setup-invites` and `preview-transactional-email`. Retain or remove.
6. **CRON CROSS-CHECK** — Dump `cron.job` and reconcile against the Check 5 table.

---

## What this audit did NOT do

- No live invocation. Every "live-broken" call-out is from static analysis. The two broken-pattern functions could be sleeping (no recent cron tick) and the rest of the system unaware. A `cron.job` + recent invocation log review is the only way to know for sure.
- No DB query for cron schedule. The Check 5 table is from CLAUDE.md only.
- Did NOT audit RLS-side gates — only HTTP-layer auth between functions.
- Did NOT audit shared helpers other than `jwt-claims.ts` (mentioned in spec); `check-permission.ts` and `loyalty-email-gate.ts` were excluded from the gate scan because they're permission-domain helpers, not service-role gates.
