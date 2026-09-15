# Phase 2 — Accounts, checkout and payments (transfer-only)

Status: steps 1–2 BUILT, step 3 DEFERRED (owner decision 2026-09-13), step 4 BUILT and awaiting review (2026-09-14), step 7 added 2026-09-13.
**THIS FILE IS THE SOURCE OF TRUTH.** `cha-jewels-web` `docs/tasks/phase2-plan.md`
is its mirror; edit here first, then mirror there. Live-schema checks are recorded
here because the Hub is where the schema lives.

> **Owner decision 2026-09-13 — step 3 (Square) is DEFERRED, not deleted.**
> The payment need is met by CSR-confirmed bank / GCash transfer. Transfer methods
> are editable in Hub Settings → Payment Methods (table `transfer_payment_methods`,
> migration `20260911170000`), served region-scoped by the `website` function
> (`transferMethods()`, index.ts:339) and rendered by the storefront's
> `TransferDetails` cards. Deferred WITH step 3, and to stay in this plan marked
> deferred until an owner decision revives them: card-on-file, `layaway_autocharge`,
> `square_webhook`, `customer_cards`, `layaway_accounts.square_card_on_file`,
> `cash_orders.square_payment_id`, `NEXT_PUBLIC_SQUARE_*`, Apple Pay / Google Pay.
> Every "(deferred)" mark below points here.

> **Owner decisions 2026-09-13 for step 4 (web layaway).**
> - **Deposit base and loyalty base are DIFFERENT figures, deliberately.**
>   Deposit = 30 % of the TOTAL: product + shipping + services (when services exist on
>   the web path). `deposit = round(0.30 × (subtotal_jpy + shipping_jpy + services_jpy))`.
>   Loyalty base = PRODUCT amount only, less any points redeemed against that order.
>   `loyalty_jpy_amount = subtotal_jpy` at creation; shipping never earns points. The
>   2026-05-26 net-spend rule then applies unchanged: `process-loyalty-redemption`
>   reduces `loyalty_jpy_amount` by `value_applied_jpy` on approval and restores it on
>   void, and `award-loyalty-points` reads the already-net figure. Step 4 must not
>   bypass that rule. Never conflate the two formulas.
> - **There is NO cancel-after-deposit.** A confirmed deposit means the order is
>   confirmed and runs on its schedule. The existing layaway lifecycle (overdue,
>   penalties, extension, forfeiture) is the only path out. Step 4 adds NO refund
>   columns to `layaway_accounts`, NO four-option refund decision and NO layaway
>   cancel function.
> - **The unpaid-deposit deadline is a SETTABLE FIELD, not a computed rule.** At
>   account creation the Hub offers an expiry date and a payment-settlement due date;
>   staff can set or change them. This replaces any 24 h / 72 h violation predicate: no
>   forfeiture lookups, no "cancelled with zero paid" test, no automatic violator
>   classification. The expiry path still exists and fires ONLY on a plan whose deposit
>   was never confirmed; nothing is ever cancelled after money is received.
>   OPEN (recorded, not decided): (a) the default when nobody sets it — 72 h proposed,
>   matching the live web cash orders; (b) whether the same override applies to web
>   CASH orders, which are hard-coded to `now() + interval '72 hours'` in
>   `create_web_order_atomic` with no way to extend; (c) whether extending a deadline
>   that has already passed reopens the order.
> - **Proof of payment:** the CSR uploads in the Hub, the customer uploads on the
>   website. The customer portal already does this through `submit-payment`. The
>   storefront needs the plumbing (upload to `payment-proofs`, insert
>   `payment_submissions` under the service role) with the same POLICY as everywhere
>   else: proof required, status `submitted`, `payments` never written directly, the CSR
>   confirms in Submissions, `total_paid` stays 0 until then.

