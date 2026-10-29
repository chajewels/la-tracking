# Page365 follow (code / name / photos) + Catalog delete — PLAN (awaiting owner approval)

Status: PLAN ONLY (revision 2, 2026-10-29). Nothing built, committed, migrated or deployed.
Source read: `git fetch` + `git show origin/main:<path>`; live facts from the owner's read-only query pack run 2026-10-29 13:45 JST (§9).
Next Hub PR: branch off `develop`, PR base `develop`. Edge-function deploy = a SEPARATE Lovable deploy-only step after merge.

## 0. What changed since revision 1
- Live results arrived: every function md5 matches what the plan expects (§9). The "repo ≠ live, FKs are NO ACTION" premise was **wrong** (`n` = SET NULL). **No FK changes at all** (old §3 step 1 deleted).
- Real cause of the delete failure found (§1.4): a CHECK constraint on `hub_only` rows, not an FK. Delete RPC now removes those rows first; a missing index is added.
- History is retained since 2026-09-25 (not 14 days). `page365_listing_names` stays (owner-approved), seeded from the full history.
- Reviews: restore both `product_review_products` AND `product_reviews.website_product_id` (§2.4).
- Re-code slug rule, link backfill (now IN this PR), extra tests.

## 1. Findings (repo origin/main + live)

### 1.1 Why a re-coded listing is stranded (N1073 → N9140) — unchanged
- `page365_inventory_finish` step (b) matches **only** by `page365_match_line(code)` = exact `page365_first_word(website_products.sku)`; it never uses `website_products.page365_product_id / page365_variant_id`.
- Listing 80622155 is N9140 on Page365; the Hub product is still sku N1073, draft, linked to 80622155 (live, §9.3). No Hub sku has first word N9140 → `unmatched` / `new`.
- `page365_inventory_land_run` (`20261005100000`, ~line 320) then hits `wp.page365_product_id = … AND wp.page365_variant_id = …` → `result_note='already_landed'`, skipped, no bell.
- Same blind spot: a published linked product whose code changed looks "missing" to hide-follow and can be auto-hidden after 2 complete reads.

### 1.2 Name / sku / photos are never followed — unchanged
- `apply` / `auto_apply_run` write stock only; `hide_item` writes stock 0 + draft. Nothing writes `website_products.name/sku/name_ja`.
- `_shared/page365-photo-copy.ts copyItemPhotos` only **adds/replaces** (key = variant + photo id + version); it never reorders; `photos_removed` is counted in finish (d) but nothing deletes. Scheduled `copyLandedPhotos` runs only for `page365_landings.photos_done_at IS NULL`. `record_photo` already protects staff photos (`page365_photo_id IS NULL`).
- Following by listing id needs `website_products.page365_product_id`: **458 of 463 are linked** (live §9.4). The 5 unlinked are handled in §2.5.

### 1.3 History is long enough — but a durable table is still right
Live: runs since 2026-09-25 (2,137 runs), 878,863 item rows, last pruned 2026-10-29 01:02 UTC (§9.5). So item history is **not** limited to 14 days. `page365_listing_names` (owner-approved) is kept as the explicit, indexed memory of "the Page365 name the Hub last saw"; it is **seeded from the full history** so every Used/Preloved flip since 2026-09-25 is in `seen_names`. Future pruning cannot erase it.

### 1.4 REAL cause of "Delete fails for every product" (replaces rev-1 §1.4)
- Live CHECK `page365_inventory_item_kind` on `page365_inventory_items`:
  `(kind='page365' AND page365_product_id IS NOT NULL AND page365_variant_id IS NOT NULL AND inventory_product_id IS NOT NULL) OR (kind='hub_only' AND page365_product_id IS NULL AND website_product_id IS NOT NULL)`.
