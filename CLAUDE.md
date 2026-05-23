# Cha Jewels Layaway System — Claude Code Context

## ⚠️ MAINTENANCE — READ BEFORE EDITING THIS FILE

This file is the LEAN CORE: durable, always-load rules only. Trimmed from 425 KB
to ~52 KB on 2026-05-22. Detailed history, status, and feature mechanics live in
`docs/` and are read on demand — NOT injected every turn.

Where new content goes (do NOT append it here):
- A rule changes (formula, invariant, enum, cap) → edit that section IN PLACE here. No dated changelog entries.
- A bug is fixed → append to docs/FIXED-BUGS.md
- A new open bug / pending task → docs/OPEN-BUGS.md or a GitHub issue
- Session status / "what we did" → handled automatically by claude-mem; do NOT log here
- A new feature shipped → docs/ (new or existing file)
- A new audit RPC → docs/AUDIT-RPCS.md
- An operational learning / schema note → docs/SCHEMA-FACTS.md

NEVER append changelogs, status snapshots, or bug logs to this file — that is what
ballooned it to 425 KB. Keep the core small.

Reference docs (read the relevant one when a task touches that area):
- docs/FIXED-BUGS.md — fixed-bug history (do not reintroduce)
- docs/OPEN-BUGS.md — known open bugs
- docs/PENDING.md — pending items / roadmap
- docs/SYSTEM-STATUS.md — point-in-time status snapshot
- docs/AUDIT-RPCS.md — full SQL of audit_account / audit_all_accounts
- docs/INVOICE-GENERATOR.md — invoice generator feature
- docs/CASH-ORDERS.md — cash order confirm/expiry/partial-payment mechanics
- docs/SCHEMA-FACTS.md — schema facts, operational learnings, proof-of-payment, account notes
- docs/RETROACTIVE-AND-EMAIL.md — retroactive enrollment award + email rate limit
- docs/LOYALTY-LIFECYCLE.md — loyalty lifecycle integration (Bug #99)
- docs/HEALTH-CHECKS.md — health checks 15-21 + periodic health queries
- docs/KNOWN-ISSUES.md — DP-detection caveats
- docs/VERIFICATION.md — how to run account health verification
- docs/TEST-ACCOUNTS.md — benchmark test account setups (TEST-001..005)
- docs/AUTO-DEPLOY.md — VERIFY: may be stale (deploy is now via Lovable IDE)
- docs/PORTAL-PIN-AUTH.md — VERIFY: may be stale (portal migrated to email/password)
- docs/RECENT-UPDATES.md — older changelog (archived)

## CURRENCY CONVERSION STANDARD — NON-NEGOTIABLE

  JPY = PHP ÷ php_jpy_rate       ← divide to go PHP → JPY
  PHP = JPY × php_jpy_rate       ← multiply to go JPY → PHP

  Example (rate = 0.42):
    ₱10,000 ÷ 0.42 = ¥23,810   ✓ CORRECT
    ₱10,000 × 0.42 = ¥4,200    ✗ WRONG

  NEVER multiply PHP by rate to get JPY — this is always wrong.
  NEVER divide JPY by rate to get PHP — this is always wrong.

  This applies to ALL RPCs, edge functions, frontend calculations,
  and business-rules.ts toJpy() function.

  The rate represents: ¥1 = ₱[rate]  (e.g. ¥1 = ₱0.42)
  Stored in: system_settings WHERE key = 'php_jpy_rate' (jsonb scalar)

  Frontend:  src/lib/currency-converter.ts → toJpy() / phpToJpy()
             uses Math.round(phpAmount / rate)  ✓

  SQL RPCs:  CASE WHEN currency = 'JPY' THEN amount
                  WHEN currency = 'PHP' THEN amount / rate
                  ELSE amount END              ✓

  get_forecast_6m() returns raw (month, currency, remaining) rows —
  NO conversion in SQL. Frontend calls toJpy() per row.

## DOMAIN ARCHITECTURE — STRICT RULE (NON-NEGOTIABLE)

  This rule has been violated repeatedly. Anyone reading this file
  (human, Claude, Lovable, future-self) MUST apply it before suggesting,
  testing, documenting, or sharing any URL with a chajewelsjp.com host.

  TWO SUBDOMAINS, TWO AUDIENCES — NO EXCEPTIONS:

    portal.chajewelsjp.com   →   CUSTOMERS ONLY
    app.chajewelsjp.com      →   INTERNAL ONLY (admin, staff, CSR, finance)

  ALL customer-facing routes use portal.chajewelsjp.com:
    /portal                   customer home
    /portal/login             customer email/password sign-in (Phase B)
    /portal/setup             customer email/password signup (Phase B)
    /portal/forgot-password   customer password reset request (Phase B)
    /portal/reset-password    customer password reset completion (Phase B)
    /loyalty                  customer loyalty portal
    Token-based legacy paths  /portal?token=X, /loyalty?token=X

  ALL internal/employee routes use app.chajewelsjp.com:
    /login                    admin/staff/CSR/finance sign-in
    /dashboard, /customers, /finance, /operations, /loyalty-admin, etc.

  BEFORE suggesting, testing, sharing, or documenting ANY URL with
  a chajewelsjp.com host, check the audience:
    Customer-facing?     →   portal.*
    Internal/employee?   →   app.*

  FORBIDDEN PATTERNS (these are recurring violations):
    - Telling a customer to visit app.chajewelsjp.com for any reason
    - Suggesting app.chajewelsjp.com/portal/... as a test URL
    - Including app.chajewelsjp.com in customer-facing emails, share
      buttons, marketing copy, QR codes, or print materials
    - Internal staff using portal.chajewelsjp.com for their work
    - Mixing the two in walkthroughs or screenshots

  The two subdomains may serve the same React build but route by host.
  They are functionally separate. The customer must NEVER see
  app.chajewelsjp.com. Internal staff must NEVER use
  portal.chajewelsjp.com for their work.

## TEST ACCOUNT EXCLUSION — NON-NEGOTIABLE

Real accounts have purely numeric invoice numbers. All test/scaffolding accounts have non-numeric invoices (families: TEST-001..005, CJ-2026-*). The canonical exclusion applied to EVERY operational and financial surface is: keep numeric only — SQL `invoice_number ~ '^[0-9]+$'`; PostgREST `.filter('<embed>.invoice_number','match','^[0-9]+$')`. The old `TEST-%`/`TEST%` filters are INCOMPLETE (miss the CJ- family) and must be replaced by this rule.

Status (2026-05-23): applied across all frontend surfaces (Dashboard, Finance, CSR Monitoring, CSR Alerts, Smart Reminders, Extensions, Audit panels) and all 20 SQL reporting RPCs (13 fc_*, get_collection_analytics, get_monthly_sales, get_monthly_analytics, get_aging_buckets, get_forecast_6m, get_forecast_drilldown, get_top_outstanding_customers). Also enforced in the dashboard-summary EDGE FUNCTION — every layaway_accounts query plus the cash_orders and layaway_accounts payment joins use .filter('<embed>.invoice_number','match','^[0-9]+$'); this powers all Overview headline KPIs (Total Receivables, Predicted, Collections This Month, etc.).

Finance dashboard client-side cascade: useAccounts() returns rawAccounts (unfiltered); Finance.tsx derives `accounts` = rawAccounts filtered to /^[0-9]+$/.test(invoice_number). Every downstream memo inherits it — accountMap, collFiltered (via accountMap.has(p.account_id)), totalForfeitedCollected, recentCompleted. One root filter, all figures clean.

Documented exception: get_staff_performance is intentionally NOT numeric-filtered — it counts confirmed payment_submissions per reviewer (a staff-activity metric), so test-account submissions are legitimately counted as real staff actions. The other unfiltered helpers (get_bulk_setup_invite_candidates, get_recent_qualifying_order, get_unpaid_schedule) are operational, not dashboard counts.

Resolved this sweep: get_monthly_sales ALL-mode currency-conversion bug fixed (#132); get_monthly_analytics + get_aging_buckets numeric filters added (#133); the get_collection_analytics concern is closed — collection_rate is now a true capped efficiency = collected_due / expected, both summed from schedule_with_actuals by due-month (#137).

Re-runnable audit — find any reporting function still missing the filter:
  SELECT p.proname, (pg_get_functiondef(p.oid) LIKE '%^[0-9]+$%') AS has_numeric_filter
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'get%' OR p.proname LIKE 'fc%')
  ORDER BY has_numeric_filter, p.proname;
  Expected false only for the four helpers named above — none are financial dashboard counts.

## PERMISSION RESOLUTION ORDER

When checking whether a user can perform an action:

  1. user_permission_overrides WHERE user_id = this_user
       → if a row exists for this permission_key, use granted value
  2. role_permissions WHERE role = user's role
       → fallback when no override exists
  3. admin role → always full access regardless of any override

  Table: user_permission_overrides (user_id, permission_key, granted)
  Managed via Settings → Permission Matrix → By Member view
  RLS: admins only (has_role(auth.uid(), 'admin'))

## total_amount DEFINITION — NON-NEGOTIABLE (updated 2026-04-12)

  layaway_accounts.total_amount = TOTAL ACCOUNT OBLIGATION.
  Includes: downpayment_amount + SUM(base_installment_amounts) + SUM(account_services)
  Services are included in total_amount at the time of service creation.

  The following operations MUST NOT write to total_amount:
  - Adding a penalty (add-penalty, recalculate-penalties)
  - Waiving a penalty (approve-waiver)
  - Recording a payment (record-payment, record-multi-payment)
  - Reconciliation (reconcile-account, daily-reconciliation)

  The only legitimate writes to total_amount are:
  - create-layaway-account  (initial set)
  - edit-account            (admin correction — admin only, via EditAccountDialog)
  - add/delete installment  (AccountDetail.tsx schedule editor)
  - add-service             (adds service amount to total_amount)

  Canonical remaining_balance formula:
    remaining_balance = total_amount + Σ(non-waived penalty_fees) - Σ(non-voided payments)
    total_paid        = Σ(payments.amount_paid WHERE voided_at IS NULL)

  NOTE: Services are already in total_amount — do NOT add services separately
  in the remaining_balance formula. Only penalties are added separately.

  Never compute total_paid from SUM(schedule.paid_amount) — schedule rows are
  derived data; payments table is the single source of truth.

## CALCULATION STANDARD — NON-NEGOTIABLE (updated 2026-04-12)

### Core Formula
  totalLAAmount     = total_amount + activePenalties
                      (services are already in total_amount — do NOT add separately)
  remainingBalance  = totalLAAmount - totalPaid

### Penalty Status Rules
  | status | counts in activePenalties? | meaning                       |
  |--------|---------------------------|-------------------------------|
  | active | YES                       | penalty charged, not yet paid |
  | paid   | YES                       | penalty charged and collected |
  | waived | NO                        | penalty forgiven, excluded    |

  activePenalties = SUM(penalty_fees.penalty_amount)
                    WHERE status != 'waived'
                    (includes both 'active'/'unpaid' and 'paid')

### Why paid penalties stay in totalLAAmount
  A paid penalty was a legitimate charge that increased the account obligation.
  The customer paid it. It must remain in totalLAAmount or the balance will be
  artificially reduced.

### sumOfPendingMonths reconciliation
  sumOfPendingMonths = SUM(layaway_schedule.total_due_amount)
                       WHERE status IN ('pending', 'overdue', 'partially_paid')

  This MUST equal remainingBalance within ₱1 tolerance.
  If it does not → schedule rows are stale and need resyncing.

### Waiver rule
  When a penalty is waived:
  - penalty_fees.status = 'waived', waived_at = now()
  - It is EXCLUDED from activePenalties
  - remainingBalance DECREASES by the waived amount
  - The corresponding layaway_schedule.total_due_amount must be reduced
    by the waived penalty_amount
  - If penalty was already paid before waiver request → status stays 'paid',
    CANNOT be waived retroactively

### totalPaid
  totalPaid = SUM(payments.amount_paid) WHERE voided_at IS NULL
  (includes downpayment + all installment payments + penalty payments)
  layaway_accounts.total_paid must always be kept in sync with this.

### Penalty display (admin + customer portal)
  penalty_fees.status = 'paid'         → green "Paid"
  penalty_fees.status = 'waived'       → gray strikethrough "Waived"
  penalty_fees.status = 'unpaid'          → red "Applied"

## Account Creation Rules

- Downpayment is NEVER marked paid at creation
- `dp_paid` always starts at 0; `total_paid = 0` on new accounts
- DP is only marked paid after payment submission is validated by staff
- Never bypass the payment validation flow
- The "Downpayment Paid" input field does NOT exist on the creation form
- DP redistribution into installments is NOT supported (removed)

## PAYMENT HISTORY AS SOURCE OF TRUTH — NON-NEGOTIABLE

  payments table is the SINGLE source of truth for all money received.
  layaway_schedule.paid_amount must ALWAYS reflect payment_allocations,
  which in turn must reflect the payments table.

  Sync chain:
    payments → payment_allocations → layaway_schedule.paid_amount → account totals

  Invariants:
    SUM(payment_allocations WHERE allocation_type='installment' AND schedule_id=X)
      ≈ layaway_schedule.paid_amount for row X

    SUM(non-voided payments.amount_paid) for account
      ≈ account.total_paid

  Automatic enforcement:
    1. record-payment and record-multi-payment invoke reconcile-account after
       each successful payment (real-time sync).
    2. daily-reconciliation edge function runs once per day for all accounts.
       Completion timestamp stored in system_settings.key = 'last_daily_reconciliation'.
    3. System Health Check 15 (CRITICAL) detects accounts where installment
       payments exceed schedule.paid_amount — flags stale schedule rows.
    4. System Health Check 16 detects non-DP payments in last 24h without allocations.
    5. System Health Check 17 verifies daily-reconciliation ran within 25 hours.

  reconcile-account edge function:
    Body: { account_id } or { invoice_number }
    Behavior: REPORT-ONLY (no DB writes since Bug #34 fix 2026-04-20)
    Steps: load data → compute canonical drift → INSERT one row to
           reconciliation_log
    Does NOT write to: penalty_fees, layaway_schedule, layaway_accounts
    Drift detection currently covers: account.total_paid,
    account.remaining_balance, account.status, schedule.status,
    schedule.paid_amount
    NOT yet covered (known gap, verified 2026-05-17): penalty_fees
    status vs payment_allocations consistency — accounts can have
    categorization noise (penalty allocations recorded as 'installment'
    type) that this drift checker does not surface. See Resolved
    Bug #7 entry for empirical details.
    CANONICAL PATTERN (confirmed 2026-05-18): the earlier
    aspirational description ("create missing allocations → sync
    schedule → auto-waive penalties → recalculate totals") was
    never the actual behavior — reconcile-account only writes a
    reconciliation_log drift row. Any function that needs
    allocations / schedule sync / account totals applied MUST
    inline those writes itself; calling reconcile-account does
    NOT fix anything. Reference implementation: process-loyalty-
    redemption Phase B Patch 2 (commit 8130ace) — inline waterfall
    allocation + per-row schedule UPDATE + account totals UPDATE.

## ENUM VALUES — NON-NEGOTIABLE

### penalty_fee_status
  Valid values: 'unpaid' | 'paid' | 'waived'
  - unpaid: penalty charged, not yet collected
  - paid:   penalty charged and collected
  - waived: penalty forgiven by admin — excluded from totals

  NEVER use 'active' — it does not exist in this enum.
  Any code filtering WHERE status = 'active' on penalty_fees is a bug.

### account_status
  Valid values: 'active' | 'overdue' | 'completed' | 'cancelled' |
                'forfeited' | 'final_forfeited' | 'extension_active' |
                'reactivated' | 'final_settlement'

### schedule_status
  Valid values: 'pending' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'

## PLAN CONFIGURATIONS — NON-NEGOTIABLE

  Stored in: plan_configurations table
  Columns: plan_months, display_label, min_amount_jpy, min_amount_php,
           dp_percentage, is_active, risk_tier

  Current plans:
    3M  → no minimum, LOW risk
    6M  → no minimum, LOW risk
    8M  → min ¥300,000 / ₱126,000, MODERATE risk
    10M → min ¥600,000 / ₱252,000, HIGH risk
    12M → min ¥1,000,000 / ₱420,000, CRITICAL risk

  Enforcement:
  - DB trigger: trg_enforce_plan_minimum fires BEFORE INSERT OR UPDATE
    on layaway_accounts — blocks total_amount below minimum for plan
  - Applies to JPY and PHP accounts separately using correct minimum
  - 3M and 6M have min = 0 — trigger passes through immediately
  - Never hardcode plan minimums in UI — always read from plan_configurations

## PAYMENT ALLOCATION RULES

  Exact payment:    status → paid. No carry. total_due_amount = base (unchanged).

  Overpayment:      current month set to paid. Surplus waterfalls to next pending
                    months (reduces their total_due_amount).

  Underpayment:     status → partially_paid.
                    paid_amount = amount received.
                    Next row: COMPLETELY UNTOUCHED. No changes.

    carry_over (manual staff action only):
                    Staff clicks Carry Over button in AccountDetail UI.
                    Calls carry-over edge function.
                    Source row → paid. Next row gets carried_amount = shortfall.
                    NEVER happens automatically.

  NEVER:
    - Change base_installment_amount for any of the above
    - Inflate total_due_amount on next row
    - Auto-carry without explicit admin button click
    - Call accept-underpayment to perform carry (it is audit-log only)

  total_due_amount semantics by status:
    pending / overdue:    base_installment_amount + penalty_amount + carried_amount (full amount owed)
    partially_paid:       full amount owed (base + penalty + carried) — paid_amount tracked separately
    paid:                 amount actually paid (= paid_amount)

  When processing an existing partially_paid row in edge functions:
    total_due_amount holds the FULL amount owed (base + penalty + carried),
    independent of paid_amount. Remaining for the row is computed as
    total_due_amount - paid_amount at read time.

    audit_account() Check 12 enforces this semantic by subtracting
    paid_amount from total_due_amount for partially_paid rows when
    summing pending months.

  CACHE-STALENESS TEST (added 2026-05-23 — prevents the misdiagnosis logged in OPEN-BUGS "Schedule cache staleness"):
    Because total_due_amount is the GROSS (above) and per-row remaining is
    total_due_amount − paid_amount (= actual_remaining = total_due − allocated
    in the view), total_due_amount ≠ actual_remaining on a non-paid row is
    EXPECTED whenever any payment is allocated — that gap is the payment, NOT
    drift. A row is genuinely stale ONLY when:
      total_due_amount ≠ base_installment_amount + penalty_amount + carried_amount
    Repair a genuine stale row by resetting total_due_amount to that GROSS sum
    (leave paid_amount / allocated untouched). NEVER flatten total_due_amount to
    actual_remaining — that overwrites the gross and breaks void/restore.

## Git Workflow

- Commit and push all changes directly to **main** branch
- Do NOT create feature branches unless explicitly asked

## TOOL OWNERSHIP RULES (updated 2026-05-10)

  Lovable → src/ AND supabase/functions/ file creation and editing.
            Lovable ALSO handles ALL Supabase edge function
            deployments via direct Supabase Dashboard tooling access.
  Claude Code → src/ AND supabase/functions/ editing when explicitly
                directed by Cynthia. Default mode is read-only audit
                and diagnosis. May commit and push to git when asked.
  Cloud Shell → git operations only (pulls, merges, pushes, repo
                audits). Cynthia has NO direct Supabase deployment
                access — NEVER suggest `npx supabase functions deploy`
                from Cloud Shell. If a function appears stale,
                escalate to Lovable to redeploy via Supabase
                Dashboard tooling.
  Supabase SQL Editor → database changes only (pure SQL)

  Practice rules (apply to both Lovable and Claude Code):
  - No prompt written without plan confirmed first.
  - No step executed without explicit go signal from Cynthia.
  - SQL changes are applied in the SQL Editor by Cynthia and are NOT
    committed to repo as migrations unless explicitly told to.

  CLAUDE.md is the single source of truth — both Lovable and
  Claude Code must read it before any changes.

## Project Overview

Jewelry layaway management system built with:

- React + TypeScript
- Tailwind CSS
- Supabase (database + edge functions)
- Vite

## Key Files to Read First

- src/lib/business-rules.ts (calculation engine)
- src/components/AccountDetail.tsx (main account view)
- src/components/MultiInvoicePaymentDialog.tsx (split payment)
- supabase/functions/ (edge functions)

## Core Calculation Rules (NEVER change these)

All values come from computeLayaway() in business-rules.ts

  totalLAAmount = baseLA + non-waived penalties + services
  totalPaid = downPayment + Σ(actualPaid of PAID/PARTIAL months)
  remainingBalance = totalLAAmount - totalPaid

## Display Rules (NEVER break these)

### Dates

  Schedule list → always show due_date (when payment is due)
  Payment History → always show created_at (when payment was made)
  NEVER mix these two

### Amounts

  - Drop .00 on whole numbers: ₱3,956 not ₱3,956.00
  - Keep 2 decimals when non-zero: ₱22,103.27
  - Always use ₱ symbol
  - Comma separators: ₱22,103.27
  - Never show ₱0 penalties

### Customer Message Templates

  SINGLE PAYMENT:
  Thank you for your payment. ₱ [amount] has been received.
  Inv # [invoiceNumber]
  View your updated account and payment schedule here:
  🔗 [portalLink]
  Next payment: [nextDueMonth] — ₱ [nextMonthAmount]
  Thank you for your continued trust in Cha Jewels! 🧡

  ---

  SPLIT PAYMENT (2+ accounts same customer):
  Thank you for your payment. A total of ₱ [totalAmount]
  has been received across [N] accounts:
    Inv #[num] — [label]: ₱ [amount]
    Inv #[num] — [label]: ₱ [amount]
  View your accounts here:
  🔗 [portalLink]
  Next payments:
    [label] — [nextDueMonth]: ₱ [nextDueAmount]
    [label] — [nextDueMonth]: ₱ [nextDueAmount]
  Thank you for your continued trust in Cha Jewels! 🧡

  ---

  FULLY PAID:
  Same as single but replace next payment line with:
  🎉 Your layaway is now fully paid! Thank you!

  ---

  BATCH PAYMENT (individual account after multi-invoice):
  Your account has been updated.
  Inv # [invoiceNumber]
  View your account here:
  🔗 [portalLink]
  Thank you for your continued trust in Cha Jewels! 🧡

## Monthly Row Display Rules

  IF penalty > 0 AND not waived:
    ✅ Nth month Mon YY: ₱ [base] + ₱ [penalty] (Penalty) = ₱ [total] (PAID)
  IF no penalty or waived:
    ✅ Nth month Mon YY: ₱ [base] (PAID)
  Never show "+ ₱0 (Penalty)"

## Payment Recording Rules

Every payment operation must update ALL 3 tables atomically:
  1. payments table — insert actual cash received
  2. schedule_items — update paid_amount and status
  3. penalty_fees — update status if penalty was paid

Never update one without the others.
Use edge functions with transactions to ensure atomicity.
If any of the 3 updates fail, roll back all of them.

## Ghost Amount Prevention

When completing a partially_paid month:
  - Set paid_amount = total_due_amount exactly
  - Set status = 'paid'
  - Never carry over excess to next month
  - Next month stays pending with paid_amount = 0

## SYSTEM INVARIANTS (permanent — never violate)

  INVARIANT 1 — total_paid source:
    ONLY: SUM(payments.amount_paid WHERE voided_at IS NULL)
    NEVER: payment_allocations or layaway_schedule.paid_amount

  INVARIANT 2 — per-row remaining source:
    ONLY: schedule_with_actuals.actual_remaining
    NEVER: layaway_schedule.total_due_amount or paid_amount

  INVARIANT 3 — waterfall order:
    ALWAYS: earliest actual_remaining > 0 first (due_date ASC)
    NEVER: skip a month with actual_remaining > 0

  INVARIANT 4 — payment ceiling:
    NEVER accept payment > account.remaining_balance

  INVARIANT 5 — carry-over storage:
    ONLY: layaway_schedule.carried_amount via carry-over edge function
          (manual staff action)
    NEVER: inflate total_due_amount on any row
    NEVER: write carried_amount from accept-underpayment
    NEVER: write carried_amount automatically on underpayment

  INVARIANT 6 — total_paid direction:
    INCREASES: record-payment only
    DECREASES: void-payment only
    NEVER decreases via reconcile-account

  INVARIANT 7 — base_installment_amount:
    Set at schedule creation only
    NEVER modified after creation under any circumstance
    Enforced by DB trigger: prevent_base_amount_change

  INVARIANT 8 — paid schedule row freeze:
    Once layaway_schedule.status = 'paid', these fields are frozen:
    status, paid_amount, total_due_amount
    Enforced by DB trigger: enforce_paid_row_freeze
    Rules:
    - Rule 1: bypass flag app.allow_paid_row_edit = 'true' allows all changes
    - Rule 2: paid_amount decreasing → allowed (void-payment)
    - Rule 3: paid_amount increasing within ceiling → allowed (restore-payment)
    - Rule 4: paid_amount increasing beyond ceiling → BLOCKED (waterfall over-allocation)
    NEVER modified by: waterfall, reconcile, Keep handler, carry-over

  INVARIANT 9 — total_amount admin-only writes:
    total_amount on layaway_accounts can only be changed by admin.
    Enforced by DB trigger: prevent_total_amount_change
    Bypass: app.allow_total_amount_edit = 'true' (edge functions only)
    NEVER modified by: non-admin users, direct PostgREST calls
    Edge functions with bypass:
    - add-installment (admin only, bypass flag set)
    - delete-installment (admin only, bypass flag set)
    - add-service (admin only, bypass flag set)
    Client-side writes: NONE — all routes through edge functions

  INVARIANT 10 — loyalty award basis:
    Award amount is derived from layaway_accounts.loyalty_jpy_amount
    (committed at account creation = full layaway commitment), NOT from
    payment.amount_paid. Editing payment amount does not adjust loyalty.
    Voiding an installment payment does not revoke loyalty (only DP voids
    do, per CLAUDE.md DP detection heuristic). See LOYALTY LIFECYCLE
    INTEGRATION section for full lifecycle wiring.

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
    auto-expire-cash-orders:       00:30 UTC = 08:30 PHT ✅
    deactivate-expired-promotions: every hour            ✅
    loyalty-notification-queue:    every hour            ✅
    fc-alert-evaluation:           every 30 minutes      ✅
    process-email-queue:           every 5 seconds       ✅
    cleanup-loyalty-images:        Sun 03:00 UTC = Sun 11:00 PHT ✅

  ORDERING RULE — never violate this sequence:
    1. Reminders fire first (before penalties)
    2. Penalty engine runs after reminders
    3. Auto-forfeit runs after penalty engine
    4. Reconciliation runs after forfeitures
    5. Loyalty inactivity check runs last
       (needs fully reconciled account data)
    6. daily-reconciliation must never be scheduled
       before 00:15 UTC

  RACE CONDITION RULE (RETIRED 2026-05-20):
    The duplicate daily-payment-reminders cron was removed
    2026-05-20 — daily-send-reminders is now the sole reminder
    cron. The 2-minute offset rule no longer applies. NEVER
    re-add a second cron pointing at /send-reminders — see
    EMAIL SENDING — LOVABLE WORKSPACE RATE LIMIT for why.

## DISPLAY RULES (permanent)

  ALL schedule display reads from schedule_with_actuals view
  actual_remaining → only source for per-row remaining
  allocated        → only source for per-row paid amount
  computed_status  → only source for row status in display
  paid_amount and total_due_amount → write-only caches, never read for display
  All next-payment logic → getNextPaymentRow() from business-rules.ts
  All pending sum logic  → sumPendingRows() from business-rules.ts
  No inline reimplementation of canonical functions permitted

## CHART TERMINOLOGY (display convention — added 2026-05-23)

Consistent labels across the Finance dashboard. The underlying metrics are unchanged — only the labels were standardized.

  "Collected" / "Total Collected" = cash actually received, bucketed by PAYMENT DATE.
    Source: get_monthly_analytics.collected_jpy (SUM payments by date_paid) and
    get_collection_analytics.collected. Shown in: Overview Monthly Performance bar/stat,
    and the Analytics "Collected vs Sales" chart.

  "Paid vs Due" chart = collection efficiency against the schedule.
    "Paid" = collected_due (payments allocated to each month's installments, bucketed by
    DUE month, capped at expected). "Due" = expected. Drives Best Month / Average Rate.
    (Formerly mislabeled "Collected vs Expected", which collided with the cash "Collected".)

  "Penalties Collected" = penalty_fees WHERE status='paid'. Same metric on both Overview
    and Analytics (Overview's former "Penalties Paid" was renamed to match).

  Forfeited — two DIFFERENT metrics, do not conflate:
    "Total Forfeited" (Overview) = remaining balance LOST on forfeited/final_forfeited accounts.
    "Recovered (Forfeited)" (Analytics) = cash COLLECTED from forfeited accounts before
    forfeiture (6-month window, excludes final_settlement).

  RULE: "Collected" always means cash received. The schedule-efficiency metric is "Paid vs Due",
  never "Collected".

## VIEW FIELD MAPPING

  schedule_with_actuals vs layaway_schedule (write-only cache):
    OLD paid_amount       → NEW allocated
    OLD total_due_amount  → NEW actual_remaining (for display)
    OLD status            → NEW computed_status (display) / db_status (writes)

## CARRY-OVER RULES (updated 2026-03-29)

  Underpayment default behavior:
    When a payment underpays a month, the row is marked 'partially_paid'.
    The next row is COMPLETELY UNTOUCHED — no carry is written automatically.
    This is enforced in review-payment-submission (auto-carry removed 2026-03-29).

  Carry-over is a MANUAL STAFF DECISION ONLY:
    Staff clicks the "Carry Over" button on a partially_paid row in AccountDetail.
    This calls the carry-over edge function (NOT accept-underpayment).

  carry-over edge function (updated 2026-04-19):
    Endpoint: /functions/v1/carry-over

    total_due_amount formula:
      CORRECT: total_due_amount = existing_total_due_amount + shortfall
      WRONG:   total_due_amount = base_installment_amount + shortfall
      This preserves all previous Keep reductions on the destination row.
    Body: { schedule_row_id, account_id }
    Auth: Bearer token + admin role required
    Steps:
      1. Validates source row status === 'partially_paid'
      2. Validates source row paid_amount > 0
      3. Computes shortfall from source.paid_amount (NOT SUM of allocations)
         shortfall = ceiling (base + penalty + carried) - paid_amount
      4. Finds next row by installment_number + 1
      5. Marks source row as 'paid' with paid_amount preserved
      6. Writes carried_amount = shortfall to next row, clears carried_by_payment_id
      7. Reverts step 5 if step 6 fails
    Net effect: source row closes as paid, next row carries the shortfall

  accept-underpayment edge function:
    Purpose: Records AUDIT LOG only when staff acknowledges an underpayment
    What it does NOT do: Does NOT write carried_amount, does NOT mark source
    row as paid, does NOT touch next row
    Net DB effect: Zero row changes — audit log entry only

  carried_amount column:
    Written ONLY by the carry-over edge function
    Cleared by void-payment when a payment that triggered carry is voided
    NEVER written by accept-underpayment
    NEVER written by inflating total_due_amount
    NEVER written automatically on underpayment

  FORBIDDEN:
    - Auto-carry on underpayment
    - Inflating total_due_amount on any row
    - Writing carried_amount from accept-underpayment
    - carried_amount written when source row is still partially_paid
    - Running carry-over on a paid source row (must be partially_paid)
    - Writing carried_amount without a valid carried_from_schedule_id
    - Writing carried_amount when source row paid_amount = 0
    - Adding services separately to remaining_balance (services are in total_amount)

## CARRIED_AMOUNT PRESERVATION (added 2026-05-21)

  total_due_amount = base_installment_amount + penalty_amount + carried_amount
  on EVERY recompute. carried_amount is part of the row's full obligation and
  must be re-added whenever total_due_amount is rewritten.

  Recompute sites: penalty-engine (Step 5 + Step 5b self-heal), add-penalty, approve-waiver.

  INVARIANT 5 ("never inflate total_due_amount") means never inflate WITHOUT a
  backing carried_amount/allocation — including the legitimate carried_amount is REQUIRED, not forbidden.


## CUSTOMER CODE STANDARD (added 2026-04-19)

  Format: CJ-YYYY-XXXXX
  - CJ = Cha Jewels
  - YYYY = year customer was created
  - XXXXX = 5-digit sequential number incrementing by 8 per year
  - Example: CJ-2026-00008, CJ-2026-00016, CJ-2026-00024

  Auto-generated by DB trigger: auto_generate_customer_code
  BEFORE INSERT on customers table
  All 484+ existing customers backfilled ✅

  Used for cross-platform synchronization with Loyalty App.
  This is the universal customer identifier across all Cha Jewels platforms.

### Forensic repair (manual customer_code edits)

  If a customer_code is ever corrupted (e.g., a row backfilled
  from an external source with malformed data, or a manual
  override before the EditCustomer lock landed on 2026-04-28),
  the only repair path is direct SQL Editor.

  After the prevent_customer_code_change trigger landed
  (2026-05-08), forensic repairs require a transaction-scoped
  GUC bypass via SET LOCAL. Without it, the UPDATE fails with:
  "customer_code is immutable post-creation..."

    BEGIN;
    SET LOCAL app.allow_customer_code_change = 'on';
    UPDATE public.customers
       SET customer_code = 'CJ-YYYY-XXXXX'
     WHERE id = '<uuid>';
    INSERT INTO public.audit_logs
      (entity_type, entity_id, action,
       old_value_json, new_value_json,
       performed_by_user_id)
    VALUES ('customer', '<uuid>',
            'manual_customer_code_repair',
            jsonb_build_object('customer_code', '<old>'),
            jsonb_build_object('customer_code', 'CJ-YYYY-XXXXX'),
            auth.uid());
    COMMIT;

  EditCustomerDialog UI does NOT allow customer_code edits
  (locked 2026-04-28 after the Charm Monaka incident — see
  Known Fixed Bugs #54).

## PENALTY STANDARD — NON-NEGOTIABLE (added 2026-04-12)

### PHP accounts:
  - Week 1: ₱500 per event
  - Week 2: ₱500 per event
  - Non-final months (months 1 to n-1): cap ₱1,000 (2 events — Cycle 1 only)
  - Final month only (installmentNumber === planMonths): cap ₱3,000 (6 events — Cycles 1+2+3)

### JPY accounts:
  - Week 1: ¥1,000 per event
  - Week 2: ¥1,000 per event
  - Non-final months (months 1 to n-1): cap ¥2,000 (2 events — Cycle 1 only)
  - Final month only (installmentNumber === planMonths): cap ¥6,000 (6 events — Cycles 1+2+3)

### Grace period rule (updated 2026-04-13):
  - Grace period (7 days) is NOT permanently consumed.
  - It applies when ALL of these are true:
    * Account has an overdue row within 7 days of due date
    * No UNPAID penalties exist on any schedule row
    * No other rows are overdue or partially_paid
  - Grace RESETS when account is fully caught up:
    * All schedule rows paid
    * No unpaid penalties on any row
  - When fully caught up and goes overdue again → grace applies again
  - Waived penalties do NOT count against grace
  - Paid penalties do NOT count against grace

  Implemented in:
    supabase/functions/penalty-engine/index.ts (week1Offset = graceConsumed ? 0 : 7)
    src/pages/AccountDetail.tsx (isInGracePeriod display)

### Penalty trigger schedule (per overdue month):
  Cycle 1: week1:1 → due_date + 7 (or +0 if grace consumed), week2:1 → due_date + 14
  Cycle 2: week1:2 → due_date + 1 month, week2:2 → due_date + 1 month + 14 days
  Cycle 3: week1:3 → due_date + 2 months, week2:3 → due_date + 2 months + 14 days
  (Final month only gets Cycles 2 and 3 — non-final months cap at Cycle 1)

### Penalty engine timing:
  Cron: 00:05 UTC daily (= 8:05 AM PHT)
  Due date filter: due_date <= today (includes the due date itself)
  Penalties apply ON the due date at 8 AM PHT — the grace period is
  the customer's consideration time, not the filter.

### Freeze guard:
  Accounts with pending payment submissions (status='submitted' or 'under_review')
  are frozen — no new penalties until the submission is resolved.

## FORFEITURE STANDARD — NON-NEGOTIABLE (added 2026-04-12)

### Status flow:
  OVERDUE → FORFEITED → EXTENSION_ACTIVE → FINAL_FORFEITED

### PATH 1 — Final month penalty cap reached:
  Condition: final month penalty total >= cap (₱3,000/¥6,000)
             AND final month due_date <= today
  Effect: account status → 'forfeited', unpaid schedule rows → 'cancelled'
  No 90-day payment guard on this path.

### PATH 2 — 3 calendar months overdue:
  Condition: first unpaid due date is 3+ calendar months ago (day-level precision)
             AND last non-voided payment > 90 days ago (safety guard)
  Effect: account status → 'forfeited', unpaid schedule rows → 'cancelled'

### 90-day payment safety guard (clarified 2026-05-15):
  The safety guard "last non-voided payment > 90 days ago" applies to BOTH PATH 2
  AND PATH 3 (not just PATH 2 as originally documented). Implementation puts this
  guard in the per-account loop BEFORE either path check, so any account with a
  payment within 90 days is skipped entirely. This is intentional — keeps recently-
  paying customers out of auto-forfeit regardless of overdue duration or penalty count.

### PATH 3 — 6th penalty occurrence → final_settlement:
  Condition: total penalty_fees rows (unpaid + paid) across all unpaid months >= 6
             AND no existing final_settlement_records for this account
             AND last non-voided payment > 90 days ago (shared safety guard with PATH 2)
  Effect: creates final_settlement_records, account status → 'final_settlement'
          Schedule rows are NOT cancelled (stay in 'overdue' status) — only PATH 1
          and PATH 2 (true forfeits) cancel unpaid schedule rows.
  Empirical verification: confirmed 2026-05-15 on fixture CJ-2026-FORFEIT-PATH3-NEW.
  Loyalty preserved per Bug #101 fix — lot stays ACTIVE, no revoke transaction
  logged, cumulative_spend_jpy unchanged.

  Fixture forensic note (2026-05-18): the fixture's account-side state remains
  intact and matches PATH 3 expectations. Loyalty-side data (loyalty_member,
  loyalty_point_lot, loyalty_transactions) was subsequently removed from the
  database between 2026-05-15 and 2026-05-18. The only migration in the
  20260515-20260518 window (20260516010044) drops three loyalty auto-award
  DB triggers and does not delete any rows. The data wipe was therefore not
  migration-driven — most likely a manual SQL cleanup, edge function call, or
  direct admin action, with no audit trail captured in session history. Admin
  UI for customer CJ-2026-05456 ("Test Path3 Customer") confirms "Not enrolled"
  in the Loyalty tab as of 2026-05-18. The 2026-05-15 empirical verification
  stands as proof of record; re-verification on this fixture is not possible
  without rebuilding the loyalty side.

### After forfeiture:
  - Admin can grant ONE-TIME extension → status = 'extension_active'
  - Extension has an end date (typically 1 month)
  - extension_active + extension expires → 'final_forfeited' (PERMANENT)
  - extension_active + extension month penalty cap reached → 'final_forfeited' (PERMANENT)
  - FINAL_FORFEITED blocks all further negotiation/reactivation

  Extension request window (customer portal):
  - Customer can request extension from portal within 7 days of forfeiture
  - Reference date: layaway_accounts.forfeited_at (timestamptz column)
  - forfeited_at is set by auto-forfeit-settlement (PATH 1 and PATH 2)
    and manual-forfeit edge functions
  - After 7 days: hide request button, show message:
    "The extension request window has closed. Please contact us directly
     for assistance."
  - Within 7 days: show "Request Extension" button
  - Once request submitted: button disabled, shows "Extension Request Pending"
  - Extension requests stored in: extension_requests table
  - Admin reviews in: CSR Monitoring → Extensions tab

### Independence rule:
  penalty-engine and auto-forfeit-settlement are INDEPENDENT
  — neither calls the other. Penalty engine creates penalties;
  auto-forfeit-settlement checks forfeiture conditions.

## PAYMENT SUBMISSION FLOW (locked — 2026-04-13)

  ALL payments regardless of submitter must go through
  Submissions review before appearing in Proof of Payment.

  Flow:
    1. Customer submits via portal → status='submitted'
    2. Staff submits from AccountDetail → status='submitted'
    3. Admin/Finance submits from AccountDetail → status='submitted'
    4. Admin/Finance reviews in Submissions tab → clicks Confirm
       → status='confirmed'
    5. ONLY confirmed submissions appear in Proof of Payment

  NO payment goes directly to Proof of Payment without
  confirmation in Submissions tab.

  The only way status becomes 'confirmed' is via explicit reviewer
  click in the Submissions tab (review-payment-submission edge
  function). Nothing else writes status='confirmed' — all INSERT
  paths (submit-payment, record-payment staff path, record-payment
  admin/finance client-side insert from RecordPaymentDialog) use
  status='submitted'.

## LOYALTY AWARD SYSTEM (added 2026-04-27, updated 2026-05-16)

### Canonical award path (SOLE path — Layer-2 triggers removed 2026-05-16):
  review-payment-submission → award-loyalty-points edge function.
  - Layaway: awards ONLY on downpayment submission confirm
    (submissionIsDP). Never on monthly installment confirm.
  - Cash: awards ONLY when the confirming payment makes the
    cash order fully paid (isFullyPaid → status 'completed').
  The Layer-2 DB triggers (trg_loyalty_on_cash_order_complete,
  trg_loyalty_on_layaway_complete) and function
  award_loyalty_points_on_complete() were DROPPED via
  migration 20260516000000_drop_layer2_loyalty_triggers.sql —
  they only INSERTed transaction rows without updating
  loyalty_members counters or creating point lots, producing
  ghost audit rows. Do NOT reintroduce a DB-trigger award path.

### Points formula:
  points = floor(loyalty_jpy_amount / 10000)
           × 100
           × current_tier_multiplier

### Tier multipliers:
  Glimmer:   1x
  Radiant:   2x
  Elite:     2x
  Crown VIP: 3x

## LOYALTY SYSTEM RULES (locked 2026-05-16) — NON-NEGOTIABLE

  1. Portal signup creates a customers row + auto-enrolls.
     setup-customer-account: when the verified email matches no
     existing customer, it creates the customers row (full_name
     required; email + auth_user_id from the JWT; optional
     mobile_number / facebook_name / messenger_link / location /
     country; customer_code via existing trigger) AND inserts a
     loyalty_members row at the Glimmer tier with all counters 0.
     Existing-customer emails continue the link-only path
     unchanged. Profile fields are collected on PortalSetup.tsx
     and stashed in localStorage (key 'portal-setup-profile') so
     they survive the email-verification page reload.

  2. review-payment-submission is the SOLE award path.
     Layaway → award only on downpayment confirm. Cash → award
     only on full completion (isFullyPaid). NEVER on monthly
     installment payments. No DB-trigger award path exists
     (Layer-2 removed — see LOYALTY AWARD SYSTEM).

  3. Currency-agnostic awards, server-enforced via amount gate
     (per Bug #113, 2026-05-17). award-loyalty-points reads
     loyalty_jpy_amount from the source row (populated at account
     creation from the "Product Amount (JPY) — Loyalty Only" form
     input; excludes shipping, service fees, insurance) and skips
     with reason='no_loyalty_amount' when loyalty_jpy_amount <= 0
     or null. Both PHP and JPY accounts can earn — loyalty_jpy_amount
     is the canonical loyalty spend basis regardless of account
     currency. The pre-Bug #113 currency gate (currency !== 'JPY')
     was removed.

  4. loyalty_enabled is the go-live gate, enforced server-side.
     award-loyalty-points: flag false/null →
     { skipped: true, reason: 'loyalty_disabled' } (no tx, no
     lot, no counter change). join-loyalty-program: flag
     false/null → 403 { error: 'Loyalty program is not
     currently available' }. Flag read from
     system_settings.loyalty_enabled (jsonb scalar), fail-closed
     (anything other than strict true = disabled). Frontend
     useLoyaltyAccess gate is retained but is now defence-in-depth
     only — the server is authoritative.

  5. Flipping system_settings.loyalty_enabled = true is THE
     go-live event. Cynthia flips it manually via SQL when
     ready. No code change required to launch.

  6. Lot expiry is surfaced in the portal. customer-portal
     returns loyalty_lots (non-revoked, non-consumed, expires_at
     ASC NULLS LAST). MemberCard shows the next-expiring lot and
     a red "expiring soon" badge when within 30 days.

## LOYALTY INACTIVITY — last_purchase_at SOURCE OF TRUTH (added 2026-05-20)

  - `loyalty_members.last_purchase_at` = order_date of the member's
    MOST RECENT SUCCESSFUL order. Successful = layaway status IN
    (`active`, `overdue`, `completed`, `extension_active`,
    `reactivated`); cash status IN (`completed`, `pending`). NEVER
    `cancelled` / `forfeited` / `final_forfeited` (layaway) or
    `cancelled` / `expired` (cash).

  - `loyalty-inactivity-check` (pg_cron job 16, 180-day) now derives
    `effectiveLastPurchase = GREATEST(stored last_purchase_at, MAX
    successful order_date)` per member and measures the 166-day
    warning + 180-day expiry against it. Read-only derivation — the
    cron does NOT write `last_purchase_at` back. This guarantees a
    member with a recent real order is never warned or expired even
    if `award-loyalty-points` never fired for it. The customer's
    `order_date` source is queried in one paginated pass per table
    (`layaway_accounts` + `cash_orders`) and JS-aggregated to a
    per-customer `Map<customer_id, Date>` — no N+1, no `.in(customerIds)`
    URL-length risk (Bug #59 precedent).

  - `created_at` is the row INSERT/import timestamp (bulk import =
    `2026-03-20`) — NEVER use `created_at` as an order/purchase
    date. Use `order_date` (`layaway_accounts` & `cash_orders`)
    and `date_paid` (`payments`).

  - 2026-05-20 backfill: corrected 30 migrated members' clocks to
    their real successful-order dates; reverted 4 forfeited-sourced
    clocks (Judy Haitch, Shiela Trevilian, Maria Milliones Jensen,
    Test Customer). Snapshot:
    `loyalty_last_purchase_backfill_audit_20260520`.

  - Honey Faye (CJ-2026-01672) was the sole wrongful expiry from
    the prior gating logic: 2,700 restored + 1,600 awarded for
    INV 19015 = 4,300 remaining_points; Google Sheet synced via 3
    manual POSTs to sync-loyalty-to-sheet (Transactions rows 419/
    420 + Members row 485) — Supabase and sheet match.

## PLAN DURATION — payment_plan_months IS AUTHORITATIVE (added 2026-05-20)

  `layaway_accounts.payment_plan_months` is the configured PLAN DURATION
  product attribute — NOT a cache, NOT derivable from the schedule. It is
  sourced from `plan_configurations` and gated by a DB trigger.

### Source of truth
  `plan_configurations` table holds the allowed durations:
    - 3, 6, 8, 10, 12 months (the only valid values)
    - Each row carries `min_amount_php`, `min_amount_jpy`,
      `dp_percentage`, `risk_tier`
  `enforce_plan_minimum_amount` trigger fires BEFORE INSERT OR UPDATE on
  `layaway_accounts` and REJECTS any `payment_plan_months` value that is
  not a configured duration (and any total below that duration's minimum).
  Consequence: the column can ONLY ever hold a configured duration. The
  trigger guarantees this.

### Engines read this column directly — that is correct
  `penalty-engine`, `add-penalty`, `auto-forfeit-settlement`,
  `finance-reconciliation`, business-rules `getPenaltyCap` /
  `isPenaltyOverCap`, and the AccountDetail / PenaltyCapAuditPanel UI all
  use `payment_plan_months` to identify the final installment for the
  ₱3,000 / ¥6,000 final-month penalty cap and forfeiture logic. This is
  the intended design.

### NEVER derive plan length from the schedule
  - `MAX(installment_number)` over non-cancelled rows is NOT the source.
  - `count(*)` of schedule rows is NOT the source.
  - Either can drift from the configured duration due to admin schedule
    edits; that is an account-level anomaly, NOT a bug in the column.

### NEVER write payment_plan_months from schedule operations
  `add-installment` and `delete-installment` MUST NOT sync
  `payment_plan_months` to the new schedule row count. Doing so:
    1. Inverts the source of truth (configured product → derived cache).
    2. Hits the trigger — any non-configured value (e.g. 5, 7, 9, 11)
       is rejected, so the write fails outright and the edge function
       returns a 500.
  An admin who adds a 7th installment to a 6-month plan creates a
  schedule with 7 rows but the account remains a 6-month plan. That is
  the documented behavior.

### Schedule-vs-column mismatches are admin-edit anomalies, not bugs
  Examples where the schedule row count differs from
  `payment_plan_months`:
    - INV 18748 (logged delete-installment)
    - CJ-2026-FORFEIT-P1, CJ-2026-FORFEIT-P3, CJ-2026-PATH1-TEST,
      CJ-2026-RESTORE-TEST (test fixtures with manually-adjusted
      schedules)
  In every such case, `payment_plan_months` remains the correct
  configured duration; the schedule is the anomaly. Do not "fix" by
  rewriting the column.

### Aborted-fix record
  Commit `f113cd2` (2026-05-20) attempted to make `payment_plan_months`
  a schedule-derived cache: engines read MAX(installment_number), and
  add/delete-installment wrote `payment_plan_months = schedule MAX`.
  That write hits the `enforce_plan_minimum_amount` trigger and 500s on
  any non-configured count (e.g. deleting from 6→5 rows). Reverted in
  commit `29505ae` (2026-05-20). DO NOT REOPEN this approach.

## LOYALTY GOOGLE SHEET SYNC TAXONOMY — NON-NEGOTIABLE (added 2026-05-16)

Canonical event_type values consumed by sync-loyalty-to-sheet:

  Members tab events:      enrolled, tier_changed, status_changed, admin_edited
  Transactions tab events: earned, bonus, redeemed, expired, adjusted, refunded, revoked, birthday_bonus

Caller responsibilities:
  - join-loyalty-program       → emits enrolled
  - award-loyalty-points       → emits earned + bonus (if promo) + tier_changed (if upgrade)
  - process-loyalty-redemption → emits redeemed (approve), revoked (void)
  - loyalty-inactivity-check   → emits expired, tier_changed (downgrade), status_changed (if wired)

Forbidden:
  - Any caller sending event_type values outside this taxonomy
  - Emission without member_id in the payload
  - Sync calls that block the parent function's return (must remain fire-and-forget)

Sheet ID location: system_settings.loyalty_sheet_id (configured via Loyalty Settings UI).

### Sync function implementation (live as of 2026-05-16)

- sync-loyalty-to-sheet/index.ts writes rows in real-time to the Sheet configured in system_settings.loyalty_sheet_id.
- Sheet tabs: Members (11 cols) and Transactions (13 cols). Column order is locked — see headers in row 1 of each tab.
- Authentication: getServiceAccountAccessToken() from _shared/google-auth.ts (same SA as invoice generator).
- Activity Status (Members tab Col I): derived from last_purchase_at — null or <90 days = "Active", ≥90 days = "Inactive".
- PHT timestamps (Col A both tabs): formatted via Intl.DateTimeFormat with timeZone 'Asia/Manila'.
- Real-time only in v1. loyalty_sheet_sync_frequency setting is informational only; the function ignores it and writes every event immediately.
- Append endpoint: spreadsheets.values.append (NOT batchUpdate) — sheet auto-finds next empty row.
- Graceful skip: if loyalty_sheet_id is empty in system_settings, function returns { disabled: true } without erroring.

Forbidden:
- Modifying sheet column order without coordinated header update in the actual Google Sheet
- Calling sync-loyalty-to-sheet with event_type outside the canonical taxonomy
- Removing the activity_status derivation (Members Col I depends on it)

## SERVICES RULE (added 2026-04-12)

  account_services are included in total_amount at the time of service creation.
  When a service is added:
    total_amount = downpayment_amount + SUM(base_installment_amounts) + SUM(account_services)

  remaining_balance = total_amount + Σ(non-waived penalties) - Σ(non-voided payments)
  Services are NOT added separately in remaining_balance formula — they are in total_amount.

  NEVER add services as a separate term alongside total_amount in the formula.

## DECIMAL RULES

  DB: all money columns NUMERIC(12,2)
  JS: use moneyAdd(), moneySub(), toInt(), fromInt() from business-rules.ts
  Never use raw +/- on money values in JS
  Money equality: always use moneyEqual() with EPSILON tolerance
  JPY: always Math.round() — never display fractional yen
  PHP: always exactly 2 decimal places

## SCHEDULE EDIT RULES

  Allowed edits: due_date only (via extend-schedule edge function)
  Locked forever: base_installment_amount (DB trigger), installment_number (DB trigger)
  Locked on completed/forfeited accounts: all edits rejected
  Adding rows: only via add-installment edge function
  Deleting rows: only via delete-installment edge function
                 requires zero allocations and zero carried_amount
  Every edit: requires reason, logged to schedule_audit_log

## LOCKED RULE (2026-05-17): GUC bypass before write via supabase-js

  When an edge function needs to bypass a BEFORE-trigger guard
  (e.g., prevent_schedule_deletion, prevent_total_amount_change)
  for a subsequent write operation, the bypass MUST be wrapped
  in a SECURITY DEFINER RPC that performs both set_config and
  the write in a single transaction.

  DO NOT use the 2-HTTP-call pattern:
    await supabase.rpc('set_config', {..., is_local: true});
    await supabase.from(table).delete()/.update()/...;

  This pattern fails Bug #39: set_config(is_local: true) is
  SCOPED TO THE TRANSACTION of HTTP call 1. HTTP call 2 may use
  a different connection/transaction, so the GUC does not persist.
  The trigger fires, the write is blocked, and depending on the
  edge function's error handling, the failure may be silent.

  CORRECT pattern (single transaction guarantee):
    CREATE FUNCTION xxx_atomic(...) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      PERFORM set_config('app.your_guc', 'on', true);
      INSERT INTO audit_table (...);  -- if applicable
      DELETE FROM target_table WHERE ...;  -- or UPDATE/INSERT
      RETURN jsonb_build_object('success', true);
    END;
    $$;

    -- Edge function:
    const { data, error } = await supabase.rpc('xxx_atomic', {...});
    if (error) throw error;
    if (data?.error) throw new Error(data.error);

  REFERENCE IMPLEMENTATIONS:
  - delete_schedule_row_atomic (2026-05-17, schedule row deletion)
  - delete_account_atomic (updated 2026-05-17 to use this pattern)

  AUDIT REQUIRED: any existing supabase-js 2-call GUC bypass pattern
  (e.g., app.allow_total_amount_edit set_config followed by .update())
  must be reviewed for Bug #39 exposure and converted to atomic RPC
  if the same failure mode could apply.

## VOID/RESTORE RULES

  Void: always deletes payment_allocations by payment_id (never by schedule_id)
  Carry cascade: voiding a payment that triggered carry clears carried_amount on next row
  Restore: validates allocation ceiling per row before recreating allocations
           rejects if row already fully allocated

## PLAN MINIMUM ENFORCEMENT (added 2026-04-23)

  Minimum amounts stored in: plan_configurations table
  Columns: plan_months, min_amount_jpy, min_amount_php

  Current minimums:
    3M: no minimum
    6M: ¥25,000 / ₱10,500
    8M: ¥300,000 / ₱126,000
    10M: ¥600,000 / ₱252,000
    12M: ¥1,000,000 / ₱420,000

  Enforcement layers:
    1. UI — NewAccount.tsx reads plan_configurations on load,
       shows minimum subtitle on each plan pill button,
       shows red warning under Total Amount if below minimum,
       disables Create button when below minimum — commit 639c3f6
    2. DB trigger — trg_enforce_plan_minimum fires on INSERT
       and UPDATE via enforce_plan_minimum_amount() function.
       Blocks any account creation or edit below the minimum.
    3. Both PHP and JPY enforced — hard block, no override