> **Reality checks found while starting step 1** (2026-09-10). The plan is
> unchanged above; these are corrections to what it assumes:
> - `customers.auth_user_id` **already exists** and is indexed
>   (`idx_customers_auth_user_id`, partial). 122 of 882 customers are already
>   linked. Step 1 does not add it.
> - It is **not unique**. `/me` and `/auth/customer` look a customer up by
>   auth user, so a duplicate would make the lookup ambiguous. Adding the
>   partial unique index is the real schema work in step 1.
> - `customer_addresses` does not exist; flat address columns
>   (`address_line1`, `city`, `postal_code`, `country`, `location`) are on
>   `customers` and populated for 704 of 882. Step 1 creates the table and
>   backfills; the flat columns stay (the Hub UI reads them).
> - **Phone OTP cannot link a customer yet.** The live linking rule
>   (`setup-customer-account`) matches on the JWT's verified EMAIL, protected
>   by a partial unique index on `lower(email)`. A phone-OTP user has no
>   email and there is no unique index on `mobile_number`. See
>   "Phone OTP" in the step-1 migration header for the decision needed.

## Decisions
- **Processor:** (deferred, 2026-09-13) Square (Japan account, JPY). Web Payments SDK on the storefront for cards, Apple Pay, Google Pay. Card-on-file for layaway instalments. PayPay online if Square approves the application; konbini out of scope. — Not built. Reason: transfer-only meets the payment need today.
- **All payments** (bank transfer JP, GCash/Maya/bank PH): "pay by transfer" order → pending → CSR confirms in the Hub through the Submissions review. Same as today, now recorded end to end. This is the ONLY payment path in Phase 2.
- **Money logic lives in the Hub.** The storefront calls the Hub. The Hub creates the order or plan, records money only through `review-payment-submission`, and awards points. The storefront never holds a payment secret.
- **Customer identity:** Supabase Auth (email link today; phone OTP see reality checks) on the Hub's project; the storefront uses the anon key from the Hub's public client config. Customers are rows in the Hub's existing `customers` table, linked by `auth_user_id`.
- **Hub ownership:** still Lovable Cloud. Acceptable for Phase 2 launch; the move to Cynthia's own Supabase is scheduled as a separate project and must happen before volume grows (see "Open item").

## What Cynthia does first (blocking)
1. (deferred with step 3) Square Dashboard → Developer → create application "Cha Jewels Web". Copy **Application ID** (public), **Access Token** (secret), **Location ID**. Sandbox versions too.
2. (deferred with step 3) Square Dashboard → enable Apple Pay and Google Pay for online; register the domain `chajewelsjapan.com` (and the Vercel preview domain for testing).
3. (deferred with step 3) Ask Square support whether PayPay online is available for the account.
4. (deferred with step 3) Give the secrets to Claude Code → Lovable secrets `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_ENV` (sandbox|production). Vercel gets only `NEXT_PUBLIC_SQUARE_APP_ID` and `NEXT_PUBLIC_SQUARE_LOCATION_ID`.
5. ✅ Done. Transfer bank details are maintained in Hub Settings → Payment Methods (`transfer_payment_methods`, one JP bank and one overseas bank active as of 2026-09-13) and shown on the transfer instructions page and in the order email.

## Customer flows
A. **Buy now (full payment)** — product → "Buy" → sign in → address → pay by transfer (card / Apple / Google: deferred) → order confirmed → receipt email → points awarded on paid.
B. **Reserve with layaway** — product → "Reserve with 30%" → sign in → address → term (allowed terms and minimums from `plan_configurations` via `layaway_quote`) → agree to layaway terms (checkbox + timestamp) → pay the deposit (30 % of the total) by transfer before the settable deadline (Square: deferred) → plan created in Hub `layaway_accounts` → schedule in account → monthly: reminder email + pay-now page with transfer instructions and proof upload (auto-charge on a saved card: deferred). A confirmed deposit is a confirmed order; from then on the Hub's layaway lifecycle applies.
C. **Live claim** — `/live/claim/[code]` → sign in → choose A or B → pay → claim becomes order/plan; expiry cron releases unpaid claims.
D. **Account** — `/account`: orders, layaway plans with schedule and "pay now" per instalment, points balance and tier, addresses (saved card: deferred).
E. **Para Sa Iba** — order type SELF/GIFT/PROXY, recipient address, points to payer. Deposit min 30% for PROXY.

