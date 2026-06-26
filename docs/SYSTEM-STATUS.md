# System Status — last updated 2026-06-19

## App Version
1.4.0 (commit 02a040c)

## 2026-06-26 — PWA prompt-with-auto-apply update flow
- Changed the service worker update semantics from silent auto-update to
  prompt-with-auto-apply. `registerType` is now `'prompt'` (was `'autoUpdate'`)
  with `injectRegister: false`; the SW is registered explicitly in `main.tsx`
  via `registerSW({ onNeedRefresh })`. The `workbox`/`manifest` config is
  unchanged.
- On a new build activating, `onNeedRefresh` dispatches a `pwa:need-refresh`
  window event. `usePwaUpdate()` surfaces this as `updateReady`.
- `src/lib/pwaUpdate.ts` holds the `updateSW` handle (`setUpdateSW`) and a
  dirty-form registry (`markFormDirty`/`markFormClean`/`hasDirtyForm`).
  `applyUpdate()` calls `updateSW(true)` (activates the waiting SW + reloads),
  falling back to `window.location.reload()` if the handle isn't set yet.
- Customer portal: a guarded one-time auto-reload effect fires on a clean
  landing (time-gated via `sessionStorage` key `pwa-update-ts`, 10s window —
  mirrors the `vite:preloadError` pattern in `main.tsx`). When a guarded form
  is dirty it does NOT auto-reload; instead a portal-styled banner ("A new
  version is available. Reload to load the latest update." + Reload button)
  lingers until the user reloads. Guarded forms: payment submission
  (`portal-payment`) and profile edit (`portal-profile`). The extension-request
  flow is intentionally NOT guarded.
- Hub: the existing update banner's Reload button now calls `applyUpdate()`
  instead of a bare `window.location.reload()` (a bare reload won't activate the
  waiting SW under `'prompt'`). `useVersionCheck` is otherwise unchanged.
- Both surfaces (portal + Hub) covered. Net effect: customers and Hub users
  land on the latest build with no manual reload, except when a guarded form is
  mid-edit (then they choose when via the banner).

## 2026-06-26 — Service Status in customer portal
- `service_jobs` are now surfaced read-only in the customer portal. Each job
  exposes customer-safe fields only: `id`, `service_type`, `service_status`,
  `status_label`, `service_description`, `service_fee`, `date_received`,
  `estimated_completion`, `date_completed`, `invoice_number`.
- Jobs are nested per layaway account and per cash order by `invoice_number`,
  rendered as a "Service Status" panel mirroring the existing "Additional
  Services" markup (layaway account detail view + cash order card).
- Jobs that don't resolve to a card land in a top-level `other_services` guard
  bucket, rendered as an "Other Services" section on the portal home (shows a
  "Re: INV #…" reference line when an invoice number is present).
- Status label map: Logged→Received, Process/On-going→In Progress,
  Pending→On Hold, Cancelled, Completed. Badges are dark-gold/dark-theme pills.
- `service_fee` is displayed in the parent card's currency (other_services uses
  `summary.primary_currency`); no per-job currency is invented.
- Edge change (nest + guard bucket in customer-portal) shipped in commit
  1e37e88; frontend rendering ships in this commit. No edge deploy in this push.

## Firebase Hosting CI auto-deploy — FIXED 2026-06-26 (commit 349cf91)

**Symptom:** Every GitHub Actions deploy failed at the auth step with:
`Error: Invalid response body while trying to fetch https://www.googleapis.com/oauth2/v4/token: Premature close`
→ `Failed to authenticate, have you run firebase login?`
Broken since ~mid-May 2026. Previously misattributed to "secret issues."

