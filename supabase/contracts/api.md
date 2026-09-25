# Website API Contract

Served by the `website` edge function (`supabase/functions/website/index.ts`).
Server-to-server only: every route requires header `x-api-key` equal to the
`WEBSITE_API_KEY` secret; anything else gets 401 `{ "error": "unauthorized" }`.
Customer-scoped routes additionally require `Authorization: Bearer <customer
JWT>` (see per-route notes). Every response carries `x-request-id` and every
error body carries `request_id`.

`cost_basis`, `margin`, and `commission` are never selected or returned.

## Catalog

### GET /catalog/collections
All collections, ordered by name. Each: `{ id, slug, name, name_en, name_ja,
description_en, description_ja, hero_media }`.

### GET /catalog/collections/:slug
One collection plus `products`: active products in
`website_collection_products.sort` order, shaped as products below.

### GET /catalog/categories
Published categories only (`published = true`), ordered by `sort_order` then
`name`. Each: `{ id, slug, name, name_ja, description, description_ja,
hero_media, cta_label, cta_label_ja, sort_order }`.

### GET /catalog/categories/:slug
The published category (404 `{ "error": "not_found" }` when missing or
unpublished) plus `products`: active products shaped exactly as
`/catalog/collections/:slug`, ordered by `website_category_products.sort_order`
then product name.

### GET /catalog/products?featured=1&limit=8
Active products, newest first, `limit` capped at 5000. With
`?fields=slug,updated_at,...` returns only the requested fields (allowlist:
`slug, updated_at, sku, name, status`).

### GET /catalog/products/:slug
One active product by slug; 404 otherwise.

### Product shape
`{ id, sku, slug, name, name_en, name_ja, karat, metals, weight_g,
description_en, description_ja, status, condition, origin, brand, updated_at,
product_variants: [{ id, size, stone, price_jpy, price_php, stock_qty,
down_payment_jpy?, down_payment_php?, down_payment_pct?,
product_media: [{ url, alt }] }], category_slugs: string[] }`

- `stock_qty` is the Hub's one stock figure. Besides website orders and staff
  edits, a **Page365 invoice imported into the Hub** reduces it (and a cancelled
  or expired import gives it back) — 2026-09-26, docs/PAGE365-IMPORT.md
  "STOCK". No field or shape changed; the storefront keeps reading `stock_qty`
  and is revalidated by the same catalogue trigger.
- Since 2026-09-27 staff can also set `stock_qty` from the **Page365 inventory
  fetch** (Website → Page365 stock; docs/PAGE365-IMPORT.md "INVENTORY"), and
  that fetch adds Page365's photos to `product_media` (in Page365's order,
  after any staff photos). Still no field or shape change: `product_media`
  items stay `{ url, alt }`, every URL is the Hub's own `promotions` bucket
  (never a Page365 hotlink), and the same revalidation trigger fires.
- `price_php` is derived per request from the latest `fx_rates` row
  (`PHP = JPY × rate`), rounded **half-up to a whole peso** with the same
  integer maths the peso checkout stores (2026-09-25; before, a float round
  could land ₱1 low on an exact .5); `null` when no rate is on file. Never
  stored.
- **Down payments** (2026-09-25, owner rule: every customer-facing money figure
  comes from the Hub; the storefront never computes or converts). Per variant,
  for the **piece alone** (no shipping), on the shortest active term:
  - `down_payment_jpy` = `layaway_quote(price_jpy, term, 'JPY').deposit`
  - `down_payment_php` = `layaway_quote(price_php, term, 'PHP').deposit` —
    convert first, then the percentage, both half-up to a whole unit. With ₱0
    shipping this is exactly the deposit a peso layaway checkout stores for the
    piece; with shipping, the checkout deposit also covers shipping (owner
    decision D1), and the checkout shows that binding figure.
  - `down_payment_pct` — that term's `dp_percentage` (0.30 today).
  - All three come from one `website_down_payments` call per request. A field
    the Hub cannot produce is **omitted, never null and never estimated**: no
    rate → no `down_payment_php`; lookup failure → none of the three (the
    catalog still renders). Render the reserve line only when the figures you
    need are present. Present on every product-shaped response
    (`/catalog/products`, `/catalog/products/:slug`, `/catalog/collections/:slug`,
    `/catalog/categories/:slug`); never on the `?fields=` slug list.
