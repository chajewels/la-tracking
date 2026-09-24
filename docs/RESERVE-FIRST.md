# Reserve first, pay after staff confirm

Owner-approved design, 2026-09-23. It applies to web cash orders and web layaways.
It is split into two parts:

- **A1: SQL only.** Migration `20260923140000_reserve_first_a1.sql`, with the
  assertions in `docs/sql/20260923_reserve_first_a1_assertions.sql`.
- **A2: edge functions, emails, cron and Hub UI.** Built 2026-09-24 on
  `feat/reserve-first-a2` — see "What A2 built" at the end. Migration
  `20260924100000_reserve_first_a2.sql`, assertions in
  `docs/sql/20260924_reserve_first_a2_assertions.sql`.

## The switch — Hub only, admin only (2026-09-24)

`system_settings.web_reservation_mode` is changed from **Website → Settings →
Reserve-first checkout** and from nowhere else. Migration
`20260924120000_web_reservation_mode_toggle.sql`, assertions in
`docs/sql/20260924_web_reservation_mode_toggle_assertions.sql`.

- **Read:** `get_web_reservation_mode()` returns the state, who changed it
  last and when, `can_change`, and how many reservations are still waiting.
  Callers need `manage_website_content` or admin. `enabled` uses the website
  reader's own rule: only JSON `true` or `"true"` counts as on.
- **Write:** `set_web_reservation_mode(p_enabled, p_expected)` is the ONLY
  writer. It checks the **admin role** itself; no permission override can
  grant it. It stores JSON `true`/`false`, stamps `updated_by_user_id` and
  `updated_at`, and writes one `audit_logs` row (`entity_type
  'system_setting'`, action `set_web_reservation_mode`, old → new, user,
  time). `p_expected` is the state the admin saw; if it no longer holds, the
  call returns `stale` and writes nothing. Setting the state it already has
  writes nothing.
- **Guard:** `trg_guard_web_reservation_mode` refuses any other UPDATE or
  DELETE of this row, including an admin's direct PostgREST write and a SQL
  Editor UPDATE. `system_settings` RLS is unchanged, and every other key is
  unaffected.
- The website reads the switch per request, so a change applies to the next
  checkout with no deploy. `/content/settings` is cached like the rest of that
  endpoint, so storefront copy that reads `web_reservation_mode` from it can
  lag by the normal cache window.

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

## What A2 built (2026-09-24)

The switch `system_settings.web_reservation_mode` shipped **false** (it is now changed from the Hub — see "The switch" above). With it
false every customer-facing path is today's: `p_reserve` is not even sent, the
same emails go out (`order-confirmation`, `layaway-plan-created` render
byte-for-byte as before — proved by rendering both old and new), and the same
responses come back. The website reads the switch per request and fails
CLOSED (`readReservationMode`: only JSON `true` or the string `"true"` is on).

**Website (`website` edge function).**

- `/checkout/pay` passes `p_reserve: true` in reserve mode and sends
  `order-reserved` (cash, customer's language) or `layaway-reserved` (English
  only). The response carries `reservation_mode: true`,
  `awaiting_confirmation: true`, `transfer_due_at: null`,
  `transfer_methods: []` (and, for a layaway, `schedule: []` — it is re-dated
  at confirmation).
- `POST /checkout/quote` and `GET /checkout/quote/:id` withhold
  `transfer_methods` in reserve mode (bank details are never shown before
  confirmation); `transfer_available` is unchanged; `reservation_mode: true` is
  added only in reserve mode.
- `GET /orders`, `/orders/:id`, `/layaway`, `/layaway/:id` add
  `awaiting_confirmation` and `ready_for_payment` to every order and plan (both
  derived, `ready_confirmed_at` itself is stripped). Transfer methods are
  withheld on any unconfirmed reservation.
- `POST /layaway/:id/pay`, `submit-payment` and `submit-cash-payment` refuse an
  unconfirmed reservation with 409 `not_ready_for_payment`. The rule checks the
  channel first, so Hub plans (which also carry `ready_confirmed_at` NULL) are
  never blocked.

