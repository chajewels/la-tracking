# Cash on delivery (代金引換) at website checkout

Owner plan: project doc `claude/cod-plan-2026-10-10.md` (owner decisions 2026-10-09/10).
Migration: `supabase/migrations/20261202100000_cod_checkout.sql` (md5-guarded in-place patches of
the live bodies; a record-only migration of the patched bodies follows the apply —
docs/MIGRATIONS.md).

## Rules

- **Who.** Method `cod`: a yen, full-payment website order delivered in Japan. Never layaway,
  never pesos, never abroad.
- **Switch.** `system_settings.cod_mode` = `"off"` | `"on"`. Anything but the exact string `"on"`
  reads as off (`public.cod_mode()`). Seeded off. Changed ONLY in Hub → Website → Settings →
  **Cash on delivery** (`CodSettingsCard`, admins) through `set_cod_settings(p_mode, p_fee_table,
  p_expected_mode)`: admin ROLE only, `stale` check, one `audit_logs` row
  (`system_setting / set_cod_settings`). The guard trigger `trg_guard_cod_settings` refuses every
  other UPDATE / DELETE of `cod_mode` and `cod_fee_table`. Never change them in SQL or a migration.
- **Fee table.** `system_settings.cod_fee_table`, a JSON array of `{max_jpy, fee_jpy}`, 1–10 rows,
  whole yen, `max_jpy` strictly ascending, 0 ≤ fee ≤ ¥100,000 (`cod_fee_table_valid`). Seed (owner):

  | Amount collected (up to and including) | Fee |
  |---|---|
  | ¥10,000 | ¥1,040 |
  | ¥30,000 | ¥1,150 |
  | ¥100,000 | ¥1,370 |
  | ¥300,000 | ¥1,810 |

  An invalid table means COD is offered to nobody (fail-closed).
- **Amount collected** = pieces after points + shipping (+ services − discount once staff edit at
  Confirm). The fee is NOT part of it.
- **Limit.** COD is offered only while the amount collected ≤ the top `max_jpy` (¥300,000). The fee is
  not counted, so the courier may collect up to ¥301,810. Nothing to collect (points paid
  everything and shipping is free) → no COD (`cod_nothing_to_collect`).
- **ONE fee rule.** `public.cod_fee_jpy(collected)` (SQL, service role only) returns the fee or NULL
  (no COD). TS mirror: `supabase/functions/_shared/cod-fee.ts` (`codFeeJpy`, `codNotOfferedReason`).
  `development/cod-checkout.test.ts` proves the two agree (same seed, same brackets; value by value
  against a local database when `COD_PG_DB` is set). The storefront never computes a bracket.
- **Its own line.** `checkout_quotes.cod_fee_jpy`, `web_order_drafts.cod_fee_jpy` + `cod_fee`,
  `cash_orders.cod_fee`. Included in the draft `total` / `total_jpy` and in `cash_orders.total_amount`
  / `remaining_balance`. NEVER in `loyalty_jpy_amount` (the default loyalty basis stays pieces −
  discount). Points never pay the fee, nor shipping. CHECKs: a fee only on a `cod` row; a COD draft
  is full payment in yen; a COD cash order is yen.
- **Re-bracketed** whenever the amount collected changes: the checkout choice
  (`POST /checkout/quote/:id/choice`), pay (`create_web_draft_atomic`), staff edits at Confirm
  (`confirm-web-draft` → `computeWebDraftFigures` calls `cod_fee_jpy`; `materialize_web_draft_atomic`
  refuses `cod_fee_mismatch`, `over_cod_limit`, `cod_nothing_to_collect`, and `cod_fee_not_cod` on
  any other method), and every method change.
- **Manage Invoice on a COD order (review H2, chosen: block).** The fee is shown as its own line
  and included in the reconciled total. Total, shipping and discount of an order that STAYS `cod`
  cannot be edited: the Hub refuses with the reason, and the database refuses too
  (`trg_guard_cod_order_amount` → `cod_amount_locked`; only a change of `payment_method` in the same
  UPDATE — the two switch functions — may move them). Staff switch the method away (fee removed),
  edit, and switch back (fee re-bracketed), or cancel and recreate. Date and loyalty edits still
  work. Chosen over a re-bracketing RPC because Manage Invoice writes a free-typed total from the
  browser; a server writer for it is a separate change.