- `category_slugs` lists the published categories the product belongs to;
  empty array when uncategorised. Present on `/catalog/products` and
  `/catalog/collections/:slug` (and `/catalog/categories/:slug`) results.

## Testimonials

### GET /testimonials
Published testimonials (`published = true`), ordered by `sort_order` ascending
then `created_at` descending: `[{ id, customer_name, location, quote_en,
quote_ja, item, rating, testimonial_date }]`. `testimonial_date` is a nullable
date (when the testimonial was originally given). Returns `[]` when there are
none — never an error.

## Content

### GET /content/settings
Every `website_settings` row with `public = true`, flattened to
`{ key: value }` (values are the stored JSON), plus one derived key:
`web_reservation_mode` (boolean) — read at request time from
`system_settings.web_reservation_mode` via the same reader the checkout path
uses (`readReservationMode`, fail-closed to false). It is never stored as a
`website_settings` row, so there is exactly one switch. Ordered by key;
non-public rows are never returned. Same `x-api-key` rule and same cache
treatment as `/catalog/collections` — freshness for the stored keys comes from
the `website_settings` revalidate trigger, which posts `{ "tag": "content" }`
to the storefront's revalidate endpoint on every insert, update or delete
(the derived key is always current per request).

### GET /content/posts?type=article|news
Posts with `published = true` and `published_at <= today` (PHT), ordered by
`published_at` descending. `type` is optional and filters exactly. Each:
`{ id, slug, type, title_en, title_ja, excerpt_en, excerpt_ja, cover_media,
published_at, layaway_only }` — the body is never in the list response. Returns
`[]` when there are none.

### GET /content/posts/:slug
The full post, `body_en` / `body_ja` included. 404 `{ "error": "not_found" }`
when the slug is unknown, the post is unpublished, or `published_at` is in the
future.

Same `x-api-key` rule and cache treatment as `/catalog/collections`; freshness
comes from the `website_posts` revalidate trigger, which posts
`{ "tag": "content", "postSlug": <slug> }` on every insert, update or delete.

### GET /content/faq
Published FAQ sections ordered by `sort_order`, each with its published items
ordered by `sort_order`: `[{ slug, title_en, title_ja, items: [{ id,
question_en, question_ja, answer_en, answer_ja, layaway_only }] }]`. Returns
`[]` when there are none.

Same `x-api-key` rule and cache treatment as `/catalog/collections`; freshness
comes from the `website_faq_sections` / `website_faq_items` revalidate
triggers, which post `{ "tag": "content", "path": "/faq" }` on every insert,
update or delete.


## Newsletter

### POST /newsletter
Body `{ email, lang?, source? }` (`lang` `en`|`ja`, default `en`; `source` ≤ 64
chars). No customer auth required; a valid customer session, when present,
links `customer_id`. Rate-limited to 5 posts per IP per 10 minutes (429
`rate_limited`; in-memory per isolate). Upserts on the normalised email: a new
address inserts with `consented_at` now, a previously unsubscribed address
re-consents, an active address is unchanged. Response 200 `{ "status":
"subscribed" | "already_subscribed" }` — it never reveals whether the address
existed beyond that. New subscriptions raise a `newsletter_subscribed` staff
notification.

### GET /newsletter/unsubscribe?token=<uuid>
Sets `unsubscribed_at` for the matching token. Always 200 `{ "status":
"unsubscribed" }` whether or not the token matched — existence is never leaked.

## Contact

