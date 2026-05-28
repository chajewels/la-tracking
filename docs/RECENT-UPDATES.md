## Recent Updates

  2026-05-28 — record-payment rate limit: downpayment submissions now
  5 per account per 24h (counted on downpayment submissions alone);
  installment/other submissions unchanged at 3. Commit ec8843f.

  2026-05-25 — customer-statement feature fully deleted (commit 7f38d37,
  FIXED-BUGS #153): src/pages/CustomerStatement.tsx + entire
  supabase/functions/customer-statement/ directory removed. /statement
  route, statement_token field, statementUrl calc, and View Full Statement
  button stripped from CustomerPortal. statement_tokens query removed from
  customer-portal edge fn; Check 9 removed from system-health-v2.
  customer-portal + system-health-v2 redeployed via Lovable IDE.

  2026-05-25 — Loyalty tier_changed downgrade transactions now logged
  (commits 0272587 code, da0b6fc docs marker, FIXED-BUGS #156). Both
  downgrade paths in loyalty-inactivity-check (expiry-triggered and
  gap-triggered) now insert tier_changed rows to loyalty_transactions
  with notes explaining the cause ("6+ months inactivity" / "{N}-day
  purchase gap"). Matches the upgrade path emission shape in
  award-loyalty-points (L670–705). Non-blocking inserts. Deployed via
  Lovable IDE.

  2026-05-25 — Deferred items resolved (FIXED-BUGS #154, #155):
  send-transactional-email auto-deploy was already wired correctly via
  the _shared/** path filter in supabase-functions-deploy.yml (Bug #103
  closed by design); RLS file 6 (Phase B policies) was already deployed
  via migrations 20260504000005 + 20260504000006 — the "deferred"
  marker was stale.

  2026-05-25 — Documentation handover: docs/HANDOVER-2026-05-25.md and
  docs/NEXT-SESSION-PROMPT.md added (commits fdec3cd, 35d8519, 2433a93).

  2026-05-24 — Settings → Team deactivate/reactivate (FIXED-BUGS #148,
  commit 30d817a): create-team-member gains action:'deactivate'|
  'reactivate' (admin/manage_team gated, self-deactivation blocked).
  Deactivate sets profiles.status='inactive' + bans auth login;
  reactivate restores + unbans. user_roles row kept so member stays
  listed and historical attribution is preserved.

  2026-05-24 — Settings → Roles & Permissions live matrix (FIXED-BUGS
  #149, commit f8828fb): hardcoded Quick Comparison table replaced with
  a live read-only matrix driven by usePermissions().allPermissions,
  reusing the Permission Matrix's exported PERMISSION_MODULES + ROLES
  catalog. Permission Matrix By Member picker (FIXED-BUGS #150, commit
  7538aa5) restricted to actual team members via .filter(p => p.role).

  2026-05-24 — Customer profile leak closed (FIXED-BUGS #151 commit
  ecd0daa, #152 commit 3a4a884): create-team-member stamps
  user_metadata.is_team_member=true on the auth user; handle_new_user
  trigger only creates a profile when that flag is true. Customers no
  longer get profiles rows; 80 leftover role-less profiles cleaned.

  2026-05-24 — Realtime dashboards live cross-user (FIXED-BUGS #147,
  commit bc98e02): supabase_realtime publication populated with 7 core
  mutating tables + financial_alerts. Single global useRealtimeSync
  hook mounted once at the App root, gated on internal-user predicate
  (admin/staff/finance/csr) so the customer portal never subscribes.
  Debounced 250ms invalidate of REALTIME_INVALIDATE_KEYS on any
  postgres_changes event.

  2026-05-24 — Finance forecast 0.85 risk haircut removed (FIXED-BUGS
  #146, commit 8c54bad): Expected Next Month, Predicted (30d/90d), and
  the 6-Month Cashflow chart's gold "adjusted" bars repointed to
  undiscounted values (next_month_expected, predicted_30d/90d_raw).
  Predicted (30d/90d) cards relabeled "Expected (30d/90d)". Chart
  dropped its gold bar, "Adj:" figure, and "Risk-Adjusted (85%)"
  legend. OPEN-BUGS D8/D9 closed.

  2026-05-24 — Upcoming Receivables cumulative oldest card (FIXED-BUGS
  #145, commit f52438c): forecastCards collapses every bucket dated
  on/before last month into one aged card ("Overdue · incl. earlier"
  when applicable), keeping current → +5 as individual cards. SQL
  get_forecast_6m lower bound removed; get_forecast_drilldown accepts
  AGED:YYYY-MM sentinel.

  2026-05-24 — Monitoring polish: Extension Requests shows customer
  name not invoice (FIXED-BUGS #143, commit e944eb7); Penalty Follow-Up
  stage tooltips render per-currency totals via formatCurrency instead
  of a cross-currency sum stamped with hardcoded ₱ (FIXED-BUGS #144,
  commit 8b91f5c).

  2026-05-23 — Finance chart terminology standardized (FIXED-BUGS #139,
  commit eeb80f3) + CHART TERMINOLOGY convention recorded in CLAUDE.md
  (commit 88f85f8): "Collected" always means cash received; the
  schedule-efficiency metric is "Paid vs Due". Penalty/forfeited labels
  unified across Overview and Analytics tabs.

  2026-05-23 — Dashboard collections/today test-account leaks closed
  (FIXED-BUGS #142, commit b9319f7): dashboard-summary's todayPayQ /
  monthPayQ payment sums got the account join + canonical numeric
  filter. Finance Collections-tab "This Month" card points at server
  summary.collections_this_month so it matches Overview.
  dashboard-summary redeployed via Lovable IDE.

  2026-05-23 — Collections tab test-account payment leak closed
  (FIXED-BUGS #138, commit 5f96cf5): collFiltered gained
  .filter(p => accountMap.has(p.account_id)), excluding payments
  belonging to test accounts (TEST-*, CJ-2026-*) from the Today/
  Yesterday/Week/Month/Year cards and Payment Feed.

  2026-05-23 — Settings → Team and Finance CSR Performance now list
  only internal team (FIXED-BUGS #141 commit 9d57b2f, #136 commit
  ed9a08b): fetchMembers / profilesWithRoles dropped the
  || 'staff' / || 'unknown' default and filtered to profiles with a
  real user_roles entry.

  2026-05-23 — Dashboard "Overdue & Due Soon" widget test-account
  filter (FIXED-BUGS #140, commit 7b1b494): OverdueAlerts.tsx
  schedule_with_actuals query gained the canonical numeric-only
  invoice filter on the embedded join. Completes the test-exclusion
  sweep on the one Dashboard widget the #124–131 pass missed because
  it queries directly rather than via dashboard-summary.

  2026-05-22 — Schedule cache staleness MISDIAGNOSIS closed (commit
  017c82a): an apparent "stale-high cache" framing was wrong —
  total_due_amount holds the GROSS per-row obligation
  (base + penalty + carried) and divergence from actual_remaining
  equals the row's allocated amount, by design. Exactly one genuine
  stale row found (INV 17325 inst 5), repaired via SQL. CLAUDE.md
  PAYMENT ALLOCATION RULES section gained a CACHE-STALENESS TEST.

  2026-05-21 — Bug #117 carry-drop redeployed (was on main, never
  deployed live): penalty-engine / add-penalty / approve-waiver now
  preserve carried_amount on total_due_amount recompute. Census:
  21 carried rows, only INV #18693 wiped. Repaired via SQL.
  CLAUDE.md CARRIED_AMOUNT PRESERVATION section added.

  2026-05-20 — System-wide test-exclusion sweep complete (FIXED-BUGS
  #131): 18 SQL reporting RPCs (13 fc_*, get_collection_analytics,
  get_monthly_sales, get_forecast_6m, get_forecast_drilldown,
  get_top_outstanding_customers) migrated to the canonical numeric-only
  rule invoice_number ~ '^[0-9]+$'. Frontend surfaces (Dashboard,
  CSR Monitoring, Smart Reminders, Extensions, Audit panels) and
  dashboard-summary edge fn previously swept in #124–130. CLAUDE.md
  TEST ACCOUNT EXCLUSION section added.

  2026-05-20 — Retroactive enrollment award + Lovable workspace
  email rate-limit hardening (CLAUDE.md sections added). Duplicate
  daily-payment-reminders cron retired (the real fix behind
  Bug #114's transient 429s).

  2026-05-19 night — Phase B/C/D cleanup patch (commit 413bf0b):
  (1) CREATE writes invoice_number=NULL for shipping_fee/service_fee/
  catalog_reward (REDEEM-{id} placeholder removed; column nullable since
  2026-05-19). (2) APPROVE bell body now type-aware — points-only types
  include the customer's notes inline (bell was already unconditional;
  Gap-2 "FK gate" premise was false, nothing ungated). (3) loyalty-redeem
  email renders "Purpose: {notes}" for points-only vs "Applied to: INV #…"
  for new_order_discount (notes added to templateData + template prop).
  CLAUDE.md locked type-rules table extended with invoice_number column +
  bell + email rules. Deploy: process-loyalty-redemption +
  send-transactional-email (registry coupling). new_order_discount paths
  and VOID branch unchanged.

  2026-05-19 evening — Design correction: shipping_fee and service_fee
  redemptions are now strictly points-only (no FK, no invoice_number,
  required notes). Last night's locked rules incorrectly tied these to
  existing accounts. Phase B/C/D Patch (commit fa8b6f7):
  process-loyalty-redemption CREATE/APPROVE/VOID branches type-aware,
  RedemptionForm strips order picker for shipping/service and adds
  required notes textarea, RedemptionApprovalModal displays notes
  prominently. Historical cancelled redemptions referencing TEST-004
  (08d1d0e0, af636465, bfd0da07) remain as audit artifacts of the
  pre-correction design.

  2026-05-19 morning — Phase 7-bis: ported fetchWithRetryOnRateLimit
  helper to daily-reconciliation (commit 7ac176f). Fixes silent
  account skip on Supabase outbound rate limit (empirical: 2026-05-19
  01:00 UTC cron skipped invoice 18175 and TEST-001). Same pattern
  as Bug #114 / Phase 7 fix in send-reminders. Issue 3 resolution
  rationale documented; stale "do not use redemption flow" warning
  at line ~6692 removed (contradicted resolved status).

  2026-05-18 evening — Redemption end-to-end shipped: Phase B
  (synthetic payment + inline waterfall allocation on approve,
  commits 2b0fb64/2afca0f/8130ace), Phase C (type-aware form +
  picker + mobile fix, af6bcba/ce70934/64a0b25/3d073c8), Phase D
  (RedemptionApprovalModal type-aware labels), Phase E (this
  CLAUDE.md sync). Redemption-wiring Issues 1+2+3 RESOLVED &
  VERIFIED end-to-end (cash 19034 + layaway TEST-004 08d1d0e0);
  reconcile-account confirmed diagnostic-only; payments
  submitted_by_type CHECK + schema facts documented; void-path
  cleanup (D1), atomic rollback (D2), GAS-delete sync (D3)
  deferred.

  2026-05-19 07:34 UTC — Customers menu mobile crash fixed (commit 165c51a).
  Option A active-letter-only grouped view. Was Bug #80 follow-up; grouped view
  rendered all 662 CustomerCards causing iOS WebKit OOM. Mobile test confirmed.

  2026-05-19 mid-session — DB UPDATE: TEST-001 status active→completed (cache
  sync; audit 12/12 pass). TEST-004 status overdue→active (canonical audit
  reports no rows currently overdue).

  2026-05-19 07:58 UTC — RedemptionForm.tsx dead-code cleanup (commit 210dcb2).
  -51 net lines: deleted unused state (selectedOrderId/Kind, loadingOrders,
  ordersError), unused useMemo (eligibleOrders), unused helpers. tsc green.

  2026-05-19 08:34 UTC — RedemptionForm orders-fetch dual-auth fix (commit
  f941e6e). Phase B Step 4-B2 5th missed call site closed: orders-fetch now uses
  getPortalAuthHeaders helper, sending Bearer JWT for session-auth (email/password)
  customers and ?token=X for legacy token-auth. Previously sent anon key as
  Authorization Bearer (broken for both modes — Path 0 silently rejected, no
  fallback worked). Empirically verified: customer Carl Aurel Largo redeemed
  new_order_discount on his account 20000.

  2026-05-19 08:38–08:39 UTC — First real-customer end-to-end Phase B Patch 2
  verification on account 20000: redemption a31bf7b1 (confirmed, 200 pts, ¥200)
  → synthetic payment 61f354ca (ref LOYALTY-a31bf7b1) → allocation fcc68f51
  (installment, schedule row 1, ¥200) → row 1 partially_paid (paid_amount=200)
  → account total_paid +200. Carl then submitted ¥7,500 Rakuten Bank payment
  (implicit DP); final state: total_paid 7,700, remaining 17,300, status active.
  audit_account('20000') all 12 checks pass. 43-phase Issues 1+2+3 empirically
  closed twice (TEST-004 08d1d0e0 + Carl 20000 a31bf7b1).

  2026-05-19 09:09 UTC — Bug #82 THIRD occurrence (commit 9e3bd1f). Bulletproof
  table-anchor replaces React-Email <Button> across 5 auth templates
  (signup/recovery/magic-link/invite/email-change). Root cause: React-Email
  Button renders nested <span> that Yahoo strips. Empirically verified on
  h8redthanblue@yahoo.com at 18:23 JST. See Bug #82 entry for universal rule.

  2026-05-19 evening — Sequence 2 (customer portal auth migration) scope
  collapsed. feature/email-password-auth branch confirmed gone (Scenario C:
  work shipped incrementally to main over the past 2 weeks). Original 'HIGH
  risk, dedicated test session needed' framing no longer applicable. Remaining
  items: P5 session timeout (LOW, ~45min), P3 loyalty staff visibility
  (feature), P6 admin audit log (feature).
