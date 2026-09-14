# Phase 2 step 4 — web layaway acceptance script

**Run this before any real customer creates a web layaway.** Nothing in step 4 has ever
executed against a real database. The RPCs create accounts, decrement stock, cancel plans
and return stock; they have been read, typechecked and reasoned about, but not *run*.
Treat every first execution here as a live test.

- **Where:** the `develop` Firebase preview channel, against the live Supabase project
  (there is no separate database — this is why Test Customer matters).
- **Who:** every account under Test Customer (`4201767c-54e6-48d0-8c9e-c1b3c07a931e`,
  `is_test = true`), so `enforce_test_invoice_prefix()` stamps `TEST-` on every invoice
  and nothing reaches a financial dashboard.
- **Prerequisite:** the four migrations of this release are applied (Lovable message E)
  **and** the 29 edge functions are deployed (message F). Running this against a
  half-deployed fleet proves nothing.
- **Division of labour:** Cynthia drives the UI and the storefront. Claude Code runs the
  SQL checks in the right-hand column and reports. Nothing here writes to a real
  customer's account.

Record the result beside each row. **Any ✗ stops the release of step 4 to real traffic** —
the rest of the release (loyalty, email) is independent and can stand.

---

## A. Yen plan — the baseline

| # | Step | Expected result |
|---|---|---|
| A1 | Storefront, Test Customer signed in, currency **JPY**. Add one in-stock piece. Note its `stock_qty` first. | — |
| A2 | `POST /layaway/quote` for the basket, term 6M | `eligible: true`, `term_downgraded: false`, a 6-row schedule |
| A3 | `POST /checkout/quote` with `mode: "layaway"`, `term_months: 6` | 200, a `checkout_quotes` row, `settlement_currency = 'JPY'` |
| A4 | `POST /checkout/pay` on that quote | 200, a `layaway_accounts` row created |
| A5 | **Account row** | `source_channel = 'web'`, `web_reference` matches `CJ-W-\d{6}`, `quote_id` set, `customer_lang` set, `expired_at` NULL, `transfer_due_at` ≈ now + 72h |
| A6 | **Deposit** | `downpayment_amount` = **30% of the total** (product + shipping + services), not 30% of the product alone |
| A7 | **Schedule, to the yen** | Every `base_installment_amount` and `due_date` identical to what the Hub's own preview produces for the same figures. Instalment 1 is order month **+ 1**, never the order month |
| A8 | **Item lines** | One `layaway_account_items` row per basket line, `variant_id` and `quantity` correct |
| A9 | **Stock held** | `website_product_variants.stock_qty` decremented by exactly the quantity ordered, **once** |
| A10 | **`total_paid`** | `0`. A new plan never starts paid |
| A11 | **Customer email** | "layaway plan created" received, in the customer's language, quoting the `CJ-W-` reference — *not* the invoice number |

```sql
-- A5–A10 in one pass
SELECT invoice_number, web_reference, source_channel, customer_lang,
       currency, total_amount, downpayment_amount, total_paid,
       round(downpayment_amount / NULLIF(total_amount,0) * 100, 2) AS deposit_pct,
       transfer_due_at, settlement_due_at, expired_at,
       fx_rate_used, fx_rate_date, loyalty_jpy_amount
  FROM layaway_accounts WHERE web_reference = 'CJ-W-XXXXXX';

SELECT installment_number, due_date, base_installment_amount, total_due_amount, status
  FROM layaway_schedule WHERE account_id = '<id>' ORDER BY installment_number;

SELECT i.variant_id, i.quantity, v.stock_qty
  FROM layaway_account_items i JOIN website_product_variants v ON v.id = i.variant_id
 WHERE i.account_id = '<id>';
```

## B. Peso plan — the one that fails silently

**This is the highest-risk check in the script.** A peso total written into
`loyalty_jpy_amount` inflates the customer's tier progress and *nothing errors*. It would
be found months later, as a wrong tier.

