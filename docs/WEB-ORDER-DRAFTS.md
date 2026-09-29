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
- Drafts are not in the realtime publication. PR 5 chose not to add them (no
  migration): the park area polls every 60s, and the events that matter already
  refresh it (see PR 5 below).

## PR 4 — the review screen and Confirm (2026-09-29)

- **Screen:** `/orders/review/website/:id` (`src/pages/WebOrderReview.tsx`),
  permission `confirm_web_order_ready` (PermissionsContext fallback). Built to
  look and work like the Page365 import review but as **its own page**: the
  plan's "one component, two adapters" extraction was not done, so the live,
  daily Page365 screen is not touched at all (plan risk 7). The two can be
  merged later if wanted.
- **Locked (W2-3):** customer (W2-4: no Change yet), pieces, prices, currency,
  cash / layaway, term. **Editable:** shipping (JP prefilled from checkout;
  empty and required when checkout left it for confirmation), service lines,
  discount, courier (PH preselects Pabitbit; JP / other must be chosen — W2-10),
  payment deadline (empty = the customer's 24h / 72h rule), notes, Trade
  Program, loyalty product amount (empty = pieces − discount, yen).
- **Money never computed in the browser:** every figure comes from
  `confirm-web-draft` `{action:'preview'}`; Confirm sends the inputs only and
  the server recomputes. Logic: `supabase/functions/_shared/web-draft-figures.ts`
  (`computeWebDraftFigures`, tested in `src/test/web-draft-figures.test.ts`).
  Layaway deposit + schedule = `layaway_quote(pieces − discount, term,
  currency, PHT today, shipping, services)`; refused if not eligible, term
  downgraded, or its total differs. Whole numbers only. Loyalty gate
  `LOYALTY_AMOUNT_REQUIRED` as in create-cash-order / create-layaway-account.
- **Server:** new edge function `confirm-web-draft` (verify_jwt, requireAuth +
  `confirm_web_order_ready`): `preview` (writes nothing), `confirm` →
  `materialize_web_draft_atomic` then the existing ready email
  (`sendOrderReadyEmail` / `sendLayawayReadyEmail`), `decline` →
  `decline_web_draft_atomic`. **Deviation from the plan:** a dedicated function
  instead of a web branch inside create-cash-order / create-layaway-account, so
  the live order-creation functions are not touched; it keeps their checks
  (permissions again in SQL, loyalty gate, plan minimum via
  `trg_enforce_plan_minimum`).
- **Deferred to PR 6 (they need draft emails / draft service requests, which
  arrive with the checkout side):** the customer email on "Can't supply", the
  Services landing after Confirm (`?convert=1&fee=&return=`, W2-6), and
  extending the ready emails with courier and service wording (service lines
  already appear as item lines in the order).
- **How staff reach the screen:** from the park area (PR 5). Until then only by
  URL; there are no drafts while `web_checkout_mode = order`.

## PR 5 — the park area: Sales → Website orders (2026-09-29)

Hub frontend only — no migration, no edge function, no Lovable step.

- **Where:** Sales → **Website orders** (`/sales?tab=web`, W2-1), shown only to
  holders of `confirm_web_order_ready` (the draft tables' RLS key). Sidebar
  sub-item with the same permission and a count badge.
- **To confirm:** drafts `to_confirm`, oldest first — web reference (opens the
  review screen), "Full payment" / "Layaway · N months", "Shipping to add"
  (`shipping_jpy` NULL), "Service requested" (an open `service_requests` row with
  `web_draft_id`), TEST, customer, provisional total, country, age (red at 24h)
  and the 72h auto-cancel time. Actions: **Review**, **Can't supply** (reason
  required → `confirm-web-draft` decline). Reservations from the old
  reserve-first flow are listed too, marked **Old flow**, with their existing
  Confirm / Can't supply (plan risk 5) until PR 10.
- **Awaiting payment:** web orders confirmed (`ready_confirmed_at` set) with
  `web_released_at` NULL and a live status. Nearest deadline first: badge
  "Website — awaiting payment", amount due (cash balance / layaway deposit),
  deadline + countdown (red under 6h or passed), "Reminder sent" /
  "No reminder yet" (`web_payment_reminders` status sent), and a note when a
  payment submission is waiting (INVARIANT 12 freeze). Action: **Open** (the
  order page already has Record payment, Move deadline and Cancel).
  **Deviation:** the plan listed those three as row actions; they stay on the
  order page so no dialog is duplicated.
- **Closed (W2-2):** declined / auto-cancelled drafts, and web orders cancelled,
  expired or forfeited with `web_released_at` NULL. Never in the Cash / Layaway
  lists.
- **Cash / Layaway lists (R7):** a web order is hidden until `web_released_at`
  is set (`showInSalesLists`, `src/lib/web-park.ts`); a `completed` order is
  never hidden. The "Awaiting confirmation" channel chip is removed (those rows
  are in Website orders now); a link "Unpaid website orders are in Website
  orders →" is shown to holders of the permission. Hub orders are untouched.
  `useAccounts` itself is NOT filtered, so Record payment, the command palette
  and every report still see parked orders (W2-8: no report change).
- **Sidebar pill "To confirm · N"** counts drafts + old-flow reservations and
  now opens Sales → Website orders. **Dashboard card** is renamed "Website
  orders to confirm" and lists drafts (Review / Can't supply) then old-flow
  reservations. **Command palette** finds drafts by CJ-W reference or name, and
  layaway / cash orders by CJ-W reference too.
- **Customer page (W2-8):** a "Website orders to confirm" block with that
  customer's drafts; plans and cash orders still awaiting payment carry the
  "Website — awaiting payment" badge.
- **Refresh:** query keys `web-drafts` and `web-park` are in `CORE_KEYS`, so a
  realtime change on `cash_orders` / `layaway_accounts` / `staff_notifications`
  refetches them (a new draft rings a bell; Confirm writes an order); the hooks
  also poll every 60s. The review screen and the decline dialog invalidate them.
- **Dev preview:** `/__fixtures?view=hub&webpark=1&at=/sales?tab=web`.
- **Tests:** `src/test/web-park.test.tsx` (rules + screen),
  `src/test/web-reservations.test.tsx` (Dashboard card with drafts).

## PR 6 — the checkout, Hub side, behind the switch (2026-09-29)

Edge functions only (plus the Hub Services landing). **Nothing changes live
while `web_checkout_mode = 'order'`** — every new path is taken only in
`'draft'` mode, which the owner switches on in PR 8 after the storefront
(PR 7) is live. No migration: every SQL function it calls shipped in PR 3.

### `website` (the Website API)

- **Switch:** `checkoutDraftMode()` calls `web_checkout_mode()` (fails closed
  to `'order'`; a read error is `'order'` too).
- **`POST /checkout/quote` and `GET /checkout/quote/:id`** gain
  `shipping_at_confirmation` and `provisional`. In draft mode a destination
  with no published rate returns `shipping_jpy: null`,
  `shipping_at_confirmation: true`, `requires_manual_quote: false`, and a
  layaway quote is priced without shipping instead of refusing
  `shipping_quote_required`. In order mode both are `false` and
  `requires_manual_quote` is exactly as before, so old storefront builds keep
  blocking safely.
- **`POST /checkout/pay`** in draft mode calls `create_web_draft_atomic`
  (before, and instead of, the two old writers) and answers
  `{ draft_id, web_reference, mode, currency, total (provisional), total_jpy,
  shipping_pending, deposit, term_months, provisional: true,
  awaiting_confirmation: true, reservation_mode: true, transfer_due_at: null,
  transfer_region, transfer_methods: [] }` — never `order_id` / `account_id`,
  never bank details. New error codes: `agreement_missing` 400,
  `unsupported_mode` 400, `checkout_mode_not_draft` 409 (only if the switch
  flips back between the two reads). Then the "we have your order / layaway
  request" email, built from the draft, with the provisional note.
- **`GET /drafts`** (the customer's drafts, newest first) and
  **`GET /drafts/:id`** (one draft + its pieces + the address snapshot),
  scoped by `customer_id`. Each draft carries `kind: 'draft'`, `status`,
  provisional money in the settlement currency, `shipping_pending`,
  `decline_reason` (declined only — the reason the customer was told), and
  `order_id` / `account_id` once confirmed (W2-9: the storefront redirects).
  **Deviation from plan §4.3:** drafts are NOT merged into `GET /orders` /
  `GET /layaway`, so those keep their exact shape for storefront builds that
  predate drafts; PR 7 reads `/drafts` beside them.
- **`GET /me`** `records` gains `drafts` (open drafts) and the blank-account
  bell requires all three to be 0.
- **Service requests (W2-5):** `POST /me/service-requests` accepts `draft_id`
  (exactly one of `cash_order_id` / `layaway_plan_id` / `draft_id`; the draft
  must be the customer's and still `to_confirm`, else `draft_closed` 409). Both
  service-request reads return `draft_id`.

### Emails (`_shared/reservation-emails.ts`, keyed per DRAFT id)

- `sendDraftReservedEmail` — at checkout: `order-reserved` (customer's
  language, provisional note, shipping "—" when still to be added) or
  `layaway-reserved` (English, provisional note). Key `draft-reserved-<id>`.
- `sendDraftClosedEmail(kind)` — `declined` (staff "Can't supply", with the
  reason: `order-cancelled` / `layaway-declined`) or `lapsed` (72 hours:
  `order-reservation-lapsed` / `layaway-reservation-lapsed`). Key
  `draft-<kind>-<id>`.
- Draft links go to the storefront page `/checkout/complete/d/<draft_id>`
  (built in PR 7).
- **Ready emails** (after Confirm, also the old flow): `courier` line when the
  order has `planned_shipping_method_id`; a layaway ready email also lists the
  pieces and the agreed service lines by name (their amounts are already in
  the total). All layaway copy stays English.

### Other functions

- **`confirm-web-draft`:** "Can't supply" now emails the customer; Confirm
  returns the draft's open `service_requests`.
- **`web-reservation-sweep`:** also runs `expire_web_drafts_atomic(72)`, sends
  the lapsed email, raises bell `web_draft_auto_cancelled`, and lists drafts
  unconfirmed for 24 hours in the sales@ reminder (stamped on
  `web_order_drafts.reservation_reminded_at`, Hub link to the review screen).
- **Deviation:** `decline-web-reservation` is NOT extended to drafts — the Hub
  declines a draft through `confirm-web-draft` (PR 4/5), so a second path
  would only duplicate it.

### Hub: the Services landing (W2-6)

After Confirm, if the draft carried an open service request, the review screen
opens `/services?tab=requests&open=<id>&convert=1&fee=<services total>&return=<order page>`:
the request drawer opens with the job dialog already open, the fee prefilled
from the service lines staff typed (editable; `ServiceJobPrefill.serviceFee`),
and after the job is saved and linked it returns to the new order. A person
still saves the job — the dialog is never skipped.

### Not in PR 6

- **W2-7 (part-paid web cash order at its deadline)** needs the SQL
  reminder predicate changed as well as `auto-expire-cash-orders`, so it is its
  own small PR with a migration; it is independent of drafts.

### Deploy set

`website`, `web-reservation-sweep`, `confirm-web-draft`,
`confirm-web-order-ready`, `decline-web-reservation`,
`preview-transactional-email` (the last three only bundle the changed
templates / `reservation-emails.ts`).

### Tests

`src/test/web-orders-pr6.test.ts` (source guards), `src/test/web-order-review.test.tsx`
(Services landing), `development/email-encoding.test.ts` (new template
variants render clean), `development/layaway-english.test.ts`,
`src/test/peso-cash.test.ts` (every order email passes the currency).

## W2-7 — a part-paid web cash order at its deadline (2026-09-29)

Migration `20261019100000_w2_7_part_paid_web_orders.sql` (md5-guarded from live,
Bug #280) + `auto-expire-cash-orders`.

- `expire_web_order_atomic` locks the order and refuses `part_paid_released`
  when `web_released_at` is set (the order has received a real payment —
  loyalty redemptions never count, store credit does). Every other refusal is
  still `terminate_web_order_atomic`'s.
- `web_payment_reminder_eligible`: the cash branch adds
  `o.web_released_at IS NULL` — a part-paid web order is not chased. The TS
  mirror (`_shared/web-payment-reminder-rules.ts`) holds only the timing rules,
  so it needs no change.
- `auto-expire-cash-orders` leaves released web orders out of its candidates
  (`.or(source_channel.is.null,source_channel.neq.web,web_released_at.is.null)`),
  so they never take a place in the run's quota.
- Staff still cancel such an order by hand when needed (the existing Cancel,
  with its refund decision). Mirrors layaway: `expire_web_layaway_atomic`
  already refuses once any payment exists.
