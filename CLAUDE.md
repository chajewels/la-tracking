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
  TEST-007 — Cash order Bug #99 smoke test (¥1M, Test Customer Glimmer→Radiant)
  TEST-008_ELITE — Layaway DP restore lifecycle (Bug #66 + Bug #99 restore-loyalty test fixture)

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

## AUDIT RPCs

  All audit RPCs live in Supabase SQL Editor — NOT in repo
  migrations. Function bodies recorded here so future Claude
  sessions can see what exists without querying the live DB.

### audit_account(p_invoice_number text) RETURNS JSONB

  Per-account real-time audit. Called by "Check Health"
  button in AccountDetail (admin + finance). Returns JSONB
  with checks array, each entry { label, expected, stored, pass }.

### audit_all_accounts() RETURNS TABLE

  System-wide audit. Calls audit_account() per account in a
  loop (per Known Fixed Bug #28, rewritten 2026-04-19 to
  delegate rather than reimplement). Returns:
    invoice_number text, status text,
    all_pass boolean, failed_checks text[]

  Called by "Run System Audit" button in Dashboard (admin only).

### audit_delete_cleanup_invariants() RETURNS TABLE

  Schema-invariant audit RPC. Detects FK gaps in
  delete-cleanup edge functions before they cause
  production 500 errors. Created 2026-04-28 after
  tonight's reconciliation_log + extension_requests
  incidents (see Known Fixed Bugs #50 and #51) revealed
  delete-account was vulnerable to silent schema drift
  from SQL-Editor-created tables.

  Lives in: Supabase SQL Editor (not in repo migrations).

  Signature:
    RETURNS TABLE (
      delete_function text,
      parent_table    text,
      child_table     text,
      fk_name         text,
      on_delete       text,
      in_allowlist    boolean,
      finding_type    text,
      severity        text,
      message         text
    )

  Empty result = healthy. Any rows returned = drift to
  investigate.

  Allowlist flags (set per allowlist row):
    - defensive = true — entry is CASCADE belt-and-
      suspenders cleanup. Stale check is skipped because
      the entry is intentionally redundant with DB-level
      CASCADE.
    - pre_check_protected = true — the parent edge
      function rejects deletion via a pre-check rather
      than cleaning up. Missing-cleanup check is skipped
      because the pre-check enforces the invariant.

  Audited parents:
    - layaway_accounts → delete-account
      (14 child entries, all covered after commits
       bdac341 + 1ff9cd8)
    - customers → delete-customer
      (2 entries: customer_analytics defensive,
       layaway_accounts pre_check_protected)
    - cash_orders → none yet
      (no delete-cash-order function exists; surfaces
       preventive findings as severity='info' so future
       gaps are visible before a delete function is
       built)

  Function body (current production):

  ```sql
  CREATE OR REPLACE FUNCTION public.audit_delete_cleanup_invariants()
  RETURNS TABLE (
    delete_function text,
    parent_table    text,
    child_table     text,
    fk_name         text,
    on_delete       text,
    in_allowlist    boolean,
    finding_type    text,
    severity        text,
    message         text
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
  AS $$
    WITH
    allowlist (delete_function, parent_table, child_table,
               defensive, pre_check_protected) AS (
      VALUES
        -- delete-account (supabase/functions/delete-account/index.ts)
        -- 14 direct-FK children. payment_allocations is excluded
        -- because it is deleted indirectly via payment_id IN
        -- (paymentIds) and has no direct FK to layaway_accounts.
        ('delete-account',  'layaway_accounts', 'payment_submission_allocations', false, false),
        ('delete-account',  'layaway_accounts', 'payment_submissions',            false, false),
        ('delete-account',  'layaway_accounts', 'penalty_waiver_requests',        false, false),
        ('delete-account',  'layaway_accounts', 'penalty_fees',                   false, false),
        ('delete-account',  'layaway_accounts', 'csr_notifications',              false, false),
        ('delete-account',  'layaway_accounts', 'extension_requests',             false, false),
        ('delete-account',  'layaway_accounts', 'reminder_logs',                  false, false),
        ('delete-account',  'layaway_accounts', 'reconciliation_log',             false, false),
        ('delete-account',  'layaway_accounts', 'account_services',               false, false),
        ('delete-account',  'layaway_accounts', 'final_settlement_records',       false, false),
        ('delete-account',  'layaway_accounts', 'penalty_cap_overrides',          false, false),
        ('delete-account',  'layaway_accounts', 'statement_tokens',               false, false),
        ('delete-account',  'layaway_accounts', 'payments',                       false, false),
        ('delete-account',  'layaway_accounts', 'layaway_schedule',               false, false),
        -- delete-customer (supabase/functions/delete-customer/index.ts)
        ('delete-customer', 'customers',        'customer_analytics',             true,  false),
        ('delete-customer', 'customers',        'layaway_accounts',               false, true)
        -- cash_orders has no delete function — allowlist intentionally
        -- empty so any blocking FK to cash_orders surfaces as a
        -- preventive finding.
    ),
    parents (parent_table, delete_function) AS (
      VALUES
        ('layaway_accounts', 'delete-account'),
        ('customers',        'delete-customer'),
        ('cash_orders',      '(none — soft-cancel only)')
    ),
    -- All blocking FKs in pg_constraint pointing at audited parents.
    fks AS (
      SELECT
        p.parent_table,
        p.delete_function,
        regexp_replace(c.conrelid::regclass::text, '^public\.', '') AS child_table,
        c.conname AS fk_name,
        CASE c.confdeltype
          WHEN 'a' THEN 'NO ACTION'
          WHEN 'r' THEN 'RESTRICT'
        END AS on_delete
      FROM pg_constraint c
      JOIN parents p
        ON c.confrelid = ('public.' || p.parent_table)::regclass
      WHERE c.contype = 'f'
        AND c.confdeltype IN ('a', 'r')
    ),
    -- Finding 1: blocking FK exists, child not covered by allowlist.
    -- pre_check_protected entries silently cover the FK so they do
    -- not appear here. Cash_orders gaps are info, others are critical.
    missing AS (
      SELECT
        f.delete_function,
        f.parent_table,
        f.child_table,
        f.fk_name,
        f.on_delete,
        false AS in_allowlist,
        CASE
          WHEN f.parent_table = 'cash_orders' THEN 'preventive_no_delete_fn'
          ELSE 'missing_cleanup'
        END AS finding_type,
        CASE
          WHEN f.parent_table = 'cash_orders' THEN 'info'
          ELSE 'critical'
        END AS severity,
        format(
          '%s blocks DELETE on %s but is not in the %s cleanup list. Add an explicit DELETE in the edge function or a pre-check that rejects deletion.',
          f.fk_name, f.parent_table, f.delete_function
        ) AS message
      FROM fks f
      WHERE NOT EXISTS (
        SELECT 1 FROM allowlist a
        WHERE a.parent_table = f.parent_table
          AND a.child_table  = f.child_table
      )
    ),
    -- Finding 2: allowlist entry that no longer matches a blocking FK.
    -- defensive entries are excluded because they are intentionally
    -- redundant (CASCADE at the DB level handles them, the explicit
    -- DELETE is belt-and-suspenders).
    stale AS (
      SELECT
        a.delete_function,
        a.parent_table,
        a.child_table,
        NULL::text AS fk_name,
        NULL::text AS on_delete,
        true AS in_allowlist,
        'stale_allowlist_entry' AS finding_type,
        'warning' AS severity,
        format(
          'Allowlist tracks %s.%s for %s but no NO ACTION/RESTRICT FK to %s exists. The FK may have been changed to CASCADE/SET NULL, or the table was dropped.',
          a.parent_table, a.child_table, a.delete_function, a.parent_table
        ) AS message
      FROM allowlist a
      WHERE a.defensive = false
        AND NOT EXISTS (
          SELECT 1 FROM fks f
          WHERE f.parent_table = a.parent_table
            AND f.child_table  = a.child_table
        )
    )
    SELECT * FROM missing
    UNION ALL
    SELECT * FROM stale
    ORDER BY severity DESC, parent_table, child_table;
  $$;

  REVOKE ALL ON FUNCTION public.audit_delete_cleanup_invariants() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.audit_delete_cleanup_invariants() TO authenticated;
  ```

  Maintenance rule:
    Whenever a new SQL-Editor table is created with a
    NO ACTION/RESTRICT FK to any audited parent, EITHER:
      1. Add the table to the relevant edge function's
         cleanup list AND add a row to the allowlist
         VALUES block, OR
      2. Set defensive=true (CASCADE at the DB level
         covers it; allowlist entry is redundancy), OR
      3. Set pre_check_protected=true (parent edge
         function's pre-check rejects deletion when
         this child has rows).
    Then run `SELECT * FROM audit_delete_cleanup_invariants()`
    in SQL Editor to confirm zero new findings.

  Verification — initial run on 2026-04-28: returned
  exactly 4 rows:
    - 3 critical: delete-customer missing cleanup for
      cash_orders, extension_requests, payment_submissions
    - 1 info:     cash_payments preventive (no
      delete-cash-order function exists)
    - 0 layaway findings: delete-account is fully
      covered after commits bdac341 + 1ff9cd8.

  After delete-customer fix (Known Fixed Bug #53,
  same day 2026-04-28): the 3 critical rows are
  resolved. Once Cynthia adds the 3 new allowlist
  rows to the audit RPC in SQL Editor:
    ('delete-customer', 'customers', 'cash_orders',         false, true),
    ('delete-customer', 'customers', 'extension_requests',  false, false),
    ('delete-customer', 'customers', 'payment_submissions', false, false)
  the RPC returns exactly 1 row — the cash_payments
  info finding (preventive, unchanged because no
  delete-cash-order function exists yet).

### email_send_log table

  Tracks every transactional email attempt with status
  (pending → sent / failed / suppressed / dlq), template_name,
  recipient_email, error_message. Use as ground-truth for
  email delivery diagnostics. NOTE: prior session notes
  referenced a "transactional_email_log" table — that name
  is incorrect; the actual table is email_send_log.

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

## Known Open Bugs

  Bugs that have been surfaced and triaged but not
  yet fixed. Each entry should describe the fix
  pattern so the next session can pick it up cleanly.

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
  - D8: Hardcoded `riskFactor = 0.85` at
    dashboard-summary line 417 is undocumented and
    drives Predicted (30d), Predicted (90d), and
    Expected Next Month cards. Move to system_settings
    table OR document the value choice in a code
    comment + CLAUDE.md.
  - D9: `predicted_30d_raw` subtitle wording is
    confusing — Finance.tsx Predicted (30d) card
    headline is risk-adjusted (×0.85) while subtitle
    "of {raw} due" exposes the un-adjusted value.
    Easy to misread as "predicted of X due" implying
    X is the target. Reword subtitle to clarify
    risk-adjustment, or surface both numbers more
    explicitly.

### AgingBuckets follow-ups (surfaced 2026-04-29)

  Two low/medium issues found while verifying the
  D2/D4 revert (commit 1b9ff78). Both will be
  folded into the same get_aging_buckets() RPC
  work as D2/D4.

  - AgingBuckets currency-prop partially resolved (2026-04-30):
    The component now consumes the currency prop for
    variant='amount' (toJpy conversion when displayCurrency=JPY;
    PHP-only filter when displayCurrency=PHP). This closed the
    user-visible "ignored" complaint.

    Optional follow-up: get_aging_buckets() RPC still does not
    take p_currency parameter. Adding it would push the filter
    to the SQL layer instead of the JS layer. Currently no
    behavioral difference because the JS-layer filter is correct.
    Defer to future session.

    (originally surfaced 2026-04-29, partially resolved 2026-04-30)

  - TEST-005 in Overdue & Due Soon widget:
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

  - 2 edge functions are completely missing from
    .github/workflows/supabase-functions-deploy.yml:
      - auth-email-hook (imports 6 templates from
        _shared/email-templates/)
      - reactivate-account (imports check-permission.ts)

    These functions deploy manually only. Pre-existing
    gap separate from bug #77 (which fixed the OR clause
    propagation for functions already in the workflow).
    Lower severity since manual deploys are tracked, but
    future Lovable changes to these functions will not
    auto-deploy.

    Surfaced 2026-05-01 during workflow gap investigation
    for bug #77.

### Currency toggle behavior (surfaced 2026-04-30)

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

### Priority/severity guide (as of 2026-04-30)

  Honest triage for the open bugs above + items in PENDING ITEMS.
  Updated when severity changes or items resolve.

  P0 — Customer-impacting / data integrity at risk
    None as of 2026-04-30.

  P1 — Operational gaps that affect business decisions (Medium severity)
    - Currency toggle final decision (Path A vs B). Mixed state
      is operationally workable but counterintuitive to new staff.
      Decision deferred today as Option 3 (defer) per session log.
    - Loyalty staff visibility — staff cannot see customer loyalty
      tier when handling accounts. Resolved per bug #63 for the
      page-access dimension; tier visibility on layaway accounts
      may still need surfacing.
    - Admin audit log UI (P6 in PENDING ITEMS legacy numbering) —
      DB triggers exist on audit_logs; no admin query UI to read
      "who changed what when." Compliance risk if dispute arises.

  P2 — Hygiene / consistency (Low severity)
    None as of 2026-05-01 (both items resolved — see bugs
    #74 and #75).

  P3 — Defensive hardening (Low severity, no known bugs)
    - Session timeout 2hr (P5 in legacy numbering) — security
      hygiene.

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

  - Bug #101 PATH 3 no-revoke empirical verification pending.
    Code change shipped 2026-05-14 (commit 326cc4d) removed
    fireLoyaltyRevoke from PATH 3 branch of auto-forfeit-settlement.
    Logic-only verification done; needs empirical fixture that triggers
    PATH 3 (6th penalty occurrence → status transition to final_settlement)
    and confirms loyalty lot stays ACTIVE with no revoke transaction
    logged. Fresh fixture required since CJ-2026-FORFEIT-P3 is already
    in final_settlement state with manually-restored lot.

  - Session lesson 2026-05-14: Bug #100 auto-deploy staleness incident
    recurred during Bug #101 deployment. Workflow reported success at
    326cc4d merge time; production function continued running pre-Bug #101
    code until forced redeploy via trivial whitespace change. Pattern is
    reproducible. Defense: empirical retest is the only proof of deployed
    code; never trust workflow success alone. For high-confidence deploys,
    request Lovable bundles a trivial change with the substantive change
    to guarantee the deployment hash differs.

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
    daily-payment-reminders:       00:02 UTC = 08:02 PHT ✅
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

  RACE CONDITION RULE:
    daily-send-reminders and daily-payment-reminders
    both call the send-reminders edge function.
    They are offset by 2 minutes to prevent simultaneous
    hits. Never schedule both at the same UTC minute.

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

## PAYMENT SUBMISSIONS FK NOTE (added 2026-04-28)

  payment_submissions.confirmed_payment_id is a SOFT
  reference — no FK constraint. It may point to either:
    - payments(id)        when submission.account_id IS NOT NULL  (layaway)
    - cash_payments(id)   when submission.cash_order_id IS NOT NULL (cash)

  Dispatch is by submission_type / cash_order_id presence,
  not by FK. The original FK to payments was DROPPED in
  production on 2026-04-28 because cash confirms always
  failed with FK violation (cash_payments rows are not in
  payments).

  Do NOT recreate this FK without first splitting
  confirmed_payment_id into two columns
  (confirmed_layaway_payment_id +
   confirmed_cash_payment_id) and migrating all rows.

## CASH ORDER CONFIRM ROLLBACK (added 2026-04-28)

  review-payment-submission cash branch hand-rolls
  rollback because edge functions have no DB transactions
  across multiple statements.

  Order of operations on cash confirm:
    1. Fetch cash_order (capture pre-update snapshot:
       total_paid, remaining_balance, status, completed_at)
    2. Re-validate ceiling
    3. INSERT cash_payments
    4. UPDATE cash_orders (totals + status if fully paid)
    5. UPDATE payment_submissions (status='confirmed',
       confirmed_payment_id, reviewer_user_id, etc.)

  Failure handling:
    - Step 3 fails → return 500, nothing to roll back
    - Step 4 fails → DELETE cash_payment from step 3,
      return 500
    - Step 5 fails → revert cash_orders to snapshot,
      DELETE cash_payment, return 500
    - Step 5 + revert both fail → audit-log
      'confirm_rollback_failed' with snapshot for manual
      reconciliation, return 500 with cash_payment_id in
      error message

  Production hit 2026-04-28: step 5 failed silently due
  to dropped FK collision (cash_payment.id not in
  payments table). Half-confirmed state corrupted the
  order: customer could not retry because
  remaining_balance was 0. Hotfix dropped the FK; this
  permanent fix wraps steps 3-5 with manual rollback.

## CASH ORDER EXPIRY (added 2026-04-28)

  Cash orders carry a manual expiration deadline.
  expires_at on cash_orders is set at order creation
  (NewCashOrder form) and is required — no default,
  no auto-derivation. Staff sets it per customer
  arrangement.

  Database (added 2026-04-28):
  - cash_order_status enum widened: pending, completed,
    cancelled, expired
  - cash_orders.expires_at (timestamptz, nullable)
  - cash_orders.expired_at (timestamptz, nullable)
  - idx_payment_submissions_cash_order_status

  Edit rights: admin + finance only.
  - "Edit Expiry" button on CashOrderDetail (admin/finance)
  - Direct UPDATE on cash_orders.expires_at (no edge
    function), audit-logged via audit_logs

  Cron (auto-expire-cash-orders):
  - Schedule: 30 0 * * * (08:30 PHT)
  - Runs after auto-forfeit-settlement and
    daily-reconciliation, alongside
    loyalty-inactivity-check
  - Selects WHERE status = 'pending'
    AND expires_at IS NOT NULL
    AND expires_at < NOW()
    AND remaining_balance > 0
  - Per order: status → 'expired', expired_at = now(),
    audit_logs row, fire-and-forget cash-order-expired
    email
  - Auto-rejects all pending payment_submissions on
    the order: status → 'rejected',
    reviewer_notes = 'Cash order expired (auto-rejected)'
  - MAX_ORDERS_PER_RUN = 100
  - Per-order try/catch — one failure does not abort
    the batch; failure is audit-logged separately
  - Confirmed payments (cash_payments) are NEVER
    voided — money already received stays received,
    only the unpaid portion is forfeited per terms

  Confirm guard (review-payment-submission):
  - cash_orders with status='cancelled' OR 'expired'
    cannot have payments confirmed
  - Partial-payment confirmations preserve the
    existing cash_orders.status when not fully paid
    (defense in depth — line 476 block already
    prevents confirming on cancelled/expired)

  Submit guard (submit-cash-payment):
  - Existing status check rejects anything that is not
    'pending' (line 116) — naturally blocks 'expired'
  - 409 duplicate guard relaxed: only blocks when an
    existing pending submission has the SAME amount
    AND SAME method (legitimate sequential partials
    are allowed)
  - Rate limit unchanged: 3 non-rejected/non-cancelled
    submissions per 24h. Auto-rejected-by-expiry
    submissions land at status='rejected', already
    excluded.

  Existing cash_orders backfilled with expires_at = NULL
  — these are EXEMPT from auto-expire until staff
  manually sets a date via Edit Expiry.

## CASH ORDER PARTIAL PAYMENTS (added 2026-04-28)

  Both staff and customer flows now support partial
  payments on cash orders.

  Math (review-payment-submission):
  - Already additive (lines 516–541, unchanged):
      newTotalPaid = total_paid + submitted_amount
      newRemaining = max(0, remaining_balance - submitted_amount)
      isFullyPaid → status='completed' + completed_at
      not fully paid → preserve current status
  - Rounded to 2 decimal places
  - Validates submitted_amount ≤ remaining_balance + 0.005
    at both submit and review time

  Loyalty trigger:
  - Points awarded only when the order completes
    (isFullyPaid). Partial payments do not award.

  RecordCashPaymentDialog:
  - Default mode: amount field locked, pre-filled with
    full remaining balance, button reads "Pay Full Amount"
  - "Make partial payment" toggle unlocks the amount
    field, button reads "Submit Partial Payment"
  - Validation unchanged: amount > 0 AND ≤ remaining + 0.005

  CashPortalPaymentDialog:
  - Already partial-friendly — no functional change
  - Cosmetic: "Pay by [date]" in Sheet header when
    expires_at is set

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

## SCHEMA FACTS & OPERATIONAL LEARNINGS (added 2026-05-16)

### loyalty_transactions full column reference

  Common-mistake column names that DO NOT exist on loyalty_transactions:
  event_type, points_change, amount_spent_jpy, multiplier, created_by (as text).

  Actual schema (verified via information_schema 2026-05-16):
    id                  uuid       PK
    member_id           uuid       NOT NULL, FK to loyalty_members.id
    account_id          uuid       nullable, FK to layaway_accounts
    cash_order_id       uuid       nullable, FK to cash_orders
    payment_id          uuid       nullable
    promo_id            uuid       nullable
    transaction_type    enum       NOT NULL (loyalty_transaction_type —
                                    12 values as of 2026-05-17; see
                                    "loyalty_transaction_type enum
                                    (2026-05-17 expansion)" below)
    points_amount       numeric    NOT NULL — signed; negative for
                                    redeemed/revoked/expired
    spend_amount_jpy    numeric    nullable
    rate_snapshot       numeric    nullable — PHP/JPY exchange rate at
                                    transaction time
    invoice_number      text       nullable
    tier_at_time        text       nullable
    notes               text       nullable
    created_by_user_id  uuid       nullable, FK auth.users
    created_at          timestamptz NOT NULL

  The sheet's "Multiplier" column is DERIVED at sync time by sync-loyalty-to-sheet
  via loyalty_tiers lookup keyed on tier_at_time — it is NOT stored on the
  transaction row.

### loyalty_transaction_type enum (2026-05-17 expansion)

  Original 7: earned, bonus, redeemed, expired, adjusted, refunded, revoked
  Added 5:    enrolled, tier_changed, status_changed, admin_edited, birthday_bonus

  (Total 12. birthday_bonus was already referenced in prior schema notes
  but is grouped here under the 2026-05-17 ALTER TYPE expansion that
  formally added the 5 member-event / lifecycle values. 475 historical
  'enrolled' rows backfilled from loyalty_members.enrolled_at, one row
  per member with non-null enrolled_at dated to actual enrollment time.)

  Member-event types (enrolled, tier_changed, status_changed, admin_edited):
    points_amount=0 by convention; spend_amount_jpy and other monetary
    columns typically NULL. Represent non-monetary lifecycle events.
  Transaction types (the original 7 + birthday_bonus): represent
    points-affecting events; monetary columns populated as relevant.

  Sub-tab filter convention in TransactionsTab.tsx:
    Member view: WHERE transaction_type IN ('enrolled', 'tier_changed',
                                            'status_changed', 'admin_edited')
    Transactions view: WHERE transaction_type IN ('earned', 'bonus',
                                                  'redeemed', 'expired',
                                                  'adjusted', 'refunded',
                                                  'revoked', 'birthday_bonus')

  Going-forward emission status (2026-05-17):
    enrolled       → wired (join-loyalty-program, non-blocking insert)
    tier_changed   → wired (award-loyalty-points, tierUpgraded block)
    status_changed → reserved, NOT yet emitted (future workstream)
    admin_edited   → reserved, NOT yet emitted (future workstream)
    birthday_bonus → reserved, NOT yet emitted (Phase 6.2)

### customers.email mixed-case storage (rule)

  customers.email is stored mixed-case in this DB (e.g. 'Stokesmaria85@yahoo.com'
  with capital S). Always use LOWER(c.email) = LOWER(...) when comparing by email.
  Case-sensitive comparison via = or IN (...) will silently drop matches without
  erroring. This rule applies to every email-keyed JOIN, WHERE, and UPDATE.

  Empirical case: 2026-05-16 catch-up migration — case-sensitive A1 query missed
  Stokesmaria85 entirely; only resurfaced via LOWER() lookup, leading to an
  UPDATE that would have erroneously re-enrolled an existing member.

### Supabase SQL Editor CSV export alphabetizes columns

  Supabase SQL Editor's "Export to CSV" sorts result columns alphabetically by
  column name, regardless of the SELECT order specified in the query. The
  in-editor result grid also displays columns alphabetically. This is irrelevant
  for inspection but breaks any downstream import where column position matters
  (e.g. appending to a Google Sheet with locked column order).

  Workaround: post-export reorder via Python pandas/csv module before downstream
  use. Confirmed twice — Substep 7 backfill 2026-05-16 (475 + 372 rows) and
  catch-up migration 2026-05-16 (6 + 6 rows). Template script lives at
  /home/claude/build_csvs.py in the Claude sandbox during such sessions.

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

## INVOICE GENERATOR — SHIPPED 2026-05-10

  Workstream tracking the JPY-only invoice generator that creates
  Google Sheets in Drive folder Invoice/{YYYY}/{MM}. {Month}/.

  Locked decisions:
    Auth:            Google Service Account JWT (jose@5, RS256)
                     Service account: firebase-deployer@cha-jewels-la-tracking.iam.gserviceaccount.com
    File format:     native Google Sheet (not .xlsx)
    Currency:        JPY only (regardless of account currency)
    Math model:      post-tax discount (NOT D-1a as originally proposed)
                       tax   = round(subtotal_pretax × 0.10)
                       total = max(0, subtotal_pretax + tax − discount + shipping)
                     Matches master template's print-tab formulas.
                     Customer-facing total = DB total, exactly.
    Drive root:      Shared Drive Invoice folder
                       (set via INVOICE_ROOT_FOLDER_ID Supabase secret)
                     Original My Drive folder 1bMiQMq3-avl1sq5_EU3T9sIlmLOQmp7k
                     ABANDONED due to service-account storage quota.
    Master template: 15peyTqLv4q6rne1ois6bxV1cRoMjkXfiPk48XmAVJeo
                       INVOICE_MASTER_TEMPLATE in Shared Drive Invoice folder
                       set via MASTER_INVOICE_TEMPLATE_ID Supabase secret
                     4 tabs: Invoice-Use this (data entry, tax-inclusive prices)
                             InvoiceWithTax-Print this (customer printable)
                             Cash Receipt, Help
                     Function writes to Invoice-Use this only.
                     Print tab pulls via formulas → division by 1.1 to
                     show pretax breakdown.
    Folder convention: Invoice/{YYYY}/{MM}. {Month}/ (auto-create)
    Filename (D-3b): {invoice_number} first;
                     {invoice_number}-v{N+1} on regenerations
                     (count from existing generated_invoices rows).
    UI surface:      shadcn Sheet (slide-out side panel)
    Form state:      plain useState (mirror RecordPaymentDialog pattern)
    Trigger placement:
                     AccountDetail — between RecordPaymentDialog
                       and AddServiceDialog
                     CashOrderDetail — after Record/Submit Payment,
                       before Cancel Order
    Role gating:     admin + finance + staff

  Pre-requisites confirmed 2026-05-09:
    GOOGLE_SERVICE_ACCOUNT_JSON Supabase secret set
    INVOICE_ROOT_FOLDER_ID Supabase secret set (Shared Drive folder)
    MASTER_INVOICE_TEMPLATE_ID Supabase secret set
    Drive API + Sheets API enabled on cha-jewels-la-tracking GCP project
    Service account is Content Manager on Shared Drive
    Drive API calls include supportsAllDrives=true and
      includeItemsFromAllDrives=true for Shared Drive support

  Cell layout (Invoice-Use this tab) — function-locked:
    F5  = Invoice #         H5  = Date
    F7  = Order Type        H7  = Terms
    A12 = Bill To name      F12 = Ship To name
    A14 = Bill To addr 1    F14 = Ship To addr 1  (postal+city+country)
    A15 = Bill To addr 2    F15 = Ship To addr 2  (street/building)
    A16 = Bill To phone     F16 = Ship To phone
    Items rows 21-33 (max 13):
      col A = description    col F = qty
      col G = unit price     col H = amount  (both tax-INCLUSIVE)
    H34 = subtotal (formula — function does NOT write)
    H35 = discount (function writes value)
    H36 = shipping fee (function writes value)
    H37 = final total (formula — function does NOT write)
    Unused item rows beyond items count: A/F/G cleared by function
    to prevent template sample data bleed-through.

  Step 1a — SHIPPED 2026-05-09 (schema + RPC patches):

    Phase α — customers table:
      Added 4 nullable columns: address_line1, city, postal_code, country
      country backfilled from location for all 667 rows
      4 normalizations: Hongkong → Hong Kong, UK → United Kingdom,
        Netherland → Netherlands, Korea → South Korea

    Phase β-1 — generated_invoices table:
      17 columns, RLS enabled with 5 policies, 4 indexes
      Parent FKs: account_id, cash_order_id (both ON DELETE RESTRICT)
      CHECK constraint: exactly_one_parent (XOR on the two FKs)
      Snapshot columns (jsonb): ship_to, bill_to, items
      Totals (numeric(12,0)): discount_jpy, shipping_fee_jpy,
        subtotal_pretax_jpy, tax_jpy, total_jpy
      No void mechanism — regeneration writes a new row,
        latest by generated_at = current

    Phase β-2 — delete_account_atomic patched:
      New step 16 deletes generated_invoices before the account row
      Function comment updated: 16 → 17 explicit DELETEs

    Phase β-3 — audit_delete_cleanup_invariants allowlist:
      Added ('delete-account', 'layaway_accounts',
             'generated_invoices', true, false)

    Phase β-4 — delete-customer/index.ts: NOT patched (intentional)
      Pre-check at lines 67-107 transitively guards generated_invoices
      via accounts/cash_orders blockers.

  Audit baseline post-Step 1a:
    SELECT * FROM audit_delete_cleanup_invariants();
    Expected: 0 critical, 0 warning, 2 info rows
      - cash_payments → cash_orders (existing preventive)
      - generated_invoices.cash_order_id → cash_orders (new preventive)

  Step 1b — SHIPPED 2026-05-09:
    Final commit chain on main:
      3f6d2b1 — initial generate-invoice edge function + workflow
      0556426 — SHEET_NAME = "Invoice-Use this", DWD setup
      69a8338 — cell layout + tax-inclusive item prices
      2486963 — post-tax discount math (final correction)

    File: supabase/functions/generate-invoice/index.ts (~600 lines)
    Workflow: .github/workflows/supabase-functions-deploy.yml has
              path-trigger + deploy step (NO --no-verify-jwt)

    End-to-end test (TEST-004, 13-item payload, ¥5,000 discount,
    ¥1,500 shipping):
      subtotal_pretax_jpy: 313,500
      tax_jpy:              31,350
      total_jpy:           341,350
    DB row matches print tab cell-for-cell.

    Deploy lesson learned (2026-05-09):
      Lovable can report "deployed successfully" while the live
      edge function stays on prior code. After every Lovable code
      change to an edge function, force manual deploy from Cloud Shell:
        npx supabase login   (first time or session expired)
        npx supabase functions deploy <function-name> \
          --project-ref pfoicalpzdcmyxzvwyhz
      Verify by re-running the test invocation and checking values
      of the most-recent affected row.

  Step 1c — SHIPPED 2026-05-10:
    Frontend wiring complete on both surfaces, with count-badge polish.

    Step 1c-1 — SHIPPED 2026-05-09 (commit 91c5ac5):
      New file: src/components/invoices/InvoiceGeneratorSheet.tsx
      Self-contained shadcn Sheet (slide-out) with invoice form.
      Form fields: ship_to + bill_to (with "same as ship to" default ON),
        items array (1-13), discount, shipping fee, terms.
      Edge function call: supabase.functions.invoke('generate-invoice')
      Two-stage UX: form → success (sheet URL + Open in Drive +
        Generate Another + Done).
      Internal role gate: admin / finance / staff (returns null otherwise).
      Live total preview matches Invoice-Use this display math.

    Step 1c-2 — SHIPPED 2026-05-10 (commit f0edac4):
      Wired into src/pages/AccountDetail.tsx between Messenger link
      and AddServiceDialog. Spot A placement — outside the
      payment-eligibility gate, so visible regardless of account
      status (paid, overdue, forfeited, etc.).
      Pre-fills ship_to + bill_to from account.customers (the
      existing useAccount hook already fetches customers(*) — no
      extra query).
      Tested end-to-end on TEST-004:
        13-item payload, ¥5,000 discount, ¥1,500 shipping
        DB row: subtotal_pretax_jpy=313,500, tax_jpy=31,350,
                total_jpy=341,350
        Drive sheet matches print tab cell-for-cell.

    Step 1c-3 — SHIPPED 2026-05-10 (commit d775e16):
      Wired into src/pages/CashOrderDetail.tsx in the action button
      row (Spot B). Sits between the Submit Payment button and
      the Cancel Order button. Outside both canRecordPayment and
      canCancel gates — visible regardless of cash order status.
      Required broadening the existing useCashOrderDetail hook's
      SELECT from customers(id, full_name) to include
      address_line1, city, postal_code, country, mobile_number.
      CashOrderRow.customers type expanded to multi-line shape.
      Tested end-to-end on cash order 18991 (PHP, completed):
        DB row: account_id=NULL, cash_order_id populated,
        subtotal_pretax_jpy=82,709, tax_jpy=8,271, shipping=1,988,
        total_jpy=92,968.
      Confirms exactly_one_parent CHECK constraint working.

    Step 1c-4 — SHIPPED 2026-05-10 (commit 530c039):
      Polish: prior-generation count badge on the trigger button.
      Reads from generated_invoices via useQuery, keyed by parent.
      Auto-bumps on successful generation via
      queryClient.invalidateQueries.
      Hidden when count = 0; shows secondary Badge with count when > 0.
      Provides "wait, was this already invoiced?" signal to staff
      without the cost of a full invoice-history list.

    Final commit chain on main:
      91c5ac5 — 1c-1 InvoiceGeneratorSheet component
      f0edac4 — 1c-2 wire into AccountDetail
      d775e16 — 1c-3 wire into CashOrderDetail
      530c039 — 1c-4 count badge

    Verified working surfaces:
      AccountDetail.tsx — Generate Invoice button visible to
        admin/finance/staff regardless of status; pre-fills from
        customer record; count badge shows prior generations.
      CashOrderDetail.tsx — same behavior; broadened SELECT
        ensures all 6 address fields available for pre-fill.

  Step 1d — SHIPPED 2026-05-10 (commit 154ac2c):
    get-page365-order edge function fetches Page365 order data
    from the latest CSV in the _Page365-Mirror Drive folder
    (PAGE365_MIRROR_FOLDER_ID secret). Reads UTF-16 LE TSV,
    filters by invoice number, returns:
      { found, address?, phone?, shipping_fee?, discount?,
        items?: [{ description, qty, unit_price_with_tax }] }

    Implementation:
      Extracted shared getServiceAccountAccessToken helper into
        supabase/functions/_shared/google-auth.ts (was previously
        inlined in generate-invoice).
      generate-invoice refactored to import the shared helper
        (zero behavior change, pure refactor).
      get-page365-order: 153 lines, single POST handler.

    End-to-end test (invoice 18952, Roselyn Julianda Valenzuela):
      Returns 2 items (necklace + bracelet totaling ¥84,960),
      Saudi Arabia address, phone — all correct.

    Final commit chain on main:
      154ac2c — feat(invoice): get-page365-order edge function +
                extract google-auth helper

  Step 1e — SHIPPED 2026-05-10 (commit 70d8491):
    InvoiceGeneratorSheet pre-fills SHIP TO address, phone,
    items, discount, and shipping fee from get-page365-order
    when the dialog opens. Customer name preserved from
    prefillAddress prop (customers table).

    Implementation:
      useQuery on ['page365-order', parentInvoiceNumber] enabled
        when dialog open + invoice number present + user authorized.
      useEffect on page365Error → toast.error fallback for
        network/Drive failures.
      useEffect on page365Data?.found === true → setShipTo,
        setItems (mapping unit_price_with_tax →
        unit_price_jpy_inclusive), setDiscount, setShipping.
      "Pre-filled from Page365" Badge (variant="secondary")
        shown next to SHIP TO heading when data loaded.
      Page365 wins on conflict: address_line1 = full address
        string, city/postal_code/country cleared (Page365 has
        it all in one field), phone overridden, name preserved
        from customers table.
      found=false → silent fallback (no toast, dialog
        behaves exactly as before).

    End-to-end verified on invoice 18952 in production: dialog
    opened, badge appeared, all fields auto-populated within
    ~1 second. Invoice generated correctly via Google Sheets
    with all pre-filled data.

    Final commit chain on main:
      70d8491 — feat(invoice): wire Page365 pre-fill into
                InvoiceGeneratorSheet

  ### Step 2 — Cash Receipt Auto-Population (SHIPPED 2026-05-11)

  Cash Receipt tab of generated invoices is auto-populated with
  proof-of-payment images and metadata for every confirmed
  payment_submissions entry on the parent account/cash_order.

  Architecture:
  - _shared/cash-receipt.ts — 13-slot canonical cell map + Sheets
    API helpers (buildSlotUpdates, appendOneReceipt,
    appendManyReceipts). Single source of truth for slot positions
    and =IMAGE formula construction.
  - append-cash-receipt edge function — thin HTTP wrapper that
    delegates to appendOneReceipt. Used for incremental writes
    from review-payment-submission and for ad-hoc curl testing.
  - generate-invoice extension — on Sheet creation, queries all
    confirmed receipts for parent (ORDER BY payment_date ASC,
    created_at ASC, LIMIT 13), embeds them in a single Sheets API
    batchUpdate via appendManyReceipts. Persists
    cash_receipt_sheet_id on parent table. Response gains
    embedded_receipt_count field.
  - review-payment-submission extension — on confirm in cash-order
    branch, fires-and-forgets append-cash-receipt with the new
    receipt's slot_index. Same in layaway branch for single-
    allocation submissions only (confirmedPaymentIds.length === 1).

  PHP→JPY conversion: per CLAUDE.md CURRENCY CONVERSION STANDARD,
  amounts are converted PHP ÷ rate before display. Rate fetched
  from system_settings.php_jpy_rate (jsonb scalar). Always
  displays as "{amount} JPY".

  Slot layout: 13 slots in the Cash Receipt tab.
  - Column B: slots 1, 2, 3 (image B5, B58, B110 / metadata B40, B93, B145)
  - Column I: slots 4, 5, 6 (image I5, I58, I110 / metadata I40, I93, I145)
  - Column P: slots 7, 8, 9 (image P5, P58, P110 / metadata P40, P93, P145)
  - Column W: slots 10, 11, 12, 13 (image W5/58/110/158 / metadata W40/93/145/191)

  Failure isolation: receipt-embed errors caught and logged with
  console.warn, never block invoice generation or payment
  confirmation. Slot overflow (slot_index > 13) logs and skips.

  Schema columns:
  - layaway_accounts.cash_receipt_sheet_id text NULL (added 2026-05-11)
  - cash_orders.cash_receipt_sheet_id text NULL (added 2026-05-11)

  ### Folder logic fix (SHIPPED 2026-05-11, commit 194b13f + 5c9bff2)

  Bug: generate-invoice used `new Date()` for the target Drive
  folder, so backdated regenerations landed in the current month
  instead of the order's month.

  Fix:
  - layaway_accounts and cash_orders SELECTs widened to include
    `order_date`.
  - parentOrderDate captured alongside parentInvoiceNumber.
  - Folder resolution parses parentOrderDate as "YYYY-MM-DD"
    (date type, no tz). MONTH_NAMES[mm - 1] gives "NN. Month".
  - Defensive fallback to current date if order_date is null or
    non-ISO (column is NOT NULL in schema; fallback is insurance).

  Side effect: required hotfix commit 5c9bff2 to restore the
  `const now = new Date();` declaration that was used at line 451
  (CELLS.invoice_date) but accidentally removed in the folder fix.

  ### Currency conversion conditional (SHIPPED 2026-05-11, commit 46fb78f)

  Rule: payment_submissions.submitted_amount is stored in the
  parent account's currency. Cash receipt display always shows
  JPY. So:

  - JPY accounts: submitted_amount used as-is (no conversion)
  - PHP accounts: submitted_amount converted via Math.round(
    amount / php_jpy_rate) — per CLAUDE.md CURRENCY CONVERSION
    STANDARD (JPY = PHP ÷ rate)

  Applies in both generate-invoice (bulk fill) and
  review-payment-submission (cash + layaway branches).

  Widened both function's parent SELECTs to include `currency`.
  Used a ternary: `currency === "JPY" ? amount : Math.round(amount / rate)`.

  ### Cleanup completed (2026-05-11)

  - generated_invoices.drive_folder_path audit returns 0 misfiled
    rows after the folder fix shipped and stale rows were DELETED.
  - The 12 original misfiled rows from before the folder fix were
    cleaned up via:
      DELETE FROM generated_invoices gi USING layaway_accounts la
      WHERE gi.account_id = la.id AND gi.drive_folder_path != ...;
    (and the cash_orders equivalent)
  - Drive files for those 12 invoices marked for staff
    regeneration via the fixed generate-invoice — they'll land in
    correct order_date folders with correct JPY amounts.
  - Buggy 18946 row (sheet_id 1WBlOv6CoszfZxmNP_a6TCDOy2_HWGXphOIWKadZos7s,
    generated 11:13:44 UTC, showed 60,590 JPY) deleted from
    generated_invoices; 18946-v2 at 1erhLngGJ3y6... is the
    canonical correct version (25,448 JPY).

## SYSTEM STATUS (as of 2026-05-16)

  Phase B email/password authentication: SHIPPED ✅ (2026-05-05)
    - Customer portal supports both token-based and email/password auth
    - Per-customer routing via customers.auth_user_id
    - Token auth permanent — no sunset, no revocation on signup
    - Admin Send Setup Link UI on CustomerDetail page
    - Production-validated 2026-05-06 via CJ-2026-05088 re-migration
    - 71 no-email customers + Cabalza family stay on token auth indefinitely

  Phase B post-launch hardening: SHIPPED ✅ (2026-05-06)
    - Phase 1 portal-link helper integration: 3 admin URL builders
      now route via getPortalLinkForCustomer() —
      src/pages/CustomerDetail.tsx, src/pages/AccountDetail.tsx,
      src/components/customers/CustomerPortalShareMenu.tsx
      (commit 5363f7d). Migrated customers receive bare URL,
      non-migrated continue with token URL.
    - Phase 2 portal-link helper integration: reminder cards
      (Monitoring overdue/grace/due_today/upcoming via
      ReminderCard, commit d2525ce) + P1-P8 penalty messages
      and dialog action buttons (PenaltyFollowUpSection,
      commit 0ea159a) + Monitoring portalTokens query reshape
      with auth_user_id (commit 7ff6937)
    - portalTokens query Map shape extended:
      Map<string, { token, authUserId }>; queryKey renamed to
      'portal-tokens-with-auth' in both PenaltyFollowUpSection
      and Monitoring to invalidate stale browser caches.
      useAutoRefresh entries updated in lockstep with the
      query key rename.
    - Staff-email collision detection: SHIPPED ✅ — new
      check_customer_email_conflict(p_customer_id)
      SECURITY DEFINER RPC + yellow warning banner + Copy URL
      + Messenger alt-channel buttons in CustomerPortalShareMenu
      (commit 8265ce6). Prevents future Brendalyn-style mishaps
      where admin unknowingly sends a setup link to an email
      belonging to a staff account, which would silently link
      the customer to the staff auth user.
    - Email template HSL color fix (Yahoo Mail PH): see
      Known Fixed Bug #82 (commit e0c7719). General rule:
      inline email CSS must use hex or rgb(), never hsl().
    - PortalSetup Loading-screen timeout + bootstrapping flag
      fix: see Known Fixed Bug #83 (commit 633c211).
    - PWA NetworkFirst nav caching: see Known Fixed Bug #84
      (commit 4014f97).
    - Pilot customer migrations: 3 customers migrated to
      email/password — CJ-2026-05088 "Test Customer"
      (unattended verification), Brendalyn CJ-2026-03936
      (manual SQL email fix needed after a deferred SQL
      placeholder bug), Cholita CJ-2026-02000 (clean
      unattended after HSL→hex email fix).
    - Net result: migrated customers (auth_user_id IS NOT NULL)
      now consistently receive bare
      https://portal.chajewelsjp.com/portal URLs across admin
      payment confirmations, reminder cards
      (overdue/grace/due_today/upcoming), and P1-P8 penalty
      messages. Non-migrated customers continue receiving
      ?token=X URLs.

  Phase 4-B2.5 — Extension request session-auth wiring: SHIPPED ✅ (2026-05-07)
    - Commit 3741326. Frontend-only fix in
      src/pages/CustomerPortal.tsx (+12/-4 lines).
    - handleExtensionRequest now uses
      getPortalAuthHeaders(portalToken):
        * token-auth users → empty headers (anon fallback
          unchanged)
        * session-auth users → Bearer JWT (PostgREST sees
          authenticated role, matches existing
          TO authenticated WITH CHECK (true) RLS policy on
          extension_requests)
    - Body now writes customer_id from new AccountDetail prop
      so admin queue can identify session-auth requesters even
      when portal_token is null.
    - Notification email's portalUrl now calls
      getPortalLinkForCustomer({ auth_user_id: null,
      portal_token: portalToken || null }, 'portal') — token URL
      when token present, bare /portal URL when null.
    - Unblocks customer-side extension requests for migrated
      session-auth users without depending on RLS file 6 (which
      contains SELECT-only policies, unrelated to the INSERT
      path). Original "RLS policy work" diagnosis from session
      memory was a misdiagnosis — RLS was already permissive
      enough.

  delete-account → delete_account_atomic atomic RPC: SHIPPED ✅ (2026-05-08)
    - 16-step FK cleanup + audit log wrapped in single transaction
      (atomic). Partial failures roll back; eliminates silent
      audit gaps from prior TypeScript implementation.
    - Defense-in-depth admin role check at both edge function
      and RPC layers (auth.uid() + public.has_role inside
      SECURITY DEFINER body; Bearer JWT + supabase.rpc('has_role')
      at edge function entry).
    - Edge function rewritten as thin wrapper (~85 lines, down
      from 159). Caller contract unchanged; useDeleteAccount hook
      and AccountDetail UI button untouched.
    - Closes prior security gap: any authenticated user could
      previously call delete-account directly without admin role
      check (edge function only validated JWT presence, never
      role).
    - All 5 smoke tests passed in production SQL Editor before
      commit:
        1. Pre-delete inventory baseline (1 account, 3 schedule rows)
        2. RPC returned {"success": true} on first valid call
        3. Cleanup verified: account=0, schedule=0, audit_logs=1
        4. Re-call on deleted UUID returned {"error": "Account not found"}
        5. Atomic rollback — wrong-UUID FK exception rolled back
           all 16 deletes (audit-or-nothing semantics verified)
    - RPC body in
      supabase/migrations/20260508013641_delete_account_atomic.sql

  PHASE B BULK ROLLOUT (added 2026-05-07)
    - Purpose: one-time broadcast to send the
      portal-setup-invite email to every eligible customer
      that has not yet been migrated. After Phase B's per-
      customer admin button validated the flow, this delivers
      Setup Links at scale (586 net-deliverable customers at
      deploy time) without admins clicking each customer
      individually.
    - Edge function:
      supabase/functions/bulk-send-setup-invites/index.ts
    - Companion RPC: get_bulk_setup_invite_candidates
      (supabase/migrations/20260507000001_bulk_setup_invite_candidates.sql)
      SECURITY DEFINER, returns the next batch of eligible
      customers + total_eligible. Two modes: count_only=true
      returns a single row with the total; count_only=false
      returns up to p_limit rows ordered by customer_code.
    - Auth: admin-only. Edge function extracts Bearer JWT,
      calls supabase.auth.getUser, then queries user_roles
      and rejects with 403 if role !== 'admin'. Mirrors the
      manual-forfeit pattern. The RPC also gates on
      public.has_role(auth.uid(), 'admin'); service_role
      callers (auth.uid() IS NULL inside the edge function)
      pass through, but direct PostgREST calls without admin
      role are blocked.
    - Exclusions baked into the RPC (every condition must
      hold for a customer to receive the invite):
        * customers.email IS NOT NULL
        * auth_user_id IS NULL (not yet migrated)
        * setup_link_sent_at IS NULL (no prior invite)
        * LOWER(email) NOT IN auth.users (staff-collision
          exclusion — prevents the Brendalyn-style mishap)
        * email NOT shared by 2+ unmigrated customers
          (Cabalza-pattern exclusion — shared family inbox)
    - Net deliverable at deploy time: 586 customers.
    - Idempotent: each successful send stamps
      customers.setup_link_sent_at = NOW(); subsequent runs
      automatically skip already-sent customers via the
      RPC's setup_link_sent_at IS NULL filter. Failed sends
      do NOT stamp, so they remain eligible for retry on the
      next batch.
    - Architecture: per-candidate
      supabase.functions.invoke('send-transactional-email')
      with templateName 'portal-setup-invite' (matches the
      per-customer admin button payload from
      CustomerPortalShareMenu.tsx exactly). No in-function
      throttle — process-email-queue (cron every 5 seconds)
      paces actual delivery. Suppression list and unsubscribe
      tokens are enforced by send-transactional-email so the
      bulk function piggybacks on existing safety nets.
    - Test mode: pass test_customer_codes (string[]) in the
      request body to scope the candidate set to specific
      customer_codes for targeted dry runs or pilot batches.
      Test codes are an ADDITIONAL filter; staff-collision /
      shared-email customers in the test list are still
      excluded (the safety floor is non-negotiable).
    - Dry-run mode: { dry_run: true } returns the candidate
      preview without sending or stamping.
    - Cloud Shell driver: while-loop calling the endpoint
      until response.remaining_eligible === 0. Recommended
      batch_size 50 (default; clamped to 1..100). Each
      response also includes per-failure errors[] for audit.
    - Workflow note: this is the function's first commit, so
      per Bug #77 the path-trigger may not fire on initial
      deploy (commits.*.added is not detected). The same
      commit also touches .github/workflows + CLAUDE.md so
      the workflow run does fire — but if for any reason the
      Deploy bulk-send-setup-invites step skips, run a manual
      Cloud Shell deploy:
        npx supabase functions deploy bulk-send-setup-invites \\
          --project-ref pfoicalpzdcmyxzvwyhz

  Cash Basis Plan Phase 1 (DB): COMPLETE ✅
    - cash_orders table created with 3 indexes
    - cash_payments table created with 2 indexes
    - payment_submissions extended with cash_order_id
    - cash_order_status enum created (pending/completed/cancelled)
    - RLS policies on both tables (admin full, staff/finance read+insert)
    - updated_at trigger on cash_orders

  Cash Basis Plan — Non-Negotiable Rules:
    - Cash orders: one-time full payment, no schedule, no DP
    - Penalty engine: skips WHERE cash_order_id IS NOT NULL
    - Auto-forfeit: does NOT apply to cash orders
    - All flows (submissions, proof, void, loyalty) use same infrastructure
    - Invoice numbers entered manually same as layaway

  Cash Basis Plan: COMPLETE ✅ (2026-04-25)
    - Database: cash_orders + cash_payments tables live
    - 6 edge functions deployed (create/submit/void/
      review/dashboard/customer-portal)
    - Full UI: Cash tab, NewCashOrder, CashOrderDetail,
      customer portal integration, submissions handling
    - 2 email templates (cash-payment-submitted,
      cash-payment-confirmed)
    - KPIs: Dashboard + Finance + Executive all show
      cash metrics
    - Cancellation tracking (cancelled_at, reason, user)
    - Payment submissions go through review flow

  Cash Basis Plan — Known Gaps:
    - Cash payment rejection/clarification emails
      silently fail (no cash-specific templates built yet)
    - Executive dashboard 6-month history chart for
      cash vs layaway deferred (needs
      cash_revenue_by_month_6m RPC)

  Cash order payment submission flow: LIVE ✅ (2026-04-27)
    - submit-cash-payment: duplicate guard (409),
      rate limit (3/24h, excludes cancelled+rejected)
    - account_id nullable on payment_submissions
    - anon storage policy for payment-proofs bucket
    - service_role SELECT/UPDATE policies on customers table
    - Payment methods: CHA_PAYMENT_METHODS shared to
      src/lib/payment-methods.tsx
    - Pending Submissions hidden when cash order completed
    - Cancel submission: customer can cancel and resubmit

  Cash order item_description: REMOVED from form ✅ (2026-04-27)
    - Column remains nullable in DB for invoice use

  Loyalty Program Phase 1 (DB): COMPLETE ✅ (2026-04-25)
    - 5 tables created: loyalty_tiers, loyalty_members,
      loyalty_transactions, loyalty_redemptions,
      loyalty_promos, loyalty_beta_members
    - 3 enums: loyalty_transaction_type,
      loyalty_redemption_type, loyalty_redemption_status
    - 4 tiers seeded: Glimmer/Radiant/Elite/Crown VIP
    - loyalty_jpy_amount column on BOTH layaway_accounts
      and cash_orders (for both earning paths)
    - 18 RLS policies (admin/staff/finance scoped)
    - Feature flag system_settings.loyalty_enabled = false
    - Beta gate ready for testing

  Loyalty Program — Non-Negotiable Rules (locked v2):
    - Points: floor(jpy_equiv / 10,000) × 100 × tier_mult
    - Tiers: Glimmer(0)/Radiant(1M)/Elite(4M)/Crown VIP(8M)
    - Inactivity: 6 months → tier downgrade + points zeroed
    - Pre-expiry email: 14 days before 6-month mark
    - Redemption: 3 types only — new_order_discount/
      shipping_fee/service_fee
    - NO cash payout, NO partial payment to existing balance
    - Invoice number required on every redemption
    - Enrollment: opt-in via portal Join button
    - Cash order trigger: points awarded on completion
    - Layaway trigger: points awarded on DP confirmation
    - Google Sheet: backup mirror, sync on every points update
    - GAS emails: must be disabled — Supabase is sole sender

  Loyalty Program Phase 2 (Edge Functions): COMPLETE ✅ (2026-04-25)
    - 5 new functions: award-loyalty-points,
      sync-loyalty-to-sheet (stub), join-loyalty-program,
      process-loyalty-redemption, loyalty-inactivity-check
    - 3 updated: create-layaway-account, create-cash-order,
      review-payment-submission (DP + cash completion
      triggers wired)
    - pg_cron job 'loyalty-inactivity-check' scheduled
      daily at 08:05 PHT (job_id 13)
    - Sheet sync deferred — stub function in place,
      Google Cloud service account setup pending

  Loyalty Program Phase 3 (UI): COMPLETE ✅ (2026-04-25)
    - LoyaltyPortal page at /loyalty route
    - MemberCard, PointsSnapshot, VipProgressSection,
      RecentActivity, RedemptionForm, TierCelebrationModal
    - Beta gate: useLoyaltyAccess hook + LoyaltyComingSoon
      + LoyaltyJoinPrompt
    - 💎 My Loyalty card in CustomerPortal.tsx
    - customer-portal edge function returns loyalty data

  Loyalty Program Phase 4 (Emails): COMPLETE ✅
    - 8 email templates: welcome, earned, bonus,
      tier-upgrade, tier-downgrade, pre-expire,
      expire-deduct, redeem
    - All wired into edge functions with correct
      template names + props
    - buildLoyaltyPortalUrl helper for server-side
      portal URL generation

  Loyalty Program Phase 5 (Admin): COMPLETE ✅
    - Loyalty tab in Customer Detail (full history)
    - Pending Redemptions queue at /loyalty/redemptions
    - Sidebar badge with pending count
    - Loyalty Promos tab in Promotions menu
    - Settings tab: feature flag toggle + beta whitelist
      + system stats
    - Beta whitelist functional (add/remove)

  Loyalty Program — Deployed to Production:
    - All edge functions deployed via auto-deploy
    - Frontend live on Firebase
    - Feature flag OFF — beta mode active
    - notify_loyalty_launch table created for
      "notify me" email collection
    - account_notes.cash_order_id column added
      (already part of cash plan)

  Loyalty Program — Known Backlog:
    - Cash payment rejection/clarification emails
      silently fail (deferred from cash plan)
    (Sheet sync now LIVE — see 2026-05-15 → 2026-05-16
     GSheet loyalty backup workstream. Adjust Points now
     SHIPPED & VALIDATED — see entry below.)

  Adjust Points feature: SHIPPED & VALIDATED ✅ (2026-05-17)
    - admin/finance can manually add or deduct loyalty
      points via UI dialog (AdjustPointsDialog.tsx +
      CustomerLoyaltyTab.tsx, gated by
      can('loyalty_adjust_points'))
    - adjust-loyalty-points edge function: signed
      points_delta, reason ≥10 chars, admin OR finance
      has_role auth, server-side overdraw guard fires
      BEFORE ledger/counter/audit writes (true
      defense-in-depth)
    - Writes loyalty_transactions (type='adjusted'),
      updates loyalty_members counters, audit_logs entry,
      in-portal notification (emit-notification master +
      recipient pattern), sheet sync (adjusted event)
    - 5/5 smoke tests + server-side guard code-review
      pass 2026-05-17 (permission seeded; +100 / -50 to
      Efrhyll Largo CJ-2026-05448 confirmed; overdraw
      client + server reject with no DB change; staff
      403 UI gate)
    - Shipped commit 7f8ea84

  Loyalty Transactions tab with Member/Transactions sub-tabs: SHIPPED ✅ (2026-05-17)
    - 8th tab on LoyaltyAdmin page (between Audit Log and Promotions),
      read-only feed of loyalty_transactions rows mirroring the Google
      Sheet backup structure
    - Two sub-tabs: Member (enrolled/tier_changed/status_changed/admin_edited)
      and Transactions (earned/bonus/redeemed/expired/adjusted/refunded/
      revoked/birthday_bonus); independent filter/page state per sub-tab
    - Table: date, type (color-coded badge), member (clickable to Members
      tab), points (signed/colored), spend, tier, invoice (deep-link),
      truncated notes with tooltip
    - Filters: date range (All / 7 / 30 / 90 days) + type dropdown
      (adapts to active sub-tab) + member search (case-insensitive
      client-side over customer_code + full_name); CSV export
    - Drawer: full transaction detail with conditional field rendering,
      "Open member profile" link, source deep-links to account/cash order,
      regex-parsed "Tier change" highlight card for tier_changed rows
    - 475 historical 'enrolled' rows backfilled from loyalty_members.enrolled_at
    - Future enrollments emit 'enrolled' rows via join-loyalty-program
    - Future tier upgrades emit 'tier_changed' rows via award-loyalty-points
    - Commits: d636a4f (initial tab) + f5f6d98 (sub-tabs + event wiring)
    - Edge functions deployed 2026-05-17 10:57 UTC
    - status_changed / admin_edited / birthday_bonus enum values reserved
      for future event emission wiring (separate workstreams)

  accept-underpayment auto-carry: REMOVED ✅
  carry-over edge function: DEPLOYED ✅
  review-payment-submission auto-carry: REMOVED ✅
  recalculate-penalties: DISABLED (returns 410) ✅
  Underpayment decision modal: BUILT ✅
  Overpayment/Keep decision modal: BUILT ✅
  penalty-engine due_date filter: FIXED ✅
  penalty-engine grace period: FIXED ✅
  penalty-engine self-healing Step 5b: ADDED ✅
  auto-forfeit-settlement error checking: ADDED ✅
  auto-forfeit-settlement immediate audit logs: ADDED ✅
  fix-account-totals: REWRITTEN ✅
  Account Health button: ADDED ✅
  System Audit button: ADDED ✅
  SystemAudit.tsx page: REMOVED ✅
  AccountDetail verify panel: REMOVED ✅
  Waterfall bug (penalty split): FIXED ✅
    (commits 9069ffd + 7993a94 + b7bc1c8)
  Session timeout (2hr idle + 5min warning): ADDED ✅
    (commit bfe4634)
  Admin audit log DB trigger: ADDED ✅
    (layaway_accounts + payments tables)
  delete-account audit wipe: FIXED ✅
    (commit bf368a6)
  delete-account reconciliation_log cleanup: ADDED ✅
    (2026-04-28) — reconciliation_log was created
    via SQL Editor 2026-04-20 with ON DELETE NO ACTION;
    delete-account cleanup list now includes it as
    step 9 (originally step 8 in commit bdac341,
    renumbered to 9 when extension_requests was
    inserted at step 7). Manual deploy required —
    delete-account is not in the auto-deploy workflow.
    See bug #50.
  delete-account extension_requests cleanup: ADDED ✅
    (2026-04-28) — extension_requests FK declared in
    repo migration 20260418010000 with no ON DELETE
    clause (defaults to NO ACTION). Added as step 7
    immediately after csr_notifications, in the same
    session as the reconciliation_log fix. After
    these two additions the cleanup list now covers
    all 6 NO ACTION/RESTRICT FKs to layaway_accounts.
    Manual deploy required. See bug #51.
  record-payment canonical formula: FIXED ✅
    (commit 6dd13e4)
  Platform rebrand → Cha Jewels Hub: DONE ✅
    (commit f0c3751)
  Customer portal splash screen: ADDED ✅
    (commit 1df6ee1)
  Admin login redesign (Kihei photo): DONE ✅
  Sidebar retheme (warm charcoal + gold): DONE ✅
  daily-reconciliation pg_cron: ADDED ✅
    (job 7, schedule 5 0 * * *)
  Email templates (13 total): ADDED ✅
    (commit 366b3bc)
  Email notifications wired to 7 edge functions: DONE ✅
    (commit 85f5666)
  System Audit: 683/683 passed ✅
  Admin Audit restructured: DONE ✅
    - Reconciliation tab: REMOVED
    - System Health tab: REMOVED
    - Moved into Monitoring & Audit page as 4th tab
    - Admin Audit removed from sidebar
    - TEST-% filter added to all audit tabs
    - Canonical formula alignment: VERIFIED
    - 3 minor display fixes applied (commit 355b0b0)
  Monitoring page renamed: "Monitoring & Audit" ✅
    - CSR Alerts, Smart Reminders, Extensions: unchanged
    - New Audit tab with 4 sub-tabs added

  Cash order payment submission flow: LIVE ✅ (2026-04-27)
    - submit-cash-payment: duplicate guard (409),
      rate limit (3/24h, excludes cancelled+rejected)
    - account_id nullable on payment_submissions
    - anon storage policy for payment-proofs bucket
    - service_role SELECT/UPDATE policies on
      customers table
    - Payment methods: CHA_PAYMENT_METHODS shared
      to src/lib/payment-methods.tsx
    - Pending Submissions hidden when cash order
      completed
    - Cancel submission: customer can cancel and
      resubmit

  Cash order item_description: REMOVED from form ✅ (2026-04-27)
    - Column remains nullable in DB for invoice use

  Loyalty award system: LIVE ✅ (2026-04-27,
  Layer-2 removed 2026-05-16)
    - Single canonical path: review-payment-submission
      → award-loyalty-points edge function
    - Layer-2 DB trigger safety net REMOVED
      2026-05-16 (migration
      20260516000000_drop_layer2_loyalty_triggers.sql) —
      produced ghost audit rows without updating
      counters/lots. See LOYALTY AWARD SYSTEM +
      LOYALTY SYSTEM RULES.
    - Skips if loyalty_jpy < ¥10,000 or null
    - Skips if loyalty_jpy_amount <= 0 or null (server-enforced
      amount gate per Bug #113, currency-agnostic since 2026-05-17)
    - Skips if customer not enrolled (no auto-enroll)
    - Skips if loyalty_enabled flag is false/null

  Loyalty staff visibility: LIVE ✅ (2026-04-29)
    - view_loyalty_redemptions permission key seeded in
      role_permissions (admin/finance/staff = true,
      csr = false). Applied via SQL Editor.
    - PAGE_PERMISSION_MAP gates /loyalty/redemptions
      via the new key — closes the prior page-access
      bug where the route was denied for everyone (see
      Known Fixed Bug #63).
    - AppSidebar permPath added so the sidebar entry
      now respects canSeeNav.
    - NewCashOrder + NewAccount: staff role can see the
      "Product Amount (JPY) — Loyalty Only" input.
    - AccountDetail: Loyalty Points Preview card added
      (parity with CashOrderDetail). Footnote reads
      "awarded once downpayment is confirmed" per the
      locked layaway DP-trigger rule.
    - RedemptionApprovalModal: Approve button gated to
      admin || finance. Staff sees a read-only modal
      with Close only.
    - process-loyalty-redemption: server-side approve
      gate tightened to admin || finance, closing the
      UI/server drift surfaced in Known Fixed Bug #64.
      create and cancel gates left unchanged.

  PWA install on customer portal: ROLLED BACK 🚧 (2026-04-29)
    - PR-1 (cae1bc8, bug #61) and PR-2 (bef1949, bug #62)
      shipped a hide-banner hotfix and a data:-URL dynamic
      manifest. Phase 0 (commit referenced as Known Fixed
      Bug #65) reverted both because the data:-URL manifest
      failed Chrome's install-eligibility heuristic — Start
      URL parsed empty in DevTools and customers never saw
      a working install prompt anyway.
    - Current state: customers cannot install the portal as
      a PWA. Static /manifest.webmanifest from vite-plugin-pwa
      and the service worker remain in place untouched. iOS
      Safari "Add to Home Screen" still works natively (uses
      the current URL with token, not start_url).
    - Forward fix: PWA TOKEN-TO-SESSION REDEMPTION Phase A
      (see PENDING ITEMS) — token-to-cookie/session swap
      so the installed shortcut resolves to the right
      customer without needing to bake the token into
      start_url.
      NOTE (2026-05-17): superseded — canonical PWA status now
      lives in SYSTEM STATUS → "PWA Install". Phase A abandoned
      2026-05-04; Phase B (email/password) is the sanctioned path.
    - Customers who installed the broken admin-context PWA
      before Phase 0 still have a dead shortcut on their
      device. Phase 6 dead-shortcut UX handler (in PENDING)
      will cover that.

  Loyalty Admin Portal: LIVE ✅
    Phase 1 — Foundation (LIVE 2026-04-29)
      - Route /loyalty/admin with 4 tabs:
        Dashboard / Members / Redemptions /
        Beta Whitelist
      - Sidebar entry "Loyalty" replaces
        "Loyalty Redemptions" (top-level,
        between Promotions and Settings)
      - Old /loyalty/redemptions redirects to
        /loyalty/admin?tab=redemptions
      - URL-driven tab state with deep-linking
        support (?tab=members&search=<code>)
      - Pending redemptions count badge on
        sidebar entry
      - Dashboard: total members, per-tier
        counts, points outstanding/redeemed,
        lifetime spend, recent enrollments
        table, tier distribution donut chart,
        pending redemptions card
      - Members: search/filter/sort/pagination,
        drawer view (read-only, links to
        Customer Detail for Adjust Points)
      - Redemptions: full queue with approve/
        reject flows (admin/finance gated
        server + UI)
      - Beta Whitelist: customer search +
        add/remove flow
      - CustomerLoyaltyTab: removed inline beta
        UI, added portal links (View in Members,
        Manage Beta Status)
      - ~793 lines of duplicate code removed
    Phase 2 — Configuration (LIVE 2026-04-29)
      - Tiers tab: 4 tier cards. Edit dialog is
        a two-step flow (form → impact preview)
        that recomputes every member's tier
        under the proposed threshold and
        surfaces promoted_in / demoted_out
        counts before save.
      - Tier name is read-only — locked because
        loyalty_promos.applicable_tiers
        references tier names and renaming
        would silently break promo applicability.
      - Editable per tier: min_spend_jpy,
        points_multiplier, color_hex,
        free_shipping_min_items (nullable),
        mystery_gift.
      - Settings tab: master loyalty_enabled
        toggle (admin only) with confirmation
        modal; hardcoded constants display
        (base rate, activity threshold, expiry
        rule); 8 email notification toggles;
        Google Sheets sync config (sheet ID,
        service account, frequency) with
        disabled "Sync Now" button.
      - Email toggles ship UI only — Phase 2.5
        wires the gates at each send site.
        Toggling stores the preference in
        system_settings; sends still fire
        unconditionally.
      - Audit Log tab: paginated audit_logs
        query filtered to loyalty entity_types,
        with entity_type / action / performer /
        date-range filters and a row-click
        drawer showing old/new JSON diff.
      - Audit instrumentation added to all
        Phase 1 mutations: beta add/remove,
        feature flag toggle, redemption
        approve/cancel.
      - LOYALTY_SETTINGS_AUDIT_ID sentinel
        00000000-0000-0000-0000-0000000000a1
        used for system-level audit entries
        because audit_logs.entity_id is
        UUID NOT NULL and system_settings has
        no per-row UUID.
      - LoyaltySettingsTab.tsx deleted (191
        lines); the Settings menu Loyalty tab
        was removed. Single source of truth
        for the feature flag now lives in the
        admin portal Settings tab.
      - BetaWhitelistTab feature-flag toggle
        removed; now shows a read-only status
        indicator + "Manage in Settings tab →"
        link.
      - 11 system_settings keys seeded for
        Phase 2 (8 email toggles, 3 sheet sync
        config keys).
    Phase 2.5 — Email gate plumbing (LIVE 2026-04-29)
      - New _shared/loyalty-email-gate.ts
        helper exporting createLoyaltyEmailGate
        factory + LOYALTY_EMAIL_KEYS tuple +
        LoyaltyEmailKey type.
      - 8 send sites gated across 4 edge
        functions:
          award-loyalty-points (3):
            loyalty-earned, loyalty-bonus,
            loyalty-tier-upgrade
          process-loyalty-redemption (1):
            loyalty-redeem
          join-loyalty-program (1):
            loyalty-welcome
          loyalty-inactivity-check (3):
            loyalty-pre-expire,
            loyalty-expire-deduct,
            loyalty-tier-downgrade
      - sendEmail helper in
        loyalty-inactivity-check now takes
        gate + gateKey as its first two
        params (Option A — explicit). Skip
        log lives inside the helper so all
        3 call sites are gated through one
        code change.
      - Per-invocation Map cache: each
        handler creates its own gate via
        createLoyaltyEmailGate(supabase) so
        the same key is never queried twice
        in a single invocation.
      - Fail-safe to true: missing key, RLS
        denial, network error, JSON parse
        failure all return true so the gate
        never silently suppresses a send
        because of an infrastructure problem.
      - Standardized skip log format:
          [email-gate] {template} skipped
          — toggle '{key}' is OFF
        Greppable in Supabase function logs.
      - All 4 functions are in the
        auto-deploy workflow so the gates
        ship on push to main. Toggling a
        key off in /loyalty/admin?tab=settings
        now actually suppresses the
        corresponding sends.

    ### Loyalty email gates

    All loyalty_email_* keys in system_settings default to TRUE when the row
    is missing. Explicit FALSE row required to disable. Shipping a new
    transactional email gate does not require a manual system_settings INSERT
    for activation — but inserting an explicit row provides admin UI visibility
    and an auditable enable/disable history.

    Phase 3 — Content Management (LIVE 2026-04-29)
      - Promotions tab: full CRUD with stats
        per promo (uses, unique customers,
        total bonus points), 3-bucket
        grouping (scheduled / upcoming /
        past). Stats aggregated client-side
        from loyalty_transactions where
        transaction_type='bonus' and
        promo_id IS NOT NULL.
      - Rewards Catalog tab: 5 collapsible
        category groups (Redeem with Points
        / Tier Exclusive / Shipping Rewards
        / Member-Only Offers / VIP Vault).
        Full CRUD with Vault toggle that
        locks category='VIP Vault' and
        is_vault=true in sync. Stock display
        with "Out of stock" / low (≤10% of
        limit) / "X / Y left" / "Unlimited"
        tones.
      - Banners tab: featured + promo banner
        management with live preview pane
        mirroring customer-facing component
        shape. link_target supports
        tab:foo (in-portal nav: home /
        rewards / points / notifications /
        profile / tiers) and http(s)://
        (external open). Schedule status
        chips (Live / Scheduled / Expired /
        Always on / Paused).
      - Admin portal tab count: 7 → 10.
        TabsList layout switched to
        flex+overflow on <xl, grid-cols-10
        on xl+. Order:
          Dashboard / Members / Redemptions /
          Beta / Tiers / Settings / Audit Log /
          Promotions / Rewards / Banners.
      - Customer portal now reads from DB:
          RewardsScreen → useLoyaltyRewardsCatalog
          VipRewardsVault → vault subset
            (passed as prop)
          FeaturedBanner → useLoyaltyBannersByType
            ('featured'), top priority becomes
            hero card
          PromoBanners → useLoyaltyBannersByType
            ('promo'), all active sorted by
            display_priority
        New shared dispatchBannerLink helper
        in src/components/loyalty/home/bannerLink.ts
        parses link_target prefix and routes
        to setTab or window.open.
        rowToReward adapter in RewardsScreen
        maps LoyaltyRewardRow → existing
        FallbackReward shape so canRedeem /
        canAccessReward / badge logic stays
        unchanged.
      - 17 rewards + 4 banners (1 featured,
        3 promo) seeded so customer portal
        works from first deploy without
        admin intervention.
      - LoyaltyPromosTab.tsx (443 lines) and
        LoyaltyPromoFormModal.tsx (369 lines)
        deleted. Single source of truth for
        promo admin is now /loyalty/admin?tab=promotions.
        Promotions menu page (/promotions)
        kept its other 3 tabs (Promos /
        Categories / Announcements) but
        dropped the Loyalty Promos tab.
      - Audit instrumentation: 3 new
        entity_types (loyalty_promo /
        loyalty_reward / loyalty_banner)
        written on every create / update /
        delete via the admin hooks.
    Phase 3.2 — Catalog Redemption Wiring (LIVE 2026-05-01)
      - Schema:
          loyalty_redemptions.reward_id uuid
            REFERENCES loyalty_rewards(id)
            ON DELETE SET NULL
          idx_loyalty_redemptions_reward_id
          loyalty_redemption_type enum
            extended with 'catalog_reward'
            (4th value alongside the 3
            legacy types).
      - process-loyalty-redemption changes
        (commit f632b5c):
          create action accepts reward_id;
          when reward_id is set,
          redemption_type defaults to
          'catalog_reward' and
          invoice_number is optional.
          Validates the reward exists,
          is_active, current_stock > 0
          (or NULL = unlimited), and
          points_redeemed === points_cost.
          Inserts the redemption row with
          a placeholder invoice_number
          'REDEEM-PENDING' (NOT NULL
          constraint preserved) then
          immediately UPDATEs to
          REDEEM-${redemption.id} so each
          catalog redemption has a 1:1
          stable forensic identifier.
          approve action does an atomic
          UPDATE … SET current_stock =
          current_stock - 1 WHERE id = $1
          AND current_stock > 0 (race-free
          decrement). If the WHERE clause
          fails to match (a parallel
          approval drained the last unit
          first) the function returns 409
          with stock_race: true and the
          redemption stays pending so
          staff can cancel it explicitly.
          On success, writes an
          audit_logs entry with
          entity_type='loyalty_reward',
          action='stock_decremented'.
          cancel action carries a TODO
          for Phase 3.2.1 — re-incrementing
          stock when an already-approved
          catalog redemption is voided.
      - Customer portal RewardsScreen real
        flow (commit ace3c6a):
          handleRedeem replaced (was a
          stub) with a real call to
          process-loyalty-redemption
          action='create'. Pattern-matched
          error toasts: 409 → "sold out",
          config-mismatch → "config
          changed, refresh the catalog",
          insufficient-points →
          "Insufficient points".
          Modal carries an optional
          invoice_number input and a
          three-state Confirm button (Out
          of Stock / Insufficient Points /
          Confirm Redemption with spinner).
          Stock badges: "Out of stock"
          (red) when current_stock = 0,
          "Only X left" (amber) when
          current_stock between 1 and 5.
          Success copy is now "Redemption
          Submitted!" + "pending admin
          approval" — no more "Redemption
          Successful" claim before the
          approval step.
          inStock(reward) helper centralizes
          the unlimited / 0 / >0 check.
          rowToReward adapter propagates
          current_stock onto the
          FallbackReward shape via a new
          optional currentStock?: number |
          null field on the type.
      - Anon RLS policies (applied via
        SQL Editor):
          loyalty_rewards anon SELECT
            WHERE is_active = true
          loyalty_banners anon SELECT
            WHERE is_active = true
          Customer portal uses token-
          based auth (anonymous to
          Supabase) so the prior
          authenticated-only policies
          blocked customers from reading
          either table once the portal
          was switched to DB-driven
          rewards/banners in Phase 3.
    Phase 3.2.1 — Cancel/Void Approved Redemption (LIVE 2026-05-08)
      - Admin can reverse a confirmed
        redemption via "Void Redemption"
        button in RedemptionApprovalModal.
        Closes the gap where confirmed
        redemptions had no recovery path —
        previously required manual SQL.
      - Atomic backend operation in
        process-loyalty-redemption new
        action='void' branch:
          1. Refund points — INSERT new
             loyalty_transactions row with
             transaction_type='refunded'
             (new enum value, see
             TODAY'S DATA FIXES 2026-05-08)
             and positive points_amount
             matching the original debit.
             notes field carries the
             original transaction_id for
             forensic linkage.
          2. UPDATE loyalty_redemptions —
             status='cancelled',
             cancelled_at, cancelled_by,
             cancellation_reason. Race-
             safe via WHERE id=X AND
             status='confirmed'; concurrent
             void attempts get 409 after
             rolling back the refund tx.
          3. UPDATE loyalty_members —
             remaining_points += N,
             total_points_redeemed -= N
             (clamped at 0 for sanity).
          4. Re-increment
             loyalty_rewards.current_stock
             for catalog rewards. Skip
             silently for unlimited
             (current_stock NULL); warn-
             and-continue if reward row
             missing.
          5. audit_logs entry
             (action='redemption_voided',
             stock_re_incremented flag,
             refund_transaction_id).
          6. Phase 4.2 cancellation
             notification emit (reuses
             existing
             buildRedemptionCancelledNotification
             + emitNotification).
      - Frontend: extended
        RedemptionApprovalModal with
        state-aware rendering:
          status='confirmed' AND admin →
          green Confirmed banner + "Void
          Redemption" destructive button
          + Close.
          showVoidInput=true → reason
          textarea (rows=3, maxLength=500)
          + Back + Confirm Void
          (aria-busy={voiding},
          variant=destructive).
          status='cancelled' → gray
          banner with cancelled_at +
          cancellation_reason + Close.
          status='confirmed' AND
          NOT admin → green banner +
          Close only (read-only).
      - Status enum reused (no schema
        change). New 'refunded' value
        added to loyalty_transaction_type
        enum (ALTER TYPE applied via SQL
        Editor). Action whitelist updated
        to include 'void' alongside
        create/approve/cancel — closes a
        latent regression from C2 commit
        203b654 (the void branch was
        unreachable until this fix; see
        Bug #90).
      - resolvePortalAuth wiring also
        added to the same edge function
        in this session — closes Phase B
        Step 3f-2 gap where this function
        was missed in the original
        7-function rewire on 2026-05-05.
        See Bug #89.
      - Smoke test PASSED end-to-end on
        2026-05-08:
          customer redeem (200-pt
          Birthday Bonus) → admin
          approve → admin void.
        Verified all 5 expected DB
        changes:
          loyalty_redemptions.status =
            'cancelled' + cancelled_at +
            cancellation_reason populated
          loyalty_members.remaining_points
            restored to original
          loyalty_transactions: new row
            with type='refunded',
            positive points_amount
          audit_logs: action=
            'redemption_voided' row
          Customer's NotificationsScreen:
            cancellation card visible
      - Known limitation — email
        asymmetry. Approve flow sends
        both transactional email (via
        send-transactional-email) AND
        in-portal notification. Void flow
        sends only the in-portal
        notification. Customer experience
        is asymmetric until the "Void
        email notification" PENDING item
        ships (see PENDING ITEMS LOYALTY
        ADMIN PORTAL phased-build
        tracker — small standalone fix,
        ~2 hrs, does not depend on
        Phase 6).

    Phase 3.1 — Bonus Multiplier Wiring (LIVE 2026-05-01)
      - Promos can apply a multiplier
        override in addition to flat
        bonus_points. Both fields can be
        set on the same promo (no mutex);
        either or both can be neutral
        (1.00 / 0).
      - Schema (commit referenced under
        TODAY'S DATA FIXES 2026-05-01):
          ALTER TABLE loyalty_promos
            ADD COLUMN bonus_multiplier
              numeric(5,2) NOT NULL
              DEFAULT 1.00
              CHECK (bonus_multiplier >= 1.00);
        Existing rows backfilled to 1.00
        (neutral). DB-level CHECK blocks
        negative or fractional-discount
        promos.
      - Strategy B (multiply): tier
        multiplier and promo multiplier
        stack multiplicatively. Crown VIP
        (3x) member during a 3x promo
        earns 9x base. The tier ladder
        keeps its meaning during promos
        — Glimmer (1x) × 3x promo = 3x,
        still less than Crown VIP × 3x.
      - Edge function calculation
        (commit 069d7ac in
        supabase/functions/award-loyalty-points):
          baseUnits  = floor(jpy/10000)
          earnedTx   = baseUnits × 100
                       × tier_multiplier
          delta      = earnedTx
                       × (promo_mult - 1)
          flatBonus  = activePromo
                       .bonus_points
          bonusTx    = delta + flatBonus
          memberTotal = earnedTx + bonusTx
        Bonus tx skipped when bonusTx = 0
        (no-op promo, e.g. mult=1.00 +
        bonus=0). Bonus tx notes string
        documents which fields contributed:
        "Multiplier promo (delta: X) +
        flat bonus (Y)" / "Multiplier
        promo (delta: X)" / "Flat bonus
        (Y)". Promo linkage preserved
        via promo_id column.
      - max_per_customer cap counts bonus
        tx rows per (member, promo) —
        unchanged. Each promo fire still
        writes one bonus tx, so cap
        behavior is identical for
        flat-only, multiplier-only, and
        combined promos.
      - Email payload (loyalty-bonus
        template) sends bonusTxPoints
        (delta + flat) so customers see
        the promo's full impact rather
        than just the flat portion.
      - Admin UI:
          PromoEditDialog (commit 9a9d7f5):
            side-by-side bonus_points +
            bonus_multiplier inputs.
            Multiplier accepts 1.00–99.99
            with step 0.01. Helper text
            under each input ("Flat bonus
            points added on top. Leave at
            0 to skip flat bonus." /
            "Multiplier (1.0 = no boost).
            Stacks with tier multiplier.").
            Validation rejects < 1.00 and
            > 99.99 with explanatory
            messages. max_per_customer
            moved to its own row.
          PromotionsTab (commit 35ea1a9):
            new BonusField cell renders
            a solid-primary "{N}x Bonus"
            badge when multiplier > 1
            and a "+N pts" text when
            bonus_points > 0; both
            inline when both apply.
            Tooltip on the badge
            ("Multiplier stacks on top
            of the member's tier
            multiplier.") explains tier
            stacking. fmtMultiplier
            strips trailing zeros so
            3.00 → "3x", 2.50 → "2.5x",
            1.27 → "1.27x".
      - useLoyaltyPromosAdmin types
        updated: bonus_multiplier:number
        on LoyaltyPromoRow,
        bonus_multiplier?:number on
        CreatePromoInput. Insert payload
        sets `?? 1` fallback; SELECT
        projection includes the new
        column. UPDATE path passes
        through partial input.updates
        unchanged.
    Phase 3.5 — Image Upload to Storage (LIVE 2026-05-03)
      - Replaced the paste-image-URL flow
        with a real Supabase Storage upload
        UI across all 3 loyalty admin
        dialogs: PromoEditDialog,
        RewardEditDialog, BannerEditDialog.
      - New storage bucket: loyalty-images
          public = true (anon read for
            customer portal — same pattern
            as the promotions bucket and
            the Phase 3.2 anon RLS on
            loyalty_rewards / banners)
          file_size_limit = 5_242_880
            (5 MB) enforced at storage
            layer
          allowed_mime_types =
            {image/jpeg, image/png,
             image/webp}
        Bucket-level constraints back up
        the client-side validation.
      - 4 RLS policies on storage.objects
        scoped to bucket_id =
        'loyalty-images':
          SELECT  → anon, authenticated
          INSERT  → admin OR finance
          UPDATE  → admin OR finance
          DELETE  → admin OR finance
        Tighter than the promotions
        bucket precedent (admin+staff) —
        loyalty content stays in the
        admin/finance domain.
      - New shared component
        (commit 27b1f2b):
        src/components/loyalty-admin/ImageUploadField.tsx
          Click-to-browse + drag-and-drop
          drop zone (empty state) or
          80×80 thumbnail with Replace +
          Remove buttons (filled state).
          Loading spinner overlays both
          states during upload. Inline
          error text + sonner toast on
          rejection.
          Client validation: mime in
          {jpeg,png,webp} and size ≤ 5 MB
          before any upload attempt.
          Filename pattern:
            ${entity}-${crypto.randomUUID()}-${Date.now()}.${ext}
          Stored flat in the bucket root.
          Extension derived from filename
          with mime-type fallback when
          missing.
          Returns the public URL via
          supabase.storage.getPublicUrl
          and writes it to image_url via
          the onChange callback.
          Fire-and-forget delete on
          Replace and on Remove. Scoped
          via regex against
          /storage/v1/object/public/loyalty-images/
          so legacy paste URLs (and any
          external URLs) are never
          touched — only files we own
          get cleaned up.
          Drag handlers preventDefault
          + stopPropagation on the
          three drag events so dropping
          a file outside the zone does
          not navigate the page.
      - Wired into 3 dialogs (commits
        5194de7 / 39aea4d / 7b8eafd):
          PromoEditDialog,
          RewardEditDialog,
          BannerEditDialog.
        Boundary conversions preserve
        the existing
        FormState.image_url:string
        contract:
          value:    form.image_url || null
          onChange: (url) => image_url:
                    url ?? ''
        formToInput's empty-to-null logic
        on each dialog continues to map
        empty strings back to null on
        save, so the image_url database
        column shape is unchanged.
        BannerEditDialog's existing
        live preview pane reads
        form.image_url directly and
        continues to work unmodified —
        the boundary conversion keeps
        that string populated whenever
        a URL is set.
        Layout adjustment in
        BannerEditDialog: image_url and
        emoji were paired in a 2-col
        grid; the new ImageUploadField
        is much taller than a single
        Input, so the pair was split
        into two stacked full-width
        rows. Promo and Reward dialogs
        kept their original full-width
        Image row.
        Label text on all 3 dialogs
        renamed from "Image URL
        (optional)" to "Image (optional)"
        — no longer a URL paste.
      - Phase 3 series complete — full
        content management end-to-end.
    Phase 4 — Communications/Notifications (LIVE 2026-05-04)
      - Manual admin broadcast notifications
        to loyalty members. Auto-triggered
        notifications (points / order /
        milestone / etc.) deferred to Phase
        4.2.
      - 6 admin-pickable categories: info /
        promo / tier / system / reward /
        birthday. Customer-side icon mapping
        retains all 12 prior categories so
        future Phase 4.2 auto-trigger types
        render with the right icon when they
        land.
      - 3 audience modes: 'all' (every
        enrolled loyalty_members row),
        'tier' (JOIN audience_tiers names →
        loyalty_tiers.id → members.current_tier_id),
        'specific' (audience_member_ids
        array passthrough).
      - Schedule for future send. Hourly
        cron (loyalty-notification-queue,
        jobid=19, '0 * * * *' UTC) picks up
        rows where status='scheduled' AND
        scheduled_for <= now(), atomically
        locks status → 'sending' to prevent
        double-send across overlapping
        ticks, then runs the same fan-out
        as the synchronous path.
      - Optional per-notification email
        side-fire gated by the per-row
        send_email toggle AND the global
        system_settings.loyalty_email_broadcast
        setting (default true). Email loop
        runs in EdgeRuntime.waitUntil
        background so the response returns
        promptly even on 464-member
        broadcasts. Per-recipient portal
        URL built from a single batched
        customer_portal_tokens lookup.
      - Read state per recipient with
        mark-as-read (single) and
        mark-all-read endpoints. Customer
        portal NotificationsScreen does
        optimistic flips on click with
        rollback on error.

      Schema:
      - loyalty_notifications (master, 17 cols)
          id, title, body, category, audience_type,
          audience_tiers, audience_member_ids,
          link_target, status, scheduled_for,
          sent_at, expires_at, send_email,
          email_sent, created_by_user_id,
          created_at, updated_at.
        Status flow: draft → scheduled →
          sending → sent (or cancelled /
          failed). CHECK constraint widened
          from 4 to 6 values.
        audience_member_ids[] is ephemeral —
          NULLed post-send so the recipients
          table becomes the truth.
        email_sent boolean tracks whether
          the email side-fire actually ran
          (set true at the end of the
          background email loop; useful for
          audit + retry diagnostics).
      - loyalty_notification_recipients
        (per-member delivery + read state,
        6 cols)
          id, notification_id, member_id,
          is_read, read_at, created_at.
        UNIQUE (notification_id, member_id)
          prevents double fan-out on retry.
        4 indexes including 2 partials:
          idx_loyalty_notification_recipients_member_created
            for portal listing
          idx_loyalty_notification_recipients_member_unread
            (WHERE is_read=false) for unread
            count
          idx_loyalty_notifications_status_scheduled
            (WHERE status='scheduled') for
            queue processor
          idx_loyalty_notifications_status_created
            for admin list

      Edge functions (4 new + 1 extended):
      - send-loyalty-notification
        (synchronous fan-out, admin/finance
         JWT auth, validates body, persists
         master row, resolves audience,
         bulk-inserts recipients, fires
         email side-fire in background,
         writes audit_logs)
      - mark-loyalty-notification-read
        (token-auth via resolvePortalAuth,
         mode='single' OR mode='all',
         service_role bypasses RLS for the
         updates, idempotent on already-read
         rows)
      - process-loyalty-notification-queue
        (service_role JWT only, hourly cron
         picks up overdue scheduled rows,
         atomic check-and-update lock,
         per-iteration try/catch so one bad
         row doesn't abort the batch,
         terminal 'failed' status on error
         with audit_logs entry)
      - customer-portal extended to return
        notifications array (max 100, sent +
        not-expired, ordered created_at
        DESC) + unread_count

      Email template:
      - loyalty-broadcast template at
        supabase/functions/_shared/transactional-email-templates/
          loyalty-broadcast.tsx
        with memberFirstName,
        notificationTitle, notificationBody,
        ctaUrl. Mirrors the loyalty-welcome
        layout (gold header bar, brand text,
        h1, greeting, body, optional CTA
        button, footer). Registered in
        registry.ts.
      - Loyalty email gate
        (LOYALTY_EMAIL_KEYS) extended with
        the 9th key 'loyalty_email_broadcast'.

      Hooks (src/hooks/loyalty-admin/useLoyaltyNotifications.ts):
      - useLoyaltyNotifications(filters)
        admin list with stats joined
        client-side. refetchOnWindowFocus
        per Q3.
      - useLoyaltyNotificationStats(id)
        per-notification stats — total /
        read_count / read_rate / email_sent /
        email_pending. Three parallel count
        queries.
      - useSendNotification,
        useUpdateNotification,
        useCancelNotification — mutations
        wired to the edge function (send /
        update) or direct RLS-permitted
        UPDATE (cancel) with audit_logs
        entry.
      - useLoyaltyMembersForAudience for the
        Specific audience picker, 5-min
        staleTime.
      - useTierList returns the 4 hardcoded
        tier names; TIERS const + Tier type
        also exported.

      UI:
      - NotificationsTab admin component as
        the 11th tab in LoyaltyAdmin
        (xl:grid-cols-11). Card grid with
        status / category badges, audience
        labels, stats panel for sent rows
        (recipients / read / read rate %),
        timestamps (Created / Scheduled /
        Sent / Expires), and per-status
        action buttons (Edit on draft /
        scheduled, Edit + Cancel on
        scheduled, View on sent / cancelled /
        failed). Empty state, loading
        skeletons, and AlertDialog confirm
        on cancel.
      - NotificationComposeDialog with
        title / body char counters, category
        select, audience radio + conditional
        sub-pickers (tier checkboxes or
        member search), link target
        (none / portal tab / external URL),
        schedule radio (now / future
        datetime), email toggle with global
        gate state, expiry collapsible.
        Edit mode pre-fills the form;
        editLocked banner blocks interaction
        when status is sent / sending /
        cancelled / failed. AlertDialog
        confirm before send/schedule
        showing audience + send time + email
        status.
      - NotificationsScreen.tsx (customer
        portal) replaced staticFallback with
        real DB-driven array. PHT-aware
        date grouping (Today / Yesterday /
        "Mon DD"). Optimistic mark-as-read
        with rollback. Link target dispatch
        — tab:foo → onSetTab; https:// →
        window.open. Bottom-nav
        unreadCount wired to data.unread_count.

      System settings:
      - loyalty_email_broadcast (default
        true) seeded in C1 SQL. Admin can
        flip from the Settings tab to
        globally suppress notification
        emails without disabling the
        per-row toggle UI.

      Cron:
      - jobid=19 in pg_cron, scheduled
        '0 * * * *' (top of every hour
        UTC). Calls
        process-loyalty-notification-queue
        with the service_role JWT
        Authorization header (vault-fetched
        in the cron command body, so the
        JWT isn't hardcoded in the
        schedule).
    Phase 4 polish (LIVE 2026-05-04)
      - Sent / cancelled / failed
        notifications are immutable history.
        New "Duplicate" action button on
        those terminal-state cards (gold
        primary, alongside View) opens
        NotificationComposeDialog
        pre-filled with the source row's
        content but treated as a fresh
        send — original history preserved.
      - NotificationComposeDialog accepts a
        new optional prop:
          mode?: 'create' | 'edit' | 'duplicate'
        defaulting to 'edit' when
        notification is set, 'create'
        otherwise. Backwards-compatible
        with prior call sites.
      - Duplicate-mode pre-fill carries
        title / body / category /
        audience_type / audience_tiers /
        send_email. Clears scheduled_for,
        expires_at, and audience_member_ids
        so admin re-picks anything
        time-sensitive. (audience_member_ids
        is NULLed post-send per the Q9
        ephemeral rule — there's nothing
        to preserve anyway.)
      - When source had audience_type
        ='specific', a toast.info on
        dialog open prompts:
        "Audience type carried over —
        re-pick the specific members
        before sending." Forces the admin
        to re-confirm members; the picker
        opens with an empty selection.
      - editLocked banner is skipped in
        duplicate mode — duplicate is a
        fresh insert, so the source's
        terminal status doesn't lock the
        form. isEditMode (true only in
        'edit') gates the notification_id
        passing to the mutation, so
        duplicate uses useSendNotification
        like create.
      - Per-status action matrix on
        NotificationsTab cards:
          draft     → Edit
          scheduled → Edit + Cancel
          sending   → View only
          sent      → View + Duplicate
          cancelled → View + Duplicate
          failed    → View + Duplicate
      - Modal stacking bug fixed in the
        same session: the original
        compose-and-confirm flow used a
        nested AlertDialog inside the
        Dialog, which stacked two
        bg-black/80 overlays (near-opaque
        backdrop) and trapped Confirm
        button clicks at the upper
        portal. Refactored to a single
        Dialog with a two-view toggle
        (showConfirm boolean state) —
        same DialogContent renders form
        OR confirmation summary panel
        based on the flag. Footer
        buttons swap with the view
        (Cancel + Send/Schedule on form;
        Back + Confirm on summary).
        Error path keeps the confirm
        view open so admin can retry
        without re-filling the form.
    Phase 4.2 — Auto-trigger Notifications (LIVE 2026-05-07)
      - Instrumented 3 existing edge
        functions to emit in-portal
        notifications on loyalty events.
        No new edge functions — sidesteps
        the workflow path-filter .added
        bug.
      - Direct DB INSERT pattern (no edge
        fn HTTP roundtrip). Sub-millisecond
        and atomic with the parent
        operation.
      - send_email=false on all
        auto-triggers. The existing
        transactional email gates
        (loyalty_email_earned, _bonus,
        _tier_upgrade, _redeem,
        _pre_expire, _expire_deduct,
        _tier_downgrade) already cover the
        email channel for these events;
        notifications are the in-portal
        complement. Doubling up would
        double-email customers.
      - try/catch wrap on every emit via
        the shared helper — parent
        operation never fails on
        notification error.

      CHECK constraint widened from 6 → 11
      categories:
        Phase 4 admin-pickable: info /
          promo / tier / system / reward /
          birthday
        Phase 4.2 auto-trigger: points /
          redemption / order / expiry /
          milestone (milestone schema-only,
          emit logic deferred to 4.2.1).

      Shared helpers (NEW):
        _shared/loyalty-notification-templates.ts
          - 8 pure template builders:
            buildWelcomeNotification,
            buildPointsEarnedNotification,
            buildTierUpgradeNotification,
            buildTierDowngradeNotification,
            buildRedemptionApprovedNotification,
            buildRedemptionCancelledNotification,
            buildPreExpiryNotification,
            buildExpiryFiredNotification.
          - Each returns { title, body }
            with title ≤ 100 chars, body ≤
            500 chars enforced via the local
            truncate('…') helper, matching
            the loyalty_notifications CHECK
            constraints.
          - Defensive: rewardName capped at
            80 chars; cancellation reason
            capped at 300; fmt() returns
            '0' for NaN/Infinity.
          - TIER_MULTIPLIERS map embedded
            (Glimmer 1, Radiant 2, Elite 2,
            Crown VIP 3) — kept in sync
            with loyalty_tiers seed.
        _shared/emit-notification.ts
          - emitNotification(supabase,
            member_id, args) — fire-and-
            forget helper.
          - Two INSERTs per call:
            loyalty_notifications (master,
            status='sent', sent_at=now,
            audience_type='specific',
            audience_member_ids=null,
            send_email=false,
            email_sent=false,
            created_by_user_id=null) +
            loyalty_notification_recipients
            (single row, is_read=false).
          - Defensive validation: empty
            member_id → warn+return;
            invalid category → warn+return.
          - All failure paths log with the
            '[loyalty-notify]' prefix
            (greppable in Supabase function
            logs). NEVER throws.
          - Orphaned-master semantics on
            partial failure: customer-portal's
            INNER JOIN on recipients hides
            orphans from customers; admin
            tab shows 0 recipients as the
            failure signal.

      award-loyalty-points emits
      (commit 33240b3):
        - Welcome (first-ever award; prev
          total_points_earned === 0) —
          category 'order', link tab:home.
          isFirstAward derived from the
          local `member` object's pre-update
          state (line 240 UPDATE doesn't
          mutate the local).
        - Points earned (every successful
          award) — category 'points', link
          tab:points. Body shows totalAdded
          (earned + bonus) and the invoice
          number.
        - Tier upgrade (when tierUpgraded ===
          true at line 222) — category
          'tier', link tab:home.
        Customer fetch hoisted out of the
        email try/catch so notifications
        reuse `customer` for firstName
        without a second round-trip; fetch
        wrapped in its own micro try/catch
        so failure leaves customer=null and
        firstName falls back to "there".
        All three emits sequentially
        awaited before function return so
        Edge Runtime termination doesn't
        drop inserts.

      process-loyalty-redemption emits
      (commit 6d27b1c):
        - Redemption approved (normal path,
          before success return) — category
          'redemption', link tab:points.
        - Redemption approved (stock-race-
          loss path, before the 409 return).
          Points are already debited at
          this point so the customer needs
          to see the redemption in their
          portal even though admin will
          manually cancel/refund afterward.
        - Redemption cancelled (with admin
          cancellation_reason in body) —
          category 'redemption', link
          tab:points.
        Reward name resolution via shared
        resolveRewardName helper:
          - Catalog rewards (reward_id set)
            fetch loyalty_rewards.name.
          - Non-catalog (3 legacy enum
            types) map to humanized labels
            via REDEMPTION_TYPE_LABELS
            ('New order discount' /
            'Shipping fee' / 'Service fee').
          - Final fallback "Your reward".
        Cancel branch SELECT widened from
        ('id, status') to include
        ('member_id, reward_id,
        redemption_type, points_redeemed')
        — needed by both resolveRewardName
        and emitNotification.

      loyalty-inactivity-check emits
      (commit 1ac5fd7):
        - Pre-expiry warning — category
          'expiry', link tab:points.
          Inside the same if (needsWarn)
          gate as the pre-expire email,
          AFTER the pre_expiry_warned_at
          UPDATE succeeds, so the
          notification respects the
          WARNING_REPEAT_COOLDOWN_DAYS
          cooldown and a failed update
          can't leave the customer
          notified-but-not-tracked.
        - Expiry fired — category 'expiry',
          link tab:points. Body shows the
          pointsLost. Always emitted when
          daysSinceLast >= INACTIVITY_DAYS.
        - Tier downgrade — category 'tier',
          link tab:home. Twin emit when
          expiry causes a downgrade
          (tierChanged === true). Plus
          standalone emission in the
          gap-too-big branch. The two
          paths are mutually exclusive
          because expiry uses `continue`
          to skip the standalone
          downgrade branch.

      Scope correction from spec:
        Originally 4 functions; reduced to
        3. review-payment-submission
        delegates to award-loyalty-points
        on the DP-confirm path (line 761);
        instrumenting award covers
        DP-confirm, cash-order-complete,
        and any future trigger of award.
        Single source of truth.
    Phase 3.1.1 — Customer portal "Nx Bonus" badge (LIVE 2026-05-08)
      - Gold-gradient chip beside the
        existing tier multiplier chip on
        MemberCard's Home-tab header.
        Surfaces the currently-active
        multiplier promo to customers in
        real time so they can see they're
        in a 2x/3x/etc earning window
        without admin having to broadcast.
      - Resolution mirrors
        award-loyalty-points selection
        EXACTLY so the badge represents
        what the customer would actually
        earn:
          1. Date window — is_active=true
             AND today between start_date
             and end_date.
          2. Tier match — applicable_tiers
             null/empty OR includes the
             member's current tier name.
          3. Cap remaining — bonus tx
             count for (member_id,
             promo_id) <
             max_per_customer.
          4. NEW Phase 3.1.1 filter —
             bonus_multiplier > 1.00.
             Flat bonus_points-only
             promos don't surface the
             chip because there's nothing
             to multiply; they still
             fire as bonuses, just no
             "Nx" messaging.
        On any cap-query failure: fail-
        closed (don't show a badge we
        can't validate). Outer try/catch
        ensures unexpected errors keep
        activePromo=null and never block
        the rest of the portal payload.
        All failure paths log with
        '[customer-portal]' prefix
        (greppable in Supabase function
        logs alongside the Phase 4 C5
        notifications-query logging).
      - customer-portal payload extended
        (commit ced71e4):
          active_promo: {
            bonus_multiplier: number,
            name: string,
            end_date: string  // YYYY-MM-DD
          } | null
        Fields chosen for what the badge
        actually displays. id +
        applicable_tiers omitted —
        deferred to a future 3.1.2
        if/when the badge needs to
        deep-link to a details modal or
        show "Crown VIP only" qualifier
        text.
      - Frontend wiring (commits f7e403d
        + eb786d8):
          loyaltyData.ts store:
            New exported
            LoyaltyActivePromoData type +
            activePromo:
            LoyaltyActivePromoData | null
            field on the snapshot.
            setLoyaltyData() signature
            extended with an optional 4th
            arg (defaults to null —
            backwards-compatible).
            Identity-equality short-
            circuit extended so listeners
            re-render only when the
            promo state actually changes
            (e.g., the next refetch
            returns null after the promo
            ends).
          LoyaltyPortal.tsx:
            PortalData.active_promo?
            optional field. The existing
            setLoyaltyData call now
            passes data.active_promo ??
            null as the 4th arg. No new
            effect — runs on the same
            cadence as the existing
            tiers/transactions plumbing,
            including refetchOnWindowFocus
            from Phase 4.
      - MemberCard.tsx UI (commit
        282c4c4):
          Tier chip wrapped in a flex
          container with gap-2; the
          conditional promo chip sits
          beside it. When activePromo is
          null, the wrapper collapses to
          a single chip — no layout
          shift, no empty placeholder.
          Promo chip styling: bright
          saturated gold gradient
          (linear-gradient(135deg,
          hsla(45,90%,55%,0.95) →
          hsla(45,100%,65%,0.95))) +
          0 0 12px hsla(45,90%,55%,0.4)
          glow boxShadow for the
          limited-time feel. Dark
          hsl(36,80%,15%) icon + text
          for max contrast against the
          bright gradient. Sparkles
          icon (lucide-react) —
          deliberately distinct from
          TrendingUp on the tier chip
          so the two chips read as
          separate facts rather than
          duplicates of each other.
          Browser-native title tooltip
          shows promo name + friendly
          end date (e.g. "Spring 3x
          Weekend — ends May 12,
          2026"). Long-press surfaces
          it on iOS Safari.
          fmtMultiplier helper inlined
          (parseFloat(toFixed(2)).toString)
          to strip trailing zeros: 3.00
          → "3", 2.50 → "2.5", 1.27 →
          "1.27". Same logic as the
          admin-portal helper in
          PromotionsTab.tsx; duplicated
          locally to avoid coupling the
          customer portal to admin-
          portal helpers — promote to
          a shared util when a third
          caller appears.
          fmtEndDate helper anchors
          the YYYY-MM-DD parse at local
          noon (`+ "T12:00:00"`) so the
          timezone difference between
          UTC and the customer's locale
          never shifts the displayed
          day backwards. Same defense
          pattern as the PHT helpers in
          date-utils.ts.
      - No click action — informational
        only. A future Phase 3.1.2
        could add a tap-to-details
        modal and surface tier-specific
        qualifier text if customer
        feedback warrants it.
      - No SQL changes. Phase 3.1
        already shipped the
        bonus_multiplier column with
        the >= 1.00 CHECK; the
        Phase 3.1.1 schema follow-up
        (CHECK widening for
        multiplier-only promos) is a
        separate, narrowly-scoped
        constraint adjustment recorded
        under TODAY'S DATA FIXES
        (2026-05-08).
    Phase 3.5.1 — Orphan Image Cleanup (LIVE 2026-05-07)
      - cleanup-loyalty-images edge
        function runs weekly to clean
        orphaned images in the
        loyalty-images bucket. Detects
        images NOT referenced by any
        loyalty_promos / loyalty_rewards /
        loyalty_banners image_url field.
      - Schedule: Sunday 03:00 UTC
        (11:00 AM PHT) — jobid 20.
      - Service role auth (verified —
        rejects non-service-role callers
        with 403). Calls authorized via
        email_queue_service_role_key from
        vault per Lovable Option 1 —
        same key the 3 sibling crons
        (16/17/19) were repointed to in
        the same session.
      - Dry-run by default via
        system_settings.cleanup_loyalty_images_dry_run
        (default true). Manual override
        per-invocation via
        ?dry_run=true|false query param.
        Plan to flip to false after the
        first 1-2 weekly runs are
        reviewed.
      - Hard cap = 50 deletes per run.
        If exceeded, function halts
        without deleting and writes a
        'cleanup_halted' audit row.
        Manual investigation required
        before flipping the dry-run flag
        off in any case where the cap is
        approached.
      - Audit log per run with sentinel
        entity_id
        00000000-0000-0000-0000-0000000000a2
        (Phase 2 pattern; a1 is
        loyalty_settings, a2
        distinguishes loyalty_images_cleanup),
        entity_type 'loyalty_images_cleanup',
        action 'cleanup_dry_run' /
        'cleanup_run' / 'cleanup_halted'.
        new_value_json carries
        files_scanned / orphans_detected /
        files_deleted / dry_run /
        safety_cap_hit / cap / elapsed_ms.
      - Filename matching via the
        loyaltyImagesPath helper (lifted
        in C2 to
        _shared/loyalty-images-path.ts +
        src/lib/loyalty-images-path.ts —
        same dual-file convention as
        portal-link.ts and portal-auth.ts;
        cross-reference comment in each
        twin flags drift). URLs that
        don't match the bucket pattern
        (legacy paste-only externals)
        correctly drop out — they're not
        in the bucket either, so they
        can't be orphans.
      - Smoke test passed end-to-end:
        200 OK in ~205 ms, 0 orphans
        detected (empty bucket at smoke
        time), audit row written.

  ### 2026-04-30 — Session shipped

  Six commits to main, zero rollbacks. Audit pool 683 audited /
  684 in scope / 1 excluded (INV #18857) / 0 failing.

  - e28cf60 — Dashboard restructure to account-counts-only +
    Finance gap-fill cards (Cash Revenue Today + Total Overdue).
    get_aging_buckets(p_scope) RPC deployed. AgingBuckets
    variant=count + scope toggle. Bug #67 logged.

  - 76c9d3a — audit_skipped state for newly-created accounts.
    audit_account() and audit_all_accounts() RPCs updated to
    skip accounts where total_paid=0 AND no allocations.
    Frontend AccountDetail Check Health modal handles new
    response shape. Bug #68 logged.

  - c26ec78 — partially_paid semantics doc fix + audit_account
    Check 12 services double-count fix + currency toggle status
    logged. CLAUDE.md PAYMENT ALLOCATION RULES section updated
    to reflect actual runtime (full-owed semantic, not
    shortfall). Bugs #71 and #72 logged. reconcile_failing_accounts()
    Cartesian product bug fixed in same session via SQL Editor
    (bug #69). TEST-004 audit drift healed via manual SQL
    UPDATE (bug #70).

  - fff86ce — INVARIANT 2 migration to schedule_with_actuals
    across 3 surfaces:
    - get_forecast_6m() RPC migrated
    - dashboard-summary edge function 5 cache-read sites migrated
    - get_forecast_drilldown(p_month) RPC created (server-side
      join pattern matching get_aging_buckets() — avoids URL-length
      risk)
    - Finance.tsx forecast drilldown migrated to use new RPC
    Bug #73 logged. INV #18531 ₱1,000 cumulative cache
    overstatement eliminated (cache 65,186 → canonical 64,186).

  ### 2026-05-01 — PWA Phase A Step 2 deployed (infrastructure)

  Backend infrastructure for portal session redemption deployed.
  Both new edge function and shared helper are DORMANT — no
  existing code path calls them yet. Step 3 will wire them in.

  - New edge function: redeem-portal-token
    POST { token } → { session_id, customer_id, expires_at }
    Validates token via customer_portal_tokens.is_active
    Creates row in customer_portal_sessions
    Captures user-agent and IP for audit
    Auto-deploys via GitHub Actions

  - New shared helper: supabase/functions/_shared/portal-auth.ts
    Exports resolvePortalAuth(supabase, { token?, portal_token?, session_id? })
    Returns { customer_id, source_token_id, session_id?, via: 'session' | 'token' }
    Accepts both 'token' and 'portal_token' field names
    (handles historical inconsistency across the 7 portal
    edge functions)
    Updates last_used_at on session validation (fire-and-forget)
    Throws structured error messages on auth failure

  Step 1 (SQL Editor, today) created customer_portal_sessions
  table with FK CASCADE to customers and customer_portal_tokens.
  Step 3 (next session) will wire 7 portal edge functions to use
  resolvePortalAuth, update 3 frontend pages to redeem on first
  mount, add /launch route, change manifest start_url, and
  recreate InstallAppBanner gated to TEST-% accounts.

  No customer-facing impact from Step 2 alone. Token-based auth
  flow unchanged.

  ### 2026-05-01 — PWA Phase A Step 3a-1 deployed (3 of 7 functions)

  First batch of portal edge function wiring. Three simplest
  functions now accept session_id alongside legacy token via
  the resolvePortalAuth helper.

  Functions wired in this commit:
    - join-loyalty-program
    - submit-payment
    - edit-payment-submission

  Workflow gap closed: edit-payment-submission added to
  auto-deploy path filter and deploy step.

  Length pre-check removed: submit-payment line ~37
  (token.length < 16 would have rejected session_ids).
  Same pre-check also removed from join-loyalty-program
  for the same reason (spec said only submit-payment but
  join-loyalty-program had the identical guard at line 29
  that would have blocked session_id-only calls).

  edit-payment-submission presence check loosened: the
  guard `if (!portal_token || !submission_id)` would have
  rejected session-only callers. Replaced with
  `if (!submission_id)` since resolvePortalAuth handles
  the auth-side missing-credentials case.

  Backwards compatible — existing token-based callers see no
  change. No customer impact (frontend hasn't changed).

  Known follow-ups for Step 3b:
    - join-loyalty-program welcome email URL embeds
      portal_token at line ~125. When a session-only call
      reaches this function (after Step 3b ships), the URL
      becomes ?token=undefined. Step 3b should either look
      up the customer's active token for the email URL or
      switch the email link shape to a session-aware URL.
    - submit-payment writes portal_token into the
      payment_submissions row at line ~189. Session-only
      submissions would store NULL. Acceptable today
      (customer_id is also captured) but worth tracking.

  Steps 3a-2 and 3a-3 will wire the remaining 4 functions:
    - 3a-2: verify-portal-pin (PIN logic), customer-statement
      (workflow gap check)
    - 3a-3: customer-portal (dual-mode), submit-cash-payment
      (dual-auth)

  Step 3b (later) will flip frontend to redeem token → session
  on mount and add /launch route + manifest start_url change.

  ### 2026-05-01 — PWA Phase A helper bugfix (76)

  resolvePortalAuth session validation path rewritten from
  PostgREST embed to two sequential queries. Bug surfaced
  during Step 3a-1 verification when session_id auth
  returned 401/403 despite healthy session. Root cause:
  schema cache could not resolve the FK relationship for
  the embed.

  Fix preserves all session validation logic. Adds error
  logging on both queries to expose future debugging info.

  Step 3a-1 verification can now resume. Fresh redeem of
  test token will produce a session that authenticates
  successfully through the helper.

  ### 2026-05-01 — Workflow _shared/ propagation fix (#77)

  GitHub Actions workflow updated so 7 edge functions that
  import from supabase/functions/_shared/ helpers now
  auto-redeploy when those helpers change. Closes the
  latent bug class that surfaced during Phase A Step 3a-1
  (bug #76 helper fix required manual Cloud Shell deploys
  of 3 portal functions).

  Functions now propagating _shared/ changes:
    - send-transactional-email (pre-existing)
    - preview-transactional-email (pre-existing)
    - submit-payment (NEW)
    - join-loyalty-program (NEW)
    - edit-payment-submission (NEW)
    - award-loyalty-points (NEW)
    - loyalty-inactivity-check (NEW)
    - process-loyalty-redemption (NEW)
    - manual-forfeit (NEW)

  Phase A Step 3a-2 and 3a-3 will add the same OR clause
  to verify-portal-pin, customer-statement, customer-portal,
  and submit-cash-payment as those functions are wired to
  resolvePortalAuth.

  ### 2026-05-01 — PWA Phase A Step 3a-2 deployed

  Fourth portal edge function wired to resolvePortalAuth.

  Function wired in this commit:
    - verify-portal-pin (PIN logic preserved bit-for-bit)

  Workflow gap closed: verify-portal-pin deploy step now
  includes _shared/ OR clause for auto-propagation of
  helper changes (matches Bug #77 pattern).

  Phase A scope correction: customer-statement was originally
  listed in the 7-function Phase A audit but is NOT a portal-
  token consumer. It uses statement_tokens table (different
  FK target — layaway_accounts vs customers — and different
  auth lifecycle: account-scoped print/share vs customer-
  scoped portal session). resolvePortalAuth cannot
  authenticate statement_tokens values. Phase A scope is now
  6 functions, not 7. customer-statement stays on token-only
  auth indefinitely or until separately deprecated (planned
  follow-up workstream — feature confirmed unused 2026-05-01).

  Phase A status:
    - Step 1 (table): COMPLETE
    - Step 2 (helper + redeem): COMPLETE
    - Step 3a-1 (3 functions): COMPLETE
    - Step 3a-2 (1 function): THIS COMMIT
    - Step 3a-3 (2 remaining: customer-portal, submit-cash-payment):
      PENDING
    - Step 3b (frontend redemption + /launch + manifest +
      banner): PENDING

  After this commit: 4 of 6 portal functions accept session_id
  alongside token. 2 remain to wire in Step 3a-3.

  ### 2026-05-01 — PWA Phase A Step 3a-3a deployed

  Fifth portal edge function wired to resolvePortalAuth
  (Path A only).

  Function wired in this commit:
    - submit-cash-payment Path A (customer-facing portal
      token auth)

  Path B (admin Bearer JWT auth, lines 72-102) deliberately
  preserved bit-for-bit. Path B handles admin cash payment
  recording via RecordCashPaymentDialog and is structurally
  separate from Path A.

  Workflow gap closed: submit-cash-payment deploy step now
  includes _shared/ OR clause for auto-propagation of helper
  changes (matches Bug #77 pattern). 11 deploy steps now
  propagate _shared/ changes (2 pre-existing + 7 from #77
  + 1 from 3a-2 + 1 from this commit).

  Phase A status:
    - Step 1 (table): COMPLETE
    - Step 2 (helper + redeem): COMPLETE
    - Step 3a-1 (3 functions): COMPLETE
    - Step 3a-2 (verify-portal-pin): COMPLETE
    - Step 3a-3a (submit-cash-payment Path A): THIS COMMIT
    - Step 3a-3b (customer-portal dual-mode): PENDING
    - Step 3b (frontend redemption + /launch + manifest
      + InstallAppBanner): PENDING

  After this commit: 5 of 6 portal functions accept
  session_id alongside token. customer-portal is the last
  remaining function (wires next in Step 3a-3b).

  ### 2026-05-01 — PWA Phase A Step 3a-3b deployed (Backend complete)

  Sixth and final portal edge function wired to
  resolvePortalAuth. Phase A backend is now fully wired.

  Function wired in this commit:
    - customer-portal (dual-mode: GET + POST, two separate
      auth sites, both wired independently)

  Length pre-checks removed at 2 sites:
    - POST handler line 74 (was: token.length < 16)
    - GET handler line 157 (was: token.length < 16)

  Workflow gap closed: customer-portal deploy step now
  includes _shared/ OR clause for auto-propagation of helper
  changes. 12 deploy steps now propagate _shared/ changes
  (2 pre-existing + 7 from #77 + 1 from 3a-2 + 1 from 3a-3a
  + this commit).

  Phase A backend status: COMPLETE
    - Step 1 (table): ✓
    - Step 2 (helper + redeem): ✓
    - Step 3a-1 (3 functions): ✓
    - Step 3a-2 (verify-portal-pin): ✓
    - Step 3a-3a (submit-cash-payment Path A): ✓
    - Step 3a-3b (customer-portal dual-mode): ✓ THIS COMMIT
    - Step 3b (frontend redemption + /launch + manifest
      + InstallAppBanner): PENDING

  All 6 portal functions now accept session_id alongside
  legacy token. Backwards compatible — existing token-based
  callers see no behavior change.

  Step 3b (frontend) is the customer-visible flip:
    - 3 frontend pages add token-redemption logic
      (CustomerPortal, LoyaltyPortal, and any third)
    - New /launch route with 3-case logic
      (session/admin/neither)
    - vite.config.ts manifest start_url change to /launch
    - New InstallAppBanner gated to TEST-% accounts only

  Step 3b ships in next session given its production-visible
  nature. Backend is stable and verified — frontend can flip
  with a single revert if needed.

  ### 2026-05-03 — Phase A frontend reverted (#79)

  Frontend commits 703a516 (3b-1), dc31be1 (3b-2),
  85a8d23 (3b-2-fix) reverted. Phase A backend intact.

  Production state:
    - HEAD: 235bf30 (revert of 3b-1)
    - Customer auth: token-only (backend supports both
      modes; frontend uses token only)
    - InstallAppBanner: not deployed
    - /launch route: not deployed
    - PWAInstallContext: not deployed

  Phase A status update:
    - Step 1 through 3a-3b (backend): COMPLETE, live
    - Step 3b-1 (frontend redemption): REVERTED — broke
      PIN UI transition (#79)
    - Step 3b-2 (/launch + banner): REVERTED (revert chain)
    - Step 3b-2 fix (#78): REVERTED (revert chain)
    - Step 3b-3 (manifest): NOT SHIPPED

  Pending: root cause analysis of #79 before any retry.
  Phase A may proceed backend-only if frontend retry is
  deferred.

  ### 2026-05-04 — Customers mobile crash fixed (#80)

  Customers page now paginates at 50 per page. Three pages
  migrated to useAccountsLight() (no embed).
  AIRiskPanel/AccountList/Finance unchanged but benefit
  from tightened embed (full_name + messenger_link only).
  Mobile Chrome on iOS loads Customers menu correctly.

  Files modified:
    - src/hooks/use-supabase-data.ts (tightened useAccounts
      embed + added useAccountsLight)
    - src/pages/Customers.tsx (pagination + light hook)
    - src/pages/Dashboard.tsx (light hook)
    - src/pages/NewAccount.tsx (light hook)
    - src/components/dashboard/OverdueAlerts.tsx (dead
      import cleanup)

  Phase A status (unchanged):
    - Backend (commits through 17fa7a6): live
    - Frontend (3b-1 through 3b-2-fix): reverted, pending
      investigation of #79

  ### 2026-05-04 — Phase A frontend Path A paused

  Bug #79 deeper investigation completed. Stale helper
  hypothesis ruled out by DB evidence. Remaining suspect
  is frontend state machine in CustomerPortal — requires
  runtime browser observation to pinpoint.

  debug/repro-79 branch preserved locally at 703a516 with
  reproduction steps documented. Resume when local
  debugging time is available.

  Phase A status:
    - Backend (commits through 17fa7a6): LIVE
    - Frontend (3b-1 through 3b-2-fix): REVERTED, on hold
    - Reproduction setup: ready for future investigation

  No customer impact. Token-only auth working as intended.

  ### 2026-05-15 → 2026-05-16 — GSheet loyalty backup workstream + production go-live

  Full loyalty sheet sync infrastructure shipped over two days, capped by
  the production loyalty_enabled flip:

    Sheet:    1xTdtkNZ0IXWT51V1ytnpdSJnuO-nvzpY-iaDvp3xk7k
              ("Cha Jewels Loyalty Backup")
    Service:  cha-jewels-invoice@cha-jewels-hub.iam.gserviceaccount.com
              (shared with invoice generator)

    Caller fixes (commit 34235f8):
      - award-loyalty-points: replaced broken payload, added 3 emissions
        (earned + bonus if promo + tier_changed if upgrade), loyalty_enabled
        fail-closed gate enforced server-side at step 1b
      - process-loyalty-redemption: redeemed payload enriched, added
        revoked emission to void action branch
      - loyalty-inactivity-check: tier_change → tier_changed rename +
        payload enrichment + expired emission enriched
      - join-loyalty-program: enrolled payload enriched with customer_code

    sync-loyalty-to-sheet rewrite (commit 808dda6):
      - Stub replaced with live implementation
      - Routing by event_type to Members (11 cols) or Transactions (13 cols) tab
      - PHT timestamps via Intl.DateTimeFormat
      - Activity Status derivation from last_purchase_at (null or <90 days = Active)
      - Append endpoint (spreadsheets.values.append)
      - Graceful skip when loyalty_sheet_id is empty

    Realtime sync frequency option added to useLoyaltySettings + SettingsTab.

    Historical backfill: 475 enrolled members + 372 historical
    loyalty_transactions appended via CSV import. Cutoff timestamp
    2026-05-16 12:13:57+00 filters out post-toggle events to avoid duplicates.

    loyalty_enabled flipped TRUE at 2026-05-16 12:13:57 UTC — production go-live.
    Live earn flow validated end-to-end with Jan Jovic (CJ-2026-00880,
    member_uuid 87a0c878-0def-4dbc-a28f-47d039e226db): 1800→2000 pts,
    cumulative 186,666→209,179 ¥, transaction
    2ff4c0a5-835b-4919-819d-ad8154f8c26b synced to sheet in real-time.

  ### 2026-05-16 — Loyalty migration catch-up (6 customers)

  Old-system loyalty earnings for 6 customers were not captured in the
  2026-05-16 historical backfill (per-customer aggregate gaps). Resolved
  with consolidated per-customer earned rows matching the backfill data
  shape (Option A — one row per customer, NULL account_id/cash_order_id):

    Customer                                 Code              Pts    Spend ¥
    stokesmaria85 (Ellen P Stokes)           CJ-2026-03560    2,400   153,332
    mmheartie11 (Marikarr Heartie Merca)     CJ-2026-00248    1,200    63,440
    anjcherie28 (Anj Pelijates)              CJ-2026-01608    1,000   103,980
    mickey1504 (Shiely Sy Demalata)          CJ-2026-02472      100    13,320
    maeserrana (Mae Serrana)                 CJ-2026-00736    2,100   211,960
    maricaralonzo110485 (Maricar May Alonzo) CJ-2026-02464    1,400   149,940
    TOTAL                                                     8,200   695,972

  Writes: 6 loyalty_transactions INSERTs + 6 loyalty_members UPDATEs
  (cumulative_spend_jpy, total_points_earned, remaining_points,
  last_purchase_at). Sheet appended with 6 earned rows in Transactions tab
  and 6 admin_edited rows in Members tab. All catch-up rows filterable via
  notes ILIKE 'Migration catch-up from old loyalty system%'.

  Session discoveries that led to SCHEMA FACTS section addition:
  loyalty_transactions actual column names differ from common assumptions
  (transaction_type not event_type, points_amount not points_change,
  spend_amount_jpy not amount_spent_jpy, no multiplier column,
  created_by_user_id uuid not created_by text); customers.email stored
  mixed-case so LOWER() comparison required; Supabase SQL Editor CSV
  export alphabetizes columns. See SCHEMA FACTS & OPERATIONAL LEARNINGS
  for the documented rules.

## PORTAL PIN AUTHENTICATION (added 2026-04-21)

  PIN hash storage: customers.portal_pin_hash (64-char SHA-256 hex digest)
  Related columns:  customers.portal_pin_attempts
                    customers.portal_pin_locked_until

  Hashing standard: SHA-256 only (crypto.subtle.digest)
    TextEncoder → SHA-256 → hex map → 64-char string
    NEVER use bcrypt — removed in commit 7080d5a

  Auto-seed logic (verify-portal-pin):
    If no PIN set → hash last 4 digits of mobile_number, fallback '0000'
    Store as 64-char hex digest

  Verify logic:
    Pure SHA-256 hex equality compare
    No bcrypt fallback — dropped in commit 7080d5a

  Set PIN (set-portal-pin):
    Same TextEncoder + crypto.subtle.digest pipeline
    Every newly set PIN stores as 64-char hex

  Migration note (2026-04-21):
    Confirmed 0 bcrypt hashes ($2a$…) in customers table
    All accounts are SHA-256 clean — no PIN resets required

  Edge functions:
    verify-portal-pin — deployed 2026-04-21
    set-portal-pin    — deployed 2026-04-21

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

## PENDING ITEMS (as of 2026-05-16)

### LOYALTY PORTAL — Cha Jewels Circle Port
Multi-phase port of Circle UI into
loyalty portal. In progress.

  ✅ Phase 1 partially done — propless
     components (MemberCard, VipProgress,
     PointsSnapshot, RecentActivity,
     TierCelebrationModal) ported with
     setLoyaltyData store
  ✅ LoyaltySplashScreen with onboarding
     carousel (4 slides) deployed
  ✅ MemberCard gold gradient + original
     7-second shine effect restored
  ✅ Tier badges row darkened for gold
     background readability
  ⏳ Phase 1 remaining — store extensions:
     - LoyaltyMemberData: email, join_date,
       last_purchase_date
     - LoyaltyTransactionData: invoice_number,
       spend_amount_jpy, tier_multiplier
     - TIER_STATIC: tagline per tier
     - staticFallback.ts (REWARDS, NOTIFICATIONS,
       MILESTONES, REFERRAL, FAQS)
  ⏳ Phase 2 — BottomNav + screen scaffolding
     (Home, Rewards, Points, Alerts, Profile +
     hidden Tiers screen via QuickActions)
  ⏳ Phase 3 — Home screen full composition
     (HomeHeader, MilestoneBanner, QuickActions,
     BirthdayRewardCard, FeaturedBanner,
     PromoBanners, ReferralSection,
     ExclusiveOffers, MilestoneCard)
  ⏳ Phase 4 — Tiers screen
  ⏳ Phase 5 — Points screen (with extended
     transaction fields)
  ⏳ Phase 6 — Rewards screen + VipRewardsVault
     (wired to existing RedemptionForm flow)
  ⏳ Phase 7 — Notifications screen
  ⏳ Phase 8 — Profile screen

### LOYALTY DATA & MIGRATION
  Pre-go-live items all completed 2026-05-15 → 2026-05-16:
    - 464-member base migration done (6-customer catch-up applied
      2026-05-16 — see SYSTEM STATUS)
    - sync-loyalty-to-sheet rewritten from stub to live real-time append
    - Google Sheets GAS email notifications shut off — Sheets is backup
      only; Supabase send-transactional-email is the sole sender

  (No pending items — Adjust Points shipped & validated
   2026-05-17, see SYSTEM STATUS.)

### BUG INVESTIGATIONS — DEFERRED
  6. Schedule rows disappearing bug — 3
     accounts affected today (17636, 18454,
     18088). Months deleted without audit
     log entries. Possible causes:
     - delete-installment edge function
       called incorrectly
     - reconcile-account auto-deleting rows
     - UI bug allowing deletion bypass
     - schedule_audit_log trigger not
       firing on DELETE
     - Direct SQL bypass
     STATUS (2026-05-17): Stage 1 forensic visibility shipped (Bug #112).
     Trigger log_schedule_deletion_trigger now captures every DELETE on
     layaway_schedule to schedule_audit_log with action='forensic_delete'.
     Hypothesis (FK CASCADE from account deletion) ready for confirmation
     via real forensic data when next "vanished installment" report comes in.
     Stage 2 hard blocker design drafted (BEFORE DELETE trigger with GUC
     bypass for delete_account_atomic and delete-installment) but NOT shipped
     pending evidence from Stage 1 to justify the wiring complexity.
  7. RESOLVED 2026-05-17 — Empirical investigation found the
     original hypothesis was incorrect. reconcile-account has
     been report-only since Bug #34 fix (2026-04-20) and never
     wrote to penalty_fees.

     Diagnostic SQL across all accounts found 46 candidate rows
     (penalty.status='paid' exceeding penalty-type allocations)
     but ZERO real corruption:
     - 38 rows: pure allocation_type categorization noise —
       customer paid penalty bundled with base, allocation
       recorded as 'installment' type instead of split into
       'penalty' + 'installment'. Cash totals and customer-
       facing math correct.
     - 8 rows: partial-payment context (live + closed accounts)
       where penalty-first waterfall fully covered penalties,
       with remaining cash partial against base. Same
       categorization signature; math correct.

     Verified accounts: 17062, 17241, 17374, 17451, 17832
     (all completed, total_paid >= total_amount); 18531
     (overdue, partial payment in progress, math correct).

     Current penalty writers all have correct paid_amount-vs-
     penalty guards: record-payment, record-multi-payment,
     review-payment-submission, edit-payment-amount,
     restore-payment.

     No code fix required. No data repair required.

     FOLLOW-UP TRACKING (low priority): allocation_type
     categorization sometimes records penalty cash as
     'installment' type when penalty is added shortly
     before/during a payment cycle. Internal accounting noise
     only — does not affect customer-facing math or balance.
     Worth investigating if revenue split reports between base
     and penalty become important.
  8. review-payment-submission returned 500
     error on cash order #10000 confirmation.
     Cause unknown — error log not captured.
     Order status flipped to completed despite
     crash, but award call never fired. DB
     trigger now provides safety net so future
     failures won't lose points.

### BUG #99 EMPIRICAL VERIFICATION (added 2026-05-13)
  - Manual-forfeit empirical verification: pick a clean test layaway
    account, trigger forfeit via UI, verify revoke fires + tier
    transition + email + in-portal notification
  - Auto-forfeit-settlement empirical verification: synthetically
    trigger each of 5 hook points: manual-forfeit + 4 auto-forfeit-
    settlement paths (PATH 1 penalty cap, PATH 2 3-month overdue,
    extension expiry, extension cap). PATH 3 → final_settlement does
    NOT revoke per Bug #101 (2026-05-14); empirical verification of
    PATH 3 no-revoke is a separate workstream tracked under Open
    workstreams section.
    Verify revoke fires correctly at each
  - 464-member historical loyalty backfill: migrate existing customers'
    loyalty state to Bug #99-final lot schema (spend_basis_jpy +
    lot-based math)

### TODAY'S DATA FIXES (completed)
  - 17636: Month 4 penalties reset from
    'paid' to 'unpaid' (data corruption
    from reconcile-account)
  - 18454: Month 5 restored (₱4,086
    PHP, due 2026-07-11)
  - 18088: Month 6 restored manually +
    total_amount corrected from ₱52,118
    to ₱67,980

### TODAY'S DATA FIXES (2026-04-27)
  - Manually awarded 100 points to Test
    Customer for cash order #10000 (failed
    auto-award due to review-payment-submission
    500 error)
  - Built a DB-trigger safety net for loyalty
    award on completion (SUPERSEDED — the
    Layer-2 trigger path was DROPPED 2026-05-16
    via migration
    20260516000000_drop_layer2_loyalty_triggers.sql;
    review-payment-submission is now the sole
    award path. See LOYALTY SYSTEM RULES.)
  - Cash order #10001 created and completed
    successfully

### TODAY'S DATA FIXES (2026-04-29)
  - Seeded view_loyalty_redemptions in
    role_permissions via SQL Editor
    (admin/finance/staff = true, csr = false).
    Closes the page-access gap surfaced as
    Known Fixed Bug #63.
  - Seeded 11 system_settings keys for
    Phase 2: 8 email toggles
    (loyalty_email_*) defaulted true to
    preserve current send behavior; 3 sheet
    sync keys (loyalty_sheet_id,
    loyalty_sheet_service_account,
    loyalty_sheet_sync_frequency) defaulted
    to empty / "manual".
  - Sentinel UUID
    00000000-0000-0000-0000-0000000000a1
    used as audit_logs.entity_id for every
    entity_type='loyalty_settings' row,
    since audit_logs.entity_id is UUID NOT
    NULL and system_settings has no per-row
    UUID. Documented in
    src/hooks/loyalty-admin/useLoyaltySettings.ts
    as LOYALTY_SETTINGS_AUDIT_ID.
  - Phase 2.5 email gate plumbing — wired
    8 system_settings toggles to actual
    send sites across 4 edge functions.
    Email toggles in admin portal Settings
    tab now functional (no longer UI-only).
    Defaults still true so production
    behavior is unchanged until an admin
    flips a toggle off.
  - Phase 3 schema: extended loyalty_promos
    with image_url and display_priority
    columns; created loyalty_rewards (17
    rows seeded matching the prior
    staticFallback.REWARDS catalog) and
    loyalty_banners (4 rows seeded — 1
    featured matching the old hardcoded
    "Spring 2026 Gold Collection" hero, 3
    promo matching the old PromoBanners
    array: birthday / layaway / tier-up).
  - RLS policies seeded for both new
    tables: admin/finance full CRUD,
    staff read, authenticated customer
    read where is_active = true.

### TODAY'S DATA FIXES (2026-04-30)

  Manual SQL UPDATEs applied via SQL Editor (no edge function
  involvement, no commit traces in repo):

  - TEST-004 audit drift healing
    Layaway schedule row 3 status flipped from 'overdue' to
    'partially_paid'. total_due_amount preserved at 4,000
    (full-owed = base 3,500 + penalty 500).
    layaway_accounts.remaining_balance updated to canonical
    2,500. All 12 audit checks now pass.
    Investigation took 5+ wrong attempts before reading
    penalty_fees revealed the 500 PHP week-1 cycle 1 unpaid
    penalty as the canonical truth driver. Logged as bug #70.

  - INV #18852 plan flip
    payment_plan_months changed 6 → 8 via single targeted SQL
    UPDATE. Schedule rebuild handled separately by Cynthia.
    Plan distribution: 3M=16, 6M=657, 8M=2, 10M=0, 12M=0 = 675.

### TODAY'S DATA FIXES (2026-05-01)

  Schema changes and RLS policies applied via SQL Editor in
  support of Phase 3.2 (Catalog Redemption Wiring):

  - loyalty_redemptions schema additions
    Added reward_id uuid column with FK to
    loyalty_rewards(id) ON DELETE SET NULL, plus
    idx_loyalty_redemptions_reward_id index. Extended the
    loyalty_redemption_type enum with 'catalog_reward' as a
    4th value (used when a redemption is tied to a specific
    loyalty_rewards row rather than one of the 3 legacy
    self-describing types).

  - Anon SELECT policies on loyalty_rewards and loyalty_banners
    Customer portal uses token-based auth (anonymous role to
    Supabase). Phase 3 RLS shipped TO authenticated only,
    which blocked customers from reading the catalog and
    banners once the portal was switched to DB-driven content.
    Added: "Anon can read active rewards" ON loyalty_rewards
    FOR SELECT TO anon USING (is_active = true) and the
    parallel "Anon can read active banners" policy on
    loyalty_banners. No code change — RLS only.

  - Phase 3.1 schema: ALTER TABLE loyalty_promos ADD COLUMN
    bonus_multiplier numeric(5,2) NOT NULL DEFAULT 1.00
    CHECK (bonus_multiplier >= 1.00). Existing rows backfilled
    to 1.00 (neutral, no behavior change for promos already
    running). COMMENT ON COLUMN documents the stack semantics:
    total_mult = tier_mult × bonus_multiplier; flat
    bonus_points still adds on top.

### TODAY'S DATA FIXES (2026-05-03)

  Storage bucket and RLS policies applied via SQL Editor in
  support of Phase 3.5 (Image Upload to Storage):

  - Created loyalty-images storage bucket
    INSERT INTO storage.buckets with public=true,
    file_size_limit=5242880 (5 MB), and allowed_mime_types
    ARRAY['image/jpeg','image/png','image/webp']. Public flag
    matches the promotions bucket precedent so the customer
    loyalty portal can read directly via anon role; mime
    whitelist + size limit enforce the upload contract at
    storage layer (defense-in-depth alongside client-side
    validation in ImageUploadField).

  - 4 RLS policies on storage.objects scoped to bucket_id =
    'loyalty-images':
      "Public read loyalty images" — SELECT to anon +
        authenticated. Required for customer portal
        rendering (token-based, anonymous to Supabase).
      "Admin and finance upload loyalty images" — INSERT
        WITH CHECK (admin OR finance). Tighter than the
        promotions bucket (admin+staff) by design.
      "Admin and finance update loyalty images" — UPDATE
        with the same role check. Needed because Supabase
        upsert mode hits the UPDATE path on overwrite.
      "Admin and finance delete loyalty images" — DELETE
        with the same role check. Required by the
        ImageUploadField fire-and-forget cleanup on
        Replace / Remove.

### TODAY'S DATA FIXES (2026-05-04)

  Schema, indexes, RLS, system_settings, and pg_cron job applied
  via SQL Editor in support of Phase 4 (Communications/Notifications):

  - Phase 4 schema: created two tables.
      loyalty_notifications — master, 17 columns, with CHECK
        constraints on title (1-100), body (1-500), category
        (6-value whitelist), audience_type (3-value whitelist),
        and status (initially 4-value, widened to 6 — see
        next bullet). updated_at trigger via the canonical
        public.update_updated_at_column().
      loyalty_notification_recipients — per-member delivery +
        read state, 6 columns, UNIQUE (notification_id,
        member_id), CASCADE on both FKs (master + member).
      4 indexes: 2 on recipients (member_id+created_at DESC,
        partial member_id WHERE is_read=false), 2 on master
        (partial status='scheduled', status+created_at DESC).
      3 RLS policies: admin/finance read on both tables;
        admin/finance manage on master. No client write
        policies on recipients — service_role only via the
        edge functions.

  - Phase 4 status CHECK widened from 4 to 6 values:
    DROP + ADD CHECK (status IN ('draft', 'scheduled',
    'sending', 'sent', 'cancelled', 'failed')). The new
    'sending' state is set by the queue processor's atomic
    lock to prevent overlapping ticks from double-sending;
    'failed' is the terminal state when fan-out errors out.
    Existing rows in draft / scheduled / sent / cancelled
    remain valid, no backfill needed.

  - system_settings.loyalty_email_broadcast seeded as
    to_jsonb(true) with a description column documenting it
    as the global gate for the per-notification email
    side-fire from send-loyalty-notification. Admin can flip
    via the Settings tab to globally suppress notification
    emails (e.g., during email provider incident).

  - pg_cron job 'loyalty-notification-queue' scheduled at
    '0 * * * *' (top of every hour UTC, jobid=19). Calls
    process-loyalty-notification-queue with the service_role
    JWT in the Authorization header. The JWT is fetched from
    Supabase Vault inside the cron command body rather than
    hardcoded in the schedule, so rotating the service_role
    key does not require a cron re-schedule.

  - Phase 4 polish: Modal opacity + click-trapping bug fixed.
    NotificationComposeDialog originally rendered an AlertDialog
    inside the open Dialog for the send/schedule confirmation
    step. Two shadcn portal overlays stacked at z-50 caused
    a near-opaque backdrop (bg-black/80 layered twice) AND
    trapped the Confirm button click at the upper portal so
    the handler never fired. Refactored to a single Dialog
    with a two-view pattern: showConfirm boolean state
    toggles between form view and confirmation summary
    panel inside the same DialogContent. Footer buttons
    swap with the view. Error path stays on confirm view
    so admin can retry without re-filling the form. Both
    issues resolved by removing the second portal entirely.

  - Phase 4 polish: Duplicate action button for sent /
    cancelled / failed notifications.
    NotificationComposeDialog now accepts a `mode` prop
    ('create' | 'edit' | 'duplicate'), backwards-compatible
    (defaults to 'edit' when notification is set,
    'create' otherwise). Duplicate mode pre-fills title /
    body / category / audience_type / audience_tiers /
    send_email; clears scheduled_for / expires_at /
    audience_member_ids; toasts a re-pick warning when
    source had specific-audience. editLocked skipped in
    duplicate mode. Creates new loyalty_notifications row
    on send; original history preserved (terminal-state
    notifications remain immutable). Per-status action
    matrix on the cards: draft → Edit; scheduled → Edit
    + Cancel; sending → View only; sent / cancelled /
    failed → View + Duplicate (gold primary).

  - Bug #81 — Dashboard.tsx:365 TypeScript error from
    PR #80 fixed. PR #80 (47a3e3e, "paginate + lighten
    accounts query") swapped Dashboard's useAccounts()
    for useAccountsLight() to drop the customers embed
    for the mobile Chrome OOM fix on /customers. The
    lightened 12-column shape no longer satisfied
    GeoBreakdown's prop type of AccountWithCustomer[],
    even though GeoBreakdown only reads 4 scalar fields
    (status, customer_id, currency, remaining_balance)
    and never accesses account.customers.* at runtime.
    Vite/esbuild stripped types and shipped JS anyway —
    Dashboard's Regional Overview rendered correctly in
    production; the error was compile-time noise about
    an over-specified prop type. Fix: introduced a fresh
    local GeoAccount interface in GeoBreakdown.tsx (4
    fields, primitive types, no Pick<> coupling) and
    dropped the AccountWithCustomer import. Both
    useAccounts() and useAccountsLight() satisfy the
    contract because both are supersets. PR #80's mobile
    perf optimization is preserved. GeoBreakdown is
    imported by exactly one file (Dashboard.tsx, verified
    by grep) so no other call sites are affected.

  - Bug #82 — HomeHeader staticFallback leak fixed.
    HomeHeader.tsx still imported NOTIFICATIONS from
    staticFallback even after Phase 4 C8 wired
    NotificationsScreen.tsx to real DB data. The fixture
    array contained 4 unread items, hard-pegging the
    home-tab bell badge to "4" and surfacing a fake
    "Happy Birthday Month, Cynthia! 🎂💛" preview card
    visible to every member. Surfaced during end-to-end
    Phase 4 verification: bell showed "4", bottom-nav
    showed no badge, NotificationsScreen filter showed
    "Unread (0)" — three counters disagreeing because
    only HomeHeader was on stale fixtures. Fix: drop
    the staticFallback import from HomeHeader.tsx; add
    unreadCount + latestUnread props; pass-through via
    LoyaltyPortal → HomeScreen → HomeHeader. latestUnread
    computed inline in LoyaltyPortal as the first
    !is_read item from data.notifications, projected to
    { title, body }. Preview card hidden when
    unreadCount === 0 (no fake birthday banner for
    caught-up members). Removed the
    "TODO: wire to live notifications source — Phase 7"
    comment that flagged the issue but never got
    addressed. Bell badge now matches bottom-nav (both
    read from data.unread_count) and screen filter
    (reads same data via prop), single source of truth.

  - Bug #83 — mark-loyalty-notification-read stale
    auto-deploy. Function code (CORS handler at top
    of Deno.serve, per-response corsHeaders) and
    workflow flag (--no-verify-jwt deploy step,
    correct path filter) were both correct from C3
    (commit a1dcca6). Browser nevertheless saw
    "Failed to send a request to the Edge Function"
    on click-to-read AND mark-all-read. Same class
    as the send-loyalty-notification CORS bug from
    earlier today: GitHub Actions reported green but
    Supabase served stale function code with
    verify_jwt: true, blocking OPTIONS preflight at
    the gateway before the function's own handler
    ran. Fix was operational: manual Cloud Shell
    redeploy with --no-verify-jwt:
      npx supabase functions deploy mark-loyalty-notification-read \
        --no-verify-jwt --project-ref pfoicalpzdcmyxzvwyhz
    Reinforces the AUTO-DEPLOY RULES "STALE EDGE
    FUNCTION DEPLOYS" section: for any browser-callable
    edge function reporting CORS or invocation failure,
    manual Cloud Shell redeploy is the fastest fix —
    don't trust the green CI badge alone.

### TODAY'S DATA FIXES (2026-05-07)

  - Phase 4.2 schema: CHECK constraint on
    loyalty_notifications.category widened from 6 → 11 values:
      DROP CONSTRAINT loyalty_notifications_category_check;
      ADD CHECK (category IN (
        'info','promo','tier','system','reward','birthday',  -- Phase 4 admin-pickable
        'points','redemption','order','expiry','milestone'   -- Phase 4.2 auto-trigger
      ));
    Existing Phase 4 rows untouched (all in the original 6).
    Smoke-tested via DO blocks: all 5 new categories accepted,
    invalid value 'unknown_category' still rejected with
    check_violation. 'milestone' included in the CHECK now even
    though emit logic is deferred to Phase 4.2.1 — avoids a second
    migration round-trip when the milestone path lands.

### TODAY'S DATA FIXES (2026-05-08)

  - Phase 3.1.1 schema follow-up: widened loyalty_promos CHECK
    constraint so multiplier-only promos can be created. The
    legacy CHECK only permitted bonus_points > 0 — admins
    creating a "3x Bonus Weekend" with bonus_points=0 and
    bonus_multiplier=3 hit a check_violation at INSERT time:
      ALTER TABLE public.loyalty_promos
        DROP CONSTRAINT loyalty_promos_bonus_points_check;
      ALTER TABLE public.loyalty_promos
        ADD CONSTRAINT loyalty_promos_bonus_value_check
          CHECK (bonus_points > 0 OR bonus_multiplier > 1.00);
      ALTER TABLE public.loyalty_promos
        ALTER COLUMN bonus_points SET DEFAULT 0;
    The new constraint accepts:
      * Flat-bonus promos      (bonus_points > 0, multiplier=1)
      * Multiplier-only promos (bonus_points=0, multiplier>1)  ← NEW
      * Combo promos           (bonus_points>0 AND multiplier>1)
    Rejects:
      * No-op promos           (bonus_points=0 AND multiplier=1)
    Existing rows are unaffected — Phase 3.1 backfilled
    bonus_multiplier=1.00 on every row, and every legacy promo
    still has bonus_points > 0, so they all satisfy the new OR
    check.
    bonus_points DEFAULT changed from required to 0 so admin can
    omit the field when creating a multiplier-only promo (the
    PromoEditDialog already passes 0 by default; the DEFAULT
    aligns the DB-level contract with the UI).

  - Phase 3.5.1 schema: seeded
    system_settings.cleanup_loyalty_images_dry_run = true via
      INSERT INTO public.system_settings (key, value, description)
      VALUES (
        'cleanup_loyalty_images_dry_run',
        to_jsonb(true),
        'Phase 3.5.1 — when true, cleanup-loyalty-images logs orphans but does not delete.'
      );
    Default dry-run prevents accidental mass-delete on the first
    weekly tick. Manual flip to false after the first 1-2 runs
    are reviewed via the audit_logs entries.

  - Phase 3.5.1 cron: scheduled jobid 20 cleanup-loyalty-images
    at '0 3 * * 0' (Sunday 03:00 UTC = Sunday 11:00 AM PHT)
    using email_queue_service_role_key from vault. Schedule
    statement followed the loyalty-notification-queue precedent
    (jobid 19) — vault.decrypted_secrets lookup in the command
    body so rotating the service_role JWT does not require a
    cron re-schedule.

  - Bug fix (LATENT) — 3 broken crons repointed. jobids 16/17/19
    (loyalty-inactivity-check, auto-expire-cash-orders,
    loyalty-notification-queue) referenced 'service_role_key' in
    vault, but only 'email_queue_service_role_key' exists. They
    were sending empty Bearer tokens and only succeeding because
    target functions deploy with --no-verify-jwt. All 3 crons
    repointed via cron.alter_job + regexp_replace surgical swap
    — minimal diff, idempotent (re-running matches nothing). Now
    sending real service_role JWT, removing the silent auth
    bypass risk if any of those target functions are ever
    redeployed without the --no-verify-jwt flag.

  - Clarification — GitHub Actions Supabase auto-deploy
    workflow is non-functional (missing repo secrets
    SUPABASE_PROJECT_REF + SUPABASE_ACCESS_TOKEN).
    Discovered via workflow_dispatch test of commit
    44e62a3 (path-filter fix). Edge function deploys are
    handled by Lovable inside their environment via direct
    Supabase tooling access. Cloud Shell manual deploys
    are Cynthia-side interventions when needed. Path-filter
    fix remains valid preventive infrastructure for if/when
    GitHub Actions auto-deploy gets enabled.

  - Phase 3.2.1 schema: added 'refunded' value to
    loyalty_transaction_type enum via
      ALTER TYPE public.loyalty_transaction_type
        ADD VALUE 'refunded';
    Used by process-loyalty-redemption void branch when
    inserting the refund loyalty_transactions row
    (positive points_amount; mirrors the approve-branch
    -N debit row). Existing enum values
    ('earned', 'bonus', 'redeemed', 'expired',
    'tier_downgrade') unaffected.

  - Phase 3.2.1 cleanup: orphan test redemption
    REDEEM-ce0a4c5a-9a22-4d7a-95cd-9c6a6593b324 voided
    via the new admin "Void Redemption" button as part
    of the smoke test sequence. Status flipped to
    cancelled, points refunded, audit row written.
    No production fixture remains.

### OPERATIONAL ENHANCEMENTS
  P6: Admin audit log for manual DB changes

### CI/DEPLOYMENT INFRASTRUCTURE
  ⏳ GitHub Actions Supabase auto-deploy
     enablement (BLOCKED on Lovable)

     Currently Lovable handles all edge
     function deploys directly. If GitHub
     Actions auto-deploy is desired as a
     backup mechanism or for Cynthia-side
     commits, two GitHub repo secrets need
     to be added:
       - SUPABASE_PROJECT_REF
         (value: pfoicalpzdcmyxzvwyhz)
       - SUPABASE_ACCESS_TOKEN
         (Personal access token from
         Supabase Dashboard → Account →
         Access Tokens; requires Lovable
         to generate)

     Once added, the workflow file and
     path-filter fix (commit 44e62a3)
     become active infrastructure.

     No urgency — current Lovable
     deployment model works.

### CLEANUP TODOS

  Tracked cleanup items, distinct from
  "TODAY'S DATA FIXES" (which logs
  completed corrective work) and from
  proper PENDING phases. Items here are
  reference-only — usually the work was
  done as a side effect of something
  else and is tracked here so the
  history doesn't get lost.

  - Orphan test redemption REDEEM-ce0a4c5a-9a22-4d7a-95cd-9c6a6593b324
    voided 2026-05-08 as part of Phase
    3.2.1 smoke test sequence. Status
    flipped to cancelled, points
    refunded, audit row written. No
    production fixture remains.
    (Tracking entry only — already
    cleaned up.)

### LOYALTY ADMIN PORTAL — phased build
  ✅ Phase 1 — Foundation (LIVE 2026-04-29)
  ✅ Phase 2 — Configuration (LIVE 2026-04-29)
  ✅ Phase 2.5 — Email gate plumbing
     (LIVE 2026-04-29)
  ✅ Phase 3 — Content Management
     (LIVE 2026-04-29)
  ✅ Phase 3.1 — Bonus Multiplier Wiring
     (LIVE 2026-05-01)
     bonus_multiplier numeric(5,2) on
     loyalty_promos. Strategy B —
     multiplicative stack with tier
     multiplier; flat bonus_points still
     adds on top. Edge function awards
     bonus tx with delta + flat;
     PromoEditDialog gains side-by-side
     inputs; PromotionsTab shows "{N}x
     Bonus" badge. See SYSTEM STATUS
     entry above.
  ✅ Phase 3.2 — Catalog Redemption Wiring
     (LIVE 2026-05-01)
     reward_id FK + 'catalog_reward' enum
     value + atomic stock decrement on
     approve + RewardsScreen real flow +
     anon RLS policies. See SYSTEM STATUS
     entry above.
  ✅ Phase 3.2.1 — Cancel/Void Approved Redemption
     (LIVE 2026-05-08).
     See SYSTEM STATUS entry above.
  ✅ Phase 3.5 — Image Upload to Storage
     (LIVE 2026-05-03)
     loyalty-images public bucket (5 MB
     cap, jpeg/png/webp whitelist) with
     4 RLS policies. New shared
     ImageUploadField component (click +
     drag/drop, 80×80 thumbnail, replace/
     remove, fire-and-forget delete on
     replace) wired into PromoEditDialog,
     RewardEditDialog, BannerEditDialog.
     See SYSTEM STATUS entry above.
  ✅ Phase 3.5.1 — Orphan Image Cleanup
     (LIVE 2026-05-07).
     See SYSTEM STATUS entry above.

  Phase 3 series complete — full content
  management end-to-end.
  ✅ Phase 4 — Communications/Notifications
     (LIVE 2026-05-04)
     Manual admin broadcast notifications to
     loyalty members — 6 categories, 3
     audience modes, schedule for future
     send via hourly cron, optional per-row
     email side-fire gated by global toggle,
     per-recipient read state, mark-as-read
     and mark-all-read endpoints.
     2 new tables (loyalty_notifications +
     loyalty_notification_recipients), 4
     edge functions (send / mark-read /
     queue-processor + customer-portal
     extension), 1 email template
     (loyalty-broadcast), 1 cron job
     (jobid=19, hourly), 1 admin tab
     (NotificationsTab as 11th tab in
     LoyaltyAdmin), full customer-portal
     integration (NotificationsScreen
     replaces staticFallback). See SYSTEM
     STATUS entry above.
  ⏳ Phase 4.1 — Notification templates
     Saved reusable templates for common
     broadcasts (e.g. "Tier Upgrade Welcome",
     "Promo Reminder"). Adds a
     loyalty_notification_templates table +
     CRUD UI + a Templates picker on the
     compose dialog ("Load template" button
     above the title field). Roughly half-day
     of work; deferred until admin demand
     justifies it (admins can copy/paste from
     a Notes app for now).
  ✅ Phase 4.2 — Auto-trigger Notifications
     (LIVE 2026-05-07)
     Instrumented 3 existing loyalty edge
     functions (award-loyalty-points,
     process-loyalty-redemption,
     loyalty-inactivity-check) to emit
     in-portal notifications on key member
     events. Direct DB INSERT pattern via
     two new shared helpers
     (loyalty-notification-templates +
     emit-notification). send_email=false
     on all auto-triggers — existing
     transactional emails cover the email
     channel; doubling up would
     double-email customers. CHECK
     constraint widened from 6 to 11
     categories. Scope reduced from spec's
     4 functions to 3
     (review-payment-submission delegates
     to award-loyalty-points; single
     source of truth). See SYSTEM STATUS
     entry above.
  ⏳ Phase 4.2.1 — Milestone notification
     emission
     CHECK constraint already accepts the
     'milestone' category; Phase 4.2
     widened it schema-only. Need emission
     logic on lifetime spend thresholds
     (e.g., the existing tier boundaries
     ¥1M / ¥4M / ¥8M, plus anniversary
     milestones like ¥10M / ¥20M
     cumulative_spend_jpy). Likely
     instrument award-loyalty-points to
     detect threshold crossings —
     newCumulative > threshold AND
     prev cumulative_spend_jpy <
     threshold = first crossing. Emit
     once per crossing, not per award
     above the threshold. Template
     builder needs adding to
     loyalty-notification-templates.ts
     (e.g., buildMilestoneNotification({
     thresholdJpy, totalSpentJpy })).
  ⏳ Phase 4.3 — Notification preferences
     Per-member opt-out for admin broadcasts
     by category. Adds
     loyalty_notification_preferences table
     (member_id, category, enabled) + a
     Preferences screen on the customer
     portal + a check at fan-out time in
     send-loyalty-notification and
     process-loyalty-notification-queue.
     Defer unless regulatory pressure
     emerges (e.g., GDPR-style explicit
     opt-out requirement) or admin-spam
     pressure shows up in customer
     complaints.
  ⏳ Phase 5 — Tier Benefits Schema
     Expansion (FUTURE ROADMAP)
     Currently the loyalty_tiers schema
     models only 3 benefit columns:
     points_multiplier,
     free_shipping_min_items,
     mystery_gift. Customer portal
     TIER_STATIC in
     src/components/loyalty/loyaltyData.ts
     references richer benefits not in
     schema:
       - "min ¥8,000/item" (purchase
         value floor)
       - "2% discount per ¥50,000 order"
         (Radiant + Elite)
       - "3% discount per ¥50,000 order"
         (Crown VIP)
       - "Mystery gift with every
         shipment" (Crown VIP) — differs
         from current DB "Mystery gift on
         tier-up" label
     These are display-only static
     copy. Admin cannot edit them via
     TierEditDialog. To make them
     editable would require:
       1. Schema additions to
          loyalty_tiers:
            - discount_percent numeric
            - discount_threshold_jpy int
            - min_item_value_jpy int
            - mystery_gift_cadence text
              (replaces boolean:
              'tier_up', 'every_order',
              'monthly', NULL)
            - Optional: extra_benefits
              jsonb for future
              extensibility
       2. Migration to seed existing
          tiers with TIER_STATIC values
       3. TierEditDialog form expansion
          (~4 new fields)
       4. TiersTab dynamic benefit
          rendering (loop over benefit
          columns instead of 3 hardcoded
          spans)
       5. Customer portal — replace
          TIER_STATIC with DB-sourced
          tier benefits
     SEPARATE FROM display expansion:
     ENFORCEMENT is its own project.
     Currently free_shipping is
     display-only (no edge function
     enforces it). Future enforcement
     work would touch:
       - record-payment /
         record-multi-payment (apply
         discount to grand total)
       - cash-order pricing logic
     Estimated effort: ~5 hours
     display-side expansion.
     Enforcement deferred to its own
     scope.
     Trigger: When admin requests
     ability to edit benefits beyond
     the 3 currently supported, OR
     when business rules change such
     that hardcoded TIER_STATIC values
     drift from reality. Bug #86
     (Radiant data drift) was the
     proximate trigger for logging
     this roadmap item.
  ⏳ Phase 6 — Redemption Model Overhaul
     (DETAILED SPEC, locked
     2026-05-09)

     Spec locked in design session
     2026-05-09. Implementation
     phased gradually after the
     pre-Phase 6 loose-end cleanup
     items below complete.

     PRE-PHASE 6 — LOOSE ENDS
     (~5.5 hrs total):
       - Void email notification
         (~2 hrs) — see PENDING
         entry below
       - Phase 4.2.1 milestone
         emission (~1.5 hrs)
       - P5 admin session timeout
         2hr (~2 hrs)

     ─────────────────────────────
     AREA 1 — BIRTHDAY BONUS
     ─────────────────────────────

     Eligibility:
       - Claim window: anytime
         during customer's birth
         MONTH
       - Frequency: once per
         calendar year
       - New enrollees: immediate
         eligibility
       - Missed window: closes for
         the year (cannot retro-
         claim)
       - Promo visibility: only to
         customers whose birth
         month matches current
         month

     Bonus points (tier-based):
       - Glimmer:    500 pts
       - Radiant:  1,000 pts
       - Elite:    1,500 pts
       - Crown VIP: 2,000 pts

     Expiration rule:
       - Bonus expires LAST DAY of
         month BEFORE next birth
         month
       - Example: May birthday →
         claim May 2026 → expires
         April 30 2027
       - All May-birthday
         customers expire same day

     Expiration notifications:
       - Single warning 1 month
         before expiry
       - In-portal + email

     ─────────────────────────────
     AREA 1B — BIRTHDAY FIELD
     SCHEMA
     ─────────────────────────────

     Capture:
       - Lazy capture only —
         customer enters via
         profile when ready
       - Currently empty for all
         663 customers
       - Customer-set first; admin
         cannot pre-populate

     Lock behavior:
       - Locked immediately after
         customer first save
       - Customer cannot edit
         again
       - Admin/staff can override
         ONCE only (correction
         path)
       - After admin override →
         permanently locked

     Eligibility dependency:
       - No birthday set → no
         Birthday Bonus button
         visible

     Date format:
       - Month + day only (no
         year)
       - birth_month smallint
         1-12
       - birth_day smallint 1-31
       - DB CHECK constraint
         validates valid month/
         day combos

     Schema additions on customers
     table:
       - birth_month smallint NULL
       - birth_day smallint NULL
       - birthday_set_at
         timestamptz NULL
       - birthday_corrected_at
         timestamptz NULL
       - birthday_corrected_by_user_id
         uuid NULL
       - birthday_correction_reason
         text NULL

     Lock state (derivable):
       - IF birthday_corrected_at
         IS NOT NULL → permanently
         locked
       - ELSE IF birthday_set_at
         IS NOT NULL → admin-
         correctable once
       - ELSE → empty, customer-
         settable

     ─────────────────────────────
     AREA 2 — POINTS LOTS
     ARCHITECTURE
     ─────────────────────────────

     New table: loyalty_point_lots

     Columns:
       - id uuid PK
       - member_id uuid FK
       - source_type enum
         ('order_earn',
          'birthday_bonus',
          'promo_bonus',
          'admin_adjust',
          'refund_restoration')
       - source_reference text
       - original_amount numeric
       - remaining_amount numeric
       - earned_at timestamptz
         NOT NULL
       - expires_at timestamptz
         NULL (NULL = no
         expiration)
       - consumed_at timestamptz
         NULL
       - expired_at timestamptz
         NULL
       - notes text NULL

     Expiration rules by source:

       source_type='order_earn':
         - expires_at: 12 months
           from earned_at
           INITIALLY
         - ROLLING extension: any
           customer purchase
           extends ALL active
           lots' expires_at to
           (purchase_date + 12
           months)
         - "Inactivity expiration"
           — customer must
           purchase to keep points
           alive

       source_type='birthday_bonus':
         - expires_at: last day
           of month before next
           birth month
         - DOES NOT roll — fixed
           expiry

       source_type='promo_bonus':
         - expires_at:
           configurable per promo

       source_type='admin_adjust':
         - expires_at:
           configurable

       source_type='refund_restoration':
         - Special — restores
           original consumed lot's
           remaining_amount (no
           new lot)

     Consumption order:
       - FIFO by expires_at ASC
         NULLS LAST (expiring
         soonest first)
       - Within same expires_at:
         FIFO by earned_at

     New table:
     loyalty_lot_consumption

     Columns:
       - id uuid PK
       - redemption_id uuid FK
       - lot_id uuid FK
       - amount numeric
       - consumed_at timestamptz
         NOT NULL
       - restored_at timestamptz
         NULL
       - restored_amount numeric
         NULL

     Refund rule (Q4.4):
       - Void/cancellation
         reversal restores
         consumed lots
       - Lot's remaining_amount
         increases by amount
         drawn
       - Original earned_at AND
         expires_at unchanged

     Order cancellation/forfeiture:
       - When status → cancelled/
         forfeited:
           * Find lots from order
           * Reduce
             remaining_amount
           * Customer keeps
             points already spent
             (no clawback)
           * Audit log entry
       - Cancellation REVERSAL:
         restore lots via Q4.4
         path

     Daily cron: expire-points
       - Schedule: 00:30 UTC
         (08:30 PHT)
       - Find lots: expires_at
         <= today AND expired_at
         IS NULL AND
         remaining_amount > 0
       - Set expired_at = now()
       - Decrement
         member.remaining_points
       - Set lot.remaining_amount
         = 0
       - Audit log per lot
       - Send notifications

     ─────────────────────────────
     AREA 3 — SERVICE CATALOG
     ─────────────────────────────

     Initial catalog (9 services):
       1. Resize
       2. Certification
       3. Change Color
       4. Polishing
       5. Engraving
       6. Repair
       7. Stone setting
       8. Cleaning
       9. Plating restoration

     Schema:

       loyalty_services:
         - id uuid PK
         - name text NOT NULL
           UNIQUE
         - description text
         - is_active boolean
           DEFAULT true
         - display_order int
           DEFAULT 0
         - created_at, updated_at

       loyalty_service_requests:
         - id uuid PK
         - customer_id uuid FK
         - member_id uuid FK
         - service_id uuid FK
         - customer_notes text
         - invoice_reference text
           NULL (optional free
           text)
         - proposed_points_cost
           int NULL
         - proposed_at
           timestamptz NULL
         - proposed_by_user_id
           uuid NULL
         - status enum
           ('requested',
            'cost_set',
            'cost_accepted',
            'declined',
            'cancelled',
            'fulfilled')
         - redemption_id uuid
           NULL FK
         - scheduled_fulfillment_date
           date NULL (auto-set to
           cost_accepted_at + 14
           days; admin can extend,
           never shorten)
         - fulfilled_at
           timestamptz NULL
         - fulfilled_by_user_id
           uuid NULL
         - fulfillment_notes text
           NULL
         - created_at, updated_at

     Workflow:

       1. Customer browses
          catalog (no prices
          shown)
       2. Customer requests
          service with optional
          notes + optional
          invoice reference
            → status='requested'
       3. Admin/staff reviews +
          sets cost
            → status='cost_set'
            → Customer notified
       4. Customer accepts or
          declines
            - Accept →
              status='cost_accepted'
            - Redemption row
              CREATED (first
              time)
            - Points debited from
              expiring-soonest
              lots
            - scheduled_fulfillment_date
              auto-set
              TODAY + 14 days
            - Decline →
              status='declined'
              (no redemption)
       5. Admin fulfills
            → status='fulfilled'
            → Customer notified
       6. Cancel paths
            - Before
              cost_accepted: just
              mark cancelled
            - After cost_accepted:
              void redemption
              (Phase 3.2.1) +
              refund points

     Notifications — 4 new
     templates (all in-portal +
     email):
       - service_cost_proposed
       - service_confirmed
       - service_fulfilled
       - service_cancelled

     ─────────────────────────────
     AREA 4 — DISCOUNT AUTO-APPLY
     ON INVOICE
     ─────────────────────────────

     Generic "Spend Points for
     Discount on New Order"
     reward.

     Reward model:
       - Single generic reward in
         catalog
       - No fixed points cost
       - Customer enters
         invoice_number +
         points_to_spend
       - Admin approves →
         discount auto-applied

     Points-to-yen ratio:
       - 1:1 always
       - For PHP accounts:
         PHP_amount =
         JPY_amount × 0.42 rate

     Invoice type constraint:
       - Only NEW orders
         (total_paid = 0) qualify
       - Both layaway AND cash
         orders

     Discount application:
       - Adds to invoice's
         total_paid as VIRTUAL
         PAYMENT
       - Original total_amount
         unchanged
       - remaining_balance
         recalculated

     Cascade logic (when discount
     exceeds downpayment):
       1. Apply to downpayment
          first
       2. Cascade to installment
          1 if exceeds
       3. Continue cascading to
          installment 2, 3...
       4. Until discount fully
          consumed

     Examples:

       Within DP:
         Layaway: ¥30,000, DP
         ¥6,000, 6×¥4,000
         Redeem 3,000 pts → DP
         ¥3,000 cash needed,
         installments unchanged

       Cascade:
         Layaway: ¥30,000, DP
         ¥6,000, 6×¥4,000
         Redeem 8,000 pts → DP
         fully covered,
         installment 1 reduced
         ¥4,000→¥2,000

       Multi-installment cascade:
         Redeem 12,000 pts → DP +
         installment 1 fully
         covered, installment 2
         reduced ¥4,000→¥2,000

     Void reciprocal (Phase
     3.2.1 extension):
       - Refund points to
         original lot
       - Reduce invoice
         total_paid
       - Reverse cascade —
         restore installment
         amounts
       - Recalculate
         remaining_balance
       - Modal warning if invoice
         has cash payments since
         approval

     Schema additions:
       - loyalty_redemptions:
         redemption_kind enum
           ('catalog_reward',
            'discount_on_order',
            'service_request')
       - layaway_accounts:
         loyalty_redemption_id
           uuid NULL FK
         loyalty_discount_jpy
           numeric NULL
       - cash_orders:
         loyalty_redemption_id
           uuid NULL FK
         loyalty_discount_jpy
           numeric NULL

     ─────────────────────────────
     AREA 5 — TIER BENEFITS
     DISPLAY-ONLY
     ─────────────────────────────

     Zero-cost rewards become
     display-only tier perks.
     Hide "Redeem Now" button.
     Show "Tier Perk —
     Automatically Applied"
     badge.

     ─────────────────────────────
     ROLLOUT — GRADUAL
     ─────────────────────────────

     Phase 6.0 — Pre-phase loose
     ends (~5.5 hrs)
       - Void email notification
       - Phase 4.2.1 milestone
         emission
       - P5 session timeout

     Phase 6.1 — Points lots +
     464 member migration BUNDLED
     (~15-18 hrs)
       - Schema:
         loyalty_point_lots +
         loyalty_lot_consumption
       - award-loyalty-points
         refactor
       - process-loyalty-redemption
         refactor (consume from
         lots)
       - Daily expiration cron
       - 464 member migration
         from Google Sheets
       - Validation:
         SUM(lot remaining) =
         member.remaining_points
       - Note: Production DB has
         1 member with 200 pts
         (Test Customer from
         2026-05-08 smoke test)
         — handled as edge case

     Phase 6.2 — Birthday Bonus
     (~10 hrs)
       - Schema:
         customers.birth_* +
         lock fields
       - Profile birthday capture
         UI
       - "Claim Birthday Bonus"
         button (month-gated)
       - claim-birthday-bonus
         edge function
       - Expiration cron +
         notifications

     Phase 6.3 — Service catalog
     (~12 hrs)
       - Schema:
         loyalty_services +
         loyalty_service_requests
       - Admin services
         management UI
       - Customer service
         request flow
       - Cost approval workflow
       - 4 new notification
         templates

     Phase 6.4 — Discount auto-
     apply (~15 hrs)
       - Schema:
         redemption_kind,
         loyalty_redemption_id FK
       - New "Spend Points for
         Discount" reward
       - Backend approve/void
         branches with cascade
       - Frontend discount flow

     Phase 6.5 — Tier display-
     only (~3 hrs)

     TOTAL ESTIMATE: ~60-63 hrs
     = 6-8 sessions

     ─────────────────────────────
     BACKFILL STRATEGY
     ─────────────────────────────

     Primary source: Google
     Sheets historical records
     (464+ members with full
     transaction history)
     Secondary: DB
     loyalty_transactions table

     Process:
       1. Extract per-member
          transaction history
       2. Reconstruct lots with
          original earned_at +
          computed expires_at
       3. Reconstruct consumption
          rows for spending
          events
       4. Validate: SUM =
          member.remaining_points
       5. Cutover with feature
          flag

     ─────────────────────────────
     DESIGN DECISIONS LOG
     ─────────────────────────────

     Birthday Bonus:
       Q1.1 = birth month window
       Q1.2 = once per calendar
              year
       Q1.3 = immediate
              eligibility
       Q1.4 = window closes if
              missed
       Q2.1 = tier-based
              500/1000/1500/2000
       Q2.2 = last day of pre-
              birth-month next
              year
       Q2.3 = 1 month warning

     Birthday Field:
       Q3.1 = lazy capture
              customer-set
       Q3.2 = immediate lock
       Q3.3 = admin one
              correction
       Q3.4 = no birthday no
              claim
       Q3.5 = month+day no year

     Points Lots:
       Q4.1 = 12-month inactivity
              rolling
       Q4.2 = no tier bonuses
       Q4.3 = promo bonus
              separate
       Q4.4 = restore original
              lot
       Q4.5 = expiring soonest
              first

     Service Catalog:
       Q5.1 = 9 services
       Q5.2 = variable cost with
              customer approval
       Q5.3 = status flow + 14-
              day scheduled
              minimum
       Q5.4 = in-portal + email
              all stages
       Q5.5 = optional free-text
              invoice ref

     Discount:
       Q6.1 = generic reward
       Q6.2 = 1:1 ratio
       Q6.3 = virtual payment
              via total_paid
       Q6.4 = NEW orders only
       Q6.5 = both layaway +
              cash
       Q6.6 = auto-reversal on
              void
       Q6.7 = DP first then
              cascade

     Rollout:
       Q7.1 = points lots first
       Q7.2-Q7.3 = Google Sheets
                   backfill
                   bundled with
                   464 member
                   migration
       Q7.4 = after loose ends
       Q7.5 = gradual

     Trigger: Phase 6.0 loose
     ends complete + design
     session results approved
     for build.
  ⏳ Void email notification (small
     standalone fix)

     Phase 3.2.1 (LIVE 2026-05-08) ships
     in-portal notification for void via
     buildRedemptionCancelledNotification
     + emitNotification, but does NOT
     send a transactional email to the
     customer's inbox.

     Approve flow sends both:
       - Transactional email via
         send-transactional-email
         ("Redemption confirmed: N
         points used")
       - In-portal notification

     Void flow only sends:
       - In-portal notification
         (asymmetric)

     Customer experience: gets email
     when redemption approved, but only
     sees cancellation in portal — no
     email when admin voids.

     Fix scope (~2 hours):
       1. Read approve email pipeline
          (template + invocation
          pattern)
       2. Build "redemption_voided"
          email template mirroring the
          approve template's visual
          style
       3. Wire into void branch in
          process-loyalty-redemption
          after the in-portal
          notification emit
       4. Smoke test: void a
          redemption → verify customer
          receives email

     Email content should include:
       - Reward name
       - Points refunded
       - Cancellation reason (from
         cancellation_reason)
       - New points balance
       - Link to loyalty dashboard

     Self-contained — does NOT depend
     on Phase 6 redemption overhaul.
     Can be shipped any time.

### PWA TOKEN-TO-SESSION REDEMPTION (Phase A)

  **STATUS: ABANDONED 2026-05-04 — preserved for historical reference only.
  Verified still abandoned 2026-05-17 (no frontend wiring exists). See
  SYSTEM STATUS → PWA Install for current canonical status.** Replaced by
  email/password auth workstream on
  feature/email-password-auth branch. See EMAIL/PASSWORD
  AUTH subsection below for the active replacement. The
  Phase A scope below is preserved for historical
  reference only and should NOT be picked up.

  Multi-phase PWA fix project lineage:
    Phase 0 (Known Fixed Bug #65) — Cleanup of
            failed dynamic manifest approach.
            Reverted PR-1 (cae1bc8, bug #61)
            and PR-2 (bef1949, bug #62).
            Static manifest remains; PWA
            install no longer works.
    Phase A — Token-to-cookie/session redemption
            (planned, not yet shipped).
    Phase 6 — Dead-shortcut UX handler for
            customers who installed the broken
            admin-context PWA pre-#65, plus
            customers on iOS < 17.2 where A2HS
            cannot reliably redeem the token.

  Phase A scope (planned):
    - New customer_portal_sessions table
      (server-side session keyed by token swap)
    - New redeem-portal-token edge function;
      must be added to
      .github/workflows/supabase-functions-deploy.yml
      so it auto-deploys with the rest
    - 7 portal-facing edge functions accept
      session_id alongside token:
        customer-portal
        verify-portal-pin
        set-portal-pin
        submit-payment
        submit-cash-payment
        process-loyalty-redemption
        join-loyalty-program
    - LoyaltyPortal.tsx — additive only
      (new useEffect for token → session
      redemption + session_id branch in
      fetchPortal)
    - Add audit_delete_cleanup_invariants()
      allowlist row for the new
      customer_portal_sessions table when
      it is created (otherwise the audit
      RPC will flag it as a missing-cleanup
      gap on customers delete-account)
    - Solves the iOS A2HS limitation that
      sank bug #62's manifest approach

  Sharp edges to capture in the eventual
  Known Fixed Bug entry:
    - S5: multi-customer same-device caveat
          — sessions are per-token, not
          per-device, so a phone shared
          between two enrolled customers
          will show whichever portal
          redeemed last
    - S9: iOS 7-day ITP storage uncertainty
          — Safari may evict the session
          cookie within 7 days of last
          interaction; document the
          re-redeem flow
    - Pre-iOS-17.2 customers fall back to
      the Messenger-link prompt path
      (Phase 6 still planned)

### EMAIL/PASSWORD AUTH (Phase B)

**STATUS: SHIPPED TO PRODUCTION 2026-05-05** — replaces abandoned
Phase A PWA approach. Merged to main at commit 337d65c.
End-to-end production validation complete 2026-05-06 via
CJ-2026-05088 re-migration (test fixture; auth_user_id
bcd8c2cf-23e0-4f9c-b507-f8ef15620da2).

Branch: `feature/email-password-auth` (created 2026-05-04 from
main at commit 491e44f, merged to main 2026-05-05, deleted
post-merge)

Per-customer auth routing (LOCKED 2026-05-04):
  Both auth methods coexist permanently. Per-customer
  routing is driven by customers.auth_user_id:

    auth_user_id IS NULL  → messages contain token URL,
                            customer logs in via the
                            Messenger link
    auth_user_id NOT NULL → messages contain bare portal
                            URL, customer logs in with
                            email/password

  The token endpoint stays deployed indefinitely.
  Existing token URLs continue to work for any
  customer (no active revocation). The auth_user_id
  flag controls only which URL gets sent in new
  messages.

Phase 0 — Data cleanup (✅ COMPLETE 2026-05-04):
  - 4 duplicate-email customers investigated
  - Kariemhe pair: deleted CJ-2026-04760 (zero linked
    data), kept CJ-2026-05104 "Karie Mhe Calon"
  - Cabalza pair: deferred (family sharing one email;
    keep using legacy token auth indefinitely)

Step 1 — Branch creation (✅ COMPLETE 2026-05-04):
  - Branch pushed with -u tracking to origin
  - Working tree clean

Step 2 — Database schema changes
          (✅ COMPLETE 2026-05-04, with caveats):
  6 SQL migration files committed to branch at 2d3ac1f
  (originally; rebased to 208e8ef on top of main):
    - 20260504000001_add_customer_role.sql
    - 20260504000002_add_auth_user_id_to_customers.sql
    - 20260504000003_partial_unique_email_index.sql
    - 20260504000004_sync_auth_email_to_customer.sql
    - 20260504000005_customer_rls_policies.sql
    - 20260504000006_customer_rls_policies_remainder.sql

  ⚠️ PROCEDURAL DRIFT: Files 1-5 (enum, FK column,
  partial unique email index, email sync trigger,
  3 of 9 customer RLS policies) were applied to
  production via SQL Editor on 2026-05-04 ahead of
  the merge plan. Effect on production: zero — all
  changes dormant because no customer has
  auth_user_id set yet, and no code path reads or
  writes the new structures. Procedural rule
  violated: schema changes were supposed to wait for
  merge approval. File 6 (6 remaining customer RLS
  policies for payments / payment_submissions /
  loyalty_members / loyalty_transactions /
  loyalty_redemptions / loyalty_notification_recipients)
  is NOT yet in production — applied at merge time.

  Production state vs branch state:
    Files 1-5 schema: branch == prod
    File 6 RLS policies: branch ahead of prod
                          (will reconcile at merge time)

  Process safeguard going forward: SQL intended to
  be run is preceded by an explicit
  "Run this in SQL Editor:" instruction line in
  Claude responses. Anything inside design proposals
  without that prefix is design only and must not
  be executed.

Step 3 — Backend dual-auth (⏳ PENDING):
  - 7 portal edge functions accept BOTH old auth
    (token/session) AND new auth (Bearer JWT)
  - 1-2 new functions: setup-customer-account, optionally
    invite-customer-account
  - Both auth paths remain supported permanently
    (verify-portal-pin and redeem-portal-token are
    NOT deprecated)

  Pre-Step-3 investigation REQUIRED:
    Before any code is written for Step 3, the
    existing email infrastructure must be inventoried
    end-to-end:
      - Every edge function that calls
        send-transactional-email
      - Every email template in use (auth, reminders,
        loyalty notifications, payment confirmations,
        cash order flows, forfeit warnings, etc.)
      - Every place a portal URL is embedded in a
        customer-facing message (so the
        getPortalLinkForCustomer helper can be
        applied uniformly — see Per-customer auth
        routing above)
      - Every cron job that sends emails
    Goal: ensure new customer auth emails (signup
    verification, password reset, email change)
    integrate cleanly with the established
    auth-email-hook + send-transactional-email
    sole-sender pattern. No parallel paths, no
    duplicate-send risk.

Step 4 — Frontend customer login (⏳ PENDING):
  - 4 new routes: /portal/login, /portal/forgot-password,
    /portal/reset-password, /portal/setup
  - Modify CustomerPortal.tsx + LoyaltyPortal.tsx
  - 4-B4-1 SHIPPED 2026-05-05: getPortalAuthHeaders extracted
    to src/lib/portal-auth.ts shared module (commit 2b8c0b3)
  - 4-B4-2 SHIPPED 2026-05-05: LoyaltyPortal dual-auth integration —
    authMode/accessToken/bootstrapping state, bootstrap useEffect,
    dual-auth fetchPortal, redirect changed to /portal/login,
    TopBar back button auth-mode aware
  - 4-B4-3 SHIPPED 2026-05-05: CustomerPortal View → handler conditional
    navigation — session mode navigates to /loyalty (no token), token mode
    preserves /loyalty?token=X behavior; authMode prop plumbed from parent
    CustomerPortal to loyalty card sub-component

#### PHASE B 4-B END-TO-END VALIDATED (2026-05-05)

  Full session-auth customer journey passes all 6 checkpoints on Lovable
  preview environment (preview--chajewelslayaway.lovable.app):

    Checkpoint A — CustomerPortal home in session mode: customer name,
      stats grid, payment buttons, My Loyalty card with View → arrow
    Checkpoint B — Click View → goes to /loyalty WITHOUT ?token= (4-B4-3
      conditional navigation), LoyaltyPortal renders via dual-auth
      fetchPortal (4-B4-2)
    Checkpoint C — All loyalty sub-tabs work (Alerts, Profile, Rewards,
      Points). Q2 reactive bet validated — sub-components receive
      portalToken='' but use supabase.functions.invoke() SDK auto-Bearer.
      No 4-B4-4 substep needed.
    Checkpoint D — Back to Portal goes to /portal WITHOUT ?token=
      (4-B4-2 TopBar conditional fix)
    Checkpoint E — Sign Out clears session, redirects to /portal/login
      (4-B3 sign-out button)
    Checkpoint F — Re-sign-in lands directly at /portal (auth_user_id
      already linked, skips /portal/setup flow)

  Test fixture: customer CJ-2026-05088 "Test Customer",
  email chajewelsjapan@gmail.com, auth_user_id
  3e6ca23f-0b14-44b4-ab41-3d1702bdda65. Linked via /portal/setup
  flow validating setup-customer-account end-to-end.

  Force-deployed during testing (auto-deploy was stale):
    setup-customer-account — Step 3g function never auto-deployed
      (workflow path filter bug, see open items)
    customer-portal — Step 3f-2 modifications were stale on Supabase,
      blocking session-mode fetchPortal until manual redeploy

Step 5 — Admin tools (✅ COMPLETE 2026-05-05):
  - 5-1 SHIPPED at fa64262: portal-setup-invite email template +
    registry entry + setup_link_sent_at column migration
  - 5-2 SHIPPED at 3ee12b4: Send Setup Link button + AlertDialog
    confirm + Migrated/Token-based status badge in
    CustomerPortalShareMenu, email pre-fill on PortalSetup,
    setup_link_sent_at tracking
  - Email-only delivery via existing send-transactional-email +
    portal-setup-invite template
  - Visible to admin + finance roles on CustomerDetail page
  - Validated end-to-end 2026-05-06: setup link → email →
    setup form (email pre-filled) → password creation →
    sign-in success → CJ-2026-05088 re-migrated cleanly

Step 6 — Branch testing (✅ COMPLETE 2026-05-05):
  - Full 6-checkpoint validation on Lovable preview (see
    PHASE B 4-B END-TO-END VALIDATED above)
  - Step 5 send-flow validated post-CSS-fix on preview
    before merge

Step 7 — Merge approval (✅ COMPLETE 2026-05-05):
  - Cynthia approved merge after Step 5 validation passed
  - Merged at 337d65c via fast-forward of main + parallel
    Lovable bot commits (b191129, b013b4b)
  - 38 files changed, 2062 insertions, 169 deletions, zero conflicts
  - Firebase auto-deploy completed in ~30 seconds
  - Production verified: portal.chajewelsjp.com/portal/login
    returns HTTP/2 200, /portal/setup?email=... pre-fill works

Customer rollout (post-launch):
  - Migration is opt-in only via existing token visit
    ("set up email/password if you'd like — both
    methods will continue to work")
  - Messenger broadcasts + admin invites encourage
    adoption but no deadline is enforced
  - Token auth has NO sunset — supported as long as
    any customer uses it
  - Setting up email/password does NOT revoke
    existing tokens (they just stop appearing in
    new messages)
  - 71 no-email customers stay on token auth
    indefinitely (no email → cannot migrate, but
    no expiration either)
  - Cabalza family (shared email) stays on token
    auth indefinitely
  - Customers who never opt in stay on token auth
    indefinitely

Locked decisions:
  - Email verification ON for post-launch self-signups
  - Email verification ON for migration signups
    (corrected 2026-05-05 after testing — Cynthia confirmed
    verification gate is desired before account access;
    PortalSetup.tsx handles the email-click round-trip via
    emailRedirectTo + onAuthStateChange + getSession on mount)
  - Customer-initiated email change: standard verification
  - Admin-initiated email change: override + notify
  - Password: 8 chars + 1 letter + 1 number
  - Session refresh token: 30 days
  - Empty accounts state: "You don't have any orders yet"
    with shop/Messenger CTA
  - Token auth sunset: NONE — supported indefinitely
  - Token revocation on signup: NONE — opting into
    email/password does not revoke existing tokens
  - Portal link in customer messages: bare URL
    (https://portal.chajewelsjp.com) when
    customers.auth_user_id IS NOT NULL,
    token-bearing URL otherwise. Implemented via
    centralized helper getPortalLinkForCustomer().
  - Migration policy: opt-in only, no deadline,
    no forced migration

Branch isolation rules (LOCKED):
  - All work on feature/email-password-auth
  - NO commits to main during development
  - User explicitly approves merge to main only after
    full testing
  - portal.chajewelsjp.com stays customers-only

#### Path forward (decided 2026-05-05)

  Path β chosen — build Phase B Step 5 (admin "Send setup link" UI)
  before merging branch to main. Rationale: Step 5 unblocks scaled
  migration via broadcast invites instead of manual per-customer
  Messenger sharing. Step 5 is additive (UI-only, no backend change),
  low risk.

  Open items (post-launch):
    - RLS file 6 — 6 staged SELECT-only policies on:
      payments, payment_submissions, loyalty_members,
      loyalty_transactions, loyalty_redemptions,
      loyalty_notification_recipients. Apply only if customer-side
      direct PostgREST reads are introduced. Currently all customer
      reads flow through service-role edge functions (which bypass
      RLS), so file 6 is preventive infrastructure with no active
      need.
    - Workflow path filter bug:
      .github/workflows/supabase-functions-deploy.yml uses
      contains(join(github.event.commits.*.modified, ' '), '...') only.
      New files (commits.*.added) are not detected. setup-customer-account
      Step 3h workflow trigger compensated by adding the file path
      explicitly, but the underlying .added bug remains for future new
      functions. Fix: add ".added" check alongside ".modified".
    - Accessibility cleanup on 4 portal auth pages
      (PortalLogin, PortalSetup, PortalForgotPassword,
      PortalResetPassword). Real WCAG 1.3.1 Level A gap:
      missing id / htmlFor / name attributes on form labels
      and inputs. Plus minor polish (aria-busy on submit,
      aria-describedby on errors, type="button" on nav buttons
      inside forms). Estimated 30-45 min mechanical fix. Not a
      blocker — forms work for assistive tech via visual
      proximity + sonner toasts. Standalone code commit,
      separate from docs.
    - Bulk migration follow-through (582 invites delivered
      2026-05-07 via bulk-send-setup-invites). Track conversion
      rate via auth_user_id population on customers table. No
      active blocker — passive wait for customer signups.

### OTHER
  - Email wiring — wire send-transactional-email
    into send-reminders for grace_period variant

### SYSTEM & PRODUCT (added 2026-04-27)
  - Session timeout — auto-logout 2 hours
    inactivity (P5)
  - Admin audit log for manual DB changes (P6)
  - Loyalty amount field — make visible to staff
    role
  - Dispatcher pattern cleanup: process-email-queue INSERTs new "sent" rows into email_send_log instead of UPDATE-ing the existing "pending" row, and doesn't store idempotency_key or provider response metadata on the sent row. Cosmetic/forensic limitation only — orphans pending rows in the log and prevents tracing provider message IDs. Not customer-impacting. Surfaced during Bug #109 investigation, 2026-05-15.

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
  AND la.invoice_number NOT LIKE 'TEST-%';
-- Expected result: 0 rows. If rows appear, update db_status to paid.
```

## AUTO-DEPLOY RULES (updated 2026-05-13)

  ⚠️ DEPLOYMENT MODEL (updated
     2026-05-10):

     Edge function deployments are
     handled by Lovable inside their
     environment via direct Supabase
     tooling access. Lovable owns
     Supabase Dashboard access;
     Cynthia does not.

     Cynthia has NO direct deployment
     access — `npx supabase functions
     deploy` from Cloud Shell is NOT
     an option. If a function appears
     stale or a recent commit has not
     deployed, escalate to Lovable;
     they redeploy via Supabase
     Dashboard tooling.

     GitHub Actions auto-deploy
     workflow EXISTS but has never
     been functional — missing repo
     secrets SUPABASE_PROJECT_REF
     and SUPABASE_ACCESS_TOKEN.
     Adding them requires Supabase
     Dashboard access (Lovable-owned)
     to generate an access token.

     The workflow file and its
     path-filter logic (last fixed
     2026-05-08 commit 44e62a3)
     remain valid preventive
     infrastructure for if/when
     GitHub Actions auto-deploy
     gets enabled.

GitHub Actions auto-deploys on every push to main:

FRONTEND: Firebase Hosting — ALL pushes trigger rebuild and deploy

SUPABASE EDGE FUNCTIONS — these auto-deploy when their files change.
Source of truth: .github/workflows/supabase-functions-deploy.yml.
Always re-check the workflow file before assuming a function is or
isn't auto-deployed; this list reflects the workflow as of 2026-05-13:

- accept-underpayment
- add-service
- append-cash-receipt
- auto-expire-cash-orders
- auto-forfeit-settlement
- award-loyalty-points
- bulk-import
- bulk-send-setup-invites
- carry-over
- cleanup-loyalty-images
- create-cash-order
- customer-portal
- daily-reconciliation
- dashboard-summary
- edit-payment-submission
- generate-invoice
- get-page365-order
- join-loyalty-program
- loyalty-inactivity-check
- manual-forfeit
- mark-loyalty-notification-read
- preview-transactional-email
- process-loyalty-notification-queue
- process-loyalty-redemption
- recalculate-penalties (DISABLED — returns 410)
- redeem-portal-token
- reconcile-account
- record-multi-payment
- record-payment
- review-payment-submission
- restore-cash-payment
- restore-loyalty-points
- revoke-loyalty-points
- send-loyalty-notification
- send-reminders
- send-transactional-email
- set-portal-pin
- setup-customer-account
- submit-cash-payment
- submit-payment
- sync-loyalty-to-sheet
- verify-portal-pin
- void-cash-payment

Note: _shared/** changes trigger redeploy of
send-transactional-email and preview-transactional-email,
so registry/template edits fan out to the dispatcher and
the Lovable preview UI without a follow-up touch.

Note: _shared/cash-receipt.ts is consumed by both
append-cash-receipt and generate-invoice — changes to it
require redeploying both functions.

Note (updated 2026-05-11): _shared/cash-receipt.ts is
imported directly by append-cash-receipt and generate-invoice.
review-payment-submission does NOT import it — it triggers
append-cash-receipt via fire-and-forget HTTP POST per the
Ship 2B pattern. Changes to _shared/cash-receipt.ts therefore
only require redeploying append-cash-receipt + generate-invoice.

All other edge functions still require manual deploy via Cloud Shell.
Always check .github/workflows/supabase-functions-deploy.yml
before adding new functions.

### review-payment-submission deploy verification

review-payment-submission: verify version in Supabase logs
after every deploy. If the deployed version does not match
the latest commit, escalate to Lovable to redeploy via
Supabase Dashboard tooling — Cynthia cannot run
`npx supabase functions deploy` from Cloud Shell.

### IMPORTANT — STALE EDGE FUNCTION DEPLOYS

Edge function deploys handled by Lovable can occasionally
lag behind the latest commit, leaving the production
function stale. Confirmed twice:
- Cash KPI deploy (2026-04-28)
- D3 reminder count fix — commit 0fe7517
  (2026-04-29). Auto-deploy job reported green
  but Dashboard kept showing the capped 200
  value until a manual redeploy was issued.

After ANY dashboard-summary change, verify the
fix actually shipped (compare Supabase function
version + spot-check a metric). If the metric
looks stale, escalate to Lovable to redeploy via
Supabase Dashboard tooling — Cynthia cannot run
`npx supabase functions deploy` from Cloud Shell.

Same pattern applies to any other edge function
whose effect is observable in the UI — if you
cannot see the fix, escalate redeploy to Lovable
before assuming the code is wrong.

### Known broken: GitHub Actions auto-deploy (as of 2026-05-15)

SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF repo secrets are NOT
configured in the GitHub Actions environment. Empirical evidence:

- Push events: workflow runs in ~7-14s, every deploy step silently skips
  (status "-")
- workflow_dispatch: workflow fails at first deploy step with
  "flag needs an argument: --project-ref"
- Conclusion: no edge function actually deploys via the workflow as of this date

Workaround: every edge function deploy must go through Lovable until secrets
are added.

Fix: add SUPABASE_ACCESS_TOKEN (generate at supabase.com/dashboard/account/tokens)
and SUPABASE_PROJECT_REF (value: pfoicalpzdcmyxzvwyhz) at
github.com/chajewels/la-tracking/settings/secrets/actions.

### Shared template registry coupling

The _shared/transactional-email-templates/registry.ts is bundled into every
edge function that imports it. send-transactional-email is the primary consumer
and performs all template lookups for transactional emails.

When a new template is added to _shared/transactional-email-templates/:

- The producing function (e.g. restore-loyalty-points referencing the new
template) must be deployed
- send-transactional-email MUST ALSO be deployed, or the call fails silently
with "Template not found in registry" at runtime. This is NOT optional.
- Any other consumer of the registry must be redeployed too

Empirical proof from Bug #103: deploying restore-loyalty-points alone was
insufficient — send-transactional-email needed a separate deploy to pick up
the new loyalty-tier-restored template entry. The auto-deploy workflow's
_shared/** path filter is designed to handle this automatically but is currently
disabled by the secrets issue (see Known broken above).

## LOYALTY LIFECYCLE INTEGRATION (Bug #99 — finalized 2026-05-13)

Loyalty revoke/award is wired into all payment lifecycle events EXCEPT
where explicitly decided otherwise.

### Wired (fires revoke or award):
  - void-payment (layaway):           revoke
  - restore-payment (layaway):        restore (via restore_loyalty_points RPC)
  - void-cash-payment:                revoke
  - restore-cash-payment:             restore
  - award-loyalty-points:             award (fires on DP confirmation for
                                      layaway, isFullyPaid for cash)
  - manual-forfeit:                   revoke
  - auto-forfeit-settlement:          revoke (4 hook points — PATH 1, PATH 2,
                                      extension expiry, extension cap;
                                      PATH 3 final_settlement does NOT revoke
                                      per Bug #101, 2026-05-14)
  - reactivate-account:               restore (via restore-loyalty-points
                                      edge function — Bug #101, 2026-05-14)
  - delete-account:                   revoke BEFORE delete_account_atomic RPC

### Explicitly NOT wired:

  Decision 5 — UPDATED via Bug #101 (2026-05-14) — reactivate-account
  now AUTO-RESTORES loyalty:
    reactivate-account auto-restores loyalty by calling restore-loyalty-points
    on the most recent revoke transaction tied to the account. Reverses
    the original Bug #99 decision (was "no auto re-award"). Documented
    inline in the edge function.

  Decision 7 — edit-payment-amount (no-op):
    Editing payment.amount_paid does not change loyalty state under the
    current award model (award is based on account.total_amount, not
    payment amount). No revoke or award fires. Documented inline in the
    edge function with a Phase 0 comment block.

  Decision 9 — delete-account (path-a: explicit calls):
    Implemented via explicit fetch to revoke-loyalty-points BEFORE the
    delete_account_atomic RPC. NOT via DB cascade trigger.

### Lot schema (Bug #99 final shape):
  - lot.original_amount       = base_points × tier_multiplier
                                (full multiplied points stored in lot)
  - lot.spend_basis_jpy       = loyaltyJpy (single source of truth for
                                spend reversal)
  - lot.tier_at_time          = tier name at award time (cosmetic; may
                                drift if tier crossed after DP)
  - lot.multiplier_at_time    = multiplier applied (1x/2x/3x)
  - lot.revoked_at            = TIMESTAMPTZ when revoked
  - lot.revoked_by_transaction_id = UUID of revoke transaction

### Trigger event → reason mapping (in revoke-loyalty-points):
  - void_layaway, void_cash      → 'payment_voided'
  - manual_forfeit, auto_forfeit,
    final_forfeit                → 'account_forfeited'
  - edit_amount                  → 'payment_edited' (currently unused — see
                                   Decision 7)
  - delete_account               → 'account_deleted'

### Restore trigger event → reason mapping (in restore-loyalty-points, Bug #103 — 2026-05-15):
  - account_reactivated  → 'account_reactivated' (default; via reactivate-account)
  - payment_restored     → 'payment_restored'    (future; via restore-payment)
  - manual_restore       → 'manual_restore'      (future; admin direct restore)

### Email policy:
  - Silent on routine revoke or restore (no tier change)
  - Email + in-portal notification on tier transition (any direction)
  - Tier-revoked email template handles 4 revoke reasons in REASON_COPY map
  - Tier-restored email template handles 3 restore reasons in REASON_COPY map
    (added Bug #103, 2026-05-15)
  - In-portal notifications use shared emitNotification helper for BOTH revoke
    and restore paths (writes both loyalty_notifications master row +
    loyalty_notification_recipients row; required for customer portal INNER
    JOIN visibility — Bug #100 fixed revoke side 2026-05-14, Bug #103 fixed
    restore side 2026-05-15)

### Status transition revoke matrix (Bug #101 — 2026-05-14):
  Loyalty revoke fires ONLY when account.status transitions into these
  terminal states:
    - forfeited       (via manual-forfeit OR auto-forfeit PATH 1/2)
    - final_forfeited (via auto-forfeit extension expiry/cap)
    - cancelled       (FUTURE — no current write path exists; documented
                       business rule for if/when cancel-account is built)

  Loyalty is NOT revoked on these statuses:
    - final_settlement (PATH 3) — loyalty preserved; if customer later
                                  recovers, lots stay intact
    - extension_active            — intermediate state, no terminal effect
    - completed                   — successful payoff, loyalty preserved
    - reactivated                 — restoration path; auto-restores via
                                    reactivate-account

  Loyalty is RESTORED on reactivate-account when a prior revoke transaction
  exists for the account.