## Hub API additions (la-tracking, `website` function) — Claude Code writes, Lovable deploys
| Method & path | Auth | Does |
|---|---|---|
| `POST /auth/customer` | customer JWT | upsert `customers` row for the signed-in user; return profile |
| `GET /me` | customer JWT | profile, addresses, points, tier (saved-card status: deferred) |
| `PUT /me/addresses` | customer JWT | replace address list |
| `POST /checkout/quote` | customer JWT | body `{items:[{variant_id,qty}], mode:'full'|'layaway', term_months?, order_type, ship_to}` → totals, shipping, deposit (30 % of total), dated schedule (via `layaway_quote`), amount to pay now |
| `POST /checkout/pay` | customer JWT | body `{quote_id, method:'transfer'}` (`'square'`: deferred, answers 501) → creates order or plan, sets `pending_transfer`, returns instructions and the deadline |
| `POST /layaway/:plan_id/pay` | customer JWT | customer uploads proof and submits a transfer for the deposit or one instalment → `payment_submissions` (status `submitted`); card on file: deferred |
| `POST /claims/:code/checkout` | customer JWT | converts a held claim; same body as `/checkout/pay` |
| `GET /orders`, `GET /orders/:id`, `GET /layaway`, `GET /layaway/:id` | customer JWT | account data |
| `POST /webhooks/square` | Square signature | (deferred with step 3) |
| existing routes | API key | unchanged |

## Real table names — read this before drafting any migration

This plan was written against table names that **do not exist in the Hub**. Step 2
was built after checking the live schema; steps 3-7 must do the same. The mapping,
verified against the live database on 2026-09-11 and again on 2026-09-13:

| This plan says | The Hub actually has | Notes |
|---|---|---|
| `orders` | **`cash_orders`** | A web order is a `cash_order` with `source_channel = 'web'`. 39 columns before step 2. |
| `order_items` | **`cash_order_items`** | Already had `title`, `sku`, `quantity`, `unit_price_jpy`, `line_total_jpy`; step 2 added `variant_id`. |
| `layaway_plans` | **`layaway_accounts`** | Plan duration is `payment_plan_months`, sourced from `plan_configurations` and trigger-enforced. Has NO `source_channel` / `web_reference` and NO item lines yet — step 4 adds them. |
| `layaway_payments` | **`payments`** + **`layaway_schedule`** | `payments` is money received (`amount_paid`, `voided_at`); `layaway_schedule` is the instalment rows. |
| `loyalty_ledger` | **`loyalty_transactions`** | |
| a new `payments` table for Square | **`cash_payments`** (cash orders) / **`payments`** (layaway) | See the warning below. |

**`payments` already exists — do not create or repurpose it.** The plan's step 3
describes "`payments` (provider, provider_id, amount, status, raw)" as a new table.
There is already a `payments` table and it is the layaway money-received ledger:
`(account_id, amount_paid, currency, date_paid, payment_method, reference_number,
voided_at, …)`. CLAUDE.md INVARIANT 1 makes `SUM(payments.amount_paid WHERE
voided_at IS NULL)` the **only** source of `total_paid`. Altering its shape to suit
a processor would corrupt every layaway balance in the system. Cash-order money lives
in the parallel **`cash_payments`** table with the same shape keyed on `cash_order_id`.
Processor fields, if step 3 is ever revived, belong on `cash_payments` / `payments`
as *added nullable columns*, or in a separate table keyed to them — never as a
redefinition of `payments`. **Step 4 writes `payments` rows only through
`review-payment-submission`** (the universal-submission policy); no web path inserts
into `payments` directly.

