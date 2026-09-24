<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

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

### Changing the plan (the ONLY path)
  change-payment-plan (edge fn, permission 'change_payment_plan' — admin +
  per-user override) → public.change_payment_plan_atomic. Manage Invoice
  (EditAccountDialog) is its only caller. Rules, all enforced in SQL:
  active/overdue accounts only; new plan 3, 6 or 8 months (10/12 not launched);
  reason required. Pending payment submissions (submitted / under_review /
  needs_clarification) do NOT block — allocation runs at confirmation against
  the schedule as it is then, so they land on the new plan; the preview
  reports them as pending_submissions (owner rule 2026-09-17). FIXED rows
  (payment, partial/paid status,
  penalty_amount, penalty_fees, waiver request, allocation, carry-over either
  way) must be installments 1..k and are never touched. Rows k+1..N get
  (total − downpayment − fixed base) split floor + remainder-on-last, due
  order_date + n months (same rule as the other four places). Open rows are
  UPDATED IN PLACE (bypass app.bypass_immutable_schedule_cols), never
  deleted and re-inserted, because deleting a layaway_schedule row CASCADES to
  payment_allocations, penalty_fees, penalty_waiver_requests and
  csr_notifications. Rows above N are deleted only when shortening (the
  preview reports the CSR notifications that go with them). Writes
  payment_plan_months + end_date, one audit_logs 'change_payment_plan' row
  and schedule_audit_log rows per changed installment. apply=false = preview,
  no writes. restructure-account is NOT a plan-change path (orphan; see
  OPEN-BUGS).

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

