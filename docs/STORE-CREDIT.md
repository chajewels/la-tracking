# Store Credit (Phase A)

Live and verified end-to-end (2026-07-11). This documents the full feature; the
locked policy is mirrored as a short NON-NEGOTIABLE section in CLAUDE.md.

## PURPOSE

Store credit = money the customer has actually paid, returned to them as
spendable credit when a paid **cash** order is cancelled. It is also issuable
manually by an admin (goodwill / defect resolution).

## LOCKED POLICY (do not change without Cynthia's explicit instruction)

- **Money actually received only.** Store credit equals the money actually
  received on the order. Synthetic loyalty-redemption payments
  (`reference_number LIKE 'LOYALTY-%'`) are **excluded**. Example: a ¥100,000
  order with ¥20,000 paid by redeemed points and ¥80,000 cash → **¥80,000**
  store credit.
- **Redeemed loyalty points are NEVER returned** on cancellation. Permanent.
  Never re-raise.
- **Earned loyalty points ARE revoked** when the order is cancelled (via
  `revoke_loyalty_points`).
- **Store credit is REAL MONEY**: usable as a downpayment, an installment, or any
  partial payment on any OPEN order. It is a **payment method, NOT a discount** —
  `total_amount` is never modified (INVARIANT 7 intact); `total_paid` rises.
- **Store credit EARNS loyalty points when spent** (it funds the order like cash;
  points are computed from the order's `loyalty_jpy_amount`, so this happens
  naturally).
- **No currency conversion.** JPY credit can only pay a JPY order; PHP only PHP.
  Balances are tracked separately per currency and are never summed.
- **1-year validity** from issuance. Expiry = forfeiture.
- **Layaway NEVER auto-issues store credit.** Layaway downpayments are
  non-refundable; 3 months of non-payment = forfeiture, no credit. Layaway store
  credit is **manual-only** (admin issues it when the customer gives early
  notice). Cancellation auto-credit is **cash orders only**.
- **Lot model.** Each issuance is a LOT with its own expiry and remaining
  balance. Consumption is **FIFO by soonest expiry** first. Voiding a lot cancels
  ONLY the unspent remainder — any portion already applied to an order is a real
  payment and is NOT reversed.

## SCHEMA

`store_credit_lots`
- `id`, `customer_id`, `currency`, `original_amount`, `remaining_amount`
- `status store_credit_lot_status` (`active` | `consumed` | `expired` | `voided`)
- `source_type` (`cancelled_layaway` | `cancelled_cash` | `manual_admin`)
- `source_account_id`, `source_cash_order_id`, `rate_snapshot`, `notes`
- `issued_by_user_id`, `issued_at`, `expires_at`, `created_at`, `updated_at`

`store_credit_transactions`
- `id`, `customer_id`, `lot_id`
- `txn_type store_credit_txn_type` (`issued` | `redeemed` | `expired` | `voided` | `adjusted`)
- `amount`, `currency`, `account_id`, `cash_order_id`, `balance_after`, `notes`
- `performed_by_user_id`, `created_at`

**RLS:** admin ALL; staff/finance SELECT. **No customer-facing policy** — the
portal reads these through the `customer-portal` edge function on the
service-role key (same pattern as loyalty).

## RPCs

All `SECURITY DEFINER`; `REVOKE` from PUBLIC/anon/authenticated, `GRANT EXECUTE`
to `sandbox_exec`.

- **`issue_store_credit_atomic(...)`** — mints a lot (1-year expiry).
  Double-issue guard: a given source order can never mint credit twice.
- **`redeem_store_credit_atomic(...)`** — applies credit to an open order.
  **Layaway delegates to `allocate_payment_atomic`** (full DP/installment
  waterfall, schedule, INVARIANT 11) — it does NOT hand-roll the payment.
  **Cash inserts `cash_payments` directly** (no schedule exists). Payment
  ref = `SC-<uuid>`, `payment_method = 'store_credit'`. Auto-detects whether it
  is the downpayment. Supports `p_preview` and a partial `p_amount`.
- **`void_store_credit_lot_atomic(...)`** — voids the UNSPENT remainder of a lot.
- **`cancel_cash_order_atomic(...)`** — **cash only.** Computes money actually
  received, revokes earned points, issues credit, cancels the order. Payments are
  NOT reversed (`total_paid` never decreases).

## EDGE FUNCTIONS

Permission key in brackets.

- **`issue-store-credit`** [`issue_store_credit` — admin]
- **`redeem-store-credit`** [`redeem_store_credit` — admin/staff/finance]. Also
  calls `award-loyalty-points` after a successful redemption, mirroring
  `review-payment-submission`'s gates (cash → award when the order is now
  completed; layaway → award when the credit lands as the DP). **This is
  required:** the RPC writes payments directly and never passes through
  `review-payment-submission`, so without this call store credit would earn ZERO
  points.
