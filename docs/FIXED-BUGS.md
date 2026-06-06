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

  FRONTEND FOLLOW-UP (2026-05-26): #117 was originally closed on the edge side only. Two frontend writers replicated the same carry-drop by recomputing total_due_amount = base + penalty with no carried term, via direct .update() that bypasses the fixed edge functions: src/pages/Waivers.tsx (unwaive handler, Step 2) and src/components/penalties/ApplyPenaltyCapDialog.tsx (cap-waive loop). Both fixed to base + penalty + carried (and ApplyPenaltyCapDialog's schedItems select extended to include carried_amount). #117 now closed across edge AND frontend.

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

142. Dashboard collections/today figures included test accounts. The two payment sums feeding collections_this_month and payments_today (todayPayQ/monthPayQ in dashboard-summary) had NO test filter — they queried payments without an account join. Added the account join + canonical numeric filter (select('*, layaway_accounts!inner(invoice_number)') plus filter('layaway_accounts.invoice_number','match','^[0-9]+$')) to both. The other dashboard-summary exclusions were already on the canonical numeric regex from an earlier session — not part of this fix. Pointed the Finance Collections-tab 'This Month' card at server summary.collections_this_month so it matches the Overview card. Also verified get_collection_analytics already uses the canonical (allocated + actual_remaining) source with numeric test-exclusion — no change needed (no-op). Residual follow-up RESOLVED 2026-05-24 (no-op, verified): those four cells already test-exclude — collFiltered filters payments through accountMap (#138), and useAccounts is fully paginated and unfiltered by status, so the account set is complete and the cells match the server "This Month". No fix needed. Code shipped b9319f7; dashboard-summary redeployed via Lovable IDE 2026-05-23. (Bug #142, 2026-05-23)

143. Monitoring -> Extension Requests "Account" column showed the invoice number, not the customer name. In ExtensionRequestsPanel (Monitoring.tsx) the value was const customerName = acct?.invoice_number and the panel query didn't fetch the name, so the "Account" column duplicated the adjacent "Invoice" column. Added customers(full_name) to the extension_requests -> layaway_accounts join, set customerName = acct?.customers?.full_name, and relabeled the header "Account" -> "Customer" (the invoice has its own column). Fixed 2026-05-24. (Bug #143, 2026-05-24)

144. Monitoring -> Penalty Follow-Up stage tooltips showed a cross-currency penalty sum with a hardcoded peso sign. In PenaltyFollowUpSection.tsx the StageBucket total was built as totalPenalties += alert.penaltyAmount across every alert in a stage regardless of currency, then rendered as "₱{totalPenalties}" — so a stage holding both PHP and JPY overdue accounts summed yen and pesos into one meaningless number stamped with ₱. Split the bucket total into totalPenaltiesPHP / totalPenaltiesJPY (accumulated by alert.currency) and rendered the tooltip with formatCurrency for whichever currencies are present (e.g. "₱X  +  ¥Y"), matching the native per-row display below. Frontend only. Fixed 2026-05-24. (Bug #144, 2026-05-24)

145. Finance -> Collections "Upcoming Receivables" now anchors to the current date with a cumulative oldest card, and its drilldown matches. Previously the oldest (previous-month) card only showed the single month now-1, and get_forecast_6m only fetched from now-1 onward — so when a month rolled off the front (April once June arrives) its still-unpaid receivables vanished from the cards instead of carrying forward. Changes: (a) SQL get_forecast_6m lower bound removed so all still-unpaid months on active-ish accounts are fetched; (b) frontend forecastCards collapses every bucket dated on/before last month into one cumulative oldest card (label = last month, status "Overdue · incl. earlier" when older months are folded in), keeping current -> +5 as individual cards (max 7, or 6 when nothing is aged); (c) SQL get_forecast_drilldown accepts an AGED:YYYY-MM sentinel that drops the month lower bound so the oldest card's drilldown lists all aged accounts <= that month, matching the card total — plain YYYY-MM keys behave exactly as before. No 0.85 involved (Upcoming Receivables has none). Frontend + two SQL RPCs (SQL Editor). 2026-05-24. (Bug #145, 2026-05-24)

146. Finance forecast displays no longer apply the stray 0.85 "risk" haircut. dashboard-summary's riskFactor (0.85) was discounting the Predicted (30d/90d) cards, the Expected Next Month card, and the 6-Month Cashflow Forecast chart's gold "adjusted" bars — a factor unrelated to gross profit (a self-contained 15% in fc_gross_profit) with no legitimate purpose on these forecast displays. Repointed everything to the undiscounted values dashboard-summary already emits: Expected Next Month -> next_month_expected; Predicted (30d/90d) cards in both Finance clusters -> predicted_30d_raw / predicted_90d_raw, relabeled "Expected (30d/90d)"; the 6-Month Cashflow chart dropped its gold adjusted bar, the "Adj:" figure, and the "Risk-Adjusted (85%)" legend, leaving the expected (due) bar. Now-redundant "of X due" subtitles removed. Frontend-only; the dead riskFactor stays unused in dashboard-summary (optional future tidy-up). 2026-05-24. (Bug #146, 2026-05-24)

147. Realtime dashboards were never live cross-user — the supabase_realtime publication was empty, so the existing exec-alerts (financial_alerts) channel was a silent no-op. Populated the publication with the 7 core mutating tables + financial_alerts, and added a single global useRealtimeSync hook mounted once at the App root, gated on the internal-user predicate (admin/staff/finance/csr) so the customer portal never subscribes. Added collections-forecast-6m, forecast-drilldown, operations-action-items, penalty-cap-audit to PAYMENT_KEYS to close coverage gaps. (Bug #147, 2026-05-24)

148. Settings → Team now supports deactivating/reactivating members. create-team-member gained action:'deactivate'|'reactivate' (admin/manage_team gated, self-deactivation blocked): deactivate sets profiles.status='inactive' and bans the auth login (ban_duration), reactivate restores status='active' and unbans. The user_roles row is intentionally kept so the member stays listed and all historical attribution (created_by_user_id, audit logs, etc.) is preserved. Added Deactivate/Reactivate buttons with a confirm dialog in the Team table Actions column. (Bug #148, 2026-05-24)

149. Settings → Roles & Permissions "Quick Comparison" table was a hardcoded role×capability grid that could drift from actual permissions. Replaced it with a live read-only matrix driven by usePermissions().allPermissions, reusing the Permission Matrix's exported PERMISSION_MODULES + ROLES catalog, so the Roles tab and Permission Matrix always agree. Prose role-description accordion kept as static plain-language summary. (Bug #149, 2026-05-24)

150. Settings → Permission Matrix "By Member" picker listed customers (profiles with no user_roles entry) mislabeled as 'staff', because the members query selected all profiles and defaulted missing roles to 'staff' with no filter. Restricted it to actual team members via .filter(p => p.role), dropping the || 'staff' default — matching the Team tab's fetchMembers logic. (Bug #150, 2026-05-24)

151. Customers were getting profiles rows (and leaking into team-member lists) because the on_auth_user_created → handle_new_user trigger inserted a profile for EVERY auth signup — which began including customers once Phase B gave them auth accounts. Fixed at the source: create-team-member now stamps user_metadata.is_team_member=true, and handle_new_user only inserts a profile when that flag is present, so self-signup customers never get one. (Bug #151, 2026-05-24)

152. Cleaned up 80 leftover role-less profiles (customer portal self-signups that the old unconditional handle_new_user trigger had created before #151 gated it). Deleted all profiles with no user_roles entry; profiles is now strictly team-members-only. FK-safe (nothing references profiles) and customer portal access is unaffected (customers authenticate via auth.users + customers, not profiles). (Bug #152, 2026-05-24)

153. customer-statement feature fully deleted (2026-05-25)
The customer statement feature was confirmed unused and was fully removed from the
codebase. Deleted files: src/pages/CustomerStatement.tsx (527 lines),
supabase/functions/customer-statement/ (entire 176-line function). Modified files:
src/App.tsx (removed lazy import + /statement route), src/pages/CustomerPortal.tsx
(removed statement_token field, statementUrl calc, View Full Statement block),
supabase/functions/customer-portal/index.ts (removed statement_tokens query from
Promise.all), src/integrations/supabase/types.ts (removed statement_tokens table
type), supabase/functions/system-health-v2/index.ts (removed statement_token from
select, deleted Check 9, replaced with historical comment). DB ops: delete_account_atomic
RPC updated (removed statement_tokens DELETE line), audit_delete_cleanup_invariants
RPC updated (removed statement_tokens from allowlist). statement_tokens table was
already absent from production DB. Edge functions (customer-portal, system-health-v2)
redeployed via Lovable IDE. Commit 7f38d37 shipped to main and auto-deployed to Firebase.
(Bug #153, 2026-05-25)

154. send-transactional-email auto-deploy confirmed working (2026-05-25)
Bug #103 (send-transactional-email redeploy needed after _shared/transactional-email-templates/
edits) was investigated and resolved by design — the GitHub Actions workflow
(supabase-functions-deploy.yml L205) already contains a check for _shared/ changes and
triggers send-transactional-email redeploy automatically on template edits. No action
needed; the infrastructure was correct from initial setup. Verification confirmed that
send-transactional-email IS in the auto-deploy list (L30, L204–206) and the workflow
correctly detects _shared/ mutations. (Bug #103, 2026-05-25)

155. RLS file 6 (Phase B RLS policies) already deployed (2026-05-25)
RLS file 6 was marked deferred in PENDING.md pending merge, but investigation revealed
the 6 RLS policies were already created and deployed via migrations 20260504000005
(customer_rls_policies.sql) and 20260504000006 (customer_rls_policies_remainder.sql),
both on main and live in production. The policies are: customers (SELECT/INSERT/UPDATE by staff),
user_roles (SELECT by user, full access by admin), profiles (SELECT by staff, UPDATE by user),
layaway_accounts (SELECT/INSERT/UPDATE by staff), layaway_schedule (SELECT/INSERT/UPDATE by staff),
payments (SELECT by staff). No action needed; deferred note was stale. (RLS file 6, 2026-05-25)

156. Loyalty tier_changed downgrade transaction insert (2026-05-25)
The downgrade paths in loyalty-inactivity-check (expiry-triggered and gap-triggered)
were emitting notifications and sending emails but NOT inserting tier_changed transactions
to loyalty_transactions, leaving the member ledger incomplete. The upgrade path
(award-loyalty-points) was correctly inserting tier_changed on tier upgrade (L670–705),
creating an inconsistency. Fixed by adding identical tier_changed transaction inserts
to both downgrade paths: (1) expiry path after emitNotification for tier (L364–383),
inserting tier_changed with notes "due to 6+ months inactivity"; (2) gap path after
emitNotification for tier (L477–496), inserting tier_changed with notes "due to
{gapBetweenLastTwo}-day purchase gap". Both inserts are non-blocking (log warning,
don't throw). Structure matches upgrade path (points_amount=0, tier_at_time=newTier,
null foreign IDs, created_by_user_id=null). Deployed 2026-05-25 commit 0272587 via
Lovable IDE. (Bug #156, 2026-05-25)

157. Loyalty portal Sign Out button was wired to setTab('home') instead of signing out — now calls supabase.auth.signOut() (session) / clears token + navigates /portal/login (both modes). Fixed 2026-05-26.

#158 — Frontend deploys stalled: oven-sh/setup-bun action undownloadable (2026-05-26)
  Symptom: "Deploy to Firebase Hosting" runs failed at the setup-bun step in ~9s
  ("An action could not be found at the URI .../oven-sh/setup-bun/tar.gz/<sha>", E440),
  so frontend changes (incl. the birthday Save button) never went live. actions/checkout@v5
  and actions/setup-node@v5 downloaded fine; only oven-sh/setup-bun (both @v2 and @v1) 404'd
  from codeload — a GitHub-side outage of that action's archive, not a version problem.
  Fix: removed the oven-sh/setup-bun step from firebase-deploy.yml and switched install+build
  to npm (npm install / npm run build) on the already-present setup-node@v5 (Node 22) — no
  third-party action dependency for the build. Commit e0520bf.

#159 — Record Payment dialog showed a stale preview after switching payment mode (2026-05-28)
  After toggling Installment <-> Downpayment, the previously computed preview was not cleared,
  so a downpayment could display an installment month breakdown (e.g. months 4/5/6) calculated
  in the prior mode. Fixed by clearing the preview and returning to the input step on mode
  toggle, so the breakdown always matches the selected mode. No data impact — payments saved
  with correct is_downpayment and zero installment allocations. Commit 390f7e7.

### Bug #160 — edit-payment-amount missing DP guard caused #19105 misallocation (2026-06-04)

**Symptom**: Two DP payments on layaway account #19105 (Kaila Daniela Catilo) had `payment_allocations` rows created against schedule rows M1 and M2. Payment 68819874 (₱40,000) split 33,670 → M1 + 6,330 → M2. Payment 7c37314f (₱15,000) split 5,333 → M1 + 9,667 → M2. Account audit failed on remaining-balance drift; M1 was wrongly marked 'paid', M2 wrongly 'partially_paid'.

**Root cause**: `supabase/functions/edit-payment-amount/index.ts` Phase 3 ran an unguarded waterfall to recreate `payment_allocations` from scratch on every amount edit, with no DP detection at runtime. The only DP reference in the function was a comment at L98 (which was about loyalty no-op, not allocation control). When staff manually edited the two rakuten DP payment amounts via the Payment History UI — believing them mismatched because of a separate "View Proof shows one image for every payment" preview bug — the function went through Phase 1 (reversed nothing, no existing allocations), Phase 2 (updated amount), and then Phase 3 ran the waterfall blindly, allocating the full DP amounts into M1 and M2 as installment payments.

**Why review-payment-submission was ruled out**: Git blame on `supabase/functions/review-payment-submission/index.ts` L775-790 confirms the DP gate at L778 was added by commit `8bbb93eb` on 2026-03-26, finalized by commit `70c91c45` on 2026-03-30 — over two months before the 2026-06-03 misallocations. The DP-skip inside `allocatePaymentToAccount` correctly produces empty `allocations` / `scheduleUpdates` / `penaltyUpdates` arrays when `isDownpayment=true`, so no installment inserts can be produced by this function for any DP payment.

**Why reconcile-account was ruled out**: File header explicitly states *"Reconcile a single layaway account — REPORT ONLY (no DB writes)."* The function reads, computes canonical values, returns a drift report. It does not write to `payment_allocations` at all.

**Why record-payment / record-multi-payment were ruled out**: Both have DP guards via the `is_downpayment` boolean flag (record-payment L243; record-multi-payment L184). The misallocated payments' remarks format (`"Payment submitted: Downpayment. Submission #..."`) matches review-payment-submission, not record-payment, confirming neither function processed these payments.

**Fix**: Added two-condition DP gate at the top of Phase 3 in `edit-payment-amount/index.ts` (ref_number startsWith 'DP-' OR remarks regex match for `\bdown(payment)?\b|\bdp\b`). Wrapped the entire Phase 3 body in `if (!isDP) { ... }`. Phase 1 (allocation reversal), Phase 2 (amount update), and Phase 4 (canonical totals recompute via INVARIANT 1) continue to run for all payment types. This gives a self-heal property: re-editing a previously misallocated DP payment will now reverse the bad allocations (Phase 1) and skip the re-allocation (Phase 3 wrapped), with totals corrected in Phase 4.

**Heuristic notes**: DP detection at the `payments` table layer omits the `submission_type` check used at L778 of review-payment-submission because per CLAUDE.md schema notes, the `payments` table has no `payment_type` or `is_downpayment` columns — DP is identified solely by reference_number prefix or remarks regex. All 7 of #19105's DP payments satisfy both conditions of this gate (verified empirically against payment_submissions data prior to the fix).

**Not the cause**:
- review-payment-submission (DP gate live since 2026-03-30 per git blame)
- reconcile-account (REPORT-ONLY)
- record-payment / record-multi-payment (DP guards present, did not process these payments)
- fix-account-totals (has remarks-based DP guard at L196-198 that catches "downpayment" substring; would have skipped these payments)
- bulk-import (DP-aware, handles downpayment as separate field)
- restore-payment (has `isDownpaymentPayment()` helper at L36-40)
- penalty-engine (only writes `'penalty'` allocations, never `'installment'`)

### Feature — Restore action for rejected payment submissions (2026-06-04)

**What changed**: Added the ability to restore a rejected payment submission back to the review queue. Previously, once a submission was rejected (status='rejected') there was no in-app path to recover it — accidentally rejected submissions required manual SQL intervention. Now a Restore button appears on rejected rows for users with `reject_submission` permission, returning the submission to `status='submitted'` for fresh validation.

**Frontend** (`src/pages/PaymentSubmissions.tsx`):
- `RotateCcw` icon added to lucide-react imports.
- ActionDialog extended with a `'restore'` action variant: title `'🔄 Restore Submission'`, non-destructive button styling, optional restore reason input.
- New Restore button rendered on rows where `sub.status === 'rejected' && canReject`, placed between the existing pending-status badge and the Account/Cash Order link.

**Backend** (`supabase/functions/review-payment-submission/index.ts`):
- `'restore'` added to `validActions` array.
- `restore: "reject_submission"` added to `permissionByAction` map (same permission as making the rejection — restoration is the inverse trust action).
- New RESTORE PATH early-return branch placed right after submission and allocs are fetched, BEFORE both the cash-order and layaway branches. Validates `submission.status === 'rejected'` (returns 400 otherwise), flips status to `'submitted'`, preserves `reviewer_user_id` and `reviewer_notes` on the row as rejection history.
- Audit trail: writes an `audit_logs` entry with `entity_type='payment_submission'`, `action='restored_from_rejected'`, the prior status/reviewer/notes in `old_value_json`, and the new status + restorer's optional reason in `new_value_json`. `performed_by_user_id` is the restorer.

**Status flow**: `rejected` → (Restore button) → `submitted` → re-enters standard review (under_review / confirmed / rejected / needs_clarification).

**Works for**: both layaway submissions (account_id IS NOT NULL) and cash-order submissions (cash_order_id IS NOT NULL). The restore handler short-circuits both branches with a single early-return.

**Does not change**: payment_allocations, payments, schedule rows, penalty_fees, account totals, or cash_orders. Restore only flips the submission status. Customer-facing emails do NOT fire on restore (intentional — restoration is an internal recovery action).

**Permissions**: `reject_submission` controls both rejection AND restore. If finer-grained control is needed later, split into a new `restore_submission` permission key without backend changes (just adjust `permissionByAction`).

### Bug #161 — View Proof in Payment History collapsed same-day payments to one proof (2026-06-04)

**Symptom**: In Payment History on `AccountDetail.tsx`, the inline "📎 View Proof · {sender}" link displayed the same proof image for every payment that shared a `payment_date` with another payment on the account. Affected ALL accounts with multiple payments recorded on the same calendar day — multi-tranche DP submissions (e.g. #19105: 5 DP payments on 2026-06-02 all showing the first one's proof, 2 DP payments on 2026-06-03 sharing another), same-day installment-plus-penalty payments, bulk catch-up payments, or any other case where two confirmed payments shared a date. The standalone `/payments-hub` Submissions & Proofs view in finance was unaffected because it reads `proof_url` directly off each `payment_submissions` row without any joining or deduplication.

**Root cause**: The `proofByDate` lookup in `src/pages/AccountDetail.tsx` keyed the proof map by `s.payment_date` with a first-write-wins guard (`!map.has(s.payment_date)`). The render then looked up by `p.date_paid`. The `payment_date` field is not a 1:1 key — a customer can have multiple submissions with the same payment_date on the same account (especially common for multi-tranche DP submissions, where a single DP obligation is paid in segments on the same day or two adjacent days). When multiple submissions shared a date, all payments on that date displayed the same proof URL — whichever submission was first in the DESC-ordered result set.

**Discovery (operational chain)**: This bug was the *upstream operational trigger* for Bug #160 (edit-payment-amount DP guard). Staff viewing the Payment History for #19105 saw the same proof image associated with multiple DP payments and believed the payment amounts were mismatched. They manually edited the rakuten DP payment amounts via the Payment History UI to "align" the records with what the (wrong) inline preview suggested. That manual edit invoked `edit-payment-amount` on DP payments, which had no DP guard (Bug #160), which produced the M1+M2 misallocations on #19105. Fixing Bug #160 closed the misallocation class structurally; fixing this bug (#161) closes the operational mistake path upstream of it.

**Fix**: Rekey the proof lookup by `confirmed_payment_id` instead of `payment_date`:
1. Added `confirmed_payment_id` to the SELECT in the `submissionProofs` query.
2. Added `.not('confirmed_payment_id', 'is', null)` filter so rejected/submitted/under-review rows (which never produce a payment) don't pollute the lookup.
3. Renamed `proofByDate` → `proofByPaymentId`; map keyed by `s.confirmed_payment_id` with the same first-write-wins guard (now defensive, since the mapping is 1:1 by construction).
4. Render at L1884 looks up by `p.id` instead of `p.date_paid`.

**Why `confirmed_payment_id` is the right key**: per CLAUDE.md PAYMENT SUBMISSION FLOW, every confirmed submission produces exactly one payment (`review-payment-submission` writes `confirmed_payment_id` on the submission row when creating the payment via `allocatePaymentToAccount`). The relationship is 1:1 by construction — no date collisions, no first-write-wins behavior, no cross-payment proof leakage.

**Not changed**: The `/payments-hub` Submissions & Proofs page in finance is unaffected — it uses a different rendering path that reads `proof_url` directly off each submission row, not joined through payments. Database schema unchanged. Backend edge functions unchanged. No data fix needed (the proof URLs in `payment_submissions` rows are already correct; only the rendering join was wrong).

### Bug #162 — fill-payment-tracking reads wrong column for customer country (2026-06-04)

**Symptom**: The "Country" column (column T) on the Overseas tab of the payment tracker sheet was blank for many customers, even though their country was correctly entered via the Customers menu → pencil-edit Customer Details form. Affected ~13 invoices in the latest fill (e.g. Romelyn Fortuna 18998, June Fagerholt 18992, Christia Amparo-Gonzalez 19011, Hayden Hayden 19014, Shiella Flores Almazan 19038/19067, Eetu Rain 19050, Grace Salaug 19053, ELMA GOBLER 19076 — all of whom HAD their country populated in the customer record). Other customers' country populated correctly (e.g. Yolanda Bermudez Alegre 19093 Israel, Aileen Sia 19049 Philippines).

**Root cause**: `supabase/functions/fill-payment-tracking/index.ts` queried `customers.country` at L170 (layaway path) and L179 (cash-orders path) — but the active Customer Details edit form writes the country value to `customers.location`, not `customers.country`. The `country` column on the `customers` table exists but is not populated by any active UI path; it's effectively dormant. Customers whose `location` was set but `country` was NULL produced blank cells in column T because the edge function picked the wrong column.

The two columns are not consistently kept in sync — some legacy customer records have both columns populated (e.g. Yolanda has `country = 'Israel'` AND `location = 'Israel'`), while customers entered through the current UI only get `location` populated. The split source-of-truth meant the bug was invisible for the subset whose records happened to have both fields filled.

**Fix**: Change all four read sites in fill-payment-tracking to use `customers.location` instead of `customers.country`:
1. L170 SELECT — `customer:customers(country)` → `customer:customers(location)`
2. L175 map-set — `r.customer?.country` / `r.customer.country` → `r.customer?.location` / `r.customer.location`
3. L179 SELECT — same swap as L170
4. L184-185 map-set — same swap as L175

Variable name `countryByInvoice` retained (it represents the column-T VALUE, regardless of which DB column sources it). Comment at L166 updated to document the rationale and prevent re-introduction.

**No data fix needed**: The country values are already in `customers.location` for all affected customers. As soon as the fix deploys, the next payment-tracker fill will populate column T correctly from that column.

**Going-forward consideration**: The `customers.country` column exists but is not actively populated by any UI path. Either (a) backfill `customers.country` from `customers.location` and pick one canonical column going forward, or (b) drop `customers.country` if confirmed unused. Either decision is outside the scope of this fix and parked for a future schema-cleanup pass.

### Bug #163 — award-loyalty-points auth block silently rejected service-role calls, suppressing all DP loyalty awards for ~30 hours (2026-06-04)

**Symptom**: From 2026-06-03 04:03 UTC until the fix deployed (~30 hours), every DP confirmation in `review-payment-submission` silently failed to award loyalty points. The fire-and-forget fetch from review-payment-submission resolved successfully (HTTP-wise) but with a 401 status, which the `.catch()` did not see (`.catch()` on fetch only catches network errors, not non-2xx HTTP responses). No warning logged, no error surfaced.

Customers confirmed affected via diagnostic SQL:
- Sarah Arcibal-Ponting #19060 — DP ₱4,322 confirmed 2026-06-04 08:06:42 — expected ~700 pts (Glimmer 1× × floor(73,980/10,000) × 100)
- Suzette Tupaz #19108 — DP ₱31,194 confirmed 2026-06-04 08:08:53 — expected ~1,000 pts (Glimmer 1× × floor(103,980/10,000) × 100)

Additional DPs confirmed in the 2026-06-03 04:03 → 2026-06-04 (fix deploy) window are likely also affected. Catch-up via SQL backfill or manual award-loyalty-points POST per account, scheduled after the deploy lands.

**Root cause**: Commit `56ddae1` ("Changes", authored by gpt-engineer-app[bot] on 2026-06-03 04:03:11 UTC) added a 29-line authentication block to `supabase/functions/award-loyalty-points/index.ts`. The service-role JWT detection used `atob(token.split(".")[1])` to decode the JWT payload, but `atob` decodes standard base64 — JWT payloads are **base64URL**, which uses `-` and `_` instead of `+` and `/`. When the actual service role JWT's payload base64URL contains any `-` or `_` character (depends on the encoded bytes), `atob` throws `InvalidCharacterError`. The surrounding `try { ... } catch (_) { /* fall through to user check */ }` swallows the error silently → `authorized` stays false → control falls through to `supabase.auth.getUser(token)`, which fails because service-role tokens are not user tokens → returns 401.

**Why it slipped through**:
1. Commit message was the auto-generated "Changes" — no descriptive intent, no scoping.
2. Committed by `gpt-engineer-app[bot]` (Lovable session edit) without a corresponding bug entry, plan confirmation, or SOP investigation. The change bypassed the standard `investigate → analyze → user-confirm → implement → ship → itemized verify → docs update` cycle.
3. The downstream caller in `review-payment-submission` (around L795-805 — the DP fire-and-forget block) uses `.catch()` for fetch error handling, which only catches network-level errors, not non-2xx HTTP responses. So 401 responses leave no trace.
4. No deploy-time smoke test was performed after the auth-block deploy to verify award-loyalty-points still received valid inter-function calls.

Last successful award before the break: 2026-06-03 03:19:16 UTC, invoice 19106 (Radiant tier, 4,600 pts). Every DP confirmation after 2026-06-03 04:03:11 UTC was silently denied points until this fix.

**Fix**: Replace the JWT decode in `award-loyalty-points/index.ts` with direct service-role-key equality against the `SUPABASE_SERVICE_ROLE_KEY` environment variable:

```js
// FROM:
let authorized = false;
try {
  const payload = JSON.parse(atob(token.split(".")[1]));
  if (payload?.role === "service_role") {
    authorized = true;
  }
} catch (_) { /* fall through to user check */ }

// TO:
let authorized = false;
if (token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
  authorized = true;
}
```

The function knows its own service role key from env, so direct string equality is the simplest, most reliable inter-function authorization mechanism. Avoids JWT parsing pitfalls entirely. The admin/finance user-check fallback below the service-role check remains intact — direct user calls (with a user JWT instead of the service role key) still go through `supabase.auth.getUser` + `has_role` checks.

**Catch-up plan** (post-deploy, separate work):
1. Query for all DP payments confirmed in the affected window (2026-06-03 04:03 UTC → fix-deploy time).
2. For each affected account, either (a) POST to `/functions/v1/award-loyalty-points` with the account_id to replay the award (once the auth fix is live), or (b) write loyalty_transactions backfill rows directly via SQL based on each account's `loyalty_jpy_amount` and the customer's current tier multiplier. Option (a) is cleaner since it goes through the canonical award path.

**Process note (locked lesson)**: Lovable-only auto-commits to security-critical edge functions (auth, payments, loyalty) that bypass the SOP gate can ship silent breaking changes. Going forward, ANY change to those functions should be planned and confirmed before shipping — no exceptions. The "Changes" auto-message pattern is a red flag indicating a session edit without proper documentation; future audits should treat such commits with extra scrutiny.

**Resolution & catch-up notes (added 2026-06-04 end of day)**

Outage window: 2026-06-03 04:03:11 UTC (commit `56ddae1` lands) → 2026-06-04 ~09:00 UTC (Bug #163 fix `3ae7b70` deployed). Approximately 29 hours.

**Catch-up scope was 2 accounts, not 4.** Initial diagnostic query identified 5 DP payments in the outage window across 4 unique accounts. Verification revealed two of those accounts already had `earned` txns from before the outage and would have hit the function's idempotency guard (section 4b) regardless of whether auth was working:

- **Sarah Arcibal-Ponting #19060** — prior earned txn from 2026-05-21 06:49:54 (700 pts, Glimmer). The June 4 08:06 DP confirmation was a re-confirmation/edit of an already-awarded account.
- **ケイ 東 #19105** — prior earned txn from 2026-06-03 00:38:34 (2,300 pts, Glimmer), ~3.5 hours BEFORE the breaking commit landed at 04:03:11 UTC. The two June 3 23:18/23:21 DP tranches were subsequent payments on an already-awarded account.
- **Bea Sartorio #19101** — NO prior earned txn. Actual catch-up needed.
- **Suzette Tupaz #19108** — NO prior earned txn. Actual catch-up needed.

**Catch-up was performed via SQL RPC backfill, not function POST.** External service-role calls to `award-loyalty-points` via `pg_net` returned 401 even with the correct service role key copied from Dashboard → Settings → API. Suspected cause: the Dashboard-displayed key doesn't equal the runtime-injected `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` value, possibly due to Supabase's `sb_secret_*` key-format rollout. This does NOT affect inter-function calls — verified empirically below — so the Bug #163 fix is sound for the production code path.

The catch-up RPC `public.replay_loyalty_award_bug163(uuid)` was a one-shot PL/pgSQL function replicating sections 4-12 of `award-loyalty-points` directly in Postgres: idempotency check, tier ratchet-up at post-upgrade multiplier, `earned` transaction insert with `notes = 'Bug #163 catch-up (SQL backfill)'`, member totals update, `tier_changed` transaction on upgrade. Intentionally skipped for retroactive (would have confused customers receiving stale notifications): email notifications, in-portal notifications, Google Sheet sync, `loyalty_point_lots` shadow write. RPC dropped after the two backfills completed.

**Final point totals (Bug #163 outage-related):**

| Invoice | Customer | Tier | Multiplier | Points awarded | Source |
|---|---|---|---|---|---|
| 19101 | Bea Sartorio | Radiant | 2× | 4,000 | SQL backfill 2026-06-04 10:03:31 UTC |
| 19108 | Suzette Tupaz | Glimmer | 1× | 1,000 | SQL backfill 2026-06-04 10:03:51 UTC |
| 19109 | Bernadette Bacho | (verification) | n/a | 3,600 | Natural inter-function call 2026-06-04 10:42:44 UTC |

**Runtime verification — empirical proof the fix works end-to-end.** Bernadette Bacho #19109 was the first natural DP confirmation post-deploy. DP confirmed at 2026-06-04 10:42:43.024238 UTC. The `earned` txn landed at 2026-06-04 10:42:44.9095 UTC — 1.9 seconds later. Auth gate passed, idempotency passed, award fired with correct value (3,600 pts). This confirms `review-payment-submission` → `award-loyalty-points` inter-function path works at runtime under the new direct-env-equality auth check. No Bug #164 needed.

**Future verification — diagnostic SQL pattern.** Use this whenever testing a loyalty-related auth change:

```sql
SELECT
  p.created_at AS dp_confirmed_at,
  la.invoice_number,
  c.full_name,
  lt.id AS earned_txn_id,
  lt.points_amount,
  lt.created_at AS earned_at,
  CASE
    WHEN lt.id IS NOT NULL THEN 'FIX WORKS'
    WHEN la.loyalty_jpy_amount < 10000 THEN 'BELOW MIN — expected skip'
    WHEN NOT EXISTS (SELECT 1 FROM loyalty_members lm WHERE lm.customer_id = la.customer_id) THEN 'NOT ENROLLED — expected skip'
    WHEN EXISTS (SELECT 1 FROM loyalty_transactions lt2 WHERE lt2.account_id = la.id AND lt2.transaction_type = 'earned' AND lt2.created_at < p.created_at) THEN 'ALREADY AWARDED — expected skip'
    ELSE 'FIX BROKEN — investigate immediately'
  END AS diagnosis
FROM payments p
JOIN layaway_accounts la ON la.id = p.account_id
JOIN customers c          ON c.id  = la.customer_id
LEFT JOIN loyalty_transactions lt
  ON lt.account_id = p.account_id
 AND lt.transaction_type = 'earned'
 AND lt.created_at >= p.created_at
WHERE p.created_at >= '<deploy_timestamp_utc>'::timestamptz
  AND p.voided_at IS NULL
  AND (p.reference_number LIKE 'DP-%' OR p.remarks ILIKE '%down%')
ORDER BY p.created_at DESC;
```

The `diagnosis` column collapses interpretation into one glance — distinguishes a genuine fix failure from the four common expected-skip paths.

**Process improvements (locked lessons):**

1. **Catch-up queries must filter already-earned accounts.** The initial Bug #163 catch-up query identified 5 DP payments and 4 unique accounts, but 2 of those required no action because they were already awarded — only revealed after we ran verification SQL and saw existing `earned` rows. For any future loyalty-related outage catch-up, add this filter to the candidate query:

```sql
   AND NOT EXISTS (
     SELECT 1 FROM loyalty_transactions lt
     WHERE lt.transaction_type = 'earned'
       AND lt.account_id = la.id
   )
```

2. **Absent-from-short-retention-logs ≠ "function not being called."** During this incident, edge function log retention via the analytics API was ~30 minutes. Within that window, `award-loyalty-points` had zero entries — but this was because no natural DPs had been confirmed in those 30 minutes, NOT because the function was failing. An external AI diagnostic incorrectly concluded the upstream caller was broken and recommended an unjustified Bug #164 patch. The actual root cause was empty-trigger-window, not broken-call-path. Always verify the trigger event actually occurred in the same retention window before drawing conclusions from log absence.

3. **External service-role HTTP auth has format-rollout fragility.** The Dashboard-displayed service role key currently doesn't equal the runtime `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` value, likely due to Supabase's `sb_secret_*` rollout. Inter-function calls work because both functions read the same env at invocation time. External SQL Editor / pg_net / curl calls using the Dashboard key fail with 401. Park this; only revisit if external invocation of security-gated functions becomes a real workflow requirement, at which point the auth check would need: (a) direct env equality (current), OR (b) JWT decode for legacy format, OR (c) explicit acceptance of new `sb_secret_*` format.

4. **SOP gate applies most strictly to security-critical edge functions.** Commit `56ddae1` — the originating cause of Bug #163 — was a Lovable-only auto-edit to the security-critical auth path with the generic auto-commit message "Changes", bypassing the standard `investigate → plan → confirm → ship` cycle. The fix (Bug #163) AND the catch-up (this addendum) consumed ~6 hours of operator time, affected 2 customers, and required 5 commits + 4 deploys + 1 one-shot RPC + 2 customer point backfills to resolve. Going forward, ANY change to auth, payment, or loyalty edge functions must pass through the full SOP gate — no exceptions. The "Changes" auto-commit message pattern is a red flag for unreviewed Lovable session edits and should trigger immediate audit when seen in `git log`.

**Architectural follow-up (added 2026-06-05) — sheet sync gap CLOSED**

The "External service-role HTTP auth has format-rollout fragility" gap
flagged in process improvement #3 above triggered an immediate follow-up
build the same evening rather than parking it. The hidden cost wasn't
just the 5,000 points of customer-facing loyalty debt — it was that any
future SQL RPC backfill, direct `loyalty_transactions` INSERT, migration,
or emission failure would silently bypass the Google Sheet backup with
no recovery mechanism.

The fix shipped as the **sheet sync reconciler architecture** — documented
in CLAUDE.md under "SHEET SYNC ARCHITECTURE — NON-NEGOTIABLE (added
2026-06-05)". Six steps:

1. Schema migration adding `loyalty_transactions.synced_to_sheet_at`
   timestamptz + partial index `idx_loyalty_transactions_unsynced` on
   `(created_at) WHERE synced_to_sheet_at IS NULL`. 952 historical rows
   marked synced; 2 (Bea + Suzette) deliberately left NULL to be picked
   up by the reconciler's first run.
2. Modified `award-loyalty-points` to mark synced after each successful
   `sync-loyalty-to-sheet` POST (the fast path). Commit `3c063c9` + deploy.
3. New `loyalty-sheet-reconcile` edge function — initial deploy at
   commit `f9fcd94`, embed disambiguation at commit `62d17ad`.
4. pg_cron entry `loyalty-sheet-reconcile` (jobid 21, schedule
   `7 * * * *`, Vault-backed auth).
5. Manual trigger empirically verified end-to-end: Bea (4,000 pts,
   Radiant 2×) and Suzette (1,000 pts, Glimmer 1×) emitted to the
   Transactions tab via the reconciler at 2026-06-05 05:38 UTC. Response
   `{processed: 2, succeeded: 2, failed: 0, remaining: 0}`. Post-run
   verification: `total_rows=954, synced_rows=954, unsynced_rows=0`.
6. This documentation update.

Also discovered during the build: the reconciler initially used the same
strict env-equality auth pattern as `award-loyalty-points` (post-Bug-#163
fix). That pattern works for inter-function calls but rejects external
calls when the Vault-stored service role key diverges from the runtime
`Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` value — which is the current
state per Supabase's `sb_secret_*` rollout. The cron uses Vault, so the
strict pattern broke the cron. Decision: drop the auth check entirely on
the reconciler (commit `0e845e2`), matching `sync-loyalty-to-sheet`'s
pattern. The reconciler is read-mostly and only writes a metadata column
— acceptable risk surface for an unauthenticated internal utility.
`award-loyalty-points` keeps its strict auth because it modifies customer
point balances.

**Net result:** every loyalty_transactions row now reaches the Google
Sheet backup, regardless of how it was created. SQL backfills, direct
INSERTs, migrations, edge function failures — all caught within ~1 hour
of insertion. The "external service-role HTTP auth fragility" gap is no
longer a parked item — it's been structurally routed around.

### Bug #164 — process-loyalty-redemption approve had no atomic rollback across its multi-write sequence (2026-06-05)

**Root cause:** The approve handler ran the seven writes — `loyalty_transactions` insert, `loyalty_redemptions` status flip + `transaction_id` stamp, `loyalty_members` balance debit (with non-atomic read-then-compute arithmetic), `loyalty_jpy_amount` net-reduce on the target order, synthetic `payments`/`cash_payments` insert, account/cash-order totals + status update, and `loyalty_rewards.current_stock` decrement — as sequential edge-function calls with no transaction wrapper. The two in-code comments "// atomic rollback is a separate phase" at L590 and L724 acknowledged the gap. The result was four latent holes:

1. **Double-approve race.** Two concurrent approve calls on the same pending redemption both passed the upstream `status === 'pending'` check, both inserted `loyalty_transactions` rows, and both flipped the redemption to confirmed — the customer was debited twice for one redemption.
2. **Lost-update points debit.** `update loyalty_members set remaining_points = <stale value computed in JS>` overwrote any concurrent points change between the read and the write. A redeem + an award firing in the same instant could double-credit or zero out the balance.
3. **Free-redemption hole.** If the synthetic payment INSERT or the account-totals UPDATE failed after the redemption and member rows were already written, the function returned 500 with the comment "redemption is already status='confirmed', member debited" — but the points were redeemed without any discount actually applied to the order. A retry from the UI re-approved (now blocked by status check) but never recovered the value.
4. **Approve-then-manual-refund stock race.** When `loyalty_rewards.current_stock` raced to 0 between create and approve, the function had already debited points and flipped redemption to confirmed, then emitted an "approved but cancel manually" notification and returned 409. Admin had to manually cancel + refund, which the code admitted via a Phase 3.2.1 TODO that "does not yet emit a separate notification."

**Fix:** SQL Editor added `approve_redemption_atomic(uuid, uuid, text) returns jsonb` — a SECURITY DEFINER function that performs all seven writes inside one Postgres transaction. The redemption and member rows are locked `FOR UPDATE` before any compute, points debit uses relative arithmetic (`set remaining_points = remaining_points - :points`) so concurrent updates merge correctly, and the stock decrement runs `update … where current_stock > 0` and raises `reward_out_of_stock` if no row matched. Any raise inside the function rolls back the entire write set — there is no half-committed state. `EXECUTE` is revoked from `PUBLIC` / `anon` / `authenticated`; service-role only.

`process-loyalty-redemption/index.ts` approve handler now keeps the upstream fast-error pre-flight (role check, redemption_id presence, pending-status check, member fetch, friendly insufficient-points compare) and replaces the entire write sequence with a single `supabase.rpc("approve_redemption_atomic", { p_redemption_id, p_user_id, p_user_email })` call. The four named raises map to friendly responses: `redemption_not_pending` → 400, `insufficient_points` → 400, `reward_out_of_stock` → 409 ("nothing was debited"), `not_found` → 404, generic → 500. Net frontend diff: −394 lines.

**Behavior change (owner-approved):** Catalog stock depletion at approve time now ABORTS the approval with 409 `reward_out_of_stock` and zero writes. The legacy "approved but cancel manually" notification + 409 path is removed. Customers who lose the stock race get a clean rejection instead of a debited account with a side notification asking admin to manually refund.

**Closes:**
- Hole #1 (double-approve race) — pending-status re-check now runs under `FOR UPDATE`; the second caller sees `redemption_not_pending` and rolls back with zero writes.
- Hole #2 (lost-update points debit) — relative arithmetic on a locked row.
- Hole #3 (free-redemption hole) — synthetic payment insert + totals update share the transaction; any failure rolls back the redemption flip and points debit.
- Hole #4 (stock-race manual-refund) — replaced with the abort-with-zero-writes behavior above.

**Edge-side cleanup:** The duplicate `audit_logs` insert for `redemption_approved` was removed from the edge function — the RPC owns that write now, so the previous code logged twice. Verified live 2026-06-05: points-only approve, `new_order_discount` approve + void on TEST-004, Check Health green, double-click race bounces correctly with `redemption_not_pending`.

**Untouched:** `create`, `cancel`, and `void` action handlers. The catalog-stock decrement and void branch were already atomic — this entry only closes the approve multi-write path. (commit `6b9d8a7`)

### Bug #165 — extension request feature silently broken for token-link customers (2026-06-06)

**Symptom**: Forfeited-account customers reaching the portal via the `?token=` URL flow could not submit a Request Extension. Submission appeared to succeed in the UI but no row landed in `public.extension_requests`. The duplicate-pending check on AccountDetail load returned `[]` for every customer, so the "Extension Request Pending" guard never fired either — a customer could "submit" the same request repeatedly with no feedback. Customers on the Phase B session-auth flow were unaffected because they hit the `authenticated`-role policy path.

**Root cause**: An earlier security pass (intermediate Lovable session, no preserved commit hash for the SQL block) had DROPPED every anon RLS policy on `public.extension_requests`. With RLS still enabled and no anon policy, anon callers had zero row visibility and zero INSERT permission. PostgREST returns 200 with an empty array on a permission-blocked SELECT, and the portal frontend's INSERT path quietly relied on PostgREST's `Prefer: return=representation` returning nothing on permission failure — so neither path surfaced an error to the customer.

**Third instance** of a security pass removing a live customer code path in roughly 30 days, after commit `2370082` (dropped the unrestricted `payment-proofs` anon upload policy, broke token-customer proof upload) and the Batch 4 same-day regression (dropped the broad `payment-proofs` authenticated upload policy, broke Phase B session uploads). Both prior instances were caught and patched the same day; this one ran undetected long enough to surface as an operations report.

**Fix**: Two anon RLS policies re-created via SQL Editor mirroring the `payment_submissions` anon pattern shipped in migration `20260605072749`:

1. **INSERT policy** (`"Anon can insert extension requests with token"`): `WITH CHECK (portal_token IS NOT NULL AND length(portal_token) >= 16 AND EXISTS (SELECT 1 FROM public.customer_portal_tokens t WHERE t.token = extension_requests.portal_token AND t.is_active = true AND (t.expires_at IS NULL OR t.expires_at > now()) AND t.customer_id = extension_requests.customer_id))`. Token must be ≥16 chars, point at a real active non-expired row, and own the customer_id being inserted (fail-closed against scope escalation).

2. **SELECT policy** (`"Anon can view own extension requests by token"`): `USING (portal_token IS NOT NULL AND length(portal_token) >= 16 AND portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text) AND EXISTS (SELECT 1 FROM public.customer_portal_tokens t WHERE t.token = extension_requests.portal_token AND t.is_active = true))`. Customers can only see their own rows, and only when the request header carries their token.

**Companion frontend bug — commit `90949f7`**: The duplicate-pending check at `src/pages/CustomerPortal.tsx` L1458-1465 was sending bare `apikey` + `Authorization: Bearer SUPABASE_KEY` headers, no `x-portal-token` and no session JWT. Even with the policies in place, the SELECT would have returned `[]` for the customer because the `x-portal-token` predicate in policy #2 above would never match. Fixed by rewriting the effect to `await getPortalAuthHeaders(portalToken)` and spread the result alongside `apikey` — exactly the pattern the extension POST a few lines below was already using. Token-mode customers now send `x-portal-token`; session-mode customers send their Bearer JWT.

**Process note**: The OPEN-BUGS / SYSTEM-STATUS regression-watch pattern recorded for `2370082` and Batch 4 needs to extend to RLS policy enumeration — not just storage and grants. A simple SQL snapshot of `pg_policies` before and after each security pass would have caught all three instances at the migration boundary. Locked in as a Process Improvement #5 candidate in the Bug #163 architectural follow-up, but the larger lesson is: any DROP POLICY statement in a security pass must be paired with explicit documentation of what replaces it.

### Bug #166 — Fix-all incident bucket flip (2026-06-06, commit `9b5c44b`)

Lovable "Try to fix all" flipped the `payment-proofs` bucket to private (no migration file produced) and redeployed `send-transactional-email` with an anon-key auth gate. Bucket reverted immediately via one SQL `UPDATE … SET public = true`. What was kept from the fix-all sweep: `proof-url.ts` (Phase 1 util, Option A material), two converted viewers (`CashOrderDetail`, `PaymentSubmissions`), and the `send-transactional-email` gate — the gate design was correct; the Bearer identity check was the defect, fixed in **Bug #168**. Auto-deploy remains off permanently. "Try to fix all" banned.

### Bug #167 — Portal stale-session mislabeled as Invalid Portal Link (2026-06-06, commit `694d43f`)

When a session-auth customer's refresh token is rotated on another device, the stored local session passes `getSession()` but the Bearer JWT is rejected server-side. The `fetchPortal` error branch painted this as "Invalid Portal Link" (the non-expired branch). Fix: self-healing fallback in `fetchPortal` — when `authMode === 'session' && token` is present and the fetch is rejected, `signOut()` the dead session, clear `accessToken`, set `authMode` to `'token'`, and return; the `useEffect` on `[token, authMode, accessToken, bootstrapping]` refetches in token mode automatically. Goes live on next Firebase Publish of commit `694d43f`. **NOTE**: `signOut()` uses default global scope — amend to `scope: 'local'` in the next bundled code prompt (queued).

### Bug #168 — Gate equality breaks Vault-backed crons (2026-06-06, commit `04a7f47`)

Six cron-targeted functions (`send-reminders`, `penalty-engine`, `auto-forfeit-settlement`, `daily-reconciliation`, `loyalty-inactivity-check`, `auto-expire-cash-orders`) compared the Bearer token to `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` with strict string equality. The pg_cron Vault key (`email_queue_service_role_key`) is a valid, currently-signed `service_role` JWT but not string-identical to the auto-injected env copy (different issuance). All six would 401 the nightly cron suite. `send-transactional-email` had the same defect from Lovable's fix-all gate. **Fix**: new shared helper `supabase/functions/_shared/jwt-claims.ts` (`parseJwtClaims` copied from `process-email-queue`); equality branch replaced with `claims?.role === 'service_role'` in all seven functions; `verify_jwt = true` added in `config.toml` for eight functions (six fixed + `process-loyalty-notification-queue` + `cleanup-loyalty-images`, which had claims-decode without gateway signature verification). Nine functions deployed. **Gate-class witness**: `daily-reconciliation` returned 200 via the Vault key at `net._http_response` id 5297 (timeout = function ran, not rejected; contrast instant 401 at id 5295). **Extension-email witness**: `net._http_response` id 5299 = 200; `email_send_log` extension-requested → sent within 7 seconds.

### Bug #169 — approve_redemption_atomic ENUM cast failure (P1, fixed 2026-06-06)

- **Symptom**: First live approve via the RPC returned 500 `column "currency" is of type account_currency but expression is of type text`. Transaction aborted cleanly — zero writes, redemption stayed pending (atomicity from Bug #164 fix held as designed).
- **Root cause**: `v_currency` is declared `text`; both synthetic-payment INSERTs (`public.payments` in the layaway branch, `public.cash_payments` in the cash branch) passed it uncast into the `currency` column, which is the `account_currency` ENUM. Both branches had the identical bug; per the cash-orders-are-first-class rule, both were fixed in one patch.
- **Fix**: `CREATE OR REPLACE` of `approve_redemption_atomic` run directly in Supabase SQL Editor on 2026-06-06 with exactly two changed tokens — `v_currency` → `v_currency::account_currency` in each INSERT's VALUES list. No code or deploy involved; the RPC lives only in the DB.
- **Verified**: `pg_get_functiondef` check confirmed `cast_count = 2`; subsequent live approve succeeded. This run was also the first successful staff-role approve through the `isInternal` server gate (a3d941b), confirming that change empirically.

### Bug #170 — fix-account-status: anon-key bypass + no-header bypass (2026-06-06, commit `28bc07e` deployed same day, 2026-06-06 09:15 UTC)

- **Symptom**: Security audit of edge-function auth gates surfaced two compounded bypass paths on `fix-account-status` — a System Health "fix" entry point that mutates `layaway_accounts.status`, `layaway_accounts.total_paid`, `layaway_accounts.remaining_balance`, `layaway_schedule.status`, `layaway_schedule.paid_amount`, `penalty_fees.penalty_amount`, and writes `audit_logs`. Anyone able to bypass the gate could silently rewrite balances and statuses on real customer accounts. Severity: Critical.
- **Bypass 1 (no-header)**: The original auth block wrapped its entire check in `if (authHeader)`. A request with **no** `Authorization` header skipped the JWT validation entirely and reached the action dispatch — fix-status / recalculate / sync_schedule all writable by anyone who could reach the function URL.
- **Bypass 2 (anon-key)**: Inside the gated branch, a fallback compared the Bearer token to `SUPABASE_ANON_KEY` and treated a match as `isInternalKey = true`, satisfying the authorization gate. The anon key is **publicly known** (shipped in every browser bundle) — anyone could mint the bypass header.
- **Root cause**: Optional auth (`if (authHeader)`) instead of mandatory; a public key (anon) treated as an internal-bypass credential. Neither path checked any role or permission.
- **Fix**: Auth block replaced with strict Bearer requirement (401 when missing/malformed), mandatory `supabase.auth.getUser(token)` validation, and a mandatory `hasPermission(user.id, "system_health")` role-permission check (403 on deny). `isInternalKey` removed entirely. `[functions.fix-account-status] verify_jwt = true` added to `supabase/config.toml` so the gateway validates the JWT signature before the handler executes. 2 files changed, 23 insertions, 11 deletions.
- **Verified**: Strict-mode gates exercised via `curl` after deploy — request with no `Authorization` header returns 401; request with a public anon-key Bearer returns 401 (anon JWT lacks `system_health` permission and is no longer special-cased); request with an admin/finance user JWT bearing `system_health` returns 200. Deploy timestamp: 2026-06-06 09:15 UTC.
- **Cross-reference**: Aligns with the **EDGE FUNCTION SERVICE-ROLE AUTH PATTERN** locked rule in CLAUDE.md (added 2026-06-06) and the broader Bug #168 hardening pass on cron-targeted functions.

### Bug #171 — Staff bell "Unknown sender" on staff/CSR-recorded payment submissions (fixed 2026-06-06)

- **Symptom**: `staff_notifications` bell entries for payment submissions read "Unknown sender submitted ..." even though `payment_submissions.sender_name` was populated when inspected.
- **Root cause**: `record-payment` and `record-multi-payment` created `payment_submissions` rows server-side **without** `sender_name`; the AFTER INSERT trigger `notify_submission_created` fired immediately and snapshotted NULL. The frontend (`RecordPaymentDialog` / `MultiInvoicePaymentDialog`) patched `sender_name` onto the row later alongside the proof upload — invisible to the already-written bell body. Portal paths (`submit-payment` / `submit-cash-payment`) were unaffected; `submit-cash-payment` requires `sender_name`, which is why cash submissions rendered correctly and created the misleading split in the data.
- **Fix (three layers, all 2026-06-06)**:
  1. Commit `2610741` — both edge functions now set `sender_name` at insert, derived as `user_metadata.full_name → email`, mirroring the existing `submitted_by_name` derivation. Deployed 2026-06-06 09:17 UTC.
  2. `notify_submission_created` hardened via SQL Editor `CREATE OR REPLACE` — `COALESCE` now falls back to `customers.full_name` (via `NEW.customer_id`) before `'Unknown sender'`, protecting any current or future name-late insert path.
  3. Historical repair via SQL Editor `UPDATE` — 25 bell rows rebuilt from their submissions' `sender_name` via `metadata->>'submission_id'` join, plus 1 row whose submission had NULL `sender_name` rebuilt with the customer's name (matching the new trigger fallback); verified 0 `'Unknown sender'` rows remain.
- **Note**: `submit-payment` was redeployed 2026-06-06 09:16 UTC during diagnosis; it was not the cause (its insert has included `sender_name` since `41fddad`, 2026-03-22) — redeploy harmless, function current.

### TODAY'S DATA FIXES (2026-05-20 / 2026-05-21)

  Account schedule/allocation repairs. All four accounts pass
  audit_account all_pass post-repair.

  - INV #18113: legacy overpayment-waterfall artifact. The old
    lumping waterfall (replaced by the row-by-row atomic waterfall
    in commit 9069ffd, 2026-04-23) had left surplus mis-stored.
    Surplus re-split into durable payment_allocations. Census
    confirmed no remaining affected population.

  - INV #18336: payment cd26d53c was over-allocated to installment 1
    (11,230 vs 10,000 base). Allocation capped to the base.

  - INV #18445: total_amount / carry tangle — installment 4 base
    corrupt, installment 2 overpaid, installment 3 carried a
    waived-penalty allocation, plus a bogus 931 carry. Reconstructed
    via allocation re-homing + base restore. Remaining unchanged at
    29,207.

  - INV #18693: carry-drop victim of Bug #117. total_due_amount
    restored to 10,513.58 (base 9,208 + penalty 500 + carried
    805.58) after the redeploy that made the carry-preservation fix
    live. Durable.

  (Originally recorded in CLAUDE.md commit 825512b 2026-05-21; lost in
  the lean-core trim c80ff8c; re-homed here 2026-05-26 alongside the
  new 2026-05-26 entry below, restoring the cross-reference in Bug
  #117.)

### TODAY'S DATA FIXES (2026-05-26)

  INV #17325
  Symptom: audit_account('17325') failed check 12 (sum of pending months) by ₱44.
  Balance, total_paid, and all other checks were correct.
  Root cause: legacy overpayment-waterfall artifact, pre-9069ffd (Apr 23). The Apr 6
  2026 payment (submission #add4f194 / payment 266ec018) of ₱24,000 on Month 4
  (due 23,956 = base 22,956 + penalty 1,000) was allocated as 1,000 penalty +
  23,000 installment — the installment ran ₱44 over base, and the surplus was never
  cascaded to Month 5. The view floors actual_remaining to 0, hiding the 44 from the
  per-row sum while the canonical balance counted it correctly.
  Fix (data only, no code): reallocated the ₱44 — M4 installment allocation
  94bc33e7 reduced 23,000 → 22,956; new M5 installment allocation of 44 added under
  the same payment 266ec018; M4 paid_amount → 23,956 (stays paid); M5 status →
  partially_paid, paid_amount 44 (actual_remaining 23,590).
  Result: audit_account('17325') all_pass. total_paid and remaining_balance
  unchanged (reallocation within one payment).
  NOT #116/#117 — no total_due reduction, no carried_amount involved.

### TODAY'S DATA FIXES (2026-06-04)

**Account #19105 — Kaila Daniela Catilo — DP misallocation cleanup**

**Symptom**: Audit check 2 (remaining_balance drift). Two of seven DP payments on the account had installment allocations created against schedule M1 and M2.

**Root cause**: edit-payment-amount Phase 3 unguarded re-allocation. See Bug #160 above.

**Fix**: Atomic SQL DO block in Supabase SQL Editor deleted 4 allocation rows by UUID literal (b36034dc, 0e7ac215, 1ec185b9, ac1e5c65), reset layaway_schedule.paid_amount to 0 and status to 'pending' for M1 and M2 of account_id b1c4117d-227b-408b-87aa-3d9583ea9707. The `payments` table was untouched — DP amounts and classifications preserved. The fix was applied before the code patch in Bug #160, so the bug was caught by audit before any further damage.

**Result**: Account #19105 now has 7 DP payments totaling ₱222,960 (matches `downpayment_amount` field), zero schedule allocations on those payments. `audit_account('19105')` returns `all_pass=true`.