| # | Step | Expected result |
|---|---|---|
| B1 | Repeat A1–A4 with currency **PHP** | plan created |
| B2 | **FX recorded** | `fx_rate_used` and `fx_rate_date` both non-NULL on the account; `checkout_quotes.fx_rate` matches |
| B3 | **`loyalty_jpy_amount` IS STILL IN YEN** | equals the quote's **yen product subtotal** (less any points redeemed). It must be in the same order of magnitude as the yen plan in A, **not** ~3.4× smaller or larger. A peso figure here is a ✗ |
| B4 | **Parts sum exactly** | shipping converted + subtotal = the peso settlement total, to the centavo — no rounding gap |
| B5 | **Currency** | `currency = 'PHP'`, every schedule row in pesos |

```sql
-- B3: the check that matters. Compare against the yen plan from section A.
SELECT web_reference, currency, total_amount, loyalty_jpy_amount,
       fx_rate_used, fx_rate_date,
       round(total_amount / NULLIF(fx_rate_used,0)) AS total_converted_to_jpy
  FROM layaway_accounts
 WHERE web_reference IN ('CJ-W-<yen>', 'CJ-W-<peso>');
-- loyalty_jpy_amount must look like a YEN product subtotal on BOTH rows.
```

## C. Deposit, confirmation, and the points

| # | Step | Expected result |
|---|---|---|
| C1 | Customer portal: submit the deposit **with proof** against the yen plan | `payment_submissions` row, `status = 'submitted'`, `proof_url` set |
| C2 | Submit without proof | **400** "Proof of payment is required" — no row created |
| C3 | Hub → Submissions, confirm it | `status = 'confirmed'`, one `payments` row, `total_paid` rises |
| C4 | **Points awarded** | one `loyalty_transactions` row `transaction_type = 'earned'`, `spend_amount_jpy` = the **yen** `loyalty_jpy_amount`, one `loyalty_point_lots` row |
| C5 | **Points on the peso plan too** | same shape, `spend_amount_jpy` still the yen figure — a peso basis here is a ✗ |
| C6 | **Confirmation email** | payment-received email quoting the `CJ-W-` reference |
| C7 | **DP does not allocate** | no `payment_allocations` rows against schedule for the deposit (INVARIANT 11), unless it exceeded `downpayment_amount` |

```sql
SELECT t.transaction_type, t.points_amount, t.spend_amount_jpy, t.invoice_number, t.tier_at_time
  FROM loyalty_transactions t JOIN loyalty_members m ON m.id = t.member_id
 WHERE m.customer_id = '4201767c-54e6-48d0-8c9e-c1b3c07a931e'
 ORDER BY t.created_at DESC LIMIT 10;
```

## D. A term the basket cannot reach is REFUSED

| # | Step | Expected result |
|---|---|---|
| D1 | Basket below the 12M minimum (¥1,000,000 / ₱420,000). `POST /checkout/quote` with `term_months: 12` | **409 `below_plan_minimum`**, carrying `max_term_months` and `allowed_terms` |
| D2 | **Not silently downgraded** | no `checkout_quotes` row is created, and no plan appears at a shorter term |
| D3 | Storefront UI | shows the allowed terms and asks the customer to pick again — it does not choose for them |
| D4 | Force it at pay time (a stale quote whose basket has shrunk) | `create_web_layaway_atomic` returns `below_plan_minimum` — the same answer as the quote endpoint |

## E. The expiry sweep

| # | Step | Expected result |
|---|---|---|
| E1 | Create a **second** yen plan. Do **not** pay it. Note the variant's `stock_qty` | plan `active`, stock held |
| E2 | Move its deadline into the past — Hub → Deadlines card, or `set_account_deadlines` | `transfer_due_at` in the past |
| E3 | Wait for `auto-expire-cash-orders` (hourly at :40 UTC) or invoke it once | — |
| E4 | **Plan cancelled** | `status = 'cancelled'`, `expired_at` stamped |
| E5 | **Schedule cancelled** | every `pending` / `overdue` row → `cancelled` |
| E6 | **Stock returned, once** | `stock_qty` back to its E1 value — not more. Run the sweep a second time and confirm it does **not** rise again |
| E7 | **Audit row** | `audit_logs` action `web_layaway_expired`, carrying `stock_lines_restored` and `schedule_rows_cancelled` |
| E8 | **Customer email** | says nothing was paid and nothing is owed |
| E9 | A plan that **has** a deposit is refused | `already_paid` or `payment_exists` — never expired |