- **`void-store-credit-lot`** [`void_store_credit` — admin]
- **`cancel-cash-order`** [`cancel_cash_order` — admin]

## UI

**Staff Hub:**
- `CustomerStoreCreditTab` — balance per currency, lots, history, admin Issue +
  Void.
- `IssueStoreCreditDialog`, `VoidStoreCreditDialog`.
- `ApplyStoreCreditCard` — mounted on `AccountDetail` + `CashOrderDetail`;
  self-hides when no credit is applicable in the order's currency.
- Cancel Order on `CashOrderDetail` — now allowed on **completed** orders, with a
  preview of the credit to be issued and the points to be revoked.

**Customer Portal:**
- `StoreCreditCard` on the Home tab — read-only: balance, soonest expiry with a
  30-day warning, recent history. Maison light theme, `.maison-portal` scope —
  never `.dark`.

## NOTIFICATIONS

- **Staff bell** (`staff_notifications`): `store_credit_issued`,
  `store_credit_redeemed`, `store_credit_voided`, `loyalty_revoked`. All name the
  customer and the invoice.
- **Customer portal** (`loyalty_notifications`, via `emitNotification` —
  member-scoped, NOT `customer_id`): "Points revoked" and "Store credit issued"
  on cancellation.
- **Not built:** no email is sent on points revocation or credit issuance. Only
  in-app.

## PHASE B — SHOPIFY CANCELLATION → STORE CREDIT

Built, shipped, and verified end-to-end on live Shopify orders (2026-07-11).

### What it does
Cancelling a paid order in Shopify now cancels the corresponding Hub cash order
and auto-issues store credit for the money actually received. Same locked policy
as a Hub-side cancellation: no cash refund, 1-year credit, earned points revoked,
redeemed points never returned, payments not reversed.

### How it works
- Shopify webhook topic `ORDERS_CANCELLED` is registered via
  `shopify-register-webhooks` (`TOPICS = ORDERS_CREATE, ORDERS_PAID,
  ORDERS_CANCELLED`). Registration is app-signed via GraphQL
  (`webhookSubscriptionCreate`) so the HMAC verifies — **NEVER hand-create a
  webhook in the Shopify admin UI**; it is signed with a different secret and
  will fail verification.
- `shopify-webhook` handles `orders/cancelled`: looks up `cash_orders` by
  `shopify_order_id`, then calls `cancel_cash_order_atomic` with
  `p_source = 'shopify_webhook'`. The webhook contains NO money logic — the RPC
  owns all of it.
- No Hub order found → 200 + ignored (no `shopify_webhook_events` row, so a retry
  can still succeed).
- RPC error → 500 so Shopify RETRIES.
- Already cancelled → the RPC returns `{ already_cancelled: true }` for system
  callers instead of raising, so Shopify retries are idempotent.

### Service-role caller pattern (p_source)
A webhook has no user, but every money movement is attributed. Both
`cancel_cash_order_atomic` AND `issue_store_credit_atomic` take
`p_source text DEFAULT 'staff'`. When `p_source = 'shopify_webhook'`, the
user-identity-required guard is skipped and the audit trail records
actor = `'shopify_webhook'` — an honest attribution, rather than falsely naming a
staff member. Human callers are unaffected: `p_source` defaults to `'staff'` and
the identity guard still fires.

### Operator rules (CRITICAL — tell anyone who can cancel Shopify orders, including Wonder)
- When cancelling an order in Shopify, under "Refund payments" ALWAYS choose
  **"Later"** (= no refund). The Hub issues the store credit automatically.
  - **"Original payment method"** = a real cash refund. The customer would get
    their money back AND Hub store credit — paid twice.
  - **"Store credit"** = SHOPIFY'S OWN store-credit ledger, which is a completely
    separate system from the Hub's: no expiry, invisible to the Hub, and it would
    double-compensate the customer. Do not use it.
- Shopify Settings → Customer accounts → "Self-serve returns and cancellations"
  must stay **OFF**. If customers could self-cancel, they would auto-mint Hub
  store credit with no staff review.

### Not in scope
- `refunds/create` (PARTIAL refunds) is NOT handled. Phase A/B only support
  full-order reversal. A partial refund in Shopify does nothing in the Hub.
  Policy undecided.
- Shopify cannot see Hub store credit. A customer with Hub credit shopping on
  cha-jewels.com is charged full price. Mirroring Hub credit into Shopify's
  native store-credit account is PHASE C (not built).
