<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

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
    3. Check 17 — `reconciliation_staleness` in system-health-check — fails when
       system_settings.last_daily_reconciliation is older than 25 hours, and
       pushes an issue so `overall` reads ISSUES_FOUND. It is registered in
       OPS_META so the Hub panel actually renders it.
    4. Check 17b — `loyalty_sweep_staleness` — the same test for
       last_loyalty_award_sweep. Its stamp carries `remaining`, so a run that
       stopped on its time budget reads as progress, not as an outage.

    CHECKS 15 AND 16 ARE NOT BUILT. They were documented here as though they
    were, for months. Check 17 was documented the same way and was not built
    either, which is exactly why daily-reconciliation could stop completing on
    2026-05-20 and sit at a 2026-05-19 stamp for four months with nothing
    anywhere reporting it. 17 and 17b now exist; 15 and 16 are filed in
    docs/PENDING.md. Do not describe a check here before it exists — this
    section is read as an inventory, and an inventory that lists checks nobody
    built is worse than a short one.

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

    SUPERSEDED (2026-07-05): the inline-waterfall pattern above for
    the confirm/write path is now consolidated in the
    allocate_payment_atomic Postgres RPC (single transaction:
    waterfall + payment insert + payment_allocations + penalty_fees
    + layaway_schedule + layaway_accounts totals). review-payment-
    submission is the ONLY write-mode caller (p_preview:false) — it
    delegates its allocatePaymentToAccount body entirely to the RPC.
    record-payment and record-multi-payment call the SAME RPC with
    p_preview:true to compute an exact (INVARIANT-1-accurate) plan
    without writing. Any OTHER function needing to apply allocations
    should call allocate_payment_atomic rather than re-inlining the
    waterfall; process-loyalty-redemption's downpayment path stays
    inline (DP payments never allocate to schedule).

