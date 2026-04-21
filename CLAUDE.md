# Cha Jewels Layaway System — Claude Code Context

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
    Steps: create missing allocations → sync schedule → auto-waive unpaid
           penalties on paid installments → recalculate account totals

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
    pending / overdue:    base_installment_amount + penalty_amount (full amount owed)
    partially_paid:       shortfall remaining (= base - paid, after underpayment recorded)
    paid:                 amount actually paid (= paid_amount)

  When processing an existing partially_paid row in edge functions:
    If paid_amount > total_due_amount → "new semantics": due = total_due_amount (IS the remaining)
    If paid_amount <= total_due_amount → "old semantics": due = total_due_amount - paid_amount

## Git Workflow

- Commit and push all changes directly to **main** branch
- Do NOT create feature branches unless explicitly asked

## TOOL OWNERSHIP RULES (LOCKED — 2026-03-29)

  Lovable → src/ AND supabase/functions/ file creation and editing
  Cloud Shell → npx supabase functions deploy commands ONLY
  Supabase SQL Editor → database changes only (pure SQL)
  Claude Code → READ-ONLY audit and diagnosis — never commit to repo

  No prompt written without plan confirmed first.
  No step executed without explicit go signal from Cynthia.

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

## Test Accounts (DO NOT DELETE OR MODIFY)

  TEST-001 — Locked benchmark (general baseline)
             Never modify data. All checks must always be green.
             Purpose: catches regressions in core calculation formula.

             Setup:
               Currency: PHP | Base LA: ₱26,000 | DP: ₱6,000 (paid)
               3 months | All months PAID
               No penalties

             Expected verify values (all must be green):
               activePenalties:    0
               totalLAAmount:      26,000
               amountPaid:         26,000
               remainingBalance:   0
               monthsRemaining:    0
               sumOfPendingMonths: 0
               DP + sumBases:      26,000   (6,000 + 20,000)
               downPayment:        6,000
               status:             active (completed on next reconcile)

  TEST-002 — Locked benchmark (waived penalty)
             Never modify data. All 9 verify checks must always be green.
             Purpose: catches bugs where waived penalties still affect
             totalLAAmount or remainingBalance.

             Setup:
               Currency: PHP | Base LA: ₱20,000 | DP: ₱6,000 (paid)
               3 months | Month 1 Jan 22 2026 PAID | Month 2 Feb 22 2026 PAID
               Month 3 Mar 22 2026 PENDING
               Penalty: ₱500 on Month 2, status=waived
               penalty_amount on schedule row = 0

             Expected verify values (all 9 must be green):
               activePenalties:    0        (waived = excluded)
               totalLAAmount:      20,000
               amountPaid:         15,334   (6,000 + 4,667 + 4,667)
               remainingBalance:   4,666
               monthsRemaining:    1
               sumOfPendingMonths: 4,666
               DP + sumBases:      20,000   (6,000 + 14,000)
               downPayment:        6,000    (ref: DP-TEST-002)
               nextPaymentDate:    2026-03-22

  TEST-003 — Locked benchmark (bulk import DP recognition)
             Never modify data. All 9 verify checks must always be green.
             Purpose: catches bugs where bulk import downpayments are not
             recognized by the verify check or totalPaid calculation.

             Setup:
               Currency: PHP | Base LA: ₱15,000 | DP: ₱4,500 (paid)
               3 months | Month 1 Feb 22 2026 PAID | Month 2 Mar 22 2026 PENDING
               Month 3 Apr 22 2026 PENDING
               DP payment remarks: "Downpayment (bulk import)"
               (contains 'down' → recognized by isDownpaymentPayment)

             Expected verify values (all 9 must be green):
               activePenalties:    0
               totalLAAmount:      15,000
               amountPaid:         8,000    (4,500 + 3,500)
               remainingBalance:   7,000
               monthsRemaining:    2
               sumOfPendingMonths: 7,000
               DP + sumBases:      15,000   (4,500 + 10,500)
               downPayment:        4,500    (remarks contains 'down')
               nextPaymentDate:    2026-03-22

  TEST-004 — Split payment testing (can record payments)
  TEST-005 — Split payment testing (can record payments)

## Verification Rule (updated 2026-04-12)

  Frontend verify panel and SystemAudit.tsx have been REMOVED.
  All account health checks are now server-side via SQL RPCs:

  audit_account(p_invoice_number text) — per-account real-time audit
    Called by "Check Health" button in AccountDetail (admin + finance)
    Returns JSONB with checks array, each with label/expected/stored/pass

  audit_all_accounts() — system-wide audit
    Called by "Run System Audit" button in Dashboard (admin only)
    Returns table of invoice_number, all_pass, failed_checks

  Both RPCs live in Supabase SQL Editor — NOT in edge functions.
  They use the canonical formula directly in PostgreSQL — no JavaScript
  rounding issues, no stale cached values, no view data dependencies.

  After ANY change to calculation or payment logic:
    1. Run "Check Health" on TEST-001, TEST-002, TEST-003 → all checks pass
    2. Run "System Audit" from Dashboard → check for new failures
    3. If any check fails, the change broke something

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