**Why this matters beyond tidiness.** `cash_orders` is what the loyalty award path,
the store-credit cancellation policy, the test-account exclusion, the Finance
Overview KPIs, the Trade Program metrics and the staff notification bell are all
keyed on today. CLAUDE.md's ACCOUNT-SCOPE COVERAGE rule makes that binding: an
account-scoped surface must cover `layaway_accounts` **and** `cash_orders`. A parallel
`orders` table would be invisible to every one of them.

**Check the live schema before writing any migration, and estimate with the exact
expression the write uses.** Step 1 shipped a backfill whose pre-check counted
different columns from its `INSERT`; it manufactured 871 junk rows and had to be
reverted.

Schema additions (draft migrations), in REAL table names: `customers.auth_user_id` ✅ done, `customer_addresses` ✅ done, `cash_orders.source_channel/order_type/recipient_*/payment_method/payment_status/web_reference/quote_id/transfer_due_at/customer_lang` ✅ done in step 2, `cash_order_items.variant_id` ✅ done, `checkout_quotes` ✅ done (already carries `mode`, `term_months`, `deposit_jpy`, `schedule`). Step 4: `layaway_accounts.source_channel/web_reference/quote_id/transfer_due_at/customer_lang/expired_at` (a `settlement_due_at` shipped with step 4 and was dropped 2026-09-15 — owner decision, nothing read it), a `layaway_account_items` table (the variant lines a web plan holds stock for), `layaway_quote` v2. Deferred with step 3: `cash_orders.square_payment_id`, `customer_cards`, `layaway_accounts.square_card_on_file`. Reuse existing `layaway_accounts`, `payments`, `layaway_schedule`, `loyalty_transactions` — extend, never fork.

Edge functions: `square_webhook` (deferred), `layaway_autocharge` (deferred). Emails: the plan said `receipt_email` on Resend; the Hub actually sends through the Lovable-managed email API via `_shared/storefront-email.ts` (order confirmation, payment received, expired, cancelled exist since step 2). Step 4 adds the layaway-plan and instalment templates to the same helper.

## Storefront (cha-jewels-web, on `develop`)
- Auth: `@supabase/ssr` client already present; `/login` (email link; phone OTP see reality checks), session middleware, `/account/*` protected. ✅
- Cart: cookie (`cj-cart`); one-of-a-kind pieces → qty 1, stock check at quote time. ✅
- `/checkout`: three steps (details → review → payment). Payment step shows the region's transfer methods only (Square SDK card form + Apple/Google Pay buttons: deferred). ✅ for full payment; step 4 adds the layaway variant.
- `/account`, `/account/orders/[id]` ✅; `/account/layaway`, `/account/layaway/[id]` (schedule table, pay-now with transfer instructions and proof upload) — step 4.
- Product page: "Add to cart" ✅; "Reserve with 30%" — step 4; calculator stays but must offer only terms the business sells (see open corrections).
- Live claim page: real checkout instead of "opens in Phase 2" — step 5.
- Emails are sent by the Hub; the site only shows confirmations.
- Fixture mode: canned quote / order for local work; Square mock: deferred.

