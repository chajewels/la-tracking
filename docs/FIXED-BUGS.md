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

### Bug #172 — `notify_extension_event`: `recipient_email` hardcoded as `'sales@chajewelsjp.com'` (2026-06-06, SQL fix same day)

The first `CREATE OR REPLACE` of `notify_extension_event` was applied with `'sales@chajewelsjp.com'` as a string literal in the `recipient_email` field of the `net.http_post` body. The Option A version (using `v_customer_email` read from `customers.email` at trigger execution time) was delivered but never successfully applied to the database. Result: every extension request email went to `sales@` regardless of the customer's actual email address — confirmed in `email_send_log` (10 sends to `sales@`, all from this version). Discovered by inspecting `pg_get_functiondef` output. Fix: re-ran the correct `CREATE OR REPLACE` with `v_customer_email`, `v_auth_user_id`, `v_token`, `v_portal_url` declared and used. Verified: `email_send_log` shows `recipient_email = chajewelsjapan@gmail.com` (test customer email) on the next two sends after the fix. Email audit of all other templates (`account-forfeited`, `cash-payment-confirmed`, `cash-payment-submitted`, `extension-granted`, `loyalty-earned`, `payment-submitted`, `payment-voided`, `penalty-applied`, `penalty-escalation`) confirmed all route to dynamic customer emails — no other hardcoded-recipient bugs found.

### Bug #173 — `system-health-check`: no inbound auth gate (2026-06-06, commit `a65a356`, deployed same day)

