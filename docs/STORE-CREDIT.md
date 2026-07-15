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
- Partial refunds are now handled via the orders/updated flow — see
  "Partial refunds (Shopify)" under Phase C below.
- Shopify cannot see Hub store credit. A customer with Hub credit shopping on
  cha-jewels.com is charged full price. Mirroring Hub credit into Shopify's
  native store-credit account is PHASE C (now built — see below).

## PHASE C — HUB ↔ SHOPIFY STORE-CREDIT SYNC

Built, shipped, and verified end-to-end on live Shopify orders (2026-07-13).

### What it does
The Hub's store credit is now mirrored into Shopify's native store-credit
account, so a customer can spend it at Shopify checkout. When they do, the Hub
records it correctly and draws down its own lots.

### The model (locked)
The HUB MINTS. SHOPIFY MIRRORS. Authority is one-way; sync is bidirectional.
- Every Hub credit movement (issue / redeem / void / cancellation) is pushed to
  Shopify.
- A spend at Shopify checkout is pulled back into the Hub, which draws down its
  lots.
- Shopify NEVER mints credit. Its balance is a mirror, not a source.
Reason: if both could mint, we would inherit Shopify's rules — no expiry, no lot
model, no FIFO, no source tracking, no audit. The Hub's 1-year expiry policy
would quietly stop applying.

### Customer linkage (C0)
`public.customers.shopify_customer_id` (text, unique partial index where not
null). The Hub's `customer_code` remains the primary identity; this is a LINK to
the Shopify identity. Many Hub customers legitimately have NO Shopify ID
(live-selling / layaway / PHP customers). `shopify-webhook` match chain:
`shopify_customer_id` → email → phone → create-and-flag. The webhook backfills
`shopify_customer_id` onto customers matched by email/phone (never overwrites an
existing link).

### How a Shopify checkout spend reaches the Hub
- Shopify DEBITS the customer's balance at CHECKOUT (orders/create), not at
  payment.
- So `applyShopifyStoreCredit()` runs in BOTH orders/create AND orders/paid —
  whichever sees the transaction first. Idempotent via the unique reference
  `SHOPIFY-SC-<orderId>`.
- It records the store-credit portion as a `cash_payments` row with
  `payment_method = 'store_credit'` (money that did NOT arrive), and draws down
  the Hub's lots FIFO via `consume_store_credit_for_shopify_atomic`.
- Real-money transactions are recorded separately, one row per gateway.
- Order totals are then RECOMPUTED from the payment rows — never assumed.

### RPCs (added in Phase C)
- `consume_store_credit_for_shopify_atomic(...)` — a spend ALREADY happened in
  Shopify; draw the Hub's lots down to match. Does NOT create a payment and does
  NOT touch the order. Tolerates a SHORTFALL (Shopify credit the Hub never
  issued): consumes what exists, records the shortfall, never fails — the money
  has already moved in Shopify.

### Edge functions (added in Phase C)
- `sync-store-credit-to-shopify` — pushes a Hub movement into Shopify
  (`storeCreditAccountCredit` / `storeCreditAccountDebit`). Called by
  `issue-store-credit`, `cancel-cash-order`, `redeem-store-credit` and
  `void-store-credit-lot` AFTER their RPC succeeds. SKIPS silently for non-JPY
  currency (the Shopify store is JPY-only; PHP credit stays Hub-only) and for
  customers with no `shopify_customer_id`. A Shopify failure NEVER fails the Hub
  operation — it records a row in `store_credit_shopify_sync` and returns 200.
  NOTE: `shopify-webhook` is deliberately NOT wired to it. When a customer spends
  at Shopify checkout, Shopify has ALREADY debited its own balance; pushing a
  debit there would DOUBLE-DEBIT.
- `reconcile-store-credit` — REPORT-ONLY drift detector (see below).

### Tables (added in Phase C)
- `store_credit_shopify_sync` — every push attempt: direction, amount, status
  (pending|synced|failed|skipped), `shopify_transaction_id`, `error_detail`.
  Makes a failed push visible and retryable instead of silent.
- `store_credit_reconciliation` — one row per customer per run: `hub_balance`,
  `shopify_balance`, `delta`, status (match|drift|shopify_unreadable).

