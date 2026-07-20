# Pancake Integration — Complete Test Plan

**Branch:** `feat/pancake-process-events` @ `47b65cd` (16 commits)
**main:** `0dc1d5f` — untouched, nothing deployed
**Date:** 2026-07-19

> **Nothing in this integration is "done" until Section A and Section C pass.**
> Section A is testable now on the branch preview. Section B requires merge +
> deploy and therefore cannot be signed off beforehand. Section C is regression:
> non-Pancake paths must be provably unaffected.

---

## 0. Setup — pick your test orders

Run this first. It tells you what is available and in what state.

```sql
SELECT (raw_payload ->> 'system_id')::bigint      AS system_id,
       pancake_order_id,
       status,
       event_type,
       raw_payload ->> 'status_name'              AS pancake_status,
       (raw_payload ->> 'total_price')::numeric   AS total,
       (raw_payload ->> 'total_discount')::numeric AS discount,
       (raw_payload ->> 'shipping_fee')::numeric  AS shipping,
       jsonb_array_length(COALESCE(raw_payload -> 'items', '[]'::jsonb)) AS item_count,
       raw_payload ->> 'bill_email'               AS email,
       received_at
FROM pancake_events
ORDER BY 1 DESC;
```

Pick from the results:

| Need | Look for |
|---|---|
| Simple order | `status='pending'`, `item_count=1` |
| Multi-item | `item_count >= 2` |
| Discount/shipping | `discount > 0` OR `shipping > 0` |
| Unmatched customer | `email` NULL, or an email not in `customers` |
| Cancelled | `pancake_status` = cancelled / status code 6 |

If a case has no matching order, **create one in Pancake POS** rather than
skipping it. Several of these have never been exercised even once.

**To re-test a consumed order**, reset it:

```sql
UPDATE pancake_events SET status = 'pending'
WHERE pancake_order_id = '<ORDER_ID>' AND status = 'processed';
```

⚠️ Every confirmation creates a **real** cash order or layaway account. Use a
test customer or delete afterwards. Note that deleting a cash order with line
items may be blocked by the `cash_order_items` FK — delete the items first.

---

## A. Pre-merge — testable now on the branch preview

### A1. Holding area lists correctly
**Why:** the entry point for everything else.

1. Open `/sales`, first tab.
2. Compare against the setup query.

**Expected:** every `pending` order with items AND `total_price > 0` appears
exactly once, even if it has multiple events. Orders that are `skipped`,
`processed`, cancelled, itemless or zero-total do **not** appear.

- [ ] Pass / Fail: ______

---

### A2. Toggle behaviour
**Why:** replaced the two-button version; never tested.

1. On any card, observe the Confirm button before choosing.
2. Tap **Cash**, then **Layaway**.

**Expected:** Confirm reads *"Select type"* and is **disabled** initially.
Tapping a segment highlights it and Confirm becomes enabled, reading *"Confirm
as Cash"* / *"Confirm as Layaway"*. Selection on one card does not affect
another card.

- [ ] Pass / Fail: ______

---

### A3. PAID badge
**Why:** display-only surface for a prepaid order.

1. Find an order with `prepaid > 0` or `bank_payments` populated.

**Expected:** green `PAID ¥<amount> (bank)` badge next to the total. Amount
equals `prepaid`, **not** `prepaid + bank_payments` (they are the same money).
Unpaid orders show no badge.

- [ ] Pass / Fail: ______

---

### A4. Cash path — full hydration ⚠️ partially done
**Why:** the only path exercised so far.

1. Confirm a single-item order as **Cash**.

**Expected on the form:**
- Invoice = `PKE-0NN` (zero-padded `system_id`, e.g. `PKE-070`)
- Amount = `total_price`
- One line item, correct title/qty/price
- Customer populated if matchable

- [ ] Pass / Fail: ______

---

### A5. LAYAWAY path — full hydration ❗ NEVER TESTED
**Why:** half the system. Completely unexercised with hydrated data.

1. Confirm an order as **Layaway**.
2. Complete plan selection, downpayment, and submit.

**Expected:**
- Invoice, amount, items, customer all hydrate as in A4
- Plan-month selection works normally
- Downpayment validation behaves normally
- Plan minimum enforcement unchanged
- Installment schedule generates correctly
- Account created; ledger rows flip to `processed`

**Verify:**
```sql
SELECT invoice_number, total_amount, downpayment_amount, status, customer_id
FROM layaway_accounts WHERE invoice_number = 'PKE-0NN';

SELECT count(*) FROM layaway_account_items
WHERE account_id = (SELECT id FROM layaway_accounts WHERE invoice_number = 'PKE-0NN');
```

- [ ] Pass / Fail: ______

---

### A6. Loyalty gate ❗ NEVER CONFIRMED
**Why:** the only loyalty behaviour this work changed. Hydration sets
`customerId`, which must make `useCustomerLoyaltyTier` fire.

