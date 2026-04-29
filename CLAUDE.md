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

## TOOL OWNERSHIP RULES (updated 2026-04-29)

  Lovable → src/ AND supabase/functions/ file creation and editing
  Claude Code → src/ AND supabase/functions/ editing when explicitly
                directed by Cynthia. Default mode is read-only audit
                and diagnosis. May commit and push to git when asked.
  Cloud Shell → npx supabase functions deploy commands ONLY
                (and only for functions not in the auto-deploy
                workflow — see AUTO-DEPLOY RULES list)
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
  - D2: AgingBuckets doesn't exclude TEST accounts.
    Confirmed inflating aging by ₱30,166 across 3
    buckets:
    - 1–30 days: +₱2,500 from TEST-004
    - 31–60 days: +₱14,666 from TEST-002 (₱6,166)
      + TEST-003 (₱8,500)
    - 61–90 days: +₱13,000 from TEST-005
  - D4: AgingBuckets reads write-only cache columns
    (CLAUDE.md INVARIANT 2 violation). Confirmed
    via INV #18531 ₱1,000 drift — pre-fix the
    cache showed a value ₱1,000 different from
    the canonical schedule_with_actuals
    actual_remaining for installment 1.

  ATTEMPTED FIX (REVERTED 2026-04-29): Commit
  de1e640 used a two-step query pattern with
  `.in('account_id', accountIds)` on a 600+ UUID
  list. Triggered the PostgREST URL-length
  failure mode documented in this file. All
  buckets returned ₱0 in production. Reverted
  via git revert (commit 1b9ff78).

  CORRECT FIX PATH: server-side RPC
  (get_aging_buckets()) that runs the join in
  SQL and returns aggregated results. Frontend
  consumes RPC output. Defer until investigation
  + RPC creation in next session.
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

  Sweep recommendation: ship the 4 HIGH severity
  timestamptz fixes as one PR (cleanest match to
  D1 pattern, single deploy). D2/D3/D4 can ride
  in a separate sweep alongside the PHT-frontend
  audit above. D5/D7/D8/D9 are lower priority and
  can wait for a dashboard polish session.

### AgingBuckets follow-ups (surfaced 2026-04-29)

  Two low/medium issues found while verifying the
  D2/D4 revert (commit 1b9ff78). Both will be
  folded into the same get_aging_buckets() RPC
  work as D2/D4.

  - AgingBuckets currency-prop ignored:
    src/components/dashboard/AgingBuckets.tsx
    accepts a `currency` prop and uses it only
    for formatCurrency() display. The query
    itself does not filter by currency, so PHP
    and JPY rows are bucketed together and the
    formatted total mislabels them. Surfaced
    during D2/D4 investigation. Fix path: add
    a `currency` filter on the schedule_with_actuals
    side of the get_aging_buckets() RPC and
    pass it from the prop. Defer until the
    RPC lands.

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

  - INVARIANT 2 violations in dashboard-summary
    edge function (lines 237, 321, 322, 339,
    340, 426 read total_due_amount and
    paid_amount cache columns). To be migrated
    to schedule_with_actuals in a follow-up
    RPC pass. Server-side equivalent of the
    AgingBuckets D4 bug — same cache-vs-
    canonical drift potential. (2026-04-30)

  - INVARIANT 2 violation in get_forecast_6m()
    RPC body — reads
    `total_due_amount - COALESCE(paid_amount, 0)`.
    Numbers may diverge from get_aging_buckets()
    for the same accounts. Migrate to
    schedule_with_actuals when next touched.
    (2026-04-30)

  - INVARIANT 2 violation in Finance.tsx
    forecast drilldown slide-over (~line 1005+).
    Reads cache columns for the per-account
    drill list. Migrate to schedule_with_actuals
    when next touched. (2026-04-30)

  - dashboard-summary TEST exclusion uses
    `'TEST%'` (no hyphen) at line 2278 —
    inconsistent with `'TEST-%'` (with hyphen)
    used in get_forecast_6m(),
    get_aging_buckets(), Finance.tsx drilldown,
    and audit RPCs. Standardize to `'TEST-%'`.
    (2026-04-30)

  - useDashboardSummary payload contains
    `reminder_total` / `reminder_success` /
    `reminder_failed` fields that are not
    rendered anywhere on Dashboard. Either
    dead fields, or surface on a future
    Reminders panel. (2026-04-30, surfaced
    during Dashboard inventory)

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
    deactivate-expired-promotions: every hour            ✅
    fc-alert-evaluation:           every 30 minutes      ✅
    process-email-queue:           every 5 seconds       ✅

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
  the only repair path is direct SQL Editor:

    UPDATE public.customers
       SET customer_code = 'CJ-YYYY-XXXXX'
     WHERE id = '<uuid>';

  Audit-log the change manually:

    INSERT INTO public.audit_logs
      (entity_type, entity_id, action,
       old_value_json, new_value_json,
       performed_by_user_id)
    VALUES ('customer', '<uuid>',
            'manual_customer_code_repair',
            jsonb_build_object('customer_code', '<old>'),
            jsonb_build_object('customer_code', 'CJ-YYYY-XXXXX'),
            auth.uid());

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