## Known Issues

  DP payments may be recorded with various payment_type values
  depending on how they were imported. Always check multiple fields
  when identifying DP payments:
    - payment_type === 'downpayment' or 'dp'
    - is_downpayment === true
    - reference_number starts with 'DP-'
    - remarks contains 'down' or 'dp' (case-insensitive)

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

## DISPLAY RULES (permanent)

  ALL schedule display reads from schedule_with_actuals view
  actual_remaining → only source for per-row remaining
  allocated        → only source for per-row paid amount
  computed_status  → only source for row status in display
  paid_amount and total_due_amount → write-only caches, never read for display
  All next-payment logic → getNextPaymentRow() from business-rules.ts
  All pending sum logic  → sumPendingRows() from business-rules.ts
  No inline reimplementation of canonical functions permitted

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

### PATH 3 — 6th penalty occurrence → final_settlement:
  Condition: total penalty_fees rows (unpaid + paid) across all unpaid months >= 6
             AND no existing final_settlement_records for this account
  Effect: creates final_settlement_records, account status → 'final_settlement'

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

## PROOF OF PAYMENT (added 2026-04-13)

  - Stored in Supabase Storage bucket: payment-proofs
  - File naming: {CustomerName}_{InvoiceNumber}_Month{N}_{Date}.{ext}
  - Linked to payment_submissions.proof_url
  - Only confirmed submissions (status='confirmed') appear in the
    Proof of Payment tab (.eq('status', 'confirmed') filter)
  - Visible to all roles (admin, finance, staff, customer)
  - Upload available to admin, finance, staff only
  - Standalone page: /payments-hub (Submissions & Proofs)
  - Per-account view: integrated into Payment History as inline
    "📎 View Proof · {sender}" link (AccountDetail.tsx)

  Staff-submission flow for proof:
    record-payment (server) INSERTs submission row without proof →
    client uploads file to payment-proofs bucket → client UPDATEs
    the same row with proof_url + sender_name. No duplicate row.

## ACCOUNT NOTES (added 2026-04-13)

  - Table: account_notes
  - Columns: id, account_id, note_text, created_by_user_id,
    created_by_name, created_at
  - Immutable — no edit or delete after creation
  - Max 1000 chars per note
  - Visible to admin, finance, staff roles
  - Inline panel in AccountDetail — after Payment History
  - Optional initial note on new account creation (NewAccount.tsx)

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

## VOID/RESTORE RULES

  Void: always deletes payment_allocations by payment_id (never by schedule_id)
  Carry cascade: voiding a payment that triggered carry clears carried_amount on next row
  Restore: validates allocation ceiling per row before recreating allocations
           rejects if row already fully allocated

## NEW HEALTH CHECKS (15-21, added in Phase 5 — 2026-03-29)

  Check 15: total_paid drift — SUM(payments) matches account.total_paid
  Check 16: allocation ceiling breach — no row over-allocated
  Check 17: inflated schedule rows — no pending/overdue rows with inflated total_due_amount
  Check 18: zero remaining not paid — all zero-remaining rows marked paid
  Check 19: wrongful forfeit — no zero-balance forfeited accounts
  Check 20: carried amount on paid row — no unconsumed carry on paid rows
  Check 21: double carry — no account has carry on multiple rows

