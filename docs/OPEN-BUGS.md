## Known Open Bugs

  Bugs that have been surfaced and triaged but not
  yet fixed. Each entry should describe the fix
  pattern so the next session can pick it up cleanly.

### Portal token link shows "expired" when a stale signed-in session exists on the device (found 2026-06-06) — RESOLVED 2026-07-06

  **Symptom.** Customer reaches the portal via a fresh `?token=…` URL
  but lands on the link-expired screen. Token row is healthy
  (`customer_portal_tokens.is_active = true`, `expires_at` well in
  the future). A clean curl against `customer-portal?token=…` from a
  separate machine returns HTTP 200 with the full payload, confirming
  the token-auth path itself works.

  **Root cause.** Auth-mode precedence in `CustomerPortal.tsx`
  `fetchPortal` evaluates session mode FIRST: whenever
  `authMode === 'session' && accessToken`, the function calls the
  customer-portal edge function with the session JWT and entirely
  ignores the `?token=` URL parameter. If that session's JWT has been
  invalidated upstream (deactivation, password reset, ban, key
  rotation, etc.), the upstream rejection message commonly contains
  the substring `'expired'`. The frontend error screen at
  `CustomerPortal.tsx` ~L513 does a generic `.includes('expired')`
  check on the error string and renders the link-expired template —
  even though the underlying problem is a stale session, not the
  token.

  **Evidence.** Affected customer's `customer_portal_tokens` row was
  active with `expires_at = 2026-12-03`. Curl with the same token from
  a clean shell returned 200 + full payload. Same customer's device
  had a stale Supabase Auth session in `localStorage` whose JWT was
  no longer accepted.

  **Workaround applied.** Customer migrated to email/password auth
  (the session path then succeeded with fresh credentials, bypassing
  the precedence issue).

  **RESOLVED 2026-07-06 (investigation corrected the record).**
  The prior header cited commit `694d43f` — that commit does not exist
  in the repository; the "CLOSED, awaiting Publish" claim was false.
  Investigation on origin/main established the true state:
  1. **Auth-mode precedence — already shipped.** fetchPortal in
     CustomerPortal.tsx (the `!res.ok` branch) self-heals: a session-mode
     rejection while the URL carries a `?token=` signs out the dead local
     session, clears accessToken, flips authMode to 'token', and the
     useEffect refetches via the token (the explicit link wins). This
     closes the originally-reported scenario (token-link holder with a
     dead device session).
  2. **Expired-message scoping — shipped 2026-07-06 (commit 4afb8d4).**
     The error screen's isExpired check was a generic
     `error.includes('expired')`, which would mislabel session-class
     errors ('Session expired' / 'Invalid or expired session', emitted by
     Path 1 of _shared/portal-auth.ts) as "Portal Link Expired". Narrowed
     to match 'token expired' exactly — the message the edge function
     emits ONLY for a genuinely expired portal token (Path 2). Session
     errors now fall through to the generic "Invalid Portal Link" screen.
  Net: both halves resolved; the item is closed.

