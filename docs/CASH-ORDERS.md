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

