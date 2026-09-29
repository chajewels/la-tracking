# Hero picks — the hero from ticked product cut-outs

Owner decisions, 2026-09-28 (plan approved the same day):

- The website hero shows only **product cut-outs** (`website_media_cutouts`;
  today Replicate `men1scus/birefnet`) that an **admin ticked "Use on hero"**.
- A photo can be ticked only when its cut-out is **usable**: finished and shown
  on the website (`ok`, `auto_fixed`, `approved`, never `kept_original` or
  `rejected`), with a file and its size, and its product **published**.
- The category banner and the menu thumbnails follow the same rule (storefront,
  PR 4).
- Carry-over of today's approved hero record: a Hub button, preview → apply,
  audited under the signed-in admin.
- `hero_usable` (set by the automatic checks) stays unused.

## Release order

| Step | Where | What | Website changes? |
|---|---|---|---|
| PR 1 | Hub DB, `supabase/migrations/20261013100000_hero_picks.sql` | ticks table, switch (ships `hero_record`), tick / carry-over / switch RPCs, `hero_cutouts_for_site` + the two Photos lists patched | **No** |
| PR 2 | Hub UI (same release as PR 1) | "Use on hero" tick (row + zoom viewer), Hero tab, carry-over button, switch control | **No** |
| PR 3 | Hub edge function (Lovable deploy) | `heroCutoutFor` accepts the product cut-out path | No (switch still `hero_record`) |
| PR 4 | Storefront | hero / banner / menu use only approved (ticked) cut-outs, no framed fallback | Only after the flip |
| Flip | Hub → Website → Photos → Hero | carry-over, tick extras, switch to "Ticked product cut-outs", release PR 4 | **Yes** |

Do not flip before PR 3 is deployed: until then the edge function drops product
cut-out paths and the hero has no cut-outs.

## The database (20261013100000)

- **`website_hero_picks`** — one row per ticked photo, keyed on `source_url`
  (the cut-out's own key; the Catalog save re-inserts media rows, the URL
  survives). References `website_media_cutouts(source_url) ON DELETE CASCADE`.
  `picked_via` = `tick` | `carry_over`, `picked_by`, `picked_at`. No browser
  role can read or write it; `trg_guard_hero_picks_writes` refuses every write
  that does not come through the two functions below (the cascade from a deleted
  cut-out row is the one exception).
- **The switch** `system_settings.hero_photo_source` = `hero_record` (seeded;
  today) | `product_ticks`. Anything else reads `hero_record`. Changed ONLY by
  `set_hero_photo_source(p_source, p_expected_source)` — admin role, stale-safe,
  one `audit_logs` row, revalidates the website; `trg_guard_hero_photo_source`
  refuses SQL / PostgREST writes. Never set it in a migration.
- **`hero_pick_reason(status, path, w, h, published)`** — THE rule. `NULL` =
  usable; otherwise `kept_original` | `rejected` | `not_completed` |
  `no_cutout_file` | `not_published` (`no_cutout` when there is no cut-out row).
  Used by the tick, the carry-over, the site function and the lists.
- **`set_hero_pick(url, pick)`** — admin role only. Ticking an unusable photo
  returns `{error: <reason>}`; unticking is always allowed. A change writes one
  `audit_logs` row (`website_media_cutout` / `set_hero_pick:tick|untick`); a
  repeat is `changed: false` and writes nothing.
- **`hero_picks_carry_over(apply)`** — admin role only. For every approved hero
  record, ticks the same photo when its product cut-out is usable. `apply =
  false` previews (counts, left out and why, products on the hero now / after)
  and writes nothing; `apply = true` ticks them, serialised by an advisory lock,
  `ON CONFLICT DO NOTHING` — a second press ticks nothing and writes no audit
  row. One `audit_logs` row per apply that ticked something (`system_setting` /
  `hero_picks_carry_over`, with the URLs).
- **Revalidation** — `trg_hero_pick_revalidate` (statement level) posts once to
  `notify_website` after a tick / untick / carry-over, **only while the switch
  is `product_ticks`**. The flip itself revalidates too.
- **`hero_cutouts_for_site(urls)`** (patched from live, md5-guarded): on
  `hero_record` it returns exactly today's rows (the migration's self-check and
  verify (6) prove it); on `product_ticks` it returns `{status: approved, path,
  width, height}` from the product cut-out for ticked, usable photos and nothing
  for any other photo.
- **`list_media_cutouts`** / **`get_media_cutout_tab_totals`** (patched from
  live, md5-guarded): every row gains `hero_pick` and `hero_pick_blocker`; filter
  `hero` lists every ticked photo (also one that stopped being usable, so it can
  be unticked, and also one of an unpublished product); `tabs.hero` = `count`,
  `usable`, `paid_calls`, `products_on_hero`, `published_left_out`,
  `published_in_stock`; plus `hero_photo_source`.
- "Products on the hero" / "left out" count **published products with a variant
  in stock** (`hero_product_counts`), the pieces the hero can show.

## The Hub (Website → Photos)

- **"Use on hero"** sits in `CutoutActionButtons`, so the row and the zoom viewer
  show the same tick. Admin only; other roles see it read-only with "Only an
  admin can choose the hero photos." Disabled with the plain reason when the
  cut-out is not usable. A ticked photo that stopped being usable shows "Ticked,
  but not on the hero: …" and can be unticked. Not shown before the migration
  (rows without `hero_pick`).
- **Hero tab** (shown once the totals carry `hero`): the ticked photos, the
  counts, the switch and the carry-over (`HeroPicksPanel`).
- **Switch control**: shows the current value; changing it opens a confirmation
  that says what the website will show and, for "Ticked product cut-outs", how
  many products would be on / leave the hero.
- **Carry-over**: "Carry over approved hero cut-outs…" → preview dialog →
  "Tick N photos" (disabled when there is nothing to carry over).

## Owner run order (PR 1)

1. `scripts/function-drift-audit` without `20261010200000_ddl_audit_log.sql` and
   `20261013100000_hero_picks.sql` → `0 | 0 | 0`.
2. `docs/sql/20261013_hero_picks_verify.sql` (P.1)–(P.5), read-only.
3. `supabase/migrations/20261013100000_hero_picks.sql`, as-is.
4. `docs/sql/20261013_hero_picks_verify.sql` (1)–(9), read-only, live values.

## Rollback

Switch back to "Hero record" in the Hub (instant). The new objects can then be
dropped; `website_hero_cutouts` is never touched.

## Tests

- SQL (local throwaway Postgres): `docs/sql/20261013_hero_picks_local_tests.sql`
  (T1–T10), run by `~/Code/reference/hero-picks/run-sql-tests.sh` together with a
  live-shaped preview → migration → after-checks run, a tampered-live-function
  abort, and the earlier provider-errors and hero-record suites on top.
- UI: `src/test/hero-picks-ui.test.tsx`.
