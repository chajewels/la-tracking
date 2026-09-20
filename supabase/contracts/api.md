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

See the function source for exact request/response shapes of these routes.
