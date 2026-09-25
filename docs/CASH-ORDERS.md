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


## WEB ORDERS IN PESOS (added 2026-09-25, owner-approved plan H1)

  A website FULL-PAYMENT order may settle in yen or pesos — the customer's
  choice at checkout, default yen, on the English and Japanese sites alike.
  Before 2026-09-25 create_web_order_atomic hard-coded 'JPY' and the website
  refused a peso full-payment quote (currency_not_supported_for_full).

  Yen is the price of record:
  - cash_order_items.unit_price_jpy / line_total_jpy stay YEN on every order.
  - cash_orders.loyalty_jpy_amount = the quote's YEN product subtotal
    (checkout_quotes.subtotal_jpy) on every order. Points never move with FX;
    a peso order earns exactly what the same yen order earns.
  - total_amount / remaining_balance / shipping_fee / total_paid are in the
    order's currency, like every cash order.

  The conversion (create_web_order_atomic, migration
  20260925120000_peso_full_payment):
  - rate = checkout_quotes.fx_rate — the fx_rates.jpy_php row captured at
    QUOTE time (30-minute quote life), never today's rate and never
    system_settings.php_jpy_rate (that stays the staff/reporting rate);
  - total_amount = round(total_jpy × rate), shipping_fee =
    round(shipping_jpy × rate) — Postgres half-up to a whole peso; the items
    are the remainder, so the parts sum;
  - the rate and its date are stored in cash_orders.fx_rate_used /
    fx_rate_date (CHECK cash_orders_fx_rate_only_on_php: a rate only ever sits
    on a PHP row). NULL for yen orders and for Hub-arranged peso orders.
  - PHP quote without a rate → {error:'fx_rate_missing'} (503).

  The quote the customer sees must equal the stored order to the peso. The
  website computes the peso full-payment figures with the integer half-up in
  supabase/functions/_shared/settlement.ts, NOT Math.round(jpy × rate): on an
  exact .5 the float product can land just below it (¥100,000 × 0.308345 is
  30834.499999999996 in floats; Postgres stores ₱30,835). The layaway path
  keeps its own arithmetic (layaway_quote), unchanged.

  Everything downstream already keys on cash_orders.currency: transfer
  methods and region (PHP → the Philippine accounts), the reserve-first
  confirm, the 72h expiry, payment recording (INVARIANT 4 compares like with
  like), store credit on cancellation (minted in PHP, pays PHP orders only).
  The order emails print ₱ for shipping and total and list items WITHOUT a
  per-line price on a peso order (owner decision D1 — two currencies never
  share one receipt); yen emails are unchanged.

  Hub: Manage Invoice converts a web peso order's yen items subtotal at
  fx_rate_used (src/lib/web-settlement.ts itemsSubtotalInOrderCurrency), not
  the per-browser getConversionRate(); Hub-arranged peso orders keep the old
  behaviour. Reports still convert PHP to yen at php_jpy_rate, as for peso
  layaway plans, so a peso web order's reported yen can differ slightly from
  its catalog yen price — accepted.
