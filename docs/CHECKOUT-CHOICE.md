# Checkout payment choice + points at checkout

Owner plan: `claude/checkout-payment-choice-and-points-plan-2026-10-04` (project
doc), decisions C1–C7, plus the owner's answers of 2026-10-05:
"Whole deposit allowed" (layaway points may cover the entire deposit) and
"Keep rule 9" (redeemed points are not returned when a confirmed order later
expires or is cancelled).

Migration `20261107100000_checkout_payment_choice_and_points.sql` (md5-guarded
in-place patches of the live bodies; record-only migration after apply).

## Rules

- **C1 — chosen at checkout, locked for the customer.** `transfer | paidy |
  square` travels `checkout_quotes.payment_method` → `web_order_drafts` →
  `cash_orders.payment_method` (CHECK now allows `paidy`). Only staff change it:
  `change-payment-method` edge function → `change_web_payment_method_atomic`
  (permission `confirm_payment`, reason required, audit `payment_method_changed`,
  refused while `cash_order_payment_lock` is set, Paidy/card never on a layaway
  or a peso order). On a confirmed order the customer is emailed again with only
  the new method.
- After Confirm the order page and the ready email show ONLY the chosen method:
  `paidyNotOfferedReason` / `cardNotOfferedReason` answer `method_not_chosen` on
  a web order whose method is another; `start_paidy_checkout_attempt` and
  `reserve_square_attempt` refuse the same in SQL; transfer methods are sent
  only when transfer is the method.
- **C2** layaway = transfer only (`web_order_drafts_layaway_transfer`).
  **C6** card/Paidy yen only; a peso quote greys both with the reason.
- **C3–C5 points.** 1 pt = ¥1. Full payment: at most the pieces subtotal (never
  shipping). Layaway: at most the deposit — the whole deposit is allowed.
  The draft holds a PENDING `new_order_discount` redemption
  (`loyalty_redemptions.web_draft_id`, `web_order_drafts.points_redemption_id`).
  `materialize_web_draft_atomic` links it to the new order and calls
  `approve_redemption_atomic` in the same transaction (LOYALTY- payment, loyalty
  basis netted, lots consumed). `approve_redemption_atomic` refuses a checkout
  redemption not yet linked (`web_draft_redemption`). `decline_web_draft_atomic`
  (staff decline or 72-hour expiry) cancels it — points kept.
- **Points are a discount, not money.** Every "nothing paid yet" check ignores
  LOYALTY- payments: Paidy start/file (`cash_order_points_paid`), the web-order
  lapse in `terminate_web_order_atomic`, and on a web layaway
  `layaway_deposit_started` (money arrived OR points cover the whole deposit) in
  expiry, reactivation, deadline moves, the payment reminder (amount = deposit −
  points) and `page365_web_holds`. The hourly sweep also finds deposits partly
  paid by points (`web_layaway_points_expiry_candidates`).
- **Loyalty award exception.** When points pay the WHOLE deposit (layaway) or
  the whole order (cash), no submission will ever arrive, so `confirm-web-draft`
  calls `award-loyalty-points` itself after Confirm (idempotent claims). A
  failure rings bell `loyalty_award_failed`.
- **Rule 9 kept.** Points spent on an order that later expires or is cancelled
  are not returned; only an admin void of the redemption returns them.

## Website API (see storefront `supabase/contracts/api.md`)

- Quote (POST/GET) adds `payment_options[]`, `payment_method`, `points{}`,
  `totals{}` — all Hub figures.
- `POST /checkout/quote/:id/choice` stores `{ payment_method, points }`.
- `POST /checkout/pay` takes `method` + `points` (re-checked in
  `create_web_draft_atomic`).
- Drafts, `GET /orders/:id` (`chosen_method`, `points_applied`) and
  `GET /layaway/:id` (`points_applied`, `deposit_due`).

## Hub screens

- Website order review: Payment section (method, points held), Points / To pay
  in the totals, **Change payment method**.
- Cash order (web, awaiting payment): "Customer chose …" + **Change payment
  method** (hidden while Paidy or a card hold is pending).

## Rejected payment → customer email (owner 2026-10-05)

Found in the Paidy live test: a Reject on a **cash order** (every website order)
emailed the customer nothing — review-payment-submission only emailed layaway
plans (its lookup reads layaway_accounts by account_id, null on a cash-order
submission; 22 cash rejections had gone silent). Paidy never emails a
cancellation itself (its 「ご利用の確認（未確定）」 email says so).

- ONE sender, `_shared/payment-rejected-email.ts` `sendCashPaymentRejectedEmail`
  — never throws, idempotent per submission (`payment-rejected-<id>`).
- Web order → storefront email `order-payment-not-accepted.tsx` (customer's
  language, JA then EN): Paidy "Paidy will not bill you", card "nothing was
  charged", transfer "upload the receipt again"; amount still owed, deadline,
  order link while the order is pending, "no longer open" otherwise.
- Hub cash order → the Hub `payment-rejected` template (as layaway plans get).
- Called from EVERY path that rejects a cash-order submission:
  reviewer Reject (kind `staff`, shows the reviewer's message — the Reject
  dialog says so); a Confirm that finds Paidy expired/closed or the card hold
  closed; `paidy-sync` (webhook / hourly check); `applyPaymentState` when the
  SQL rejected a waiting submission from a Square webhook / reconcile (kind
  `provider_ended`, never a message — those notes are internal English).
  `applyPaymentState` skips sources `void` / `review` / `capture` (their caller
  sends it).
- Test: development/payment-rejected-email.test.ts (CI).