**Real root cause:** A Node.js bug (nodejs/node#63989, firebase-tools#10692). A recent Node security release broke keep-alive socket handling in the node-fetch/gaxios HTTP stack that firebase-tools uses to fetch OAuth tokens from googleapis.com. Affects Node 22.23.0 and 24.17.0. NOT a credentials, secret-format, firebase-tools-version, or network/infra problem — every auth method failed identically because all hit the same broken token fetch.

**Fix:** Pinned the runner's Node version to 24.16.0 in .github/workflows/firebase-deploy.yml (actions/setup-node node-version: '24.16.0'). 24.16.0 is the last Node release before the regression — the firebase team's own documented mitigation. One-line change; deploy went green immediately.

**Ruled out during debugging (do not re-try these):** regenerating the service-account key; FIREBASE_TOKEN / firebase login:ci (Google now invalidates these tokens immediately — deprecated path, dead end); echo vs printf for the JSON; gcloud auth activate-service-account; wrong project ID. None were the cause.

**Auth mechanism in use:** service-account JSON in GitHub secret FIREBASE_SERVICE_ACCOUNT, written to a file at deploy time with GOOGLE_APPLICATION_CREDENTIALS. firebase-tools pinned to @13.

**TODO — remove the Node pin later:** firebase-tools has merged a fix (retry without keep-alive) but it is NOT yet on npm (latest is still the broken 15.22.2 as of 2026-06-26). Once a patched firebase-tools is published, the Node 24.16.0 pin can be removed and setup-node returned to a normal LTS version. Until then, leave the pin in place.

**Manual deploy fallback (always works, ~1 min):**
Run as sales@chajewelsjp.com (owns project cha-jewels-la-tracking):
`cd ~/la-tracking && git pull origin main && npm run build && firebase deploy --only hosting --project cha-jewels-la-tracking`
If CLI is on the wrong account: `firebase login:use sales@chajewelsjp.com` first.

## 2026-06-25 — Proactive update-notification signal (frontend-only)
- Proactive "new version available" signal for staff shipped. The build emits
  `/version.json` (the 7-char commit SHA) via an inline `emit-version-json` Vite
  plugin; a `/version.json` `NetworkOnly` runtimeCaching rule keeps the poll out
  of the SW cache.
- `useVersionCheck` (`src/hooks/useVersionCheck.ts`) polls `/version.json` every
  60s and on tab-focus, comparing the served SHA to the booted SHA (`__APP_VERSION__`).
- `AppLayout` shows a dismissible banner (Reload / X) when an update is detected
  and passes `updateAvailable` to `AppSidebar`, which renders an amber
  "v … · update pending" version label.
- Purely additive — does NOT touch the PWA `autoUpdate` registration, the
  `vite:preloadError` listener, or the `RootErrorBoundary` (stale-chunk recovery
  stays as-is).
- KNOWN LIMITATION: the deploy that ships this feature does not itself surface a
  banner (booted SHA == served SHA); only subsequent deploys trigger it.

## 2026-06-19 — System Audit clean
- System Audit clean as of 2026-06-19: 0 schema-drift rows, 0 per-account health failures.
- `audit_delete_cleanup_invariants()` returns zero rows — the `payment_proofs.cash_order_id`→`cash_orders` FK (2026-06-15) is now allowlisted (cash_orders is soft-cancel only, no DELETE step). See Bug #232.
- `audit_account()` CHECK-10 gained a `v_dp_overpaid` term so DP overpayment no longer false-fails the pending-vs-remaining reconciliation (e.g. invoices 19119, 19128). See Bug #233.
- Commission `sales_log.eligible` auto-check fixed (Bug #234) — Pending→Paid transitions now auto-qualify; trigger `autocheck_sales_log_eligible()` rewritten.
- Extension/forfeiture clean-vs-dirty rule shipped (48d5cfab): penalty-engine extension bump gated on all-earlier-paid; auto-forfeit Rule A gated on priorUnpaid (LOCKED file, owner-authorized). Open: reactivate-account `extension_end_date` should be cycle-accurate. See Bug #235.

## 2026-06-19 — Timesheet hardening + payroll data repairs
- Timesheet hardening (2026-06-18→06-19): manual-fill focus fix + busy-latch regression resolved (f1ec119); overnight punch-out auto-closes prior day at 23:59 (f3e0a70); custom TimeSelect replaced native time input, manual minutes limited to 00/30 with off-grid values preserved (31585c2, d4a32fb); PWA cache headers added (f1ec119); midnight pm_out=00:00 read as 24:00 (9360961).
- Payroll data repairs (2026-06-18): night-shift split rows restored (b84ce337); migration column misfill corrected by moving out-times am_out→pm_out — Block 1 = 3 rows (live_admin, am_in also a PM time), Block 2 = 55 rows (incl. 30 noon=12:00); post-check returned 0 remaining; pay proven unchanged (formula symmetric) and both UPDATEs idempotent.

## 2026-06-18 — Timesheet manual-fill + overnight punch fixes
- Timesheet (CSR Operations → Timesheet) manual fill is usable again. Cell
  edits and punches no longer trigger the page-level `load()` (which flipped
  `loading`, swapped the grid for the skeleton, and unmounted the editing input
  every keystroke). The My Timesheet tab now merges each saved row into
  `myEntries` in place via `onEntrySaved` (replacing `onRefresh`), and the grid
  time inputs dropped `disabled={busy}` so typing is never blocked. (Bug #226)
- Overnight punch-out handled (Option A): the workday runs 08:00 → 00:00, so an
  out-punch before 08:00 with no open shift today but an unclosed clock-in
  yesterday now closes yesterday's `pm_out` at 23:59 (clamped — the single-row
  day-grid model can't carry a punch past midnight), instead of filing a stray
  next-day `am_out` that left the prior shift open at 0 hours / ₱0 pay. (Bug #227)
- KNOWN FOLLOW-UP: historical rows already corrupted by the old overnight
  behavior (split shifts with a stray am_out / unclosed pm_out) are NOT
  retroactively repaired by this change — they await a separate data-repair pass.

## 2026-06-17 — Finance dashboard layout + Monthly Cash Orders chart
- Finance → Overview reflowed for a more compact top: MonthlyAnalyticsChart
  now renders its two charts independently via a `show` prop
  ('both' | 'performance' | 'sales'). The "Monthly Performance" bar chart
  (show="performance", lg:col-span-2) now fills the former Aging/Cashflow slot
  beside the "New Layaway Sales · This month" daily card (lg:col-span-1) in a
  single 3-column row right under the KPI cards. The "Monthly Layaway Sales"
  chart (show="sales") sits below the Monthly Cash Orders chart, where the full
  combined MonthlyAnalyticsChart used to sit.
- Lower row now mirrors the top row's column widths: Monthly Layaway Sales
  (show="sales", lg:col-span-2, left — aligned under Monthly Performance) beside
  Monthly Cash Orders (lg:col-span-1, right — aligned under the New Layaway daily
  card), in a 3-column grid with lg:items-start. The Monthly Cash Orders chart
  now renders as an area chart with a green gradient fill (was a plain line).
- Aging Buckets and the "6-Month Cashflow Forecast" block MOVED OUT of
  Overview into the Analytics tab, in a 2-column grid directly above the
  Staff Performance section.
- New chart: Monthly Cash Orders (src/components/finance/MonthlyCashOrdersChart.tsx)
  — a JPY line chart (PHP converted) rendered on Overview immediately after
  the Cash Orders KPI row. Backed by new RPC get_cash_orders_monthly()
  (returns month / cash_jpy / order_count). 6M/1Y/All range toggle; shares
  the isValid + year-range corrupt-date guard with MonthlyAnalyticsChart.
- Realtime: cash_orders added to useRealtimeSync SYNC_TABLES, and
  'cash-orders-monthly' added to REALTIME_INVALIDATE_KEYS, so the cash chart
  refetches live on cash-order writes.
- Bug #225: Monthly Performance "All" range no longer crashes on corrupt-date
  rows (years 0002/0004/32025) from get_monthly_analytics — see FIXED-BUGS.md.

## 2026-06-12 — v1.2.0
- Product Inquiry Tracker shipped under CSR Monitoring → Inquiries
- Two tabs: Inquiry List (filterable, paginated, add/edit) + Demand Map
- Demand Map: Top 20 most inquired items (gold bar chart), Demand
  Intelligence Quadrant (scatter: volume vs conversion rate), Top 20
  most frequent inquirers (purple bar chart)
- 805 rows migrated from Google Sheet on launch (803 initial + 2
  multi-category source rows recovered via INSERT on 2026-06-12)
- order_placed backfilled from source CSV on 2026-06-12:
  No 367 / Yes 85 / Joy Mine 3 / blank 350
- 18 date corrections applied 2026-06-12 (17 future-date typos
  + 1 unparseable source date)
- All dropdowns configurable via inquiry_dropdown_options table with
  inline + Add in form
- Tables: product_inquiries, inquiry_dropdown_options
- Permission keys: view_inquiries + manage_inquiries (all 4 roles)
- Blank filter added to Action Needed (null + empty) and Order Placed
  (null) for unset rows
- 2026-06-12: Demand Map gained Order Placed filter (applies to all
  charts) and Repeat Inquirers table (same customer, same item, 2+
  inquiries)
- Sales Commission module (/commissions) live — sales_log (735 rows incl Dec 2025)/commission_agents/commission_splits, generalized merge_groups role merging, GAS algorithm replicated client-side (winner-take-all, one role per agent, amount tiebreaker), Config tab admin-only, sheet retired to backup.
- Timesheet feature shipped (2026-06-13): CSR Operations → Timesheet (`/timesheet`); tables `timesheet_profiles` / `timesheet_entries` with per-user RLS (own rows) + admin/finance read-all; pure-TS engine `src/lib/timesheetEngine.ts` + page `src/pages/Timesheet.tsx` (Commissions precedent, no edge function); tabs: My Timesheet (all staff, live punch in/out), Consolidation (admin/finance), admin-only Cost Master + Assignments; PHP throughout; gating is RLS + in-page `roles.includes` (no role_permissions keys).
- 2026-06-14 — Timesheet SHIPPED & LIVE on main/production. Pure-TS pay engine + RLS, no edge function. Tabs: My Timesheet / Consolidation / Cost Master / Full Summary (admin) / Assignments (admin). Historical payroll imported (20 summary rows, 2024-10..2026-05). June 2026 backfilled live per-person (5 CSR). 31-row spillover now loads + counts (9f835f0a + e8878d05). Commit trail: ffb82fa8 -> 9e846464 -> 9f835f0a -> e8878d05.
- 2026-06-14 — Staff-bell audio-notification backend emitters shipped: `submission_confirmed` (review-payment-submission, cash + layaway confirm), `penalty_applied` (penalty-engine, aggregated per run), `account_forfeited` (auto-forfeit-settlement 4 paths + manual-forfeit). All fire-and-forget (try/catch, console.warn, never throw). Code push only — not yet deployed.
- 2026-06-14 — Removed duplicate edge-function `submission_confirmed` inserts from review-payment-submission; payment-confirmed bell row + chime/speech now ride the existing `notify_submission_reviewed` trigger.
- SYNC-BACKUP-SHEETS: daily live mirror of `sales_log`, `commission_agents`, `commission_splits`, `product_inquiries` to Google Sheet `1bc1hdHJLic3vCVr4CbuG6o9BRPcwCDF0Pfd5xJbKOKo` (one tab per table, named after the table). Full overwrite — each run clears the tab and rewrites header + all rows. Paginated reads (1000 rows/page) so the default PostgREST limit can't truncate the backup. Cron `0 18 * * *` UTC (03:00 JST) via pg_cron with Vault-stored service-role bearer; gateway `verify_jwt = true` + in-function `parseJwtClaims(token).role === 'service_role'` (penalty-engine posture). Google auth via the shared `_shared/google-auth.ts` helper (`GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_ADMIN_EMAIL`). Per-table try/catch: a failed table is logged and added to `errors`; sibling tables continue. Response: `{ synced: { table: rowCount }, errors: [{ table, error }] }`; 200 when every table syncs cleanly, 500 if any failed.
- Loyalty award outage 2026-06-08 → 2026-06-12: commit `4833407` changed award-loyalty-points' service-role check to `parseJwtClaims(token)?.role === "service_role"`; the env-injected service-role key is not a JWT, so every internal call 401'd and the non-blocking call site swallowed it. Fixed by `233fefc` (Bug #223). Missed awards for invoices 19111 (+400 pts) and 19094 (+3,400 pts) backfilled via manual `award-loyalty-points` calls on 2026-06-12 and verified. Live path re-verified same day: 0.77s award latency on test invoice 4567; revoke-on-void also verified. Hardening applied (same day, post-outage): daily-reconciliation sweep lookback widened 25h → 14 days (oldest-first, page limit 500) so any future outage longer than one daily cycle is still drainable; review-payment-submission now surfaces PART D `isCustomerLoyaltyEnrolled` skips as `{ skipped: true, reason: "pre_check_not_enrolled" }` traces in the response (reason isn't anomalous, so no notification — just diagnosable); explicit `lpRes.ok` check added at all three award call sites (cash, single-submission DP, multi-account DP) so a non-200 hits the failure-notification path with `{ error: <body-error or http_NNN>, status: NNN }` rather than flowing through silently. Edge function audit (docs/EDGE-FUNCTION-AUDIT-2026-06-12.md, commit `e1a5bea`) follow-up: local service-role gates in process-loyalty-notification-queue and cleanup-loyalty-images replaced with shared helper (Bug #223 class, verified format-fragile not live-broken — hourly queue cron confirmed processing 2026-06-12 13:40 UTC with zero backlog). Redundant decode removed from parse-import-docs. Remaining audit items (27-site unchecked-response sweep, synced_to_sheet_at reorder, totals-update idempotency) tracked for this week.
- Services + Trade-Ins sidebar converted to parent with sub-items
  (Service Jobs / Trade-Ins) — v1.1.1 fix carried forward

## Active Features (shipped)
- CA Bot AI command interface (`✨` button in AppLayout)
  - CREATE_CUSTOMER: DB insert, toast confirmation
  - CREATE_LAYAWAY_ACCOUNT: navigates to /accounts/new with pre-fill
  - CREATE_CASH_ORDER: navigates to /cash-orders/new with pre-fill
  - RECORD_PAYMENT single: opens RecordPaymentDialog with invoice + method pre-filled
  - RECORD_PAYMENT split: opens MultiInvoicePaymentDialog with current month per account
  - ASK_POLICY: answers from knowledge base + live DB tools
  - New customer detection: warns + opens New Customer dialog pre-filled
  - Multilingual: Tagalog and English
- AI Customer Insights dialog (Customer Detail → AI Insights button)
  - Excludes 2026-03-22 migration-batch penalty records (816 artifacts)
- Services Tracking module (/services) — service_jobs table, 178 records migrated
- Trade-In Tracker (/services?tab=trade-ins) — trade_ins table, 8 records migrated
- Policy Hub (/policy-hub) — 8-tab iframe page
- Security: portal PIN migrated to PBKDF2-SHA256, customer_pins table
- Session timeout (AuthContext, commit 1adfa15)
- Admin Audit Log (/admin-activity)
- Loyalty staff visibility
- Phase B email/password auth (100% complete)
- tier_changed emission (commit 0272587)
- approve_redemption_atomic PL/pgSQL RPC (verified fixed 2026-06-08)

## Edge Functions Deployed
- ai-command-parser (Gemini 2.5 Flash primary, GPT-5-mini fallback)
- ai-customer-insights
- All other edge functions current as of main

## AI Model
- Primary: google/gemini-2.5-flash (via Lovable gateway)
- Fallback: openai/gpt-5-mini
- Knowledge base: static system prompt + live DB tools
  (query_customers, query_accounts, query_payments,
   count_accounts, query_loyalty, query_loyalty_tiers,
   query_system_settings)

## Open Bugs
- (none currently tracked)

## Resolved (do not re-list)
- P1 void atomicity: VERIFIED FIXED 2026-06-09 (void_redemption_atomic RPC, edge function refactor)
- P1 approve atomicity: VERIFIED FIXED 2026-06-08
- P5 session timeout: shipped 2026-05-26
- P6 admin audit log: shipped 2026-05-26
- P3 loyalty staff visibility: closed
- Currency toggle Path A/B: Dashboard removed 2026-05-23
- customer-statement deletion: complete 2026-05-25
- Phase B email/password auth: 100% complete
- Bug #103 auto-deploy: closed 2026-05-25
- tier_changed emission: shipped 2026-05-25
- PWA Phase A: abandoned 2026-05-04

### Cash Order Edit Expiry — gate aligned to RLS UPDATE policy (2026-06-09)

  The Edit Expiry button in CashOrderDetail rendered under
  `(isAdmin || isFinance)`, but the underlying RLS UPDATE policy
  `staff_admin_update_cash_orders` allows admin OR staff. Two
  pre-existing mismatches:

    - Finance users saw the button but hit RLS errors on submit
    - Staff users had UPDATE permission but no UI button

  Gate changed to `(isAdmin || isStaff)` so UI matches RLS. CSR and
  customer roles remain blocked from editing (unchanged).

  No RLS policies, edge functions, or cron jobs touched. Auto-expiry
  cron `auto-expire-cash-orders` (jobid=17, 30 0 * * *) still runs.
  Cash orders still expire if unpaid past `expires_at`, and admin/
  staff can extend the deadline from the Edit Expiry button on the
  cash order detail page.

  Data fix: cash_order id 4a39facc-d9a6-499e-818e-e6bbf03c384a
  (invoice #19114, customer Pedersen Dee, ¥9,800 of ¥79,048 paid)
  was reset from status='expired' to status='pending' with
  expired_at cleared. Test orders #3456 and #1234 left as 'expired'
  per merchant decision.

### Loyalty redemption void — atomic via void_redemption_atomic RPC (2026-06-09)

  The void branch of process-loyalty-redemption was ~700 lines of
  inline TypeScript doing ~15 sequential DB writes across loyalty +
  order tables (refund tx, redemption flip, member balance, loyalty_jpy
  restore, synthetic payment void, allocation revert, schedule revert,
  account totals revert, stock re-increment, audit log, account_notes).
  Outer try/catch swallowed all errors into console.warn — meaning any
  step after refund tx could fail and leave the customer in a partial
  state: refund tx exists + redemption cancelled but member balance not
  updated, or member credited + customer's order still shows discount
  applied, or partial allocation revert leaving orphaned rows on a
  voided payment.

  Migrated to public.void_redemption_atomic(uuid, uuid, text, text)
  PL/pgSQL RPC modeled on approve_redemption_atomic's pattern. Single
  transaction with FOR UPDATE locks on loyalty_redemptions, loyalty_
  members, loyalty_rewards; relative arithmetic on member balance;
  faithful port of schedule status reversal rules (paid/overdue/
  partially_paid/pending cascade based on remaining due + due_date);
  faithful port of account status reversal (completed → overdue if
  any layaway_schedule.status='overdue' else active); faithful port
  of cash_orders.status revert (completed → pending when remaining > 0).

  account_notes insert moved INSIDE the atomic boundary and uses
  symmetric format with approve: "Loyalty: redemption voided — N pts
  refunded (type) — ¥M removed from balance" (or ₱M for PHP).

  Edge function void branch collapsed from ~700 to ~180 lines:
  auth + input validation, single supabase.rpc call, error code
  mapping (redemption_not_found → 404, redemption_not_confirmed →
  400, redemption_void_race → 409, member_not_found → 404, schedule_
  row_not_found → 500, other → 500), all side effects preserved
  (staff_notifications, email gate 'loyalty_email_redemption_voided',
  Phase 4.2 in-app notification, sync-loyalty-to-sheet 'revoked'
  event). Response shape unchanged: { voided, redemption_id,
  points_refunded, stock_re_incremented }.

  Lot tables (loyalty_point_lots, loyalty_lot_consumption) intentionally
  NOT touched. Earlier verification (2026-06-09) showed loyalty_lot_
  consumption has zero rows in production — consume_lots_fifo is never
  called from approve_redemption_atomic. void_redemption_atomic stays
  symmetric: neither touches lots. If consume_lots_fifo activates in
  approve later, void RPC needs amendment to call restore_lots_for_
  redemption simultaneously.

### approve-waiver — migrated to role_permissions matrix (2026-06-10)

`approve-waiver` edge function previously used hardcoded `has_role(admin) OR has_role(finance)` gate, ignoring the `role_permissions` Settings matrix. Migrated to use `_shared/check-permission.ts` helper with permission key `manage_waivers`. UI buttons in `Waivers.tsx` now also gated via `can('manage_waivers')`.

**Phase 1 of broader role-permissions audit.** 74 edge functions total; 30 currently use hardcoded `has_role` gates; 4 already use `checkPermission` (create-team-member, delete-customer, fix-account-status, review-payment-submission); the rest are system/cron/customer-side and intentionally not matrix-gated.

**Phase 2 scope (high-impact staff-facing, scheduled separately):** record-payment, record-multi-payment, void-payment, void-cash-payment, restore-payment, restore-cash-payment, edit-payment-amount, create-cash-order, create-layaway-account, restructure-account, plus fixing the multi-role-user bug in `_shared/check-permission.ts` (uses `.maybeSingle()` on `user_roles` which fails for users with >1 role row).

**Phase 3 scope (admin-only and lower-traffic, scheduled separately):** delete-account, delete-installment, add-installment, extend-schedule, carry-over, add-service, adjust-loyalty-points, award-loyalty-points, restore-loyalty-points, revoke-loyalty-points, bulk-import, set-portal-pin, accept-underpayment, dashboard-summary, system-health-v2, finance-reconciliation, generate-invoice.

**Audit-surfaced data integrity issues (separate cleanup):**
- Matrix is missing keys referenced in code: `view_cash_orders`, `create_cash_order` (used in `PAGE_PERMISSION_MAP`), `view_geo_breakdown` (used in `Dashboard.tsx` via `can()`).
- Naming mismatch: `PAGE_PERMISSION_MAP` references `payment_submissions` but matrix uses `view_submissions`.
- `/waivers` route is not in `PAGE_PERMISSION_MAP` — page reachable via URL even when matrix denies. Phase 2 item.

### Penalty waiver unwaive flow — migrated to atomic RPC (2026-06-10)

`Waivers.tsx` UI `handleUnwaive` previously did 3 separate client-side supabase writes to `penalty_fees`, `layaway_schedule`, and `layaway_accounts` but never reset `penalty_waiver_requests.status`. Result: orphan waiver_request rows stuck at `approved` while the corresponding penalty was unpaid/paid. UI displayed inconsistent state, and admins couldn't re-test approve flows post-unwaive (waiver never re-entered pending queue).

Migrated to atomic PL/pgSQL RPC `public.unwaive_penalty_atomic` called via new edge function `unwaive-waiver` (auth gate via `checkPermission(manage_waivers)`). Three historical orphans backfilled (Roselia #18603, Monika #17933, Maria #17110) — see Bug #193 in FIXED-BUGS.md.

**Pattern:** Mirrors `approve_redemption_atomic` (2026-06-08) and `void_redemption_atomic` (2026-06-09). All three atomic-reverse RPCs follow the same shape: `SECURITY DEFINER` + `search_path = public` + jsonb return with `error_code` mapping.

**Known related asymmetry — Bug #194 (scheduled next session):** `penalty-engine` cron at `supabase/functions/penalty-engine/index.ts` L362 also programmatically converts waived penalties back to unpaid without resetting `penalty_waiver_requests`. Separate semantic context (system-driven re-evaluation, not user reversal), so fix design may differ.

### `_shared/check-permission.ts` — migrated to multi-role iteration (2026-06-10)

The shared permission helper used by 4 edge functions previously assumed each user has exactly one role row in `user_roles`. Refactored to fetch all role rows, mirror the UI's `usePermissions().can()` iteration pattern, and support composite roles (admin + finance, staff + admin, etc.).

Dependent edge functions requiring redeploy after this change: `approve-waiver`, `unwaive-waiver`, `manual-forfeit`, `reactivate-account`. Supabase bundles `_shared/` files at deploy time, so the helper update doesn't propagate to running functions until each is redeployed.

**Pattern:** This completes item 2 of the locked 4-item Phase 2 of the role_permissions matrix audit (after Bug #192 / Bug #193). Remaining items: orphan/naming cleanup in PermissionMatrixTab (item 3), and Phase 2 migrations of 10 hardcoded staff-facing edge functions (item 4).

### Permission matrix / route gating cleanup — Bug #197 closed, Bug #198 deferred (2026-06-10)

Item 3 of locked Phase 2 scope closed. PermissionMatrixTab UI now exposes 3 previously-orphaned DB keys (`view_cash_orders`, `create_cash_order`, `view_geo_breakdown`), and `/waivers` route is now gated through PAGE_PERMISSION_MAP + NAV_PATHS (previously URL-accessible without permission check). DB prerequisite UPDATE applied pre-commit to set `staff/view_waivers=true` so Brenda retains the approve-waiver workflow access shipped in Bug #192.

Audit during Bug #197 closure revealed 11 additional DB-only permission keys absent from the matrix UI — documented as Bug #198 for deferred follow-up. Not blocking Phase 2 item 4 (10-edge-function hardcoded gate migration).

### Phase 2 Item 4 scope discovery — 28 functions, not 10 (2026-06-10)

Original Phase 2 plan estimated ~10 staff-facing edge functions still using hardcoded `has_role()` checks for role_permissions matrix migration. Cloud Shell enumeration during Bug #197 closure revealed **28 functions** still using the pattern. Four already migrated to `checkPermission()` via earlier Phase 2 work: `approve-waiver` (Bug #192), `unwaive-waiver` (Bug #193), `manual-forfeit`, `reactivate-account`.

**Effective Item 4 scope:** 28 functions broken into 6 batches by domain. Each batch ≈ one session of investigation → SQL verify role_permissions row exists for target key → Lovable code prompt → Lovable deploy prompt → smoke test → docs entry per function.

| Batch | Domain | Functions | Likely permission keys |
|---|---|---|---|
| A | Account lifecycle | create-layaway-account, create-cash-order, delete-account, restructure-account, carry-over | create_account, create_cash_order, delete_account, edit_account, edit_schedule |
| B | Payment writes | record-payment, record-multi-payment, void-payment, restore-payment, accept-underpayment | record_payment, void_payment, restore_payment |
| C | Cash + schedule | submit-cash-payment, void-cash-payment, restore-cash-payment, add-installment, delete-installment, extend-schedule, edit-payment-amount | record_payment, edit_schedule |
| D | Loyalty admin | adjust-loyalty-points, award-loyalty-points, revoke-loyalty-points, restore-loyalty-points | loyalty_adjust_points (Bug #198 dependency — key missing from matrix UI) |
| E | Admin/Finance + dashboard | bulk-import, finance-reconciliation, generate-invoice, add-service, dashboard-summary | bulk_payment_import, view_finance, view_dashboard |
| F | Special cases | system-health-v2 (parseJwtClaims target NOT checkPermission), set-portal-pin (customer-facing semantics — investigation first) | — |

**Cross-cutting concerns flagged for Batch D and E:**
- Batch D depends on Bug #198 fix (`loyalty_adjust_points` not in matrix UI yet) OR migration without UI exposure until #198 closes
- `dashboard-summary` may not need a permission gate at all — read-only summary endpoint; investigate intent before migrating
- Batch C cash payment keys may share `record_payment` permission with native payments OR have separate cash-specific keys — DB verification required

**Status:** Items 1-3 of Phase 2 closed (Bug #192, #193, #196, #197). Item 4 = 5-6 future sessions, starts with Batch A in a fresh session.

### Phase 2 Item 4 Batch A complete — 5 account lifecycle functions on checkPermission (2026-06-10)

Batch A of the Item 4 batched migration plan complete. The role_permissions matrix UI in admin Settings is now the actual source of truth for account creation (layaway + cash orders), deletion, restructure, and carry-over operations. Admin toggling a permission in the matrix has real effect on these flows — no more hardcoded `has_role` checks ignoring the matrix.

**Functions migrated:** create-layaway-account, create-cash-order, delete-account, restructure-account, carry-over.

**DB pre-fix applied:** `edit_account` default tightened to admin-only (was admin+staff via legacy seed). Admin can grant other roles via matrix toggle.

**Known UI follow-up:** Bug #200 — EditAccountDialog UI gate at AccountDetail.tsx L1040 misgated, broader UI gate audit recommended.

**Remaining Item 4 scope:** Batch B (payment writes — 5 functions), Batch C (cash + schedule — 7 functions), Batch D (loyalty — 4 functions), Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin — 2 special cases). 23 functions remain across 5 future sessions.

### Phase 2 Item 4 Batch B complete — 5 payment write functions on checkPermission (2026-06-11)

Batch B of the Item 4 batched migration plan complete. The role_permissions matrix UI in admin Settings is now the actual source of truth for payment record, void, restore, and underpayment acknowledgment operations. Admin toggling permissions in the matrix has real effect on these flows.

**Functions migrated:** record-payment, record-multi-payment, void-payment, restore-payment, accept-underpayment.

**Behavioral changes (user-approved, matches matrix intent):**
- Staff GAINS auto-confirm capability when recording payments (was admin+finance only)
- Staff + finance GAIN ability to accept underpayments (was admin-only)
- Void / restore payment behavior preserved (admin+finance)

**No DB pre-fix UPDATEs required** — matrix seeds already matched user policy intent per the "matrix is source of truth" directive.

**Remaining Item 4 scope:** Batch C (cash + schedule — 7 functions), Batch D (loyalty — 4 functions), Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin — 2 special cases). 18 functions remain across 4 future sessions.

### Phase 2 Item 4 Batch C complete — 6 cash + schedule functions on checkPermission + 2 new cash keys (2026-06-11)

Batch C of the Item 4 batched migration plan complete. Cash payment operations now have dedicated permission keys independent from regular payment keys, allowing admin to grant cash void/restore access without affecting regular void/restore access (or vice versa). Schedule edit functions and payment amount edit now matrix-driven.

**Functions migrated:** void-cash-payment, restore-cash-payment, add-installment, delete-installment, extend-schedule, edit-payment-amount.

**New permission keys introduced (admin-only seed):** `void_cash_payment`, `restore_cash_payment`. Surfaced in PermissionMatrixTab UI under new "Cash Payments" section.

**Behavioral changes:** All migrations preserve current access (admin-only or admin+finance) per DB seeds matching prior code behavior. Future policy adjustments via matrix toggles.

**Scope carve-out:** submit-cash-payment deferred to Batch F. Its dual-path routing (customer self-submission vs staff submission) uses has_role for path discrimination, not permission gating. Requires careful refactor outside standard Batch C scope.

**Remaining Item 4 scope:** Batch D (loyalty — 4 functions), Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin + submit-cash-payment — 3 special cases). 12 functions remain across 3 future sessions.

### Phase 2 Item 4 Batch D complete — 4 loyalty admin functions on checkPermission + new permission key + matrix UI (2026-06-11)

Batch D of the Item 4 batched migration plan complete. Manual loyalty point operations (adjust/award/revoke/restore) now matrix-driven. Service_role inter-function calls preserved unchanged — automated loyalty flows triggered by payment voids, account forfeitures, and reactivations continue to operate without permission gates (correct behavior).

**Functions migrated:** adjust-loyalty-points, award-loyalty-points, revoke-loyalty-points, restore-loyalty-points (user JWT paths only).

**New permission key introduced (admin-only seed):** `loyalty_revoke_points`. Surfaced in PermissionMatrixTab UI alongside existing `loyalty_adjust_points` under new "Loyalty Admin" section in Loyalty module.

**Bug #198 partial close:** 2 of 11 missing matrix UI keys now surfaced (loyalty_adjust_points + loyalty_revoke_points). 9 keys remain (approve_cash_order, edit_cash_order, manage_trade_ins, view_trade_ins, recalculate_balance, run_reconciliation, view_ai_risk, view_live_collection, view_operations_panel, view_system_health). Bug #198 remains open for follow-up.

**Behavioral changes:** None for existing users — all migrations preserve current access (admin-only or admin+finance) per DB seeds matching prior code behavior. Future policy adjustments via matrix toggles.

**Remaining Item 4 scope:** Batch E (admin/finance + dashboard — 5 functions), Batch F (system-health-v2 + set-portal-pin + submit-cash-payment — 3 special cases). 8 functions remain across 2 future sessions.

### Phase 2 Item 4 Batch E complete — 5 edge functions on checkPermission + 2 new matrix UI keys + DB seed cleanups (2026-06-11)

Batch E of the Item 4 batched migration plan complete. Read-heavy and finance-tier admin functions now matrix-driven. Service_role inter-function calls preserved unchanged in bulk-import (automated bulk import flows) and finance-reconciliation (Vault cron reconciliation).

**Functions migrated:** bulk-import (user JWT path), finance-reconciliation (user JWT path), generate-invoice, add-service, dashboard-summary.

**Matrix UI key reuse (no UI changes needed):** `bulk_payment_import` (existed at Finance → Vault & Bulk Import), `add_service` (existed at Services module, label "Manage Services"), `view_dashboard` (existed at Dashboard module).

**New matrix UI keys introduced:** `run_reconciliation` (admin+finance) and `generate_invoice` (admin+staff+finance) appended to Finance module under new "Reconciliation & Invoicing" section.

**Bug #198 advancement:** `run_reconciliation` was on the missing-keys list (DB had partial seed, matrix UI didn't surface it) — now surfaced. 8 of original 9 remain (approve_cash_order, edit_cash_order, manage_trade_ins, view_trade_ins, recalculate_balance, view_ai_risk, view_live_collection, view_operations_panel, view_system_health).

**Behavioral changes:** None for existing users — all migrations preserve current access per DB seeds matching prior code behavior. DB seed cleanups (UPDATE add_service staff=false, UPDATE bulk_payment_import finance=false) tightened DB to match stated intent and code behavior; no roles GAINED or LOST access since the partial seeds didn't correspond to active code gates.

**Remaining Item 4 scope:** Batch F (system-health-v2 + set-portal-pin + submit-cash-payment — 3 special cases). 3 functions remain across 1 future session.

### Phase 2 Item 4 Batch F complete — Phase 2 Item 4 NOW COMPLETE (28 of 28 functions migrated) (2026-06-11)

Batch F closes Phase 2 Item 4 — the matrix-driven access control migration. All staff-facing edge functions now use `checkPermission` for access control with matrix UI as the source of truth. Service_role inter-function calls preserved unchanged via `parseJwtClaims` across all dual-auth functions.

**Functions migrated in Batch F:**
- system-health-v2 — Bug #168 fix (string equality → parseJwtClaims) + has_role → `system_health` (existing key, DB seed updated to preserve any-of-4-staff)
- set-portal-pin — has_role → NEW `set_customer_pin` (admin+staff)
- submit-cash-payment — has_role dispatch → NEW `submit_cash_payment_staff` (admin+staff+finance; matrix-driven path discrimination, not access gating)

**Bug #168 fully closed:** Zero remaining string-equality auth checks against `SUPABASE_SERVICE_ROLE_KEY` across the entire `supabase/functions/` codebase.

**Phase 2 Item 4 cumulative — 28 of 28 functions migrated across 6 batches:**
- Batch A (commit 42cc3a6): 5 account lifecycle functions
- Batch B (commit 8d06b8d): 5 payment write functions
- Batch C (commit 573afd5): 6 cash + schedule functions
- Batch D (commit 3714cb8): 4 loyalty admin functions
- Batch E: 5 admin/finance + dashboard functions
- Batch F: 3 special-case functions (this batch)

**Permission keys introduced across Phase 2 Item 4:**
- Batch C: void_cash_payment, restore_cash_payment
- Batch D: loyalty_revoke_points (loyalty_adjust_points existed)
- Batch E: run_reconciliation, generate_invoice (existing keys bulk_payment_import, add_service, view_dashboard reused)
- Batch F: set_customer_pin, submit_cash_payment_staff (existing key system_health reused)

**Bug #198 advancement:** Total of 3 missing matrix UI keys surfaced across Item 4 work (loyalty_adjust_points, loyalty_revoke_points, run_reconciliation). 8 remain (approve_cash_order, edit_cash_order, manage_trade_ins, view_trade_ins, recalculate_balance, view_ai_risk, view_live_collection, view_operations_panel, view_system_health). Bug #198 remains open for follow-up sweep.

**Behavioral changes:** None for existing users — all migrations preserved current access per DB seeds matching prior code behavior. The matrix-driven design now functions end-to-end: admins toggle permissions in Settings UI, DB row_permissions table reflects intent, edge functions check against DB via checkPermission, access matches what UI shows.

**Remaining Phase 2 work outside Item 4 scope (future sessions):**
- Bug #198 final cleanup: 8 missing matrix UI keys
- Bug #200 follow-up: UI gate audit (EditAccountDialog L1040 misgating fix + comprehensive can() audit)
- riskFactor dead-code cleanup in dashboard-summary (L450, 455, 560, 562, 565)

## Operational Cleanups Log

### 2026-06-11 — Phantom Payment Cleanups (4 accounts, single-staff origin)

**Context:** During Bug #206 reclassification work, identified 4 duplicate payment entries from staff user `69095b5d-3a96-4b67-adad-7cbf9d6c2aff` (Brendalyn Bumagat) created 2026-06-11. All were manual Record Payment entries created BEFORE the matching customer submission was reviewed — resulting in duplicate payment rows once the customer submission was confirmed by the same or another staff member.

**Accounts cleaned:**

| Invoice | Phantom Amount | Type | Cleanup notes |
|---------|---------------|------|---------------|
| 18271 | ¥7,200 | Installment | Simple cleanup — no competing legit payment; DELETE allocations + DELETE payment + reset schedule row |
| 18437 | ¥5,597 | Installment | Required CORRECTIVE step: legit payment's allocation landed on Month 5 via waterfall post-phantom-delete; manually moved to Month 4 via UPDATE payment_allocations.schedule_id |
| 18644 | ¥20,320 | Multi-month installment | Phantom had 5 allocations spanning Months 2/3/4 + 3 penalty_fees rows; standard cleanup left penalty_fees.status='paid' but legit ¥20,320 submission self-healed it on confirm via waterfall re-allocation |
| 19090 | ¥3,000 | Downpayment | Simple cleanup — DPs don't allocate to layaway_schedule rows; DELETE payment only (no allocations to clean) |

**Cleanup approach evolution (lessons captured during the session):**
1. Initial pattern (18271): DELETE payment_allocations → DELETE payment → UPDATE layaway_schedule SET status='pending', paid_amount=0
2. Refined (18437): Added "move legit allocation" step when the legit payment was placed on the wrong schedule row by waterfall after phantom delete
3. Further refined (18644): Discovered `penalty_fees.status` does not auto-reset on allocation delete; if a legit submission is queued, status='paid' self-heals via re-allocation; otherwise manual UPDATE required
4. Simplest (19090): DPs are account-level not schedule-level — only delete the phantom payment, no allocation/schedule reset

**Operational concern:** 4 phantoms from one staff user in a single day indicates workflow misunderstanding (using Record Payment instead of Confirm Submission when a customer submission is queued). The matrix policy itself (staff.confirm_payment=true post-#206-revert) is correct; what needs adjusting is process awareness. Coaching message planned for 2026-06-12.

**CLOSED 2026-06-13:** root cause = non-main deployed state of the confirm path on 2026-06-10/11 (formula including pending submissions, never present on main); overwritten by main-based deploys 2026-06-12; data corrected (18437, 19090); layaway confirm path now carries an atomic submission-status guard (e41e8b9) matching the cash path.

## Locked decisions (2026-06-12)

- **Migration lot `fc235e5f` (member `eb89f10d`, 1,440 pts, earned_at 2026-10-29 / expires 2027-04-27):** the source-sheet earned_at carries a date-typo year (2026-10-29 instead of the intended earlier year), pushing the derived expiry to 2027-04-27. Owner decision 2026-06-12: leave as-is — the resulting member-favorable expiry is treated as a bonus rather than corrected backward. Do NOT re-flag in future audits.
- **Backup-sheet mirror verification scope (2026-06-12):** mirror health is verified live (same-day sync timestamps, zero stale backlog). The verification scope covers MIRROR HEALTH ONLY — data content inside the backup sheets (legacy agent names Anna/Rea on the commission sheets, manual tabs, historical rows from the pre-migration sheet) is intentionally NOT reconciled against the live DB. Future audits should not surface those as drift.

- Batch 2: 27-site response-check sweep + synced_to_sheet_at reorder shipped 6bc2499 follow-up commit (this one). Coverage: 18 of 43 sites swept (process-loyalty-redemption ×4, void-payment ×3, auto-forfeit-settlement ×2, join-loyalty-program ×3, plus add-installment / delete-installment / extend-schedule reconcile helpers); 3 sync-marker sites in award-loyalty-points upgraded to console.error with explicit "marker left NULL so loyalty-sheet-reconcile will retry" — note: audit's "marker written BEFORE the HTTP success check" claim was incorrect, the UPDATE was already inside `if (sheetRes.ok && txId)` gates; the only real gap was log-level. Sweep complete 43/43 sites as of this commit.
- 2026-06-13: invoice 19031 duplicate award (split-DP 2026-05-20, pre-guard) corrected — lot 37885cb0 revoked, member totals −2,500; unique partial index uq_lots_active_order_earn_source added enforcing one active order_earn lot per invoice; award lot insert now ON CONFLICT DO NOTHING.