- Deleting a product makes the FK `SET NULL` its `website_product_id` on its `kind='hub_only'` rows → they violate the second branch → the whole delete fails. (`kind='page365'` rows survive SET NULL: their branch does not need `website_product_id`.)
- 11 products have `hub_only` rows — N1073, 8C100, B2200, N4032, P1421, P2578, R3604, R3701, R6613, R8505, N4020 — exactly the stale ones staff want to delete. The other 452 have none and delete fine today.
- Speed: there is **no index** on `page365_inventory_items(website_product_id)` (only variant_id partial, run, listing, inventory_product, pkey, two uniques), so each delete's SET NULL scans 878k rows; `authenticated` has `statement_timeout` 8 s / `lock_timeout` 8 s. A second reason the delete can time out.
- `ProductsCard.tsx:687-696` `remove` does a plain `.delete()`; confirm text ≈ line 1018.

### 1.5 Delete relations — LIVE (all verified, §9.2). No FK is changed.
| Relation | Live action | Plan |
|---|---|---|
| `cash_order_items`, `layaway_account_items`, `web_order_draft_lines` (variant_id, website_product_id) | SET NULL | unchanged — lines keep their own code/name/price |
| `page365_stock_lines`, `page365_inventory_items` (variant_id, website_product_id) | SET NULL | unchanged **but** `hub_only` rows must be deleted first (§1.4) |
| `page365_landings.variant_id` | SET NULL | unchanged |
| `review_invites.website_product_id`, `product_reviews.website_product_id` | SET NULL | unchanged; snapshot + restore (§2.4) |
| `website_product_variants`, `website_product_media`, `website_collection_products`, `website_category_products`, `page365_product_presence`, `page365_landings.product_id`, `customer_cart_lines.variant_id`, `product_review_products.website_product_id` | CASCADE | unchanged (a cart line of a deleted piece disappears; presence is rebuilt by the next read) |
| `website_live_claims.product_variant_id` (NOT NULL, 0 rows live) | NO ACTION | **left NO ACTION on purpose**: a live-selling claim must block deleting its piece; the RPC refuses first with a plain message |

Reports / loyalty / accounting: money, `loyalty_jpy_amount`, totals and invoices live on the order tables and never read the product row; order-line display uses the line's own saved code/name/price. Only product-link features lose the link (stock return on cancel already tolerates a NULL variant). During the build I grep every join from the three line tables to `website_product_variants`/`website_products` and list them in the PR — **UNVERIFIED until then**.

Website cache: revalidation is **per-statement** triggers (`trg_website_products_revalidate_ins/_upd/_del`, `20261230200000_catalog_revalidate_per_statement.sql`, line 133-135; the per-row triggers of `20260908030829` were replaced). A delete already revalidates; checked in §10.

## 2. Design

### 2.1 Durable memory: `page365_listing_names`
```
page365_listing_names(
  website_product_id uuid PRIMARY KEY REFERENCES website_products(id) ON DELETE CASCADE,
  page365_product_id bigint, page365_variant_id bigint,
  last_p365_name text,       -- Page365 name at the last complete read
  seen_names     text[],     -- every distinct Page365 name seen for this listing (cap 30)
  bell_name      text,       -- the Page365 name we last rang a bell about (ONE bell per change)
  ja_pending     boolean NOT NULL DEFAULT false,
  updated_at     timestamptz)
```
RLS: staff read (`manage_website_catalog`); service_role writes; REVOKE PUBLIC/anon/authenticated. Seeded in the migration from the full `page365_inventory_items` history (distinct `page365_name`/variant text per `website_product_id`, oldest first). Comparison = lower, whitespace (incl. `chr(12288)`, `chr(160)`) collapsed, trimmed. **Never a literal U+3000/NBSP in SQL — `chr()` only.**

### 2.2 `page365_inventory_follow_listing(p_run_id uuid)` (service_role, SECURITY DEFINER)
Called from `page365_inventory_finish` as step **(a3)** before (b) and step **(h)** after (g), each in `BEGIN … EXCEPTION WHEN OTHERS` (a failure never fails the read). Only a complete, `ready`-bound run; a partial read changes nothing. `page365_sync_disabled` products: never.