```sql
-- E4–E7
SELECT status, expired_at, total_paid FROM layaway_accounts WHERE id = '<id>';
SELECT status, count(*) FROM layaway_schedule WHERE account_id = '<id>' GROUP BY status;
SELECT action, new_value_json FROM audit_logs
 WHERE entity_id = '<id>' AND action = 'web_layaway_expired';
-- E6 idempotency: note stock_qty, run the sweep again, re-read it. Must be unchanged.
```

## F. INVARIANT 12 — an unreviewed submission freezes automation

| # | Step | Expected result |
|---|---|---|
| F1 | Create a **third** yen plan. Submit a deposit with proof. **Do not review it** | `payment_submissions.status = 'submitted'` |
| F2 | Push `transfer_due_at` into the past | — |
| F3 | Run the sweep | `expire_web_layaway_atomic` returns **`submission_pending`**. The plan stays `active`, `expired_at` stays NULL, stock stays held |
| F4 | Now **reject** the submission, run the sweep again | it expires normally — the freeze is on automation, not on people |

This is the case where the money may already be in the bank and only the reviewer knows.
A plan expiring out from under a pending submission strands a real payment.

## G. Deadlines — set and extended, on both order types

| # | Step | Expected result |
|---|---|---|
| G1 | Hub → a **web layaway** → Deadlines card. Set `transfer_due_at` and `settlement_due_at` with a reason | both saved; `audit_logs` action `deadlines_updated` with old value, new value and the reason |
| G2 | Extend the same layaway to a later date | accepted while the plan is **live** (`active` / `overdue` / `extension_active` / `reactivated`) |
| G3 | Try it on a **cancelled or expired** plan | `not_live` — an expired order is never revived; a returning customer gets a fresh order |
| G4 | Hub → a **cash order** → set the deadline | `transfer_due_at` **and** `expires_at` both written to the same value. The hourly cron reads `expires_at`; a customer must never see a deadline the cron does not act on |
| G5 | No reason given | refused — every deadline move is audited with a reason |
| G6 | A non-`edit_account` role tries it | 403 from `set-account-deadlines` |

```sql
SELECT entity_type, action, old_value_json, new_value_json, performed_by_user_id, created_at
  FROM audit_logs WHERE action = 'deadlines_updated' ORDER BY created_at DESC LIMIT 5;

-- G4: the two must agree on a cash order
SELECT invoice_number, transfer_due_at, expires_at FROM cash_orders WHERE id = '<id>';
```

## H. Clean-up and final state

| # | Step | Expected result |
|---|---|---|
| H1 | Every account created here carries a `TEST-` invoice | `invoice_number !~ '^[0-9]+$'` — none of it reaches a dashboard |
| H2 | `SELECT * FROM loyalty_integrity_report();` | **zero rows** |
| H3 | Stock levels back where they started for every expired plan | matches the pre-test reading |
| H4 | Finance Overview and the Dashboard KPIs | unchanged by this test |

```sql
SELECT invoice_number, source_channel, status, total_paid
  FROM layaway_accounts
 WHERE customer_id = '4201767c-54e6-48d0-8c9e-c1b3c07a931e'
 ORDER BY created_at DESC;

SELECT * FROM loyalty_integrity_report();   -- expect zero rows
```

---

## Sign-off

| Section | Result | Notes |
|---|---|---|
| A — yen plan | | |
| B — peso plan, loyalty in yen | | |
| C — deposit, confirm, points | | |
| D — term refused, not downgraded | | |
| E — expiry sweep | | |
| F — INVARIANT 12 | | |
| G — deadlines | | |
| H — clean-up | | |

Step 4 goes to real traffic only when every row is ✓.
