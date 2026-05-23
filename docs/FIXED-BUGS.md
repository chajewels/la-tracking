## Known Fixed Bugs (do not reintroduce)

  - DP must never be counted twice in totalPaid
  - Waived penalties must be excluded from totalLAAmount
  - Partial months must be included in totalPaid
  - sumOfPendingMonths uses full scheduledTotal for pending,
    remaining amount for partial months
  - Split payment session tracking is per-account only
  - DP must never appear in split payment session list
  - Grand Total must include DP + base + penalties + services
  - carry-over shortfall used SUM(allocations) instead of source.paid_amount — fixed
  - carry-over wrote stale carried_by_payment_id — fixed
  - auto-forfeit-settlement wrote audit log before confirming status update — fixed
  - auto-forfeit-settlement had no error checking on status UPDATE or schedule cancels — fixed
  - penalty-engine used due_date < today (strict) missing same-day penalties — fixed to due_date <= today
  - Penalties & Waivers section showed paid penalties — fixed to show unpaid only
  - Overpayment modal Carry Over button confirmed working — waterfall already allocates surplus
  - admin_keep_allocation_override RPC silently failed for some users — added error handling
  - recalculate-penalties silently waived correct penalties — DISABLED (returns 410)
  - 17. Grace period was permanently consumed — fixed to reset when
    account fully caught up (2026-04-13)
  - 18. Keep handler did not recompute account totals after override
    — fixed to use canonical formula (2026-04-13)
  - 19. carry-over did not recompute account.status — fixed (2026-04-13)
  - 20. carry-over could overwrite existing carried_amount — fixed with
    400 guard (2026-04-13)
  - 21. void-payment, edit-payment-amount, restore-payment, and
    record-multi-payment used wrong remaining_balance formula —
    all fixed to canonical formula (2026-04-12)
  - 22. Staff payment submissions bypassed review and went directly to
    confirmed — fixed, all go through Submissions review now
    (2026-04-13)
  - 23. Proof of Payment tab showed unconfirmed submissions — fixed
    with status='confirmed' filter (2026-04-13)
  - 24. Penalty engine skipped schedule rows with waived penalties —
    fixed by separating waivedPenaltyIds map from existingPenaltyMap.
    Waived penalties now UPDATE to unpaid instead of blocking new INSERT
    (2026-04-19)
  - 25. Extension request button not clickable in customer portal —
    fixed by moving banner to scrollable div and using position:absolute
    modal inside Sheet coordinate system (2026-04-19)
  - 26. Extension requests not appearing in CSR Monitoring —
    fixed by removing ambiguous customers!inner join and correcting
    order column from created_at to requested_at (2026-04-19)
  - 27. accept-underpayment was performing carry-over operations —
    removed, now audit-log only (2026-04-19)
  - 28. audit_all_accounts() had divergent check logic from audit_account() —
    rewritten to call audit_account() per account (2026-04-19)
  - 29. Keep handler overpayment recalculated total_due_amount from scratch —
    fixed to use existing total_due_amount - spillover (2026-04-19)
  - 30. carry-over omitted penalty_amount in total_due_amount calculation —
    fixed to use existing total_due_amount + shortfall (2026-04-19)
  - 31. Waterfall only allocated first penalty row per month —
    fixed to group penalties by schedule_id (2026-04-19)
  - 32. Search input lost focus due to EmbeddedWrapper defined inside
    component — fixed to module level (2026-04-19)
  - 33. record-payment and record-multi-payment waterfall used break
    after first fully-paid month killing surplus flow to subsequent
    months — fixed to match review-payment-submission waterfall
    pattern (2026-04-20)
  - 34. reconcile-account was making DB writes that conflicted with
    carry-over decisions — rewritten to report-only with zero DB
    writes, results logged to reconciliation_log table (2026-04-20)
  - 35. Keep decision handler was reversing the waterfall and consolidating
    full payment onto Month 1 — fixed to be a no-op that preserves
    the waterfall result exactly as the edge function wrote it (2026-04-20)
  - 36. Record Payment dialog input max attribute caused browser native
    validation to reject exact remaining balance amounts due to
    floating point — fixed with 0.005 tolerance (2026-04-20)
  - 37. restore-payment used SUM(deleted allocation rows) for
    remainingInstallmentAmount — always 0 after void — fixed to
    use payment.amount_paid directly (2026-04-20)
  - 38. restore-payment cleared voided flags AFTER totals recalculation
    causing restored payment to be excluded from SUM — fixed by
    unvoiding payment before recalculating totals (2026-04-20)
  - 39. void-payment bypass flag set_config did not persist across
    separate HTTP calls — removed, freeze trigger now allows
    void naturally via paid_amount decreasing rule (2026-04-20)
  - 40. review-payment-submission isNowFullyPaid check excluded
    in-memory penalty allocation — status stayed partially_paid
    when row was fully covered by installment + penalty —
    fixed to include alreadyAllocatedPenalty in check (2026-04-21)
  - 41. review-payment-submission isNowFullyPaid excluded in-memory
    penalty allocation causing db_status to stay partially_paid
    when row was fully covered — affected INV #17676 Month 4 and
    INV #17561 Month 5 — manually corrected, permanent fix deployed
    (2026-04-21)
  - 42. INV #17561 Month 6 missing allocation row — surplus payment
    from April 18 did not create allocation for Month 6 due to
    pre-fix waterfall bug — manually inserted missing allocation
    row (2026-04-21)
  - 43. Forgot Password and Contact Support buttons were cosmetic
    shells with no click handlers — wired up (2026-04-21)
  - 44. Password reset redirected to wrong domain — fixed redirectTo
    to app.chajewelsjp.com/reset-password and added to Supabase
    URI allowlist (2026-04-21)
  - 45. Recovery session intercepted by AuthContext before
    ResetPassword page mounted — fixed with RecoveryRedirect
    component and Login guard (2026-04-21)
  - 46. Link Signature modal unclickable due to double Radix overlay
    from Dialog + AlertDialog stacking — merged into single Dialog
    with two-view pattern (2026-04-21)
  - 47. Waterfall penalty split across months — both
    review-payment-submission and record-payment used a
    two-phase global waterfall (Phase 1: pay ALL unpaid
    penalties across ALL months; Phase 2: pay bases).
    This caused penalty budget to drain across future months
    before the target month's base was covered. Fixed to
    row-by-row atomic waterfall: for each unpaid row in
    installment order, pay that row's own penalties first
    (scoped by schedule_id), then pay its base — commit
    9069ffd (2026-04-23)
  - 48. payment_submissions.confirmed_payment_id had FK to
    payments(id), causing every cash confirm to fail with
    FK violation (cash_payment.id is in cash_payments,
    not payments). FK was DROPPED in production. Column
    is now a soft reference dispatched by submission_type
    / cash_order_id presence — see PAYMENT SUBMISSIONS FK
    NOTE section (2026-04-28)
  - 49. review-payment-submission cash branch step 5
    failure had no rollback. When the submission UPDATE
    failed after cash_payments INSERT and cash_orders
    UPDATE both succeeded, the function returned 500 but
    left a half-confirmed state: cash_payment existed,
    cash_order was completed, submission was still
    'submitted', customer could not retry because
    remaining_balance was 0. Fixed with pre-update
    snapshot + manual rollback in step 5 failure path
    — see CASH ORDER CONFIRM ROLLBACK section
    (2026-04-28)
  - 50. delete-account did not clean up reconciliation_log
    — fixed (2026-04-28). reconciliation_log table
    was created via SQL Editor 2026-04-20 with
    account_id FK using ON DELETE NO ACTION. delete-account
    cleanup list at lines 73–117 of the edge function
    explicitly deletes 13 child tables but did not
    include reconciliation_log, so any account that
    had been reconciled (most active accounts after
    2026-04-20) failed to delete with FK violation
    'reconciliation_log_account_id_fkey'. Added
    explicit DELETE as step 8 between reminder_logs
    and account_services. Subsequent step comments
    renumbered. Manual deploy required (delete-account
    is not in auto-deploy workflow).
  - 51. delete-account did not clean up extension_requests
    — fixed (2026-04-28). extension_requests table was
    declared in repo migration
    20260418010000_create_extension_requests.sql with
    `account_id uuid NOT NULL REFERENCES
    layaway_accounts(id)` and no ON DELETE clause,
    which defaults to NO ACTION. Confirmed in production
    via pg_constraint query. Any account that had
    submitted an extension request (typically forfeited
    accounts) failed to delete with FK violation
    'extension_requests_account_id_fkey'. Added
    explicit DELETE as step 7, immediately after
    csr_notifications and before reminder_logs.
    Subsequent step comments renumbered 7–16 → 8–17.
    Verified leaf table — no children, no triggers.
    Manual deploy required (delete-account is not in
    auto-deploy workflow). Closes the second of two
    confirmed FK gaps tonight; together with bug #50
    these two account for the remaining 1 of 6
    NO ACTION/RESTRICT FKs to layaway_accounts that
    were not handled by the cleanup list. Other
    SQL-Editor-created child tables (account_notes,
    schedule_audit_log, loyalty_transactions,
    loyalty_redemptions, financial_alerts) are
    presumed to use CASCADE or SET NULL based on
    user's live pg_constraint count (10 CASCADE +
    3 SET NULL + 6 NO ACTION/RESTRICT = 19 total);
    can be re-verified if a future SQL-Editor table
    introduces another NO ACTION FK.
  - 52. Schema-drift detection: created
    audit_delete_cleanup_invariants() RPC to detect
    FK gaps in delete-cleanup edge functions before
    they cause production failures. Surfaced 3
    deferred bugs in delete-customer (cash_orders,
    payment_submissions, extension_requests FK gaps —
    see Known Open Bugs). Tracking these as
    known-open rather than fixing tonight (4 deploys
    already shipped — bdac341, 1ff9cd8, plus the
    earlier review-payment-submission rollback and
    cash-order partials/expiry); will fix in next
    session. Function body recorded under AUDIT RPCs
    section. (2026-04-28)
  - 53. delete-customer FK gaps closed: added
    cash_orders pre-check (mirrors layaway_accounts
    block — RESTRICT FK), extension_requests cleanup
    (NO ACTION FK), payment_submissions cleanup
    (NO ACTION FK), and audit_logs entry on
    successful delete (matches delete-account
    pattern from bf368a6). Pre-check is now
    consolidated and parallel — single Promise.all
    fetches both layaway_accounts and cash_orders;
    error response includes a structured
    `blocked_by` payload listing every blocker so
    admin sees the complete picture in one round
    trip instead of fixing one error then hitting
    the next. Surfaced by
    audit_delete_cleanup_invariants() and tracked as
    Known Open Bug entry; that entry is now resolved.
    Manual deploy required (delete-customer is not
    in auto-deploy workflow). After deploy, the 3
    new allowlist rows must be added to the audit
    RPC in SQL Editor — see AUDIT RPCs section.
    (2026-04-28)
  - 54. EditCustomerDialog allowed manual customer_code
    overwrite — discovered when customer "Charm Monaka"
    had a Facebook URL in the customer_code field
    instead of the canonical CJ-YYYY-XXXXX format.
    Data was repaired manually via SQL Editor; the
    UI hole that allowed it (writable Input at
    EditCustomerDialog.tsx:108 plus customer_code
    in the saveEdit UPDATE payload) is now closed.
    Field is read-only with a Lock icon, helper text
    explaining the cross-platform sync requirement,
    and the UPDATE payload no longer carries the
    column. Defense in depth: even if the input were
    re-enabled or DOM-tampered, the saveEdit handler
    won't write the field. Forensic repair path
    documented under CUSTOMER CODE STANDARD —
    Forensic repair subsection. Frontend-only
    change; no DB-side trigger added (single attack
    surface, application-layer enforcement is
    sufficient for now). (2026-04-28)
  - 55. dashboard-summary had 4 timestamptz
    month-boundary filters with the same TZ-skew
    bug class as D1 (commit 63bc008): bare
    monthStartStr / nextMonthStartStr were passed
    to PostgREST gte/lt against timestamptz columns
    (layaway_accounts.completed_at,
    cash_orders.completed_at, cash_orders.created_at,
    layaway_accounts.created_at). PostgREST
    forwarded them as no-offset strings, Postgres
    parsed them as UTC midnight, shifting the PHT
    month window by +8h. Visible failure mode was
    bounded to PHT 00:00–08:00 on month-1st
    boundaries — produced wrong absolute counts
    during that window for "Completed (this month)"
    card, "Cash Orders → Completed" card, and Cash
    Conversion Rate denominators.

    Fixed in commit ae5a000 by adding monthStartPht /
    nextMonthStartPht helpers (computed once at the
    top, parallel to today / tomorrow from D1) and
    switching the 4 affected queries
    (completedThisMonthQ, cashCompletedMonthQ,
    cashCreatedMonthQ, layawayCreatedMonthQ) to use
    them. Bare monthStartStr / nextMonthStartStr
    remain in 3 places that legitimately use them
    against `date` columns or in JS string compares
    (monthPayQ on payments.date_paid, plus 2 JS
    aggregations in cash/layaway revenue
    bucketing). Block comment in the helpers
    declaration documents the contract: bare
    strings for date columns, PHT-suffixed for
    timestamptz. Auto-deployed via GitHub Actions
    on push. (2026-04-28)
  - 56. PHT timezone sweep across 7 non-Dashboard
    files closed. 11 instances of
    `new Date(...).toISOString().split('T')[0]`
    replaced with getPHTToday() / todayStr() /
    Intl.DateTimeFormat with Asia/Manila timezone.
    All hits filtered against `date` columns
    (`due_date`, `date_paid`), not `timestamptz`,
    so the bug class was lower severity than D1 —
    bounded to PHT 00:00–08:00 window when UTC was
    still on the prior calendar day.

    Affected files:
    - src/pages/Monitoring.tsx (3 sites: in7days,
      past730, next7Str — line 95 already used
      getPHTToday correctly)
    - src/components/dashboard/OverdueAlerts.tsx
      (2 sites: today, threeDaysFromNow)
    - src/components/dashboard/OperationsPanel.tsx
      (1 site: next7Str)
    - src/components/dashboard/AIRiskPanel.tsx
      (1 site: today, inside assessRisk helper)
    - src/components/dashboard/PenaltyCapAuditPanel.tsx
      (1 site: today)
    - src/components/dashboard/LiveCollectionTracker.tsx
      (2 sites: weekly chart startStr + dayMap key)
    - src/components/monitoring/PenaltyFollowUpSection.tsx
      (1 site: due_date filter)
    - src/pages/Finance.tsx:437 (CSR performance
      overdue count)
    - src/hooks/useExecutiveDashboard.ts:160
      (6-months-ago boundary)

    Library internals at src/lib/business-rules.ts
    lines 296, 718, 723 deferred for separate audit
    — those are inside helper functions and have
    ripple risk across many call sites. Customer
    portal, statement, account-detail, and payment-
    dialog files also still use the pattern but
    were out of scope for the admin/staff KPI
    sweep — separate audit later.

    Frontend-only PR. Auto-deploys via Firebase
    Hosting on push. (2026-04-29)
  - 57. Customer-facing PHT timezone sweep — 11
    sites across 3 files. Same
    `toISOString().split('T')[0]` bug class as #56
    but on customer portal surfaces, where the bug
    fires in real production whenever a customer
    uses the portal between PHT 00:00–08:00.
    Customer-facing impact is structurally higher
    than the admin sweep because customers tap
    portal links at any hour (mobile reminders,
    Messenger threads, etc.).

    Affected files:
    - src/pages/CustomerPortal.tsx (6 sites:
      hasDueToday flag, portalToday status
      override, next-payment row, per-account
      Overdue pill, getAccountDuePriority,
      payment-form initial value)
    - src/pages/CustomerStatement.tsx (4 sites:
      getNextPaymentInfo today derivation,
      future/latest Date-to-string formatting
      x2, per-row overdue indicator)
    - src/components/portal/CashPortalPaymentDialog.tsx
      (1 site: todayISODate() helper body —
      affects form initial value AND max-date
      constraint)

    CRITICAL severity: CustomerPortal.tsx line
    1879 form initial value for paymentDate.
    Customer submitting a portal payment between
    PHT 00:00–08:00 silently pre-filled
    yesterday's date, which then gets logged on
    payment_submissions.payment_date and flows
    into audit logs. The customer has no obvious
    cue that the date is wrong because the input
    looks like "today" to them.

    Replaced with getPHTToday() (5 sites in
    CustomerPortal, 2 sites in CustomerStatement,
    1 site in CashPortalPaymentDialog) and inline
    Intl.DateTimeFormat with Asia/Manila timezone
    (2 sites in CustomerStatement that format
    Date objects rather than computing "today").

    Frontend-only PR. Auto-deploys via Firebase
    Hosting on push. (2026-04-29)
  - 58. Admin-side PHT timezone sweep — 16 sites
    across 12 files closed. Final frontend PHT
    sweep PR; together with #56 (admin-staff
    surfaces, ddeec70) and #57 (customer-facing,
    23e19bb) this closes every site outside
    library internals.

    Affected files:
    - src/pages/AccountDetail.tsx (2 sites:
      todayStr override-stale-OVERDUE,
      setNewInstDueDate Date-to-string)
    - src/pages/CustomerDetail.tsx (1 site:
      cdToday override-stale-OVERDUE)
    - src/pages/AccountList.tsx (1 site:
      todayStr filter)
    - src/pages/NewCashOrder.tsx (2 sites:
      orderDate form initial value,
      today expires-at-past warning)
    - src/pages/CashOrderDetail.tsx (1 site:
      Edit Expiry dialog initial value from
      timestamptz)
    - src/components/payments/RecordPaymentDialog.tsx
      (2 sites: paymentDate form initial +
      reset on submit)
    - src/components/payments/MultiInvoicePaymentDialog.tsx
      (2 sites: same form-default pattern)
    - src/components/customers/RecordCashPaymentDialog.tsx
      (1 site: todayISODate() helper body —
      cascades to form initial value AND
      max-date constraint)
    - src/components/accounts/EditAccountDialog.tsx
      (1 site: due_date Date-to-string formatting
      for new installment row)
    - src/components/loyalty/LoyaltyPromosTab.tsx
      (1 site: todayYmd() helper body)
    - src/components/customers/CashOrdersList.tsx
      (1 site: order_date display fallback)
    - src/components/customers/CustomerCashOrdersTab.tsx
      (1 site: same display-fallback pattern)

    Mix of getPHTToday() for "today"
    comparisons + form initial values, and
    inline Intl.DateTimeFormat for Date-object
    formatting where a Date object exists
    rather than computing "now".

    Lower real-world impact than #57 (admins
    mostly work 09:00–18:00 PHT outside the
    bad window), but the form-initial-value
    sites in payment-recording dialogs are
    MEDIUM impact — admin recording at unusual
    hour could silently log wrong payment_date.

    Library internals at src/lib/business-rules.ts
    lines 296, 718, 723 remain deferred for
    separate cross-cutting audit.
    src/lib/date-utils.ts:4 is a JSDoc comment
    intentionally referencing the bug pattern;
    not changed.

    Final remaining `toISOString().split('T')[0]`
    sites in src/ after this PR: 4 (all expected —
    1 JSDoc comment + 3 library internals).

    Frontend-only PR. Auto-deploys via Firebase
    Hosting on push. (2026-04-29)
  - 59. ROLLBACK — AgingBuckets D2+D4 fix attempt
    (commit de1e640) reverted because the
    PostgREST URL-length failure mode broke all
    aging buckets in production. The two-step
    query pattern used `.in('account_id',
    accountIds)` on a 600+ UUID list, triggering
    the documented PostgREST limit; all buckets
    returned ₱0 / 0 accounts in both PHP and JPY
    views ~40 minutes after deploy. Reverted via
    git revert (commit 1b9ff78). CLAUDE.md
    INVARIANT 2 + D2 TEST exclusion remain
    unfixed; correct approach is a server-side
    RPC (get_aging_buckets()) that runs the join
    in SQL and returns aggregated results.
    (2026-04-29)
  - 60. Dashboard Reminder counts capped at 200.
    dashboard-summary edge function used
    `.limit(200).select('id, delivery_status')` then
    computed counts via `.length` and `.filter().length`.
    Once reminder_logs grew past 200 rows, the count
    silently capped — production at fix time had
    7,970 total reminders (6,368 success) and
    Dashboard "Reminders Sent" card was showing 200,
    a 40x under-report.

    Fixed by replacing the single row-fetching query
    with three count-only queries
    (`select('id', { count: 'exact', head: true })`)
    matching the existing completedAllTimeQ pattern:
    reminderTotalQ (no filter), reminderSuccessQ
    (delivery_status IN sent/delivered), and
    reminderFailedQ (delivery_status = failed). All
    three run inside the same Promise.all batch so
    parallelism is preserved. Consumers read
    `count ?? 0` instead of `.length`.

    Auto-deploys via GitHub Actions on push.
    (2026-04-29)
  - 61. (HOTFIX) PWA install banner appeared on
    customer-facing routes (/portal, /statement)
    but installs landed at admin login because
    manifest start_url='/' is hardcoded. Customer
    on /portal?token=abc taps "Install App", PWA
    installs with start_url='/', launches to
    /login (admin login), customer hits dead-end.

    Hotfix: detect customer context via the
    `?token=` query param and hide the banner on
    those routes. `<InstallAppBanner />` was
    moved from outside `<BrowserRouter>` to
    inside it so `useSearchParams()` resolves;
    new early-return `if (isCustomerContext)
    return null;` runs before the visibility
    gate. Admin pages (/login, /dashboard, etc.)
    still surface the banner normally.

    Durable fix (dynamic manifest with
    token-baked start_url) deferred to a
    follow-up PR — see bug #62 below.
    (2026-04-29)
  - 62. PWA install on customer portal —
    durable fix. Customers can now install the
    app from `/portal?token=abc` (or
    `/statement?token=abc`) and the installed
    PWA opens directly at the customer's portal
    with the token preserved in start_url.

    Implementation: src/lib/dynamic-manifest.ts
    builds a `data:application/manifest+json`
    URL with `start_url='/portal?token=<token>'`
    and replaces the `<link rel="manifest">`
    href on portal page mount. Reverts to the
    static `/manifest.webmanifest` on unmount
    so admin pages keep their original
    `start_url='/'`. Wired into
    src/pages/CustomerPortal.tsx and
    src/pages/CustomerStatement.tsx via a
    `useEffect([token])`.

    PR-1 hotfix from bug #61 reverted: the
    `if (isCustomerContext) return null;`
    guard and the `useSearchParams` import
    were removed from src/App.tsx so the
    install banner re-appears on customer
    routes. The dynamic manifest now ensures
    the installed shortcut points back to the
    correct customer URL, so the banner is
    safe to show.

    Sharp edges:
      - If the portal token is rotated
        server-side, the installed PWA
        shortcut becomes a dead link until
        the customer clicks a fresh Messenger
        link and re-installs.
      - Customers who installed the broken
        admin-context PWA before this fix
        will still have the dead shortcut on
        their device. Remediation: delete
        the broken icon, re-open the portal
        from the latest Messenger link, tap
        Install App again.

    Frontend-only PR. Auto-deploys via
    Firebase Hosting on push. (2026-04-29)
  - 63. /loyalty/redemptions page-access bug:
    PAGE_PERMISSION_MAP in
    src/contexts/PermissionsContext.tsx had no
    entry for /loyalty/redemptions. canAccessPage()
    fell through to `else return false`, denying
    access for every role — admins included — so
    <Protected> rendered AccessDenied universally.
    The sidebar entry in AppSidebar.tsx had no
    permPath either, so the menu item still showed
    up; clicking it landed users on AccessDenied.

    Fixed in commit cc8e7a8 by:
      1. Seeding view_loyalty_redemptions in
         role_permissions via SQL Editor
         (admin/finance/staff = true, csr = false).
      2. Mapping /loyalty/redemptions to the new
         key in PAGE_PERMISSION_MAP.
      3. Adding permPath: ROUTES.LOYALTY_REDEMPTIONS
         to the sidebar menuItems entry so the
         menu item now hides for users without
         the permission.

    Frontend-only PR. Auto-deploys via Firebase
    Hosting on push. SQL applied separately by
    Cynthia in the SQL Editor. (2026-04-29)
  - 64. UI/server gate drift in
    process-loyalty-redemption: commit ab2d955
    gated the RedemptionApprovalModal Approve
    button to admin || finance, but the edge
    function still accepted approve from staff
    (line 214: `isAdmin || isFinance || isStaff`).
    A staff user with the function URL could
    have approved a redemption via direct API
    call (DevTools fetch, Postman, custom
    script), bypassing the UI restriction.
    Self-approval was theoretically possible if
    a staff user was also a customer with their
    own pending redemption.

    Fixed in commit 030d2f9 by dropping
    `|| isStaff` from the approve action gate.
    create gate (admin || finance || staff) and
    cancel gate (admin only) left unchanged —
    they were already correct.

    process-loyalty-redemption is in the
    auto-deploy workflow, so the fix shipped on
    push to main. (2026-04-29)
  - 65. Phase 0 — PWA banner & dynamic
    manifest cleanup. Removed the install
    banner UI, BeforeInstallPromptEvent type,
    beforeinstallprompt/appinstalled event
    listeners, and the data:-URL dynamic
    manifest helper that PR-1 (cae1bc8) and
    PR-2 (bef1949) shipped. Bugs #61 and #62
    above are now SUPERSEDED by this cleanup
    but kept in the file for audit trail.

    Why removed: PR-2's data:-URL manifest
    approach failed Chrome's install-eligibility
    heuristic (data: URLs have opaque origin
    and Chrome cannot resolve relative
    start_url against them), so customers
    never saw a working install prompt
    anyway. Verified via DevTools — manifest
    parsed but Start URL field was empty in
    Chrome's parsed view. This cleanup
    creates a clean baseline for upcoming
    Cloud-Function-backed manifest work
    (Phase 1+ of multi-phase PWA fix project).

    Static manifest from vite-plugin-pwa and
    service worker untouched. iOS Safari
    "Add to Home Screen" still works
    natively (uses current URL with token,
    not start_url from manifest). Existing
    customer devices with broken admin-context
    PWA installed before this cleanup retain
    the dead shortcut — no Phase 0 remediation
    needed; will be addressed by Phase 6
    dead-shortcut UX handler. (2026-04-29)
  - 66. restore-payment DP misallocation.

    Downpayment void→restore misallocated the DP amount across installment schedule rows instead of restoring cleanly. Discovered 2026-05-11 on TEST-008_ELITE 12-month JPY plan: voided ¥900,000 DP, restored, result was months 1-5 Paid (¥175,000 each) + month 6 Partial (¥25,000).

    Regression introduced: commit 41ebca2 (2026-04-20, the bug #37 fix). That fix correctly changed remainingInstallmentAmount from SUM(deleted allocations) to payment.amount_paid. Side effect: the same waterfall now ran for DP payments, which previously had no allocations to spread.

    Affected scope: all plan lengths for any DP void→restore between 2026-04-20 and 2026-05-11. Cohort query 2026-05-11 returned 0 rows — only TEST-008_ELITE was ever affected. No production data cleanup required.

    Fix: commit 62648f5. Added isDownpaymentPayment helper + DP short-circuit in supabase/functions/restore-payment/index.ts. For DPs: clears voided fields, recomputes account totals via canonical formula, writes audit log with kind='downpayment', skips installment waterfall entirely. Manual deploy via Cloud Shell (restore-payment not in AUTO-DEPLOY RULES).

    Verified on TEST-008_ELITE 2026-05-11: happy path and idempotency both pass. dp_allocation_count=0.

    Schema reality clarified:

    - payments has NO is_downpayment, NO payment_type columns. DP detection only via reference_number ('DP-' prefix) and remarks ('down'/'dp' substring).

    - layaway_accounts has NO dp_paid column.

    - payment_allocations.allocation_type enum is 'installment' | 'penalty' only.

    Cash scope: cash_orders have no DPs and no restore function. Bug doesn't apply to cash.

    Pending follow-ups: installment regression check + frontend Restore Payment dialog UX. (2026-05-11)
  - 67. Dashboard restructure to account-counts-only.
    AgingBuckets D2 (TEST exclusion) and D4
    (INVARIANT 2 violation via cache columns)
    closed. New get_aging_buckets(p_scope) RPC
    deployed; reads from
    schedule_with_actuals.actual_remaining
    (canonical), excludes TEST accounts via
    NOT LIKE 'TEST-%', accepts scope parameter
    ('all_collectible' = 4 statuses,
    'active_flow' = 2 statuses, default
    'all_collectible'). Returns raw
    (bucket, currency, account_count, amount)
    rows; frontend converts PHP→JPY via
    toJpy() per row.

    Dashboard now displays counts only across
    all sections. All money KPIs moved to
    Finance:
      - Total Receivables (already on Finance)
      - Collections Today (already on Finance
        Collections tab)
      - Cash Revenue Today (NEW on Finance
        Overview)
      - Cash Revenue This Month (already on
        Finance)
      - This Month layaway (already on
        Finance, twice)
      - Total Overdue with amount (NEW on
        Finance Overview)

    Layaway Accounts section split by 5 fixed
    plan tiers (3M, 6M, 8M, 10M, 12M) per
    plan_configurations reference table.
    Production distribution at restructure
    time: 3M=16, 6M=661, 8M=1, 10M=0, 12M=0
    (active_flow scope).

    Regional Overview now counts-only on
    Dashboard (countOnly prop added to
    GeoBreakdown). Continent rollup
    preserved.

    Live Collection Tracker stripped to
    counts on Dashboard (countOnly prop).
    Full money version remains on Finance
    via same component without the prop.

    Cash Orders section moved above Aging
    Buckets per UX spec. Pending Submissions
    alert raised to operational priority
    slot.
    (2026-04-30)
  - 68. Audit RPCs (audit_account, audit_all_accounts)
    updated to skip accounts with no allocations
    yet. Rule:
      total_paid = 0 AND NOT EXISTS
      (non-voided allocations)
      → audit_skipped: true, all_pass: null

    Rationale: newly created accounts have
    schedule rows but no payment_allocations;
    canonical formula returns valid numbers
    but schedule cache cannot be meaningfully
    validated against them yet. Audit returns
    "not applicable" state instead of failing
    the cache-vs-canonical checks.

    Excluded accounts:
      - INV #18857 (zero payments, zero
        allocations)
      - Any future account in the same state

    NOT excluded:
      - Accounts with payments but no
        allocations (77 historical accounts
        confirmed passing audit — left in
        the audit pool)
      - All other accounts

    Frontend: Check Health button in
    src/pages/AccountDetail.tsx renders an
    "Audit not applicable" info-color badge
    when the response carries
    `audit_skipped: true`, displays
    `skip_reason` as the message body, and
    hides the per-check pass/fail list.
    Existing all_pass green/red branch is
    preserved for the unskipped path.

    (2026-04-30)
  - 69. reconcile_failing_accounts() RPC
    Cartesian product bug fixed. Original RPC
    used double-LEFT-JOIN of payments and
    penalty_fees, causing
    `penalty_amount × payment_count` inflation
    when account had multi-payment + active
    penalty profile. Replaced with two
    independent subqueries.

    Production exposure verified zero before
    fix:
      - Repo investigation: zero callers
        (no frontend, no edge functions, no
        cron schedules in repo migrations)
      - cron.job table: zero references to
        the RPC
      - Diagnostic query: zero accounts with
        current drift matching bug profile

    Bug confirmed on TEST-004 only during this
    session (manual SQL Editor invocation):
    inflated remaining_balance from 2,500 to
    3,000. Already healed.

    Fix snapshots both old and new values
    correctly (original used RETURNING which
    returned post-update values for both
    fields).

    (2026-04-30)
  - 70. TEST-004 audit drift fixed. Symptom
    was failing "sum of pending months matches
    remaining balance" check. Root cause was
    layaway_schedule row 3 cache columns out
    of sync with canonical:
      - status was 'overdue' but should be
        'partially_paid'
      - total_due_amount was 4,000 but should
        be 4,000 (full owed including 500
        penalty), kept on partial_paid rows
        per audit RPC logic
    Manual UPDATE corrections applied via
    SQL Editor:
      - layaway_accounts.remaining_balance
        set to canonical 2,500
      - layaway_schedule row 3 set to status
        partially_paid, total_due_amount 4,000
    All 12 audit checks now pass.
    (2026-04-30)
  - 71. audit_account() Check 12 services
    double-count fixed. The check was adding
    v_services to sum_pending when services
    are already included in total_amount per
    SERVICES RULE. Effect: any account with
    non-zero account_services would have
    falsely failed Check 12.

    Production exposure verified zero before
    fix:
      - Pre-flight query returned no rows —
        zero accounts with non-zero services
        in active/overdue/extension/settlement
        status as of 2026-04-30.

    Fix: removed `+ v_services` term from
    Check 12 sum_pending calculation in
    audit_account() RPC body. No regression
    possible — term was zero on all accounts
    without services. Future accounts with
    services now audit correctly.

    Verified: TEST-004 still passes all 12
    checks. INV #18857 still excluded via
    audit_skipped. System audit count stable
    at 683 audited / 684 in scope / 1 excluded
    / 0 failing.

    (2026-04-30)
  - 72. CLAUDE.md PAYMENT ALLOCATION RULES
    doc-vs-code divergence on partially_paid
    total_due_amount semantics resolved.

    Documentation incorrectly stated
    total_due_amount = "shortfall remaining
    (= base + penalty - paid)" for
    partially_paid rows. Investigation
    2026-04-30 confirmed NO code path
    implements this semantic — all writers
    preserve full-owed value (base + penalty
    + carried). audit_account() Check 12
    expects full-owed and subtracts
    paid_amount separately at audit time.

    Resolution: documentation updated to
    match runtime. Zero code changes. The
    runtime behavior was correct; only
    documentation was wrong.

    (2026-04-30)
  - 73. INVARIANT 2 violations in
    dashboard-summary edge function +
    get_forecast_6m() RPC + Finance.tsx
    forecast drilldown migrated to canonical
    schedule_with_actuals reads.

    Production drift before fix: 1 account
    (INV #18531, JPY, status overdue) with
    ₱1,000 cumulative cache overstatement.
    Post-migration resolves to canonical
    ₱64,186 from cache ₱65,186.

    Migrations:
    - get_forecast_6m() RPC: rewritten to
      read from schedule_with_actuals using
      actual_remaining and computed_status.
      Same return shape preserved. Verified
      drift eliminated of exactly ₱1,000 vs
      cache.
    - dashboard-summary edge function: 4
      cache-read sites at lines 237 (query),
      321-322 (filter), 339-340 (overdue
      sum), 426 (forecast remaining) all
      migrated to canonical.
    - get_forecast_drilldown(p_month text)
      RPC created — server-side join pattern
      matching get_aging_buckets() to avoid
      PostgREST URL-length risk on busy
      months. Returns flat shape with all
      account + customer fields pre-joined.
    - Finance.tsx forecast drilldown
      migrated to use the new RPC.
      Cache-based PostgREST query removed.

    Affected dashboard-summary payload
    fields (now canonical):
      overdue_accounts, overdue_amount,
      due_today_count, due_3_days_count,
      due_7_days_count, predicted_30d/_raw,
      predicted_90d/_raw,
      next_month_expected/_adjusted,
      forecast_6_months[].

    No customer-facing balance change —
    customer portal reads
    layaway_accounts.remaining_balance which
    is already canonical-computed via
    record-payment / void-payment /
    record-multi-payment edge functions.

    (2026-04-30)

  - 74. CLAUDE.md PERIODIC HEALTH QUERIES SQL block had
    'TEST%' (no hyphen) at line ~3243 instead of 'TEST-%'.
    Fixed in same commit.

    Investigation 2026-05-01 confirmed:
    - Single occurrence in CLAUDE.md doc only
    - Zero runtime impact (no TESTxxx-style invoice numbers
      exist in production; all 15 dashboard-summary edge
      function sites use 'TEST-%' correctly; all frontend
      filters use 'TEST-' or 'TEST-%' correctly)
    - Pure doc hygiene fix; defensive against future test-
      naming drift if e.g. a TESTING-001 account were ever
      created

    Stale line-number reference inside the original bug
    description ("line 2278" — actual line was 3243) also
    cleaned up by retiring the bug entry.

    (2026-05-01)

  - 75. CLAUDE.md open bug entry for reminder_total /
    reminder_success / reminder_failed orphan fields was
    incorrect. Fields are fully wired and rendered.

    Investigation 2026-05-01 confirmed:
    - dashboard-summary edge function lines 154-160
      populate the three fields from reminder_logs (count
      queries, no time filter, all-time totals)
    - src/hooks/use-supabase-data.ts:368-370 declares them
      in the summary type
    - src/components/dashboard/SystemHealthPanel.tsx
      consumes them at lines 11-16:
        reminder_total → "Reminders Sent" tile
        reminder_failed → "Reminders Failed" tile
        reminder_success / reminder_total → "Reminder
          Success Rate" %
    - Panel is mounted on Dashboard behind
      can('view_system_health') permission gate

    Yesterday's audit (2026-04-30) likely missed the
    SystemHealthPanel because the permission gate hides it
    from inventory passes. Fields are functioning correctly.

    Resolution: open bug entry retired (Bug #75 entry
    documents the false-positive). No code change.

    (2026-05-01)

  - 76. resolvePortalAuth helper had a bug in session
    validation path. The PostgREST embed
    customer_portal_tokens!inner(is_active) failed silently
    because the schema cache could not resolve the FK
    relationship from customer_portal_sessions to
    customer_portal_tokens (table was created via SQL
    Editor without a subsequent NOTIFY pgrst reload).

    Symptom: all session_id-based auth returned 401/403
    with generic "Invalid portal token" message even when
    the session was healthy. last_used_at never updated.

    Investigation surfaced (2026-05-01):
      - Direct SQL JOIN works (verified via diagnostic
        SELECT)
      - PostgREST embed returns sessionErr that is silently
        swallowed by the helper's generic catch
      - Two diagnostic gaps in helper: missing error logging
        and @ts-ignore on the embed shape access

    Fix: replaced embed with two separate sequential queries
    (session lookup, then token lookup). Eliminates
    embedding-cardinality risk class. Added console.error
    logging on both queries to expose future debugging info.

    Net effect: 2 indexed queries vs 1 failing embed.
    Sub-millisecond combined. Robustness wins over the
    single-query optimization.

    No customer impact — bug only affected dormant Phase A
    session_id path. All 3 edge functions wired in Step
    3a-1 still accept token-only auth normally.

    (2026-05-01)

  - 77. GitHub Actions workflow gap: 7 edge functions that
    import from supabase/functions/_shared/ helpers were
    NOT redeployed when those helpers changed. Only
    send-transactional-email and preview-transactional-email
    propagated _shared/ changes via their deploy step's
    if: condition.

    Symptom: helper changes (e.g., bug #76 fix in
    portal-auth.ts) require manual Cloud Shell deploy of
    every dependent function. GitHub Actions reports
    workflow success but stale code keeps running.

    Investigation 2026-05-01 confirmed:
      - Path filter at line 38 already includes _shared/**
        — workflow runs on _shared changes
      - But each deploy step's if: condition controls
        whether THAT step actually fires within the run
      - Only 2 of 7 affected steps had the _shared/ OR
        clause

    Fix: appended ||contains(...'supabase/functions/_shared/')
    to the if: condition of each of the 7 affected deploy
    steps:
      - submit-payment, join-loyalty-program,
        edit-payment-submission (portal-auth.ts callers)
      - award-loyalty-points, loyalty-inactivity-check,
        process-loyalty-redemption (loyalty-email-gate.ts
        callers)
      - manual-forfeit (check-permission.ts caller)

    Trade-off accepted: portal/loyalty/forfeit functions
    will redeploy on ANY _shared/ change (~60s extra CI
    per false-positive). Acceptable. Could be tightened
    to specific helper files later if CI cost becomes
    a concern.

    Net effect: future _shared/ helper changes will
    auto-propagate to all 7 dependent functions. No more
    manual Cloud Shell deploys for helper updates.

    (2026-05-01)

  - 78. (reserved slot — Phase A Step 3b-2 fix; reverted as part
    of Bug #79 chain. No surviving fix to document.)
  - 79. Phase A 3b-1 frontend token redemption broke PIN
    UI transition. PIN backend verify returned 200/success,
    follow-up portal data calls fired correctly, but the
    UI stayed stuck on PIN entry screen and did not
    transition to dashboard.

    Symptom: Customers entered correct PIN, page did
    nothing. Customers retried, got rate-limited, locked
    out. 3 customers affected today (Test Customer, Diana
    Ramirez, PE RI Dot).

    Detection: Production diagnosis 2026-05-03 evening.
    Backend curl test showed PIN verify working (HTTP 200,
    success:true). Browser network tab showed same. But
    UI did not proceed.

    Root cause: TBD — pending investigation. 3b-1 modified
    PIN response handling to send session_id when present.
    Suspected break in pinVerified state setter or
    re-render trigger.

    Resolution: Reverted commits 703a516, dc31be1, 85a8d23
    via git revert. Pushed at HEAD 235bf30. Affected
    customers unlocked manually via SQL UPDATE.

    Phase A backend (commits 17fa7a6 and earlier) remains
    intact and operational. Token-only auth path still
    works for customers.

    Next step: investigate root cause before any retry of
    3b-1.

    (2026-05-03)

    Deeper investigation 2026-05-04 (post-revert):

    Hypotheses ruled out via runtime evidence:
      - Stale helper deployment: customer_portal_sessions
        had last_used_at populated 6-36 sec after created_at
        for all 3 affected customers, proving helper was
        working at incident time
      - pinVerified state setter changes: structurally
        unchanged in 703a516 diff
      - Response contract changes: verify-portal-pin not
        modified in 703a516
      - React Strict Mode: not enabled in main.tsx

    Remaining suspect: frontend state machine in CustomerPortal
    component fails to render dashboard after setPinVerified(true)
    fires. Specific runtime cause undetermined from static
    analysis.

    Path A reproduction setup completed:
      - Debug branch debug/repro-79 created locally at
        commit 703a516 (NOT pushed to origin)
      - 8 planned console.log instrumentation points
        identified in handlePinSubmit + PIN gate + main
        return
      - Dev server config: bun run dev →
        http://localhost:8080/portal?token=TEST_TOKEN
      - Reproduction guide and decision tree documented in
        Lovable session 2026-05-04

  PWA Install (status verified 2026-05-17):
    - PWA technical infrastructure: SHIPPED ✅ — vite-plugin-pwa generates
      manifest at build time (start_url '/portal/login', scope '/', display
      standalone, theme #D4AF37, background #000000, 192/512/maskable icons).
      Service worker registered in production via vite-plugin-pwa autoUpdate;
      preview environments (lovableproject.com, lovable.app, id-preview--)
      unregister SW per src/main.tsx.
    - Phase A (token-to-session redemption) frontend: ABANDONED 2026-05-04
      (Bug #79 revert). Backend (customer_portal_sessions table,
      redeem-portal-token edge function, resolvePortalAuth helper Path 1)
      remains live but unused from frontend.
    - Phase B (email/password auth): SHIPPED ✅ 2026-05-05 — the sanctioned
      auth flow for installed PWA cold-opens.
    - Known limitation: installed PWA's start_url is '/portal/login' (no
      token). Customers who have NOT completed Phase B email/password setup
      cannot use the installed PWA productively on cold re-open — they must
      keep tapping the Messenger token link each time. Token-only customers
      (per portal-link routing) need migration to Phase B for the PWA install
      benefit to apply. Bulk-send-setup-invites edge function exists to
      proactively migrate them.
    - Install prompt UI (beforeinstallprompt banner): NOT PRESENT. Phase 0
      (Bug #65) removed the broken InstallAppBanner; no replacement shipped.
      Customers install via browser-native A2HS only.

  - 80. Customers menu crashed mobile Chrome on
    app.chajewelsjp.com (iOS) with "Can't open this page"
    error. Pre-existing issue, surfaced 2026-05-04 when
    user was out of office and needed mobile access.

    Root cause: Customers page rendered all 662 customer
    cards at once with no pagination. useAccounts() fetched
    .select('*, customers(*)') duplicating customer data
    per account row, producing ~10 MB payload. Combined
    with ~6,500 React components + ~2,600 SVG nodes,
    exceeded iOS WebKit's per-tab heap limit (~200-300 MB)
    and triggered OOM kill.

    Why other admin pages worked: AccountList paginates at
    30/page. Loyalty Admin paginates members. Only Customers
    page brute-force rendered everything.

    Fix (4 independent improvements, single commit):
    - Tightened useAccounts() embed from customers(*) to
      customers(full_name, messenger_link). Saves payload
      for all consumers (AIRiskPanel, AccountList, Finance)
      without breaking anything.
    - Added useAccountsLight() hook with no embed for
      consumers that don't read account.customers
    - Migrated Customers, Dashboard, NewAccount to
      useAccountsLight()
    - Added pagination on Customers page (50 per page,
      mirroring AccountList pattern)
    - Cleaned up dead useAccounts import in OverdueAlerts.tsx

    Net effect: mobile Customers menu loads correctly.
    Initial render 50 cards instead of 662. Payload from
    accounts query drops from ~10 MB to ~50-100 KB on
    light-hook consumers, and from ~10 MB to ~2-3 MB on
    embed consumers (full_name + messenger_link only).

    (2026-05-04)

  - 81. AlertDialog modals unclickable app-wide. Surfaced
    during Phase B Step 5 testing 2026-05-05 when the new
    "Send Setup Link" confirmation modal couldn't be clicked,
    but the bug affected ALL AlertDialog usages across the app
    (PenaltyFollowUpSection, NotificationsTab, Promotions,
    RewardsTab, Underpayment confirm, etc).
    Root cause: src/index.css lines 181-188 had two CSS rules
    with !important that forced AlertDialog content (role
    "alertdialog") to z-index 60, while AlertDialog overlay
    rendered at z-9999. Result: overlay covered content,
    intercepting all clicks. The rules were originally added
    to layer "Underpayment AlertDialog above Action Dialog",
    but the AlertDialog component now uses z-9999 baseline,
    making the !important rules obsolete and harmful.
    Fix: removed both !important rules from src/index.css.
    AlertDialog modals across the app became clickable immediately.
    Shipped to main 2026-05-06. Lovable previously reported commit
    3d0a1b8 for this fix on 2026-05-05 but that hash was fabricated
    and never reached any branch — fix only landed on main when
    re-applied via direct edit 2026-05-06.

  - 82. Email setup-link button invisible on Yahoo Mail PH.
    Surfaced 2026-05-06 during Cholita pilot migration.
    Root cause: portal-setup-invite.tsx button used
    backgroundColor: 'hsl(44, 72%, 47%)'. Yahoo Mail's
    renderer strips HSL color values entirely from inline
    styles, leaving white text on transparent background.
    Brendalyn's earlier email (yahoo.com) hit the same bug —
    she had to drag-select the area to reveal the button.
    Fix: converted backgroundColor to '#CEA021' hex equivalent
    in supabase/functions/_shared/transactional-email-templates/portal-setup-invite.tsx.
    Manually deployed via npx supabase functions deploy
    send-transactional-email since auto-deploy can be stale.
    Subsequent Cholita migration verified visible button.
    Shipped e0c7719 / 2026-05-06. General rule: email template
    inline CSS must use hex or rgb(), never hsl().
    2026-05-07 update: e0c7719 HSL→hex fix did NOT fully resolve.
    Sheryl Blaza Virtus-Lee hit same invisible-button issue today
    even with valid hex #CEA021 after a fresh send-transactional-email
    deploy. Root cause clarified: Yahoo Mail strips inline
    background-color from bare <a> tags (documented behavior — Litmus
    discussion 1393, Email on Acid Yahoo tips, ActionRocket bulletproof
    buttons). React Email's <Button> v0.0.22 renders as a bare anchor.
    The 25 other transactional templates work on Yahoo because their
    <Section> wrapper renders as <table role="presentation">, which
    Yahoo recognizes as layout context and preserves the anchor styling.
    portal-setup-invite was the lone orphan-anchor template.
    Fix shipped: wrapped <Button> in <Section style={{textAlign:
    'center', margin:'24px 0'}}>. No color or button const changes —
    minimal Section wrapper only. New rule: all transactional email
    <Button> elements MUST be wrapped in a <Section> for Yahoo Mail
    compatibility.
    2026-05-07 verified: fix confirmed via Brenda Tuliao Yahoo Mail
    screenshot. Same-day bulk rollout delivered fixed-template setup
    invites to 582 customers (30 in initial partial run 09:32 UTC +
    540 in clean drip 09:44-09:57 UTC, plus 12 in targeted cleanup
    for pre-fix recipients). DLQ count unchanged at 89 — zero new
    bounces. Operational learning: bulk-send-setup-invites has an
    effective ~30 internal-call rate limit per invocation; batch_size
    25 is the safe ceiling. Bug #82 closed end-to-end.
    2026-05-19 update: SECOND OCCURRENCE in a different directory.
    Yahoo Mail recipient syge82@yahoo.com received the Supabase Auth
    signup confirmation email today with the same invisible-button
    defect. Investigation revealed the May 7 Section-wrap fix was
    applied ONLY to _shared/transactional-email-templates/ — the
    parallel _shared/email-templates/ directory (6 auth templates
    serving Supabase Auth events) was never swept. 5 of the 6 had
    the same untreated bare-anchor defect: signup, recovery,
    magic-link, invite, email-change. (reauthentication has no
    <Button> — OTP code only — unaffected.) signup.tsx additionally
    had HSL backgroundColor never converted to hex.

    Fix shipped 2026-05-19: all 5 affected auth templates wrapped
    <Button> in <Section style={{textAlign:'center', margin:'24px 0'}}>,
    added display:'inline-block' + margin to button style constant.
    All 5 templates used identical hsl(44, 72%, 47%) backgroundColor
    — all converted to #CEA021. (No template had a pre-existing
    hex color to preserve; CHANGE C's "IF hex → preserve" branch
    was unreached.)

    NEW UNIVERSAL RULE: All transactional email <Button> elements
    across BOTH email-template directories MUST be wrapped in a
    <Section> AND use hex (or rgb()) backgroundColor — never HSL.
    Applies to:
      supabase/functions/_shared/transactional-email-templates/*.tsx
      supabase/functions/_shared/email-templates/*.tsx
    Mandatory for all new templates added to either directory for
    Yahoo Mail compatibility.

    DEPLOY NOTE: auth-email-hook is NOT in
    .github/workflows/supabase-functions-deploy.yml — changes to
    _shared/email-templates/ require manual Lovable IDE deploy of
    auth-email-hook. (GitHub Actions auto-deploy also non-functional
    since 2026-05-15 due to missing SUPABASE_ACCESS_TOKEN +
    SUPABASE_PROJECT_REF secrets.)

    Bug #82 THIRD occurrence — fixed 2026-05-19 via commit 9e3bd1f.
    Yahoo verify button STILL invisible after 2026-05-18 Section+hex+inline-block fix
    (5b3aeff). Root cause: @react-email/components@0.0.22 <Button> renders to
    <a style='display:inline-block;background-color:#CEA021;...'>
      <span style='display:inline-block;line-height:120%;mso-text-raise:9px'>...</span>
    </a>. Yahoo Mail strips the inner <span>'s sizing styles, collapsing the button
    to zero visible width. The second-occurrence fix targeted the outer anchor's
    parent (Section + hex + inline-block on the <a>) — it never touched the inner
    <span>, so the root cause persisted. 5b3aeff is SUPERSEDED.

    FIX (9e3bd1f): bulletproof table-anchor pattern replaces <Button> across 5 auth
    templates (signup, recovery, magic-link, invite, email-change). Pattern:
      <table align='center' role='presentation'><tbody>
        <tr><td bgcolor='#CEA021' style='backgroundColor:#CEA021;borderRadius:10px'>
          <a href={url} style='display:inline-block;padding:12px 24px;color:#ffffff;
             textDecoration:none;lineHeight:100%;...'>LABEL</a>
        </td></tr>
      </tbody></table>
    No nested <span>. <td bgcolor> attribute (legacy HTML, Yahoo respects).
    border-radius on <td>. Padding on <a>. Reauthentication.tsx unaffected
    (OTP-only, no <Button>). auth-email-hook deployed via Lovable IDE after commit;
    empirically verified on Yahoo at 2026-05-19 18:23 JST (recipient
    h8redthanblue@yahoo.com — Verify Email button rendered correctly).

    UNIVERSAL RULE (locked 2026-05-19): React-Email <Button> component is unreliable
    on Yahoo Mail due to its nested <span> structure. Use hand-rolled table-anchor
    pattern for ALL auth and transactional email buttons going forward. The earlier
    'Section-wrap + hex/rgb, never HSL' rule from 2026-05-18 is necessary but
    INSUFFICIENT — the table-anchor structural change is required.

  - 83. PortalSetup got stuck on Loading screen forever after
    email verification round-trip. Surfaced 2026-05-06 during
    Brendalyn migration after a corrupted customer email caused
    setup-customer-account to fail to match by email. Two
    compounding bugs: (a) the bootstrapping flag was never
    cleared in the session-exists path, so React kept rendering
    the spinner indefinitely; (b) the setup-customer-account
    fetch had no timeout, so a hung or failed request never
    resolved to an error state. Fix in src/pages/PortalSetup.tsx:
    moved setBootstrapping(false) before the if/else branch so
    it always clears, and added AbortSignal.timeout(15000) plus
    TimeoutError handling in the catch block to surface a clear
    error message after 15 seconds. Shipped 633c211 / 2026-05-06.

  - 84. Phase B routes (/portal/setup, /portal/login,
    /portal/forgot-password, /portal/reset-password) returned
    404 for customers with previously-installed PWAs or recent
    visits. Surfaced 2026-05-06 during Brendalyn migration —
    hard refresh resolved the symptom but not the cause. Root
    cause: the PWA service worker (built by vite-plugin-pwa
    with registerType: 'autoUpdate') served cached pre-Phase-B
    index.html which referenced bundles that did not contain
    the new routes. React Router 404'd on the unknown path.
    Fix: three additions to vite.config.ts workbox config —
    cleanupOutdatedCaches: true (purges stale precaches on SW
    activation); explicit navigateFallback: 'index.html' with
    denylist regex /\/[^/?]+\.[^/]+$/ (controlled SPA fallback
    without redirecting file requests); runtimeCaching entry
    with NetworkFirst handler for navigation requests
    (request.mode === 'navigate'), networkTimeoutSeconds: 3,
    expiration 50 entries / 86400 seconds. Existing PWA users
    may need ONE reload after the new SW installs to pick up
    the change; thereafter navigation requests always try
    fresh HTML first. Shipped 4014f97 / 2026-05-06.

  - 85. EditCustomerDialog DB-side defense-in-depth shipped.
    prevent_customer_code_change trigger blocks UPDATE of
    customers.customer_code from direct PostgREST calls,
    future RPCs, and manual SQL Editor mistakes. Frontend
    lock at EditCustomerDialog (per Known Fixed Bug #54) is
    unchanged; the trigger adds belt-and-suspenders
    enforcement at the DB layer. Forensic repair uses
    transaction-scoped GUC bypass:
    SET LOCAL app.allow_customer_code_change = 'on'; before
    UPDATE — pattern mirrors app.bypass_immutable_schedule_cols
    and app.allow_base_edit. Migration file
    20260508002747_prevent_customer_code_change.sql. Closes
    the deferred P3 defensive item logged 2026-04-30 (was in
    Dashboard restructure follow-ups + P3 Defensive list of
    Known Open Bugs). All 3 smoke tests passed in production
    SQL Editor before commit. Shipped 35c5c4a / 2026-05-08.

  - 86. Loyalty Tier "Radiant" had free_shipping_min_items
    = 4 stored in DB despite Radiant not being eligible for
    free shipping. Surfaced in Loyalty Admin → Tiers tab
    where Radiant card showed "Free shipping on 4+
    qualifying items" alongside "2x points". Component
    rendering logic was correct (purely DB-driven); only
    the data was wrong. Fixed via SQL UPDATE setting
    free_shipping_min_items = NULL on Radiant tier. Audit
    log entry written with action='tier_data_fix'. Schema
    gap that allowed the drift (only 3 benefit columns
    modelled vs richer customer-portal TIER_STATIC) tracked
    as Phase 5 — Tier Benefits Schema Expansion in PENDING
    ITEMS. Verified in production 2026-05-08.

  - 87. Reward Detail Modal CTA hidden behind
    LoyaltyBottomNav. The Confirm Redemption button on
    customer portal Rewards tab → reward card → modal sat
    flush against viewport bottom (modal had `flex
    items-end`) with only 24px panel padding; the bottom
    nav (~60-100px tall depending on safe-area) overlaid
    the bottom edge. Modal overlay used `z-50`; bottom nav
    also used `z-50` — same z-index falls back to DOM
    paint order. LoyaltyPortal mounts BottomNav AFTER
    RewardsScreen, so nav painted on top of CTA. Customer
    couldn't complete the redemption flow at all on web
    or mobile, blocking Phase 3.2.1 smoke testing. Fixed
    in src/components/loyalty/screens/RewardsScreen.tsx
    via two surgical className edits: overlay z-50 →
    z-[60], inner panel + pb-[calc(env(safe-area-inset-bottom)+5.5rem)]
    + max-h-[90dvh] + overflow-y-auto. dvh used instead
    of vh for iOS Safari address-bar reliability.
    Surfaced + fixed 2026-05-08. Shipped 3d8fc10.

  - 88. RewardsScreen invoice placeholder showed
    "e.g. CJ-2026-12345" — that's the customer_code
    naming pattern (CJ-YYYY-XXXXX), NOT an invoice
    number. Customers typing their own customer_code
    into the field would fail backend validation
    ("Invoice number does not match account") since
    process-loyalty-redemption matches against
    layaway_accounts.invoice_number /
    cash_orders.invoice_number which are 5-digit
    numeric values (e.g., 18857, 19012, 10001). Fixed
    to "e.g. 19012" — matches the canonical format
    already used in src/components/loyalty/RedemptionForm.tsx:305
    and src/pages/NewAccount.tsx:530+. Single source of
    truth. Surfaced + fixed 2026-05-08. Shipped 08f97fb.

  - 89. process-loyalty-redemption returned 401 on
    customer-side action='create' calls. Function used
    raw supabase.auth.getUser(jwt) and explicitly
    rejected non-internal roles at the create-branch
    role gate (`!(isAdmin || isFinance || isStaff)` →
    403, OR 401 if anon-key fallback was sent). Customer-
    portal RewardsScreen calls the function but customer
    has no admin role; calls failed in production
    2026-05-08 during Phase 3.2.1 smoke test. Root cause:
    Phase B Step 3f-2 (commit 08f1eb0, 2026-05-05) wired
    7 portal edge functions to use the shared
    resolvePortalAuth helper but MISSED this one — at
    that time the function was admin-only and customer-
    side calls hadn't been built into the customer portal
    Rewards tab. Phase 3.2 (catalog redemption wiring,
    2026-05-01, commit f632b5c) added the customer-side
    action='create' calls but the auth-side counterpart
    was never updated. Fixed by refactoring the auth
    chain in process-loyalty-redemption: try internal-
    role auth (admin/finance/staff via auth.getUser +
    roles table) FIRST; for action='create', fall through
    to resolvePortalAuth which supports Path 0 (Bearer
    JWT → customers.auth_user_id, Phase B session-auth)
    and Path 2 (portal_token → customer_portal_tokens.
    is_active, legacy token-auth). approve/cancel/void
    branches remain admin-only — their existing role
    checks would reject customer auth anyway. Member
    ownership check added: when customerId is set
    (customer self-service), member_id must belong to
    that customer (maybeSingle on loyalty_members,
    mismatch returns 403 before any DB writes).
    created_by_user_id changed from `user.id` to
    `user?.id ?? null` to handle the customer self-
    service path where user is null (column nullable per
    schema). Companion frontend commit 02c88d6 added
    portal_token to the supabase.functions.invoke body
    so resolvePortalAuth Path 2 works for legacy
    token-auth customers. Shipped d06a16e.

  - 90. process-loyalty-redemption action whitelist
    didn't include "void". Latent regression introduced
    in commit 203b654 (Phase 3.2.1 C2 void branch). The
    dispatch validator at the top of the handler had
      if (!action || !["create", "approve", "cancel"]
        .includes(action))
        return 400 "action must be 'create', 'approve',
        or 'cancel'";
    so calls with action='void' hit a 400 BEFORE
    reaching the new void branch — the entire void
    branch was unreachable in production. Discovered
    during Bug #89 auth refactor; the same commit that
    wired resolvePortalAuth (d06a16e) also added 'void'
    to the whitelist and updated the error message to
    list all 4 actions. The void branch was never tested
    end-to-end before this fix because the auth-401
    blocked smoke testing.

  - 91. LoyaltyMemberData type missing
    loyalty_members.id UUID — RewardsScreen redemption
    submit was sending JSON body without member_id,
    backend received undefined and JSON.stringify dropped
    the field, causing 400 "member_id is required". Root
    cause: LoyaltyMemberData carried member_id (the
    user-facing customer_code "CJ-YYYY-XXXXX" displayed
    in MemberCard / ProfileScreen / etc.) but never the
    internal loyalty_members.id UUID needed by the
    backend. RewardsScreen tried to read member.id via
    `(member as any).id` cast, finding undefined. The
    `(member as any)` cast hid the bug since Phase 3.2
    (commit f632b5c, 2026-05-01) — TypeScript would have
    caught it immediately if the cast hadn't been there.
    Fixed by extending LoyaltyMemberData with two new
    UUID fields (id + customer_id) distinct from the
    user-facing member_id field, populating them in
    LoyaltyPortal's memberData useMemo from the non-null
    `member: LoyaltyMember` prop (parent gates on
    `if (!member) return <JoinPrompt />`, so the prop is
    guaranteed non-null when memberData is built — no
    `?? ''` fallbacks needed), and removing all 3
    `(member as any)` casts in RewardsScreen.tsx (lines
    106, 139, 141). Companion to backend Bug #89 +
    portal_token frontend wiring (commit 02c88d6).
    Shipped 57e7182. General lesson: avoid
    `(x as any)` casts in customer-portal flow — they
    silently disable type checking for properties that
    don't exist, hiding real bugs from the test suite.

  - 92. submit-cash-payment dispatch routed staff Bearer JWTs into
    customer portal Path A because supabase-js auto-attaches the
    Authorization header — Path B (staff role check) never
    reached, blocking all admin/staff cash payment submissions
    with toast "No customer linked to this account" — fixed with
    role-check disambiguation at the dispatch entry point
    (2026-05-10)

  - 93. RecordCashPaymentDialog.tsx labeled Proof of Payment as
    "(optional)" and isFormValid did not require !!proofFile, allowing
    admin/staff cash payment submissions without proof — violated
    PROOF OF PAYMENT locked rule — fixed with required-asterisk
    label, !!proofFile guard in isFormValid, and dropzone "required"
    hint (2026-05-10)

  - 94. Frontend Restore Payment dialog UX for DP payments (2026-05-11).
    Bug #66 follow-up. Restore Payment dialog showed monthly due range
    chooser even when restoring downpayments. Backend short-circuited
    DPs correctly (bug #66) but UX was misleading. Fix:
    src/pages/AccountDetail.tsx — added dpRestoreTarget state, branched
    Restore button click via isDownpaymentPayment helper, added simple
    "Restore Downpayment" confirmation modal matching the Void Payment
    custom-div pattern. Installment restoration path unchanged.
    Commit: 571f4ec.

  - 95. Loyalty Points Preview simplified on layaway and cash detail
    views (2026-05-11). Removed "Customer Tier" line, "Points to Earn"
    line, and footnote from both src/pages/AccountDetail.tsx and
    src/pages/CashOrderDetail.tsx. Kept only "Loyalty Amount" line with
    same gate conditions (>=10000 for layaway, >0 for cash). Removed
    Sparkles import from both files. Preserved useCustomerLoyaltyTier
    hook + import for future use.
    Commit: 91e1c51.

  - 96. Loyalty Amount moved to compact metric card on layaway account
    detail (2026-05-11). Replaced standalone simplified Loyalty Amount
    panel with a 6th compact card in the top metric row, matching
    TOTAL LA AMOUNT card styling. Grid already lg:grid-cols-6 so no
    template change needed. Cash detail unchanged (keeps simplified
    panel).
    Commit: 59657cf.

  - 97. Payment History sort order fixed to chronological on admin
    surfaces (2026-05-11). Payment History on TEST-008_ELITE showed
    installment above DP despite both having date_paid May 11, because
    the comparator only used date_paid and tied rows preserved
    server-side DESC input order. Fixed in src/pages/AccountDetail.tsx
    line 1733 — sort comparator changed from date_paid to created_at.
    Cash side fixed in src/pages/CashOrderDetail.tsx — useCashPayments
    hook .order() flipped from descending to ascending by created_at.
    created_at has microsecond precision so same-day payments are no
    longer tied. Per CLAUDE.md Display Rules ("Payment History →
    always show created_at"). Bug always existed but only surfaced
    when multiple payments recorded same day. Commit: 5ca29f3.
    Customer-facing surfaces (CustomerStatement.tsx, CustomerPortal.tsx)
    deferred — edge function changes needed to expose created_at to
    client payload (filed in Known Open Bugs).
98. award-loyalty-points ratchet-up multiplier on tier-crossing
purchase (2026-05-12). When a qualifying purchase crossed a tier
threshold, the award used the PRE-upgrade multiplier instead of
POST-upgrade. Fixed to recompute effective tier after spend is added,
then apply the resulting multiplier. Shipped via PR #6 (commit
da5cb9c). Note: PR #6's CLAUDE.md merge conflict in this section
was resolved 2026-05-13.
99. Loyalty lifecycle reversal infrastructure (2026-05-13). Wires
revoke and award into all account/payment lifecycle events that
should impact loyalty. Added spend_basis_jpy column on
loyalty_point_lots for lot-based math + active-lots-aware
idempotency; deployed revoke_loyalty_points and
restore_loyalty_points RPCs; added loyalty-tier-revoked email
template; wired 11 lifecycle paths (void/restore-payment,
void/restore-cash-payment, manual-forfeit, auto-forfeit-settlement
5 hooks, delete-account); documented Decisions 5 (reactivate-account
no-op) and 7 (edit-payment-amount no-op). Full design + wiring in
LOYALTY LIFECYCLE INTEGRATION section.
100. Loyalty revoke in-portal notification recipient gap (2026-05-14).
revoke-loyalty-points was inserting into loyalty_notifications (master row)
only, skipping the loyalty_notification_recipients table. Customer portal
uses INNER JOIN on recipients — meaning revoke tier-transition notifications
never surfaced to customers, even when email + master row fired correctly.
Surfaced during Bug #99 empirical verification prep. Fixed by replacing
inline insert at revoke-loyalty-points/index.ts lines 254-272 with shared
emitNotification helper (matches award-loyalty-points pattern, writes both
rows). Affects all 11 lifecycle paths that pipe through revoke-loyalty-points.
101. Loyalty revoke/restore lifecycle business rule correction (2026-05-14).
Per business owner decision, loyalty revoke is restricted to actual
forfeiture statuses only (forfeited, final_forfeited). PATH 3 →
final_settlement now preserves loyalty (lots stay active).
reactivate-account now auto-restores loyalty by calling restore-loyalty-points
on the most recent revoke transaction. Reverses Bug #99's Decision 5 (was
"no auto re-award"). Surfaced during auto-forfeit empirical verification
on test fixture CJ-2026-FORFEIT-P3 (PATH 3 incorrectly revoked customer's
lot even though account went to final_settlement, not forfeited).
Cancel-account documented as future requirement — no code path writes
account.status = 'cancelled' today.
102. iCloud email deliverability — investigated and filed as won't-fix at our layer (2026-05-14).
During Bug #99/100/101 empirical verification, user reported zero emails arriving at
efrhyll.largo@icloud.com despite all upstream functions returning success. Investigation:
  - suppressed_emails table: email NOT on suppression list
  - email_send_log: 6 emails between 03:10-04:21 UTC all reached status='sent'
    (3× account-forfeited, 1× loyalty-tier-revoked, 2× extension-granted)
  - No error_message rows, no DLQ moves, no failed retries
  - Each followed pending → sent lifecycle cleanly via pgmq + @lovable.dev/email-js
  - Same-day test inbox chajewelsjapan@gmail.com received emails normally
    (TEST-008_ELITE forfeit at 01:53 UTC arrived in both account-forfeited + tier-revoked)
Root cause: deliverability failure is downstream of our system. Either Lovable's email
infrastructure silently drops iCloud-bound mail, or iCloud silently filters by sender
reputation of notify.chajewelsjp.com. iCloud is well-documented for this behavior — no
bounce, no error, mail simply doesn't arrive. Not a codebase bug; we have no visibility
into Lovable's per-recipient delivery attempts.
Mitigation paths (none code-side):
  1. Verify SPF/DKIM/DMARC alignment for notify.chajewelsjp.com (Lovable manages, confirm)
  2. Open Lovable support ticket for delivery-state diagnostics beyond 'sent'
  3. Sender reputation hardening over time (volume, low complaint rate)
  4. Capture backup non-iCloud contact channel for business-critical recipients
Closing out as our system is functioning correctly per design and per its observable
contract with the email service.

103. Loyalty Tier Restored email template + restore-loyalty-points wiring (2026-05-15).
restore-loyalty-points was sending loyalty-tier-upgrade template on tier transition
after restoration — semantically wrong (upgrade implies new achievement, restoration is
recovery of prior state). Added new loyalty-tier-restored template (gold-accented,
restorative tone, 3 reason variants: account_reactivated, payment_restored,
manual_restore). Wired into restore-loyalty-points via new trigger_event parameter
(mirror of revoke-loyalty-points TriggerEvent pattern). Also fixed a Bug #100-style
recurrence: restore-loyalty-points was using direct loyalty_notifications insert
instead of shared emitNotification helper, so in-portal bell notifications never
surfaced to customers via the INNER JOIN on loyalty_notification_recipients. Switched
to emitNotification helper. Updated reactivate-account to pass
trigger_event="account_reactivated" in restore fetch. Added new email gate
loyalty_email_tier_restored.

   Empirically verified 2026-05-15 03:19:58 UTC — email_send_log row sent
   (template_name='loyalty-tier-restored'), loyalty_notifications master +
   recipient rows present, tier transition Glimmer→Radiant, restore transaction
   ledger entry created.

104. PostgREST 1000-row cap dropping oldest accounts in useAccounts/useAccountsLight hooks (2026-05-15).
Default PostgREST page limit silently truncated query results in src/hooks/use-supabase-data.ts, causing the oldest active accounts to disappear from admin views as the account count grew past 1000. Fixed by paginating queries with multi-page fetching (commit 67ad485, 02:02 UTC), then raising MAX_PAGES from 20 to 1000 in a follow-up tweak (commit c22ec23, 02:10 UTC) to accommodate the full active account set.
105. restore_loyalty_points RPC failed to increment member.remaining_points when lot.expires_at IS NULL — fixed asymmetric NULL handling in the counter IF clause (Bug #105, 2026-05-15).
106. reactivate-account skipped Extension Month row when not all installments paid, making extension cap path unreachable for PATH 2 forfeits — fixed to always create Month 4 row (Bug #106, 2026-05-15).
108. reactivate-account computed extension_end_date from lastDueDate + 1mo, producing past dates for severely-overdue forfeited accounts — fixed to today + 1mo per business rule (Bug #108, 2026-05-15).
109. send-transactional-email had no idempotency check before INSERT — added pre-INSERT check, idempotency_key column write, and concurrent race handler (2026-05-15). NOTE: The "duplicate emails" symptom was misdiagnosed during initial investigation. What appeared as 4 emails was actually 2 logical emails × 2 lifecycle rows each (pending row from send-transactional-email, sent row from process-email-queue dispatcher, sharing same message_id). The idempotency check is still beneficial as defense against genuine retry/race duplicates but did not fix what we initially thought.
107. auto-forfeit-settlement extension cap path wrote identical revoke notes text as the extension expiry path ("Final forfeit (extension expired)"), making the two paths indistinguishable via loyalty_transactions.notes — fixed cap path to write "Final forfeit (extension month penalty cap)" for forensic clarity. audit_logs.action already differentiated them via "auto_forfeit_extension_penalty_cap" vs "final_forfeited" (2026-05-15)
110. review-payment-submission award-loyalty-points calls for layaway DP (single-account ~line 830 + multi-account split ~line 873) were fire-and-forget without await. Deno Deploy suspended the worker after the parent response returned, killing in-flight fetches before they reached award-loyalty-points. Cash-order path (~line 676) already used await fetch and worked correctly (Jan Jovic invoice 19048 earned 200 pts 2026-05-16). Fixed by adding await on both layaway DP call sites. Bug discovered during investigation of invoice 19046 (Nathalie Tupas, 2026-05-17) but did not actually cause that invoice's missed earn — see #113 for the real cause. Fix remains valid for any future JPY layaway DP confirmation. (2026-05-17)

  111. Loyalty tier validation on new account creation (2026-05-17).
  Customers tagged with a loyalty tier (any non-null
  loyalty_members.current_tier_id) now require loyalty_jpy_amount
  on the new account creation form. Four tiers in production:
  Glimmer (452 members), Radiant (22), Elite (1), Crown VIP (0).
  Two-layer enforcement:
    - Frontend (src/pages/NewAccount.tsx): imports useCustomerLoyaltyTier,
      derives isLoyaltyAmountRequired and loyaltyAmountMissing, label turns
      red with asterisk, inline error helper "Required for loyalty tier
      members" appears under the input, submit button disabled when missing,
      handleSubmit shows toast.error("This customer is a {tier_name} loyalty
      member. Loyalty Product Amount (JPY) is required.")
    - Backend (supabase/functions/create-layaway-account/index.ts):
      loyalty_members lookup before INSERT, returns 400 LOYALTY_AMOUNT_REQUIRED
      with message "Customer is a {tier} tier member. Loyalty Product Amount
      (JPY) is required." if customer has tier and loyalty_jpy_amount is
      null or <= 0
  Existing accounts without loyalty_jpy_amount unaffected — rule only applies
  at creation. Cash orders not in scope.
  Edge function manually redeployed via Cloud Shell (NOT in auto-deploy list).
  Commit: 2f561f8.

  112. Forensic AFTER DELETE trigger on layaway_schedule (2026-05-17).
  Stage 1 of a 2-stage blocker for unexplained schedule row deletions.
  Symptom: monthly installments occasionally vanish from accounts with no
  schedule_audit_log entry. Root cause investigation identified FK ON DELETE
  CASCADE from layaway_accounts.id as the silent path — any account delete
  (via delete_account_atomic RPC, or direct DELETE FROM layaway_accounts in
  SQL Editor) wipes all schedule rows with zero schedule-level audit trail.
  Stage 1 ships now (non-blocking, forensic only). Stage 2 (hard BEFORE DELETE
  block with GUC bypass for delete_account_atomic and delete-installment)
  deferred until forensic data confirms the pattern.
  SQL Editor migration applied today:
    1. ALTER TABLE schedule_audit_log ALTER COLUMN admin_user_id DROP NOT NULL
       (cascades have no admin attribution)
    2. CREATE FUNCTION log_schedule_deletion() — captures full OLD row data
       as JSON (installment_number, due_date, base_installment_amount,
       penalty_amount, total_due_amount, paid_amount, currency, status,
       carried_amount, carried_from_schedule_id, carried_by_payment_id,
       generated_at, updated_at, session_user, current_user), attempts to read
       JWT 'sub' claim for admin_user_id (NULL on cascade or direct SQL)
    3. CREATE TRIGGER log_schedule_deletion_trigger AFTER DELETE ON
       layaway_schedule FOR EACH ROW
  Audit row pattern:
    - action='forensic_delete', field_changed='row_deleted'
    - admin_user_id populated → legitimate edge function path
    - admin_user_id NULL → cascade or direct SQL (session_user in old_value
      JSON identifies which)
  Legitimate delete-installment flow now produces 2 audit rows per delete
  (existing action='delete_installment' + new action='forensic_delete').
  Unexplained deletes produce only the forensic row.
  Stage 2 design draft (NOT shipped): BEFORE DELETE trigger raising EXCEPTION
  unless transaction-scoped GUC app.allow_schedule_delete='on' is set.
  Bypass would be wired into delete_account_atomic RPC and delete-installment
  edge function (SET LOCAL before delete). Awaiting forensic evidence.

  113. award-loyalty-points used account/cash_order.currency as a JPY-only gate, discarding the loyalty_jpy_amount field that the schema deliberately stores as the loyalty spend basis. Effect: all PHP-currency accounts (the majority of customers) were silently excluded from earning loyalty points; their loyalty_jpy_amount field (populated at account creation from the Product Amount (JPY) — Loyalty Only form input) was dead data. Fixed by replacing the currency gate with an amount gate: `if (!(loyaltyJpy > 0))` skip with reason="no_loyalty_amount". Both PHP and JPY accounts now earn correctly using loyalty_jpy_amount as the canonical basis (excludes shipping, service fees, insurance per design). Bug surfaced via invoice 19046 (Nathalie Tupas) on 2026-05-17 — manual invocation returned {"reason":"wrong_currency","skipped":true} after the fire-and-forget bug #110 was already shipped. (2026-05-17)

  114. send-reminders RateLimitError silent failure (fixed
  2026-05-18): Supabase Edge Function per-invocation outbound fetch
  is rate-limited; when send-reminders processes 30+ fetches in quick
  succession, subsequent calls throw RateLimitError. The catch block
  at lines 277-280 swallowed the error without retrying, causing all
  due_today alerts (positional 31-35 in iteration order: penalty +
  grace-period first, then due_today, then due_3_days, due_7_days) to
  fail in both daily cron runs since 2026-05-12 — with 100% failure
  rate from 2026-05-16 through 2026-05-18 (volume/timing alignment).
  reminder_logs system rows were created (template_type='due_today',
  channel='system', delivery_status='generated') but email_send_log
  received no pending rows, and reminder_logs UPDATE to
  channel='email' never fired.
  Fix: added fetchWithRetryOnRateLimit helper at top of
  supabase/functions/send-reminders/index.ts (3 retries with
  retryAfterMs+50ms backoff). Used at lines 197 (grace branch) and
  line 239 (regular branch).
  Root cause confirmed empirically: curl test of
  send-transactional-email with type='due_today' payload returned
  {success:true,queued:true}, ruling out template/render/INSERT
  failure. Edge function logs at 2026-05-18 00:03:00 UTC showed
  RateLimitError from ext:deno_fetch: "Rate limit exceeded for trace
  019e3863... Retry after 93ms" at send-reminders index.ts:197:32.
  Customer impact: ~17 customers across 2026-05-16/17/18 missed
  on-the-day due_today reminders; received other-stage reminders
  (due_7_days, due_3_days, grace-period, penalty if applicable)
  before and after. No backfill or outreach (per Cynthia 2026-05-18 —
  fix prevents recurrence; missed reminders were single-occurrence
  per customer).
  Deployment: manual via Lovable (auto-deploy broken since
  2026-05-15).
  (Numbering note: this fix is "Bug #110" in the Phase 7 task brief
  and commit message; #110 was already taken by the 2026-05-17
  review-payment-submission await fix, so it is recorded here as
  #114 — the next free flush-left number — per the established
  no-duplicate-numbering rule.)
  ROOT CAUSE UPDATE (2026-05-20): the per-invocation Deno fetch rate
  limit was a contributing symptom, but the real driver was a
  duplicate cron — jobid 14 'daily-payment-reminders' ('2 0 * * *')
  fired the same /send-reminders endpoint 2 min after jobid 1
  'daily-send-reminders' ('0 0 * * *'), doubling the midnight
  burst (~146/hr) past Lovable's 100/hr workspace cap. Both crons
  produced identical batches (send-reminders ignores the body
  payload). Duplicate cron removed 2026-05-20 — the actual volume
  fix. fetchWithRetryOnRateLimit (8ea5b2a) remains in place to
  handle transient 429s. See EMAIL SENDING — LOVABLE WORKSPACE
  RATE LIMIT section for full architecture + standing mitigations.

  117. total_due_amount recompute dropped carried_amount (fixed;
  code on main from a prior session, redeployed 2026-05-21).
  penalty-engine (Step 5 + Step 5b self-heal), add-penalty, and
  approve-waiver recomputed total_due_amount = base + penalty,
  overwriting the carried_amount that carry-over bakes into
  total_due. Any carried row that went overdue and was penalized
  lost its carry from total_due_amount, per-row remaining, and
  sum-of-pending. Account-level totals stayed correct — the
  canonical formula reads payments, not schedule caches — so the
  blast radius was per-row display + sum-of-pending only.
  Fix: all four recompute sites now compute
  base + penalty + (carried_amount ?? 0); approve-waiver's SELECT
  was extended to load carried_amount. The fix was already on main
  from a prior session but undeployed — redeployed 2026-05-21 to
  make it live. See CARRIED_AMOUNT PRESERVATION section.
  Census 2026-05-21: 21 carried rows; 20 healthy, only INV #18693
  (the lone overdue+penalized carried row) was wiped — no other
  affected population. #18693 repaired (see TODAY'S DATA FIXES
  2026-05-21).
  (Numbering note: #115 and #116 are Known Open Bugs; this fixed
  entry takes #117 — the next free flush-left number — per the
  no-duplicate-numbering rule.)

  118. Dashboard "Overdue & Due Soon" card read total_due_amount
  cache instead of canonical actual_remaining (fixed 2026-05-22,
  commit bb7e429). OverdueAlerts.tsx queried raw layaway_schedule
  and displayed item.total_due_amount — a DISPLAY-RULE violation
  (schedule caches are write-only, never read for display). On
  drifted rows it overstated the amount: INV #17636 inst 4 showed
  the stale ₱13,886 cache when canonical remaining was ₱1,000.
  Fix: repointed the ['overdue-schedule'] query to
  .from('schedule_with_actuals'), switched the status filter to
  computed_status, and now displays Number(item.actual_remaining ?? 0).
  Verified live: card renders via the view embed and shows canonical
  values (#17636 → ₱1,000). Account-level totals were never affected
  (canonical formula reads payments, not caches); blast radius was
  this card's displayed per-row amount only. NOTE: the widget's
  TEST-account exclusion gap is separate and still open — see
  "AgingBuckets follow-ups" in OPEN-BUGS.

  119. Admin → Audit → Overdue Debug tab read total_due_amount
  cache (fixed 2026-05-22; commits 4b43961, 1e17317, a527827).
  OverdueDebugTab displayed s.total_due_amount per installment —
  same DISPLAY-RULE violation. Reworked into a drift monitor: a
  batched .in() fetch from schedule_with_actuals builds a
  {schedule_id → actual_remaining} map; each row shows canonical
  actual_remaining as the primary amount with the cache value +
  drift annotated beside it. Shared helpers (isEffectivelyPaid,
  getNextUnpaidDueDate, remainingDue) were left untouched and still
  receive raw rows — no business-rules change. Two refinements:
  installments are sorted by installment_number (1e17317 — the
  embedded array came back unordered), and the drift annotation is
  suppressed on paid rows (a527827), where total_due_amount =
  paid_amount and actual_remaining = 0 by design, so the gap is
  expected, not stale. The monitor now flags genuine cache drift
  only on non-paid rows.

120. reactivate-account stamped the Extension Month placeholder row
     (installment = plan + 1, base 0, due 0) with status 'overdue' at creation,
     a month before its due_date. On a zero-amount row this produced
     db_status='overdue' vs computed_status='paid', failing audit_account CHECK 7
     ("schedule status consistent with allocations"). Fixed three ways:
     (a) reactivate-account now inserts the row as 'pending';
     (b) audit_account CHECK 7 branch B exempts zero-base/zero-due rows beyond
         plan length (installment_number > payment_plan_months) — a zero-amount
         row is vacuously "fully covered" and was false-positiving;
     (c) existing placeholder rows backfilled 'overdue' -> 'pending' via SQL.
     The Extension Month row itself is intentional (Bug #106) and was NOT removed.
     Affected: INV 17059 (live) + test fixtures CJ-2026-FORFEIT-P2, CJ-2026-PATH1-TEST.

121. audit_delete_cleanup_invariants() emitted two perpetual info-level
     "preventive_no_delete_fn" findings (cash_orders -> cash_payments and
     cash_orders -> generated_invoices), flagging NO ACTION FKs that would block a
     DELETE on cash_orders with no cleanup function. But cash_orders is soft-cancel
     only — auto-expire-cash-orders soft-cancels, and delete-customer blocks customer
     deletion when cash_orders exist (it does not hard-delete them), so no hard-delete
     path exists. Fix: added both pairs to the audit's allowlist (delete_function
     '(none - soft-cancel only)', defensive=false, pre_check_protected=false) so the
     audit stops flagging a delete path that does not exist. SQL Editor RPC change
     (CREATE OR REPLACE); inline comment dated 2026-05-22 in the function body; no
     edge-function or src/ change. System Audit now reports "No schema drift detected".

121. customer-portal computed remaining_balance as (total_amount − total_paid), crediting already-paid penalty payments against principal and re-adding only unpaid penalties (and double-counting services via + totalServices, since services are already in total_amount). This understated every account with paid penalties by the paid-penalty amount — e.g. INV 17636 showed Current Total Payable ₱26,271.70 vs the canonical ₱28,271.70. Fixed: remaining_balance / current_total_payable now use canonical total_amount + sum(non-waived penalties) − total_paid; progress uses the all-in obligation; added a total_obligation field. Frontend (CustomerPortal.tsx): collapsed the Remaining Balance / Outstanding Penalties / Current Total Payable trio into one "Balance Due" with an "includes ₱X in late penalties" caption, relabeled the card stat to "Balance Due", and switched the card Total to total_obligation. Portal-home "Outstanding" rollup auto-corrects via the same field. (Bug #121, 2026-05-22)

122. dashboard-summary bucketed accounts differently from CSR Monitoring: overdue counted any account 1+ days past due (grace-blind, no grace bucket) and due-3/due-7 used cumulative ranges (<= +3 / <= +7), while Monitoring's canonical classifyAccountBucket uses grace = 1-6 days, overdue = 7+ days, and exact day-marks. So Dashboard and Monitoring showed different numbers for the same metric (e.g. Due in 7 = 79 vs 21; overdue off by the grace-period accounts). Fixed: dashboard-summary now mirrors classifyAccountBucket exactly and exposes grace_accounts, so the consolidated Dashboard cards match Monitoring and deep-link to the same accounts. Grace ends at day 6 because the first penalty fires at due+7 (penalty-engine week1Offset=7). (Bug #122, 2026-05-22)

123. PenaltyFollowUpSection (CSR Alerts → Penalty Follow-Up Stages) hid the per-row Notify button once a row was notified ({!isNotified && <Notify>}), leaving only a small status dot — staff couldn't tell at a glance a row was already notified, and a staffer coming back online had to check per profile. Fixed: the action column now always renders a control — a persistent, non-clickable "Notified" badge when notified (matching the Alert List's NotifiedButton), and the "Notify" button when not. State is keyed per (schedule_id, stage), so it stays "Notified" within a stage and resets to "Notify" when the account crosses to the next stage (e.g. P1→P2). Now consistent with the pre-penalty checkpoints (Due 7 / Due 3 / Due Today / Grace). (Bug #123, 2026-05-22; numbering note: an earlier #121 collision exists in this file — two #121 entries — so this entry takes #123, the next free number after #122.)

124. CSR Monitoring → CSR Alerts included TEST accounts in its summary-card counts and alert list — the monitoring-schedules query (schedule_with_actuals → layaway_accounts!inner) had no TEST-% exclusion, while dashboard-summary excludes TEST-% on every query. So CSR Alerts Overdue/Grace counts ran higher than the Dashboard by the TEST benchmark accounts (TEST-002/003 are overdue as of today). Fixed: added .not('layaway_accounts.invoice_number', 'like', 'TEST-%') to both halves (overdue + upcoming) of the query, matching the Dashboard's exclusion. CSR Alerts cards now equal the Dashboard in ALL mode. (Reaffirms the rule: TEST accounts are excluded from all operational/financial surfaces — testing only.) (Bug #124, 2026-05-22)

125. PenaltyFollowUpSection (CSR Alerts → Penalty Follow-Up Stages) showed test accounts — its penaltyAlerts query (layaway_schedule → layaway_accounts!inner) had no test filter, so TEST-002/003/004 and CJ-2026-FORFEIT-PATH3-NEW appeared in the penalty stages. Adopted the canonical test-account rule: real accounts have numeric invoices; the only non-numeric invoices in the table are the 11 test/scaffolding accounts (TEST- and CJ-2026- families). Added .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$') to keep numeric-only. This rule supersedes the partial TEST-% filters elsewhere (dashboard-summary, CSR Alerts monitoring-schedules from #124, get_forecast_*/get_top_outstanding_customers) which miss the CJ- family, and applies where no filter exists at all (Smart Reminders queries, fc_* and get_collection_analytics/get_monthly_sales RPCs) — to be swept to this same rule. (Bug #125, 2026-05-22)

126. CSR Alerts monitoring-schedules used the partial TEST-% filter from #124, which missed the CJ-2026-* test family (CJ-2026-FORFEIT-PATH3-NEW is final_settlement and was still leaking into the cards/alert list). Replaced both occurrences with the canonical numeric-only rule .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$'). CSR Alerts now excludes all test accounts. (Bug #126, 2026-05-22)

127. dashboard-summary used the partial TEST-% filter across ~15 query sites, missing the CJ-2026-* test family — so CJ-2026-FORFEIT-PATH3-NEW (final_settlement, ¥806,000) leaked into the Dashboard counts and money roll-ups. Replaced every occurrence with the canonical numeric-only rule .filter(<col>, "match", "^[0-9]+$"). Dashboard now excludes all test accounts and matches CSR Alerts. (Bug #127, 2026-05-22)

128. send-reminders processed TEST accounts — its schedule query (layaway_schedule → layaway_accounts!inner, status active/overdue) had no test filter, so TEST-002/003/004 were included in the reminder run: reminder_logs rows were created for them and reminders could be sent to TEST customers. Added .filter("layaway_accounts.invoice_number", "match", "^[0-9]+$") (canonical numeric-only rule) so the cron skips all test accounts. Pre-existing TEST reminder_logs rows remain as history; the Smart Reminders display query will filter those separately. (Bug #128, 2026-05-22)

129. Smart Reminders (CSR Monitoring) included TEST accounts and capped the Sent total. (1) actionableItems gained the numeric-only test filter, so the count cards + Action Items are test-free. (2) reminderLogs switched its layaway_accounts join to !inner with the numeric filter, dropping historical TEST logs from History. (3) "Sent (total)" replaced the capped reminderLogs.filter(sent).length (only the last 100 logs) with a dedicated count('exact', head) query, numeric-only — a true total with no 100 cap. Card bucketing/labels left unchanged pending a separate keep-vs-canonical label decision. (Bug #129, 2026-05-22)

130. Extensions and the Audit-tab panels used incomplete or absent test filters. ExtensionRequestsPanel had none (test extension requests leaked); PenaltyCapAuditPanel, PenaltyAuditTab, OverdueDebugTab, and WaiverAuditTab used the partial .not(...'ilike','TEST-%') which misses the CJ-2026-* family (CJ- test penalties/accounts/waiver logs leaked into the audit views). Completed all five to the canonical numeric-only rule .filter(<col>,'match','^[0-9]+$'). These panels already intended to exclude test (they had TEST-% filters); this just closes the CJ- gap and adds the missing one on Extensions. (Bug #130, 2026-05-22)

131. SQL analytics/forecast RPCs excluded test accounts inconsistently or not at all. The 18 reporting RPCs — 13 fc_* Executive functions (fc_portfolio_value, fc_gross_profit, fc_monthly_inflow, fc_net_exposure_risk, fc_at_risk_accounts, fc_at_risk_detail, fc_penalty_revenue, fc_penalty_driven_accounts, fc_plan_performance, fc_cohort_timeline, fc_coverage_ratio, fc_cfo_insights, fc_evaluate_alerts), plus Finance get_collection_analytics and get_monthly_sales, plus get_forecast_6m, get_forecast_drilldown, get_top_outstanding_customers — either had no test filter (all fc_*, get_collection_analytics, get_monthly_sales) or the partial TEST-%/TEST% filter that misses the CJ-2026-* family (the three forecast/customer fns). Test money (including the ¥806k CJ-2026-FORFEIT-PATH3-NEW) leaked into portfolio value, net exposure, gross profit, at-risk, cohort, plan performance, coverage, collection analytics, monthly sales, forecast, and top-customer figures, and into financial_alerts evaluation. Applied the canonical numeric-only rule invoice_number ~ '^[0-9]+$' to every contributing scan in each, via CREATE OR REPLACE in the SQL Editor (fc_cfo_insights and fc_evaluate_alerts patched in-place via pg_get_functiondef + replace to avoid transcription risk on large PL/pgSQL bodies). Helper CTEs that only feed risk classification via account_id LEFT JOIN were left unfiltered, since the central layaway_accounts scan is filtered. This completes the system-wide test-exclusion sweep begun in #124–130: all operational and financial surfaces, frontend and SQL, now exclude test accounts by the numeric-only rule. NOTE: two pre-existing correctness bugs were intentionally left untouched in this sweep and remain OPEN — get_monthly_sales sums la.total_amount with no PHP→JPY conversion in ALL mode, and get_collection_analytics sums the write-only total_due_amount cache for "expected". (Bug #131, 2026-05-22)

132. get_monthly_sales summed la.total_amount with no PHP→JPY conversion in ALL mode (the first open correctness bug noted in #131), so the Finance "New Layaway Sales" KPI and consolidated sales figures mixed ₱ and ¥ raw. Fixed in the SQL Editor: total_sales_value now uses a per-row CASE that divides PHP by php_jpy_rate in ALL mode (mirroring get_collection_analytics.collected); single-currency modes unchanged; the #131 numeric test filter and the first-payment DISTINCT ON logic preserved. Verified ALL = JPY + PHP/rate per month across all 13 months. Also (frontend): fixed the Finance Overview KPI grid — 8 StatCards in lg:grid-cols-6 left a 4-column dead space and the gold-variant gradient-clip values (.gold-text) overflowed and rendered the overflow transparent ("cut off") at 1/6 width; changed to lg:grid-cols-4 (balanced 2×4, wider cards) and the loading skeleton to 8. Added a Collections vs Sales line chart (6 months, currency-aware) to the Finance Analytics tab, plotting collected vs total_sales_value. (Bug #132, 2026-05-22)

133. Finance dashboard test-account leak (2026-05-23)
Two independent leaks of the 11 test accounts (TEST-001..005, CJ-2026-FORFEIT-*):
(1) Client-side: useAccounts() has no test filter, so every Finance.tsx metric
    off the `accounts` array included them — inflated "Forfeited Collected",
    inflated "Active Accounts", test rows in CLV / Completion Prediction (e.g.
    "Test Path3 Customer · CJ-2026-FORFEIT-PATH3-NEW"). Fixed by filtering
    rawAccounts -> accounts to ^[0-9]+$ at Finance.tsx line 66.
(2) SQL: get_monthly_analytics used the incomplete NOT LIKE 'TEST-%' filter in
    all 3 CTEs (missed the CJ- family), inflating Monthly Performance
    "Total Forfeited". Swapped to ~ '^[0-9]+$'. This RPC was missed by the
    #131 18-RPC sweep.
(3) SQL: get_aging_buckets used the same incomplete NOT LIKE 'TEST-%' filter,
    leaking the final_settlement test account (CJ-2026-FORFEIT-PATH3-NEW) into
    the Overview "Aging Buckets" Current count/amount. Swapped to ~ '^[0-9]+$'.
    Catalog audit (pg_get_functiondef ~* '(like|~~)\s+''TEST') then returned zero
    functions — SQL reporting side fully test-clean (20 functions).

134. Finance Analytics — Collected vs Expected + Forfeited Collected cleanup (2026-05-23)
(1) get_collection_analytics emitted fractional yen (PHP/rate, no ROUND), showing as a
    long decimal in the Collected vs Expected tooltip. Fixed in SQL Editor: collected /
    expected / penalties_collected now ROUND by currency scale (0 dp for ALL/JPY, 2 for PHP).
(2) The Collected vs Expected tooltip had no formatter (bare numbers, no currency). Added
    formatCurrency(displayCurrency).
(3) totalForfeitedCollected ("Forfeited Collected" card) ignored the currency toggle — in
    PHP/JPY mode it summed every forfeited account's raw total_paid, mixing currencies. Now
    filters isAllMode || a.currency === currencyFilter (deps include currencyFilter).
    final_settlement intentionally excluded (treated as collectible, not forfeited).

135. Top 10 Outstanding Customers re-ranked (2026-05-23)
get_top_outstanding_customers ordered by score DESC, but customers with no
allocated payments get a NULL score (early-rate term divides by NULL), and
Postgres sorts NULLs first under DESC — so 0%-early customers floated to #1-2.
Changed ORDER BY to early_payment_rate DESC NULLS LAST, account_count DESC
(early-payment % primary, account-count tiebreak). Applied in SQL Editor.

136. CSR/Staff Performance included all profiles (2026-05-23)
profilesWithRoles resolved role as `?.role || 'staff'`, defaulting the ~80
roleless profiles (customers) to 'staff', so the list showed all 86. Fixed in
Finance.tsx: dropped the 'staff' default and filtered to profiles with an
assigned user_roles role (6 internal now; finance/csr auto-included later).

137. Collection rate redefined to a true, capped efficiency (2026-05-23)
get_collection_analytics rate was collected (all cash received that month) / expected,
which exceeded 100% (avg ~160%, peak 233%) because monthly cash includes advance/
catch-up payments. Step 1 (swapping the total_due_amount cache for scheduled
base+penalty) confirmed the inflation was structural, not the cache. Now: added
collected_due (amount allocated to each due-month's installments, from
schedule_with_actuals) and set collection_rate = collected_due / expected, capped
<=100% by construction. `collected` (cash by payment date) retained for the
Collections vs Sales chart; "Collected vs Expected" chart repointed to collected_due.

138. Collections tab counted test-account payments (2026-05-23)
The Finance Collections tab payment cards (Today/Yesterday/Week/Month/Year) and the Payment Feed read from collFiltered, which filtered only by voided_at and currency — so payments belonging to test/scaffolding accounts (TEST-*, CJ-2026-*) still counted in the totals and the feed. Fixed in Finance.tsx: collFiltered gained .filter(p => accountMap.has(p.account_id)) with accountMap added to its dependency array. Since accountMap is built from the numeric-filtered `accounts` array (/^[0-9]+$/.test(invoice_number)), test-account payments are now excluded from the cards and feed. Shipped 5f96cf5.

139. Finance chart terminology standardized (2026-05-23)
"Collected" meant two different things across the dashboard — cash received (Overview bar/stat and the Analytics "Collections vs Sales" line) versus the of-due, capped figure (the Analytics "Collected vs Expected" line) — and the penalty/forfeited labels were inconsistent between tabs. Relabeled (display only, no calc or dataKey changes): "Collections vs Sales" → "Collected vs Sales" (line "Collections" → "Collected"); "Collected vs Expected" → "Paid vs Due" (lines "Collected"/"Expected" → "Paid"/"Due"); Overview "Penalties Paid" → "Penalties Collected" (to match Analytics); Analytics "Forfeited Collected" → "Recovered (Forfeited)" to distinguish recovered cash from the Overview "Total Forfeited" loss figure. Shipped eeb80f3. Convention recorded in CLAUDE.md "## CHART TERMINOLOGY" (88f85f8): "Collected" always means cash received; the schedule-efficiency metric is "Paid vs Due".

140. Dashboard "Overdue & Due Soon" widget (OverdueAlerts.tsx) included TEST accounts — its schedule_with_actuals → layaway_accounts!inner query had no test filter, so overdue benchmark accounts (TEST-002/003) could surface in the widget. Added the canonical numeric-only rule .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$') on the embedded join (server-side, no URL-length risk). Completes the test-exclusion sweep on the one Dashboard widget the #124–131 pass missed because it queries directly rather than via dashboard-summary. (Bug #140, 2026-05-23)

141. Settings -> Team listed all 86 profiles including customers and Unknown-role accounts. SettingsPage.tsx fetchMembers defaulted roleless profiles to 'unknown' (role: roleMap[p.user_id] || 'unknown'), so the Team Members list showed every profile — customers and duplicate personal emails — not the internal team. Same root cause as #136 (CSR Performance, ed9a08b). Dropped the 'unknown' default and filtered to profiles with a real user_roles entry; Team Members now shows only the roled internal team (Admin/Staff/Finance/CSR). Add Member -> create-team-member always assigns a role, so the filter never hides a legitimate teammate. Fixed 2026-05-23. (Bug #141, 2026-05-23)

142. Dashboard collections/today figures included test accounts. The two payment sums feeding collections_this_month and payments_today (todayPayQ/monthPayQ in dashboard-summary) had NO test filter — they queried payments without an account join. Added the account join + canonical numeric filter (select('*, layaway_accounts!inner(invoice_number)') plus filter('layaway_accounts.invoice_number','match','^[0-9]+$')) to both. The other dashboard-summary exclusions were already on the canonical numeric regex from an earlier session — not part of this fix. Pointed the Finance Collections-tab 'This Month' card at server summary.collections_this_month so it matches the Overview card. Also verified get_collection_analytics already uses the canonical (allocated + actual_remaining) source with numeric test-exclusion — no change needed (no-op). Residual follow-up: Collections-tab Today/Yesterday/Week/Year cells still client-computed over all payments (test-inclusive). Code shipped b9319f7; dashboard-summary redeployed via Lovable IDE 2026-05-23. (Bug #142, 2026-05-23)