## SYSTEM STATUS (as of 2026-04-12)

  accept-underpayment auto-carry: REMOVED ✅
  carry-over edge function: DEPLOYED ✅
  review-payment-submission auto-carry: REMOVED ✅
  recalculate-penalties: DISABLED (returns 410) — was silently waiving penalties ✅
  Underpayment decision modal: BUILT ✅ (in PaymentSubmissions.tsx)
  Overpayment/Keep decision modal: BUILT ✅ (in PaymentSubmissions.tsx)
  penalty-engine due_date filter: FIXED to <= (includes due date) ✅
  penalty-engine grace period: FIXED to once-per-account ✅
  penalty-engine self-healing Step 5b: ADDED ✅
  auto-forfeit-settlement error checking: ADDED ✅
  auto-forfeit-settlement immediate audit logs: ADDED ✅
  fix-account-totals: REWRITTEN with canonical formula + guards ✅
  Account Health button: ADDED to AccountDetail ✅
  System Audit button: ADDED to Dashboard ✅
  SystemAudit.tsx page: REMOVED ✅
  AccountDetail verify panel: REMOVED ✅
  plan_configurations table: LIVE ✅ (3M/6M/8M/10M/12M)
  trg_enforce_plan_minimum trigger: LIVE ✅
  forfeited_at column on layaway_accounts: ADDED ✅
  extension request 7-day window: LIVE ✅
  Executive Dashboard (fc_ RPCs): LIVE ✅ (11 RPCs + alert engine)
  fc_evaluate_alerts pg_cron: RUNNING every 30 minutes ✅
  accept-underpayment carry-over logic: REMOVED ✅ (audit-log only)
  audit_all_accounts() RPC: REWRITTEN to call audit_account() per account ✅
  Keep handler overpayment formula: FIXED to use existing total_due_amount ✅
  carry-over total_due_amount formula: FIXED to use existing total_due_amount ✅
  Waterfall penalty grouping: FIXED to group by schedule_id ✅
  Customer codes CJ-YYYY-XXXXX: STANDARDIZED for all customers ✅
  Search input focus loss: FIXED (EmbeddedWrapper at module level) ✅
  reconciliation_log table: LIVE ✅
  record-payment waterfall: FIXED ✅ (2026-04-20)
  record-multi-payment waterfall: FIXED ✅ (2026-04-20)
  review-payment-submission waterfall: CONFIRMED CORRECT ✅
  Keep handler: FIXED — no-op, preserves waterfall ✅ (2026-04-20)
  enforce_paid_row_freeze trigger: LIVE ✅ (2026-04-20)
  reconcile-account report-only: LIVE ✅ (2026-04-20)
  restore-payment canonical formula: FIXED ✅ (2026-04-20)
  void-payment freeze bypass: FIXED ✅ (2026-04-20)
  TEST-001 to TEST-005: RECREATED ✅ (2026-04-20)
  Finance role void/restore: ENABLED ✅ (2026-04-20)
  review-payment-submission isNowFullyPaid: FIXED ✅ (2026-04-21)
  Finance Analytics — Forfeited Collected card: LIVE ✅ (2026-04-21)
  Finance Analytics — Top 10 Outstanding Customers: LIVE ✅ (2026-04-21)
  Finance Analytics — Collected vs Expected area chart: LIVE ✅ (2026-04-21)
  get_top_outstanding_customers RPC: LIVE ✅ (2026-04-21)
  forfeited_at backfill limitation: historical forfeitures show
    as April 2026 — acceptable, future forfeitures will be accurate
  Stale partially_paid status scan: CLEAN ✅ (2026-04-21)
    — 0 accounts with allocated >= ceiling but status = partially_paid
  Forgot Password page (/forgot-password): LIVE ✅ (2026-04-21)
  Reset Password page (/reset-password): LIVE ✅ (2026-04-21)
  Email sender name: "Cha Jewels" ✅ (2026-04-21)
  Contact Support button: m.me/chajewelsjapan ✅ (2026-04-21)
  Link Signature modal: FIXED — single dialog no double overlay ✅ (2026-04-21)
  PWA: LIVE ✅ (2026-04-21)
  Supabase Site URL: https://app.chajewelsjp.com ✅ (2026-04-21)
  prevent_total_amount_change trigger: LIVE ✅ (2026-04-21)
  add-service edge function: LIVE ✅ (2026-04-21)
  add-installment role: narrowed to admin only ✅ (2026-04-21)
  create-layaway-account role check: ADDED ✅ (2026-04-21)
  daily-reconciliation pg_cron: ACTIVE ✅ job ID 7, 5 0 * * * (2026-04-21)

## PENDING ITEMS (as of 2026-04-20)

  1. Firebase signing page connection (Steps 13-17)
  2. Update submit-payment edge function to auto-deploy list
  3. Extension lifecycle test stages 3 & 4
  4. TEST-FORFEIT-002 and TEST-FORFEIT-003
  5. send-transactional-email edge function — does not exist, email
      notifications for extension requests not working
  6. Penalty engine waived-to-unpaid auto-fix — deployed, needs
      monitoring on next cron run to confirm correct behavior
  7. Forfeitures per Month chart — historical data shows all in
      April 2026 due to backfill limitation — self-corrects over time

## PERIODIC HEALTH QUERIES

```sql
-- Detect stale partially_paid rows (run periodically)
SELECT la.invoice_number, ls.installment_number
FROM layaway_schedule ls
JOIN layaway_accounts la ON la.id = ls.account_id
LEFT JOIN (
  SELECT schedule_id, SUM(allocated_amount) AS allocated
  FROM payment_allocations pa2
  JOIN payments p ON p.id = pa2.payment_id
  WHERE p.voided_at IS NULL
  GROUP BY schedule_id
) pa ON pa.schedule_id = ls.id
WHERE ls.status = 'partially_paid'
  AND COALESCE(pa.allocated, 0) >= (
    ls.base_installment_amount
    + COALESCE(ls.penalty_amount, 0)
    + COALESCE(ls.carried_amount, 0)
  ) - 0.005
  AND la.invoice_number NOT LIKE 'TEST%';
-- Expected result: 0 rows. If rows appear, update db_status to paid.
```

## AUTO-DEPLOY RULES (updated 2026-04-12)

GitHub Actions auto-deploys on every push to main:

FRONTEND: Firebase Hosting — ALL pushes trigger rebuild and deploy

SUPABASE EDGE FUNCTIONS — these auto-deploy when their files change:
- reconcile-account
- daily-reconciliation
- record-payment
- record-multi-payment
- bulk-import
- carry-over
- accept-underpayment
- review-payment-submission
- manual-forfeit
- auto-forfeit-settlement
- recalculate-penalties (DISABLED — returns 410)
- dashboard-summary
- add-service

All other edge functions still require manual deploy via Cloud Shell.
Always check .github/workflows/supabase-functions-deploy.yml
before adding new functions.