### POST /contact
Body `{ full_name, email, phone?, message, lang?, page?, newsletter? }`.
No customer auth required; a valid customer session, when present, links
`customer_id`. Validation: `full_name` 1–120 chars, `email` format, `phone` ≤
40 chars, `message` 10–2000 chars, `lang` `en`|`ja` (default `en`), `page` ≤
200 chars. Honeypot: a non-empty `company` field gets 200 `{ "status":
"received" }` with nothing written. Rate-limited to 5 posts per IP per 10
minutes (429 `rate_limited`; in-memory per isolate, independent of the
/newsletter limit). Inserts the inquiry with status `new`; with
`newsletter: true` it also runs the same newsletter upsert as POST /newsletter
with source `contact`. New inquiries raise a `contact_inquiry` staff
notification. Response 200 `{ "status": "received" }`.

## FX

### GET /fx
`{ jpy_php, as_of }` — the latest rate; 404 when none is on file.

## Layaway

### POST /layaway/quote
Proxies the `layaway_quote` RPC: the plan schedule a checkout would create.
`term_months` defaults to 3; `currency` is `JPY` (default) or `PHP`.

**Preferred body (2026-09-25): `{ price_jpy, term_months, currency }`.**
`price_jpy` is the piece's **yen** price (a whole, non-negative number)
whatever `currency` is — the storefront sends the catalog price and never
converts.
- `currency: "JPY"` → `layaway_quote(price_jpy, term, 'JPY')`.
- `currency: "PHP"` → the Hub converts, `price_php = HU(price_jpy × rate)` at
  the latest `fx_rates` row (the same half-up the catalog's `price_php` and the
  peso checkout use), then `layaway_quote(price_php, term, 'PHP')`. Every figure
  in the answer — `deposit`, `monthly`, `last_month`, `total`, `schedule` — is
  in pesos, computed in pesos (floor-and-remainder on the peso amount), never a
  converted yen figure. No usable rate → **503 `{ "error": "fx_unavailable" }`**.
- The answer adds `price_jpy`, `fx_rate` and `fx_as_of` (`null` for yen).
- `price_jpy` wins when both `price_jpy` and `price` are sent. A non-integer or
  negative `price_jpy` → 400 `invalid_price`.

**Legacy body `{ price, term_months, currency }`** — `price` is read in
`currency` — is unchanged and keeps working until the storefront moves to
`price_jpy`. Errors: 400 `invalid_price`, 400 `invalid_currency`.

**Term minimums are per currency.** `allowed_terms[].min_amount` and
`eligible` use `plan_configurations.min_amount_jpy` for a yen quote and the
fixed **`min_amount_php`** for a peso quote (6M ₱10,500, 8M ₱126,000, …) — never
the yen minimum converted at the day's rate. So a piece can clear a term in yen
and not in pesos: ¥26,427 at 0.397296 is ₱10,499, below 6M's ₱10,500. A peso
checkout refuses the same term (`409 below_plan_minimum`), so show the peso
quote's `allowed_terms` in ₱ mode.

## Claims (live selling)

### GET /claims/:code
`{ id, code, price_locked, status, expires_at, product_variant_id }`; 404 when
the code is unknown.

## Customer-scoped routes (customer JWT + x-api-key)

- `GET /me` — customer profile plus loyalty snapshot.
- `GET /orders` / `GET /orders/:ref` — cash orders, own only.
- `GET /layaway` / `GET /layaway/:ref` — layaway plans, own only, with schedule.
- `GET/POST/PUT/DELETE /addresses` — the customer's address book.
- `POST /checkout/quote` — prices a cart (and, for a layaway, reserves its
  invoice number). See **Checkout** below.
- `GET /checkout/quote/:id` — re-reads a saved quote, same shape.
- `POST /checkout/pay` — creates the order (`create_web_order_atomic` /
  `create_web_layaway_atomic`).

### Checkout — currency, peso totals, errors (updated 2026-09-25)

**Settlement currency.** `settlement_currency` is `JPY` (default) or `PHP`, for
**both** modes — a full (one-time) payment and a layaway alike (peso full
payment, owner decision 2026-09-25; layaway since 2026-09-13). Yen is the price
of record: every `*_jpy` field stays yen whatever the customer chose.