### Dashboard wiring & realtime audit (surfaced 2026-05-22)

  End-to-end audit of all four monitoring surfaces — Dashboard, CSR
  Monitoring, Finance, Executive — checking each card/KPI for real data
  wiring, refresh mechanism, and canonical-vs-cache source. All cards
  are wired to real sources (no mocks).

  RESOLVED in the same 2026-05-22 session (do NOT re-list as open):
  - OverdueAlerts / OverdueDebug display-rule violations — #118 / #119.
  - Overdue + Due Today/3d/7d count divergence (Dashboard/Finance vs
    Monitoring): dashboard-summary now mirrors classifyAccountBucket
    (grace 1-6, overdue 7+, exact day-marks, grace_accounts exposed) — #122.
  - Reminders "Sent (total)" .limit(100) under-count: replaced with a
    true count(exact) query — #129.
  - Test-account leakage across CSR Alerts / Penalty Follow-Up / Smart
    Reminders / Extensions / Audit panels / dashboard-summary /
    send-reminders, and the 18 reporting RPCs: swept to the canonical
    numeric-only rule invoice_number ~ '^[0-9]+$' — #124–#131.
  - get_monthly_sales PHP→JPY in ALL mode + Finance KPI grid relayout — #132.

  STILL OPEN:
  - DISPLAY-RULE (RESOLVED 2026-05-23 — already fixed; "Option A" was a no-op):
    The premise was stale. remainingDue() (src/lib/business-rules.ts:142) now
    prefers canonical actual_remaining when present
    (if (item.actual_remaining != null) return Math.max(0, Number(...))), falling
    back to the total_due−paid cache only for raw layaway_schedule rows. Every
    Monitoring query reads schedule_with_actuals with select('*') (Monitoring.tsx
    :99, :201, :210), so the rows passed to remainingDue at :115/:155/:326 carry
    actual_remaining → all three CSR sites already return canonical. No code change
    needed; the #124/#126 migration to schedule_with_actuals plus the helper
    upgrade closed this. (Counts were already consistent via #122.)
  - Collections this month dual source — RESOLVED 2026-05-23 (#142). Was a
    no-op (both sides included test payments and agreed); the real issue was
    dashboard-summary's payment sums (collections_this_month, payments_today)
    having NO test filter. Fixed in #142: added the account join + numeric
    filter to todayPayQ/monthPayQ, and pointed the Collections-tab "This Month"
    card at server collections_this_month so it matches Overview. Residual
    follow-up VERIFIED 2026-05-24 — NOT an issue: collFiltered already
    test-excludes via accountMap (#138), and useAccounts returns all accounts
    (all statuses, fully paginated past the 1000-row cap), so the four cells
    are complete and consistent with the server "This Month". No fix needed.
  - Canonical-vs-cache SOURCE of the 13 fc_* RPCs — RESOLVED 2026-05-24:
    verified against the live pg_proc bodies. None read the write-only schedule
    caches (total_due_amount / paid_amount); sources are canonical tables
    (payments, penalty_fees) and reconciliation-synced account fields
    (remaining_balance, total_paid per INVARIANT 1, total_amount) used only for
    aggregates. No fix needed (no-op). Test-exclusion closed via #131, currency
    via #132. Scope: source verification only, not a per-RPC arithmetic re-audit.
    get_collection_analytics — RESOLVED 2026-05-23: verified against the live
    pg_proc body; its "expected" already uses (allocated + actual_remaining)
    from schedule_with_actuals with numeric test-exclusion, NOT the
    total_due_amount cache #131 flagged. No change needed (no-op).
  - Monitoring Extension Requests "Account" column — RESOLVED 2026-05-24
    (#143): added customers(full_name) to the panel query and set the column to
    acct.customers.full_name (was acct.invoice_number); header relabeled
    "Account" -> "Customer". [#130 had added only the test filter.]
  - PenaltyFollowUpSection.tsx ₱ symbol — RESOLVED 2026-05-24 (#144):
    the stage tooltip was both cross-currency-summed (mixing ₱ and ¥ into one
    number) and hardcoded "₱". Split the bucket into totalPenaltiesPHP /
    totalPenaltiesJPY and rendered with formatCurrency per currency present.
  - Freshness (INVESTIGATED / RESOLVED 2026-07-06): the specific gaps
    flagged here no longer hold.
    • The six cards listed as "static, lacking autoRefresh" — Dashboard
      OverdueAlerts (overdue-schedule), OperationsPanel
      (operations-action-items), LiveCollectionTracker (weekly-collections),
      AgingBuckets (aging-buckets), Monitoring Penalty Follow-Up
      (penalty-followup-alerts) and Audit (monitoring-schedules) — are ALL
      in REALTIME_INVALIDATE_KEYS (PAYMENT_KEYS / MONITORING_KEYS) and have
      refetched live via useRealtimeSync since the realtime work; they are
      not static.
    • The Executive "Live · 30s" badge is defensible, not an overstatement:
      useExecutiveDashboard genuinely polls its numeric cards every 30s
      (three setInterval(fetch, 30_000) loops) AND the Alert Bar is true
      postgres_changes realtime on financial_alerts. The label matches the
      mechanism; no change made.
    • The remaining uncovered Finance keys (monthly-sales,
      collection-analytics, staff-performance, top-outstanding-customers,
      cash-orders-monthly, trade-kpis) are DELIBERATELY left off realtime:
      each is a heavy full-table aggregate RPC; wiring them to
      REALTIME_INVALIDATE_KEYS would re-run all of them on every payment
      write (the highest-frequency mutation), a performance regression on a
      periodic-review surface for no operational benefit. Accepted as-is.
    Conclusion: no code change warranted; freshness is correct where it
    matters (live-ops cards) and appropriately periodic where it doesn't
    (heavy Finance aggregates).

### Schedule cache staleness on non-paid rows (surfaced 2026-05-22, RESOLVED 2026-05-23)

  RESOLVED 2026-05-23 — the original "stale-high cache" framing was a
  MISDIAGNOSIS. A full sweep of schedule_with_actuals across all
  pending/overdue/partially_paid rows found ~99 rows where
  total_due_amount diverged from actual_remaining, but in every one the
  divergence equalled the row's `allocated` amount exactly and
  total_due_amount equalled base+penalty+carried (the correct GROSS).
  That is the allocation model working as designed, NOT staleness:
    - total_due_amount holds the GROSS per-row obligation
      (base + penalty + carried), including on partially_paid rows.
    - allocated holds payments against the row.
    - actual_remaining = total_due_amount − allocated (the view's
      formula, confirmed empirically), and is the only value displayed.
  So total_due_amount ≠ actual_remaining on a non-paid row is EXPECTED
  whenever allocated > 0 — it is not drift. The original entry applied
  the legacy "partially_paid = shortfall" reading to an allocation-model
  system. (CLAUDE.md PAYMENT ALLOCATION RULES already states the gross
  form; this session added an explicit cache-staleness test there.)

  CORRECT staleness test (use this, NOT total_due vs actual_remaining):
    stale  ⇔  total_due_amount ≠ base_installment_amount + penalty_amount + carried_amount   (on a non-paid row)

  Genuine stale rows found by that test: exactly ONE.
    INV 17325 inst 5 — total_due_amount 23,590 vs gross 23,634 (base
    22,634 + penalty 1,000); ₱44 short — cache held ~₱956 of a ₱1,000
    penalty (a penalty bump that didn't propagate to total_due_amount).
    allocated was 0, so the ₱44 flowed into the displayed remaining and
    put the per-row sum ₱44 under the account's canonical balance. Fixed
    2026-05-23 via SQL: total_due_amount = base+penalty+carried (the
    GROSS — NOT a flatten to actual_remaining, which would break
    void/restore). Re-count after fix = 0.

  The earlier examples (#17921, #17636, #18531, #18113, TEST-004) were
  all the allocation-model case above, not stale: #18113 is the #116
  surplus repair (2,340 'installment' allocation) working; TEST-004 is
  the documented redemption-discount allocation.

  Do NOT have reconcile-account / daily-reconciliation flatten
  total_due_amount to actual_remaining — that overwrites the gross
  obligation and breaks void/restore. If a genuine stale row recurs
  (total_due ≠ base+penalty+carried), reset total_due_amount to the
  gross, leaving allocated untouched.

### Edge function code review (surfaced 2026-05-19)

  Bug #115 — restore-payment service double-counting (investigation COMPLETE 2026-05-19 — NOT a confirmed bug; see verified note below).
  LOCATION: supabase/functions/restore-payment/index.ts line 414-415.
  CODE: const newRemainingBalance = Math.max(0, round2(
    Number(accountData?.total_amount ?? 0) + penaltyTotal + serviceTotal - newTotalPaid
  ));
  CONCERN: per SERVICES RULE (added 2026-04-12, this CLAUDE.md), services are
  already included in total_amount at the time of service creation. Adding
  serviceTotal as a separate term double-counts services on accounts that have
  them.
  IMPACT SURFACE: only manifests on accounts that have applied services AND
  subsequently have restore-payment called. Carl's account 20000 has zero
  services; today's audit (12/12 pass) doesn't expose the bug. TEST accounts
  also have zero services.
  PRIORITY: LOW — narrow impact surface, restore-payment is a rare staff action.
  NEXT STEP: read restore-payment.tsx lines 162 + 408-430 in full context to
  confirm whether serviceTotal is being legitimately compensated elsewhere or
  is a true double-count. If confirmed bug, fix is one-line: remove '+ serviceTotal'
  from line 415.
  STATUS: investigation COMPLETE 2026-05-19 — NOT a confirmed bug (see verified note).
  VERIFIED 2026-05-19 (investigation COMPLETE — NOT a confirmed bug):
  - TWO sites, not one: `+ serviceTotal` appears at line 163 (early recompute)
    AND line 415 (main path). The "one-line fix" framing was incomplete.
  - Blast radius: only 2 accounts in the DB have services (INV 17408, 17253),
    both fully paid (remaining=0, clamped) → zero exposure either way.
  - Neither follows the SERVICES RULE: 17408 total_amount (71,980) is BELOW
    dp+base (73,480) by exactly the service amount (anomalous); 17253
    total_amount ≈ dp+base (service excluded). For these legacy accounts,
    removing `+ serviceTotal` would UNDERSTATE the obligation — NOT a safe
    blind fix.
  - CONCLUSION: not active, zero impact, not a one-line removal. Proper path
    (if ever) = align restore-payment with audit_account's canonical formula
    in a balance-consistency pass, after verifying the 2 legacy accounts'
    total_amount. Deferred LOW. Side note: INV 17408 sub-(dp+base)
    total_amount is a separate data anomaly worth a look.

### Overpayment waterfall (surfaced 2026-05-20)

  Bug #116 — Overpayment surplus stored as total_due reduction, wiped by
  recomputes. STATUS DORMANT / effectively closed (verified 2026-05-19) — see verified note at end of entry.

  ROOT CAUSE: overpayment surplus is currently persisted ONLY as a
  total_due_amount reduction on the downstream row — no payment_allocation,
  no carried_amount. Any process that later recomputes
  total_due_amount = base + penalty therefore WIPES the surplus.
  penalty-engine/index.ts lines 384 & 406 both do this (total_due = base +
  penalty), so a penalty landing on a row that absorbed surplus reverts the
  row to full base+penalty and the customer's surplus disappears.
  reconcile-account / daily-reconciliation likely share the same recompute
  shape — confirm during the fix session.

  DURABLE PATTERN: store surplus as a payment_allocation on the downstream
  row, NOT as a total_due reduction. schedule_with_actuals computes
  actual_remaining = GREATEST(0, total_due - allocated), so an allocation
  survives any total_due recompute (the engine never touches `allocated`).
  Penalty payments use allocation_type='penalty' (107 rows today);
  installment / overpayment-surplus allocations use allocation_type
  ='installment'.

  STATUS: DORMANT / effectively closed (verified 2026-05-19 — durable
  allocation pattern already implemented in the main waterfall; see VERIFIED
  note at end of entry). Residual risk DEFERRED per owner: penalty-engine
  recompute (lines 384 & 406) can still wipe surplus if a penalty lands on a
  surplus-absorbing row — 1 occurrence to date (INV #18113, hand-repaired
  2026-05-20). Touch points to audit at fix time: review-payment-submission
  waterfall, record-payment, record-multi-payment, accept-underpayment /
  carry-over (already allocation-based), penalty-engine recompute sites
  (lines 384 & 406), reconcile-account, daily-reconciliation.

  Repair log:
    - INV #18113 (2026-05-20): Month 3 over-allocated 6001 vs base 3661;
      the 2340 surplus had been wiped by penalty-engine that morning.
      Re-split via SQL — capped Month 3 allocation to 3661, added 2340
      'installment' allocation to Month 4 against the same payment,
      synced schedule caches. Penalty left standing (correct). Month 4
      remaining → 1320. audit_account all_pass = true.

  VERIFIED 2026-05-19 (investigation COMPLETE — DORMANT / effectively closed):
  - Main waterfall (review-payment-submission 167/170/176/180, record-payment
    265, record-multi-payment 260) cascades surplus as allocation_type=
    'installment' ALLOCATIONS — the durable pattern this entry prescribes is
    already implemented, NOT a total_due reduction.
  - Keep handler (PaymentSubmissions.tsx): overpayment "Accept waterfall" =
    allocation cascade; overpayment "Keep" = records as-is, no schedule change;
    underpayment "Keep as Partial" = no-op. NO total_due_amount write exists
    anywhere in the file.
  - Empirical: ZERO schedule rows have an unbacked total_due reduction — every
    reduced row is fully backed by a matching installment allocation.
  - The vulnerable mechanism described above was the OLD keep approach (commit
    217b9b8), converted to allocations (commit 3f87361). INV #18113 was that
    old mechanism, since repaired.
  - STALE REMNANTS to clean someday: review-payment-submission ~line 149
    comment + ~line 153 total_due ceiling reference the retired mechanism.
  - CONCLUSION: dormant / effectively closed; durable pattern everywhere; no
    recurrence path; zero vulnerable rows. (Note: 1d65c7d "Fixed carry-over
    totalDueAmount" preserves carried_amount through the penalty recompute — a
    sibling fix, distinct from this surplus concern.)

### Pending KPI accuracy items (surfaced 2026-04-28)

  Audit findings from the KPI cleanup. Group D items
  follow the numbering from the original audit report.
  The HIGH-severity timestamptz items originally
  flagged here were resolved in commit ae5a000 — see
  Known Fixed Bug #55.

  LOW / MEDIUM severity — display polish + design
  decisions, not data accuracy:
  - D5: Dashboard polling 30s — not a correctness
    bug, perf footnote. Each poll runs ~22 parallel
    SELECTs in dashboard-summary. Consider raising
    interval to 60s or driving via supabase-realtime
    subscription if perf becomes an issue at scale.
  - D7: Two cards share `cash_revenue_month_jpy` field
    (Dashboard "Revenue This Month" + Executive
    "Cash Sales (This Month · JPY)"). Not a bug —
    intentional reuse. If one is ever expected to
    diverge from the other (e.g. different scope
    rules), they need to become two separate fields.
  - D8 — RESOLVED 2026-05-24 (#146): the 0.85 haircut is no longer surfaced
    on any Finance card or chart. Expected Next Month + Predicted (30d/90d)
    cards (both clusters) repointed to the undiscounted values; the
    6-Month Cashflow Forecast chart's gold "adjusted" bar, "Adj:" figure,
    and "Risk-Adjusted (85%)" legend removed. The riskFactor constant
    stays unused in dashboard-summary (optional future tidy-up).
  - D9 — RESOLVED 2026-05-24 (#146): the confusing "of {raw} due"
    subtitle was removed alongside the relabel of the headline cards
    to "Expected (30d/90d)" pointing at the raw values.

### AgingBuckets follow-ups (surfaced 2026-04-29)

  Two low/medium issues found while verifying the
  D2/D4 revert (commit 1b9ff78). Both will be
  folded into the same get_aging_buckets() RPC
  work as D2/D4.

  - AgingBuckets currency-prop partially resolved (2026-04-30);
    optional p_currency follow-up RESOLVED 2026-05-24 (won't-do):
    The component now consumes the currency prop for
    variant='amount' (toJpy conversion when displayCurrency=JPY;
    PHP-only filter when displayCurrency=PHP). This closed the
    user-visible "ignored" complaint.

    Optional follow-up: get_aging_buckets() RPC still does not
    take p_currency parameter. Adding it would push the filter
    to the SQL layer instead of the JS layer. Currently no
    behavioral difference because the JS-layer filter is correct.
    Defer to future session.

    RESOLVED 2026-05-24 (won't-do):
    - p_currency param: won't-do — redundant. AgingBuckets is the sole
      caller; currency is handled client-side, and a server-side filter
      would regress the Finance JPY-combined view.
    - Aging buckets: confirmed correctly wired — canonical
      actual_remaining, numeric test-exclusion, Asia/Manila overdue-day
      math, correct status scopes. Per-installment bucketing is
      intended; 29 of 639 accounts (4.5%) legitimately span buckets
      (installments at different aging stages), accepted as-is.
    - Finance currency toggle: confirmed correct — PHP shows PHP
      receivables in pesos; JPY/combined shows all accounts in yen.

    (originally surfaced 2026-04-29, partially resolved 2026-04-30)

  - TEST-005 in Overdue & Due Soon widget:
    RESOLVED 2026-05-23 (Bug #140): OverdueAlerts.tsx now carries the canonical numeric-only filter .filter('layaway_accounts.invoice_number','match','^[0-9]+$') on its embedded join — test accounts excluded from the widget.
    Pre-existing TEST exclusion gap on the
    Overdue & Due Soon widget (not AgingBuckets
    — separate component). Surfaced 2026-04-29
    during D2/D4 verification. Fix path: add
    `.not('invoice_number', 'like', 'TEST-%')`
    on the underlying query, mirroring the
    pattern used elsewhere on the dashboard.
    Verify the widget's account-id filter
    chain stays under PostgREST URL limits
    (do NOT repeat the de1e640 mistake — if a
    join can't carry the TEST exclusion, push
    the filter into a server-side RPC instead
    of a client-side `.in()` over a large
    UUID list).

### Dashboard restructure follow-ups (surfaced 2026-04-30)

  Open items surfaced during the Dashboard
  account-counts-only restructure (Known Fixed
  Bug #67). All are INVARIANT 2 / TEST-exclusion
  consistency items that remain after the
  AgingBuckets fix landed.

  (No items remaining — EditCustomerDialog
  DB-side defense entry retired 2026-05-08;
  see Known Fixed Bug #85.)

### Workflow gaps (surfaced 2026-05-01)

  Retired 2026-07-05: moot — the deploy workflow itself was proven inert (never deployed anything) and removed; ALL edge functions deploy via Lovable IDE, so no function is 'missing' from any deploy path.

### Currency toggle behavior (surfaced 2026-04-30) — RESOLVED 2026-05-23

  Currency toggle Dashboard behavior is mixed.
  Investigation 2026-04-30 mapped per-widget
  currency awareness:

  Currency-aware (filter by toggle): Total
    Customers, Total Active Accounts, Overdue
    (status), Forfeited, Forfeited Today,
    today/month payments, Live Collection
    Tracker recent feed, Operations Panel
    pills.

  Currency-agnostic (always global): Plan
    tiles, Completed (this month), All Time
    Completed, Cash Orders (always JPY),
    AgingBuckets, Regional Overview, AI &
    Predictions panels.

  No codified principle; split is organic.
  Status quo held pending UX decision on
  Path A (counts always global) vs Path B
  (counts always filter by currency).

  (2026-04-30)

  RESOLVED 2026-05-23: The Dashboard currency toggle was removed. The
  Dashboard now shows a single combined ALL view (PHP + JPY, PHP converted
  to JPY). The Path A vs Path B question is therefore moot — there is no
  toggle to filter by. Finance keeps its own currency toggle; this is a
  Dashboard-only change.

### Priority/severity guide (as of 2026-04-30)

  Honest triage for the open bugs above + items in PENDING ITEMS.
  Updated when severity changes or items resolve.

  P0 — Customer-impacting / data integrity at risk
    None as of 2026-04-30.

  P1 — Operational gaps that affect business decisions (Medium severity)
    - Currency toggle final decision (Path A vs B) — RESOLVED 2026-05-23.
      Toggle removed from the Dashboard; it now shows a single combined
      ALL view (PHP + JPY, PHP to JPY). Path A/B is moot. Finance keeps
      its own toggle. (Dashboard-only change.)
    - Loyalty staff visibility — RESOLVED 2026-05-26. Page-access
      dimension fixed via bug #63; account-view tier badge now
      surfaced in AccountDetail.tsx (useCustomerLoyaltyTier L66 +
      LoyaltyTierBadge render L1011-1012).
    - Admin audit log UI (P6 in PENDING ITEMS legacy numbering) —
      RESOLVED 2026-05-26. Standalone admin-only Admin Audit page
      shipped at /admin-activity (AdminActivityLog.tsx + ActivityLogTab.tsx,
      get_audit_filter_options() RPC) — paginated audit_logs browser with
      entity/action/actor/date filters and before→after diff. Distinct
      from the System Audit page (/admin-audit).
    - Loyalty redemption approve atomic rollback —
      RESOLVED 2026-06-05 (commit 6b9d8a7 + SQL RPC
      approve_redemption_atomic). The approve handler now delegates
      every write to a single SECURITY DEFINER transaction. See Bug
      #164 in docs/FIXED-BUGS.md for full details.

  P2 — Hygiene / consistency (Low severity)
    None as of 2026-05-01 (both items resolved — see bugs
    #74 and #75).

  P3 — Defensive hardening (Low severity, no known bugs)
    - Session timeout 2hr (P5 in legacy numbering) — RESOLVED 2026-05-26.
      2h idle timeout with 5-min warning modal now applies to both the
      staff app and the customer portal (AuthContext.tsx, commit 1adfa15).

  P4 — Larger features (Medium severity, real effort, not blocking)
    - PWA Phase A install routing — ABANDONED 2026-05-04 (Bug #79 revert),
      replaced by EMAIL/PASSWORD AUTH (Phase B). Verified 2026-05-17: Phase A
      frontend wiring is still absent from CustomerPortal.tsx,
      CustomerStatement.tsx, and LoyaltyPortal.tsx. The 71 no-email customers
      and similar token-only cohorts cannot use installed PWA cold-opens
      effectively. Action path is migration to Phase B (not reviving Phase A).
      Not currently a code workstream; tracked as operational/support issue.
    - Invoice generator — Google Sheets + Drive, JPY only.
      ✅ SHIPPED 2026-05-09 / 2026-05-10 (Steps 1a-1e in
      INVOICE GENERATOR section)

  No P0 work today. Triage triggered when an item escalates
  (e.g., customer report, audit flag, regulatory deadline).

  (last reviewed 2026-05-04)

  - Customer-facing Payment History sort order (surfaced 2026-05-11,
    RESOLVED 2026-05-17 via Phase 2 of A1 plan):
    src/pages/CustomerPortal.tsx Payment History section derives from
    customer-portal edge function. Previous state: customer-portal
    sorted payments by date_paid DESC with no tiebreaker — same-day
    payments had undefined order.

    Empirical investigation 2026-05-17 revealed that 67% of payment
    rows (2,960 of 4,377) are bulk-import artifacts with
    created_at = 2026-03-20 and date_paid spanning May 2025 -
    Aug 2025 (real payment dates). Sorting by created_at ASC (the
    original proposed fix-path) would have clustered ~2,960 rows on
    the bulk-import day, destroying real chronology for the majority
    of payments.

    Fix applied: composite sort date_paid PRIMARY + created_at
    TIEBREAKER on 2 customer-portal query sites:
      1. customer-portal payments fetch (DESC, newest first)
      2. customer-portal cash_payments fetch (DESC, newest first)

    Same-day payments now have stable deterministic order via
    created_at tiebreaker.

    SCOPE NOTE: customer-statement edge function was intentionally
    SKIPPED. Although src/pages/CustomerStatement.tsx +
    supabase/functions/customer-statement/index.ts still exist in
    the repo, the admin UI to generate/share statements was
    previously removed, no email links point to /statement, and no
    customer access path remains. The file is effectively dead code,
    pending formal deletion investigation (separate parked workstream
    — see Open workstreams: customer-statement deletion).

    Bulk-import semantics note: advance payments are correctly
    recorded with date_paid = scheduled installment date (not the
    actual entry date). This preserves installment-to-payment
    alignment for reporting. Verified 2026-05-17 against accounts
    18394 and 18498 — both completed and fully paid via advance
    payment pattern.

  - Audit failure during DP-voided + active-installment state (surfaced
    2026-05-11): When DP is voided while an installment payment is
    active, audit_account() returns all_pass=false on check "sum of
    pending months matches remaining balance" because schedule rows
    don't have a slot for unpaid DP. Discrepancy clears once DP is
    restored or another DP is recorded. Edge case only during
    transient voided-DP state. Not customer-facing. Defer.

### Open workstreams (added 2026-05-14)

  - Session lesson 2026-05-14: Bug #100 auto-deploy staleness incident
    recurred during Bug #101 deployment. Workflow reported success at
    326cc4d merge time; production function continued running pre-Bug #101
    code until forced redeploy via trivial whitespace change. Pattern is
    reproducible. Defense: empirical retest is the only proof of deployed
    code; never trust workflow success alone. For high-confidence deploys,
    request Lovable bundles a trivial change with the substantive change
    to guarantee the deployment hash differs.

  - Session lesson 2026-05-19: HANDOVER / doc staleness. A long chat runs
    on stale local context while Lovable commits to main in parallel, so
    handovers and CLAUDE.md edits written from chat memory drift from
    reality (this session the chat believed redemption Issues 1-3 and the
    Customers mobile crash were still open — both had already shipped to
    main). Defense: always rebuild HANDOVER from main, never from chat
    context. `git pull origin main`, read the actual CLAUDE.md status
    sections (Recent Updates / Known Open Bugs / PENDING ITEMS), and
    reconcile each claim (old claim → verified state → source) before
    writing. Do not manufacture a doc edit when investigation shows none
    is needed.

  - Extension request window off-by-one (deferred, not a defect for now):
    documented as "7 days" in the customer-facing UI copy, but
    `CustomerPortal.tsx` computes `floor(elapsedDays) <= 7`, which actually
    gives 8x24h from `forfeited_at` before the window closes. Mirrored
    intentionally in `supabase/functions/request-extension/index.ts`
    (`WINDOW_DAYS = 7`, same `floor(...) <= 7` comparison) so frontend and
    backend agree. If this is ever tightened to a true 7-day window, the
    frontend and `request-extension/index.ts` must be changed together in
    the same commit — one enforces the account-status/ownership/pending
    checks server-side, the other renders the countdown.