- **(a3) re-code:** for each `kind='page365'`, `match_result='pending'` item whose `(page365_product_id, page365_variant_id)` equals exactly one non-sync-disabled `website_products` row (unique index `uq_website_products_page365_source`) and `page365_first_word(listing text) <> page365_first_word(wp.sku)`:
  - new code already used by **another** Hub product → no write, bell `page365_recode_blocked` once (dedup `bell_name`), item flagged `code_exists_other_piece`.
  - else set `sku` and `name` (code word swapped, rest kept); `page365_product_presence.code` updated in the same statement so hide-follow never sees "missing"; audit `page365_code_followed`; `page365_listing_names` updated. Step (b) then matches it by the new code like any row. The duplicate-code steps (a)/(a2) are **not edited**; a3 only sees `pending` rows.
  - **Slug (F):** if the product has **never been published** → regenerate the slug from new code + name with the exact land_run recipe (`left(btrim(regexp_replace(lower(code||'-'||name-minus-code),'[^a-z0-9]+','-','g'),'-'),90)`, suffix `-<variant_id>` on collision). If it has ever been published → slug untouched (public URLs and caches stay valid).
  - **How "ever published" is told:** there is **no** published column today (status only; the bulk-publish RPC writes audit `website_product_published`, a manual save does not). So the migration adds `website_products.first_published_at timestamptz` + `BEFORE UPDATE OF status` trigger that stamps it once when status first becomes `'active'` (never cleared), and **backfills** it from evidence: current status ≠ `draft`; or an audit row `website_product_published`; or an audit `page365_inventory_hidden` (old status `active`); or any `cash_order_items / layaway_account_items / web_order_draft_lines / customer_cart_lines` reference. A draft with none of that is `NULL` = never published. Backfill is conservative (unsure → treated as published → slug kept). The PR lists the backfill counts. Trigger must sort after the revalidate/terminology triggers' needs (BEFORE, no table writes).