- **Partly paid orders (owner M2).** The courier collects `remaining_balance`, so the bracket is on
  `remaining_balance` without the fee. Staff record the full amount the courier collected.
- **No payment deadline.** `materialize_web_draft_atomic` writes `transfer_due_at` / `expires_at`
  NULL for `cod` (and still refuses `deadline_required` for every other method). Switching an order
  TO `cod` clears both columns in the same UPDATE (review H1: a stale date must never come back).
  `set_account_deadlines` refuses a COD order (`cod_no_deadline`, review L2).
  `revive_web_cash_order_atomic` is unchanged: a COD order can never reach `expired`.
- **Shipped orders never lapse (review H1).** `terminate_web_order_atomic` refuses a lapse and any
  automated termination of an order with `shipped_at` set (`shipped`), whatever the method, and
  `auto-expire-cash-orders` leaves shipped orders out of its candidates.
  `terminate_web_order_atomic` refuses a lapse and any automated (system) termination of a COD order
  (`cod_no_deadline`) — `expire_web_order_atomic` reaches the same guard; `auto-expire-cash-orders`
  leaves COD out of its candidates; `web_payment_reminder_eligible` skips COD (and
  `sendClaimedPaymentReminder` refuses it again). No automatic cancel.
- **Flow.** Staff Confirm → ship at once → when the courier remits, staff record the FULL amount
  collected (pieces + shipping + fee) with method **Cash on Delivery** (`cod`, already in
  payment-method-registry) and the courier's remittance statement as proof, through the normal staff
  submission path (submit-cash-payment Path B → review-payment-submission). The courier's own
  charges stay outside the Hub. `payment_status` stays `pending_transfer` (the legacy name for
  "awaiting payment") until the order completes.
- **Refused parcel.** Staff cancel (Cancel on the order page, a person, with a reason) — allowed, the
  stock returns as for any web cancel.
- **The customer never files COD.** `submit-cash-payment` Path A refuses `cod_staff_only` (method
  `cod` / "Cash on Delivery" / 代金引換) and `cod_paid_on_delivery` (any method on a COD order)
  — `customerFilingRefusal` in `_shared/cod-fee.ts`. The database records no submitter identity, so
  this rule lives in the edge function (proven in `development/cod-checkout.test.ts`).
- **Switching.** Staff (`change-payment-method` → `change_web_payment_method_atomic`) and the
  customer after a rejected payment (`switch_web_payment_method_by_customer_atomic`,
  `CUSTOMER_METHODS`) may switch to or from COD, with the checkout's eligibility (switch on, Japan,
  yen, within the limit). The SQL re-brackets and moves `total_amount` / `remaining_balance` (drafts:
  `total` / `total_jpy`) by the fee delta in the same transaction, and answers `cod_fee`,
  `old_cod_fee`, `fee_delta`. Refused while any payment lock is set (unchanged).