**Staff actions.** Both gated on `confirm_web_order_ready` at the edge function
and again inside the RPCs where A1 does so.

- `confirm-web-order-ready` → `confirm_web_order_ready_atomic`, then the
  "ready — pay now" email: `order-confirmation` / `layaway-plan-created` with
  `variant: 'ready'` (bank details, the new deadline, the re-dated schedule;
  layaway English only). `preview: true` returns the deadline the customer will
  get without writing — the Hub confirm dialog states it.
- `decline-web-reservation` ("Can't supply", reason required) refuses anything
  that is not an unconfirmed, live, unpaid web reservation — it is not a second
  cancel door. Cash → `terminate_web_order_atomic('cancelled', …, 'staff')` +
  `order-cancelled` with the reason; layaway →
  `decline_web_layaway_reservation_atomic` + `layaway-declined` (English only).

**Hourly `web-reservation-sweep`** (cron `23 * * * *`, Vault pattern):
first the 72-hour auto-cancel (`expire_unconfirmed_web_reservations_atomic`)
with `order-reservation-lapsed` / `layaway-reservation-lapsed` to each customer
and a `web_reservation_auto_cancelled` bell row per order; then ONE email to
sales@chajewelsjp.com (`web-reservations-awaiting`, internal) listing every
reservation 24h+ unconfirmed and never chased. **Dedupe is a column**,
`reservation_reminded_at` on both tables, stamped only after the send was
accepted (or found suppressed) — a refused send is retried next hour.

**Bell and report.** A web order or plan that arrives unconfirmed reads "New
reservation — confirm the piece" (switch off: unchanged, because A1 stamps
`ready_confirmed_at` and the trigger runs AFTER INSERT). `email_delivery_report`
gains `web_layaways_placed`, `web_reservations_confirmed` (staff confirmations
only — `ready_confirmed_by IS NOT NULL`) and `web_layaways_closed`.

**Hub.** Reservation panel with Confirm / Can't supply at the top of
CashOrderDetail and AccountDetail (record-payment is hidden on a reservation);
DeadlinesCard reads "Awaiting confirmation — no payment deadline yet"; an
"Awaiting confirmation" filter on both lists plus a "To confirm" badge per
card; a "To confirm · N" pill at the top of the sidebar on every page; a
"Reservations to confirm" Dashboard card, oldest first, with age, auto-cancel
time and inline actions. All gated on `confirm_web_order_ready`, which now has
a row in the Permission Matrix.

**Decided in A2.** A cancelled reservation keeps
`payment_status = 'awaiting_confirmation'`, as A1 left it. Every surface that
could show payment details keys on `pending_transfer` AND on the reservation
flag, and the website derives `awaiting_confirmation` only while the order is
still live, so the stale value is never read as "awaiting".

**Not in A2.**

- The storefront (`chajewels/cha-jewels-web`) must read `reservation_mode` /
  `awaiting_confirmation` / `ready_for_payment` to switch its copy. Until it
  does, do not flip the switch.
- ~~`record-payment` / `record-multi-payment` (staff) are not guarded
  server-side.~~ Closed 2026-09-24: see "Staff payment guard" below.

## Staff payment guard (2026-09-24)

Every staff payment path now refuses an unconfirmed web reservation on the
server with **409 `not_ready_for_payment`** (`{error, reference, message}`),
not only by hiding the Hub button:

- `record-payment` — before any preview or write.
- `record-multi-payment` — one reservation in the batch refuses the whole
  batch, before any write.
- `review-payment-submission`, `confirmed` action — the only writer of
  `payments` / `cash_payments`. It checks the submission's order(s) BEFORE the
  status flip, so a refused confirm leaves the submission pending.
- Cash orders: `submit-cash-payment` already refused for every role (A2).

The rule is `firstUnconfirmedReservation()` /
`staffNotReadyForPaymentBody()` in `_shared/web-reservation-rules.ts`: web
channel AND `ready_confirmed_at IS NULL`, so a Hub plan is never blocked.
Tests: `src/test/web-reservations.test.tsx` "staff payment guard".
