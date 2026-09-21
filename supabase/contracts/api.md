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
product_media: [{ url, alt }] }], category_slugs: string[] }`

- `price_php` is derived per request from the latest `fx_rates` row
  (`PHP = JPY × rate`); `null` when no rate is on file. Never stored.
- `category_slugs` lists the published categories the product belongs to;
  empty array when uncategorised. Present on `/catalog/products` and
  `/catalog/collections/:slug` (and `/catalog/categories/:slug`) results.

## Testimonials

### GET /testimonials
Published testimonials (`published = true`), ordered by `sort_order` ascending
then `created_at` descending: `[{ id, customer_name, location, quote_en,
quote_ja, item, rating }]`. Returns `[]` when there are none — never an error.

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
Body `{ price, term_months, currency }` (JPY or PHP). Proxies the
`layaway_quote` RPC: the plan schedule a checkout would create.

## Claims (live selling)

### GET /claims/:code
`{ id, code, price_locked, status, expires_at, product_variant_id }`; 404 when
the code is unknown.

## Customer-scoped routes (customer JWT + x-api-key)

- `GET /me` — customer profile plus loyalty snapshot.
- `GET /orders` / `GET /orders/:ref` — cash orders, own only.
- `GET /layaway` / `GET /layaway/:ref` — layaway plans, own only, with schedule.
- `GET/POST/PUT/DELETE /addresses` — the customer's address book.
- `POST /checkout/quote` — reserves an invoice number and prices a cart.
- `POST /checkout` — creates the order (`create_web_order_atomic` /
  `create_web_layaway_atomic`).

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