## LOYALTY AWARD SYSTEM (added 2026-04-27)

### Award triggers:
  Points are awarded automatically when:
  - cash_orders.status flips to 'completed'
  - layaway_accounts.status flips to 'completed'
    (safety net — primary award still on DP
    confirmation per non-negotiable rule)

### Two-layer wiring:
  Layer 1 — Edge function call (primary)
    review-payment-submission line 615-632
    calls award-loyalty-points edge function
    when payment confirmation results in
    cash order completion or DP confirmation.

  Layer 2 — DB trigger (safety net, added
            2026-04-27)
    trg_loyalty_on_cash_order_complete
      on cash_orders UPDATE
    trg_loyalty_on_layaway_complete
      on layaway_accounts UPDATE

    Function: award_loyalty_points_on_complete()
    - SECURITY DEFINER, exception-safe
    - Idempotency check: skips if loyalty
      transaction already exists for this
      cash_order_id or account_id
    - Skips if loyalty_jpy_amount < ¥10,000
      or NULL
    - Skips if customer not enrolled in
      loyalty (no auto-enroll)
    - No tier upgrade detection (edge
      function handles)
    - No email send (edge function handles)
    - First writer wins; second writer sees
      existing transaction and bails

### Points formula:
  points = floor(loyalty_jpy_amount / 10000)
           × 100
           × current_tier_multiplier

### Tier multipliers:
  Glimmer:   1x
  Radiant:   2x
  Elite:     2x
  Crown VIP: 3x

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

## SYSTEM STATUS (as of 2026-04-23)

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
    - Sheet sync (sync-loyalty-to-sheet) is a STUB —
      needs Google service account + sheet IDs configured
    - Adjust Points feature deferred (placeholder UI)
    - Cash payment rejection/clarification emails
      silently fail (deferred from cash plan)

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

  Loyalty award system: LIVE ✅ (2026-04-27)
    - Two-layer wiring: edge function call +
      DB trigger safety net
    - DB trigger: award_loyalty_points_on_complete()
    - trg_loyalty_on_cash_order_complete on
      cash_orders UPDATE
    - trg_loyalty_on_layaway_complete on
      layaway_accounts UPDATE
    - Idempotent (skips if transaction exists)
    - Skips if loyalty_jpy < ¥10,000 or null
    - Skips if customer not enrolled (no auto-enroll)
    - Verified end-to-end with cash order #10001

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

## PENDING ITEMS (as of 2026-04-26)

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
  1. 464 member migration — Google Sheets
     loyalty members → Supabase loyalty_members
     (match by email then name, create
     customer records for unmatched)
  2. sync-loyalty-to-sheet — deployed as stub,
     needs Google service account + Sheet IDs
  3. Google Sheets GAS email notifications
     must be turned off — Sheets becomes
     backup only (Supabase send-transactional-email
     is sole sender)
  4. Adjust Points feature — placeholder UI
     only, no functionality yet

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
  7. reconcile-account incorrectly marks
     penalties as 'paid' on installments
     with paid_amount = 0 (caused 17636 bug).
     Auto-pay penalty logic should require
     paid_amount >= base_installment_amount.
  8. review-payment-submission returned 500
     error on cash order #10000 confirmation.
     Cause unknown — error log not captured.
     Order status flipped to completed despite
     crash, but award call never fired. DB
     trigger now provides safety net so future
     failures won't lose points.

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
  - Built DB trigger safety net
    (award_loyalty_points_on_complete +
    trg_loyalty_on_cash_order_complete +
    trg_loyalty_on_layaway_complete)
  - Verified trigger works end-to-end with
    cash order #10001 (auto-awarded 100 pts)
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

### OPERATIONAL ENHANCEMENTS
  P6: Admin audit log for manual DB changes
  P7: Invoice generator — Google Sheets +
      Drive (service account ready)
  P9: Invoice button — add to AccountDetail
      and CashOrderDetail pages

