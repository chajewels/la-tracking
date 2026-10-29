# Catalog delete — verification plan (review 2026-10-29, BUG-04)

Status: REVIEW ONLY. No code change in this document's PR beyond the plan itself. Nothing here is
run against live; every live step below is for the OWNER to run (read-only first, then one
disposable test product). Never delete B2200 or any other real product as a test.

Reviewed (repo `develop` 05c55a77 + this branch): `delete_website_product_atomic` in
`supabase/migrations/20270220100000_page365_follow_and_catalog_delete.sql` §9,
`src/lib/catalog-delete.ts`, `src/components/website/ProductsCard.tsx` (`remove`, line ~688; the
trash button, line ~1013), `assert_staff_caller` (20261130160000), plan §1.4–1.5 / §2.4 in
`docs/PAGE365-FOLLOW-AND-DELETE-PLAN.md`, local tests §7–§9 of
`docs/sql/20270220_page365_follow_local_tests.sql`.

## 1. What the deployed path does (as read)

`ProductsCard` → trash button (rendered only when `canManage` =
`can("manage_website_catalog") || isAdmin`) → browser `confirm(deleteConfirmText(...))` →
`deleteWebsiteProduct(id)` → `callUntypedRpc('delete_website_product_atomic', {p_product_id, p_reason:
null})` → one SECURITY DEFINER transaction:

| Step | Statement | Safeguard |
|---|---|---|
| 1 | `assert_staff_caller('manage_website_catalog')` | API caller must hold the permission (service_role passes; a session with no JWT — SQL Editor — passes by design) |
| 2 | `SELECT … FOR UPDATE` the product | plain "This product no longer exists." when gone |
| 3 | `website_live_claims` with status `held / paid / layaway` on any of its variants | REFUSE: "This piece has an active live-selling claim." (the FK is NO ACTION, so the refusal is the only readable message) |
| 4 | delete the product's `expired / released` claims | otherwise the NO ACTION FK would block |
| 5 | snapshot reviews into `product_review_detached` (both link kinds) | only for a Page365-linked product |
| 6 | `DELETE page365_inventory_items WHERE kind='hub_only' AND website_product_id = …` | the real cause of "delete fails" (CHECK `page365_inventory_item_kind`) |
| 7 | count `page365` item rows and order/layaway/draft lines | reported, not changed |
| 8 | `INSERT audit_logs ('website_product_deleted', old = sku/name/status/listing, new = reason + counts, performed_by = auth.uid())` | audit BEFORE the delete, same transaction |
| 9 | `DELETE FROM website_products` | FKs as live: SET NULL on `cash_order_items`, `layaway_account_items`, `web_order_draft_lines`, `page365_stock_lines`, `page365_inventory_items`, `page365_landings.variant_id`, `review_invites`, `product_reviews`; CASCADE on variants, media, collection/category links, presence, landings, cart lines, `product_review_products` |

Grants: `authenticated, service_role` EXECUTE; `PUBLIC, anon` revoked; the self-check of the
migration asserts both. Statement budget for `authenticated`: 8 s (`statement_timeout`), helped by
`idx_page365_inventory_items_product`.

## 2. Findings

1. **Permission is enforced twice** (button + RPC). Correct. But the local harness replaces
   `assert_staff_caller` with a no-op (`20270220_page365_follow_local_stub.sql`), so **no local test
   proves the refusal** of a staff member without `manage_website_catalog`. See §4 M1.
2. **An ACTIVE (published) product can be deleted** with the same one-line `confirm()`. The plan did
   not ask for a publish guard; the storefront revalidates by trigger and the page 404s. Owner
   decision whether "published → hide first" should be required (not implemented; noted only).
3. **Orders / layaway / drafts** keep their own saved code / name / price and lose only the product
   link (FK SET NULL). Money, loyalty basis and invoices never read the product row (plan §1.5).
   The repo-side join audit promised in plan §1.5 ("UNVERIFIED until build") was not found in
   `docs/`; see §4 M6.