- **(h) name follow** — compare **Page365-now vs `last_p365_name`** (never vs the Hub name):
  1. unchanged → nothing.
  2. changed, and the Hub name (after swapping the code word) is **exactly a name in `seen_names`** (never completed) → copy the new Page365 name, `ja_pending=true`, `name_ja=NULL` (storefront falls back to English), audit `page365_name_followed`.
  3. changed, Hub name not in `seen_names` (staff completed it, or Hub name longer than Page365's 80-char cap) → **keep the Hub name**; ONE bell `page365_name_changed` (only if `bell_name` ≠ new Page365 name) showing Page365 old → new and the Hub name.
  4. always append the new name to `seen_names`, set `last_p365_name`.
  A Hub-completed name is never overwritten.
- **Price:** untouched; `price_differs` (finish (c)) shows it for staff approval.
- **Photos (SQL half):** only when the listing's photo array is **non-empty**; Page365-origin media only (`page365_photo_id IS NOT NULL`): `DELETE` rows whose photo id left Page365 (audit `page365_photo_removed`; storage object left, a sibling variant may share it), `UPDATE sort = base + position` for the rest (same staff-photo base as `record_photo`). Staff photos untouched. Added/replaced photos: existing copier, §7.

### 2.3 Bells
`page365_name_changed`, `page365_recode_blocked`, and one `page365_names_followed_summary` for the one-time pass (§4). Dedup by `bell_name`; a stable difference rings once.

### 2.4 Delete — `delete_website_product_atomic(p_product_id uuid, p_reason text)` (SECURITY DEFINER; `assert_staff_caller('manage_website_catalog')`; audit row)
1. `SELECT … FOR UPDATE` the product (not found → plain message).
2. **Live claim guard (B):** if any `website_live_claims` row exists for its variants → refuse: "This piece has an active live-selling claim." (Matches the NO ACTION FK; any status, since statuses are not verified.)
3. **Snapshot reviews (E)** into new `product_review_detached(review_id, page365_product_id, page365_variant_id, was_linked boolean, was_primary boolean, detached_at)` — one row per review found in **either** place: `product_review_products` (was_linked) and `product_reviews.website_product_id = product` (was_primary). Written only when `page365_product_id IS NOT NULL`; a Hub-only product writes none.
4. **`DELETE FROM page365_inventory_items WHERE kind='hub_only' AND website_product_id = p_product_id`** (B) — they only record "not in Page365"; count returned.
5. `DELETE FROM website_products WHERE id = …` (FKs unchanged; the new index makes SET NULL cheap; revalidate triggers fire).
6. Return `{hub_only_removed, items_unlinked, order_lines_unlinked, reviews_detached}`.
The browser calls the RPC instead of `.delete()`. Grants: `authenticated` EXECUTE with the in-function guard; REVOKE PUBLIC/anon re-asserted.

**Which review link each reader uses (cited):**
- Storefront product page: `supabase/functions/website/index.ts:4500-4502` filters by **`product_review_products`** (`.eq("website_product_id", productId)`), then `listQ.in("id", reviewIds)`. The per-review `product` badge (`:4492`, embedded via `product_reviews_website_product_id_fkey`, shown only when `prod.status === "active"`) uses **`product_reviews.website_product_id`**.
- Hub `ReviewsCard.tsx:68-69` reads **both** (`product:` via the `product_reviews` FK and `links:product_review_products`); badge fallback to the primary product at `:306`.
→ Restoring only one leaves either the product page empty or the badge/Hub wrong, so **both** are restored.

**Re-land:** when Page365 still lists the piece in stock, the next complete read has no Hub product for the listing; (a3) finds nothing; `land_run` creates a **fresh unpublished draft** with Page365's current name, code, photos (existing rules: in-stock only, never auto-publish). One added block in `land_run`, right after the product insert: for `product_review_detached` rows matching `(page365_product_id, page365_variant_id)` → `INSERT INTO product_review_products … ON CONFLICT DO NOTHING` where `was_linked`, `UPDATE product_reviews SET website_product_id = v_pid WHERE id = review_id AND website_product_id IS NULL` where `was_primary`; then delete the consumed rows. Attach is by Page365 listing id, not by code (a re-coded piece still gets its reviews). Rest of `land_run` byte-identical to live.

### 2.5 Link backfill — IN this PR (G)
Candidates = `website_products` with `page365_product_id IS NULL`, not `page365_sync_disabled`, whose `page365_first_word(sku)` equals the code of **exactly one** `kind='page365'` item in the **latest ready full run**, and that listing/variant is not already linked to another product. Today: **N1616, R7828, R3341** (all active, matched by code every read — 131× in 24 h). Never linked: **8C100** (Hub-only, not in Page365) and **N4020** (owner: website sample, never synced). The migration's self-check **raises if the candidate set differs from the dry-run list approved in the PR**, so N4020/8C100 cannot slip in; and I recommend N4020 gets the Catalog "Don't sync with Page365" switch (audited, via the UI — not SQL). The backfill sets only `page365_product_id`, `page365_variant_id` (+ seeds `page365_listing_names`); no stock/name/price/status change. **PR contains the dry-run SELECT and its 3-row result first.**

## 3. Migration plan (one NEW file; timestamp assigned at build)
`supabase/migrations/<ts>_page365_follow_and_catalog_delete.sql` — no `BEGIN/COMMIT`. **No FK changes.**
0. md5-guarded DO pre-flight against the **live md5s in §9** (finish `a697a6d3…`, land_run `7f27675e…`, match_line, first_word, auto_apply_run, follow, hide_item, apply, record_photo, store_product, retention); refuses if any differs.
1. **Index (C):** `CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_product ON public.page365_inventory_items (website_product_id) WHERE website_product_id IS NOT NULL;` — plain `CREATE INDEX` (`CONCURRENTLY` cannot run inside the migration's DO/transaction). Plain build takes a write lock on the table for its duration; on 878,863 rows I expect **seconds to low tens of seconds (estimate, not measured)**, and only the partial rows (those with a product id) are indexed. Apply it just after a scheduled read finishes (reads run every 5–10 min) with `SET LOCAL lock_timeout`/`statement_timeout` raised in the file; if a read lands mid-build it simply waits.
2. `website_products.first_published_at` + trigger + backfill (§2.2).
3. Tables: `page365_listing_names` (+ seed from history), `product_review_detached`.
4. Functions: `page365_inventory_follow_listing`, `delete_website_product_atomic`, helpers (`page365_norm_name`, `page365_swap_code`).
5. In-place md5-guarded patches (live body with edits, per CLAUDE.md "start from live"): `page365_inventory_finish` (add (a3) before (b), (h) after (g)); `page365_inventory_land_run` (review restore block). All other functions unchanged, proved by md5 after.
6. Link backfill (§2.5) with candidate-set self-check; one-time name pass (§4).
7. REVOKE/GRANT re-asserted; `scripts/function-drift-audit` and `structure-drift-audit` = 0; `chr()` for U+3000/NBSP.

### 4. Today's 46 differences (one-time, same migration)
Run the (h) logic once against the latest ready full run. Uncompleted names (Hub ∈ `seen_names`, mostly Used↔Preloved) updated + `ja_pending`; completed ones ("Diamond" vs "Dia", "Blue Topaz" vs "B.T") kept; **no per-product bells**, one summary bell. PR description first lists the 46 as `product | Hub name | Page365 name | action` from a SELECT (no write) for the owner to review.

## 5. Local SQL tests (`docs/sql/…_page365_follow_local_tests.sql`, same harness as the other `*_local_tests.sql`)
1. **Re-code:** linked N1073 (draft, stock 0), listing now N9140 → sku/name first word N9140, item `matched`, stock follows, no `already_landed`, audit row, presence code updated.
2. Re-code to a code another Hub product owns → blocked, one bell, no write; second run → no second bell.
3. **Slug, never published** (draft, `first_published_at` NULL): slug regenerated from N9140 + name. **Slug, ever published** (published then hidden/draft, `first_published_at` set): slug unchanged. Plus: backfill marks an active product / a product with an order line as published.
4. **Uncompleted name** + Page365 "[Used]"→"[Preloved]" → Hub name copied, `ja_pending`, `name_ja` NULL.
5. **Completed name** + Page365 change → Hub unchanged, ONE bell old → new; next run same text → no bell.
6. **Photos:** order B,A with staff photo S → Page365 rows re-sorted after S, S untouched; removal of A deletes only A; empty photo array deletes nothing.
7. **Price differs:** `price_differs=true`, variant price unchanged.
8. **Delete + re-land + reviews:** product with ≥1,900 item rows, a draft line, an order line, an approved review linked in **both** `product_review_products` and `product_reviews.website_product_id`, plus a second review linked in only one of them → delete OK; lines keep code/name/price with NULL link; reviews survive; next read lands a fresh unpublished draft; **both** link kinds restored exactly as before (and the one-sided review stays one-sided); consumed `product_review_detached` rows removed. Hub-only product deletes with no `detached` rows.
9. **(a)** delete of a product that **has `hub_only` rows** succeeds and removes **only its own** `hub_only` rows (another product's untouched).
10. **(b)** delete **refused** (plain message, nothing changed) when a `website_live_claims` row exists for its variant.
11. **(c)** delete of a normal linked product leaves its `kind='page365'` rows with `website_product_id`/`variant_id` NULL (CHECK satisfied), order/draft lines unlinked but intact.
12. **(d)** `idx_page365_inventory_items_product` exists and is partial on `website_product_id IS NOT NULL`; `EXPLAIN` of the product's SET NULL path uses it.
13. **Duplicate-code case unchanged:** existing `20270215_page365_duplicate_code_local_tests.sql` passes unmodified.
14. `page365_sync_disabled` product: no re-code/name/photo change, never backfill-linked. Partial read: nothing changes.
15. **Backfill:** candidates = exactly {N1616, R7828, R3341}; 8C100 and N4020 never linked; a listing already linked elsewhere is skipped.

## 6. Frontend changes (Hub src/)
- `ProductsCard.tsx:687` `remove` → `supabase.rpc("delete_website_product_atomic", …)` (cast at call site; `types.ts` never hand-edited). Confirm text (≈ line 1018): "Remove {name}? Orders and drafts keep their own copy of the code, name and price. If this piece is still in stock on Page365 it will come back as a new unpublished draft." (Hub-only product: shorter text.) The live-claim refusal shows its plain message as the toast; success toast shows counts.
- `StaffNotificationBell.tsx` (cases near lines 95 and 210): labels/routes for `page365_name_changed`, `page365_recode_blocked`, summary bell.
- `Page365Review.tsx` / `Page365InventoryCard.tsx`: result_note labels `code_followed`, `name_followed`, `code_exists_other_piece`; "Name changed on Page365" chip with old → new.
- Tests: `src/test/page365-follow.test.tsx` (source-assertion style of `page365-duplicate-code.test.tsx`).

## 7. Edge-function changes — SEPARATE Lovable deploy-only step (after merge)
1. `supabase/functions/page365-inventory-fetch/index.ts`: extend `copyLandedPhotos` with a second backlog — items of the latest **ready scheduled run**, `match_result='matched'`, `photos_to_copy > 0`, linked product, not sync-disabled → `copyItemPhotos` (≤12 photos/call, 4/s). New `photo_attempts` column on items caps retries at 3 per run.
2. Same file: after the read, translate up to ~5 `ja_pending` names per tick via `translate-product-description` (name only), write `name_ja`, clear `ja_pending`; failure leaves them pending (storefront shows English).
3. `_shared/page365-inventory.ts`: TS twins `normalName`, `swapCode`.
Lovable message asserts on SOURCE CONTENT (code-only unique string + line count differing from pre-release main) and the deployed body only (CLAUDE.md).

## 8. Remaining defaults (change on request)
- Removed Page365 photos: the storage object stays in the bucket (a sibling variant may share it).
- Live-claim guard refuses on any claim row regardless of status (status values not verified); relax later if staff need to delete after a claim ended.

## 9. Live facts — DONE (owner's read-only run, 2026-10-29 13:45 JST)
- md5(prosrc)/length: first_word `7265832b…`/99; apply `e65757c2…`/5998; auto_apply_run `d9d251fb…`/11940; **finish `a697a6d3…`/13674**; follow `6e265684…`/4041; hide_item `3a0a932b…`/3892; **land_run `7f27675e…`/8319**; record_photo `c8f94536…`/3697; retention `453cea7b…`/2570; store_product `6ae646ee…`/2871; match_line `4bec82da…`/1529. All as expected.
- FKs: as in §1.5 (SET NULL / CASCADE as listed; only `website_live_claims.product_variant_id` is NO ACTION, 0 rows).
- Listing 80622155 → Hub sku N1073, draft, linked; Page365 now N9140, available 1.
- `website_products` 463, 458 linked; unlinked: 8C100, N4020, N1616, R7828, R3341.
- Retention: runs since 2026-09-25 13:31 UTC (2,137), items 878,863, last pruned 2026-10-29 01:02 UTC.
- CHECK `page365_inventory_item_kind` and the 11 products with `hub_only` rows (§1.4); no index on `page365_inventory_items(website_product_id)`; `authenticated` statement/lock timeout 8 s.

## 10. Verification after release (live)
1. Index exists; `function-drift-audit` / `structure-drift-audit` = 0; function md5s equal the migration header.
2. Next scheduled read: listing 80622155 → the former N1073 product now `sku N9140`, name = Page365's text (uncompleted) or kept + one bell; item `matched`, no `already_landed`; stock = Page365 available (1); Page365 photos in order; still draft (never auto-published); slug regenerated (never published).
3. Summary bell for the 46 appears once; nothing re-rings over the next 3 reads. N1616, R7828, R3341 linked (`page365_product_id` set); 8C100 and N4020 not.
4. Delete a test product, and one stale product with `hub_only` rows (e.g. 8C100): succeeds, within the 8 s limit; `/products/<slug>` 404s after revalidation; its order/draft lines still show code/name/price.
5. Delete a linked in-stock product with an approved review: the next read lands a fresh unpublished draft and the review is attached again both ways (product page list and badge).
6. Duplicate-code pieces (N5245, N1045) still resolve by name as before.

## 11. Documentation used
`CLAUDE.md` (PAGE365 IMPORT, Migrations & FUNCTION CHANGES, SECURITY DEFINER, EDGE AUTH); migrations `20260926120000`, `20260927100000`, `20260929100000`, `20261001100000`, `20261002100000`, `20261005100000`, `20261215100000`, `20270215100000`, `20270217100000`, `20261230200000`; `_shared/page365-photo-copy.ts`, `page365-inventory-photos/index.ts`, `website/index.ts:4488-4540`, `ReviewsCard.tsx`, `ProductsCard.tsx` at `origin/main`. No library docs needed. UNVERIFIED: the join audit in §1.5 (done at build), `website_live_claims` status values.

## 12. As built (2026-10-29) — deviations from the plan above
- **`page365_inventory_land_run` is NOT edited.** The plan patched it to restore reviews; the build restores them in finish step (h) (`page365_inventory_follow_listing` → `page365_restore_reviews`) right after landing, by Page365 listing id. A failure there can never undo a landing, and land_run's live md5 stays `7f27675e…`.
- **Slug also follows a never-public product's name** (not only its code): a product with `first_published_at IS NULL` whose name followed Page365 gets its slug regenerated with the same recipe. Once public, the slug never moves.
- **Japanese names go through two service-role RPCs** (`page365_pending_ja_names`, `page365_set_name_ja`) so `page365-inventory-fetch` still writes only its own `page365_*` tables (existing guard test "an outage changes nothing on the website").
- **The link backfill skips when the database has no complete full read** (a rebuild from the repo); on live it still refuses unless the candidates are within N1616, R7828, R3341 and all three end up linked.
- **`page365_inventory_follow_code` is its own function** (step a3) next to `page365_inventory_follow_listing` (step h).
- The finish return value gains a `followed` key.
- Local harness only (not live): `docs/sql/20270220_page365_follow_local_stub.sql`, `…_seed.sql`, `…_tests.sql`; read-only owner dry run `docs/sql/20270220_page365_follow_dry_run.sql`.

## 13. Fix after release (2026-10-29) — code + name changed in one Page365 edit
Branch `fix/page365-follow-simultaneous-code-name`, migration `20270221100000_page365_follow_recode_name.sql`.
- **What was wrong.** §2.2 (h) compares Page365-now with `last_p365_name`, never the Hub name — right in steady state, wrong for the one case the plan was written for: §1.1's listing was re-coded + renamed BEFORE the release, so §3 step 3's history seed already stored the NEW name as "last seen" while the Hub still carried the old text, and §4's pass skipped it (unmatched). First read: (a3) → `N9140 <old words>`; (h) → "unchanged". Hybrid name, no bell, never re-evaluated.
- **Fix.** In the read where (a3) renamed the product (`result_note = 'code_followed'`), (h) also compares with the Hub name; everything else (seen_names gate, one bell, slug rule, price, photos, delete) unchanged. The bell names the previous distinct Page365 text. The one-time pass runs again (repairs a product a read between the releases already left hybrid).
- **Proof.** Local suite §0b / §4c / §4d (143 checks, + the 46 duplicate-code checks unmodified). UNVERIFIED on live: the md5 of `page365_follow_names` (the pre-flight refuses anything but the 20270220100000 body or the fixed one).
- **Not changed (noted for the owner).** (a3) swaps the FIRST WORD of the Hub name whatever it is; a Hub name that does not start with the code would lose its first word — no such product is known (names are copied from Page365), but a guard (`first_word(name) = old_code`, as already done for `name_ja`) is a candidate follow-up. A blocked re-code still lets step (b) match the listing to the OTHER product by code (pre-existing matcher behaviour, §2.2).

