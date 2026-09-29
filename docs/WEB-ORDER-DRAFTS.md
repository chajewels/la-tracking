# Website order drafts (website-orders PR 3 of 10, 2026-09-29)

Migration `supabase/migrations/20261018100000_web_order_drafts.sql`.
Plan: `~/Code/reference/website-orders/INVESTIGATION-v2.md` (owner's Mac;
decisions W2-1..W2-12 approved 2026-09-27, W2-10 amended: only PH has a default
courier). PR 1 = #222 (settings move), PR 2 = #224 (shipping fees + couriers).

## What it is

A website checkout will stop creating a real order at pay. It writes a **draft**
that holds the piece. Staff open the draft on a review screen like the Page365
import (PR 4), add shipping, service lines and a discount, and **Confirm**. Only
Confirm creates the cash order or layaway plan, built on the final total. The
order leaves the park area (PR 5) when its first real payment is confirmed.

**PR 3 is dormant.** The switch `system_settings.web_checkout_mode` is seeded
`order` (today's checkout). The draft writer refuses `checkout_mode_not_draft`
until the owner flips it (PR 8), and nothing calls the other functions until
PR 4 / PR 6 ship.

## Tables

| Table | One row per | Written by |
|---|---|---|
| `web_order_drafts` | website checkout (in draft mode) | the `*_web_draft_atomic` functions only |
| `web_order_draft_lines` | piece in a draft, with its stock hold | same |

- `status`: `to_confirm` → `confirmed` (Confirm) / `declined` (staff "Can't
  supply") / `expired` (72h unconfirmed). Only `to_confirm` can move.
- Line `hold_state`: `held` (stock taken) → `released` (stock given back, on
  decline / expiry) or `transferred` (now an order line, on Confirm — **no
  second stock movement**).
- Money: the quote's yen figures, plus the settlement-currency figures
  converted ONCE at the quote's rate (same integer half-up as the order
  writers). `shipping` / `shipping_jpy` NULL = added at confirmation. All
  provisional.
- The invoice number (`invoice_seq`, `web_reference` = `CJ-W-` + 6 digits) is
  reserved at draft time for **both** modes. A layaway uses the number reserved
  on its quote (the agreement was signed against it); a cash draft draws one.
  Declined / expired drafts leave gaps — by design.
- A layaway draft must carry the signed agreement (CHECK + writer refusal
  `agreement_missing`) — "no unsigned plan" is now a database gate.
- RLS: SELECT for staff holding `confirm_web_order_ready`; no browser writes.

## Functions (all service role only, except the switch)

| Function | Does |
|---|---|
| `create_web_draft_atomic(customer, quote, lang, agreement_version, agreement_signed_at)` | The checkout's writer (PR 6). Same quote checks as `create_web_order_atomic` / `create_web_layaway_atomic`; refuses `checkout_mode_not_draft`, `agreement_missing`, `below_plan_minimum`, `out_of_stock`, and `shipping_quote_required` **only** when the destination has an active rate row. Holds the stock, snapshots the address, consumes the quote. Bell: "New website order — confirm the piece". |
| `decline_web_draft_atomic(draft, reason, user, source)` | "Can't supply" (staff: `confirm_web_order_ready`, reason required) or the expiry (`source = 'system'` → `expired`). Releases held lines and returns the stock once. Audited. |
| `expire_web_drafts_atomic(hours = 72, limit = 100)` | The sweep (PR 6 wires it into `web-reservation-sweep`). One draft's failure never stops the others. |
| `materialize_web_draft_atomic(draft, user, order jsonb, schedule jsonb, service_lines jsonb)` | Confirm's single write (PR 4's web branch in `create-cash-order` / `create-layaway-account`). Needs `confirm_web_order_ready` plus `create_cash_order` / `create_account`. Writes the order (web columns, `ready_confirmed_at/by`, `pending_transfer`, deadline, courier), schedule, product lines (from the held lines) and service lines (item rows without a variant), transfers the hold, confirms the draft, re-points the draft's service requests, audits. Refuses `deadline_required`, `term_locked` (W2-3), `schedule_invalid`, `schedule_mismatch` (deposit + instalments must equal the total), `agreement_missing`, `hold_lost`, `not_open`. |
| `web_checkout_mode()` | `'draft'` only if the setting is exactly `"draft"`; anything else `'order'` (fail closed). |
| `get_web_checkout_mode()` / `set_web_checkout_mode(mode, expected)` | The switch. Set: **admin only by role**, audited, guard trigger `trg_guard_web_checkout_mode` refuses SQL / PostgREST writes. Never flip to `draft` before PRs 4–7 are live. |