`POST /checkout/quote` body: `{ items: [{ variant_id, qty }], mode: "full" |
"layaway", settlement_currency?, term_months? (layaway), ship_to_address_id,
order_type?, recipient_name?, recipient_phone?, gift_note? }`.

Quote response (POST and GET) — currency fields:
- `subtotal_jpy`, `shipping_jpy` (null = no published rate), `total_jpy` — yen.
- `settlement_currency` — as requested.
- `fx_rate`, `fx_rate_date` — the `fx_rates.jpy_php` rate (PHP per 1 JPY)
  captured on the quote, `null` for yen. **Never shown to customers** (owner
  decision 2026-09-18); the order is charged at this rate, not today's.
- `subtotal_settlement`, `shipping_settlement`, `total_settlement` — in the
  settlement currency. For yen they equal the `*_jpy` figures.
- `transfer_region` / `transfer_methods` / `transfer_available` — keyed on the
  settlement currency (PHP → the Philippine accounts). Methods are `[]` while
  reserve-first is on.

**Peso rounding.** Converted once, `PHP = JPY × fx_rate`, rounded **half-up to a
whole peso** (Postgres `round(numeric)`). Shipping is converted on its own and
the items subtotal is the remainder (`subtotal = total − shipping`), so the
three always sum. For a **full payment** the quote uses integer maths that
matches `create_web_order_atomic` exactly, so `total_settlement` is the order's
`total_amount` to the peso. A **layaway** uses the same integer half-up since
2026-09-25 (H3), matching `create_web_layaway_atomic`'s `round(total_jpy *
fx_rate)`; its peso deposit and schedule then come from `layaway_quote`.

**Pay response** (`POST /checkout/pay`, full payment): `order_id`,
`web_reference`, `currency` (`JPY` | `PHP`), `total` (in `currency`),
`total_jpy` (kept for older storefront builds — yen, not what a peso order
owes), `transfer_due_at` (null while a reservation awaits staff),
`transfer_region`, `transfer_methods` (`[]` for a reservation), plus
`reservation_mode` / `awaiting_confirmation` on a reservation. A layaway answers
`mode: "layaway"`, `account_id`, `currency`, `total`, `deposit`, `term_months`,
`schedule`, … as before.

**`GET /orders/:id`**: `currency` is the order's settlement currency;
`total_amount`, `total_paid`, `remaining_balance`, `shipping_fee` are in it.
Item `unit_price_jpy` / `line_total_jpy` are **always yen** — on a peso order
show the pieces without a per-line price and the totals in ₱ (owner decision
D1). The stored rate is not returned.

**Error codes** (`{ error, … }`; `request_id` on RPC refusals):

| code | status | where | meaning |
|---|---|---|---|
| `customer_auth_required` | 401 | all | no/invalid customer JWT |
| `email_unverified` | 403 | all | customer email not verified |
| `email_required_for_account` | 422 | all | auth user has no email |
| `not_linked` | 404 | all | no customer row for this user |
| `bad_mode` | 400 | quote | `mode` not `full` / `layaway` |
| `bad_currency` | 400 | quote | `settlement_currency` not `JPY` / `PHP` |
| `term_required` | 400 | quote | layaway without `term_months` |
| `empty_cart` | 400 | quote | no items |
| `too_many_items` | 400 | quote | over the line limit |
| `bad_order_type` | 400 | quote | not `SELF` / `GIFT` / `PROXY` |
| `address_required` | 400 | quote | no `ship_to_address_id` |
| `address_not_found` | 404 | quote | not one of this customer's addresses |
| `variant_id_required` | 400 | quote | a line without `variant_id` |
| `bad_quantity` | 400 | quote | qty < 1 or not a number |
| `variant_not_found` | 404 | quote | `variant_id` included |
| `product_unavailable` | 409 | quote | product not active; `variant_id` |
| `out_of_stock` | 409 | quote, pay | `variant_id` (+ `available` on quote) |
| `fx_unavailable` | 503 | quote | PHP requested but no usable `fx_rates` row (the daily fetch has never written one, or it is unreadable). Retry later or choose yen; a peso figure is never guessed. |
| `shipping_quote_required` | 400 | quote (layaway), pay | no published shipping rate for the address |
| `below_plan_minimum` | 409 | quote, pay | layaway: amount/term not allowed; `allowed_terms`, `max_term_months` |
| `quote_id_required` | 400 | GET quote, pay | |
| `quote_already_used` | 409 | GET quote, pay | quote consumed — re-quote |
| `quote_expired` | 409 | GET quote, pay | 30-minute life passed — re-quote (the new quote takes the current rate) |
| `quote_not_found` | 404 | pay | not this customer's quote (GET answers a plain 404) |
| `not_yet` | 501 | pay | `method: "square"` |
| `bad_method` | 400 | pay | anything but `transfer` |
| `unsupported_method` | 400 | pay | RPC refusal, same meaning |
| `transfer_unavailable` | 409 | pay | no active account for the quote's currency; `currency`, `region` |
| `fx_rate_missing` | 503 | pay | a PHP quote carries no rate (should not happen: the quote refuses first) |
| `empty_quote` | 400 | pay | total ≤ 0 |
| `variant_missing` | 409 | pay | a quoted variant no longer exists |
| `layaway_not_yet` / `not_a_layaway_quote` / `full_not_layaway` | 501 / 400 / 400 | pay | mode mismatch between quote and writer |

**Retired:** `currency_not_supported_for_full` (400) — was returned for a PHP
full-payment quote until 2026-09-25. The Hub no longer sends it; a storefront
keeps mapping it only as a rollback safety net.

### Service requests

#### GET /me/service-requests
The signed-in customer's requests, newest first: `[{ id, kind, status,
item_title, details, ring_size, cash_order_id, layaway_plan_id, customer_note,
created_at, updated_at }]`. `staff_note` is never returned.

#### POST /me/service-requests
Body `{ kind, details, ring_size?, cash_order_id? | layaway_plan_id?,
item_title? }`. `kind` must be one of `resize`, `cleaning`, `repair`,
`appraisal`, `other`; `details` 1–1000 chars; exactly one of the two ids, and
it must belong to the signed-in customer (404 otherwise). Inserts with status
`requested` and returns the created row in the GET shape. 429
`too_many_open_requests` when the customer already has more than 5 requests in
`requested` status.

See the function source for exact request/response shapes of these routes.

## Newsletter campaigns (staff JWT + `manage_website_content`)

These are Hub endpoints, not storefront routes: they take a staff session, not
`x-api-key`. Campaign mail is sent through the dedicated marketing provider
(Resend, sender `news@news.chajewelsjp.com`), never through the transactional
sender. See `docs/RETROACTIVE-AND-EMAIL.md` for the setup steps and the rate
cap.

### POST /functions/v1/campaign-queue
Body `{ campaign_id, test_email? }`.

- With `test_email`: renders one copy per language the campaign has, subject
  prefixed `[TEST] `, and returns `{ mode: "test", sent, provider: { enabled,
  reason, message, from }, rendered: [{ lang, subject, html, sent }] }`. While
  sending is disabled the HTML is returned and nothing is sent.
- Without: only from status `draft`. Snapshots active subscribers filtered by
  the campaign audience and returns `{ mode: "queued", total, skipped,
  audience }`. 409 `campaign_not_draft` / `sending_disabled`.

### POST /functions/v1/process-newsletter-campaigns
No body. Service-role (cron, every 10 minutes) or a staff session with
`manage_website_content`. Sends up to `newsletter_rate_per_hour / 6` recipients
per run, 5 concurrent, oldest queued campaign first. Returns `{ budget,
rate_per_hour, sent, failed, skipped, rate_limited }`, or `{ skipped: true,
reason, message }` while sending is disabled.

### POST /functions/v1/campaign-cancel
Body `{ campaign_id }`. Queued/sending → `cancelled`, pending recipients →
`skipped`. Returns `{ cancelled: true, skipped }`. 409
`campaign_not_cancellable`.