### LOYALTY ADMIN PORTAL — phased build
  ✅ Phase 1 — Foundation (LIVE 2026-04-29)
  ✅ Phase 2 — Configuration (LIVE 2026-04-29)
  ⏳ Phase 2.5 — Email gate plumbing
     Wire the 8 loyalty_email_* toggle keys
     to the actual gate at each send site:
       - award-loyalty-points (3 sends:
         loyalty-earned, loyalty-bonus,
         loyalty-tier-upgrade)
       - process-loyalty-redemption (1 send:
         loyalty-redeem)
       - loyalty-inactivity-check (2 sends:
         loyalty-pre-expire,
         loyalty-expire-deduct)
       - join-loyalty-program (1 send:
         loyalty-welcome)
       - review-payment-submission (1 indirect
         send via award-loyalty-points fanout)
     Each call site reads system_settings
     before fetching to send-transactional-email
     and skips on false. No new tables.
  ⏳ Phase 3 — Content Management
     - Promotions tab (loyalty-only promos)
     - Rewards Catalog tab
     - Featured banner system
  ⏳ Phase 4 — Communications
     - Notifications tab (broadcast system)
     - Notification templates
     - Per-event email/SMS toggles

### PWA TOKEN-TO-SESSION REDEMPTION (Phase A)
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

### OTHER
  - Firebase signing page Steps 13-17
    (separate Firebase repo, not in main repo)
  - Email wiring — wire send-transactional-email
    into send-reminders for grace_period variant

### SYSTEM & PRODUCT (added 2026-04-27)
  - Session timeout — auto-logout 2 hours
    inactivity (P5)
  - Admin audit log for manual DB changes (P6)
  - Invoice generator — Google Sheets + Drive
    (service account ready)
  - Loyalty amount field — make visible to staff
    role
  - Invoice button — add to AccountDetail and
    CashOrderDetail

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

## AUTO-DEPLOY RULES (updated 2026-04-29)

GitHub Actions auto-deploys on every push to main:

FRONTEND: Firebase Hosting — ALL pushes trigger rebuild and deploy

SUPABASE EDGE FUNCTIONS — these auto-deploy when their files change.
Source of truth: .github/workflows/supabase-functions-deploy.yml.
Always re-check the workflow file before assuming a function is or
isn't auto-deployed; this list reflects the workflow as of 2026-04-29:

- accept-underpayment
- add-service
- auto-expire-cash-orders
- auto-forfeit-settlement
- award-loyalty-points
- bulk-import
- carry-over
- create-cash-order
- customer-portal
- daily-reconciliation
- dashboard-summary
- join-loyalty-program
- loyalty-inactivity-check
- manual-forfeit
- preview-transactional-email
- process-loyalty-redemption
- recalculate-penalties (DISABLED — returns 410)
- reconcile-account
- record-multi-payment
- record-payment
- review-payment-submission
- send-reminders
- send-transactional-email
- set-portal-pin
- submit-cash-payment
- submit-payment
- sync-loyalty-to-sheet
- verify-portal-pin
- void-cash-payment

Note: _shared/** changes trigger redeploy of
send-transactional-email and preview-transactional-email,
so registry/template edits fan out to the dispatcher and
the Lovable preview UI without a follow-up touch.

All other edge functions still require manual deploy via Cloud Shell.
Always check .github/workflows/supabase-functions-deploy.yml
before adding new functions.

### review-payment-submission deploy verification

review-payment-submission: verify version in Supabase logs
after every deploy. If unchanged, manually deploy:

  npx supabase functions deploy review-payment-submission \
    --no-verify-jwt --project-ref pfoicalpzdcmyxzvwyhz

### IMPORTANT — STALE EDGE FUNCTION DEPLOYS

GitHub Actions auto-deploy can report success while
the deployed Supabase edge function stays stale.
Confirmed twice:
- Cash KPI deploy (2026-04-28)
- D3 reminder count fix — commit 0fe7517
  (2026-04-29). Auto-deploy job reported green
  but Dashboard kept showing the capped 200
  value until a manual deploy was issued.

After ANY dashboard-summary change, verify the
fix actually shipped (compare Supabase function
version + spot-check a metric). If the metric
looks stale, manually redeploy from Cloud Shell:

  npx supabase functions deploy dashboard-summary \
    --project-ref pfoicalpzdcmyxzvwyhz

This forces Supabase to take the latest code.
Same pattern applies to any other auto-deployed
edge function whose effect is observable in the
UI — if you can't see the fix, redeploy manually
before assuming the code is wrong.