> Note: loyalty point **awarding** is unchanged — `award-loyalty-points` is
> invoked only from `shopify-webhook`. Pancake orders behave exactly like
> manual orders. Only the *required-field gate* is in scope here.

1. Confirm an order whose customer is a **loyalty member** (e.g. CYNTHIA LARGO).
2. Observe the Loyalty Product Amount field.
3. Try to submit leaving it blank.

**Expected:** the field becomes **required**; submitting blank is blocked with
the tier-named message. Repeat on both cash and layaway.

- [ ] Cash Pass / Fail: ______
- [ ] Layaway Pass / Fail: ______

---

### A7. Multi-item order ❗ NEVER TESTED
**Why:** settles the outstanding `total_price` reconciliation question.

1. Create a Pancake order with **2+ different products**.
2. Confirm it.

**Expected:** every line hydrates with correct qty and price. Record whether
`total_price` equals the sum of lines (+shipping −discount).

**If they differ, STOP and report the numbers** — that changes which field is
authoritative.

- [ ] Pass / Fail: ______  Line sum: ______  total_price: ______

---

### A8. Discount and shipping ❗ NEVER TESTED
**Why:** every order so far had free shipping and zero discount.

1. Create a Pancake order with a discount **and** a shipping fee.
2. Confirm it.

**Expected:** Discount field = `total_discount`, mode `amount`. Shipping field =
`shipping_fee`. Total stays `total_price` and is **not** recomputed from items.

- [ ] Pass / Fail: ______

---

### A9. Item matching — matched
**Why:** title matching is the only viable key (barcode is unusable).

1. Confirm an order whose product title exactly matches a Hub product.

**Expected:** line item shows the **catalog image**, and **no** unmatched
warning appears.

- [ ] Pass / Fail: ______

---

### A10. Item matching — unmatched
1. Confirm an order with a product not in the Hub (e.g. "Sample Product").

**Expected:** line item appears with Pancake's title and price, no image, and
a warning: *"N Pancake item(s) not matched…"*.

**Verify `product_id` is NULL, not a fake value:**
```sql
SELECT title, product_id, unit_price_jpy, quantity FROM cash_order_items
WHERE cash_order_id = (SELECT id FROM cash_orders WHERE invoice_number = 'PKE-0NN');
```

- [ ] Pass / Fail: ______

---

### A11. Item matching — ambiguous title
**Why:** two duplicate titles exist; must fall back, never guess.

1. Create a Pancake order using `N3903 Necklace SV925 Akoya Pearl 8.3-8.7mm 43cm [Preloved]`
   or `PPS13 Earrings K18 Natural Golden South Sea Pearl 13.0mm Stud`.

**Expected:** treated as **unmatched** — warning shown, `product_id` NULL.
Must **not** silently attach to either duplicate.

- [ ] Pass / Fail: ______

---

### A12. Customer matching — matched by email ⚠️ done once
**Why:** two live customers share phone `07083073318`; email must win.

**Expected:** *"Matched existing customer: CYNTHIA LARGO"*, customer field
populated. **Must not** match "Test Customer".

- [ ] Pass / Fail: ______

---

### A13. Customer matching — no match ❗ NEVER TESTED
1. Confirm an order whose `bill_email` is absent or unknown to the Hub.

**Expected:** warning *"No unique customer match…"*. Name pre-filled in the
search box, customer **not** selected. **No customer is created automatically.**

**Verify no customer was created:**
```sql
SELECT count(*) FROM customers WHERE created_at > now() - interval '10 minutes';
```

- [ ] Pass / Fail: ______

---

### A14. Ledger closure ⚠️ done once
**Expected:** after creation, **all** rows for that order read `processed`.

```sql
SELECT pancake_order_id, status, event_type FROM pancake_events
WHERE pancake_order_id = '<ORDER_ID>' ORDER BY received_at DESC;
```

- [ ] Pass / Fail: ______

---

### A15. Processed orders stay hidden
1. After A14, return to `/sales`.

**Expected:** the confirmed order is **gone** and does not return after refresh,
even when Pancake emits later updates for it.

- [ ] Pass / Fail: ______

---

### A16. Cancelled order excluded ❗ NEVER TESTED
1. Cancel an order in Pancake POS (status 6). Wait for the event.

**Expected:** does **not** appear in the holding area.

- [ ] Pass / Fail: ______

---

### A17. Non-JPY currency warning
1. If an order has `order_currency` other than JPY.

**Expected:** warning toast *"Pancake order currency is X, not JPY…"*.
Skip if unreproducible — the shop is JPY-only.

- [ ] Pass / N/A: ______

---

## B. Post-deploy — CANNOT be signed off before merge

These depend on deployed edge functions. **Written but never executed.**

### B1. `pancake_order_id` persists ❗ HIGHEST RISK
**Why:** the entire double-confirmation protection now rests on this column.

```sql
SELECT invoice_number, pancake_order_id, source_channel, total_paid, status
FROM cash_orders WHERE invoice_number = 'PKE-0NN';
```

