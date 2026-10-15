# Sale prices, coupons, and consent-first visitor emails — plan

Status: **PLAN, awaiting Cynthia's go** (Hub rule: "No prompt written without
plan confirmed first"). Nothing here is built yet. Written 2026-10-15.

Storefront companion fix already done (no Hub change): the product page's
"View cart" is now a full-width button directly under "Added to cart"
(storefront branch `fix/view-cart-below-added`).

Owner decisions taken 2026-10-15:

| # | Question | Decision |
|---|----------|----------|
| S-1 | How a sale looks | Sale price in the CTA colour, full price struck through beside it, small "Sale" tag. Replaces D2-5 ("never struck through") **for items on sale only**; sold pieces stay muted, never struck. |
| S-2 | What a sale changes | Sale price is the real price everywhere: checkout, layaway down payment and monthly, pesos, loyalty points, cart-reminder emails. |
| C-1 | Coupon kinds | Fixed yen off, percent off, plus limits (expiry, minimum order, total uses, per-customer use, combine with sale / points). |
| T-1 | Anonymous visitors | Consent-first build: banner, visitor ID only after "Accept", behaviour tied to an email only when the visitor gives one **and** ticks a marketing opt-in. Privacy-policy wording drafted for owner approval. |

Release order: **Sale (S) → Coupons (C) → Visitor emails (T)**. Each Hub step is
one PR `develop` → `main` (migration + Hub frontend + edge function together),
then one Lovable apply-and-deploy message with source assertions, then the
storefront PR. The storefront never computes a figure (`check:money`).

---

## S. Sale price per product variant

### Hub
- **Migration** `website_product_variants`:
  - `sale_price_jpy integer NULL`, CHECK `sale_price_jpy > 0 AND sale_price_jpy < price_jpy`.
  - `sale_ends_at timestamptz NULL` (optional; empty = until staff remove it).
  - `price_jpy` keeps meaning **full price**. Nothing existing is rewritten.
  - SQL function `website_effective_price_jpy(price_jpy, sale_price_jpy, sale_ends_at)` →
    the sale price while it is set and not past `sale_ends_at`, else `price_jpy`. One
    definition, used by every reader below.
- **Hub UI** (`src/components/website/ProductDialog.tsx`, `ProductsCard.tsx`):
  - Variant row: "Full price (¥)" (the existing field, relabelled) + "Sale price (¥)"
    + "Sale ends (JST)". Validation mirrors the CHECK. "≈ ₱" hint for both.
  - List: full price, and the sale price beside it with a "Sale" chip while active.
  - Import / Page365 paths keep writing `price_jpy` only; they never touch sale fields.
- **Website edge function** (`supabase/functions/website/index.ts`):
  - `VARIANT_SELECT` adds `sale_price_jpy, sale_ends_at`.
  - `shapeProduct` sends **`price_jpy` = effective price** and, only while on sale,
    `compare_at_price_jpy` (full) + `compare_at_price_php` + `sale_ends_at`.
    Keeping `price_jpy` as "what you pay" means cart, down payments
    (`attachDownPayments`), layaway quote, checkout and points all follow the sale
    with no change to their contracts.
  - `POST /checkout/quote` (~:2313): `unit = effective price` (re-read on the server,
    as today). The draft already copies the quote's `unit_price_jpy`, so
    `create_web_draft_atomic` / `materialize_web_draft_atomic` need no change.
  - `GET /me/points-preview` (~:2025/:2092) and `cart_reminder_candidates`
    (migration `20261021100000`, :340) read the effective price.
  - A sale ending between quote and pay: the quote's price stands (same rule as a
    price change today — the draft uses the quote).
  - Revalidation: saving a sale triggers the existing product revalidation, and a
    sale reaching `sale_ends_at` is picked up by ISR (60 s) — no cron needed.
- **Not touched:** the retired `create_web_order_atomic` / `create_web_layaway_atomic`
  direct paths (PR 10 retired them from checkout).

### Storefront
- `lib/types.ts` `ProductVariant`: `compare_at_price_jpy?`, `compare_at_price_php?`, `sale_ends_at?`.
- One component `components/commerce/sale-price.tsx` renders sale price + struck full
  price + "Sale"/「セール」 tag (EN/JA), used by `price-block.tsx`, `product-card.tsx`,
  `arrival-card.tsx`, hero stage prices, search suggestions, cart lines.