4. **Audit row** carries `performed_by_user_id = auth.uid()` — NULL when run from the SQL Editor
   (expected: the owner's run is the test, and the reason text says so).
5. **Live-claim statuses** `held / paid / layaway / expired / released` match the enum in
   `20260908030829_…sql`; whether live carries other values is UNVERIFIED (read-only query in §3.1).
6. **`product_review_detached` rows linger** when the listing never lands again (no TTL). Harmless
   (small table, FK CASCADE from `product_reviews`); noted.
7. **Page365-linked product still in stock on Page365**: the next complete read lands a FRESH
   UNPUBLISHED draft (new product id, new slug) and restores the reviews — the confirm text says
   so. Hidden consequence: hero picks, collections and category links are gone (CASCADE) and are
   not restored. The confirm text does not mention that; owner decision.
8. **Failure modes are atomic**: any RAISE rolls the whole function back (one transaction), so a
   refused delete leaves no audit row and no detached reviews. Correct.

## 3. End-to-end verification — local first, then one disposable product on live

### 3.1 Read-only on live (owner, SQL Editor) — BEFORE anything else
```sql
-- the deployed body is the shipped one
SELECT md5(p.prosrc), length(p.prosrc) FROM pg_proc p
 WHERE p.oid = to_regprocedure('public.delete_website_product_atomic(uuid,text)');
-- claim statuses actually present (expected subset of held/paid/layaway/expired/released)
SELECT status::text, count(*) FROM public.website_live_claims GROUP BY 1;
-- the index exists and is partial
SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_page365_inventory_items_product';
-- grants
SELECT has_function_privilege('anon', 'public.delete_website_product_atomic(uuid,text)', 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', 'public.delete_website_product_atomic(uuid,text)', 'EXECUTE') AS auth_can;
```
Expected: md5 = the value recorded at the apply; `anon_can = false`, `auth_can = true`; index present.

### 3.2 Local SQL harness (already automated — run on every change)
Sequence in `docs/sql/20270220_page365_follow_local_stub.sql` header (stubs → migrations →
`…_follow_local_stub` → `…_seed` → `20270220100000` ×2 → `20270221100000` ×2 → `…_local_tests.sql`).
Delete checks that EXIST today (§7–§9 of the tests file, all passing, 2026-10-29):
- (a) a product WITH `hub_only` rows: plain `DELETE` reproduces the live CHECK failure; the RPC
  succeeds, removes ONLY its own `hub_only` rows, audits, returns the count.
- (b) HELD / PAID / LAYAWAY claim → refused with the plain message, nothing changed; EXPIRED +
  RELEASED claims → cleared (count 2), delete succeeds.
- (c) a normal linked product: `kind='page365'` item rows stay with NULL links (CHECK satisfied);
  a `cash_order_items` line and a `web_order_draft_lines` line keep code / name / price with the
  link cleared; `order_lines_unlinked = 2` reported.
- (d) the partial index exists and the planner uses it for the SET NULL lookup.
- §8: three reviews (both links / primary only / join-table only) remembered by listing, survive
  the delete, come back EXACTLY as before when the listing lands again as a fresh unpublished
  draft; consumed `product_review_detached` rows removed; a Hub-only product writes no rows.
- §9: `anon` cannot execute, `authenticated` can (guarded inside).

### 3.3 Disposable test product on live (owner) — never a real product
1. In Hub → Website → Products create **`ZZTEST-DEL-1`** (Hub-only, draft, origin JAPAN, one
   variant, price 1 JPY, stock 0, name `ZZTEST-DEL-1 Delete test — not for sale`). Do NOT publish.
   Do NOT give it a Page365 link (so no listing can re-land it).
2. Make it own a `hub_only` row: wait for one complete scheduled read (≤ 10 min) and check
   `SELECT count(*) FROM page365_inventory_items WHERE kind='hub_only' AND website_product_id = <id>;`
   → ≥ 1 (this is exactly the shape that used to fail).
3. Optional, to exercise the order-line path WITHOUT customer data: do NOT create an order. Observe
   `order_lines_unlinked = 0` instead. (A real order line would touch customer data — out of scope.)
4. Delete it from the Products card as a staff user WITH `manage_website_catalog`. Observe:
   - toast "Product removed" (no description, since nothing was unlinked), row gone, within the 8 s
     budget (note the time);
   - `SELECT * FROM audit_logs WHERE action='website_product_deleted' ORDER BY created_at DESC LIMIT 1;`
     → old_value sku `ZZTEST-DEL-1`, new_value `hub_only_removed ≥ 1`, `performed_by_user_id` = the
     staff user;
   - `SELECT count(*) FROM page365_inventory_items WHERE website_product_id = <id>;` → 0;
   - `/products/<slug>` on the storefront → 404 (it was never published; this only proves the
     revalidation trigger did not error).
5. Permission: as a staff user WITHOUT `manage_website_catalog`, the trash button must not render;
   and a direct call `supabase.rpc('delete_website_product_atomic', {p_product_id: <another ZZTEST id>})`
   from the browser console must fail with `not allowed` (42501). Use a second disposable product
   `ZZTEST-DEL-2` for this, then delete it as the catalog user.
6. Live-claim refusal is proved locally only (3.2 b); on live, do not create a claim.
7. Rollback: a disposable product needs none. If a REAL product were ever deleted by mistake:
   `audit_logs` has sku / name / status / listing ids; a Page365-linked piece still in stock comes
   back as a fresh draft on the next read (reviews restored; collections / category / hero links
   must be re-set by hand); a Hub-only piece must be re-created by hand from the audit row and the
   order lines' saved code / name / price. There is no "undelete" and this plan does not add one.

### 3.4 What to observe over the next 3 reads after a Page365-linked delete (if the owner tests one)
Only with a disposable Page365 listing (none exists today — skip unless the owner creates a test
listing on Page365 with a `ZZTEST` code): a fresh draft lands, `first_published_at IS NULL`, reviews
return both ways, no bell.

## 4. Checks MISSING from the local suite today (candidates, in priority order)
- **M1 permission refusal** — the stub's `assert_staff_caller` is a no-op. Add a local variant that
  installs the real body from 20261130160000 and sets
  `request.jwt.claims` to `{"role":"authenticated","sub":"<uuid without the permission>"}` → expect
  `42501`; with the permission → success; with `role=service_role` → success.
- **M2 `layaway_account_items` line** — only cash + draft lines are tested; add a layaway line and
  assert code / name / price kept, link NULL, counted.
- **M3 CASCADE relations** — assert `website_collection_products`, `website_category_products`,
  `page365_product_presence`, `page365_landings.product_id`, `customer_cart_lines` rows are gone and
  `website_product_media` rows gone (storage objects untouched — by design).
- **M4 an ACTIVE product** — delete succeeds today; pin the behaviour the owner chooses (allow, or
  require draft first).
- **M5 sync-disabled product** — delete with `page365_sync_disabled = true`; no `detached` rows
  when unlinked; and a linked + switched-off product must NOT re-land (land_run reads the switch).
- **M6 join audit** — a repo grep of every join from `cash_order_items / layaway_account_items /
  web_order_draft_lines` to `website_product_variants / website_products` (plan §1.5 promised it in
  the PR; not found in `docs/`). Readers that assume a non-NULL link would break after a delete.
- **M7 re-land after re-code** — delete, then the listing comes back with a NEW code: reviews are
  attached by listing id (not code) — assert it.
- **M8 `product_review_detached` for a listing that never returns** — document or add a TTL
  (owner decision).
- **M9 double delete race** — two staff click Remove at once: the second gets "This product no
  longer exists." (FOR UPDATE then NOT FOUND) — assert with two sessions, or accept as read.

## 5. Owner decisions needed
1. Delete of a PUBLISHED product: allow as today, or require hide first (M4).
2. Confirm text: mention that collections / categories / hero picks are not restored for a
   re-landed piece (finding 7).
3. Whether `product_review_detached` rows should expire (M8).