## Sequence (each step = one PR on develop, one Lovable deploy message)
1. Hub: auth linkage, `customers.auth_user_id`, `/auth/customer`, `/me`, addresses. Site: `/login`, `/account` shell. — **BUILT**
2. Hub: quotes + transfer orders (`/checkout/quote`, `/checkout/pay` transfer path) on **`cash_orders` / `cash_order_items`**. Site: cart, checkout with transfer only. **First real order end to end without Square.** — **BUILT** (migration `20260911120000`, see docs/WEBSITE-VERCEL.md "Checkout and web orders").
3. **DEFERRED (owner decision 2026-09-13, reason: transfer-only).** Hub: Square payments (`/checkout/pay` square path, `square_webhook`) recording into **`cash_payments`** — NOT a new `payments` table. Site: card form, Apple/Google Pay. Revive only by owner decision.
4. **BUILT 2026-09-14 — one PR per repo, awaiting Cynthia's merge; the two Lovable messages follow the merges.** Hub: layaway plan creation from checkout on **`layaway_accounts`** + **`layaway_schedule`** + **`layaway_account_items`** (`create_web_layaway_atomic`, `source_channel='web'`, deposit = 30 % of total, loyalty base = product subtotal, settable deposit deadline and settlement due date, expiry only when the deposit was never confirmed), instalment and deposit pay by transfer with customer proof upload through `payment_submissions` → **`payments`** (never a direct insert). FIRST COMMIT: `layaway_quote` v2 (terms and minimums from `plan_configurations`, the Hub's floor-and-remainder rounding, dated schedule) and the calculator term list. Card-on-file and `layaway_autocharge`: deferred. Site: "Reserve with 30%", layaway checkout, `/account/layaway` list + detail with schedule, pay-now and proof upload.
5. Hub: claim checkout, expiry cron hardening. Site: live claim page.
6. Receipts and reminder emails; points award on paid; account polish; Para Sa Iba fields.
7. **CSR parking area and Page365 / storefront fetch-and-attach.** Two entry points, one confirmation surface: paste a public Page365 invoice link → fetch → draft a Hub order; paste or pick a storefront product → fetch → draft a `website_products` record. Both land in a parking area where a CSR checks the parsed fields, edits anything, and confirms. NOTHING writes to a live order or a live product without that confirmation. Findings, verified 2026-09-13 by fetching both endpoints:
   - Both return clean JSON, no HTML scraping, no login. Invoice example `https://chajewelsjapan.com/invoices/ecyxls32dubb?sig=…`; products `https://www.chajewelsjapan.com/products?page=33`.
   - Invoice fields: `no` (= the Hub `invoice_number`; example 19668 against a highest Hub invoice of 19667, so the numbers are the same series and this is the join key), `stage`, `customer{name, phone, address, structural_address}`, `created_at`, `expires_on`, `price_subtotal` / `price_shipping` / `price_total`, `items[]{name, price, quantity, subtotal, note, product{id, product_id, description, photo}}`, `shipping_option`, `banks_available`.
   - Product fields: `name` (leading code = natural sku, e.g. R2117), `description` (line-broken into metal / weight / stone / size / condition), `price`, `photo.normal`, `category.name`, `id` / `product_id`.
   - A RESIZE FEE line is a SERVICE, not a product line — it belongs in `account_services` and is already inside `total_amount`. Importing it as a product line would inflate the loyalty base.
   - Item notes carry deal terms in free text ("Layaway (May) 8M / DP on 09/20 / Resize # 16"). Parse and DISPLAY for CSR confirmation; never auto-apply.
   - Origin is per-product and is a SUGGESTION from category only. A Tiffany or Bvlgari piece in a preloved category did not originate in Japan. Never auto-set `origin = JAPAN`; the badge is rendered only from product data.
   - `description_ja` is generated by the existing `translate-product-description`, not fetched.
   - Page365 stock is NOT a stock source: `available: 0` / `when_out_of_stock: "inform"` appears on every item including ones plainly for sale. The Hub does not own inventory (Shopify holds bidirectional sync). Fetch price, name, description, photos only.
   - The `?sig=` link is a CAPABILITY URL — it exposes customer name, phone and address to anyone holding it. Store the slug and invoice number; do not persist the signature.
   - Page365's API is undocumented and unversioned. It must fail visibly, never import a partial order silently.
   - CURRENCY, OPEN: in the sample invoice the item prices match the JPY storefront exactly, but shipping 2,395 on an LBC Visayas/Mindanao option to a Cebu customer reads like pesos. If one invoice can mix currencies in a single total, the Hub's conversion standard has no room for it. Check one more PH invoice before any build.
   - Parking area, OPEN (recorded, not decided): what lands in it (all new accounts, or web-created only — Cynthia said "all new created account"); what takes an item out (deposit confirmed / staff marks seen / ages out); where it lives (own sidebar item, or a tab under CSR Monitoring); confirm ACCOUNT-SCOPE means it covers `layaway_accounts` AND `cash_orders`. ALSO: check whether the unmerged `feat/pancake-process-events` holding-area UI (21 commits, PR #20 "[DO NOT MERGE] Pancake POS holding area") is the pattern to reuse — building a second holding area when one exists is worse than either.

## Acceptance for launch (transfer-only)
- Production, cash: one CSR-confirmed transfer order placed from the live storefront — order confirmation email received, transfer recorded through Submissions with proof, "payment received" email received, points awarded on completion for a loyalty member.
- Production, layaway: one plan created from the web whose deposit (30 % of total), every instalment amount, every due date and the total equal the Hub's `layaway_accounts` + `layaway_schedule` to the yen; the customer's deposit proof submitted from the website, confirmed by a CSR through Submissions; points awarded on the deposit confirm on the product subtotal; the plan visible in `/account/layaway` with the same numbers.
- Unpaid deposit: a second web plan left unpaid passes its (settable) deadline → expired by the expiry path, stock back on sale, expiry email received. Nothing is ever expired or cancelled after a confirmed deposit.
- Emails: all of the above require the Lovable-managed email API to accept runtime sends again (outage since 2026-09-04, ticket open); until then the acceptance cannot be completed and the storefront `develop → main` release stays held.
- No payment secret in the storefront repo or Vercel (`grep -r sq0atp` stays empty as a guard for the deferred step).

## Open item — Hub ownership
The plan scheduled the move to a Supabase project in Cynthia's account (Tokyo region, Pro) "after step 3 and before marketing pushes traffic". Step 3 is deferred, so that trigger never arrives. **Proposed new trigger, for Cynthia's decision, not decided here:** either (a) before the storefront production release (`develop → main` after the acceptance above), or (b) before the first marketing push after that release. The reasons stand regardless of Square: Lovable Cloud gives no direct DB backup, no dashboard and no service-role key, and the 2026-09-04 email outage showed that a platform-side state can block customer communication for days with no self-service remedy. The API contract means the storefront does not change when the backend moves. It does not block step 4.

## Open corrections found during the step-4 investigation (2026-09-13)
- **CLAUDE.md TEST ACCOUNT EXCLUSION is stale.** It describes the numeric invoice regex as live in 20 reporting RPCs and gives an audit query expecting it. Live: 0 functions contain the regex; they filter on `is_test = false` (`get_monthly_sales`: `WHERE la.is_test = false`; `get_aging_buckets`: `AND a.is_test = false`; `fc_cohort_timeline`: `WHERE la.is_test = false`; `get_trade_kpis` has neither). The section's audit query now reports every function as failing. Needs rewriting.
- **penalty-engine index.ts:107** still excludes test accounts by the literal names `TEST-001 / 002 / 003`, which CLAUDE.md declares incomplete and replaced.
- **`layaway_quote` quotes plans the business cannot sell.** It allows 4, 5 and 7-month terms that `create-layaway-account` and `trg_enforce_plan_minimum` reject, ignores `plan_configurations` minimums, and rounds `round((price − deposit) / term)` where the Hub uses floor with the remainder on the last row. The PRODUCTION storefront calculator offers [3, 4, 5, 6, 8] today. **FIXED 2026-09-14** in `20260914100000_layaway_quote_v2.sql`: terms and minimums now come from `plan_configurations`, rounding is the Hub's floor-with-remainder-on-the-last-row, and the function returns dated rows plus `allowed_terms` with an `eligible` flag per term. The storefront calculator reads that list instead of a hardcoded array.
- **docs/PENDING.md** web-order stock line ("cancelling from CashOrderDetail leaves stock decremented") is stale: `terminate_web_order_atomic` (2026-09-13) restores stock. **docs/FIXED-BUGS.md Bug #267** is wrong: publishing the project did not clear the `missing_unsubscribe` refusal (published twice, still refused, ticket open with Lovable). Both flagged; Cynthia supplies the #267 wording.
- **Hub-ownership trigger** remains OPEN (see above). Does not block step 4.
