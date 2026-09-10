# Website ↔ Vercel Storefront Integration

Written 2026-09-10 from repository source at `823e6e9`. The public storefront
(`cha-jewels-web`, Next.js on Vercel) is a **separate deploy target** from the
Hub. It never touches Postgres directly: it reads through one service-to-server
edge function and is told when to re-render.

Two pipelines, one database:

| | Hub frontend | Storefront |
|---|---|---|
| Repo | `chajewels/la-tracking` (`src/`) | `cha-jewels-web` |
| Host | Firebase Hosting | Vercel |
| Deploys on | push to `main` (`.github/workflows/firebase-deploy.yml`) | its own repo's pipeline |
| Data access | Supabase client, RLS | `website` edge function only |

**Neither pipeline deploys edge functions.** The Lovable IDE is the only
edge-function deploy path (CLAUDE.md → TOOL OWNERSHIP RULES). A green `main`
proves the code in this repo compiles; it does not prove that code is running in
Supabase. Check those separately.

---

## 1. The read path — `website` edge function

Source: `supabase/functions/website/index.ts` (252 lines). One function, routes
on path, so both `/website/x` and `/functions/v1/website/x` resolve.

**Auth:** header `x-api-key` must equal the secret `WEBSITE_API_KEY`.
The check is `if (!expected || apiKey !== expected)` — it **fails closed**, so an
unset secret 401s every request rather than disabling the gate.

**Privacy invariant:** `cost_basis`, `margin` and `commission` are never named in
any `select`. They cannot leak even by accident. Keep it that way — do not add
them to `PRODUCT_FIELDS`.

| Endpoint | Serves | Notes |
|---|---|---|
| `GET /catalog/products` | Listing grid | `?limit=` 1–5000, default 8. Active only, newest first. |
| `GET /catalog/products?fields=…` | Sitemap feed | Allowed fields: `slug`, `updated_at`, `sku`, `name`, `status`. Anything else is dropped, not errored. Use `?fields=slug,updated_at&limit=5000`. |
| `GET /catalog/products/:slug` | Product page | Active only; 404 otherwise. |
| `GET /catalog/collections` | The seven jewelry types | Ordered by name. |
| `GET /catalog/collections/:slug` | Collection + its active products | Ordered by the link table's `sort`. |
| `GET /fx` | `{ jpy_php, as_of }` | 404 when `fx_rates` is empty. |
| `POST /layaway/quote` | Term pricing | Body `{ price, term_months?, currency? }`. `currency` JPY\|PHP, default JPY; `term_months` default 3. Calls the `layaway_quote` RPC. |
| `GET /claims/:code` | Live-sale claim lookup | Code is upper-cased. |
| `POST /claims/:code/checkout` | — | **501 not_implemented.** Phase 2. |
| `POST /loyalty/join` | Signup capture | Body `{ name, contact, region, lang }`. `region` JP\|PH\|OTHER, `lang` ja\|en. Writes `loyalty_signups`. |
| `GET /loyalty/tiers` | Tier ladder | Reads `loyalty_tiers` ordered by `display_order`. Returns `{ slug, name, threshold_jpy, requalify_spend, multiplier, hold_minutes, benefits_ja, benefits_en }`. |
| `POST /auth/customer` | **Customer JWT + API key** | Links or creates the `customers` row for the signed-in user. 409 `email_already_linked` when another auth user owns that email. Does NOT auto-enrol in loyalty. |
| `GET /me` | **Customer JWT + API key** | Profile, addresses, loyalty snapshot, `saved_card` (always false until step 3). 404 `not_linked` before `/auth/customer` has run. |
| `PUT /me/addresses` | **Customer JWT + API key** | Replaces the whole address list via the `replace_customer_addresses` RPC — atomic, so a bad payload leaves the existing list intact. |
| `POST /wholesale/inquiry` | Wholesale form | Body `{ name, business, email, phone?, market, volume, notes?, lang }`. `market` JP\|PH\|BOTH\|OTHER, `volume` TEST\|20_50\|50_200\|200_PLUS, `lang` ja\|en. Writes `wholesale_inquiries`. |

### Customer account routes — two credentials, not one (Phase 2 step 1)