- Update the D2-5 comments (`price-block.tsx:39-41`, `product-card.tsx:34`) to the new rule.
- `lib/fixtures.ts`: one fixture variant on sale. Contract: `supabase/contracts/api.md`.
- Guards: `check:money` unchanged (all figures are the Hub's); add a unit test that a
  sold piece is never rendered struck.

---

## C. Discount coupons

### Hub
- **Migration**
  - `website_coupons`: `id`, `code citext UNIQUE` (A–Z 0–9 -, 3–32), `kind` (`amount`|`percent`),
    `amount_jpy` / `percent` (1–90), `min_subtotal_jpy`, `starts_at`, `ends_at`,
    `max_uses`, `per_customer_limit` (default 1), `combine_with_sale bool`,
    `combine_with_points bool`, `active bool`, `note`, `created_by`, timestamps.
    Staff-only RLS. Never deleted (deactivated), audited like Shipping fees.
  - `website_coupon_uses`: `coupon_id`, `customer_id`, `quote_id`, `draft_id`,
    `cash_order_id` / `layaway_account_id`, `discount_jpy`, `status`
    (`held` → `used` | `released`), timestamps. A use is `held` when the draft is
    created, `used` at staff Confirm, `released` on draft cancel/expiry — so
    `max_uses` counts held + used and an abandoned draft gives the use back.
  - `checkout_quotes`: `coupon_id`, `coupon_discount_jpy` (nullable).
- **Discount maths (Hub only)**: on the **pieces subtotal** (never shipping, services,
  COD fee). Percent rounds down to the yen. If `combine_with_sale` is false, sale
  lines are excluded from the base. Capped at the base. Peso figure via the existing
  quote conversion.
- **Website API**
  - `POST /checkout/quote/:id/choice` gains `coupon` (code or `null` to remove). Answer adds
    `coupon: { code, discount_jpy, discount_php }` and the totals already returned
    (`total_after_points`, `due_now_after_points`, `cod_fee`) are net of it.
  - Refusal codes (stable, translated on the site): `coupon_not_found`,
    `coupon_expired`, `coupon_not_started`, `coupon_used_up`,
    `coupon_already_used`, `coupon_min_subtotal` (+ `min_subtotal_jpy`),
    `coupon_not_with_sale`, `coupon_not_with_points`.
  - Points cap becomes `pieces − coupon` (still never shipping; layaway: ≤ deposit).
  - `POST /checkout/pay` → `create_web_draft_atomic`: re-validates the coupon inside the
    transaction (row lock on the coupon), writes the `held` use, stores coupon +
    discount on the draft. Layaway: the plan is quoted on `products − discount`, the
    same basis `computeWebDraftFigures` already uses at Confirm.
  - `/orders/:id` and drafts return `coupon_code` + `discount_jpy` so the account pages
    can show the line (today the site never receives `discount_amount`).
- **Staff Confirm** (`confirm-web-draft`, `_shared/web-draft-figures.ts`): the
  `discount` field is pre-filled from the coupon and labelled with its code; staff may
  still change it (their call, logged). `materialize_web_draft_atomic` writes
  `discount_amount`, `discount_type`, `discount_value` as today → `total_amount` is net
  of the discount **at creation** (INVARIANT 9 respected: never modified after).
  Loyalty basis = products − discount, in yen (existing rule). Paidy: negative line
  (existing `paidy-rules.ts` path).
- **Hub UI**: Website → Settings → **Coupons** (admin), list + create/edit/deactivate,
  uses per coupon with links to the orders.

### Storefront
- `components/commerce/checkout-flow.tsx`: a "Coupon code" field + Apply/Remove beside
  the points panel; summary row "Coupon (CODE) −¥X"; refusal messages EN/JA.
- `lib/checkout-actions.ts` `checkoutChoiceAction(quoteId, { method, points, coupon })`;
  `cleanChoice` allows `coupon` (trimmed, upper-cased, ≤ 32 chars).
- **Coupon link**: `/c/<CODE>` (and `?coupon=<CODE>` on any page) saves the code in a
  `cj-coupon` cookie (code only, 7 days) and goes to the cart; checkout pre-fills and
  applies it. The cart shows "Coupon CODE will be applied at checkout" — no figure
  (figures only come from the quote).
- Account order pages show the coupon line from the Hub's figures.
- Fixtures + contract (`supabase/contracts/api.md`) + unit tests for the refusal map.

---

## T. Consent-first visitor tracking and reminder emails

Legal frame (from `reference/abandoned-cart-investigation.md` :352-372 and
`lib/content/legal.ts` :874): 特定電子メール法 §3/§4 (prior opt-in, consent record,
sender block), 特商法 §12-3, APPI (personal data once linked to an email), PH Data
Privacy Act (specific, informed, evidenced consent). **The privacy-policy and banner
wording below are drafts for owner approval; no tracking ships before they are approved
and published.**

### Storefront
- **Consent banner** (EN/JA): "Accept" / "Reject" / "Settings", equal prominence.
  Choice stored in `cj-consent` (`necessary` | `analytics+personalisation`), 13 months,
  changeable from a footer "Cookie settings" link. Reject = today's behaviour exactly.
- **Visitor ID** `cj-vid` (random UUID, HttpOnly, 13 months) created **only** after Accept;
  deleted on Reject/withdraw.
- **Events** (server-side, via a Server Action pairing `HUB_API_KEY` — never a browser
  fetch to the Hub): `product_view` (variant), `add_to_cart`, `cart_view`,
  `checkout_start`. No free text, no URLs with query strings. Not sent on `/account`,
  `/login`, `/auth`, `/checkout/complete` (same blocklist as Metricool).
- **Identify** — only where the visitor types an email **and** ticks a separate,
  unticked-by-default "Email me about pieces I viewed and my cart" box (with
  text_version): newsletter form, contact form, sign-in form. Sign-in links the visitor
  ID to the customer whether or not the box is ticked (it is her own account), but
  emails still require the tick.
- Privacy policy (`lib/content/legal.ts`) analytics + marketing sections rewritten
  (draft for approval), "Cookie settings" page, unsubscribe page reused.

### Hub
- **Migration**: `website_visitors` (visitor_id, customer_id NULL, email NULL,
  first/last seen), `website_visitor_events` (visitor_id, event, variant_id, at),
  `marketing_email_consents` + append-only `marketing_email_consent_events`
  (email-keyed, text_version, source, IP-free) — the cart-reminder consent tables are
  customer-keyed and stay as they are. Retention: events 90 days, unlinked visitors
  13 months (pg_cron purge, like `purge_stale_customer_carts`).
- **Website API**: `POST /visitor/events` (batched, API key, rate-limited per visitor),
  `POST /visitor/identify`, `POST /visitor/forget` (on Reject/withdraw: delete events
  and visitor row).
- **Sweep** `visitor-reminder-sweep` (pg_cron hourly), kill switch
  `visitor_reminders_mode` off/owner_only/on (seeded `off`, fails closed). Two emails:
  **cart left** (added to cart, no checkout in 24 h) and **browse** (viewed the same
  in-stock piece ≥ 2 times, no cart in 48 h). Rules: opted-in, not suppressed, not a
  test customer, stock still available, one email per 7 days per address, 09:00–19:59
  local, never to an address already covered by a cart reminder (signed-in customers
  keep stages A/B), prices in the email are the Hub's current effective prices.
- **Sender**: marketing path (Resend, `news@news.chajewelsjp.com`, List-Unsubscribe) —
  **prerequisite: `RESEND_API_KEY` set and `NEWSLETTER_DOMAIN_VERIFIED=true`**. Never the
  transactional path (100/hr Lovable cap, and the existing rule).
- **Hub UI**: Website → Settings → Visitor reminders (switch, counts, last sends), and a
  customer's linked visitor activity on the customer page (staff only).

---

## Open items before go
1. Cynthia's go on this plan (and on S first).
2. T only: owner approval of banner + privacy-policy wording; Resend key + domain.
3. C only: `create_web_draft_atomic`, `materialize_web_draft_atomic` and the
   `cart_reminder_candidates` body are changed **from live** (Hub rule "FUNCTION
   CHANGES START FROM LIVE"): Cynthia runs `pg_get_functiondef` for each and the
   migration is an md5-guarded patch of that text; `scripts/function-drift-audit`
   must stay at 0 before it is written.
4. Whether coupon management is admin-only or also `manage_website_content` staff
   (plan assumes admin-only, like Shipping fees).
