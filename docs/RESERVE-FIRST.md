# Reserve first, pay after staff confirm

Owner-approved design, 2026-09-23. It applies to web cash orders and web layaways.
It is split into two parts:

- **A1: SQL only.** Migration `20260923140000_reserve_first_a1.sql`, with the
  assertions in `docs/sql/20260923_reserve_first_a1_assertions.sql`.
- **A2: edge functions and UI.** Not built yet. This file is the contract A2
  builds against.

## The flow

1. **Checkout creates a reservation.** The website edge function reads
   `system_settings.web_reservation_mode`, which is seeded `false`. When the
   switch is `true`, the edge function passes `p_reserve => true` to
   `create_web_order_atomic` or `create_web_layaway_atomic`. A reservation:
   - holds the stock, so the piece reads Sold
   - has no payment deadline (`transfer_due_at` and, for cash, `expires_at`
     are NULL)
   - has `ready_confirmed_at` NULL
   - on a cash order, has `payment_status = 'awaiting_confirmation'`. The
     storefront shows transfer methods only for `pending_transfer`, so no
     payment details are shown.
2. **Staff confirm it ready for dispatch.** This is
   `confirm_web_order_ready_atomic(entity_type, entity_id, user_id, note)`.
   It starts the deadline using `web_deposit_deadline_hours(customer,
   exclude_order)`: 24 hours for a first order, 72 for a returning customer.
   The order being confirmed does not count towards "returning".
   - **Cash:** `payment_status` becomes `pending_transfer`, and
     `transfer_due_at` and `expires_at` both get the deadline.
   - **Layaway:** `order_date` becomes the confirmation date (PHT). Every open
     installment is re-dated to `order_date + n months`, the same expression
     `layaway_quote` uses, and each move is logged to `schedule_audit_log`.
     `end_date` follows. The checkout date is kept in the `audit_logs` row.
3. **"Can't supply".**
   - **Cash:** `terminate_web_order_atomic(id, 'cancelled', reason, user, …,
     'staff', false)`. This function is unchanged and already returns the
     stock.
   - **Layaway:** `decline_web_layaway_reservation_atomic(account_id, reason,
     user)`.
4. **Nobody confirms within 72 hours.**
   `expire_unconfirmed_web_reservations_atomic(p_hours => 72, p_limit =>
   100)` cancels the reservation and returns the stock. It returns
   `cancelled_cash_orders`, `cancelled_layaways` and `skipped`. Each cancelled
   entry carries `id`, `invoice_number`, `web_reference`, `customer_id` and
   `customer_lang` for the email. A2 schedules this function and sends the
   emails.

With the switch `false`, nothing passes `p_reserve`, and every order is
written exactly as before. The only difference is that `ready_confirmed_at`
is stamped `now()`. This was proved in scratch by diffing every written row,
RPC result, schedule row and stock level before and after the migration.

## Who can confirm or decline

The permission key is `confirm_web_order_ready`:

| Role | Allowed |
|---|---|
| admin | yes |
| staff | yes |
| csr | yes |
| finance | no |
| live_agent | no |

The key is checked inside `confirm_web_order_ready_atomic` and inside a staff
`decline_web_layaway_reservation_atomic`, through `has_permission`, so user
overrides apply. The edge function must pass the signed-in user's id. A call
with no user is refused.

The cash decline goes through `terminate_web_order_atomic`, which does not
check permissions. The A2 edge function must check `confirm_web_order_ready`
before calling it.

All three new RPCs can be executed by `service_role` only.

## Refusal codes (`{error: …}`)

**`confirm_web_order_ready_atomic`:**

- `bad_entity_type`
- `user_identity_required`
- `permission_denied`
- `not_found`
- `not_web_order` or `not_web_layaway`
- `already_confirmed`
- `not_live` (the cash order is not `pending`, or the plan is not `active`)
- layaway only:
  - `already_paid`
  - `payment_exists`
  - `schedule_not_pristine` (any row that is not pending, or that carries
    paid, penalty or carried amounts, or any `penalty_fees` row)

**`decline_web_layaway_reservation_atomic`:**

- `reason_required`
- `user_identity_required` and `permission_denied` (staff callers only)
- `not_found`
- `not_web_layaway`
- `already_confirmed`
- `not_live`
- `already_paid`
- `payment_exists`
- `submission_pending` (INVARIANT 12, `p_source = 'system'` only)

**`set_account_deadlines`** now also refuses `not_ready` on an unconfirmed web
reservation. There is no deadline to move until staff confirm.

## Automatic paths that leave reservations alone

These were checked 2026-09-23:

- **`auto-expire-cash-orders`.** Cash orders are selected on
  `expires_at IS NOT NULL AND expires_at < now`. Web layaways are selected on
  `transfer_due_at IS NOT NULL`. A reservation has neither, so it is never
  expired by the deadline sweep, only by the 72-hour one.
- **`reactivate_web_layaway_atomic`.** It revives only plans with
  `expired_at` set. A declined or swept reservation never has `expired_at`, so
  it cannot be revived there.
- **Penalty engine.** Installment 1 of a reservation is at least a month away,
  and a reservation lives at most 72 hours unconfirmed.

## What A2 still has to do

- **Website edge function:**
  - read the switch and pass `p_reserve`
  - show "awaiting confirmation" on the order pages
  - keep payment details hidden until `pending_transfer`
  - refuse payment submissions on an unconfirmed reservation, in
    `submit-cash-payment` / `submit-payment` or before them
- **Hub:**
  - an unconfirmed queue (indexes `idx_cash_orders_web_awaiting_ready` and
    `idx_layaway_accounts_web_awaiting_ready`)
  - Confirm and Can't supply buttons, gated on `confirm_web_order_ready`
- **Emails:** confirmation-with-payment-details, declined, and auto-cancelled.
- **Sweep scheduling:** a cron for the 72-hour sweep (Vault pattern).
- **Decided in A2, not A1:** a cancelled reservation keeps
  `payment_status = 'awaiting_confirmation'`. This is because
  `terminate_web_order_atomic`'s cancel path never touches `payment_status`,
  and that path has always behaved this way. The storefront shows payment
  details only for `pending_transfer`, so the stale value is harmless. It is
  still worth deciding in A2 whether a cancelled reservation should read
  `cancelled`.
