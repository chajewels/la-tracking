# Phase 2 — Accounts, checkout and payments (Square)

Status: plan. This is the Hub-side copy of `cha-jewels-web`'s
`docs/tasks/phase2-plan.md` (source of truth: that file, commit `47329f0`).
Both Claude Code sessions read the same text — if you edit one, mirror the other.

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
- **Processor:** Square (Japan account, JPY). Web Payments SDK on the storefront for cards, Apple Pay, Google Pay. Card-on-file for layaway instalments. PayPay online if Square approves the application; konbini out of scope.
- **Everything else** (bank transfer JP, GCash/Maya/bank PH): "pay by transfer" order → pending → CSR confirms in the Hub. Same as today, now recorded end to end.
- **Money logic lives in the Hub.** The storefront tokenises the card and calls the Hub. The Hub creates the Square payment, records it, awards points, and receives Square webhooks. The storefront never holds a Square secret except the public Application ID.
- **Customer identity:** Supabase Auth (phone OTP, email fallback) on the Hub's project; the storefront uses the anon key from the Hub's public client config. Customers are rows in the Hub's existing `customers` table, linked by `auth_user_id`.
- **Hub ownership:** still Lovable Cloud. Acceptable for Phase 2 launch; the move to Cynthia's own Supabase is scheduled as a separate project and must happen before volume grows (see "Open item").

## What Cynthia does first (blocking)
1. Square Dashboard → Developer → create application "Cha Jewels Web". Copy **Application ID** (public), **Access Token** (secret), **Location ID**. Sandbox versions too.
2. Square Dashboard → enable Apple Pay and Google Pay for online; register the domain `chajewelsjapan.com` (and the Vercel preview domain for testing).
3. Ask Square support whether PayPay online is available for the account.
4. Give the secrets to Claude Code → Lovable secrets `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_ENV` (sandbox|production). Vercel gets only `NEXT_PUBLIC_SQUARE_APP_ID` and `NEXT_PUBLIC_SQUARE_LOCATION_ID`.
5. Decide the transfer bank details shown to customers (JP bank; PH GCash number / bank) — these display on the transfer instructions page.

## Customer flows
A. **Buy now (full payment)** — product → "Buy" → sign in (OTP) → address → pay: card/Apple/Google (Square) or transfer → order confirmed → receipt email → points awarded on paid.
B. **Reserve with layaway** — product → "Reserve with 30%" → sign in → address → term (from `layaway_quote`) → agree to layaway terms (checkbox + timestamp) → pay deposit (Square or transfer) → plan created in Hub `layaway_plans` → schedule in account → monthly: auto-charge card on file if saved, else reminder + pay link.
C. **Live claim** — `/live/claim/[code]` → sign in → choose A or B → pay → claim becomes order/plan; expiry cron releases unpaid claims.
D. **Account** — `/account`: orders, layaway plans with schedule and "pay now" per instalment, points balance and tier, addresses, saved card (Square card-on-file id only).
E. **Para Sa Iba** — order type SELF/GIFT/PROXY, recipient address, points to payer. Deposit min 30% for PROXY.

## Hub API additions (la-tracking, `website` function) — Claude Code writes, Lovable deploys
| Method & path | Auth | Does |
|---|---|---|
| `POST /auth/customer` | customer JWT | upsert `customers` row for the signed-in user; return profile |
| `GET /me` | customer JWT | profile, addresses, points, tier, saved-card status |
| `PUT /me/addresses` | customer JWT | replace address list |
| `POST /checkout/quote` | customer JWT | body `{items:[{variant_id,qty}], mode:'full'|'layaway', term_months?, order_type, ship_to}` → totals, shipping, layaway schedule (via `layaway_quote`), Square amount to charge now |
| `POST /checkout/pay` | customer JWT | body `{quote_id, method:'square'|'transfer', source_id?, save_card?}` → creates order or plan; for `square` calls Square Payments API with idempotency key = quote_id; for `transfer` sets `pending_transfer` and returns instructions |
| `POST /layaway/:plan_id/pay` | customer JWT | pay one instalment (card on file or new source) |
| `POST /claims/:code/checkout` | customer JWT | converts a held claim; same body as `/checkout/pay` |
| `GET /orders`, `GET /orders/:id`, `GET /layaway`, `GET /layaway/:id` | customer JWT | account data |
| `POST /webhooks/square` | Square signature | `payment.updated`, `refund.updated` → reconcile; idempotent on `payment_id` |
| existing routes | API key | unchanged |