Scanner (Deep agentic scan) flagged Critical. The handler had no auth gate — after the OPTIONS return it went straight to creating a service-role client and executing health check queries against `layaway_accounts`, `layaway_schedule`, `customers`, `penalty_fees`, and `cash_orders`. Any unauthenticated request reached all data. Fix: user JWT gate inserted between the OPTIONS return and the `try` block — requires `Authorization: Bearer` header (401 if missing), `getUser(token)` validation (401 if invalid), then `user_roles` lookup gated to `admin / staff / finance / csr` (403 if no match). `verify_jwt = true` added in `config.toml`. Only caller is `UnifiedSystemHealthTab.tsx` L282 (`supabase.functions.invoke` — real staff session JWT, unaffected). Same fix class as `fix-account-status` (Bug #170). Pattern now locked: any function with only staff frontend callers gets user JWT + roles gate, never anon-key bypass or no-header bypass.

### Bug #174 — three ungated edge functions: `get-page365-order` (Critical), `sync-loyalty-to-sheet` (Warning), `append-cash-receipt` (Warning) (2026-06-07, commit `b1e41d3`, deployed same day)

Scanner (Deep agentic scan) flagged all three. `get-page365-order` had no inbound auth gate — any caller could retrieve customer PII (address, phone, order items) from the Page365 Google Drive CSV mirror. `sync-loyalty-to-sheet` had no inbound gate — any caller could write arbitrary rows to the Loyalty Google Sheet. `append-cash-receipt` had no inbound gate — any caller could write to the cash receipt Google Sheet. Fixes: **`get-page365-order`** — user JWT + `user_roles IN (admin / staff / finance / csr)` gate + `verify_jwt = true` (only caller: `InvoiceGeneratorSheet.tsx` via `invoke`). **`sync-loyalty-to-sheet`** — service-role claims gate + `verify_jwt = true` (callers: `adjust-loyalty-points`, `award-loyalty-points`, `loyalty-inactivity-check`, `loyalty-sheet-reconcile`, `process-loyalty-redemption`, `customer-portal` — all send `Bearer` env service role key). **`append-cash-receipt`** — service-role claims gate + `verify_jwt = true` (caller: `review-payment-submission` L835 + L1098, internal only). `verify_jwt = true` total: 16 functions.

### Bug #175 — `fix-account-totals`: no inbound auth gate (2026-06-07, commit `725afc8`, deployed same day)

Scanner (Deep agentic scan) flagged Critical. The bulk account-totals repair tool — which rewrites `total_paid`, `remaining_balance`, schedule `paid_amount`, and allocation records across all active accounts — had no inbound auth gate. Any unauthenticated caller could trigger mass database writes. No frontend or edge-function callers exist; the function is a manually-triggered admin utility. Fix: service-role claims gate (`parseJwtClaims` from `_shared/jwt-claims.ts`) + `verify_jwt = true` in `config.toml`. Confirmed 401 via `curl` post-deploy. `verify_jwt = true` total: **17 functions**.

### Bug #176 — `verify-portal-pin`: portal PIN stored as unsalted SHA-256 (2026-06-07, commit `6086c0f`, deployed same day)

Scanner (Deep agentic scan) flagged Critical. Portal PINs were hashed with `crypto.subtle.digest('SHA-256')` server-side with no salt. SHA-256 is a fast hash; a 4-digit PIN space (10,000 combinations) can be fully rainbow-tabled in milliseconds. Fix: replaced with PBKDF2-SHA256 via Deno's built-in `crypto.subtle` (100,000 iterations, 16-byte random salt per entry). Stored format changed from 64-char hex to `pbkdf2:{32-char-salt-hex}:{64-char-hash-hex}`. Lazy migration: existing SHA-256 hashes are verified once with the legacy `verifySha256` helper and silently re-hashed to PBKDF2 on the customer's next successful login. Default PIN auto-set (last 4 digits of `mobile_number`) now also uses PBKDF2 from the start. `verifySha256` helper is retained for migration only and never used to create new hashes.

### Bug #177 — `customers.portal_pin_hash` readable by authenticated customers (2026-06-07, SQL only, fully resolved)

Scanner (Deep agentic scan) flagged Critical. The `customers` table SELECT RLS policy (`auth_user_id = auth.uid()`) is row-level only; Postgres RLS cannot restrict individual columns. Session-authenticated customers could `SELECT portal_pin_hash` from their own row, enabling offline cracking. Two approaches were attempted and failed before the final fix: (1) column-level `REVOKE` broke PostgREST — it generates explicit column lists internally and errors when it hits a revoked privilege; (2) `REVOKE` + `NOTIFY pgrst reload schema` also failed — PostgREST schema reload did not resolve the conflict. Final fix: created `customer_pins` table (`customer_id UUID PK → customers.id`, `pin_hash`, `pin_attempts`, `pin_locked_until`) with RLS enabled and no SELECT policy for `authenticated` — `service_role` bypasses RLS entirely so edge functions are unaffected. Migrated 303 rows from `customers`. Updated `verify-portal-pin` (commit `747d76e`, deployed) to read and write all PIN fields from `customer_pins`; `customers` is now queried for `id` and `mobile_number` only. Dropped `portal_pin_hash`, `portal_pin_attempts`, `portal_pin_locked_until` columns from `customers`. Authenticated users now have zero access to PIN data at the schema level — the columns no longer exist on `customers`, and `customer_pins` has no `authenticated` SELECT policy.

### Bug #178 — Proof-of-payment filename collisions overwrote prior uploads in Storage (2026-06-07)

**Symptom**: Account #19116 (Kaila Daniela Catilo) had 5 confirmed downpayment submissions on 2026-06-07. SQL inspection showed all 5 `payment_submissions.proof_url` rows stored the EXACT same string — `https://.../payment-proofs/c8d63981-.../KailaDanielaCatilo_19116_DP_2026-06-07.jpg` — with `times_this_url_appears = 5`. Only the most recently uploaded image actually existed in Supabase Storage; the prior 4 images were gone. The View Proof inline link in Payment History rendered 5 distinct buttons (one per payment, per the Bug #161 rekey), but every button signed and opened the same surviving image because the underlying `proof.url` strings were identical.

**Root cause**: Three proof-upload code paths constructed filenames purely from human-readable identifiers (customer name, invoice, month/DP/Cash segment, date) with no uniqueness component:

- `src/pages/CustomerPortal.tsx` L2123 — customer portal main submission upload
- `src/components/payments/RecordPaymentDialog.tsx` L188 — staff payment recording from AccountDetail
- `src/components/customers/RecordCashPaymentDialog.tsx` L132 — staff cash payment recording

When the same customer + invoice + segment + date combination was uploaded multiple times — common for split downpayments, same-day installment-plus-penalty payments, or staff re-recording corrections — the filename was identical. The two staff paths (RecordPaymentDialog, RecordCashPaymentDialog) used `upsert: true` on the Supabase Storage `.upload()` call, which silently overwrites existing files. The customer portal path used a direct REST POST without an explicit `x-upsert` header, but Storage's behavior still produced overwrites in practice (the 5 #19116 uploads all succeeded with identical paths). Result: only the last image survived; the prior N-1 images were lost; all N submissions' `proof_url` rows pointed to the same surviving file.

Two existing-correct upload paths were unaffected because they already had uniqueness:
- `src/pages/CustomerPortal.tsx` L2660 — edit-submission flow uses `${timestamp}_${origName}` prefix
- `src/components/portal/CashPortalPaymentDialog.tsx` L131 — cash portal uses `${Date.now()}_${invoice}_Cash` prefix

`src/components/payments/MultiInvoicePaymentDialog.tsx` L348 was NOT in scope — it uses `upsert: false`, so filename collisions error out loudly rather than silently overwriting (different failure mode, lower data-loss risk).

**Fix**: Two changes per broken path —

1. Appended `_${Date.now().toString(36)}` to every filename in the 3 broken upload paths immediately before the extension. `Date.now().toString(36)` produces ~8 readable base-36 characters (e.g. `lo3ay7gz`), guaranteed unique for human-paced uploads, keeps the readable prefix intact for staff browsing Storage.

2. Flipped `upsert: true` → `upsert: false` on the two staff `.upload()` calls (RecordPaymentDialog L195, RecordCashPaymentDialog L136). Defensive: if the timestamp suffix ever fails to produce uniqueness (theoretical same-millisecond from rapid concurrent uploads), Storage will throw an HTTP 409 instead of silently overwriting — the failure becomes visible.

**Data state caveat — #19116**: The original 4 proof images for #19116's first 4 downpayment submissions are GONE from Storage, overwritten between 11:35 UTC and 13:09 UTC on 2026-06-07 when the 5 uploads happened in sequence. The 5 `payment_submissions.proof_url` rows still exist and still point to the surviving file (the 13:09 UTC upload). All 5 View Proof buttons will continue to render and open the same image until either (a) the customer re-uploads the original 4 images and staff updates each row's `proof_url` to a unique new path, or (b) the historical mismatch is accepted as documentation cost of the bug. The submissions are all `confirmed` and the payment data itself (amounts, dates, allocations) is intact and unaffected — only the proof archive lost 4 of 5 images for this account.

**Going-forward consideration**: After this fix ships, no future filename collision is possible across the 3 affected paths. If perfect consistency is desired, a follow-up patch could extend the same uniqueness suffix to `MultiInvoicePaymentDialog.tsx` L348 — currently safe due to `upsert: false` but ideally aligned with the other paths' filename convention.

### Bug #179 — Payment History list sorted by entry time instead of payment date (2026-06-07)

**Symptom**: Account #19116's Payment History displayed 5 confirmed downpayments out of chronological order — Mar 4 → Jun 2 → Jun 7 → Apr 2 → May 3 — instead of the correct Mar 4 → Apr 2 → May 3 → Jun 2 → Jun 7. Surfaced immediately after Bug #178's data correction set `date_paid` to the actual transfer dates on the 2 back-entered rows.

**Root cause**: `src/pages/AccountDetail.tsx` L1752 rendered the Payment History list with `[...payments].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())` — sorting by `payments.created_at` (when staff recorded the row) instead of `payments.date_paid` (when the customer actually transferred). For accounts where every payment is recorded same-day as it happens, both columns track together and the bug is invisible. For accounts with back-entered payments — where staff catches up on weeks or months of historical transfers in a single session — `created_at` reflects entry order, not transfer order, producing misordered displays.

**Fix**: Changed the sort comparator to sort primarily by `date_paid`, with `created_at` as the tiebreaker for same-day payments. Null-safe: if `date_paid` is missing (shouldn't occur on confirmed payments, but defensively), falls back to `created_at`.

**Going-forward**: This same sort pattern may exist in other Payment History renderings (`src/pages/CustomerPortal.tsx`, `src/pages/PaymentSubmissions.tsx`, `src/pages/PaymentsHub.tsx`). A follow-up grep should confirm whether they need the same correction.

### Bug #180 — `set-portal-pin`: SHA-256 hashing + writes to dropped `customers` columns (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Critical. `set-portal-pin` still used `crypto.subtle.digest('SHA-256')` and wrote `portal_pin_hash`, `portal_pin_attempts`, `portal_pin_locked_until` to the `customers` table — columns that were dropped on 2026-06-07 (Bug #177). Any call returned 500. Auth gate (admin/staff JWT) was already correct. Fix: replaced SHA-256 with PBKDF2-SHA256 (100,000 iterations, 16-byte salt) matching `verify-portal-pin`, and switched the write target to `customer_pins.upsert`. `verify_jwt = true` added.

### Bug #181 — `carry-over`: zero authentication (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Critical. `carry-over` had no inbound auth gate — any internet user could POST to mark schedule rows as paid, forge carry amounts, and flip account status. No frontend `invoke` callers exist (called internally by `accept-underpayment` via service-role). Fix: service-role claims gate (`parseJwtClaims` from `_shared/jwt-claims.ts`) + `verify_jwt = true`. Confirmed 401 via `curl`.

### Bug #182 — `reconcile-account`: zero authentication (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Critical. `reconcile-account` exposed full per-account financial drift data (`total_paid`, `remaining_balance`, schedule status discrepancies) with no auth gate. Report-only but writes to `reconciliation_log`. Frontend caller: `AccountDetail.tsx` auto-triggers on mount with user session JWT. Fix: staff JWT gate (`is_staff` RPC) + `verify_jwt = true`. Confirmed 401 via `curl`.

### Bug #183 — `edit-schedule-item`: any authenticated JWT accepted (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Critical. `edit-schedule-item` validated the JWT (`getUser`) but had no role check — any Phase B customer with a session JWT could alter `base_installment_amount` on any schedule row. Fix: `is_staff` RPC check inserted after `getUser`. `verify_jwt = true` added. Confirmed 401 via `curl`.

### Bug #184 — `send-transactional-email`: customer JWTs accepted in user-JWT fallback (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Critical. The function has a service-role claims gate + user-JWT fallback for the staff share-menu caller. The fallback called `auth.getUser` and proceeded on any valid JWT — including Phase B customer session JWTs — with no role check. Any authenticated customer could trigger company-branded email sends to arbitrary recipients. Fix: `is_staff` RPC check inserted in the user-JWT fallback path after `getUser` succeeds. Confirmed 401 via `curl`.

### Bug #185 — `award-loyalty-points` + `finance-reconciliation`: prohibited service-role string equality (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Warning. Both functions used `token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` string equality — the Bug #168 prohibited pattern that rejects Vault-backed cron keys. Both are dual-gated (`service_role` OR admin/finance user JWT). Additional issue in `finance-reconciliation`: used `SUPABASE_ANON_KEY` to initialize the auth client for user JWT verification — replaced with `SUPABASE_SERVICE_ROLE_KEY` for consistency. Fix: `parseJwtClaims` import + claims-based check for both. `verify_jwt = true` added. Stale Bug #163 comment removed from `award-loyalty-points`.

### Bug #186 — `parse-import-docs`, `restore-loyalty-points`, `revoke-loyalty-points`, `bulk-import`: prohibited service-role string equality (2026-06-08, commit `4833407`, deployed same day)

Scanner flagged Warning. All four used `token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` string equality — Bug #168 prohibited pattern. All are service-role-only (no frontend `invoke` callers). Fix: `parseJwtClaims` import + claims-based check for all four. `verify_jwt = true` added. Confirmed 401 via `curl`.

### Bug #187 — `record-payment` + `record-multi-payment`: cross-account submission injection + anon key auth client (2026-06-08, commit `cbb8414`, deployed same day)

Scanner flagged Warning. `record-payment` had a dual code path: admin/finance callers directly record payments; non-admin/finance callers insert `payment_submissions`. The non-admin/finance path accepted any authenticated JWT including Phase B customer session JWTs with no ownership check — any customer could POST with any `account_id` and inject payment submissions into the CSR review queue. `record-multi-payment` similarly accepted any authenticated JWT; its `customer_id` ownership check used a `customer_id` from the request body (not verified against the caller's identity). Additional issue: `record-multi-payment` used `SUPABASE_ANON_KEY` to initialize the auth client for user JWT verification. All frontend callers are staff-side components (`RecordPaymentDialog.tsx`, `MultiInvoicePaymentDialog.tsx`, `BulkPaymentImport.tsx`, `use-supabase-data.ts`). Fix: `is_staff` RPC gate added to both after `getUser`. `record-multi-payment` auth client switched to `SUPABASE_SERVICE_ROLE_KEY`. `verify_jwt = true` added to both. Confirmed 401 via `curl`.

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

### Bug #189 — Loyalty redemption void atomic via RPC migration (2026-06-09) ✅

  process-loyalty-redemption edge function's void branch (L744-1447)
  was ~700 lines of inline TypeScript doing ~15 sequential DB writes
  with no atomic rollback. Outer try/catch swallowed all errors into
  console.warn, leaving customers in partial states on mid-step
  failures.

  Fix: created public.void_redemption_atomic PL/pgSQL RPC (single
  transaction, FOR UPDATE locks, relative arithmetic on member
  balance, atomic account_notes inside the boundary). Refactored edge
  function to ~180 lines: auth + validation + RPC call + error code
  mapping + non-atomic side effects (staff_notifications, email,
  Phase 4.2 in-app notification, Google Sheet revoked sync). Response
  shape preserved.

  Counterpart to Bug #169 (approve atomicity, fixed 2026-06-05).

  Files: supabase/functions/process-loyalty-redemption/index.ts,
         public.void_redemption_atomic (Supabase DB)
  Related: SYSTEM-STATUS.md entry on the same date.

### Bug #188 — Cash Order Edit Expiry gate mismatch (2026-06-09) ✅

  The Edit Expiry button in src/pages/CashOrderDetail.tsx L716
  was gated by `(isAdmin || isFinance)`, but the RLS UPDATE policy
  `staff_admin_update_cash_orders` allows admin OR staff. Result:
  finance users saw a button that failed with permission errors;
  staff users had UPDATE permission but no button.

  Fix: changed UI gate to `(isAdmin || isStaff)`. Added
  `const isStaff = rolesArr.includes('staff');` declaration near
  L264. UI now matches the existing RLS policy.

  Files: src/pages/CashOrderDetail.tsx
  Related: SYSTEM-STATUS.md entry on the same date.

### Bug #191 — RecordPaymentModal passed raw view rows to RecordPaymentDialog (2026-06-08) ✅ (renumbered from #185 on 2026-06-09 to resolve parallel-session collision)
- **Symptom:** The floating Record Payment modal queried `schedule_with_actuals` directly and passed raw view rows to RecordPaymentDialog. The view exposes `allocated` / `computed_status` / `actual_remaining`, but RecordPaymentDialog reads `paid_amount` / `status` / `total_due_amount`. Result: schedule rows displayed incorrect paid/unpaid state (status was undefined for every row), "Due for this month" amount was wrong (used the view's `total_due_amount` directly rather than `actual_remaining`), and partial-paid warnings (which depend on `status === 'partially_paid'`) never fired
- **Root cause:** The modal duplicated the schedule fetch logic instead of using the existing `useSchedule` hook (which already normalizes the view's field names into the shape RecordPaymentDialog expects). AccountDetail's existing Record Payment entry point has always gone through `useSchedule`, so that entry point was correct; only the new floating modal was affected
- **Fix:** Replaced direct `supabase.from('schedule_with_actuals')` query with the `useSchedule(accountId)` hook. Removed local `scheduleData` / `scheduleLoading` state (now managed by react-query). Removed unused `useEffect` and `supabase` imports. Preserved original fetch gating (hook only fires when `step === 'record'`)
- **File:** `src/components/payments/RecordPaymentModal.tsx`
- **Note:** Bug #190 fixed the DP remaining display specifically (the `downpaymentRemaining` useMemo). This bug fixes the entire schedule row display across RecordPaymentDialog's UI. Together they bring the modal entry point to behavioral parity with AccountDetail's existing entry point

### Bug #190 — RecordPaymentModal DP remaining ignored existing DP payments (2026-06-08) ✅ (renumbered from #184 on 2026-06-09 to resolve parallel-session collision)
- **Symptom:** New floating Record Payment modal's single-payment view showed the full base downpayment amount as "remaining" even when DP payments had already been recorded against the account
- **Root cause:** Component referenced `dp.paid_amount` and `dp.is_downpayment` — neither column exists on the `schedule_with_actuals` view. `Number(undefined ?? 0)` evaluated to 0, so subtraction never reduced the displayed remaining
- **Fix:** Renamed `dp.paid_amount` → `dp.allocated` (correct view column); removed dead `is_downpayment` OR branch
- **File:** `src/components/payments/RecordPaymentModal.tsx`
- **Note:** No data damage — backend record-payment edge function allocates from actual DB state, independent of the frontend display value

### TODAY'S DATA FIXES (2026-06-07)

#### 2026-06-07 — Account #19116 (Kaila Daniela Catilo) proof-image + date_paid correction

**Context**: Bug #178 (filename-collision class) caused 5 downpayment submissions on account #19116 (`c8d63981-4b06-40e6-86ef-4f3e7ea21906`) to share a single Storage file. The original 4 receipt images were overwritten and irrecoverable server-side. Customer Kaila provided the 5 original BDO transfer receipts after the code fix shipped, allowing manual correction.

**State found before correction**:
- 5 confirmed downpayment `payment_submissions` rows, all `proof_url` pointing at the same file `c8d63981-4b06-40e6-86ef-4f3e7ea21906/KailaDanielaCatilo_19116_DP_2026-06-07.jpg` (62987 bytes, last overwritten 2026-06-07 11:45 UTC)
- 2 of the 5 `payments` rows had wrong `date_paid` (`2026-06-07`) because staff back-entered them today instead of setting the actual transfer date

**Correction actions taken**:
1. Uploaded 5 receipt images to Supabase Storage (`payment-proofs` bucket, landed at bucket root):
   - `KailaDanielaCatilo_19116_DP_2026-03-04.jpeg` — Mar 4 Heartbiz Downpayment (₱7,430)
   - `KailaDanielaCatilo_19116_DP_2026-04-02.jpeg` — Apr 2 Gold Bracelet (₱2,890)
   - `KailaDanielaCatilo_19116_DP_2026-05-03.jpeg` — May 3 May Payment (₱2,890)
   - `KailaDanielaCatilo_19116_DP_2026-06-02.jpg` — Jun 2 Payment for June (₱2,890)
   - `KailaDanielaCatilo_19116_DP_2026-06-07.jpg` — Jun 7 Full Payment for Trading (₱8,667)
2. SQL `UPDATE payments SET date_paid = ...` on 2 rows to correct dates from `2026-06-07` to actual transfer dates:
   - `dac613cf-4c79-4959-b769-eaa4fa42e40c` → `2026-04-02`
   - `a345826d-b3e7-442b-8ecc-aa995c980044` → `2026-05-03`
3. SQL `UPDATE payment_submissions SET proof_url = ...` on 5 rows to point each at its correct date-specific Storage file. All URLs use the bucket-root path pattern `https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/payment-proofs/KailaDanielaCatilo_19116_DP_YYYY-MM-DD.{jpg,jpeg}`.

**Final state**:
- All 5 submissions display correctly in AccountDetail Payment History (chronological order achieved after Bug #179 sort fix shipped same day).
- `payments.date_paid` matches the receipt dates on each BDO transfer screenshot.
- Each submission has its own unique `proof_url` pointing at a distinct file in Storage.
- Financial data (amounts, allocations, schedule status, loyalty) untouched throughout — only `date_paid` strings and `proof_url` strings changed.

**Loose ends**:
- One orphaned file remains at `c8d63981-4b06-40e6-86ef-4f3e7ea21906/KailaDanielaCatilo_19116_DP_2026-06-07.jpg` (62987 bytes — the original Bug #178 collision survivor). No `proof_url` row points at it anymore. Safe to delete via Storage dashboard whenever convenient.
- The Apr 2 vs May 3 receipt-to-submission_id mapping was determined by chronological assumption (earlier-created submission row maps to earlier receipt date). If staff actually entered them in the reverse order, swap the two `date_paid` values via a simple SQL UPDATE — no downstream impact.

### Bug #192 — `approve-waiver` hardcoded admin/finance gate, blocked staff with `manage_waivers=true` (2026-06-10) ✅
- **Symptom:** Staff member (Brenda) with `role_permissions.manage_waivers=true` in Settings matrix received 403 from `approve-waiver` edge function when approving penalty waivers
- **Root cause:** `approve-waiver/index.ts` L36-44 used hardcoded `has_role(admin) OR has_role(finance)` check, bypassing the `role_permissions` matrix entirely. Settings matrix was decorative for this function — toggling `staff.manage_waivers` in Settings had no effect on actual access
- **Fix:** Migrated gate to use `_shared/check-permission.ts` helper with permission key `manage_waivers`. Function now honors Settings matrix as the source of truth.
- **UI:** Also gated Approve/Reject buttons in `Waivers.tsx` with `can('manage_waivers')` so users without permission don't see actions that would 403.
- **Files:** `supabase/functions/approve-waiver/index.ts`, `src/pages/Waivers.tsx`
- **Note:** First migration from hardcoded `has_role` gate to matrix-honoring `checkPermission`. Phase 1 of broader role-permissions wiring audit. 30 edge functions in the same hardcoded-gate pattern (record-payment, void-payment, restore-payment, edit-payment-amount, adjust-loyalty-points, etc.) are scheduled for Phase 2/3 migration — see `SYSTEM-STATUS.md`.

### Bug #193 — Unwaive flow asymmetric: never reset `penalty_waiver_requests.status`, created orphan rows (2026-06-10) ✅
- **Symptom:** After clicking Unwaive on an approved waiver, `penalty_fees` correctly reverted to `unpaid` and `waived_at` cleared, but `penalty_waiver_requests.status` stayed at `approved` with `approved_by_user_id` + `approved_at` populated. UI showed inconsistent state: waiver=Approved next to penalty=unpaid. Admin testing approve flows post-unwaive was blocked because the orphan didn't re-enter the pending queue.
- **Root cause:** `handleUnwaive` in `src/pages/Waivers.tsx` (L106-195) did 3 client-side steps that updated `penalty_fees`, `layaway_schedule`, and `layaway_accounts` — but never touched `penalty_waiver_requests`. Result: the request record stayed at the post-approve state forever. Not atomic across the 3 supabase writes.
- **Fix:** New PL/pgSQL RPC `public.unwaive_penalty_atomic(p_waiver_id, p_user_id, p_user_email)` (`SECURITY DEFINER`, `search_path=public`) performs the entire reverse-of-approve as a single transaction: resets `penalty_waiver_requests.status='pending'`, restores `penalty_fees.status='unpaid'`, recalculates `layaway_schedule` and `layaway_accounts` (including reverting `completed` → `overdue`/`active`), inserts audit log. New edge function `unwaive-waiver/index.ts` wraps the RPC with auth + `checkPermission('manage_waivers')`. UI `handleUnwaive` refactored from 90 LOC of direct supabase writes to ~15 LOC edge function invoke. **Same-day RPC enum cast fix (2026-06-10):** initial RPC used `::layaway_account_status` enum cast which doesn't exist; CREATE OR REPLACE FUNCTION redeployed with `::account_status` (the actual enum name).
- **Files:** `supabase/functions/unwaive-waiver/index.ts` (new, commit `cba3e4a`), `src/pages/Waivers.tsx` (handleUnwaive refactor, commit `94c5909`), `public.unwaive_penalty_atomic` RPC (new in DB, with same-day enum cast fix).
- **Orphan backfill — corrected record (2026-06-10):** Initial orphan detection used the criteria `waiver_status='approved' AND waived_at IS NULL`. This **over-matched** — only `penalty_status='unpaid'` indicates a true asymmetric-unwaive orphan. The `penalty_status='paid'` combination is the legitimate "approve-after-payment" pattern (customer paid penalty before staff approved waiver as goodwill marker; approve flow correctly skipped setting `waived_at`).
  - **Roselia #18603** — TRUE orphan (penalty_status was `unpaid`). Reset to pending successfully. Brenda re-approved through normal staff flow; account verified clean.
  - **Monika #17933** and **Maria #17110** — NOT orphans. Penalties were legitimately paid by customers. Backfill incorrectly reset their waiver_requests to pending. Staff/admin then re-approved via UI at 06:35 UTC, which incorrectly flipped `penalty.status` from `paid` to `waived` (approve flow doesn't check if penalty was already paid). Created reconciliation gap: customer's payment in `payments` table + penalty marked `waived` = double-credit on financial reports.
  - **Recovery:** Monika — unwaive (penalty → unpaid, waiver → pending) + reject waiver. Maria — same unwaive + reject + manual `UPDATE penalty_fees SET status='paid', waived_at=NULL` (penalty was legitimately paid by ₱9,956 BDO payment 2026-03-22). Both accounts verified at `remaining_balance=0`, `account_status='completed'`, audit_logs entries for `reconciliation_correction` action.
- **Lesson learned:** Future orphan-detection queries MUST tighten the criteria. The `waiver_status='approved' AND penalty_status='unpaid' AND waived_at IS NULL` combination is a true orphan. The `penalty_status='paid' AND waived_at IS NULL` combination is the legitimate "approve-after-payment" goodwill pattern and must NOT be touched.
- **Architectural pattern:** Mirrors `approve_redemption_atomic` (2026-06-08) and `void_redemption_atomic` (2026-06-09). All three atomic-reverse RPCs follow the same shape: `SECURITY DEFINER` + `search_path = public` + jsonb return with `error_code` mapping.
- **Related:** 
  - Bug #194 — `penalty-engine` cron has the same asymmetric write at L362 (programmatic unwaive without resetting waiver_request). Separate scope, scheduled for next session.
  - Bug #195 — Bulk-import payments don't create `payment_allocations` rows, causing legacy data drift in Account Health checks (multi-account scope). Surfaced during Bug #193 reconciliation cleanup. Separate scope.

### Bug #194 — `penalty-engine` cron programmatically unwaives penalties without resetting `penalty_waiver_requests` (open, scheduled) ⏳

- **Symptom:** Same orphan-state class as Bug #193, but produced automatically by the cron rather than by a UI click. After `penalty-engine` runs, some previously-waived penalties become `status='unpaid'` with new `penalty_date`, while their corresponding `penalty_waiver_requests.status` stays at `approved`.
- **Location:** `supabase/functions/penalty-engine/index.ts` L362.
- **Code:** Direct `UPDATE penalty_fees SET status='unpaid', waived_at=NULL, penalty_date=...` without touching `penalty_waiver_requests`.
- **Different semantic context vs Bug #193:** This is system-driven re-evaluation, not user-initiated reversal. The waiver_request resolution may differ — possibly mark as `auto_reversed`, possibly leave as historical `approved` (since the user's intent was a goodwill waive even if the system later re-applied the penalty). Fix design pending.
- **Status:** Open. Scheduled for next session. No customer impact for now (similar to Bug #193 orphan state — harmless if penalty subsequently gets paid).

### Bug #195 — Bulk-import payments don't create `payment_allocations` rows (legacy data drift) ⏳ OPEN

- **Symptom:** Account Health Check panel fails on:
  - `no schedule rows with paid_amount but no allocations` — schedule rows with `paid_amount > 0` and `allocations_count = 0`
  - `schedule status consistent with allocations` — schedule rows marked `status='paid'` with no allocations recording how they were paid
- **Scope:** Multi-account legacy issue. Surfaced on Maria #17110 (5 of 6 schedule rows affected during Bug #193 cleanup), likely affects most accounts that received bulk-imported payments before native payment-recording was deployed.
- **Root cause:** The bulk-import payment process inserts rows into `payments` and updates `layaway_schedule.paid_amount` directly, but doesn't create corresponding `payment_allocations` rows. Native payment-recording (via `record-payment` edge function) properly creates allocation rows.
- **Customer-facing impact:** None. Account `remaining_balance` reflects all payments accurately. Issue is purely in audit/reconciliation reports.
- **Workaround / proposed migration:** For each bulk-imported payment, identify the matching schedule row by `due_date` and create a `payment_allocations` row with `allocation_type='installment'`, `allocated_amount=payment.amount_paid`. Down-payment rows (`ref LIKE 'DP-%' OR remarks LIKE '%down%'`) don't get allocated (DP reduces account total directly, not via schedule).
- **Discovered during:** Bug #193 reconciliation on Maria #17110 — 5 of her 6 schedule rows (Oct 2025–Feb 2026 installments, payment screenshot showed `cash · Installment N (bulk import)` label) had no allocations, while the 1 native BDO payment from 2026-03-22 correctly created 2 allocations (base + penalty).
- **Status:** Open. Not customer-blocking. Pending decision on whether to migrate (preferred) or document as accepted historical drift.

### Bug #196 — `_shared/check-permission.ts` failed for multi-role users (2026-06-10) ✅

- **Symptom:** Edge functions using `checkPermission()` would silently fail or behave incorrectly for users with more than one row in `user_roles`. The `.maybeSingle()` call on `user_roles` would throw if multiple rows existed (PostgREST returns 406 with PGRST116 error). Even with one role, the helper only inspected a single role and ignored secondary role permissions.
- **Root cause:** `_shared/check-permission.ts` used `.maybeSingle()` on the `user_roles` query, expecting only one row per user. The schema permits multiple role rows per user (composite roles like has_admin + has_finance). Current code only checked the first/single fetched role; admin check used `role === "admin"` (single comparison); role_permissions lookup used `.eq("role", role)` (single role).
- **Fix:** Refactored to fetch all role rows, build a `roles` array, then mirror the UI's `usePermissions().can()` pattern:
  - `roles.includes("admin")` for admin shortcut
  - `.in("role", roles)` query against role_permissions
  - `.some(rp => rp.is_allowed === true)` to OR across results
- **Files:** `supabase/functions/_shared/check-permission.ts` (1 file, ~47 LOC, refactored).
- **Dependent functions redeployed:** `approve-waiver`, `unwaive-waiver`, `manual-forfeit`, `reactivate-account` (each bundles the shared file at deploy time; need redeploy to pick up the fix).
- **Related:** Phase 1 of role_permissions matrix audit (Bug #192). This is item 2 of the locked 4-item Phase 2 scope.

### Bug #197 — PermissionMatrixTab + PAGE_PERMISSION_MAP cleanup: cash order keys, geo breakdown, /waivers route gating (2026-06-10) ✅

- **Symptom:** Three permission gaps preventing admin from managing role-based access through Settings UI:
  1. `view_cash_orders` and `create_cash_order` used by `/cash-orders` and `/cash-orders/new` pages (already in PAGE_PERMISSION_MAP at PermissionsContext.tsx L66-67), but absent from PermissionMatrixTab UI — admins couldn't toggle them per role.
  2. `view_geo_breakdown` referenced by `src/pages/Dashboard.tsx` L48, but absent from PermissionMatrixTab.
  3. `/waivers` route exists in App.tsx but absent from PAGE_PERMISSION_MAP — page was UN-gated, any authenticated user could navigate there directly via URL. Also missing from NAV_PATHS so sidebar gating couldn't apply.
- **Root cause:** Drift between code references and the admin-facing matrix UI / route gating definitions. Original Phase 1 audit (CLAUDE.md) flagged these.
- **Fix:**
  - `src/components/settings/PermissionMatrixTab.tsx`: Added `view_geo_breakdown` to Dashboard module; added `view_cash_orders` + `create_cash_order` to Sales module under new `section: 'Cash Orders'` subdivision (right after `reassign_owner`).
  - `src/contexts/PermissionsContext.tsx`: Added `'/waivers': 'view_waivers'` to PAGE_PERMISSION_MAP; appended `/waivers` to NAV_PATHS array.
  - **DB prerequisite (already applied 2026-06-10 before this commit):** `UPDATE public.role_permissions SET is_allowed = true WHERE permission_key = 'view_waivers' AND role = 'staff'`. Required because PAGE_PERMISSION_MAP gating would otherwise regress Brenda's access to the waivers approve workflow shipped in Bug #192.
- **Files:** `src/components/settings/PermissionMatrixTab.tsx`, `src/contexts/PermissionsContext.tsx`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Verification:**
  - Admin Settings → Permissions tab now shows view_cash_orders, create_cash_order, view_geo_breakdown rows in correct sections.
  - Direct navigation to `/waivers` for users without `view_waivers=true` returns AccessDenied.
  - Brenda (staff) retains access (view_waivers=true seeded pre-commit).
- **Related:** Item 3 of locked Phase 2 scope after Bug #192 (Phase 1 approve-waiver migration), Bug #193 (unwaive flow asymmetry), Bug #196 (check-permission.ts multi-role). Triggers Bug #198 (broader matrix UI / DB drift audit).

### Bug #198 — Broader matrix UI / DB drift: 11 additional DB-only permission keys absent from PermissionMatrixTab (open)

- **Symptom:** Audit run during Bug #197 closure (2026-06-10) revealed 11 DB-seeded permission keys not exposed in PermissionMatrixTab UI beyond the 3 fixed in #197. Admins cannot toggle these per role through Settings; behavior is determined solely by current DB row state (or absence) with no UI surface.
- **Keys missing from matrix UI (DB has rows for each):**
  - Cash order admin flows: `approve_cash_order`, `edit_cash_order`
  - Loyalty: `view_loyalty_redemptions` (referenced in PAGE_PERMISSION_MAP L78-79), `loyalty_adjust_points`
  - Trade-ins: `manage_trade_ins`, `view_trade_ins`
  - Admin tools: `recalculate_balance`, `run_reconciliation`
  - Monitoring/health: `view_ai_risk`, `view_live_collection`, `view_operations_panel`, `view_system_health` (separate from `system_health` already in matrix)
- **Required next steps before fix:**
  1. Grep each key in `src/` to determine if actively code-referenced or dead/legacy DB rows
  2. For each actively-used key: decide correct matrix module + section placement
  3. For each dead key: decide whether to delete from DB or leave as-is
  4. Verify per-role `is_allowed` seeds before exposing in UI (so toggling defaults don't surprise existing users)
- **Scope note:** Larger than Bug #197's 3-key fix — may require new matrix module headers (Trade-Ins, Admin Tools) or further section subdivisions. Defer until after Phase 2 item 4 (10-edge-function hardcoded gate migration).
- **Status:** Documented, not actively in current Phase 2 scope.

### Bug #199 — Phase 2 Batch A: 5 account lifecycle edge functions migrated to checkPermission (2026-06-10) ✅

- **Symptom:** Five staff-facing edge functions (create-layaway-account, create-cash-order, delete-account, restructure-account, carry-over) used hardcoded `supabase.rpc("has_role", {...})` checks that ignored the role_permissions matrix UI in admin Settings. Toggling a permission in the matrix had no effect on these operations — DB rows existed but were not consulted by edge function gates.
- **Root cause:** Pre-checkPermission era pattern from before `_shared/check-permission.ts` existed (Bug #196 completed the helper). Hardcoded gates created drift between admin-facing matrix UI and actual access control. User directive 2026-06-10: matrix must be the actual source of truth ("if i toggle on the confirm payment to any staff, it should be working").
- **Fix:** All 5 functions migrated to `checkPermission(supabase, user.id, "<permission_key>")` pattern. Matrix UI now drives actual access for these operations.
- **Permission key mapping:**
  - `create-layaway-account` → `create_account`
  - `create-cash-order` → `create_cash_order` (already in matrix UI per Bug #197)
  - `delete-account` → `delete_account`
  - `restructure-account` → `edit_account` (first real consumer of this previously-ghost permission)
  - `carry-over` → `edit_schedule` (carry-over modifies layaway_schedule rows)
- **DB pre-fix applied 2026-06-10 (pre-deploy):** `UPDATE role_permissions SET is_allowed = false WHERE permission_key = 'edit_account' AND role = 'staff'`. Established admin-only default for edit_account per user policy directive. Tightens restructure-account from prior admin+staff to admin-only via matrix-driven gate. Zero operational impact at deploy time — restructure-account has no UI callers today (orphan function).
- **Files:** 5 edge functions in `supabase/functions/`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Net code change:** −15 LOC per function avg (Promise.all blocks collapsed to single checkPermission call).
- **Verification:**
  - All 5 functions reachable via curl smoke test returning 401 (function exists + auth gate working)
  - Admin retains access (admin bypass in checkPermission)
  - Staff/finance/csr access controlled by current role_permissions DB rows; admin can adjust via Settings → Permissions matrix
- **Net effect on existing users:**
  - create-layaway-account / create-cash-order: previously code blocked finance role despite DB rows saying finance=true. Migration now respects DB seed — finance gains create access. If unintended, admin toggles finance=false in matrix for these keys.
  - delete-account: behavior preserved (DB admin-only matches old code admin-only).
  - restructure-account: tightens to admin-only (was admin+staff). No operational impact since function has no UI callers; future use will respect matrix.
  - carry-over: behavior preserved (DB edit_schedule admin-only matches old code admin-only).
- **Known follow-up:** Bug #200 — UI gate audit. EditAccountDialog at AccountDetail.tsx L1040 is misgated by `isAdmin && can('edit_invoice')` and should use `can('edit_account')`. Similar UI gate audits likely needed elsewhere. Until Bug #200 fixes the L1040 misgating, toggling `edit_account` in matrix only affects the (orphan) restructure-account function.
- **Related:** Item 4 Batch A of Phase 2 (Bug #192/#193/#196/#197 sibling work). Batch B (payment writes) and Batch C (cash + schedule) and Batch D (loyalty) and Batch E (admin/finance + dashboard) follow. system-health-v2 (parseJwtClaims target) and set-portal-pin (customer-facing semantics) remain as Batch F special cases.

### Bug #200 — UI gate audit: matrix permissions misgated or unused in src/ components (open)

- **Symptom:** Multiple UI surfaces use incorrect permission keys, hardcode `isAdmin &&` checks, or skip permission gating entirely — creating drift between the role_permissions matrix UI in admin Settings and actual UI access. Toggling a permission in the matrix may have no effect on the UI feature it should control.
- **Known instances:**
  - `src/pages/AccountDetail.tsx` L1040: `<EditAccountDialog>` gated by `{isAdmin && can('edit_invoice') && (` — should use `can('edit_account')`. The dialog edits account-level fields (total_amount, order_date, downpayment, currency, notes, payment_plan_months) and schedule rows, NOT invoice number. The `isAdmin &&` prefix locks out staff entirely even when DB matrix grants edit_account.
  - Inline invoice pencil button at L920-936 may also have unclear gating semantics — needs audit.
  - Other UI components likely have similar misgating patterns — comprehensive grep audit needed.
- **Required next steps before fix:**
  1. Comprehensive grep audit: every `can('<key>')`, `isAdmin`, `hasPermission`, and `roles.includes(...)` call site in src/
  2. For each: verify the gate uses the correct semantic permission key
  3. Remove redundant `isAdmin &&` prefixes (admin bypass already in checkPermission and useAuth.can helpers)
  4. Verify gated UI surface matches what the permission name describes
  5. Cross-reference with PermissionMatrixTab matrix entries
- **Scope note:** UI-only audit, no edge function changes (those are Phase 2 Item 4's edge function batches). Should be addressed after Phase 2 Item 4 completes OR in parallel as a UI-focused side workstream.
- **Status:** Documented during Bug #199 (Batch A) closure when EditAccountDialog misgating was discovered during gate investigation. Defer to dedicated UI audit session.

### Bug #201 — Phase 2 Batch B: 5 payment write edge functions migrated to checkPermission (2026-06-11) ✅

- **Symptom:** Five payment-write edge functions (record-payment, record-multi-payment, void-payment, restore-payment, accept-underpayment) used hardcoded `supabase.rpc("has_role", {...})` checks that ignored the role_permissions matrix UI in admin Settings. For record-payment/record-multi-payment the role check was a flag controlling auto-confirm path (not a hard gate); for the others it was a 403 gate.
- **Root cause:** Same as Bug #199 — pre-checkPermission era pattern from before Bug #196 shipped the `_shared/check-permission.ts` helper. Matrix UI toggles for record_payment/confirm_payment/void_payment/restore_payment had no effect on edge function behavior.
- **Fix:** All 5 functions migrated to `checkPermission(supabase, userId, "<permission_key>")` pattern. Gate-vs-flag structure preserved (record-payment/record-multi-payment keep their canConfirm flag semantics; void/restore/accept stay as hard gates).
- **Permission key mapping:**
  - `record-payment` canConfirm flag → `confirm_payment`
  - `record-multi-payment` canConfirm flag → `confirm_payment`
  - `void-payment` gate → `void_payment`
  - `restore-payment` gate → `restore_payment`
  - `accept-underpayment` gate → `confirm_payment` (no dedicated accept_underpayment key exists; semantic match — acknowledging payment shortfall)
- **Files:** 5 edge functions in `supabase/functions/`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Net code change:** −5 LOC per function avg (Promise.all blocks collapsed to single checkPermission call).
- **Verification:**
  - All 5 functions reachable via curl smoke test returning 401 (function exists + auth gate working)
  - Admin retains access (admin bypass in checkPermission)
  - Other roles controlled by current role_permissions DB rows; admin can adjust via Settings → Permissions matrix
- **Net effect on existing users (per user directive — DB matrix is source of truth, no pre-fix UPDATEs applied):**
  - `record-payment` / `record-multi-payment` canConfirm: was admin+finance auto-confirm. Now admin+staff+finance auto-confirm (staff GAINS auto-confirm capability — matches DB confirm_payment=true for staff, user confirmed intent). Eliminates pending-review workflow for staff-recorded payments.
  - `void-payment`: behavior preserved (admin+finance, matches DB).
  - `restore-payment`: behavior preserved (admin+finance, matches DB).
  - `accept-underpayment`: was admin-only. Now admin+staff+finance per matrix confirm_payment. Staff/finance GAIN ability to acknowledge underpayments (audit-log-only, no row changes). User confirmed intent: "can accept if granted and toggle on the matrix by member."
- **Related:** Item 4 Batch B of Phase 2 (Bug #199 sibling work — Batch A account lifecycle). Bug #200 UI gate audit remains open (separate scope). Batches C (cash + schedule, 7 functions), D (loyalty, 4 functions), E (admin/finance + dashboard, 5 functions), F (system-health-v2 + set-portal-pin, 2 special cases) remain.

### Bug #202 — Phase 2 Batch C: 6 cash payment + schedule edit functions migrated + 2 new cash permission keys (2026-06-11) ✅

- **Symptom:** Six edge functions (void-cash-payment, restore-cash-payment, add-installment, delete-installment, extend-schedule, edit-payment-amount) used hardcoded `supabase.rpc("has_role", {...})` checks ignoring the role_permissions matrix UI. Cash payment void/restore were admin-only by design but shared no dedicated permission key. Schedule edits were admin-only with no matrix surface. Payment amount edits were admin+finance hardcoded.
- **Root cause:** Same pre-checkPermission era pattern as Bug #199 / #201. Cash payment functions were stricter than regular payments per business design ("Admin only — staff/finance cannot void") but had no separate permission key.
- **Fix:**
  - 6 functions migrated to `checkPermission(supabase, user.id, "<permission_key>")` pattern.
  - 2 NEW permission keys created in role_permissions table (admin-only seed): `void_cash_payment`, `restore_cash_payment`. Both added to PermissionMatrixTab UI under new "Cash Payments" section.
- **Permission key mapping:**
  - `void-cash-payment` → NEW `void_cash_payment` (admin-only, independently controllable from regular void_payment)
  - `restore-cash-payment` → NEW `restore_cash_payment` (admin-only, independently controllable)
  - `add-installment` → `edit_schedule`
  - `delete-installment` → `edit_schedule`
  - `extend-schedule` → `edit_schedule`
  - `edit-payment-amount` → `void_payment` (reuse — post-creation payment modification, semantically similar to void)
- **DB pre-fix applied 2026-06-11 (pre-deploy):**

```sql
  INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
    ('admin', 'void_cash_payment', true), ('staff', 'void_cash_payment', false),
    ('finance', 'void_cash_payment', false), ('csr', 'void_cash_payment', false),
    ('admin', 'restore_cash_payment', true), ('staff', 'restore_cash_payment', false),
    ('finance', 'restore_cash_payment', false), ('csr', 'restore_cash_payment', false);
```

- **Files:** 6 edge functions in `supabase/functions/`, `src/components/settings/PermissionMatrixTab.tsx`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Verification:**
  - All 6 functions reachable via curl smoke test returning 401
  - Admin retains access (admin bypass in checkPermission)
  - Cash payment keys independently toggleable from regular payment keys
- **Net effect on existing users:**
  - void-cash-payment / restore-cash-payment: behavior preserved (admin-only). Independent control from regular void_payment / restore_payment via separate matrix keys.
  - add-installment / delete-installment / extend-schedule: behavior preserved (admin-only — matches edit_schedule DB seed from Batch A pre-fix).
  - edit-payment-amount: behavior preserved (admin+finance — matches void_payment DB seed).
- **submit-cash-payment NOT migrated in Batch C** — dual-path function (Path A customer portal, Path B staff Bearer JWT). `has_role` check discriminates between staff and customer JWT, not a permission gate. Moved to Batch F special cases alongside set-portal-pin for careful refactor.
- **Related:** Item 4 Batch C of Phase 2 (Bug #199/#201 sibling work). Bug #200 UI gate audit remains open. Batches D (loyalty, 4 functions), E (admin/finance + dashboard, 5 functions), F (system-health-v2 + set-portal-pin + submit-cash-payment, 3 special cases) remain.

### Bug #203 — Phase 2 Batch D: 4 loyalty admin edge functions migrated + 1 new permission key + matrix UI surface (2026-06-11) ✅

- **Symptom:** Four loyalty admin edge functions (adjust-loyalty-points, award-loyalty-points, revoke-loyalty-points, restore-loyalty-points) used hardcoded `supabase.rpc("has_role", {...})` checks ignoring the role_permissions matrix UI. Matrix toggling had no effect on manual loyalty operations.
- **Root cause:** Same pre-checkPermission era pattern as Bug #199/#201/#202. Three of four functions (award/revoke/restore) have dual-auth (service_role inter-function calls + user JWT manual operations) — only the user JWT path uses has_role.
- **Fix:** All 4 functions migrated; dual-auth structure preserved. Service_role inter-function calls unchanged (parseJwtClaims branch); user JWT path now uses checkPermission. 1 new permission key (`loyalty_revoke_points`) introduced to preserve current admin-only design for revoke/restore (vs admin+finance for adjust/award).
- **Permission key mapping:**
  - `adjust-loyalty-points` → `loyalty_adjust_points` (existed in DB, admin+finance) ✅
  - `award-loyalty-points` user JWT path → `loyalty_adjust_points` (same key — both adjust/award are admin+finance)
  - `revoke-loyalty-points` user JWT path → NEW `loyalty_revoke_points` (admin-only seed)
  - `restore-loyalty-points` user JWT path → NEW `loyalty_revoke_points` (same key — both revoke/restore are admin-only)
- **DB pre-fix applied 2026-06-11 (pre-deploy):**

```sql
  INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
    ('admin', 'loyalty_revoke_points', true), ('staff', 'loyalty_revoke_points', false),
    ('finance', 'loyalty_revoke_points', false), ('csr', 'loyalty_revoke_points', false);
```

- **Files:** 4 edge functions in `supabase/functions/`, `src/components/settings/PermissionMatrixTab.tsx`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Matrix UI additions:** `loyalty_adjust_points` and `loyalty_revoke_points` added to Loyalty module under new "Loyalty Admin" section. Partially closes Bug #198 (2 of 11 missing keys now surfaced).
- **Verification:**
  - All 4 functions reachable via curl smoke test returning 401
  - Admin retains access (admin bypass in checkPermission)
  - Service_role inter-function calls unchanged (no regression on automated loyalty operations from payment voids/forfeitures/reactivations)
  - Admin can independently toggle adjust vs revoke capabilities via matrix
- **Net effect on existing users:**
  - adjust-loyalty-points / award-loyalty-points user JWT: behavior preserved (admin+finance, matches DB).
  - revoke-loyalty-points / restore-loyalty-points user JWT: behavior preserved (admin-only, matches DB).
  - Service_role automated paths: unchanged.
- **Related:** Item 4 Batch D of Phase 2 (Bug #199/#201/#202 sibling work). Partially closes Bug #198 (matrix UI / DB drift). Batches E (admin/finance + dashboard, 5 functions), F (system-health-v2 + set-portal-pin + submit-cash-payment, 3 special cases) remain.

### Bug #204 — Phase 2 Batch E: 5 edge functions migrated + 2 new matrix UI keys + 2 existing key seed cleanups (2026-06-11) ✅

- **Symptom:** Five edge functions (bulk-import, finance-reconciliation, generate-invoice, add-service, dashboard-summary) used hardcoded `supabase.rpc("has_role", {...})` checks ignoring the role_permissions matrix UI. Two of the functions (bulk-import, finance-reconciliation) had dual-auth — only the user JWT path used has_role.
- **Root cause:** Same pre-checkPermission era pattern as Bug #199/#201/#202/#203.
- **Fix:** All 5 functions migrated; dual-auth structure preserved in the two with service_role inter-function call paths. Two existing matrix UI keys reused (`bulk_payment_import`, `add_service`) — DB seeds corrected to match Cynthia's stated intent and current code behavior. Two new matrix UI keys introduced (`run_reconciliation`, `generate_invoice`).
- **Permission key mapping:**
  - `bulk-import` user JWT path → existing `bulk_payment_import` (admin+staff; matrix UI label "Bulk Payment Import" at Finance → Vault & Bulk Import section)
  - `finance-reconciliation` user JWT path → NEW `run_reconciliation` (admin+finance; previously partial-seeded in DB but missing from matrix UI — partially closes Bug #198)
  - `generate-invoice` → NEW `generate_invoice` (admin+staff+finance; net new key)
  - `add-service` → existing `add_service` (admin only; matrix UI label "Manage Services" at Services module)
  - `dashboard-summary` → existing `view_dashboard` (all 4 roles=true; matrix UI label "View Dashboard" at Dashboard module)
- **DB cleanup applied 2026-06-11 (pre-deploy, after initial pre-fix produced 2 orphan keys):**

```sql
  -- 1. DELETE orphan keys created in error during initial pre-fix (bulk_import × 4 + manage_services × 4)
  DELETE FROM public.role_permissions
  WHERE permission_key IN ('bulk_import', 'manage_services');

  -- 2. UPDATE add_service: tighten staff to false (admin-only intent)
  UPDATE public.role_permissions SET is_allowed = false
  WHERE permission_key = 'add_service' AND role = 'staff';

  -- 3. UPDATE bulk_payment_import: tighten finance to false (admin+staff intent)
  UPDATE public.role_permissions SET is_allowed = false
  WHERE permission_key = 'bulk_payment_import' AND role = 'finance';

  -- 4. INSERT missing bulk_payment_import rows (staff=true, csr=false)
  INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
    ('staff', 'bulk_payment_import', true),
    ('csr',   'bulk_payment_import', false);
```

  Plus the initial pre-fix that introduced `run_reconciliation` (already partially seeded, finance updated false → true) and `generate_invoice` (4 new rows).
- **Process note:** During initial pre-fix the matrix UI taxonomy was not grepped before proposing key names. This led to 2 orphan keys being created in DB (`bulk_import`, `manage_services`) that paralleled the existing UI keys (`bulk_payment_import`, `add_service`). Orphans were DELETEd; existing keys were UPSERTed to correct seeds. SOP refinement for future batches: grep matrix UI taxonomy FIRST, then edge function code, then cross-reference before proposing any new keys.
- **Files:** 5 edge functions in `supabase/functions/`, `src/components/settings/PermissionMatrixTab.tsx`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Matrix UI additions:** `run_reconciliation` (label "Run Finance Reconciliation") and `generate_invoice` (label "Generate Invoice") appended to Finance module under new "Reconciliation & Invoicing" section.
- **Verification:**
  - All 5 functions reachable via curl smoke test returning 401
  - Admin retains access (admin bypass in checkPermission)
  - Service_role inter-function calls unchanged (no regression on Vault cron triggering finance-reconciliation; no regression on automated bulk-import flows)
- **Net effect on existing users:**
  - bulk-import: admin+staff preserved (no change)
  - finance-reconciliation: admin+finance preserved (no change — UPDATE finance=true reflected intent)
  - generate-invoice: admin+finance+staff preserved (no change)
  - add-service: admin-only preserved (UPDATE staff=false reflected intent)
  - dashboard-summary: all 4 staff roles preserved (view_dashboard all roles=true)
- **Related:** Item 4 Batch E of Phase 2 (Bug #199/#201/#202/#203 sibling work). Partially closes Bug #198 (1 of 9 missing keys now surfaced — `run_reconciliation`). Batch F (system-health-v2 + set-portal-pin + submit-cash-payment, 3 special cases) remains.

### Bug #205 — Phase 2 Batch F COMPLETE: 3 special-case functions migrated + Bug #168 fully closed (2026-06-11) ✅

- **Symptom:** Three remaining edge functions held nonstandard auth patterns: (1) system-health-v2 used the prohibited string equality auth pattern (Bug #168) AND 4x has_role calls; (2) set-portal-pin used standard 2x has_role admin+staff gate; (3) submit-cash-payment used 3x has_role for PATH DISCRIMINATION (not access gating) between customer flow and staff direct-entry flow.
- **Root cause:** Same pre-checkPermission era patterns. system-health-v2 was an explicit known gap per Bug #168 (kept dual-gated when initial sweep happened). submit-cash-payment's pattern was always recognized as dispatch-not-access-gate, deferred to dedicated batch.
- **Fix:**
  - **system-health-v2:** Two independent fixes in one batch. (1) Bug #168 string equality `authToken === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` replaced with `parseJwtClaims(authToken)?.role === "service_role"`. (2) 4x has_role admin/staff/finance/csr collapsed to `checkPermission(supabaseGate, user.id, "system_health")` — service_role inter-function/cron path unchanged via parseJwtClaims branch.
  - **set-portal-pin:** Standard 2x has_role → `checkPermission(supabase, user.id, "set_customer_pin")` migration. NEW permission key introduced (admin+staff seed) for clean security separation from general `edit_customer` permission (since PIN management is more sensitive than profile editing).
  - **submit-cash-payment:** Refactored 3x has_role dispatch logic to `checkPermission(supabase, user.id, "submit_cash_payment_staff")`. This is Option 2 from investigation — preserves matrix-driven design philosophy by making PATH DISPATCH matrix-controllable. NEW permission key (admin+staff+finance seed, csr=false) — matches current dispatch behavior exactly.
- **Permission key mapping:**
  - `system-health-v2` user JWT path → existing `system_health` (DB seed updated to all 4 roles=true to preserve current any-of-4-staff behavior; previously DB had admin+staff only)
  - `set-portal-pin` → NEW `set_customer_pin` (admin+staff seed)
  - `submit-cash-payment` Path B dispatch → NEW `submit_cash_payment_staff` (admin+staff+finance seed, csr=false)
- **DB pre-fix applied 2026-06-11 (pre-deploy):**

```sql
  -- 1. UPDATE system_health: expand finance + csr to true (preserve any-of-4-staff current behavior)
  UPDATE public.role_permissions SET is_allowed = true
  WHERE permission_key = 'system_health' AND role IN ('finance', 'csr');
  -- 2. INSERT set_customer_pin (admin+staff seed)
  INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
    ('admin', 'set_customer_pin', true), ('staff', 'set_customer_pin', true),
    ('finance', 'set_customer_pin', false), ('csr', 'set_customer_pin', false);
  -- 3. INSERT submit_cash_payment_staff (admin+staff+finance seed)
  INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
    ('admin', 'submit_cash_payment_staff', true), ('staff', 'submit_cash_payment_staff', true),
    ('finance', 'submit_cash_payment_staff', true), ('csr', 'submit_cash_payment_staff', false);
```

- **Files:** 3 edge functions in `supabase/functions/`, `src/components/settings/PermissionMatrixTab.tsx`, `docs/FIXED-BUGS.md`, `docs/SYSTEM-STATUS.md`.
- **Matrix UI additions:** `set_customer_pin` (label "Set Customer Portal PIN") under Customers module new "Portal Security" section; `submit_cash_payment_staff` (label "Submit Cash Payment (Staff Direct Entry)") appended to Sales module Cash Payments section.
- **Bug #168 fully closed:** system-health-v2 was the last remaining function carrying the prohibited string equality auth pattern. With this Batch F fix, ALL edge functions now use either `parseJwtClaims` (service_role detection) or `checkPermission` (user permission gates). Zero remaining string-equality auth checks against `SUPABASE_SERVICE_ROLE_KEY` across the codebase.
- **Verification:**
  - All 3 functions reachable via curl smoke test returning 401
  - Admin retains access (admin bypass in checkPermission)
  - Service_role inter-function/cron paths unchanged in system-health-v2 (parseJwtClaims branch)
  - submit-cash-payment Path A (customer portal) unaffected — has_role dispatch only fired on Bearer JWT path
- **Net effect on existing users:**
  - system-health-v2: all 4 staff roles preserved (no change — DB seed updated to match)
  - set-portal-pin: admin+staff preserved (no change)
  - submit-cash-payment: admin+staff+finance get Path B; csr gets Path A; customer JWT/portal_token/session_id get Path A (no change)
- **Related:** Item 4 Batch F of Phase 2 (Bug #199/#201/#202/#203/#204 sibling work). Fully closes Bug #168. Phase 2 Item 4 NOW COMPLETE — all 28 staff-facing edge functions migrated from hardcoded has_role to matrix-driven checkPermission, with service_role inter-function paths preserved unchanged via parseJwtClaims.

### Bug #206 — confirm_payment staff seed bypassed payment_submissions queue (regression from Bug #201 Batch B) (2026-06-11) ✅

**Severity:** P1 — production data integrity / audit trail gap
**Discovered:** 2026-06-11 by Cynthia during routine review
**Reporter:** Cynthia
**Status:** ✅ FIXED 2026-06-11

#### Symptom
Staff record-payment and record-multi-payment entries landed directly in payments table without creating payment_submissions row. Bypassed admin/finance review queue. Confirmed cases: accounts 18664 (¥19,131, 2026-06-11 03:32 UTC) and 18010 (¥18,660, 2026-06-11 02:46 UTC), both entered by staff user 69095b5d.

#### Root cause
Bug #201 Batch B (commit 8d06b8d, 2026-06-XX) made confirm_payment matrix-driven with seed admin=t, staff=t, finance=t, csr=f. The `canConfirm` flag in both record-payment (L112) and record-multi-payment (L50) calls `checkPermission(supabase, user.id, "confirm_payment")` which now returns true for staff. Both functions branch on canConfirm:
- canConfirm=true → direct insert into payments table (auto-confirmed)
- canConfirm=false → insert into payment_submissions with status='submitted' (review queue)

Pre-Batch-B behavior had `has_role` check for `[isAdmin, isFinance]` only — staff naturally hit the submission-queue branch. Batch B granted staff canConfirm=true based on Cynthia's confirmation "staff can do all of these" (Q1), which was interpreted as auto-confirm permission rather than function access only.

#### Fix
Single matrix UI toggle: confirm_payment.staff = false. SQL equivalent:
```sql
UPDATE public.role_permissions SET is_allowed = false
WHERE permission_key = 'confirm_payment' AND role = 'staff';
```

No code change. Both record-payment and record-multi-payment now correctly route staff entries to payment_submissions queue.

#### Verification
- 2026-06-11: Matrix UI toggle applied — `confirm_payment.staff = false`. Final policy state: admin=true, staff=false, finance=true, csr=false.
- DB state verified via `SELECT permission_key, role, is_allowed FROM role_permissions WHERE permission_key='confirm_payment'`.
- Design rationale (LOCKED): admin + finance keep auto-confirm because they ARE the review authority — finance owns this function. Staff bypass intentionally removed. Do not propose toggling admin/finance to false in future sessions.

#### Retroactive treatment
Two staff-bypassed payments detected during incident triage. Both audit trails recovered via SQL:

1. **Account 18664** (¥19,131, payment id `5f6d2d04`, staff user `69095b5d`, 2026-06-11 03:32 UTC) — INSERT-ed new `payment_submissions` row `e874eade` linking to the staff payment with proof file `BrendalynBumagat_18664_Month3_2026-06-11_mq8xznsu.jpg`.

2. **Account 18010** (¥18,660, payment id `67e4133b`, staff user `69095b5d`, 2026-06-11 02:46 UTC) — Restored the parallel cancelled customer-portal submission `33e0dda9` to `status='confirmed'` and linked it to the staff payment.

3. **Side cleanup (pre-existing drift, not caused by the bypass):** May 11 submission `#73087cec` for 18664 had its `proof_url` incorrectly pointing at the June 11 file. Updated to point at the actual May 11 file `MariaCrisdeGuzman_18664_Month2_2026-05-11.jpg` (recovered from storage history).

Both June 11 payments now visible in account payment history with View Proof button and in Proof of Payments page.

#### Lessons / SOP reinforcement
- When user says a role "can do" a function, ask specifically about workflow side-effects (auto-confirm, queue bypass, etc.). "Access to function" ≠ "auto-confirm permission." Two separate semantic layers.
- Matrix-driven design = DB seed is source of truth, matrix UI is control surface, edge function enforces via `checkPermission`. All three layers must align with intended workflow semantics.
- Storage `proof_url` drift can occur — files exist but referenced URLs can become stale. Worth auditing across submissions in a future cleanup pass.

#### Reclassification (2026-06-11) — MISDIAGNOSIS, REVERTED

**Updated status: Bug #206 fix REVERTED 2026-06-11 ~08:19 UTC.**

The initial fix (matrix seed staff.confirm_payment=false) broke legitimate staff workflow that had been operating successfully for 3 days pre-Batch-A-F. Brenda Bumagat and Bogart Antonette could no longer confirm customer payment submissions, halting daily operations.

**What was actually happening (re-analysis):**
- Pre-Batch-A-F: Staff legitimately used Record Payment to log cash drop-offs and external rakuten payments (e.g., 18664 ¥19,131, 18010 ¥18,660) — these were NOT customer portal submissions, so direct payments-table inserts were the documented path
- Staff ALSO legitimately confirmed customer-submitted payments via Confirm flow — also a valid path
- The "bypass" framing in the original Bug #206 root cause was a misdiagnosis. Direct payment entry by staff is not a queue bypass; it's the documented path for non-portal payments.

**Reversion SQL:**

```sql
UPDATE public.role_permissions
SET is_allowed = true
WHERE permission_key = 'confirm_payment' AND role = 'staff';
```

**Updated locked matrix:**

| Role | confirm_payment |
|------|----------------|
| admin | true |
| staff | **true (restored 2026-06-11)** |
| finance | true |
| csr | false |

**Memory update:** Earlier instructions to "do not propose toggling admin/finance OFF and do not question this seed in future sessions" are SUPERSEDED. The matrix is what it is; staff CAN confirm payments — this is the working design.

**Related operational cleanups:** 4 phantom payment entries were cleared via manual SQL during this incident — see `docs/SYSTEM-STATUS.md` "Operational Cleanups Log" entry for 2026-06-11. All were duplicate-entry artifacts from one staff user manually recording payments before the matching customer submission was confirmed (workflow misunderstanding, not a code bug).

**Outstanding follow-up:**
- Bug #208 (graceful 403 handling) remains valid — protects future scenarios where a role IS genuinely denied
- Brenda coaching message planned (Taglish, sent separately) to prevent further phantom duplicates

### Bug #208 — Graceful 403 handling on staff-side payment confirm UI (2026-06-11) ✅

**Severity:** P1 — Staff confirmation flow surfaced generic error toast; modal stayed open; Lovable monitoring flagged has_blank_screen=true
**Discovered:** 2026-06-11 during Bug #206 Batch F deploy fallout
**Reporter:** Cynthia
**Status:** ✅ FIXED 2026-06-11 (v1 commit `f043910` deployed past security gate manually; v2 commit `777ac14` pushed but NOT deployed — defense-in-depth for future scenarios)

#### Symptom
When staff attempted to confirm a customer payment submission via PaymentSubmissions page and lacked permission (post-Bug-#206 Batch F migration where staff.confirm_payment was briefly set to false), the edge function correctly returned 403 with `{ error: "Access denied" }` body — but the frontend displayed a generic "Edge Function returned a non-2xx status code" toast. Confirmation modal remained open. No graceful indicator that the action was permission-blocked vs a system error. Lovable monitoring flagged `has_blank_screen: true`.

#### Root cause
supabase-js wraps non-2xx edge function responses with `data=null` and the real error inside `error.context` (Response object). PaymentSubmissions.tsx `reviewMutation` handler threw based on `error` presence before checking `data?.error`, swallowing the structured `{ error: "..." }` body. The `onError` handler then matched only the generic wrapper message, not actual permission-denial keywords.

#### Fix v1 — commit `f043910` (deployed)
src/pages/PaymentSubmissions.tsx (reviewMutation + onError):
- Swap throw order in mutationFn so `data?.error` is checked before `error`
- onError: check `isPermissionError` via message keywords (`'access denied'` / `'permission'` / `'forbidden'`)
- Permission toast shows "Permission denied — contact admin"; modal closes
- Manually published past Lovable's security gate (9 critical + 11 warnings — 3 are real bugs deferred to next session)

#### Fix v2 — commit `777ac14` (pushed, not deployed; defense-in-depth)
Same file, two enhancements:
- mutationFn Path 2: when `error` is set, attempt `ctx.clone().json()` to extract `body.error`, throw enriched error with `.status = ctx.status` attached
- onError: read `status = err?.status ?? err?.context?.status`, prepend `status === 403 ||` to isPermissionError chain
- Result: 403 handled gracefully regardless of body content

v2 is dormant in production. With Bug #206 reclassification (staff.confirm_payment reverted to true), no current staff hits the 403 path. v2 will deploy with next natural prod push.

#### Verification
- v1: Brenda + Bogart confirmed payment submission successfully post-revert (visual confirmation 2026-06-11)
- v2: Pushed to main, awaiting natural deploy

#### Related
Bug #206 (matrix policy revert, reclassified as misdiagnosis); Bug #199/#201 Batches A-F (matrix migration that exposed this gap)

### Bug #209 — edit_schedule.finance matrix gap blocking underpayment carry-over (2026-06-11) ✅

**Severity:** P2 — workflow gap; finance role could confirm payment but couldn't complete carry-over step
**Discovered:** 2026-06-11 during Bug #206 work
**Reporter:** Cynthia
**Status:** ✅ FIXED 2026-06-11 (SQL UPDATE)

#### Symptom
Finance role users could call `confirm_payment` (Bug #206 Batch B migration granted them confirm rights) but the `carry-over` edge function (which finalizes underpayments by adjusting schedule) was gated by `edit_schedule` permission. The role_permissions seed for `edit_schedule` had finance=false. Result: finance could confirm an underpayment but hit 403 when attempting the follow-up carry-over.

#### Root cause
Bug #199/#201 Batches A-F migrated all staff-facing edge functions to matrix-driven `checkPermission`. The `edit_schedule` permission key seed had finance defaulted to `false`. The confirmation + carry-over flow spans two permission keys; the finance seed wasn't aligned across both.

#### Fix
SQL UPDATE in Supabase SQL Editor:

```sql
UPDATE public.role_permissions
SET is_allowed = true
WHERE permission_key = 'edit_schedule' AND role = 'finance';
```

Single row updated. No code change. The `carry-over` edge function correctly enforces the gate — the seed value was the gap.

#### Verification
Finance role completed carry-over flow on test underpayment scenario (2026-06-11). Workflow restored.

#### Related
Bug #206 (concurrent matrix policy work); Bug #199/#201 Batches A-F (migration that introduced this gap); Bug #168 (matrix-driven auth pattern)

### Bug #207 — Payment Proofs and Waivers search bars disconnected from PaymentsHub top-level search (2026-06-11) ✅

**Severity:** P2 — UX broken, search filter not propagated across all tabs
**Discovered:** 2026-06-11 by Cynthia during Bug #206 incident triage
**Reporter:** Cynthia
**Status:** ✅ FIXED 2026-06-11 (commit `8854787`)

#### Symptom
PaymentsHub (Sales page) hosts 3 tabs: Submissions, Proof of Payment, Waivers. Top-level search bar value was supposed to filter all 3 tabs in sync. In practice, the top bar only filtered the Submissions tab — Proof of Payment and Waivers ignored it. Users typing "18010" or "Brendalyn" in the top bar saw no result changes in Proof of Payment, leading to the impression the entire search was broken.

#### Root cause
Three layered issues in PaymentsHub.tsx and PaymentProofs.tsx:
- PaymentsHub L104: `<PaymentSubmissions embedded searchValue={search} />` — wired correctly ✓
- PaymentsHub L108: `<PaymentProofs embedded />` — `searchValue` NOT passed ✗
- PaymentsHub L112: `<Waivers embedded />` — `search` NOT passed ✗ (Waivers accepts the prop with default `''`, just never received it)
- PaymentProofs component did not declare or use a `searchValue` prop at all — only listened to its own redundant inline `<ProofsSearchBar>`.

#### Fix
Commit `8854787` (push only, frontend-only, no edge functions affected). Two files modified:

1. `src/pages/PaymentsHub.tsx`
   - L108: `<PaymentProofs embedded />` → `<PaymentProofs embedded searchValue={search} />`
   - L112: `<Waivers embedded />` → `<Waivers embedded search={search} />`

2. `src/pages/PaymentProofs.tsx`
   - Added `useEffect` to React imports.
   - Extended component signature: `({ embedded = false, searchValue }: { embedded?: boolean; searchValue?: string } = {})`.
   - Added `useEffect` to mirror parent-supplied `searchValue` into `searchRef.current` and bump `filterTick` (triggers existing useMemo).
   - Wrapped inline `<ProofsSearchBar onSearch={handleSearch} />` in `{!embedded && (...)}` to suppress the redundant inline search when embedded inside PaymentsHub.

#### Verification
- Top search bar on Sales page now filters all 3 tabs in sync after Firebase Hosting auto-deploy.
- Inside PaymentsHub, the redundant right-side ProofsSearchBar is no longer rendered.
- Direct route to PaymentProofs (non-embedded standalone) continues to render its inline search bar correctly.

#### Lessons / SOP reinforcement
- Prop name inconsistency exists (PaymentSubmissions uses `searchValue`, Waivers uses `search`). Refactor for consistency would be a future ticket.
- When child components carry their own search inputs AND a parent provides a top-level search, hide the child inputs when embedded so there is one clear control surface.
- Frontend prop disconnects fail silently — users perceive "broken search" when in fact the prop wiring is the gap. Worth a broader audit on other tabbed surfaces.

### Bug #210 — `carry-over` edge function gated on `edit_schedule` broke staff confirm→carry flow (2026-06-11) ✅

**Severity:** P1 — staff could confirm an underpayment but hit 403 on the follow-up carry-over step. Bug #209 fixed it for finance via DB seed; staff hit the same gap because Bug #199 Batch A mapped `carry-over` to `edit_schedule` (admin-only seed).
**Discovered:** 2026-06-11 by Cynthia during Bug #206/#209 reclassification work.
**Reporter:** Cynthia.
**Status:** ✅ FIXED 2026-06-11.

#### Symptom
Staff confirmed a partial payment (`confirm_payment` allowed per matrix), then clicked Carry Over to push the shortfall to the next installment. Carry-over edge function returned 403 `"edit_schedule permission required"`. The confirm and carry steps are conceptually one workflow but were gated by two different permission keys.

#### Root cause
`carry-over` was migrated in Bug #199 Batch A using `edit_schedule` as its permission key alongside `add-installment` / `delete-installment` / `extend-schedule`. Those three legitimately modify schedule structure (admin-only). Carry-over only adjusts the partial-paid amount on an existing row — semantically it's the closing step of a payment confirm, not schedule editing. The mismatch broke the staff flow that worked pre-Batch-A-F.

#### Fix
`supabase/functions/carry-over/index.ts` L35-L37:
- `checkPermission(..., "edit_schedule")` → `checkPermission(..., "confirm_payment")`
- Error string updated accordingly.

`add-installment`, `delete-installment`, `extend-schedule` remain on `edit_schedule` — they truly are schedule edits.

`CLAUDE.md` CARRY-OVER RULES section updated: "Bearer token + admin role required" → "Bearer token + confirm_payment permission via checkPermission (matrix-driven; overrides respected)".

#### Verification
Pending deploy. Staff with `confirm_payment=true` will complete the full confirm→carry flow without a second permission check.

#### Related
Bug #199 Batch A (migration that introduced the mismatch); Bug #209 (parallel finance fix via DB seed); Bug #206 reclassification (broader matrix policy revert).

### Bug #211 — Permission refresh after matrix toggle unmounts the current page via ProtectedRoute spinner (2026-06-11) ✅

**Severity:** P1 — toggling any permission switch in Settings → Permissions caused the entire app shell to remount with a full-screen spinner. Made the matrix UI feel unstable; in some scenarios the toggle didn't appear to "stick" because the user navigated away mid-refresh.
**Discovered:** 2026-06-11 during Bug #206 work.
**Reporter:** Cynthia.
**Status:** ✅ FIXED 2026-06-11.

#### Symptom
After every successful permission write (role toggle, member override toggle, reset), `PermissionsProvider.fetchData()` ran with `setLoading(true)`, which flipped the context's `loading` flag. `ProtectedRoute` reads that flag and renders a full-screen spinner while loading — so the entire current page unmounted and remounted on every toggle.

#### Root cause
`src/contexts/PermissionsContext.tsx` `fetchData` set `setLoading(true)` unconditionally at the start. The same function powered both initial-load (where loading=true is correct — prevents stale-permission flashes on user switch) and post-toggle refresh (where loading=true is wrong — the page should stay mounted).

#### Fix
`fetchData` now accepts `{ silent?: boolean; retryCount?: number }`:
- Initial-load path (useEffect on auth ready) calls `fetchData()` — non-silent, current behavior preserved
- New `refresh` callback wraps `fetchData({ silent: true })` — skips both `setLoading(true)` and `setLoading(false)`, refetches in the background
- Context's `refresh` value now exposes the silent wrapper (was previously `refresh: fetchData` raw)

#### Verification
Pending deploy. Matrix toggles should update inline without remount; ProtectedRoute spinner should only appear on initial load or user switch.

#### Related
Bug #208 (Lovable `has_blank_screen` monitoring — this remount pattern likely contributed to that signal in some scenarios).

### Bug #212 — Member override toggle ambiguous OFF state (amber background read as "still on") (2026-06-11) ✅

**Severity:** P2 — UX clarity; users couldn't tell at a glance whether an override was ON or OFF because both states used amber backgrounds.
**Discovered:** 2026-06-11 by Cynthia during Bug #211 fix testing.
**Reporter:** Cynthia.
**Status:** ✅ FIXED 2026-06-11.

#### Symptom
On the Permission Matrix → By Member view, when a row had a custom override, the Switch used `data-[state=checked]:bg-amber-500` AND `data-[state=unchecked]:bg-amber-900/60`. Both states were amber. Without a clear off-track, users mistook OFF overrides for ON. Same row, two visually similar amber tones — confusing during a fast review.

Additionally, the success toast said "Permission updated for {name}" — gave no indication of WHICH permission changed or to what state.

#### Root cause
`src/components/settings/PermissionMatrixTab.tsx` MemberMatrix Switch className: the override style differentiated ON/OFF only by alpha (`bg-amber-500` vs `bg-amber-900/60`), not by color. Toast string was a constant, not parameterized on the permission/state.

#### Fix
(a) Switch className updated:
- Unchecked track: `bg-muted` (clearly off — matches the role-default off-state)
- Amber identity preserved via `ring-1 ring-amber-500/60` around the whole track (so "custom override" is still recognizable in both states)
- Checked track stays `bg-amber-500` for the ON-override signal

(b) Toast message now includes permission label + new state:
`${findPermissionLabel(key)}: ${newGranted ? 'Enabled' : 'Disabled'} (custom override) for ${selectedMember.full_name}`

A new `findPermissionLabel(key)` helper scans PERMISSION_MODULES — keeps `handleToggle` signature stable.

#### Verification
Pending deploy. OFF overrides will read as a muted grey track with an amber ring; toast will identify the exact permission and new state.

#### Related
Bug #211 (same file, same review session).

### Bug #213 — Multi-role members collapsed to single role in Permission Matrix UI (2026-06-11) ✅

**Severity:** P1 — the Permission Matrix By-Member view misrepresented multi-role users. Backend `checkPermission` correctly ORs across all of a user's role rows (Bug #196), but the Matrix UI showed only one role (last-write-wins on the roleMap) and computed role defaults from that single role. Admin toggling for, say, a staff+finance composite user couldn't see the actual effective permission set.
**Discovered:** 2026-06-11 by Cynthia during Bug #211/#212 work.
**Reporter:** Cynthia.
**Status:** ✅ FIXED 2026-06-11.

#### Symptom
`settings-team-members` query built `roleMap[r.user_id] = r.role` — last write wins. A user with two `user_roles` rows showed only one. `getRoleDefault(key)` then looked up a single role in `role_permissions`, producing wrong defaults for composite-role users. Backend OR semantics meant the user's actual effective permission could differ from what the matrix UI showed.

#### Root cause
`src/components/settings/PermissionMatrixTab.tsx`:
- `TeamMember` interface had `role: string` (singular)
- Query overwrote roleMap entries on duplicate user_id
- Dropdown showed `({m.role})` — single
- Role badge displayed a single badge
- `getRoleDefault` queried `role_permissions` with `p.role === selectedMember.role`

#### Fix
- `TeamMember.role: string` → `TeamMember.roles: string[]`
- Query aggregates: `roleMap[user_id]` becomes `string[]`, pushed-on-duplicate
- Dropdown option label: `({m.roles.join(', ')})` — e.g. `"Maria (staff, finance)"`
- Role badge: `selectedMember.roles.map(role => <Badge>...)` — one chip per role
- `getRoleDefault(key)` mirrors backend OR semantics: `selectedMember.roles.some(role => allPermissions.find(...)?.is_allowed ?? false)`
- `RoleMatrix` is unchanged — it operates on `role` strings (admin/staff/finance/csr), not `TeamMember`. No signature change needed.

#### Verification
Pending deploy. By-Member view will list each user once with all roles shown; the effective default tile will reflect the OR across all roles, matching what the edge functions enforce.

#### Related
Bug #196 (`_shared/check-permission.ts` multi-role fix — established the OR semantics this UI now mirrors).

### Bug #214 — `reconcile-account` edge function used coarse `is_staff` RPC instead of matrix-driven `run_reconciliation` key (2026-06-12) ✅

- **Symptom:** Toggling `run_reconciliation` in the Permission Matrix had no effect on who could actually invoke `reconcile-account`. The function gated on `supabase.rpc("is_staff", { _user_id: user.id })` — a coarse role check that bypassed the matrix entirely.
- **Root cause:** Pre-Phase 2 pattern that survived Batch A-F migrations because `reconcile-account` was treated as a read-only diagnostic and not surveyed for matrix migration. The `run_reconciliation` key already existed in `role_permissions` (admin=true, finance=true, staff=false, csr=false) but no edge function consumed it.
- **Fix:** Replaced the `is_staff` RPC check with `checkPermission(supabase, user.id, "run_reconciliation")`. Import of `../_shared/check-permission.ts` added. 403 body now reads `"run_reconciliation permission required"` so future debugging matches the matrix key by name.
- **Files:** `supabase/functions/reconcile-account/index.ts`.
- **DB changes:** none — `run_reconciliation` already seeded in `role_permissions`.
- **Net effect on existing users:** admin + finance retain access (matches existing seed); staff loses access (was implicitly granted via `is_staff` despite matrix saying staff=false). Admin can flip staff via matrix if needed.
- **Related:** Bug #199 Batch A pattern; Bug #210 (`carry-over` → `edit_schedule` matrix migration); Bug #168 (matrix-driven auth pattern).

### Bug #215 — `edit-schedule-item` edge function used coarse `is_staff` RPC instead of matrix-driven `edit_schedule` key (2026-06-12) ✅

- **Symptom:** Toggling `edit_schedule` in the Permission Matrix had no effect on who could actually invoke `edit-schedule-item`. The function gated on `is_staff` RPC — a coarse role check that bypassed the matrix.
- **Root cause:** Same pre-Phase 2 pattern as Bug #214. `edit_schedule` was already matrix-driven for `carry-over` (Bug #210) but `edit-schedule-item` (the function that rewrites `base_installment_amount`) was missed in the Batch C sweep.
- **Fix:** Replaced `is_staff` RPC check with `checkPermission(supabase, user.id, "edit_schedule")`. Import of `../_shared/check-permission.ts` added. 403 body now reads `"edit_schedule permission required"`.
- **Files:** `supabase/functions/edit-schedule-item/index.ts`.
- **DB changes:** none — `edit_schedule` already seeded in `role_permissions` (admin=true, finance=true after Bug #209, staff=false, csr=false).
- **Net effect on existing users:** admin + finance retain access (matches seed); staff loses implicit `is_staff` access (matches matrix). Admin can flip staff via matrix if needed.
- **Related:** Bug #199 Batch A; Bug #202 Batch C (cash + schedule migrations); Bug #209/#210 (`edit_schedule` matrix-driven story); Bug #168.

### Bug #216 — `ai-customer-insights` edge function had auth gate only, no role/permission check (2026-06-12) ✅

- **Symptom:** Any authenticated user (including Phase B customer-portal users) could invoke `ai-customer-insights` for any `customer_id` and receive a staff-facing AI risk assessment containing aggregated layaway, payment, penalty, and loyalty data. No role gate, no permission gate — only `supabase.auth.getUser` validation.
- **Severity:** P1 information disclosure — function surfaces cross-customer financial data + AI-summarized risk to anyone with a valid session JWT.
- **Root cause:** Function shipped without a role check during the AI insights feature build; missed in Phase 2 Batch A-F because it was not surveyed (predates the matrix migration sweep).
- **Fix:** Added `checkPermission(supabase, user.id, "view_accounts")` immediately after the `getUser` block — same key that gates the `/accounts` and `/customers` UI pages. Import of `../_shared/check-permission.ts` added. 403 body reads `"view_accounts permission required"`. OpenAI / Lovable AI Gateway call logic untouched.
- **Files:** `supabase/functions/ai-customer-insights/index.ts`.
- **DB changes:** none — `view_accounts` already seeded for admin/staff/finance/csr per existing matrix policy.
- **Net effect on existing users:** all internal roles retain access (view_accounts is broadly seeded); customer-portal sessions now blocked at 403 (correct behavior — function is staff-facing).
- **Related:** Bug #168 (matrix-driven auth pattern); Bug #199 Batch A and follow-on batches (Phase 2 migration sweep that should have caught this).

### Bug #217 — Editing expiry on an EXPIRED cash order had no functional effect (2026-06-12) ✅

- **Symptom:** Staff opening "Edit Expiration" on a cash order with `status='expired'` and picking a future date saw a success toast, but the order remained in `expired` status with `expired_at` set, and the order detail page continued to show the expired state. The new `expires_at` was written but the rest of the expiry state machine wasn't reset, so the revival was invisible to all downstream surfaces.
- **Root cause:** `confirmEditExpiry` in `src/pages/CashOrderDetail.tsx` only `UPDATE`d `expires_at`. The auto-expire-cash-orders cron sets `status='expired'` AND `expired_at=NOW()` at expiry; partially undoing one column does not revive the order.
- **Fix:** When `order.status === 'expired'` AND the new `expires_at` is in the future, the same UPDATE call now also writes `status: 'pending'` and `expired_at: null`. A second audit_logs row is written with action `'cash_order_revived'` and `new_value_json: { expires_at, invoice_number, revived_from_status: 'expired' }` (non-revival edits still log `expires_at_updated`). Toast on revival reads `Order revived — new expiration <date>`. `cash-orders` list query also invalidated so the list view reflects the status flip.
- **Files:** `src/pages/CashOrderDetail.tsx` (`confirmEditExpiry`).
- **DB changes:** none — RLS policy `staff_admin_update_cash_orders` already allows admin+staff to update `status`, `expires_at`, and `expired_at` on `cash_orders` rows.
- **Out of scope (intentionally untouched):**
  - `auto-expire-cash-orders` cron: its `status='pending'` race-guard already re-expires revived orders correctly when the new date passes.
  - `payment_submissions` auto-rejected at expiry stay rejected — customers resubmit.
- **Related:** SCHEMA-FACTS revival path note (same commit); cash_orders status lifecycle (`pending` → `expired` → `pending` via revival → `completed`/`cancelled`).

### Bug #218 — `confirm_payment` coupling let admin/finance direct-write payments via record-payment, and the RecordPaymentDialog fallback INSERT spawned stray pending submissions (19115/18132 incident) (2026-06-12) ✅

- **Severity:** P0 — two coupled failure modes produced both bypassed-queue payments AND orphan pending-review rows that polluted the Submissions tab. Manifested concretely on invoices 19115 and 18132 (both cleaned via SQL + schedule recompute on 2026-06-12).
- **Discovered:** 2026-06-12 by Cynthia (owner).
- **Symptom:**
  1. Admin/finance recording a payment from AccountDetail wrote a `payments` row directly via `record-payment` (canConfirm branch), skipping the Submissions review entirely. Proof of Payment then showed the payment without any reviewer audit trail.
  2. When the dialog tried to attach proof, the admin/finance branch in `uploadProofAndRecordSubmission` searched for a confirmed submission, didn't find one for that exact amount/account/date combination, and fell back to INSERTing a brand-new `payment_submissions` row with `status='submitted'`. That row had no real submitter intent behind it — it was the dialog's "rescue" attempt to attach proof, but it landed in the queue as a phantom pending submission.
- **Root cause:** The `canConfirm = checkPermission("confirm_payment")` flag in `record-payment`/`record-multi-payment` (Bug #201 Batch B) was intended to be a matrix-driven auto-confirm but in practice it coupled "can confirm" to "can bypass the queue" — two policies that should be independent. Compounded by `RecordPaymentDialog.uploadProofAndRecordSubmission` performing a best-effort search-and-attach-or-insert flow that could never reliably find the right confirmed row (timing window: the proof upload races the reviewer's confirm action, and the search criteria — same amount, same account, recency — match any number of legitimate rows).
- **Concrete incident:** Invoices 19115 and 18132 each ended up with an extra `payment_submissions` row in `submitted` status that did not correspond to a real customer or staff submission. Both rows traced back to admin/finance recording payments through `RecordPaymentDialog`. Cleanup required deleting the stray submissions via SQL and recomputing the affected schedules.
- **Fix:** Removed the `canConfirm` direct-write branches in both `record-payment` and `record-multi-payment` (replaced by Bug #219 universal-submission redesign). Removed the entire admin/finance "search confirmed row → fallback INSERT" path from `RecordPaymentDialog.uploadProofAndRecordSubmission` — the dialog now only attaches proof to the `existingSubmissionId` that `record-payment` just returned. No more fallback INSERT. No more stray pending rows from the dialog.
- **Files:** `supabase/functions/record-payment/index.ts`, `supabase/functions/record-multi-payment/index.ts`, `src/components/payments/RecordPaymentDialog.tsx`.
- **DB cleanup (out of band, 2026-06-12):** Stray `payment_submissions` rows for 19115 and 18132 were DELETEd via SQL Editor; affected schedule rows were recomputed by manual reset of `paid_amount` and `status` to match the surviving non-voided allocations. The SQL was applied directly by Cynthia and is not committed as a migration.
- **Related:** Bug #219 (universal-submission redesign — sibling fix in the same commit set); Bug #178 (proof file uniqueness suffix — related dialog work); Bug #201 Batch B (where `canConfirm` was introduced as matrix-driven auto-confirm — that direction is now reverted in favor of policy 219).

### Bug #219 — Universal submission-only payment recording redesign — payments table is now written ONLY by the confirmation flow (2026-06-12) ✅

- **Policy (locked by owner, 2026-06-12):** Recording a payment ALWAYS creates a pending `payment_submissions` row, for EVERY role including admin and finance. Direct writes to the `payments` table happen ONLY via the confirmation flow (`review-payment-submission`). Cash orders already comply (`submit-cash-payment` is submission-only for all roles); this fix brings layaway payments to the same model.
- **Severity:** P1 redesign — addresses both the audit-trail integrity gap (admin/finance payments had no reviewer record) and the coupling that produced Bug #218.
- **Discovered:** 2026-06-12 by Cynthia (owner); locked as policy in CLAUDE.md PAYMENT SUBMISSION FLOW.
- **Fix:**
  - `supabase/functions/record-payment/index.ts`: removed the `canConfirm` lookup and the `!canConfirm && !preview_only` gating. `if (!preview_only)` now unconditionally creates a `payment_submissions` row (with the existing duplicate-soft-block, audit log, and 201 response — applied to every role). The direct-write waterfall below (`payments` insert, `payment_allocations` inserts, penalty/schedule updates, account total update, reconcile-account call, email send) was removed entirely — that path was unreachable for any non-preview call and only invited reintroduction of the bypass. `preview_only` logic is fully preserved.
  - `supabase/functions/record-multi-payment/index.ts`: same collapse. Removed `canConfirm`. Three forks collapsed: per-account submission insert is now `if (!preview_only)`; the per-account direct-write branch was deleted; the batch-return branch is `if (!preview_only)` returning the submission summary. Preview path returns `{ preview: true, batch_id, total_amount, account_results }`.
  - `src/components/payments/RecordPaymentDialog.tsx`: removed `isAdminOrFinance` const and all behavioral branches. Every submit now follows the existing staff path — `record-payment` returns `{ submission_id }`, the dialog uploads proof and `UPDATE`s that row via `existingSubmissionId`. The preview step UI, `handlePreview`, `handleConfirm`, and `useRecordPayment` usage were removed (dead with universal submission). The admin/finance "search confirmed row → fallback INSERT" branch in `uploadProofAndAttach` was removed (Bug #218 root cause).
  - Label unification (no behavior changes):
    - `src/pages/CashOrderDetail.tsx` button: removed the `(isAdmin || isFinance)` label fork — always `Submit Payment` with the Upload icon.
    - `RecordPaymentDialog` trigger: always `Submit Payment` with Upload icon. DialogTitle: `Submit Payment for Confirmation`. Submit button: `Submit for Confirmation`. Underpayment branch button: `Submit Partial — carry …`.
    - `RecordPaymentModal` DialogTitles: `Record Payment` → `Submit Payment`.
    - `WorkspaceSplitButton` menu items: `Record Payment` → `Submit Payment`.
    - `PermissionMatrixTab` `record_payment` row label: `Record Payment` → `Submit Payment`.
  - `supabase/functions/ai-command-parser/index.ts`: knowledge-base section "How to record a payment (staff)" → "How to submit a payment (staff)" with a note that all roles enter the Submissions queue. RECORD_PAYMENT intent description updated to "submit a payment". No structural change to the parser or to AICommandModal's event dispatch.
- **Files (5 src + 3 edge + CLAUDE.md + 2 docs):** `supabase/functions/record-payment/index.ts`, `supabase/functions/record-multi-payment/index.ts`, `supabase/functions/ai-command-parser/index.ts`, `src/components/payments/RecordPaymentDialog.tsx`, `src/components/payments/RecordPaymentModal.tsx`, `src/components/layout/WorkspaceSplitButton.tsx`, `src/components/settings/PermissionMatrixTab.tsx`, `src/pages/CashOrderDetail.tsx`, `CLAUDE.md`, `docs/FIXED-BUGS.md`, `docs/SCHEMA-FACTS.md`.
- **DB changes:** none. `confirm_payment` matrix key is unchanged (still gates `review-payment-submission`). `record_payment` matrix key still gates whether a user can OPEN the submit-payment UI / call `record-payment` at all — that gate is intact.
- **Deploys NOT in this commit:** `record-payment`, `record-multi-payment`, `ai-command-parser` all need redeploy via Lovable IDE / Supabase Dashboard tooling. Frontend ships via Vite build on the next prod push.
- **Net effect on existing flows:**
  - Admin / finance: clicking Submit Payment now creates a pending submission visible in Submissions; the payment row is created when admin/finance confirms it there. One extra click in the happy path; clean audit trail across all roles.
  - Staff / CSR: unchanged behavior (already submission-only via the `!canConfirm` branch).
  - Customer portal: unchanged (already submission-only via `submit-payment`).
  - Cash orders: unchanged (already submission-only via `submit-cash-payment`).
- **CLAUDE.md update:** PAYMENT SUBMISSION FLOW section updated with the locked universal-submission policy (Step 2 collapses Staff/Admin/Finance/CSR into one row; Step 3 explicitly states that the reviewer's confirm action is what creates the `payments` row via review-payment-submission).
- **Related:** Bug #218 (the coupling and dialog-fallback root cause that this redesign closes); Bug #201 Batch B (where the canConfirm coupling was introduced and is now reverted as policy); Bug #206 reclassification (related discussion of confirm vs submit semantics for staff).
- **Remainder fix (2026-06-12, no new bug number):** `WorkspaceSplitButton.tsx` L68 was missed in the initial label sweep — `replace_all: true` in the original edit only matched the L58 occurrence because the two lines differed in leading-indent depth (10 spaces vs 8 spaces). One-line follow-up landed in the next commit; both menu items now read `Submit Payment`.

### Bug #220 — CA Bot duplicate payment submissions: double event listener + dup-check race window (2026-06-12) ✅

- **Severity:** P1 — produced real duplicate pending submissions (invoice 18671: two ₱6,063.38 rows 411ms apart, ids 961781eb / feb94fdc; the no-proof twin came from the second hidden modal instance).
- **Root cause (two layers):**
  1. The CustomEvent `open-record-payment-modal` had TWO listeners — `AppLayout.tsx` (the intended global path) and a legacy duplicate in `WorkspaceSplitButton.tsx` left behind when the CA Bot RECORD_PAYMENT flow was rerouted to the modal. One dispatch opened two stacked, identically pre-filled RecordPaymentModal instances; the per-instance `submittingRef` guard cannot protect across instances.
  2. The duplicate-submission soft block in `record-payment` ran as a separate SELECT before a separate INSERT, so two near-simultaneous calls both passed the check before either insert committed (commit-visibility race).
- **Fix:**
  - Commit `a9b1a14`: removed the WorkspaceSplitButton listener, its four `initial*` state hooks, the `channelMap` const, and the `initial*` props on its `<RecordPaymentModal>` (−44 LOC). AppLayout's listener is now the single event path; the split button's own click flow is unchanged.
  - Commit `72eca4c` (deployed): `record-payment` now calls the new `public.insert_payment_submission_guarded` RPC, which takes `pg_advisory_xact_lock(hashtext('payment_submission:' || account_id))`, re-runs the dup check (status submitted/under_review, 30 min, amount ±1, force bypass), and inserts atomically in one transaction. Concurrent callers serialize on the lock; the second receives the same 409 `duplicate_submission_detected` response as before.
- **Verification:** grep — single listener remains in AppLayout + dispatch in AICommandModal, zero `open-record-payment-modal` hits in WorkspaceSplitButton; `thirtyMinAgo` zero hits in record-payment; RPC call present at ~L128; deployed function returns 401 to unauthenticated curl.
- **Cleanup:** submission 961781eb rejected as duplicate; feb94fdc processed normally.
- **Related:** Bug #218 (the prior duplicate-payment incident on the now-deleted dialog fallback path); Bug #219 (universal submission-only redesign — this RPC now guards its single write path).

### Bug #221 — Permission Matrix UI/DB drift: 6 enforced keys invisible in matrix, 7 keys partially seeded (2026-06-12) ✅

- **Severity:** P2 — six runtime-enforced permission keys (view_ai_risk, view_live_collection, view_operations_panel, view_system_health, view_services, view_loyalty_redemptions) were absent from the Permission Matrix UI, so admins could not see or adjust them; seven other keys (manage_announcements, manage_promotions, manage_trade_ins, manage_waivers, view_services, view_trade_ins, view_vault) had missing role rows in role_permissions, making toggles on those role cells silent no-ops (missing row = checkPermission resolves false).
- **Fix:**
  - SQL backfill (run 2026-06-12): inserted the 13 missing role rows with explicit is_allowed = false via a self-resolving CROSS JOIN + NOT EXISTS insert. Verified: all seven keys now have exactly 4 role rows.
  - Commit `5852cc3`: added the six keys to PERMISSION_MODULES in src/components/settings/PermissionMatrixTab.tsx — four under Dashboard, view_services as the first Services entry, view_loyalty_redemptions under Loyalty.
- **Reserved keys decision (locked):** five seeded keys with zero runtime references are KEPT as reserved, not deleted: approve_cash_order, edit_cash_order, recalculate_balance, manage_trade_ins, view_trade_ins. Rationale: trade keys pre-stage the future trade-in UI; deletion buys nothing (unevaluated keys cost nothing) and risks the silent-false trap on any future re-seed. Documented in docs/SCHEMA-FACTS.md "Reserved permission keys" section.
- **Verification:** matrix file grep shows the six keys at L22/71/88-area; SQL count query returned 7 rows × roles_seeded = 4.
- **Related:** Bug #198 (the original drift discovery); Bug #168 / Phase 2 Item 4 (the matrix-driven checkPermission migration this completes the UI side of).

### Bug #222 — Last three staff-facing edge functions normalized to shared checkPermission; add-penalty csr gap closed (2026-06-12) ✅

- **Severity:** P2 housekeeping with one P3 behavioral fix. review-payment-submission and delete-customer each carried a local hasPermission clone (user_roles → role_permissions lookup) — functionally matrix-driven but duplicated code outside the shared helper. add-penalty had a real gap: a coarse user_roles IN (admin, staff, finance, csr) gate with no role_permissions lookup, so csr could add penalties and member overrides were ignored.
- **Fix (commit `5852cc3`, deployed):**
  - review-payment-submission: local clone deleted; call site uses shared checkPermission from _shared/check-permission.ts. The per-action key map preserved exactly: under_review/needs_clarification → review_submission, rejected/restore → reject_submission, confirmed → confirm_payment. Zero behavior change.
  - delete-customer: local clone deleted; shared checkPermission("delete_customer"). Zero behavior change.
  - add-penalty: coarse role gate replaced with checkPermission("add_penalty") + standard 403. INTENDED behavior change: csr (seeded false) loses access; per-member overrides now apply.
- **Key-alignment decision (locked):** review_submission / reject_submission / confirm_payment remain three separate keys — the per-action map is deliberate workflow design (staff triage the queue but cannot confirm; seeds: staff true/true/false). Do not propose collapsing these into confirm_payment in future sessions.
- **Verification:** hasPermission count 0 in both files; checkPermission import + call present in add-penalty; all three deployed from 5852cc3; curl proof: review-payment-submission 401, add-penalty 401, delete-customer 400 {"error":"Missing authorization"} (handles auth in-function; gate intact, no action precedes auth).
- **Related:** Bug #200 (the UI/backend gate audit that found these); Bug #168 (the prohibited string-equality / non-matrix auth pattern family). Note: edit-payment-submission was investigated and EXCLUDED — it is customer-portal-facing (resolvePortalAuth + ownership check), must never receive a staff checkPermission gate.

### Bug #223 — Service-role detection rejected env-injected key: loyalty awards + ALL transactional email down since 2026-06-11 (2026-06-12) ✅

- **Severity:** P1 outage. parseJwtClaims-based service-role detection (introduced in the Batch D/F permission migrations) returns null for the env-injected SUPABASE_SERVICE_ROLE_KEY when it is not in JWT format, so every internal function-to-function hop authenticating with that key was rejected 401 "Unauthorized". Impact from first failure 2026-06-11 08:31 to fix deploy 2026-06-12: 9 loyalty award attempts failed across 4 accounts (members Dideth Palacio-Rosima #19115 and Anna Kakanin #19120 lost points; #19090/#19121 were non-members owed nothing), and zero transactional emails sent after 06-10 (payment confirmed/rejected/clarification all silently dead). Cron-invoked functions were unaffected — the vault-stored cron key is a JWT and parsed fine, which is what isolated the diagnosis.
- **Fix (commit 233fefc, 9 functions deployed):**
  - _shared/jwt-claims.ts: new isServiceRole(token) — direct equality against the SUPABASE_SERVICE_ROLE_KEY env value first (format-proof), parseJwtClaims role check as fallback (preserves vault-JWT cron callers).
  - 19-function sweep replacing the raw parseJwtClaims service check with isServiceRole.
  - reconcile-account: had NO service path at all (straight getUser + checkPermission despite 4 internal callers) — added isServiceRole short-circuit; user-JWT path unchanged.
  - review-payment-submission: new membership pre-check (isCustomerLoyaltyEnrolled) before all 3 award-loyalty-points call sites — non-enrolled customers never enter the loyalty pipeline, so no loyalty notification can ever reference a non-member, even during outages (per Cynthia's spec).
- **Backfill:** awards re-fired 2026-06-12 12:01 via pg_net + vault key for the two member accounts — #19115 +1,500 pts, #19120 +500 pts, both synced to sheet and loyalty-earned email sent (this also served as live end-to-end verification of the fix across award-loyalty-points, sync-loyalty-to-sheet, and send-transactional-email). The already_awarded guard (account-keyed earned-transaction check) made re-firing provably safe.
- **Accepted loss:** transactional emails for actions in the outage window are unrecoverable (direct-send architecture, 60-minute transactional TTL); customers were covered by staff messenger notifications during the window.
- **Verification:** isServiceRole present in shared helper + receivers; 401 curls on all 9 deployed functions; fresh email_send_log rows post-deploy; backfill loyalty_transactions rows confirmed.
- **Note:** sync-backup-sheets (new, not yet deployed) still carries the old pattern — apply the isServiceRole swap before its first deploy.
- **Related:** Bugs #199/#201–#205 (the Batch D/F migrations that introduced the pattern); Bug #222 (same-day normalization work that led to discovering this); Bug #218/#220 (account #19115 also featured in the morning's duplicate-submission incident).
- **Follow-ups (same day):** commit 85ff208 — loyalty failure notifications now identify the customer (`full_name · Inv #` prefix) in both review-payment-submission and daily-reconciliation emitters; commit c76806c — sync-backup-sheets migrated off the banned raw parseJwtClaims pattern to isServiceRole and deployed. All three functions deployed with 401/403 curl proof.

### Bug #224 — Layaway payment-confirm bell showed "confirmed by Unknown" (2026-06-15) ✅

The staff-bell "Payment confirmed" notification (written by the `notify_submission_reviewed` Postgres trigger on `payment_submissions` UPDATE) showed the reviewer as "Unknown" for LAYAWAY confirms. Root cause: the layaway confirm path's CAS status-flip update (`UPDATE … SET status='confirmed' WHERE id=? AND status IN ('submitted','under_review')`) fired the trigger BEFORE `reviewer_user_id` was written — and the later reviewer-detail update (review-payment-submission ~L1263) no longer changes `status`, so the trigger never re-fires and never sees the reviewer.

Fix: write `reviewer_user_id` (and `reviewer_notes`) atomically in the CAS flip itself: `.update({ status: "confirmed", reviewer_user_id: user.id, reviewer_notes: reviewer_notes || null })`. The trigger now fires with the reviewer already set. The cash path was already correct (its `.update(subUpdate)` sets status + reviewer atomically); the general/restore paths were untouched.

### Bug #225 — Finance "Monthly Performance" All-range crashed on corrupt-date rows (2026-06-17) ✅

`MonthlyAnalyticsChart` (Finance → Overview) threw under the "All" range. `get_monthly_analytics` returns a few corrupt-date rows (years like `0002`, `0004`, `32025`) that survived the null "All" cutoff (the only range with no lower bound). `format(parseISO(badMonth), 'MMM yy')` then threw `RangeError: Invalid time value`, which `RootErrorBoundary` caught and surfaced as the misleading "the app was just updated" screen. The 6M/1Y ranges masked it because their `cutoff` filter excluded the bad rows.

Fix: added an `isSaneMonth` guard to the `chartData` useMemo — `isValid(parseISO(m)) && year >= 2020 && year <= currentYear + 1` — applied in the row filter alongside the cutoff, so corrupt-date rows are dropped in every range. Same guard applied to the new `MonthlyCashOrdersChart`. No backend change (the corrupt source rows are left in place; the chart just refuses to render them).

### Bug #226 — Timesheet manual fill unusable (grid unmounted on every keystroke) (2026-06-18) ✅

Timesheet manual fill unusable — every cell edit called the page-level load(), flipping `loading` and swapping the whole grid for the skeleton, unmounting the editing input on each keystroke. Fixed by an in-place myEntries merge (onEntrySaved) instead of onRefresh, plus removing disabled={busy} from grid time inputs.

### Bug #227 — Timesheet overnight punch-out filed next day as stray am_out (2026-06-18) ✅

Timesheet overnight punch-out filed the next day as a stray am_out, leaving the prior shift open and computing 0 hours/₱0 pay. Fixed (Option A): an out-punch before 08:00 with no open shift today but an unclosed clock-in yesterday closes yesterday's pm_out at 23:59 (clamped; the day-grid model can't carry a punch past midnight). Pre-existing split rows still need a separate data repair.

### Bug #228 — Timesheet manual-fill busy-latch regression (punch buttons stuck disabled) (2026-06-19) ✅

Punch In/Out buttons stuck disabled after typing in the manual-fill grid. Cause: the focus-fix refinement (commit 1a51842) dropped the `finally { setBusy(false) }` in `writeField`, so `busy` never reset after a save. Fixed in commit f1ec119 by restoring the `finally` (writeField now has both setBusy(true) and setBusy(false), alongside pasteRow's).

### Bug #229 — Timesheet time fields rendered per-device (OS locale) (2026-06-19) ✅

Native `<input type="time">` showed 12-hour AM/PM on some devices and 24-hour on others — looked like a deploy gap but wasn't; native time inputs render per OS locale. Fixed in commit 31585c2 by replacing the punch-grid input with a custom `TimeSelect` (two `<select>` dropdowns) that renders identical text on every device. Commit d4a32fb then limited manual minute choices to 00/30 while preserving any off-grid stored minute as a selectable option; the Time In/Out buttons still record exact minutes.

### Bug #230 — PWA stale deploy (updates reached some users, not others) (2026-06-19) ✅

Some users stayed on the old build after a deploy. Cause: CDN/browser caching of `sw.js` and `index.html`. Fixed in commit f1ec119 — firebase.json sets `Cache-Control: no-cache` on `/index.html` and `/sw.js`, while `/assets/**` stays immutable (hashed filenames). Stale long-open tabs need one reload, after which updates auto-propagate.

### Bug #231 — Midnight PM-out paid ₱0 (2026-06-19) ✅

PM OUT = 00:00 made Hours and Salary show "—" (e.g. pm_in 13:00 → pm_out 00:00). Cause: `timeOfDayHours` returns 0 for both a blank punch and a real 00:00, so `dailyHours` computed `(0 − in)` → negative → clamped to 0. Surfaced after the 00/30 minute limit (Bug #229) removed the old 23:59 workaround. Fixed in commit 9360961 — in `dailyHours`, a non-blank `pm_out` resolving to 0 (midnight) is lifted to 24:00 (end of the 08:00→00:00 workday); a blank pm_out stays 0. 13:00→00:00 now computes 11h. Retroactive, since pay is computed live, not stored.

### Bug #232 — audit_delete_cleanup_invariants flagged payment_proofs→cash_orders FK (preventive info) (2026-06-19) ✅

The `payment_proofs.cash_order_id` FK to `cash_orders` (added 2026-06-15) is a blocking FK to a parent that has no delete function (cash_orders is soft-cancel only), so `audit_delete_cleanup_invariants()` surfaced it as a preventive `info` finding. Resolved by allowlisting it — adding `('(none - soft-cancel only)', 'cash_orders', 'payment_proofs', false, false)` to the RPC's allowlist CTE. cash_orders is NOT given a DELETE step (it is never hard-deleted); the allowlist entry simply acknowledges the FK so the finding clears. RPC now returns zero rows. SQL-Editor-only change (RPCs are not repo migrations); docs/AUDIT-RPCS.md updated to match.

### Bug #233 — audit_account CHECK-10 false positive on DP overpayment (2026-06-19) ✅

CHECK-10 ("sum of pending months matches remaining balance") in `audit_account()` fired false positives on accounts where the downpayment collected exceeds `downpayment_amount`. The overage reduces remaining_balance via total_paid but was never reflected on the pending side, so the two sides disagreed. Fixed by adding a `v_dp_overpaid = GREATEST(0, v_dp_paid - downpayment_amount)` term subtracted from `v_sum_pending` — mirroring the existing `v_unpaid_dp` term for the overpaid direction. Examples that previously false-failed: invoices 19119, 19128. SQL-Editor-only change; docs/AUDIT-RPCS.md updated.

### Bug #234 — sales_log `eligible` checkmark not auto-checking after payment confirmation (2026-06-19) ✅

- **Symptom:** after the auto-flip set `status='Paid'`, `eligible` stayed false, excluding the row from the commission pool despite meeting all criteria.
- **Root cause:** `Commissions.tsx` auto-stamps `eligible=false` on non-Paid rows via `defaultEligible()` (overriding the DB default `true`). `computeMonth()` pools purely on `eligible===true` with NO status gate, so that `false` is load-bearing while pending. When the auto-flip set `status='Paid'` directly in the DB, the BEFORE trigger `autocheck_sales_log_eligible()` was blocked by its `NEW.eligible IS DISTINCT FROM false` guard → `eligible` stayed false → row stranded.
- **Fix (trigger rewrite):** on a non-Paid→Paid UPDATE transition, force `eligible=true` for qualifying rows (channel != 'Live', source not in Live Post / Online Store / Other), overriding the auto-stamped `false`; on INSERT, still honor an explicit `eligible=false` (creation-time opt-out); already-Paid edits hit neither branch, so admin opt-outs on Paid rows are preserved.
- **Accepted edge:** an opt-out applied while a row is still Pending won't survive its later Paid transition (re-included); recoverable by re-unchecking on the now-Paid row.
- **Data correction:** two stranded already-Paid rows (`4860bd05-fa2d-47ad-800c-9a2d2fc9aca3` / inv 19195, and `096dcab9-fcb9-47e8-b832-9606b18ddd97` / null-invoice Admin Post) flipped to `eligible=true` directly.
- **Verified:** stranding surfacing query returns 0 rows.

### Bug #235 — Extension/forfeiture: clean-vs-dirty accounts (penalty bump gate + Rule A guard) (2026-06-19) ✅

Commit `48d5cfab` — `penalty-engine` + `auto-forfeit-settlement`. The `auto-forfeit-settlement` change is an **OWNER-AUTHORIZED** modification to the LOCKED file.

**Rule (owner-confirmed):**
- **CLEAN account** (all earlier installments paid): forfeits via the final-month cap (PHP 3000 / JPY 6000). Extension grants one more month on the final installment: **+PHP 1000 / JPY 2000 → PHP 4000 / JPY 8000**. Final forfeiture at the next penalty cycle tick after that fills.
- **DIRTY account** (an earlier installment unpaid): forfeits via the **3-month-no-payment rule (RULE 2)**. The final-month cap is dead — no +1000/2000 bump; the final installment stays at PHP 3000 / JPY 6000. Final forfeiture at the next tick after the cap fills.

**Fixes:**
- `penalty-engine`: built `accountsWithEarlierUnpaid` from the Step 1 batch (unpaid-only rows; any `installment_number < final month` ⇒ dirty). The extension bump on the final installment is gated `&& !accountsWithEarlierUnpaid.has(accountId)`.
- `auto-forfeit-settlement` (LOCKED, owner-authorized): added `priorUnpaid = schedItems.some(s => s.installment_number < payment_plan_months && s.status !== 'paid')`; **Rule A** (final-month cap forfeiture) now requires `!priorUnpaid`. The cap re-activates automatically once earlier months clear. No forfeiture-timing logic in the locked engine was changed.

**Forfeiture date:** driven by the existing extension expiry path (`extension_end_date + 1 day`). Set manually for current accounts — **17059 = 2026-07-06** (forfeit Jul 7), **17325 = 2026-07-04** (forfeit Jul 5).

**Verification:** 17325 (dirty) holds at PHP 3000. 17059 (clean) confirmed in-scope; its bump correctly did not fire because an open payment submission (a full PHP 22,593 payoff of Month 6, pending review) **froze** the account — the freeze guard correctly prevented a PHP 1000 shortfall against the customer's payment.

**Open follow-up:** `reactivate-account` still sets `extension_end_date = reactivated_at + 1 month`, which is not the cycle-accurate forfeiture tick (differs clean vs dirty). Future reactivations need `extension_end_date` computed from the final installment's penalty cycle. Not yet implemented.

### Bug #236 — PWA "Reload" button reloaded the same commit (stale-cache race) (2026-06-27) ✅

Commit `243999f` (`fix(pwa): let updateSW drive the reload to avoid stale-cache race`). Single-file diff: `src/lib/pwaUpdate.ts`, `applyUpdate` body only.

- **Symptom:** Clicking "Reload" on the new-version banner refreshed the app but kept serving the old commit. Intermittent — fast desktop networks sometimes updated, mobile / slow networks usually didn't.
- **Root cause:** `applyUpdate` called `void _updateSW(true)` (async: skipWaiting + reload-on-`controllerchange`) then `window.location.reload()` synchronously in the same tick. The reload tore the page down before the waiting service worker activated, so the reload was served by the old SW. On the Hub that SW uses `NetworkFirst` with a 3s timeout (`vite.config.ts`), so a slow network served the cached old `index.html` → old hashed bundles → same commit. The earlier `d5a8fab` "always reload" change introduced the race.
- **Fix:** When a SW handle exists, call `void _updateSW(true)` and let the SW drive the reload on `controllerchange`, with a `setTimeout(reload, 3000)` fallback for the no-waiting-SW case (the Hub banner can fire from `version.json` polling before a new SW installs, so the button must never be a silent no-op). Plain `reload()` only when no SW handle is present.
- **Ruled out / not changed:** `firebase.json` already serves `index.html` and `sw.js` as `no-cache` (browser HTTP cache was not the cause); single SW registration via `main.tsx` (no competing workers); `caches.delete('navigation-cache')` hardening considered and not needed — single-click update verified, so `updateSW(true)`'s activation reliably drives the reload.
- **Verification:** Booted Hub on the fixed build (footer `243999f`), deployed a newer build (`ae59365`) via empty trigger commit, confirmed `version.json` served `ae59365` on both `app.` and `portal.` hosts (NetworkOnly), banner fired, one Reload click flipped the footer `243999f → ae59365`. Pre-fix, the same action on `10fc4b2` required multiple clicks. `tsc` clean.

### Bug #237 — Test accounts leaking into KPIs (bare-numeric tests bypass prefix/regex guards) (2026-06-27) ✅

Commits `5b2526d` (edge), `4436777` + `2cbe4f8` + `d565ceb` (frontend), plus SQL-Editor column DDL + 24-RPC sweep (LIVE DB, not in migrations — see CLAUDE.md "Live DB ahead of repo migrations").

- **Symptom:** Expired test orders (cash `1234`/`3456`, ¥176,524 combined) showed in Finance KPIs; 6 test accounts (¥1,200,000) showed in the Executive Dashboard monthly-inflow-by-plan chart.
- **Root cause:** Two leaky guard patterns fleet-wide. The `TEST-` prefix is applied only by `enforce_test_invoice_prefix()` at insert, so test orders created before their customer was flagged `is_test` stayed bare-numeric. `invoice_number ~ '^[0-9]+$'` only catches *lettered* tests; `NOT LIKE 'TEST-%'` only catches *prefixed* ones — bare-numeric tests passed both. The structural marker `customers.is_test` existed but only 1 of 755 customers was flagged.
- **Fix:** Added order-level `is_test boolean NOT NULL DEFAULT false` to `cash_orders` + `layaway_accounts`; backfilled (19 orders, `WHERE invoice_number !~ '^[0-9]{5}$'`); flagged 5 pure-test customers. Rewrote `enforce_test_invoice_prefix()` to set `NEW.is_test` from `customers.is_test` at insert. Swept BOTH guard patterns to `is_test = false` across **24 RPCs** (atomic pg_get_functiondef DO-block, excluding the trigger fn), **2 edge functions** (dashboard-summary ×19, send-reminders ×1), and **13 frontend sites** (Monitoring, AdminAudit, OverdueAlerts, PenaltyCapAuditPanel, PenaltyFollowUpSection, Finance, useExecutiveDashboard, Dashboard).
- **Left by design:** `service_jobs` / `trade_ins` (no is_test, no test rows, manual inputs); display-badge sites (CashOrdersList, CustomerCashOrdersTab); AccountDetail hardcoded fixture set; input-validation/search regex (ServiceJobDialog, TradeInDialog, CustomerDetail, CustomerPortal, ActivityLogTab).
- **Verification:** Live function dump confirmed all 24 RPCs on `is_test = false`. Finance cash leg dropped ¥2,332,759 → ¥2,156,235 (matches Overview); inflow chart shed ¥1,200,000. `get_monthly_sales` unchanged at ¥7,406,048.57 (its tests were already lettered).

### Bug #238 — "Total Sales · This Month" card layaway leg disagreed with the rest of the app (2026-06-27) ✅

Commit `e05f019` — `dashboard-summary/index.ts` (deployed via Lovable).

- **Symptom:** The Finance "Total Sales · This Month" card's layaway leg read ¥8,342,014 while the New Layaway Sales card and the Collected-vs-Sales chart Sales line both read ¥7,406,049.
- **Root cause:** The card computed the layaway leg by `order_date` — a different basis than the canonical figure. Every other "layaway sales" number derives from `get_monthly_sales.total_sales_value` (first-payment-month basis, DISTINCT ON account_id earliest payment).
- **Fix:** Repointed the card's layaway leg to `rpc('get_monthly_sales', { currency_mode:'ALL', months_back:0 })`, summing `total_sales_value` for the current PHT month label. Single source of truth — the card can no longer drift from the chart. Cash leg untouched.
- **Verification:** Card reads ¥9,562,284 = ¥7,406,049 layaway · ¥2,156,235 cash; layaway now matches the New Layaway Sales card and the chart Sales line. Footer confirmed build `e05f019`.

### Bug #239 — PWA reload still served stale build: skipWaiting stale-handle + navigateFallback precache (corrects #236) (2026-06-27) ✅

Follow-up to **#236**. That entry fixed one cause (`243999f` — same-tick `window.location.reload()` racing SW activation) and was marked "single-click verified," but that pass held only for an isolated single deploy. Under successive deploys the Reload button still loaded the old commit. Investigation (live DevTools SW panel + precache inspection) found two further causes beneath the first. The reload failure was three layers, not one.

- **Symptom:** Clicking "Reload" refreshed but stayed on the old commit; banner never cleared. Walking forward one commit per click under rapid deploys. Worker observed stuck "waiting to activate"; even after activation, SW-served `/` referenced the old `index-*.js` while `version.json` reported the new build.
- **Cause 2 — stale skipWaiting handle (fixed `f267de7`):** `applyUpdate` messaged the `registerSW` `updateSW(true)` handle, which is captured at first `onNeedRefresh` and goes stale across deploys, so it missed the worker actually waiting now → new worker never skip-waited. **Fix:** read `navigator.serviceWorker.getRegistration()` at click time and `postMessage({ type: 'SKIP_WAITING' })` to `registration.waiting`; reload on `controllerchange`; keep `updateSW(true)` + 3s timeout as fallback. (Manual DevTools skipWaiting activating the worker confirmed the worker was healthy and the defect was message delivery.)
- **Cause 3 — navigateFallback served stale precached HTML (fixed `fcf4c82`):** `navigateFallback: 'index.html'` (`vite.config.ts`) served SPA navigations from the workbox precache, which retained multiple `index.html` revisions across deploys; navigations resolved to a stale revision → old bundle, even after the new worker activated. This shadowed the existing `request.mode === 'navigate'` NetworkFirst rule. Confirmed: SW-served `/` returned old `index-*.js` while `version.json` was current. **Fix:** removed `navigateFallback` + `navigateFallbackDenylist`; navigations now fall through to the NetworkFirst `navigation-cache` rule, fetching fresh `index.html` from Firebase (served `no-cache`) with 3s timeout + offline fallback. Tradeoff accepted (Option A): weaker cold-offline first-launch.
- **One-time client cleanup:** clients that loaded before `fcf4c82` hold a poisoned precache (stale `index.html` revisions). The fix stops future navigations from using it, but an already-poisoned client needs one reset to reach a clean baseline — unregister SW + clear caches + hard reload, or in most cases a single hard reload. New clients are unaffected.
- **Verification (from a clean post-`fcf4c82` worker, static target, button only — no DevTools, no hard reload):** banner fired → one Reload click → new worker activated and took control, footer advanced to the served build, banner cleared. Console proof: SW-served `/` referenced the current bundle (`index-CpO8mZiU.js`) matching `version.json` (`8cea88b`) — no stale HTML. `tsc` clean on both `f267de7` and `fcf4c82`.
- **Note on #236:** its "single-click verified" was true only for an isolated deploy; the stuck-waiting / successive-deploy and precache-staleness cases were not covered there. This entry supersedes that verification claim.

### Bug #240 — Missing JS chunks served as index.html (MIME crash, cached immutable) (2026-06-27) ✅

Commit `2d524e9` — `firebase.json` rewrite source `"**"` → `"!/assets/**"`. Surfaced by #239's navigateFallback removal (more asset/navigation fetches hit the network), but a pre-existing hosting-config bug independent of the PWA work.

- **Symptom:** Stale clients (running an old index.html that references old hashed chunks) crashed to the RootErrorBoundary white screen — "The app was just updated. Please refresh." Console: "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html" for chunks like AppLayout-*.js, then `TypeError: Cannot read properties of undefined (reading 'default')` in vendor-react. A normal reload did not fix it; only a full cache clear did.
- **Root cause:** `rewrites.source: "**"` rewrote EVERY unmatched path to /index.html, including requests for hashed asset files that no longer exist on the server (old chunk hashes from a prior build). Those returned HTTP 200 with content-type text/html, so the browser rejected them as module scripts and the dynamic import() resolved to undefined. Because /assets/** is also marked Cache-Control: immutable max-age=31536000, the browser cached that HTML-as-JS response for a year — turning a transient stale-chunk miss into a sticky crash.
- **Fix:** changed the rewrite source to "!/assets/**" so requests under /assets/** are NOT rewritten — a missing hashed chunk now returns a genuine 404. The dynamic import() then fails cleanly and triggers the existing `vite:preloadError` handler in main.tsx (time-gated reload → fresh index.html → correct chunk hashes). The /assets/** immutable header is intentionally unchanged: it is correct for content-hashed filenames; the bug was the rewrite serving HTML under it, not the header.
- **Verified (curl against live 2d524e9):** missing chunk (AppLayout-DHl-1c_6.js) → HTTP 404; current chunk (index-DQ1PSNaV.js, pulled live from index.html) → 200 text/javascript; navigation route (/finance) → 200 text/html (SPA routing intact, negation did not over-exclude). Fresh client loads with no MIME errors.
- **Note:** clients still holding a poisoned immutable HTML-as-JS response from before 2d524e9 need one cache-clearing reload to recover; new requests self-heal via the 404 → preloadError path.

### Bug #241 — Cash-receipt slips attached row-major (printed out of sequence / split across pages) (2026-06-28) ✅

**Symptom.** On the invoice generator's "Cash Receipt" tab, auto-attached payment slips filled left-to-right across the top row (slot 1→B5, 2→I5, 3→P5) instead of top-to-bottom down the leftmost column. Printing cannot reorder cells, so the printed sequence was wrong; the template's own slot labels were already column-major, disagreeing with the code.

**Root cause.** The `SLOTS` map in `supabase/functions/_shared/cash-receipt.ts` was numbered ROW-MAJOR: `index = (band-1)*4 + col`, placing consecutive receipts across each band. The caller (`review-payment-submission`) correctly computes `slot_index` as the chronological count of confirmed receipts and hands it in 1,2,3…; the mis-order was entirely in the cell map.

**Fix (commit `3554ca1`, all three consuming functions redeployed via Lovable).**
- Rewrote `SLOTS` to COLUMN-MAJOR: slots 1-6 → column B (top to bottom), 7-12 → I, 13-18 → P, 19-24 → W. Each slot's cell address is otherwise unchanged; only the index→cell assignment was reordered.
- Corrected band-5/6 anchor rows from 216/251 and 269/304 to **214/249 and 265/300** — the higher rows pushed the bottom slips onto a second print page; the corrected rows keep all 24 on one page. (Owner-verified against the live template via the Name Box.)
- Raised the cash-receipt slot cap in `review-payment-submission` from `> 13` to `> 24` (BOTH guard occurrences, ~lines 1032 and 1463) — the 13 cap was silently dropping receipts 14-24, which the 24-slot grid supports.
- Redeployed `append-cash-receipt`, `review-payment-submission`, and `generate-invoice` (all import the shared module; shared code bundles at deploy time). Deploy verified live (append-cash-receipt 401 auth-gate, Date header matched deploy time).

**No backfill required.** Query of all production cash-receipt sheets (`is_test = false`) confirmed every existing sheet holds exactly one slip, which sits at B5 under both the old and new maps — so no historical sheet was mis-placed. Invoice 18954 (the 3-slip example) was a demo/manual sheet with no matching `cash_order` record, not production data. Forward-only fix; the first production cash order to receive a 2nd confirmed receipt will place it at B58 (down), proving column-major fill.

### Bug #242 — Customer portal proof-of-payment upload always failed (token/session customers) (2026-06-28) ✅
Symptom: customers could not upload proof through the portal ("Proof upload failed — please try again."); staff had been recording payments manually via the staff app to compensate. Broken since 2026-06-05.
Root cause: portal uploaded proofs via direct anon REST POST to the payment-proofs bucket, authorized by the "Token customers can upload payment proofs" storage RLS policy which reads current_setting('request.headers')::json ->> 'x-portal-token'. storage-api does not forward that custom header into Postgres request.headers (PostgREST does; storage-api does not), so the EXISTS check saw NULL and denied every anon upload. The 2026-06-05 rework (072749 drop + 120957 re-add) introduced the header dependency. auth.uid()-based staff/session policies were unaffected.
Fix: new service-role edge function upload-proof (verify_jwt=false) — resolvePortalAuth -> customer_id, verifies account ownership (layaway_accounts OR cash_orders), writes via service role (bypasses storage RLS, no header dependency). Three portal sites (PayNow + edit-proof in CustomerPortal.tsx, cash portal in CashPortalPaymentDialog.tsx) now call it. Storage RLS policies left intact. submit-payment / submit-cash-payment / staff record-payment unchanged. Function deployed + frontend in f4ef23c9.
Follow-up (d9cdb4a, 2026-06-28): two residual issues surfaced after the upload-proof migration. (1) Gateway auth — upload-proof was actually deployed with verify_jwt ON (not off as stated above); an apikey-only request returns 401. The portal call sites clear the gateway by sending Authorization: Bearer <anon publishable JWT> alongside apikey (CustomerPortal.tsx ~L2797, CashPortalPaymentDialog.tsx); resolvePortalAuth finds no JWT user and falls through to the token path, so token/session auth still resolves. Added/restored in c4f4b3b8, c2199094. (2) Edit-proof sent account_id as the literal string "undefined". The customer-portal function (supabase/functions/customer-portal/index.ts) selects account_id (L343) and groups submissions by it (L689) but omits it from the per-submission payload projection (L795-807), while the frontend Submission interface falsely declares account_id: string (CustomerPortal.tsx L59) — so sub.account_id was undefined at runtime, serialized to "undefined", and upload-proof's ownership check rejected it (403 "Account not found or access denied"). PayNow was unaffected (uses primaryAccountForName.id). Masked before 2026-06-05 because the permissive anon storage policy accepted the resulting undefined/ path; surfaced only once upload-proof began validating ownership. Fix: pass the parent account.id into SubmissionsTab (accountId prop + type) and use it at the edit upload (L2793: fd.append('account_id', accountId)) instead of sub.account_id, so the edit path mirrors PayNow. Verified end-to-end in a fresh incognito portal session (#18952, token-only, no login): edit-proof upload succeeded and landed in storage.objects as a service-role write (owner NULL, 2026-06-28 11:05:29). Frontend-only, auto-deployed via firebase-deploy.yml.

### Bug #243 — "Sales" analytics attributed by first-payment date instead of order date; system-wide re-base to order date (2026-07-01) ✅

**Symptom.** On 2026-07-01 the Finance Collected-vs-Sales chart and the Total Sales · This Month KPI showed ¥462,895 of July layaway sales despite zero July-ordered accounts. Three accounts (inv #19242/#19235/#19243) were ordered Jun 30 but first-paid Jul 1, dumping their full contract value into July.

**Root cause.** Every layaway "sales" figure derived from get_monthly_sales, which bucketed each account's total_amount by DATE_TRUNC('month', earliest payment's date_paid) — DISTINCT ON account_id. So a sale was recognized in the month of first payment, not the month it was booked. Confirmed NOT a timezone issue: order_date and date_paid are `date` columns (no zone); created_at (timestamptz) resolved cleanly to Jul 1 in UTC/PHT/JST. Diagnostic: by_order_date_jul=0, by_first_payment_jul=462,895. order_date is an operator-editable, back-datable field (#19242 set to Jun 30 while the row was created Jul 1) — accepted as the sales basis.

**Business definition (corrected).** A sale belongs to its order_date month, counts only once the account has ≥1 non-voided payment, and cancelled accounts are excluded.

**Fixes.**
- SQL (SQL Editor, CREATE OR REPLACE — no frontend/edge/deploy for the RPCs; output shapes unchanged so all consumers re-base automatically): get_monthly_sales, get_daily_new_layaway_sales, get_daily_new_layaway_sales_last_month — scan layaway_accounts directly, bucket by order_date, COUNT(*) (was COUNT(DISTINCT account_id)), gate on EXISTS non-voided payment, add status <> 'cancelled', preserve is_test=false + ALL-mode PHP→JPY. Verified get_monthly_sales('ALL',12) → Jun 2026 ¥11,158,745 / 62 accts, no Jul row (Total Sales KPI now ¥0 this month until a July-ordered account is paid — intended).
- SQL: get_cash_orders_monthly — added the missing is_test=false (function added 2026-06-17, after the #131 test-exclusion sweep, so it leaked 3 test cash orders / ¥191,524 into June and into the Overview Monthly Cash Orders chart). Cancelled predicate (cancelled_at IS NULL) left unchanged — proven equal to the KPI's status<>'cancelled' once the test filter is applied.
- SQL: get_trade_monthly_trends — added is_test=false + EXISTS payment gate on both legs (payments for the layaway leg, cash_payments.cash_order_id for the cash leg). Already order/creation-date based, so no basis change; no-op on current data (0 test, 0 unpaid trades).
- Frontend: Collected-vs-Sales chart folds the cash leg into Sales in ALL mode only, via get_cash_orders_monthly which is JPY-only (commit 9e93351, Finance.tsx). Executive "Cash Sales (This Month)" KPI repointed from cash_revenue_month_jpy (collected, date_paid) to total_sales_booked_this_month.cash_jpy (booked, order_date) (commit 56dada3, ExecutiveDashboard.tsx).

**Boundary audit.** All other dashboard/executive metrics are collections / inflow / profit / exposure (get_monthly_analytics = collected/forfeited/penalties, fc_monthly_inflow, fc_gross_profit, fc_plan_performance, fc_cohort_timeline, fc_cfo_insights, revenue-mix/cash_revenue_*, get_collection_analytics, fc_penalty_revenue, fc_portfolio_value, fc_net_exposure_risk, fc_coverage_ratio, fc_at_risk_*, aging, outstanding) and were confirmed to correctly remain on their payment/balance basis — deliberately NOT flipped.

Bug #244 (2026-07-05): consume_lots_fifo consumed from REVOKED lots. The FIFO selection filtered remaining_amount > 0 AND expired_at IS NULL but never revoked_at IS NULL, so the earliest-earned lot won FIFO even when revoked — consuming from it deducted member counters while leaving the OPEN-lot sum unchanged (invariant violation per redemption). Pre-existing in the orphan function since creation; latent because the function had zero callers until the 2026-07-05 lot-wiring. Caught by cycle test 1 (approve leg showed points 18300 vs open_lot_sum 18400, invariant_ok=false; ledger row pointed at lot d540352a with revoked_at 2026-05-12). Fix: added AND lots.revoked_at IS NULL to the FIFO SELECT via SQL Editor, aligning the consume lot-set with the canonical invariant set (revoked_at IS NULL AND expired_at IS NULL AND remaining_amount > 0). Cycle test 2 verified: mid-cycle invariant_ok=true, consumed_lot_is_open=true, full restore on void, fleet violations 0.

2026-07-06 — Completed accounts showed residual Partial/Pending schedule rows (e.g. 19119, 18535): DP collected beyond downpayment_amount reduces remaining_balance via total_paid but never allocates to schedule rows (INVARIANT 11; DP redistribution intentionally removed), so rows stayed open after completion. Accounting was already reconciled in audit_account CHECK-10 via v_dp_overpaid (2026-06-19, see docs/AUDIT-RPCS.md). Fixed display-only in src/pages/AccountDetail.tsx (d3c8cc7): accountSettled renders residual rows as "Settled", REMAINING as —, and adds a "Downpayment Overage Credit" footer line. No DB/RPC/edge-function changes.

### Bug #245 — payment tracking sheet appends targeted stale sheet after monthly regeneration (2026-07-06)
Root cause: fill-payment-tracking creates a new sheet file every run but never wrote its ID to system_settings.payment_tracking_sheet_id (the key was seeded once manually and read-only in code). append-payment-tracking therefore kept writing confirmed payments to the previous month's sheet — June 2026 payments landed in the May sheet.
Fix: fill-payment-tracking now upserts outId into system_settings.payment_tracking_sheet_id on success (non-blocking) and returns setting_updated in its response. Manual SQL repoint applied for June 2026.
Known limitation (accepted): regenerating an OLD month's sheet will repoint the setting to that older sheet; repoint manually via SQL if that workflow is ever used. Also note: payments recorded via record-payment / record-multi-payment do not trigger append-payment-tracking at all — only submission confirmations do; full-sheet regeneration covers them.

### Bug #246 — fill-payment-tracking silently dropped pre-cohort payment months (2026-07-06)
Root cause: the month-cell loop skipped any payment month before the sheet's first column (offset < 0 → continue). Backdated history (trade-in downpayments, e.g. invoice 19109: ₱311,670 of ₱353,955 dated 2025-11 → 2026-05) vanished from the generated sheet; column D understated and column E overstated by the dropped total, silently.
Fix: pre-cohort amounts now roll into the FIRST month column, merged by column so multiple redirected months aggregate instead of overwriting. Months beyond the last column still skip. Rule: cohort = MIN(order_date) roster-wide, so pre-cohort dates only occur on backdated history entries; date-based redirection is equivalent to the intended 'old downpayment → first month' rule without relying on the remarks-based DP heuristic (payments has no payment_type/is_downpayment columns).

### Bug #247 — generate-invoice hard-capped at 13 items by template row block (2026-07-06)
Root cause: items occupy rows 21–33 (13 rows) in the master invoice template; both the edge function and InvoiceGeneratorSheet.tsx enforced MAX_ITEMS = 13, so long orders could not generate an invoice at all.
Fix: when items exceed 13, the function inserts the extra rows into the per-invoice copy on both tabs (Invoice-Use this + InvoiceWithTax-Print this) via a structural batchUpdate — insertDimension before the last item row so =SUM(H21:H33) auto-expands, inheritFromBefore for formatting, and copyPaste replicates the print tab's per-row formulas with self-adjusting references. Discount/shipping writes shift down by the inserted count. Master template untouched; ≤13-item invoices take the exact pre-fix path. Safety bound: 100 items. Tab resolution is by exact title and fails loudly listing actual tab names if the print tab title ever changes.

### Bug #248 — invoice fields starting with + rendered as #ERROR! (2026-07-06)
Root cause: populateSheet in generate-invoice writes all cells with valueInputOption USER_ENTERED, under which Google Sheets parses values beginning with +, =, or - as formulas. Phone numbers with international prefixes (+81…, +63…) failed to render; all free-text fields (names, addresses, item descriptions) shared the exposure.
Fix: populateSheet now prefixes string values starting with =, +, -, or ' with a literal-text apostrophe (not displayed by Sheets). Numbers untouched; valueInputOption unchanged; cash-receipt module (intentional IMAGE() formula) untouched.

### Bug #249 — DP overage now waterfalls to installments; footer reconciliation block removed (2026-07-06)
DP excess over the required downpayment is now allocated to installment schedule rows (real payment_allocations), so the schedule Remaining column sums to the true Remaining Balance without a separate credit line. Removed the footer reconciliation block added in e7007911 (and the earlier caption in ba223e8), which double-subtracted the overage after allocation. Account 19122 corrected via targeted allocation (Month 2 +¥12,006). Going-forward RPC change tracked separately.

### Bug #250 — DP overage now waterfalls into installments (2026-07-06)
Root cause: allocate_payment_atomic skipped the installment waterfall entirely for DP payments (old INVARIANT 11), so any DP paid over downpayment_amount floated as a global credit — reducing remaining_balance but never appearing on schedule rows. The schedule Remaining column then summed higher than the true balance (account 19122: schedule ¥91,986 vs balance ¥79,980, the ¥12,006 DP overage). The audit_account 'sum of pending months' check compensated by subtracting the overage; once the overage is allocated to a row that subtraction double-counts (showed ¥67,974).
Fix (both RPCs, applied live via SQL Editor, bodies synced into baseline migration):
  1. allocate_payment_atomic: for a DP payment, compute excess over downpayment_amount (counting prior non-voided DP payments, capped at this payment) and feed ONLY the excess into the existing waterfall (Month 1 onward, skipping paid rows). Required DP portion records as a payment with no allocation. Non-DP payments unchanged. Preview mode inherits the same logic.
  2. audit_account: removed the DP-overage subtraction from v_sum_pending (excess now counted via the schedule row it lands on).
Void path unchanged — void-payment already deletes allocations and recomputes paid_amount, so a voided excess-bearing DP reverses correctly.
Scope: going-forward for new DP payments. Account 19122 was corrected manually (one payment_allocations row tying the Jun-29 DP excess to Month 2 + paid_amount 13,342); no other backfill. audit_account('19122') → all_pass true.
Note: existing overpaid-DP accounts (other than 19122) will now correctly show their pending-months check as needing the same allocation until a future DP payment or manual correction runs — this surfaces reality, not new breakage.

## Store Credit (Phase A) — bugs fixed 2026-07-11

  - types.ts duplicate identifiers (TS2300/TS2717) — hand-added store_credit
    types collided with Lovable's auto-generated block. Fixed by removing the
    hand-written hunk. Root cause: src/integrations/supabase/types.ts is
    auto-generated; never hand-edit it (cast at the call site instead).
  - Store credit earned ZERO loyalty points when spent — redeem_store_credit_atomic
    writes payments directly and bypasses review-payment-submission, which is the
    only caller of award-loyalty-points. Fixed by calling award-loyalty-points
    from redeem-store-credit with the same gates (cash → award on completion;
    layaway → award when the credit lands as the DP).
  - Points not revoked on cash-order cancellation — cancel_cash_order_atomic
    passed p_source_reference => 'cash_order:<uuid>', but revoke_loyalty_points
    matches on the INVOICE NUMBER (award-loyalty-points writes the invoice
    number). It silently no-op'd (RAISE NOTICE + NULL return). Fixed by passing
    the invoice number; also removed the EXCEPTION WHEN OTHERS wrapper that was
    hiding the failure.
  - Customer portal notifications never fired on cancellation — the code was
    correct on GitHub main, but Lovable's repo mirror was one commit behind, so
    the DEPLOYED build did not contain it. Fixed by syncing the mirror. Lesson:
    assert on deployed SOURCE CONTENT (grep the unique string + line count), never
    trust "deployed successfully".

## Shopify cancellation → store credit (Phase B) — bugs fixed 2026-07-12

  - Shopify cancellation silently did nothing in the Hub. The webhook receiver
    explicitly discarded every topic except orders/create and orders/paid, and
    ORDERS_CANCELLED had never been registered with Shopify. A cancelled/refunded
    Shopify order stayed `completed` in the Hub, so the books were wrong. Fixed by
    registering the topic and adding the handler branch.
  - Shopify cancellation then failed with user_identity_required.
    cancel_cash_order_atomic had a service-role path but issue_store_credit_atomic
    — which it calls — did not, and received the same NULL user. Fixed by adding
    p_source to the inner RPC and threading it through. Cost three live test orders
    to find; the PL/pgSQL error CONTEXT named the real culprit.

### Bug #251 — Cash Receipt text block not written on succeeding payments (2026-07-12) ✅
Symptom: after invoice generation, a confirmed payment attached the receipt IMAGE but left the
INVOICE #/DATE/AMOUNT text block blank; staff filled it in by hand.
Root cause (two faults): (1) _shared/cash-receipt.ts hard-coded ONE slot map (the current master
template) and applied it to every sheet, but three template generations exist — 13-slot (26 merges,
3 bands), 24-slot (48), 30-slot (60, adds column AD). Old-template sheets have no bands at rows
163/214/265, so slots 4-6 wrote into non-existent cells. (2) reposition-cash-receipts read each
slot's metadata from OLD_SLOTS (24-slot ROW-major) positions; on 13-slot sheets those cells were
never used and held the blank template placeholder, which it then wrote OVER the correct metadata at
the new position — destroying the text while rebuilding the image from proof_url, so the image still
looked fine. Confirmed on live sheets 18951 (B93 = blank placeholder, I5/I40 blanked = reposition's
vacate step) and 19004 (slot 2 hand-typed by staff).
Fix: derive the slot map from each sheet's own merged ranges at runtime (deriveSlotMap); rebuild ALL
slots from payment_submissions on every confirmed payment (idempotent, self-healing, fixes damaged
sheets on their next payment); retire reposition-cash-receipts (HTTP 410); remove the 24-slot caps so
column AD (25-30) actually works; drop the confirmedPaymentIds.length === 1 gate so split payments
also embed.
Follow-up (b110e73, 2cc40db, 2026-07-12): the self-healing rebuild only fires when a submission is CONFIRMED, so sheets damaged before the fix — whose payments were already confirmed — could never heal on their own (verified on invoice 18951: all 3 payments confirmed, B93 still blank). Added a one-off repair sweep: new edge function rebuild-cash-receipts (admin-gated via hasPermission(user.id,'system_health'), no service-role/anon bypass per Bug #170) that walks every layaway_accounts AND cash_orders row with a non-null cash_receipt_sheet_id (180 sheets), rebuilds all slots from payment_submissions via appendManyReceipts, and is resumable via a ${kind}:${id} cursor with batch_size (default 20, clamped 1-25) and dry_run defaulting to TRUE. Per-record try/catch and ~1s pacing keep one bad sheet or the Google Sheets quota from aborting a batch. UI: RebuildCashReceiptsCard (src/components/admin/RebuildCashReceiptsCard.tsx) rendered inside the System Audit modal in Dashboard.tsx, gated by can('system_health') — it was first added to UnifiedSystemHealthTab.tsx, which is ORPHANED (imported by nothing) and therefore never rendered. Verified end-to-end on 18951: derived capacity=13 from the sheet's own merges (old 13-slot template, 26 merges), and B93 was restored to "INVOICE #: 18951 / DATE: 2026-05-30 / AMOUNT: 4,830 JPY". Accounts whose receipt count exceeds their sheet's capacity are reported as overflow and must be regenerated onto the 30-slot template — the sweep cannot fix those.

## Hub ↔ Shopify store-credit sync (Phase C) — bugs fixed 2026-07-13

  - PHANTOM REVENUE: a Shopify order paid entirely with store credit booked a
    full-value cash payment in the Hub. orders/paid recorded amount_paid =
    order.total_price with no inspection of HOW the order was paid — so ¥134,980
    of revenue was recorded for an order where Shopify collected ¥0. Fixed by
    splitting the transactions by gateway and recording the store-credit portion
    as payment_method = 'store_credit'.
  - DOUBLE-SPEND WINDOW: Shopify debits store credit at CHECKOUT but the Hub only
    reacted at orders/paid. For a bank-transfer order that window is DAYS — and
    FOREVER if the customer never pays. During it the Hub still showed the credit
    as available and offered an "Apply Store Credit" button. Fixed by handling
    store credit in orders/create as well, idempotently.
  - AUTHORIZATION vs SALE: the store-credit transaction on a partially-settled
    order has kind "authorization", not "sale", so the filter dropped it and no
    drawdown occurred. Fixed by accepting both kinds for store credit (real money
    still requires kind "sale").
  - DUPLICATE PAYMENT: the same store-credit payment was recorded twice
    (orders/create AND orders/paid) because the 23505 idempotency guard relied on
    a unique constraint that did not exist. Fixed with a partial unique index plus
    an explicit check-before-insert.
  - FALSE SYNC FAILURE: two successful pushes to Shopify were recorded as 'failed'
    because the response read-back of a nested field was denied by a missing
    scope, and the code treated any GraphQL error as total failure. Dangerous — a
    retry would have double-credited the customer. Fixed by judging success on
    userErrors + the returned transaction, and by no longer requesting the account
    balance.

## Shopify order edits & partial refunds — bugs fixed 2026-07-14

  - Shopify webhook used cumulative total_price and imported edited-out lines.
    orders/create + orders/updated read Shopify's total_price (cumulative, never
    decreases) and imported all line_items including current_quantity:0 lines,
    overstating edited orders (SH-1014: ¥428,940 vs true ¥293,960, 3 items vs 2).
    Fixed cdfe017: totals from current_total_price ?? total_price; lines filtered
    to current_quantity > 0 (absent = keep); qty = current_quantity ?? quantity.
  - store_credit_lots_source_type_chk missed on new source type. The partial-
    refund build extended issue_store_credit_atomic's validation with
    'shopify_partial_refund' but the table CHECK constraint independently
    enforces the same list and rejected the insert (23514) on first live mint.
    Fixed by ALTER TABLE dropping/re-adding the constraint with the new value.
    RULE: adding a source type requires BOTH the RPC validation list AND the
    table constraint.
  - Webhook idempotency matched error rows — one failure permanently bricked an
    order+topic. The already-processed lookup matched ANY shopify_webhook_events
    row; recordError writes status='error' rows; so one 500'd event blocked all
    future events of that topic for that order AND neutered Shopify's retries
    (proven in production on orders/updated for SH-1015 after a zero-total
    constraint violation). Fixed 678131e: lookup filters .eq("status","processed").
  - orders/updated crashed on zero-total edits. Shopify's cancellation/refund
    flows can emit orders/updated with current_total_price 0; writing it violated
    cash_orders_total_amount_check and recordError'd. Fixed 678131e: zero-total
    guard skips re-sync, fires shopify_order_zeroed staff notification, returns
    200; Hub keeps last valid state.
  - orders/cancelled minted Hub credit but never mirrored it to Shopify. The
    Hub-UI cancel path pushed via sync-store-credit-to-shopify; the webhook
    branch called cancel_cash_order_atomic directly with no push — Shopify-side
    cancellations silently drifted the ledgers. Fixed 6f69353: cancelled branch
    now pushes the minted lot (non-blocking).
  - Cancelled orders resurrected by concurrent webhooks. Shopify fires
    orders/cancelled and orders/updated (and sometimes orders/paid)
    near-simultaneously on a cancel. Handlers guarded status only at fetch time,
    so a handler that read the order before the cancel committed later wrote
    status back to 'completed' — cancelled_at survived, producing contradictory
    rows. Proven twice in production: SH-1017 (orders/updated totals write) and
    SH-1018 (orders/paid booked ¥188,960 onto a cancelled order and completed
    it). Fixed da3f225 + b97798f: every cash_orders status writer in
    shopify-webhook now chains .neq("status","cancelled") (orders/updated
    totals write + recomputeCashOrderTotals), and orders/paid gained an
    entry guard — payment for a Hub-cancelled order books NOTHING and fires a
    shopify_paid_after_cancel staff notification (policy A: money decisions in
    race windows are manual). RULE: cancelled is terminal; any new cash_orders
    status writer must carry the .neq guard.
  - Item images never matched: GID vs numeric product id. products.
    shopify_product_id stores the GraphQL GID ("gid://shopify/Product/12345")
    while webhook payload line.product_id is the bare number — the image_url
    Map lookup never hit, so Shopify-synced orders showed empty item boxes.
    Fixed b97798f: query converts numeric ids to GIDs, Map keys on the numeric
    tail (String(id).split("/").pop()). Verified SH-1019 (thumbnails render).

### Bug #252 — Commission split Config: Add Month unusable + Overview amounts unreadable (2026-07-31) ✅

- **Symptom:** adding a new month of split config was effectively impossible — the month picker blanked itself on selection and an added month silently vanished. Separately, Overview → Per-agent Total Earnings and Status Distribution showed amounts in black/grey on the dark card, and the per-month charts hid intermediate month ticks.
- **Root cause (Add Month):** the Splits-editor picker is `input[type=month]` but the handler stored `YYYY-MM-01` and fed it back as `value`; per the HTML value-sanitization algorithm a non-conforming month string is coerced to `''`, so the field cleared on every pick. `addBlankSplit()` also wrote only to local `splitDrafts`, never to the DB, while the `useEffect` on `[splits]` rebuilds drafts from the DB on every `onRefresh()` (fired by the agent toggle and AgentDialog) and Radix `Tabs.Content` unmounts inactive tabs — any of the three discarded the pending row.
- **Root cause (tooltips):** recharts 2.15.4 `DefaultTooltipContent` sets item colour to `entry.color || '#000'`, and `getMainColorOfGraphicItem` returns the series `fill`. The per-agent `<Bar>` carries no `fill` (colour lives on its `<Cell>` children) and `Bar.defaultProps` has none → `#000`. `<Pie>` inherits `Pie.defaultProps.fill = '#808080'`. The shared `tooltipStyle` set `background` but never `color`, so labels inherited.
- **Root cause (ticks):** `CartesianAxis.defaultProps.interval = 'preserveEnd'` drops colliding ticks in the half-width chart cards.
- **Fix:** picker stores `YYYY-MM`; `addBlankSplit` is async and INSERTs the seeded row immediately (seed = the split the month was already inheriting, so results are unchanged on add) then refreshes; new `deleteSplit()` behind `window.confirm` restores inheritance; pre-history seed fallback now takes the OLDEST split (`sorted[sorted.length - 1]`). `tooltipStyle` gains `color: hsl(var(--card-foreground))`, the two affected tooltips gain a matching `itemStyle`, and both per-month X axes get `interval={0}` with -45° ticks.
- **Notes:** RLS `commission_splits_auth_all` is `FOR ALL USING (true)`, so DELETE needed no policy change; the Config tab stays admin-gated in the UI only. `sync-backup-sheets` full-overwrites `commission_splits` nightly, so a deleted split leaves the backup sheet on the next run.

### Bug #253 — Layaway account creation fully blocked + schedule preview off by one month (2026-08-01) ✅

- **Symptom:** every new layaway account failed with `Failed to create schedule: Start year rule violation: installment 1 in month 9 must be year 2025, got 2026`. Separately, the Schedule Preview on New Account listed the order month as installment 1 instead of the month after.
- **Root cause (blocker):** DB trigger `trg_validate_schedule_start_year` on `layaway_schedule` (function `validate_schedule_start_year`, introduced 2026-03-21 as import GUARDRAIL 3) hardcoded installment 1 to months 9-12 -> 2025 and months 1-8 -> 2026. Since installment 1 = order month + 1, an August 2026 order date produces a September 2026 installment 1, which the trigger demanded be 2025. Permanently unsatisfiable from order_date 2026-08-01 onward: Sep->Dec 2026 all demand 2025, and Dec 2026 orders land installment 1 in Jan 2027 which demands 2026. Creation was 100% dead, not intermittent.
- **Root cause (preview):** generateScheduleDates() in src/lib/calculations.ts used `date.setMonth(date.getMonth() + i)` while create-layaway-account used `getMonth() + i + 1`. Frontend and backend had diverged with no documented rule pinning either.
- **Fix:** dropped `trg_validate_schedule_start_year` and `validate_schedule_start_year` (Option A — the guardrail was scoped to the 2025-26 import season and had expired; `trg_validate_schedule_chronology` remains as the durable guard). Frontend changed to `+ i + 1`. Rule documented in CLAUDE.md Account Creation Rules.
- **Not affected:** no monetary impact. NewAccount.tsx builds `custom_installments` purely by index with no dates in the payload, so custom amounts always landed on the correct backend dates — the defect was labelling only. `create-layaway-account` needed no change; its date logic was already correct.
- **Related:** restructure-account was exposed to the same trigger when zero installments are paid (`nextInstallmentNumber = 1`, `lastPaidDate = orderDate`). Unblocked by the same drop. `buildSchedule()` in calculations.ts is dead code (zero callers) but consumes the same fixed helper.

### Bug #254 — schedule rows stuck at `partially_paid` when the denominator changed after allocation (2026-08-03) ✅

- **Symptom:** Per-Account Health showed 1 failed / 495. Invoice #19387 failed
  `audit_account` CHECK 7 "schedule status consistent with allocations". Four
  further rows on #17041, #17174, #17599 (x2) had the same failure. #19387's
  account was also stuck `active` with `remaining_balance = 0` — a customer who
  had paid in full still showing as open.
- **TWO DISTINCT CAUSES, same symptom:**
  1. **#19387 — base edited after allocation.** Audit trail: payment allocated
     14:29:33 against `base_installment_amount = 2650.00`, applying 2649.80 —
     20 centavos short, so `partially_paid` was CORRECT at the time. At 14:31:23
     staff edited the base down to 2649.80 via `edit-schedule-item` →
     `admin_update_schedule_base`, which writes `base_installment_amount`,
     `total_due_amount` and (only when already paid) `paid_amount` — but NEVER
     `status`. The allocation was now exactly full; nothing re-evaluated it.
     The account's `status` was likewise never recomputed, only its
     `remaining_balance`.
  2. **#17041 / #17174 / #17599 (2026-04-21) — penalty allocated in a later
     transaction than the installment.** In `allocate_payment_atomic`,
     `v_paid_amt` is written as the INSTALLMENT portion only, while `v_fully`
     tests `v_new_paid + v_row_pen`. When the penalty lands in a separate
     transaction, the earlier pass sees `v_row_pen = 0`, writes
     `partially_paid` and a base-only `paid_amount`. The later penalty
     allocation completes the ceiling but re-evaluates nothing.
- **Fix (cause 1):** `admin_update_schedule_base` now recomputes schedule status
  from non-voided allocations after the base write, UPWARD ONLY, and closes the
  account (`completed` + `completed_at`) when the balance is zero and no
  schedule row is left open. Both writes guarded. Applied via SQL 2026-08-03.
- **Fix (cause 2):** data-only correction of the 4 affected rows (`status` →
  `paid`, `paid_amount` → allocation sum), guarded so allocations exceeding the
  ceiling could not be swept in. No allocations deleted, no money moved — all
  three accounts were already `completed` with correct balances.
- **Verified:** `audit_account` returns `all_pass: true` for 19387, 17041,
  17174, 17599.
- **FALSE ALARMS during investigation — do not re-chase:**
  - `check_allocation_ceiling` was suspected of being bypassed. It was NOT.
    Re-checking all 18 rows across the three accounts gave `over_ceiling = 0.00`
    on every row; the trigger is enabled (`tgenabled = 'O'`) and correct. The
    apparent overage came from computing the ceiling off `base` alone while
    ignoring `penalty_amount`, which is non-zero on exactly those four rows.
  - The round-number "gaps" (4000/3000/2000/1000) were not missing money — they
    are legitimate `allocation_type = 'penalty'` rows from STEP A of the
    waterfall. `audit_account` CHECK 4 correctly passes them, since it only
    flags allocations exceeding the payment amount.
  - This is NOT the remainder-placement defect. `total_due_amount` equals
    `base + penalty + carried` on every affected row.
- **STILL OPEN (not fixed by this):** cause 2 has no structural prevention.
  `allocate_payment_atomic` still writes `v_paid_amt` installment-only while
  `v_fully` accounts for `v_row_pen`, so a penalty allocated in a separate
  transaction from its installment can still strand a row. No instances since
  2026-04-21.

### Bug #255 — Bug #165 REOPENED and superseded: extension requests still RLS-blocked for token customers (2026-08-15)

Bug #165's 2026-06-06 fix recreated two anon RLS policies on `extension_requests`, but was verified by reading the policy text, never by inserting through it as `anon`. The INSERT policy's `EXISTS` clause against `customer_portal_tokens` is evaluated as the `anon` role, and that table has no `anon` policy — only three policies, all `TO authenticated` gated on `is_staff(auth.uid())` — so the subquery always returned zero rows and `WITH CHECK` always failed with `42501`. Zero anon extension requests landed between 2026-06-05 and 2026-08-15; the only row in that period was session-auth (`portal_token` NULL).

Also corrects a claim in the original Bug #165 entry: it credited commit `90949f7` with making token-mode customers send `x-portal-token`. That is wrong — `src/lib/portal-auth.ts` returns `{}` for token mode and has been unmodified since 2026-05-05, so that header was never sent by token-mode customers. The SELECT-side symptom (duplicate-pending check always returning `[]`) was real, but not for the reason recorded.

**Fix**: superseded the direct-PostgREST-write architecture entirely rather than patching the RLS policy again. The write now goes through a new service-role edge function, `request-extension` (mirrors `submit-payment` and every other portal write): validates the caller via `resolvePortalAuth`, checks account ownership + `forfeited` status + the 7-day window + an already-pending guard, inserts with the service-role key (bypasses RLS by design), and fires the staff notification email server-side (the old client-side email call authenticated with the anon key, which the Bug #168 service-role gate on `send-transactional-email` rejects, so that mail had also been silently failing). `customer-portal`'s payload now includes `has_pending_extension` per account, computed service-side, so the pending-guard works for both auth modes without a client-side RLS-gated read. See CLAUDE.md DOMAIN ARCHITECTURE section: all customer-portal writes go through a service-role edge function now, as a standing rule — not a one-off fix.

### Bug #256 — cash orders excluded from retroactive enrollment award (2026-08-16)

Cash orders were excluded from the retroactive enrollment award because `get_recent_qualifying_order`'s cash branch required `loyalty_jpy_amount >= 10000` with no NULL tolerance and no derive path, while layaway had both (`loyalty_jpy_amount IS NULL` OR `>= 10000`, plus `derive_order_loyalty_jpy` to populate it). A cash order created while the customer was NOT yet a member always carries `loyalty_jpy_amount = NULL`, so it could never satisfy the cash branch's `>= 10000` filter and was invisible to the retroactive-award lookup no matter how recently it completed.

CJ-2026-06776 enrolled 11 minutes after cash order 19475 completed and received 0 points; `get_recent_qualifying_order` returned no row even at a 3650-day lookback, confirming this was a filter defect, not a timing/window issue.

**Fix**: `get_recent_qualifying_order`'s cash branch now accepts `loyalty_jpy_amount IS NULL` (mirrors layaway). `join-loyalty-program`'s cash branch now calls the new sibling RPC `derive_cash_order_loyalty_jpy(p_cash_order_id)` — mirroring the existing layaway `derive_order_loyalty_jpy` call — to populate `loyalty_jpy_amount` for that ONE cash order before `award-loyalty-points` runs. Formula: JPY → `total_amount`; PHP → `round(total_amount / php_jpy_rate)`. `shipping_fee` is deliberately NOT subtracted, matching layaway (which has no shipping column at all). See docs/RETROACTIVE-AND-EMAIL.md for the full derivation spec.

### Bug #257 — penalty-engine wrote a nonexistent column, silently breaking waiver reinstatement (2026-08-18)

`penalty-engine` (Step 3, the waived-to-unpaid UPDATE) wrote `waiver_status` on `penalty_fees` — a column that does not exist there; `waiver_status` belongs to `penalty_waiver_requests`. The UPDATE failed silently (error only logged, never surfaced), so a waived penalty on a row that went overdue again was never reinstated. Meanwhile the engine had already incremented `newPenaltyForItem` for that slot before attempting the write, so `layaway_schedule.penalty_amount` was inflated against a schedule row whose underlying `penalty_fees` row was still `status = 'waived'` — a drift that system-health-v2 Check 5 (schedule penalty vs non-waived penalty_fees sum) correctly flagged. Confirmed on invoice 18823 on both 2026-08-17 and 2026-08-18 (the failure was deterministic, not transient). Introduced by commit `99a8f150` (2026-06-13).

**Fix**: the erroneous `waiver_status` / `penalty_date` fields were dropped from the unwaive UPDATE (`status: "unpaid", waived_at: null` only — `penalty_date` is never rewritten, it records when the penalty was incurred). `newPenaltyForItem` is now only incremented AFTER the UPDATE succeeds, so a future write failure can no longer inflate the schedule total independently of the actual `penalty_fees` state. See CLAUDE.md and docs/SCHEMA-FACTS.md for the new grace-period + auto-unwaive behavior shipped alongside this fix.

### Bug #258 — gap downgrade re-charged an absence already settled by points expiry (2026-08-19)

`loyalty-inactivity-check` charged one inactivity period twice: once as points expiry, then again as a tier downgrade on the customer's return. Confirmed on CJ-2026-01504 (Vil Ma). Timeline: migrated 2026-05-15 at Glimmer / ¥972,844 cumulative. On 2026-07-25 the expiry path fired exactly on day 180 from her last order (2026-01-26) and expired all 1,880 points — but the tier drop was a no-op because she was already at Glimmer (`display_order = 1`, so `nextLower` resolves to the same tier and `tierChanged = false`). Line 338 therefore left `is_downgraded = false` and wrote no baseline, leaving the gap path's only dedup guard disarmed. Zeroed points then removed her from the nightly candidate set entirely via the `.gt("remaining_points", 0)` filter (line 172), so nothing re-examined the gap for 24 days. During the whole absence `gapBetweenLastTwo` read 113 days (2026-01-26 vs 2025-10-05) — under the 180 threshold — because the gap clock measures the interval between the two most recent *past* orders and therefore cannot fire while a customer is absent.

On 2026-08-18 order 19478 (loyalty spend ¥136,980) correctly promoted her Glimmer → Radiant, crossing Radiant's ¥1,000,000 `min_spend_jpy` at ¥1,109,824 cumulative, and awarded 2,600 points at the ratcheted-up Radiant 2× multiplier per the locked ratchet-up rule (Bug #98). That single award simultaneously re-armed all three preconditions: it restored `remaining_points` (back into the candidate set), lifted `display_order` above 1, and rewrote `topTwo` so the same absence now measured 202 days instead of 113. The next nightly run at 2026-08-19 00:25 stripped the tier she had earned 16 hours earlier. Net symptom: Glimmer badge with Radiant-rate points.

**Fix**: the gap path now skips the downgrade when an `expired` transaction falls inside the gap window `[topTwo[1], topTwo[0]]` — that absence has already been charged as points forfeiture and must not be charged again as a tier drop. A window test is required rather than "newer than the last expiry": a member expired long ago who then opens a genuinely new unsettled gap must still be downgraded. Skips increment `summary.downgrades_skipped_settled`. The gap path's legitimate safety-net role is preserved — a zero-point member never expired during the gap has no settlement record and is still downgraded on return. `award-loyalty-points` was not touched; the 2,600-point award was correct. CJ-2026-01504 was repaired in SQL to Radiant / `is_downgraded` false / baseline NULL; cumulative ¥1,109,824 and the 2,600-point lot were left untouched as correct.

### Bug #259 — delete-cash-order revoke failed silently on an unknown trigger_event (2026-08-25)

`delete-cash-order` called revoke-loyalty-points with `trigger_event: "delete_cash_order"`, which is not a key of TRIGGER_TO_REASON. The revoke returned 400 at the validation guard before touching any points. The call is fire-and-forget by design (mirroring delete-account), so the deletion completed and only a console.error was emitted. Net effect: deleting a cash order that had awarded loyalty points left those points and their cumulative spend on the member permanently. Found when deleting "Test-007 Tier upgrade" produced no `revoked` transaction and no change to CJ-2026-05088's balance. Fixed by sending `delete_account`, which maps to RevokeReason `account_deleted`. Affected only cash order deletions between the delete-cash-order deploy and this fix.
