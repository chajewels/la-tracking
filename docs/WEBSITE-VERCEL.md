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