**Expected:** `pancake_order_id` = the long order id (**not** the system_id),
`source_channel` = `pancake`.

- [ ] Pass / Fail: ______

---

### B2. Layaway `pancake_order_id` persists
```sql
SELECT invoice_number, pancake_order_id FROM layaway_accounts
WHERE invoice_number = 'PKE-0NN';
```
**Expected:** populated. `layaway_accounts` has **no** `source_channel` column.

- [ ] Pass / Fail: ______

---

### B3. Double confirmation is blocked
1. Reset an order to `pending` **after** it has already created an order.
2. Confirm it a second time.

**Expected:** creation **fails** on the `pancake_order_id` partial unique index
(or the invoice unique constraint), with a clear message. No duplicate row.

- [ ] Pass / Fail: ______

---

### B4. Invoice pre-fill resolves via `system_id`
1. Open the created order → Generate Invoice.

**Expected:** pre-fills from the Pancake ledger. `PKE-069` must resolve via
`system_id`; the older `PKE-10881693605` must still resolve via the fallback.

- [ ] Pass / Fail: ______

---

### B5. Shop guard rejects foreign shops
**Expected:** an event with a different `shop_id` returns 200 with
`skipped: "wrong_shop"` and writes **no** ledger row. Legitimate events from
shop `5226933` continue to be captured (coercion works — number vs string).

- [ ] Pass / Fail: ______

---

### B6. Receiver still captures after deploy
**Expected:** a new Pancake order still lands in `pancake_events`. Confirms the
guard didn't break the live path.

- [ ] Pass / Fail: ______

---

## C. Regression — non-Pancake paths must be unaffected

**These are the highest-blast-radius checks.** `create-cash-order` and
`create-layaway-account` serve every creation path.

### C1. Manual cash order (no Pancake params)
1. `/cash-orders/new` directly.

**Expected:** blank invoice, no toasts, **no** query to `pancake_events`,
`source_channel` unchanged (`hub_manual` / `social_manual`).

- [ ] Pass / Fail: ______

---

### C2. Manual layaway
**Expected:** identical to before. Plan minimums, DP, installments unchanged.

- [ ] Pass / Fail: ______

---

### C3. Catalog picking (the `row_key` refactor)
1. Add two catalog products, change a quantity, remove one.

**Expected:** identical behaviour to before. Removing one row must not remove
the other. `product_id` written correctly for picked products.

- [ ] Pass / Fail: ______

---

### C4. CA bot creation
1. Create an account via the CA command modal.

**Expected:** URL params still seed name/amount/currency/plan/notes. No Pancake
hydration fires.

- [ ] Pass / Fail: ______

---

### C5. Shopify auto-create still works
1. Place a test Shopify order.

**Expected:** cash order auto-created as before with `shopify_order_id` and
`source_channel = shopify_direct`. Store credit, refunds and loyalty unaffected.

- [ ] Pass / Fail: ______

---

### C6. Page365 invoice pre-fill unchanged
1. Generate an invoice on a non-`PKE-` account.

**Expected:** routes to `get-page365-order` exactly as before.

- [ ] Pass / Fail: ______

---

## D. Known gaps — NOT tested, accepted as open

Not defects. Documented so they aren't mistaken for passing tests.

| # | Gap | Impact |
|---|---|---|
| D1 | **Payment sync Hub → Pancake** not built (Stage 2) | Order paid in the Hub still shows unpaid in the POS. Manual reconciliation. |
| D2 | **Shopify dedupe** (§7.3) deferred | A Shopify sale reaching Pancake can appear in the holding area alongside the auto-created order. Fails safe on the invoice constraint. |
| D3 | **`extractOrderId` fallback** | Missing `order_link` stores a bare `system_id` in the same column as long ids. Never observed. |
| D4 | **Product mirror never prunes** | Deleted Shopify products persist in the Hub and stay pickable. Pre-existing. |
| D5 | **Product deletion vs order history** | `*_items.product_id` is an FK to `products`; deleting a product is constrained by past orders. |
| D6 | **Inventory writeback** | Deliberate — the Hub never writes inventory. Pancake ↔ Shopify handle it natively. |
| D7 | **Loyalty awarding** | Only auto-invoked from `shopify-webhook`. Pancake orders follow the manual path, unchanged. |
| D8 | **Status codes** | Only 0 / 1 / 6 observed. Others unmapped; `status_name` is the reliable label. |

---

## Sign-off

| Section | Cases | Must pass before |
|---|---|---|
| A — pre-merge | A1–A17 | **MERGE** |
| C — regression | C1–C6 | **MERGE** (C5/C6 need deploy for full coverage) |
| B — post-deploy | B1–B6 | **Declaring the integration live** |

**Merge blockers:** A5 (layaway), A6 (loyalty gate), A7 (multi-item),
A8 (discount/shipping), A11 (ambiguous title), A13 (no-match customer),
A16 (cancelled) — none has ever been run.

Tester: ____________  Date: ____________