- **Leaving COD arms a fresh deadline (review M1).** CLAUDE.md (WEB LAYAWAY): "the deadline is a
  field, moved ONLY through set_account_deadlines … a reason is required". So the switch functions
  do not write it themselves: when a CONFIRMED order goes from `cod` to transfer / paidy / card they
  call `set_account_deadlines` in the same transaction, with now + `web_deposit_deadline_hours`
  (the customer's 24h / 72h rule, the one Confirm uses; the order itself excluded) and a reason
  ("Payment method changed from cash on delivery: …" / "Customer switched from cash on delivery …"),
  audited as `deadlines_updated`. A refusal rolls the whole switch back (`deadline_not_set_<code>`).
  `change-payment-method` still warns (`deadline_missing` / `deadline_in_past`) if a non-COD order
  ends with no usable date, and the confirmation email omits the deadline lines when there is none.
- **Mappers.** `publicMethod`, `storedMethod` (`_shared/checkout-choice.ts`), `webMethodOf`
  (`src/lib/web-payment-method.ts`) and `notAcceptedMethod` map `cod` to `cod`, never to transfer:
  no bank details, transfer emails or transfer reminders for COD.

## Emails (JA and EN)

- Order confirmation / ready (`order-confirmation.tsx`, `chosenMethod: 'cod'`, `codFee`): "we ship
  it; pay the courier on delivery", the 代引手数料 / Cash on delivery fee row, NO deadline lines.
- Reserved (`order-reserved.tsx`, `method: 'cod'`, `codFee`): COD next step and fee row.
- Payment received (`order-payment-received.tsx`, `method: 'cod'`): "the courier passed on your
  payment", "thank you for receiving your parcel".
- Not accepted (`order-payment-not-accepted.tsx`, `cod`): "we could not match it with the courier's
  remittance; we will contact you".
- `METHOD_NAME` / `PayMethod` gain `cod` (代金引換 / cash on delivery).

## Hub

- Labels: `WEB_METHOD_LABEL.cod` = "Cash on delivery (代引)".
- Change payment method: COD in the list; a warning that the total changes by the fee (and that COD
  has no deadline); the toast reports the fee delta and `deadline_missing`.
- Website order review: "Cash on delivery fee" row in the totals; no deadline input for COD.
- Cash order page: fee row in Financial Breakdown; no Expires tile; the Deadlines card is replaced
  by "Payment deadline: none — cash on delivery"; the awaiting-payment banner says how to record the
  courier's remittance.
- Website → Settings → **Cash on delivery** card (admins): switch + fee table.

## Website API (storefront contract)

- `POST /checkout/quote`, `GET /checkout/quote/:id`, `POST /checkout/quote/:id/choice`:
  `payment_options[]` gains `{ method: "cod", offered, reason, fee_jpy }`. Reasons (first that
  fails): `layaway`, `currency_not_yen`, `off`, `address_not_jp`, `nothing_to_collect`,
  `over_cod_limit`. `fee_jpy` is the fee choosing COD adds (null when not offered). `totals` gains
  `cod_fee` (the fee when COD is chosen, else 0), already included in `total_after_points` and
  `due_now_after_points`. The COD limit is judged with the points she asked for.
- `POST /checkout/quote/:id/choice` and `POST /checkout/pay` accept `payment_method` / `method`
  `"cod"`. New refusals (409): `over_cod_limit`, `cod_nothing_to_collect`; `method_unavailable` with
  `reason`.
- `POST /checkout/pay` answer and `GET /drafts[/:id]`: `payment_method: "cod"`, `cod_fee` (already in
  `total`).
- `GET /orders`: `chosen_method: "cod"`. `GET /orders/:id`: `order.cod_fee`, `chosen_method: "cod"`,
  `cod: { fee, collect_on_delivery }` (null on other methods), `transfer_methods: []`, `paidy` / `card`
  null — the order page shows no pay box and says the courier collects `collect_on_delivery`.
- `POST /orders/:id/payment-method` accepts `"cod"` (offered by the same rule); refusals
  `method_unavailable`, `over_cod_limit`, `cod_nothing_to_collect` (409).

## Tests

- SQL: `development/sql/cod-checkout-2026-10-10.sql` (46 checks; local copy of live, rolled back).
- Deno (CI): `development/cod-checkout.test.ts`.
- Vitest: `src/test/cod-hub.test.ts`.

## Deploy order

1. Hub PR → `develop` → release PR → `main` (owner merges); merge `main` back into `develop`.
2. Lovable applies the migration and deploys the edge functions (one message, source assertions
   first). `cod_mode` stays off.
3. Record-only migration of the seven patched bodies.
4. Storefront PR (checkout option, 代引手数料 row, order page, switch, i18n, fixtures, contract,
   特定商取引法 rows, a `check:money` rule against bracket lookups).
5. Owner acceptance, then the admin switches COD on in the card.