`/auth/customer`, `/me` and `/me/addresses` require **both** `x-api-key` (the
storefront's server-side key, already checked for every route) **and**
`Authorization: Bearer <customer JWT>`. A leaked customer token cannot reach the
Hub without the server key, and the key alone cannot read anyone's profile.

**Linking is by VERIFIED email only.** Same rule as the live
`setup-customer-account`, protected by the existing partial unique index on
`lower(email) WHERE auth_user_id IS NOT NULL`, plus a new partial unique index
on `auth_user_id` itself (one customer per auth user).

Refusals are deliberate, not gaps:

| Response | Why |
|---|---|
| `422 email_required_for_account` | The JWT has no email — a phone-OTP session. See below. |
| `403 email_unverified` | An unverified address would let anyone claim a customer row by signing up with it. |
| `409 email_already_linked` | Another auth user already owns that email's customer row. Also returned when a concurrent request wins the link race — the `UPDATE … .is("auth_user_id", null)` guard makes that a no-op rather than a takeover. |

**Phone OTP is blocked, and it is the plan's stated primary auth.** The plan
(`docs/PHASE2-WEBSITE.md`) specifies phone OTP with email fallback, but a
phone-OTP JWT carries no email and `mobile_number` has no unique index.
Measured 2026-09-10: **863 customers have a phone, only 77 are clean E.164, and
10 groups collide** once digits are normalised. Linking on phone today could
attach a signup to the wrong customer — handing over someone else's order
history and loyalty balance. Shipping it needs an E.164 normalisation pass and
a decision on those 10 collisions first.

**Addresses:** `customer_addresses` (created step 1) is the storefront's source;
the flat columns on `customers` are the Hub UI's and were **not** dropped.

**There is no address data on `customers` to migrate, and the step-1 backfill
that tried was removed.** `address_line1`, `city` and `postal_code` are empty
for every one of the 882 customers; only `location` is populated, and it holds a
**country** (Japan 371, Philippines 139, United States 118, Canada 54, …). The
backfill's `COALESCE(address_line1, city, location)` fallback therefore wrote
871 rows whose street line was a country name, with no postal code and
`is_default` set — which checkout would have preselected. Migration
`20260910160000` deleted them. Real addresses start arriving at checkout in
step 2.

The lesson worth keeping: the pre-check counted
`COALESCE(address_line1, city, postal_code, country)` and got 704, but the
INSERT read `COALESCE(address_line1, city, location)`. The estimate and the
write looked at different columns, so the estimate could not have caught this.
Count the exact expression the write uses.

### Loyalty tier field mapping

`loyalty_tiers` has no `slug` column — the slug is derived from `name`
(lower-cased, non-alphanumerics collapsed to `-`). `threshold_jpy` ←
`min_spend_jpy`, `requalify_spend` ← `requalify_spend_jpy`, `multiplier` ←
`points_multiplier`, `hold_minutes` ← `hold_minutes`.

**Benefits:** `benefits` is a single untagged jsonb **array** in English.
`benefits_ja` (added 2026-09-10, migration
`20260910120000_loyalty_tiers_benefits_ja.sql`) holds the Japanese translation —
same order, same length. It is nullable by design and the route's precedence is:

1. the `benefits_ja` column,
2. a `ja` key inside `benefits`, if that column is ever converted to
   `{ en: [], ja: [] }`,
3. English.

So a tier added later without Japanese copy degrades to English rather than
rendering an empty list. Do not make `benefits_ja` NOT NULL — the fallback is
the point. Keep the two arrays the same length; the storefront renders whichever
the visitor's language selects, one bullet per entry.

**Tier ladder as of 2026-09-10** — the storefront's `lib/loyalty.ts` fallback
must not drift from this:

| Tier | Threshold | Requalify | Multiplier | Hold |
|---|---|---|---|---|
| Glimmer | ¥0 | none | 1x | 60 min |
| Radiant | ¥1,000,000 | ¥500,000 | 2x | 60 min |
| Elite | ¥4,000,000 | ¥2,000,000 | 2x | 60 min |
| Crown VIP | ¥8,000,000 | ¥4,000,000 | 3x | 60 min |

**Hold time is uniform at 60 minutes and is NOT a tier benefit.** The storefront
briefly advertised an escalating hold (3h / 12h / 24h) that no tier has ever
had; never reintroduce per-tier hold copy.

**No revalidation trigger covers `loyalty_tiers`.** The five triggers in §2 are
on the `website_*` tables only, so a tier edit does not notify the storefront.
`/loyalty` picks up changes when its own 300-second ISR window expires; the
`catalog` tag that `/api/revalidate` clears does not cover the `loyalty` tag the
tiers fetch uses. A tier edit is therefore visible within five minutes, not
instantly — acceptable today, but worth knowing before anyone reports the page
as stale.

### Wholesale inquiries

`wholesale_inquiries` is written by the service-role client inside this function.
RLS grants **no** `anon` access; `authenticated` may only `SELECT`, gated on
`public.has_permission(auth.uid(), 'manage_website_catalog')`. There is no
insert, update or delete policy — the public form's only path in is this
endpoint. Staff read submissions in the Hub under **Website Catalog → Wholesale
inquiries** (read-only list).


### Currency — peso is never stored

`fx_rates` holds one row per day: `jpy_php` = **PHP per 1 JPY**, the same
direction as `system_settings.php_jpy_rate`. Written daily by the
`fetch-fx-rate` edge function (pg_cron `daily-fx-rate`, `45 0 * * *` =
**08:45 PHT**, deliberately after the account pipeline so it never competes with
it; Vault-backed auth per the CRON AUTH RULE).

The `website` function derives the peso figure **per request**:

```
price_php = round(price_jpy × jpy_php)
```

There is no stored peso column — `price_php` and `description_tl` were dropped
from `website_products` in migration `20260908121000`. Never reintroduce a
stored peso price: a second copy of every price is a second thing to drift.

> This is the JPY→PHP direction of the CLAUDE.md currency standard
> (`PHP = JPY × rate`). The inverse (`JPY = PHP ÷ rate`) is unchanged and still
> governs every account calculation.

### Catalog vocabulary

- **Metals** (`website_product_karat`): `K18`, `K14`, `K10`, `PT1000`, `PT950`,
  `PT900`, `SILVER925`. `K18` is the single value for Au750 / 18K — never
  `750`, `Au750` or `18K` as separate options.
- **Collections** are jewelry types: necklaces, pendants, earrings, bracelets,
  rings, anklets, sets.
- **Terminology guard:** the `reject_forbidden_gold_terms()` trigger raises on
  country-branded gold (`japanese gold`, `saudi gold`, `italian gold`,
  `dubai gold`, `hk gold`, `chinese gold`) in `name`, `description_en` or
  `description_ja`. Use "K18 gold, Made in Japan". The
  `translate-product-description` prompt mirrors this ban, and its output is
  regex-checked before it is stored.

---

## 2. The write path — how a staff edit reaches the site

```
staff edit
  → website_products / _variants / _media / _collection_products / website_collections
  → trigger notify_website_revalidate()          [Postgres, SECURITY DEFINER]
  → POST /functions/v1/notify_website            [pg_net, Vault-backed bearer]
  → POST ${WEBSITE_URL}/api/revalidate           [x-revalidate-secret]
  → revalidatePath / revalidateTag               [Next.js on Vercel]
  → page re-renders, refetching from `website`
```

### Trigger — `notify_website_revalidate()`

Attached to all five tables (`trg_website_products_revalidate`,
`…_variants_…`, `…_media_…`, `…_collection_products_…`,
`…_collections_…`), `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW`.

It resolves slugs from `COALESCE(NEW.…, OLD.…)`, so a **DELETE still notifies
with a real slug** rather than a null. Media rows resolve their product through
`website_product_variants`. The service key comes from
`vault.decrypted_secrets` (`email_queue_service_role_key`) — never embedded.
It posts only when at least one slug resolved.

`EXECUTE` is revoked from `anon`, `authenticated` and `PUBLIC`.

### Relay — `notify_website` edge function

Service-role only (`requireAuth(..., { allowServiceRole: true })`, then an
explicit `ctx.isService` check). Forwards `{ productSlug?, collectionSlug? }`.

**Status codes are the health signal — never return 200 on a failure.**

| Code | Meaning |
|---|---|
| `500` | `WEBSITE_URL` and/or `REVALIDATE_SECRET` unset. Response names which in `missing[]`. |
| `502` | Storefront rejected the call (`revalidate_rejected`, carries its status) or was unreachable. |
| `200` | Storefront accepted the revalidation. |

This matters because the caller is a trigger using `PERFORM net.http_post(...)`,
which is **fire-and-forget**. A misconfiguration does *not* block the catalog
write and does *not* surface in the Hub UI — the write commits either way. The
only trace is this function's log line and the row pg_net records:

```sql
-- Revalidations that did not reach the storefront
SELECT created, status_code, content
FROM net._http_response
WHERE status_code <> 200
ORDER BY created DESC
LIMIT 50;
```

Until 2026-09-10 a missing `WEBSITE_URL` returned
`{ skipped: true, reason: "not_configured" }` with **HTTP 200**. The trigger was
satisfied, pg_net logged a success, and the only symptom was a catalog that
silently stopped updating. That is why the codes above are non-negotiable.

### Storefront contract — `POST /api/revalidate`

Verified against the storefront 2026-09-10.

```
POST ${WEBSITE_URL}/api/revalidate
Header:  x-revalidate-secret: <REVALIDATE_SECRET>
Body:    { "productSlug"?: string, "collectionSlug"?: string }
```

Revalidates:

| Target | When |
|---|---|
| `/` | always |
| `/products/[slug]` | when `productSlug` is present |
| `/collections/[slug]` | when `collectionSlug` is present |
| tag `catalog` | always |

Both keys are optional and either may arrive alone — `notify_website` builds the
payload with `jsonb_strip_nulls` upstream and only includes keys that resolved.
A change to a collection **link** row sends both.

**If either side of this contract changes, both must change together.** The path
shapes (`/products/[slug]`, `/collections/[slug]`) and the `catalog` tag live in
the storefront repo; the payload keys live in `notify_website_revalidate()` and
`notify_website` here.

---

## 3. Secrets

Three secrets gate the whole integration. None is a code change.

| Secret | Set where | If unset |
|---|---|---|
| `WEBSITE_API_KEY` | Supabase function secret **and** Vercel env — identical value | `website` returns `401 unauthorized` to every request. Loud: the storefront shows nothing. |
| `WEBSITE_URL` | Supabase function secret | `notify_website` → **500**, `missing: ["WEBSITE_URL"]`. No trailing slash (the relay strips exactly one). |
| `REVALIDATE_SECRET` | Supabase function secret **and** Vercel env — identical value | `notify_website` → **500**. |

### Verifying a secret is set

**Do not trust a secrets listing — verify by behaviour.** Lovable's reporting of
Supabase *function* secrets has been wrong at least once: `WEBSITE_API_KEY` was
reported unconfigured and was subsequently **confirmed set by curl**
(2026-09-10). A listing that omits a secret is not evidence the secret is
missing.

```bash
# WEBSITE_API_KEY — 200 with a rate proves the key, the function and the cron
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "x-api-key: $WEBSITE_API_KEY" \
  https://<project>.supabase.co/functions/v1/website/fx
# 200 = set and correct · 401 = unset or mismatched
```

`WEBSITE_URL` / `REVALIDATE_SECRET` are verified by the end-to-end test in §4 —
or immediately by any `net._http_response` row with `status_code = 500`.

---

## 4. Go-live checklist

1. **Set the three secrets.** Supabase first, Vercel to match. Verify
   `WEBSITE_API_KEY` with the curl above rather than a listing.
2. **Smoke the read path.** `GET /fx` with the key. A 200 with a rate proves
   auth, routing and the FX cron in one call.
3. **Confirm the storefront handler** still matches the contract in §2.
4. **Prove the loop.** Change one product name in the Hub; the page updates
   without a redeploy. Then confirm `net._http_response` logged a 200 for it.
   Until this has been seen once, the pipeline is designed, not working.

---

## 5. CI coverage

`supabase/functions` is under a blocking Deno gate as of `823e6e9` (job
`edge-functions`, config `development/deno.ci.json`). `website`,
`notify_website` and `fetch-fx-rate` are all covered by both steps — see
`docs/PENDING.md` for the gate's operating manual and its limits.

It is a **detection** gate on `main`, not a prevention gate on the deploy.
