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

## 0. PRE-FLIGHT — read before you start (measured 2026-09-15)

These are the real values in the database now. Two of them constrain how acceptance can
be run at all, and one of them corrects an expectation this script shipped with.

**STOCK, RE-MEASURED 2026-09-15 17:49 PHT — N4020 HAS MOVED:**

| SKU | product | price JPY | stock |
|---|---|---|---|
| R7828 | Ring 750 YG/WG Diamond 2.70ct | 679,980 | **1** |
| N4020 | Necklace Tiffany & Co. Open Teardrop | 72,980 | **3** (was 1; raised, and CJ-W-900012 already holds one) |
| R3341 | Ring K18WG Diamond 3.82ct | 628,980 | **0 — cannot be reserved** |

Three N4020 units plus one R7828 is enough for the remaining sections without raising stock
again. R7828 is the only ten-month fixture, and there is exactly one of it.

Sections A, B, E and F need **four** plans holding stock, and only two units exist. Either
raise `stock_qty` on N4020 to 4 in the Hub's Website Catalog before starting, or run the
sections strictly in order and reuse the unit that section E's expiry returns. Raising
stock first is far less error-prone.

**THE INTEGRITY REPORT ALREADY RETURNS ONE ROW, LEGITIMATELY.** Test Customer
(`CJ-2026-05088`) carries the deferred Bug #271 spend residue: stored 4,430,940 against an
expected 1,350,940, with 701,960 of that attributable to cancelled/forfeited orders still
counting. Its correction was explicitly deferred. Points are clean — counter, live lots and
ledger net all agree at 12,400. **Baseline this row before starting and compare against it
at the end; do not expect zero.**

**TEST CUSTOMER IS STEPPED DOWN, AND THAT IS NOT A BUG.** `earned_tier` Elite,
`current_tier` Radiant, `is_downgraded` true, `downgrade_spend_baseline` 4,430,940. Its last
purchase was 2026-09-14, so this is not fresh inactivity — it is a prior step-down that a new
purchase does not undo, because requalification is by spend (Elite needs 2,000,000 more since
baseline), never by recency. Expect a **Radiant ×2** multiplier on any points awarded during
acceptance, not Elite.

**OTHER MEASURED VALUES**

| what | value |
|---|---|
| web layaway accounts | 0 (nothing to confuse with a test plan) |
| `layaway_account_items` rows | 0 |
| existing web cash orders | 4 |
| `php_jpy_rate` | 0.42 |
| `loyalty_enabled` | true — awards WILL fire |
| Test Customer `is_test` | true — invoices auto-prefix `TEST-` |
| plan minimums | 3M none · 6M ¥25,000/₱10,500 · 8M ¥300,000/₱126,000 · 10M ¥600,000/₱252,000 · 12M ¥1,000,000/₱420,000 |

**THE SECTION D FIXTURE, PRECOMPUTED.** R7828 at ¥679,980 clears the 10M minimum
(¥600,000) but falls short of the 12M minimum (¥1,000,000). So ask for **12M on R7828**:
it must be refused with `below_plan_minimum`, carrying `max_term_months` and `allowed_terms`,
and must NOT silently become a shorter term. N4020 at ¥72,980 is the opposite fixture — it
clears 3M and 6M only, so 8M on N4020 is a second refusal case if you want one.

**THE SECTION B NUMBER, PRECOMPUTED — this is the one that fails without erroring.** If you
reserve **R7828 in pesos**, the peso settlement total is about **₱285,592** (679,980 × 0.42
on the product alone, before shipping). `loyalty_jpy_amount` on that account must read

>   **679,980**

the yen product subtotal. If it reads **285,592**, or anything in the ₱200–300k range, that
is the silent failure: a peso figure written into a yen column, which inflates or deflates
tier progress and never raises an error.

**EMAIL ROWS ARE AMBIGUOUS AGAIN (2026-09-15).** #53's skip logging is deployed but inert —
the `email_send_log` status check constraint rejects `'skipped'` and `email-log.ts` swallows
the rejection (Bug #272, fix in PR #61, not yet applied). So during acceptance a MISSING
`email_send_log` row does not distinguish "no email was attempted" from "a skip that could
not record itself". If an expected email does not appear, read the edge function logs
directly; do not infer from the absent row.

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
       transfer_due_at, expired_at,
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

## D. A term the basket cannot reach

**REWRITTEN 2026-09-15 — the expectation below was wrong, not the code.** The quote does
not refuse; it DOWNGRADES and says so. Run against the live database:

```
layaway_quote(679980, 12, 'JPY', …)   R7828 at ¥679,980, asking for 12 months
  eligible               true
  requested_term_months  12
  term_months            10          <- downgraded
  term_downgraded        true        <- and flagged, not silent
  max_term_months        10
  allowed_terms          3 ✓  6 ✓  8 ✓  10 ✓  12 ✗ (min ¥1,000,000)
```

There is no `below_plan_minimum` anywhere in `layaway_quote`. The refusal lives in
`create_web_layaway_atomic`, which is the writer — confirmed present in its body. So the
two functions do different jobs on purpose: the quote offers the best term it can and
labels the downgrade, the writer refuses what must not be written.

The storefront already surfaces it: `layaway-calculator.tsx` renders the 12M option
`disabled` with its minimum in the label, caps the selector at `max_term_months`, and shows
the "term unavailable" note whenever `term_downgraded` is true. A customer therefore cannot
request 12M at all.

| # | Step | Expected result |
|---|---|---|
| D1 | Product page for R7828 (¥679,980), open the term selector | 12M is present but **greyed out** and labelled with its ¥1,000,000 minimum; 10M is the highest selectable |
| D2 | Pick the highest term you can, then read the note under the figures | if a downgrade happened, the note says the term is unavailable — it never silently shows a different term as though you had asked for it |
| D3 | Reserve at the term the calculator allows | the plan is created at that term; `payment_plan_months` matches what the calculator showed |
| D4 | (Backstop, not reachable through the UI) `create_web_layaway_atomic` on a quote below the minimum | returns `below_plan_minimum` |

**N4020 is the second fixture**: at ¥72,980 it clears 3M and 6M only, so 8M shows
`term_downgraded: true` with `term_months: 6` and `max_term_months: 6`.

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
| G1 | Hub → a **web layaway** → Deadline card. Set `transfer_due_at` with a reason | saved; `audit_logs` action `deadlines_updated` with old value, new value and the reason. There is ONE field here: `settlement_due_at` was dropped 2026-09-15 (owner decision) and the card no longer offers it |
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
| H2 | `SELECT * FROM loyalty_integrity_report();` | **exactly ONE row, and it must be unchanged** — Test Customer `CJ-2026-05088`, `spend_stored` 4430940 vs `spend_expected` 1350940, `terminal_order_spend` 701960. This is the deferred Bug #271 correction, not an acceptance failure. A SECOND row, or any change to this row's numbers, is a failure. |
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