`materialize_web_draft_atomic`'s `p_order` keys (order currency unless `_jpy`):
`total_amount` (req.), `shipping_fee`, `discount_amount`, `discount_type`,
`discount_value`, `order_date` (default PHT today), `transfer_due_at` (req.),
`notes`, `is_trade`, `loyalty_jpy_amount` (default the draft's product subtotal,
yen), `planned_shipping_method_id`; layaway: `downpayment_amount` (req.),
`payment_plan_months` (= the draft's term), `end_date` (default last due date).
`p_schedule`: `[{installment_number, due_date, amount}]`. `p_service_lines`:
`[{title, quantity, unit_price_jpy, line_total_jpy}]` (yen, like every line).

## Released stamp (`web_released_at`)

On `cash_orders` and `layaway_accounts`. Set by `trg_web_released_payments` /
`trg_web_released_cash_payments` (AFTER INSERT OR UPDATE OF voided_at,
amount_paid) on the first non-voided payment > 0 that is not a loyalty
redemption (`payment_method = 'loyalty_redemption'` or `LOYALTY-%`). Store
credit counts (it is real money). Sticky: a later void does not clear it. Only
`source_channel = 'web'` rows are ever stamped. Backfilled from the first
qualifying payment.

## Live functions extended (md5-guarded, Bug #280)

| Function | Live md5 before | After | Change |
|---|---|---|---|
| `page365_web_holds(uuid)` | `6417708e…` | `45bb5a67…` | + held draft lines. **Without this the Page365 inventory sync puts a drafted piece back on sale.** |
| `email_delivery_report(integer)` | `c5e8e93e…` | `64008318…` | + `web_drafts_placed`, `web_drafts_closed`; an order made from a draft is not counted again as "placed" |
| `web_reservation_expiring_bells()` | `0909b5ef…` | `a90b5294…` | + drafts unconfirmed 48–72h (`entity_type 'web_draft'`) |

## Service requests (W2-5)

`service_requests.web_draft_id` (FK, ON DELETE SET NULL). The target CHECK is
now `service_requests_target_check`: cash order OR layaway OR draft. Confirm
points the request at the new order and keeps `web_draft_id` as history.

## Tests

- Local: `docs/sql/20261018_web_order_drafts_local_stub.sql` (live column
  lists and live function bodies, md5-proven) +
  `docs/sql/20261018_web_order_drafts_local_tests.sql` (switch, cash + peso
  layaway drafts, sold-out rollback, shipping at confirmation, decline, 72h
  expiry and 48h bell, Confirm for both modes with no second stock movement,
  released stamp incl. loyalty exclusion and void, RLS, email report, backfill
  and re-run).
- Static (CI): `src/test/web-order-drafts-migration.test.ts`.
- Live: `docs/sql/20261018_web_order_drafts_verify.sql` (pre-checks, the
  rollback-only preview, after-checks).

## Known limits, for later PRs

- Reassign Owner moves an order, not its draft row: a confirmed draft keeps the
  original `customer_id` (history only; the order is what counts).
- W2-4 (changing the customer on the review screen to an R11-matching account)
  is not in `materialize_web_draft_atomic` yet: it always uses the draft's
  customer. PR 4 adds it if the screen offers "Change".
- Drafts are not in the realtime publication yet (PR 5, with the park area).