Schema additions (draft migrations): `customers.auth_user_id`, `customer_addresses`, `orders.channel/order_type/recipient/payment_method/payment_status/square_payment_id`, `order_items`, `payments` (provider, provider_id, amount, status, raw), `customer_cards` (square customer id + card id, brand, last4), `layaway_plans.square_card_on_file` flag, `checkout_quotes` (server-side quote cache, 30 min TTL). Reuse existing `layaway_plans`, `layaway_payments`, `loyalty_ledger` — extend, never fork.

Edge functions: `square_webhook`, `layaway_autocharge` (daily cron: due instalments with card on file → charge → record), `receipt_email` (Resend; JA/EN templates).

## Storefront (cha-jewels-web, on `develop`)
- Auth: `@supabase/ssr` client already present; add `/login` (phone OTP + email), session middleware, `/account/*` protected.
- Cart: in-memory + cookie; one-of-a-kind pieces → qty 1, stock check at quote time.
- `/checkout`: three steps (details → payment → confirm). Square Web Payments SDK card form + Apple/Google Pay buttons; transfer option with instructions page.
- `/account`, `/account/orders/[id]`, `/account/layaway/[id]` (schedule table, pay-now button).
- Product page: "Buy now" and "Reserve with 30%" buttons replace the placeholder calculator CTA; calculator stays.
- Live claim page: real checkout instead of "opens in Phase 2".
- Emails are sent by the Hub; the site only shows confirmations.
- Fixture mode: mock Square with sandbox App ID; `/checkout/pay` returns canned success.

## Sequence (each step = one PR on develop, one Lovable deploy message)
1. Hub: auth linkage, `customers.auth_user_id`, `/auth/customer`, `/me`, addresses. Site: `/login`, `/account` shell.
2. Hub: quotes + transfer orders (`/checkout/quote`, `/checkout/pay` transfer path), `orders`, `order_items`. Site: cart, checkout with transfer only. **First real order end to end without Square.**
3. Hub: Square payments (`/checkout/pay` square path, `square_webhook`), `payments` table. Site: card form, Apple/Google Pay. Sandbox first, then production keys.
4. Hub: layaway plan creation from checkout, instalment pay, card-on-file, `layaway_autocharge`. Site: layaway flow + schedule + pay-now.
5. Hub: claim checkout, expiry cron hardening. Site: live claim page.
6. Receipts and reminder emails; points award on paid; account polish; Para Sa Iba fields.

## Acceptance for launch
- Sandbox: card, Apple Pay, transfer, layaway deposit + one instalment, claim checkout, refund via Square dashboard reconciles to the Hub.
- Production: one real ¥1,000 card payment refunded; one real transfer order confirmed by a CSR.
- No Square secret in the storefront repo or Vercel (`grep -r sq0atp` is empty). Webhook signature verified. Idempotency proven by replaying a webhook.
- Layaway numbers on the site equal the Hub's plan to the yen.

## Open item — Hub ownership
Payments raise the cost of Lovable Cloud lock-in: no direct DB backup, no dashboard, no service-role key for Cynthia. Plan the migration to a Supabase project in Cynthia's account (Tokyo region, Pro) as its own task after step 3 and before marketing pushes traffic. The API contract means the storefront does not change when the backend moves.