### C4 — Drift detection
`reconcile-store-credit` compares, for every customer with a
`shopify_customer_id`, the Hub balance (active, unexpired JPY lots) against the
Shopify balance (`storeCreditAccounts` query), and records the delta. It also
surfaces pending/failed rows in `store_credit_shopify_sync`.
Runs nightly via pg_cron (`reconcile-store-credit-daily`, 18:15 UTC / 03:15 JST).
Visible at Settings → Store Credit in the Hub.
IT REPORTS. IT DOES NOT REPAIR — deliberately. Over the course of this build the
"correct" side was the Hub in some cases and Shopify in others; an auto-repair
would have destroyed correct data and masked the underlying bug. Drift is a
SYMPTOM. A human must diagnose the cause.

### Operator rules (CRITICAL — tell anyone who touches Shopify orders)
- NEVER record store credit in Shopify directly. The "Store credit" option in
  Shopify's cancel-order dialog is SHOPIFY'S OWN separate credit ledger — no
  expiry, invisible to the Hub. Using it double-compensates the customer. Always
  cancel with "Later" (no refund).
- NEVER use "Collect payment" in the Shopify admin on an order that used store
  credit at checkout. It ignores the applied credit and charges the FULL order
  total, so the customer pays twice over. Use "Capture payment" instead, which
  settles what was actually authorised.
- NEVER issue / void / redeem store credit via SQL now that the sync is live. The
  Shopify push lives in the EDGE FUNCTIONS, not in the RPCs — calling an RPC
  directly bypasses the sync and silently drifts the two ledgers. Always use the
  Hub UI.

### Partial refunds (Shopify)
Policy LOCKED 2026-07-14: ALL reversals become Hub store credit; there are no
cash refunds. Partial refunds ride the orders/updated payload's `refunds[]`
array (the `refunds/create` topic is NOT registered — not needed).

Flow per refund:
1. Real-money gate — any successful positive transaction on the refund means
   real cash left via a gateway = policy violation → no mint +
   `shopify_cash_refund_detected` staff notification.
2. `mintAmount = min(sum refund_line_items.subtotal, headroom)` where
   `headroom = max(0, paid - newTotal - credit already issued for this order's
   partials)`.
3. `issue_store_credit_atomic` (source_type `'shopify_partial_refund'`,
   `p_source_refund_id` = Shopify refund id — DB-level per-refund idempotency).
4. `sync-store-credit-to-shopify` push (Hub mints, Shopify mirrors).
5. `shopify_partial_refund_credit` staff notification. Loyalty points are
   AUTO-ADJUSTED on partials (2026-07-15) via revoke_loyalty_points_partial:
   lot-level revoke-and-replace — the active order_earn lot for the invoice
   is revoked and replaced with a lot recomputed on the reduced spend basis
   using the lot's own effective multiplier
   (entitled = round(new_units × original / old_units)); earned_at/expires_at
   preserved (no expiry reset); consumed/redeemed points stay consumed
   (rule 9); member counters and tier recomputed with downgrade flag; one
   'revoked' transaction carrying the Shopify refund id. promo_bonus lots
   deliberately untouched on partials (policy 2026-07-15). No-ops cleanly
   when no member or no active lot. Iterative: each partial recomputes from
   the current replacement lot. Full cancel sweeps the replacement via the
   existing all-or-nothing revoke_loyalty_points. Idempotency piggybacks the
   per-refund store-credit mint (adjust runs only on a fresh mint). Webhook
   call is non-blocking; on RPC failure the staff notification carries a
   manual-review line. Verified live 2026-07-15 on SH-1017:
   2400 -> 1800 -> 1300 -> swept, clocks preserved.

Unpaid orders: zero headroom → re-sync only, no credit (policy).

`cancel_cash_order_atomic` now nets out partial-refund credit: a full cancel
after partials mints money_received minus non-voided `shopify_partial_refund`
lots, so total credit per order never exceeds money actually received
(verified: SH-1015 293,960 = 134,980 + 158,980).

Verified live 2026-07-14 on SH-1015/SH-1016: single partial, multi-partial
shared headroom, idempotent re-fires, real-cash gate, capped full cancel,
cancelled-branch mirror, zero-total guard.

### Not in scope
- PHP store credit is never mirrored (the Shopify store is JPY-only).
