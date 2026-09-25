<!-- Moved VERBATIM from CLAUDE.md on 2026-09-24 to bring it under the
     Claude Code load limit. CLAUDE.md keeps every rule from these sections
     as a rules block with a pointer here; this file keeps the full text.
     Read it when a task touches this area. -->

## PAGE365 IMPORT — NON-NEGOTIABLE (added 2026-09-19)

  A CSR pastes a public Page365 invoice link; the Hub fetches it, the CSR
  confirms, and the Hub creates a normal cash order or layaway plan. There is
  NO new write path — `create-cash-order` and `create-layaway-account` create
  the order exactly as they do for a hand-typed one, so plan minimums, the
  loyalty gate, permissions and the `is_test` prefix all still apply.

  `page365-fetch-order` NEVER WRITES AN ORDER. Link in, draft out, into
  `page365_drafts`. It refuses the whole import naming the field when anything
  is missing or the totals do not reconcile to the yen — a half-parsed draft is
  worse than none, because the CSR cannot see what is absent until the order is
  already wrong.

  THE `?sig=` IS A CAPABILITY, NOT AN IDENTIFIER. Anyone holding the full link
  can read that customer's name, phone and address. It is used for the single
  outbound fetch and dropped: never stored on the draft, never on the order,
  never logged, never returned. Only the slug and the invoice number survive.

  PAGE365 INVOICES ARE JPY (owner decision 2026-09-19) — item prices and
  shipping alike. The draft is yen throughout; the ACCOUNT currency is the
  CSR's choice at confirmation. A PHP plan converts at
  `system_settings.php_jpy_rate`, and the rate plus the moment it was read
  travel with the draft so the peso total can be reproduced later. NEVER use
  `src/lib/currency-converter.ts` `getConversionRate()` server-side or as the
  basis of a stored figure: it reads `localStorage` with a hardcoded 0.42
  fallback, so it is per-browser and not auditable.

  A RESIZE FEE IS A SERVICE, NOT A PRODUCT LINE. The parser flags it
  `kind: 'service'`. A service belongs in `account_services` (already inside
  `total_amount`) and must never reach `loyalty_jpy_amount`, which is the
  product amount alone — booking one as a product inflates the customer's tier
  progress with a fee paid for labour.

  ITEM NOTES ARE DISPLAYED, NEVER APPLIED. "Layaway (May) 8M / DP on 09/20 /
  Resize # 16" is free text a human wrote. The CSR reads it and sets the term;
  nothing parses it into fields. Page365's OWN stock is not a stock source (the
  Hub never reads it), and `origin` is never auto-set. The reverse direction —
  a Page365 import REDUCING the website's stock — is the STOCK section below
  (added 2026-09-26).

  PHOTOS ARE COPIED, NEVER HOTLINKED — `promotions/page365/<no>/<n>.<ext>`,
  into `{cash_order,layaway_account}_items.image_url`. An order outlives the
  external system it came from. A photo that cannot be copied is left null; a
  missing picture is cosmetic and is not worth refusing a sound import.

  A CONSUMED DRAFT IS A COURTESY, NOT THE GUARD. `consume_page365_draft` (a
  SECURITY DEFINER RPC — `page365_drafts` deliberately has no UPDATE policy)
  stamps `consumed_at` after a successful import, and the review screen treats
  a failure as non-fatal because the order already exists. What actually stops
  a double import is `uq_{cash_orders,layaway_accounts}_page365_no` plus the
  409 `already_imported` both create functions return.

  ONE HUB ORDER PER PAGE365 INVOICE, and one invoice_number across BOTH order
  tables — see `public.invoice_numbers` in docs/SCHEMA-FACTS.md. The registry
  triggers are named `trg_zz_*` so they fire AFTER `enforce_test_invoice_prefix`
  and record the final, possibly `TEST-` prefixed, value; never rename them to
  something that sorts earlier.

  DISCOUNTS: `price_total` IS ALREADY NET (added 2026-09-23). Page365 discounts
  the INVOICE, not the lines. `price_subtotal` and every item `subtotal` stay at
  full price, and `price_total` = subtotal + shipping − `price_discount` −
  `campaign_discount`. Both fields are read, both are subtracted, and the
  reconcile is that identity to the yen; a negative in either is refused by name.
  Summing the two is deliberate — if Page365 ever reported ONE discount in BOTH,
  the total stops reconciling and the import is refused, which beats silently
  halving a customer's total. Reading neither is what refused EVERY discounted
  invoice with a 422 until this landed.
  The draft carries `discount_jpy`, `discount_breakdown` and, for display only,
  `promotion_code` and `discount_campaign_name` — a promo code is never written
  to the order. The review screen PRE-FILLS the Discount field from
  `discount_jpy` and marks it "From Page365" until the CSR types over it.
  LOYALTY BASIS = PRODUCT LINES − DISCOUNT, in yen (owner rule 2026-09-23:
  "loyalty excludes the discount and the shipping fee"). The whole discount
  comes off the product amount; services and shipping were already outside it.
  Points must never be earned on money the customer did not spend. While the
  discount is still Page365's own the basis uses the draft's exact yen figure
  rather than converting the peso input back, so the basis cannot drift when the
  CSR toggles the currency.

  THE UI IS THE ONLY WAY IN, AND IT NEVER AUTO-DECIDES. Sales → the split
  button's "From Page365" opens a paste box; a successful fetch navigates to
  `/page365/review/:draftId`, where every parsed field is editable before
  anything is created. The customer is SUGGESTED, never auto-selected — matches
  are listed with the basis shown (name / phone / name + phone) because live
  phone data is only 80 clean E.164 of 891, with 10 colliding digit-groups.
  Item notes are displayed beside their line and never parsed. A RESIZE FEE
  arrives flagged `kind: 'service'` and the CSR can move any line between
  product and service; the loyalty basis sent to the creating function is the
  PRODUCT total in yen, LESS the discount (see DISCOUNTS below) — services and
  shipping are never in it.
  Currency is the CSR's choice at review: JPY default, and PHP converts the
  total, shipping and discount with the rate the DRAFT carries (`payload.fx`,
  `system_settings.php_jpy_rate`) — shown once on screen with its source and
  read time. Line items stay in yen whatever the account currency.
  THE ROUTE IS PERMISSIONED ON EITHER CREATE KEY. `/page365/` in
  PermissionsContext resolves to `create_cash_order OR create_account`, because
  the screen can produce either and gating on one would lock out a user who
  holds the other; the cash/layaway toggle then offers only the type they can
  actually create. An unmapped path there returns false for everyone but admin
  — the documented new-feature lockout.

  LINE ITEMS ARE WRITTEN INSIDE THE CREATING FUNCTION (`_shared/order-extras.ts`),
  not by the browser afterwards. The old post-RPC writes in NewAccount.tsx and
  NewCashOrder.tsx swallowed their own failure into a `toast.warning` on an
  order the CSR had just been told was created successfully. On an import
  nobody typed the lines, so nobody would know what was lost. A failure now
  rolls the order back. Every extra field is optional and a caller that sends
  none behaves exactly as before.


## STOCK — a Page365 import reduces website stock, once (added 2026-09-26)

  > **Since PR 2 (2026-09-28) this is the `invoice` mode only — the rollback.** The live
  > mode is `inventory_sync`: an import still claims, matches and flags every line exactly
  > as below, but never changes website stock. See "PR 2 — PAGE365 IS THE STOCK MASTER".

  Owner-approved plan: ~/Code/reference/page365-stock-investigation.md (D1–D7).
  Migration `20260926120000_page365_stock_sync.sql`; edge helper
  `supabase/functions/_shared/page365-stock.ts`; Hub words
  `src/lib/page365-stock.ts`. Local SQL tests:
  `docs/sql/20260926_page365_stock_sync_local_{stub,tests}.sql`.

  MATCHING IS THE FIRST WORD, EXACTLY. The product code is the first
  whitespace-delimited word of the Page365 line (`page365_first_word`: leading
  blanks incl. U+3000 and NBSP ignored, upper-cased). It must equal exactly ONE
  `website_products.sku` (compared the same way; a code with a space inside
  never matches) and that product must have exactly ONE variant. Anything else
  is a FLAG — `unmatched` (no product code, e.g. "Necklace …"),
  `ambiguous_sku` (several products), `no_variant`, `ambiguous_variant`
  (several sizes, D6) — and no stock moves. Nothing is guessed, nothing is
  fuzzy. A line the parser marked a service (resize) or the CSR booked as a
  service is SKIPPED (`not_a_product`), never flagged. Product status is not
  looked at: draft and archived products are reduced too (D7).

  STOCK IS TAKEN AT IMPORT, NEVER AT FETCH (D1). `page365-fetch-order` only
  PREVIEWS: it stores `stock_match` on each draft item (`page365_match_line`,
  read-only) and the review screen shows a chip per line — "Will take stock",
  "Will flag · …", "Service — skipped", or "Stock not checked" for drafts
  fetched before this shipped. `create-cash-order` / `create-layaway-account`
  take the stock when `page365_no` is present, AFTER the order and its lines
  are written, by calling `page365_apply_stock` (service role only).

  THE LINES COME FROM THE STORED DRAFT, NOT THE BROWSER. The request carries
  `page365_draft_id` (required whenever `page365_no` is sent — 400 without it,
  409 if the draft is gone or is for another invoice) and
  `page365_service_lines` (1-based draft positions booked as a service). Names
  and quantities are Page365's own; editing a line on the review screen, or
  removing it, does not change what is taken. `line_no` = position in the draft.

  NEVER TWICE. Every line is CLAIMED in `page365_stock_lines`
  (UNIQUE `page365_no, line_no`, `INSERT … ON CONFLICT DO NOTHING`) BEFORE any
  stock moves, and only the call that claimed it may move stock — a retry, a
  second tab or two concurrent calls take once (proven with two live sessions:
  5 → 3, the other call saw `already_claimed`). The one re-claim: a line whose
  order was DELETED (unpaid only; the delete already gave the stock back) may
  be claimed again by a fresh import of the same invoice — so net, still once.

  THE WEBSITE'S OWN DECREMENT, NEVER BELOW ZERO. `UPDATE … SET stock_qty =
  stock_qty - q WHERE id = v AND stock_qty >= q` after locking the variant row,
  exactly like `create_web_order_atomic`. Zero rows (the piece is reserved or
  sold on the website) → no reduction, the line is flagged
  `insufficient_stock` with the stock seen, and the ORDER IS STILL CREATED.
  The website reservation is never overridden (D5 logic); staff adjust
  Page365's own stock. Business outcomes never raise; only a bad request or a
  database error does, and the creating function then deletes the order it
  just wrote (the RPC's own transaction already rolled back, so nothing is held).

  GIVING IT BACK IS A TRIGGER, SO EVERY WRITER IS COVERED.
  `page365_stock_follow_order` (AFTER UPDATE OF status, AFTER DELETE, on both
  order tables): into a dead status (cash: cancelled, expired — D3, the hourly
  `auto-expire-cash-orders`; layaway: cancelled, forfeited, final_forfeited —
  D4, manual AND automatic forfeit) or a delete → every `held` line becomes
  `released` and its stock comes back, summed per variant, once (`stock_state`
  is the guard). Out of a dead status (cash revive, reactivation, extension) →
  each released line is taken again if still in stock, otherwise flagged
  `rehold_failed`; it NEVER raises and never blocks the status change (D5).
  AFTER triggers, so a refused delete (paid order) or any BEFORE guard that
  refuses moves nothing. Only ledger rows move stock: every hand-typed order,
  and every Page365 order imported before this shipped, has none and is
  untouched. `auto-forfeit-settlement` stays LOCKED — nothing in it changed.

  PAGE365-SIDE CANCELLATIONS (D2): there is no signal from Page365 (the `?sig=`
  is never stored, so the invoice cannot be re-read). Staff cancel the Hub
  order; the trigger returns the stock.

  FLAGS REACH STAFF THREE WAYS. A bell `staff_notifications` row
  `page365_stock_flag` (one per import with any flag, and one per revive that
  could not re-take) — it opens Website → Page365 stock. The Website workspace
  tab **Page365 stock** (`manage_website_catalog`) lists open flags with the
  invoice, line, reason and stock seen; RESOLVE requires a note, is audited
  (`page365_stock_flag_resolved`) and NEVER moves stock
  (`resolve_page365_stock_flag`, same permission, checked in SQL). The order
  pages (CashOrderDetail / AccountDetail) show a "Website stock" panel per line:
  Stock taken / Flagged · reason / Stock returned / Service — skipped.

  THE STOREFRONT NEEDS NO CHANGE. A reduction is a plain UPDATE on
  `website_product_variants`, which fires `notify_website_revalidate` like any
  catalogue edit (docs/WEBSITE-VERCEL.md). Website orders keep their own
  stock paths (gated `source_channel = 'web'`); Page365 lines keep
  `variant_id` NULL on the items tables, so those paths never see them.

## INVENTORY — Page365 catalogue → website stock and photos (added 2026-09-27, PR 1 of 4)

Plan: `~/Code/reference/page365-inventory-fetch-investigation.md` (owner approved every
recommendation). Migration `20260927100000_page365_inventory_fetch.sql` (owner runs it),
edge functions `page365-inventory-fetch` and `page365-inventory-photos`, Hub card
**Website → Page365 stock → Page365 inventory** (`Page365InventoryCard.tsx`). Behaviour
tests: `docs/sql/20260927_page365_inventory_fetch_local_{stub,tests}.sql`; unit/pins:
`src/test/page365-inventory.test.tsx`.

**Reading.** The storefront answers JSON. `GET /products?page=N` is a *cumulative* list
(page N = first 16·N products), so the fetch reads page 1 for `count`, then page
`ceil(count/16)` for everything, and refuses a list whose length ≠ count or that repeats
an id. Then one `GET /products/<id>` per product, ≤ 4 requests/s
(`createRateLimiter(4, 4)`), 8 s timeout, 40 products per `continue` call. The browser
loops `continue` until the run leaves `fetching`; a closed tab leaves a run the next
**Resume fetch** (or a new Fetch after 10 min idle) picks up. A claim older than 3 min is
taken again; a failed product is retried once. One `fetching` run at a time (unique index).

**Strict parse, no reviews.** `parseProductDetail` keeps only `name, price, full_price,
photos, variants`; a missing or non-integer `available`, no variants, or a photo not on
`https://assets.page365.net` is an error for that product, never a guessed value.
`page365_inventory_store_product` re-checks the variants and copies whitelisted keys only.
The `review` block (customer names and words) never leaves the parser.

**Code = per variant.** One variant → first word of the product name; 2+ variants →
first word of each variant name (listing E1053 carries pieces E1053 **and** E2057).
Matching is #195's `page365_match_line`, unchanged: exact code, one product, one variant.

**The proposal** (`page365_inventory_finish`, all rows at one moment):

| category | meaning | on the review screen |
|---|---|---|
| `decrease` | `max(0, available − web holds) < stock_qty` | pre-ticked |
| `increase` | … `> stock_qty` | tick required; sent in the *increase* list |
| `no_change` | equal | counted only |
| `excluded` | the variant has a #195 `page365_stock_lines.stock_state = 'held'` line — **only in `invoice` mode** (PR 2) | shown, never tickable |
| `not_synced` | the product is switched to "Don't sync with Page365" (PR 2) | own group; never proposed, applied or given photos |
| `flagged` | `no_code`, `duplicate_in_page365`, `ambiguous_sku`, `no_variant`, `ambiguous_variant` | shown with the reason |
| `new` | code not in the Hub | listed only — nothing created |
| `hub_only` | active/draft Hub product whose code is absent from a **complete** read | flagged with the count of consecutive runs; becomes `hide` only under the PR 3b rule (see HIDE-FOLLOW) |
| `hide` (PR 3b) | a Hub-only product SEEN on Page365 before, missing from 2 complete reads in a row, still published, not switched off | own group "Hide on website", pre-ticked; stock 0 + unpublished on apply |

Price differences (`price_differs`, plus Page365's compare-at `full_price`) are reported
only. **Web holds** (`page365_web_holds`) = quantity on web cash orders still `pending`
+ live web layaways (`active/overdue`, `stock_released_at IS NULL`) with `total_paid = 0`
— the sales staff have not yet entered in Page365 (owner rule: every confirmed website
sale goes into Page365). A rise can therefore mean "confirmed on the website, not yet in
Page365": staff leave it unticked.

**Run status.** `ready` only when every product read cleanly and `count` did not fall more
than 20 % against the last ready run; otherwise `partial` (shown, nothing tickable,
apply refuses). A list that cannot be read → `failed`, no products queued. **An outage
changes nothing.**

**Apply** — `page365_inventory_apply(run, decrease_ids[], increase_ids[])`, signed-in user
with `manage_website_catalog`. Refuses a run that is not `ready`, is > 24 h old, or has a
newer ready run. Per row: `UPDATE … SET stock_qty = proposed WHERE id = variant AND
stock_qty = seen_stock` → `applied` (+ audit `page365_inventory_applied`, old/new stock,
code, Page365 qty, web holds) or `changed_since_fetch`. Skipped, row left reviewable:
`direction_mismatch` (an increase sent as a decrease), `invoice_hold` (re-checked live),
`not_a_stock_change`, `already_*`. One audit row per call (`page365_inventory_apply`).
The CHECK `stock_qty >= 0` and `proposed_stock >= 0` are the never-below-zero backstop.

**Photos** (on Apply, for ticked matched products; pre-ticked). `page365-inventory-photos`
copies each photo not yet present **with the same version** to
`promotions/website/page365/<page365 product>/<photo id>-<version>.<ext>` (`upsert:false`,
image/*, ≤ 10 MB, ≤ 4/s, 12 per call, the browser loops), then
`page365_inventory_record_photo`: same id + version → nothing; new version → url refreshed
in place; a spreadsheet hotlink to the same Page365 file → replaced in place; else
inserted. Order = Page365's (position, then list order); with no staff photos the first
Page365 photo is `sort 0` (main). **Staff photos** (`page365_photo_id IS NULL`, not a
Page365 hotlink) keep their rows and their `sort`; Page365 photos go after them. A copied
photo Page365 later drops is reported (`photos_removed`), never deleted. Unique index
`(variant_id, page365_photo_id)` makes a duplicate impossible. A fetch alone copies nothing.

**PR 2 (2026-09-28)** switched invoice imports to record-only (`inventory_sync`) — next
section. PR 3 adds the 30-min schedule (decreases only) — section SCHEDULE below;
PR 4 "Create drafts" — section DRAFTS below.

## PR 2 — PAGE365 IS THE STOCK MASTER (added 2026-09-28)

Migration `20260928100000_page365_inventory_pr2.sql` (owner runs it). Local SQL tests:
`docs/sql/20260928_page365_inventory_pr2_local_{stub,seed_held,tests}.sql` (66 checks;
PR 1's 75 still pass in `invoice` mode). Unit/pins: `src/test/page365-inventory-pr2.test.tsx`.

**The mode.** `system_settings.page365_stock_mode`: `inventory_sync` (seeded) | `invoice`
(the #195 behaviour, the rollback). Only an explicit `invoice` brings the decrement back.
In `inventory_sync`, `page365_apply_stock` claims every line, matches it, flags
`unmatched / ambiguous_* / no_variant` exactly as before, and records a matched line as
`stock_state = 'page365_master'` (variant and `stock_seen` recorded) **without touching
website stock**. `insufficient_stock` no longer arises. The result carries `mode`,
`recorded`, `sync_off`; the bell for flagged lines says "did not match one website product".

**Cut-over.** Every `held` line became `absorbed` (audit `page365_stock_absorbed`, one row
per line): its piece is inside Page365's own number now. `page365_stock_follow_order` is
UNCHANGED (md5-asserted) and only ever releases `held` and re-takes `released`, so
cancelling / expiring / forfeiting / deleting an order whose lines are `absorbed` or
`page365_master` returns nothing, and reviving it takes nothing. `released` lines were left
as they are: reviving such an order still re-takes its piece exactly as under #195 (a
bounded, staff-reviewed flap; the next fetch proposes the correction). Re-running the file
never re-flips the settings and absorbs only while the mode is `inventory_sync`. Rollback:
set the mode to `invoice` — new imports decrement again; absorbed lines stay absorbed.

**"Don't sync with Page365".** `website_products.page365_sync_disabled` (default false),
switched in Catalog → product → "Don't sync with Page365". Only `manage_website_catalog`
may flip it (`trg_page365_sync_switch`, 42501 otherwise); every flip is audited
(`page365_sync_switched`). Switched on: the fetch puts the product's rows (and its Hub-only
row) in `not_synced` — never proposed, never a price difference, no photos counted;
`page365_inventory_apply` refuses it (`sync_disabled`, read LIVE from the product, so a
switch flipped after a fetch still protects it); `page365_inventory_record_photo` refuses
it; `page365-inventory-photos` skips it before any download; an invoice import records the
match with `stock_state = 'none'` in EITHER mode. The migration switches nothing on — the
owner switches N4020 (a sample) in the UI.

**The fetch.** No `excluded` category outside `invoice` mode. The proposal is now
`max(0, available − web holds − unpaid invoice holds)`, where the last term
(`page365_invoice_holds`) = quantity on `page365_master` / `absorbed` lines whose Hub order
is live and unpaid (cash `pending`; layaway `active/overdue` with `total_paid = 0`),
subtracted while `system_settings.page365_hold_unpaid_invoices` is not `false` (seeded
`true`). It exists because it is **not yet confirmed whether an unpaid Page365 invoice
lowers Page365's `available`**. If it does not, this keeps a piece sold on an unpaid invoice
off the website; if it does, the piece is subtracted twice while unpaid — a one-off piece
reads 0 either way, a multi-piece listing shows one too few until the order is paid. Never
an oversell. Once the owner's test shows Page365 counts unpaid invoices, set the key to
`false`. Review column "Invoice holds".

**Invoice fetch fixes (`page365-fetch-order`).**
- F1: the webstore list is cumulative ("load more"), never empty — the old page walk
  re-downloaded ever-larger pages until its 20 s budget ran out. A line without a product
  id now reads the list the PR 1 way (`readCatalogueList`: page 1 for the count, page
  ceil(count/16) for everything, once per fetch), finds exactly one listing with the line's
  code (`findListing`, never a prefix, never a guess between two), then its product page.
- F2: the code is the first word (`firstWord`) — the regex missed R13R6, E8JS, 12M17, …
- Photos: an order line keeps ONE photo, the main one (`photos[0]` in Page365's display
  order, `mainGalleryPhoto`). A line that matched a website variant whose gallery is
  already copied reuses that stored copy — nothing downloaded, no second file. The full
  gallery belongs to the catalogue product. Catalog's product save now carries each copied
  photo's `page365_photo_id / _version` through its delete-and-reinsert of media rows —
  before PR 2 a save stripped them and the next copy duplicated every Page365 photo.
- The draft carries `stock_mode`; the review chips say "Matched · CODE — stock follows the
  Page365 inventory fetch" (or "Not synced with Page365") instead of "Will take stock".

## DRAFTS — "Create drafts" from new Page365 codes, and Catalog bulk Publish (added 2026-09-28, PR 4 of 4)

Plan: `~/Code/reference/page365-inventory-fetch-investigation.md` (PR 4, owner-approved).
Migration `20260929100000_page365_inventory_drafts.sql` (owner runs it, AFTER PR 1 and PR 2's
migrations). Hub: **Website → Page365 stock → New in Page365** (`Page365NewProductsPanel.tsx`)
and **Website → Catalog** bulk bar (`CatalogBulkBar.tsx`). Behaviour tests:
`docs/sql/20260928_page365_inventory_drafts_local_{stub,tests}.sql`; unit/pins:
`src/test/page365-drafts.test.tsx`.

**Owner rules.** Nothing appears on the website until a person publishes it. Created
products are drafts. Sold pieces (Page365 available 0) are hidden by default and only
created when "In stock only" is switched off. Every money figure comes from the Hub; yen is
the price of record. Origin is set by staff and never guessed. Descriptions are English and
auto-translated to Japanese.

**Filters (review screen).** "In stock only" (ON by default), search by code/name, Page365
category, yen price range, "Select all shown" (ticks only rows the filters show; a filter
change drops ticks on rows it hides), counts at the top (`N new · N in stock · N sold out ·
N drafted`). The Page365 category comes from the catalogue LIST, stored at fetch start in
`page365_inventory_products.list_category` / `list_description` (the list carries no
reviews). Runs fetched before this release have no categories: fetch again.

**What "Create drafts" makes** (`page365_inventory_create_drafts`, signed-in user with
`manage_website_catalog`, only on a `ready`, current, < 24 h run):
- One Hub product per new CODE, each with ONE variant. A Page365 listing carrying two codes
  (E1053 / E2057) gives two products, because #195's matcher only matches a code to a
  product with exactly one variant — a two-variant product would never sync stock.
- `sku` = the code; name = the Page365 name (the variant's name when the listing carries
  several codes); `status` = draft; `origin` = UNKNOWN; `condition` = Preloved only when
  Page365 says so ("[Preloved]" in the name or a PRELOVED category), else New.
- Price = Page365's yen price for that variant; stock = Page365 available (a new variant
  has no website holds, so this IS max(0, available − holds)).
- Metals: whole words equal to a Hub stamp, as printed in the name/description (K18, PT900,
  …; "0.750ct" is not 750). **A stamp is required only for jewelry** (owner decision
  2026-09-28, `website_products.item_kind`). A listing whose name or Page365 category
  carries the whole word "watch"/"watches" is drafted as `item_kind = watch` and needs
  none; anything else is jewelry, and jewelry with no stamp printed → **failed `no_metal`**.
- "Don't sync with Page365" (PR 2): a code whose Hub product is switched off is never
  drafted — `sync_disabled`, whether the fetch saw the switch (`not_synced`) or it was
  switched on since (read live).
- Category: only when the Page365 category's first word is a jewelry type (Rings MIJ,
  Necklace MIJ, …) AND exactly one Hub category has that slug/name (singular or plural).
  "SUPPLIER LISTINGS - …", "- BRANDED PRELOVED" → left unset, flagged **needs category**.
- Description: Page365's text only through `page365_clean_description` (no links, e-mail,
  @handles, phone numbers, HTML or banned gold wording; ≤ 2,000 characters), else empty.
- Skipped, never duplicated: `code_exists` (a Hub sku whose first word is the code — made
  by hand since the fetch), `already_created` (that Page365 listing+variant was drafted),
  and the `sku` UNIQUE constraint for a race. Failed, with the reason: `no_price`,
  `no_metal`, `code_is_a_word` (the name starts "Necklace …", so the first word is not a
  code), and any trigger refusal (banned gold wording in the Page365 name).
- The review item becomes `matched` to the new variant (`status applied`,
  `result_note draft_created`), so the PR 1 copier (`page365-inventory-photos`) copies
  every photo in Page365's order, first = main, one row per (variant, photo id) — the panel
  runs it right after creating. The next fetch sees the draft as an ordinary matched piece.
- Audited: `audit_logs` `page365_draft_created` per product, `page365_inventory_create_drafts`
  per call.

**Publishing** (`website_publish_products`, Catalog → select → Publish). Drafts only; each
product missing origin, category, a brand name (origin BRAND), a metal stamp (jewelry only —
watches and other items need none) or a price stays
a draft and is listed with what is missing (`website_product_publish_missing` is the one
definition). Japanese is generated first for drafts that have none. Audited
(`website_product_published`). `trg_page365_draft_publish_guard` refuses a Page365 draft
going live any other way (the product dialog, a spreadsheet row, SQL); Hub-made products are
not affected. The product dialog now writes a status change to active LAST (after
categories) so a complete save passes the guard, and keeps `page365_photo_id/_version` on
media rows it re-writes (otherwise the next photo copy would add every photo again).

**Catalog bulk bar.** Select rows → Set origin (Made in Japan / Branded + brand name /
Other), Add category, Publish. `?view=page365-drafts` shows only Page365 drafts;
`?product=<id>` opens a product (links from the Create-drafts results).

**Not built.** Drafts from unmatched INVOICE lines (planned alongside PR 4 in §5.1) — the
catalogue path covers every listed piece; filed in docs/PENDING.md.

## SCHEDULE — automatic fetch every 30 minutes, decreases only (added 2026-09-30, PR 3 of 4)

> **Changed by PR 3c (2026-10-02, section QUICK FETCH below):** the scheduled read now applies
> INCREASES too, most scheduled reads are QUICK (the list + Hub products' pages), and one FULL
> read runs nightly at 02:00 PHT (03:00 JST). The switch is "Automatic updates every 30
> minutes (decreases, increases, hiding)". Everything else in this section still holds.

Migration `20260930100000_page365_inventory_schedule.sql` (owner runs it AFTER the release
is on main and `page365-inventory-fetch` is redeployed). Local SQL tests:
`docs/sql/20260930_page365_inventory_schedule_local_{stub,tests}.sql` (107 checks). Unit and
pins: `src/test/page365-inventory-schedule.test.tsx`.

**Owner rules (final, 2026-09-26).**
- The scheduled fetch runs every 30 minutes and AUTOMATICALLY applies **decreases only**.
  Increases, new products (Create drafts), price differences and photo copies are NEVER
  automatic — they wait on the review screen for staff.
- Same safety as manual: target = Page365 available − website holds (− unpaid invoice holds
  while `page365_hold_unpaid_invoices`); compare-and-set; never below zero; products switched
  to "Don't sync with Page365" always skipped (read live); a partial run (read errors, or the
  catalogue shrank > 20 %) applies NOTHING; a run past its 30-minute window, or superseded by a
  newer ready run, applies nothing.
- The switch: Hub → Website → Page365 stock → "Automatic decreases every 30 minutes",
  `system_settings.page365_inventory_auto_apply`, default OFF. Only `manage_website_catalog`
  changes it (`set_page365_inventory_auto_apply`, one `audit_logs` row
  `set_page365_inventory_auto_apply` per change); `trg_guard_page365_inventory_auto_apply`
  refuses every other write (SQL Editor included). The migration never turns it on.
- Politeness: ≤ 4 requests/s to Page365, one reader at a time, never overlapping a manual
  fetch.

**How a tick works.** pg_cron job `page365-inventory-schedule`, `2-59/5 * * * *`, POSTs
`{action:"schedule"}` to `page365-inventory-fetch` with the Vault service key
(`email_queue_service_role_key`, CRON AUTH RULE). The function accepts the service role ONLY
for that action (JWT claims, `requireAuth(req, {allowServiceRole:true})`); signed-in staff get
403 for it. Each tick (`scheduleDecision`, `_shared/page365-inventory.ts`):
1. closes any scheduled run that ended but was not closed yet (a staff "Join" finished it, or
   it was marked abandoned) — `page365_inventory_auto_apply_run`, idempotent;
2. **skip** if a MANUAL fetch is reading (fresh within 10 min): it is staff's to finish;
3. **resume** the scheduled run still reading;
4. **wait** if the last scheduled run began < 27 min ago (so a new read begins every 30 min);
5. **start**: retention first (`page365_inventory_retention(14)`), then the same two-request
   list read as a manual fetch, `source = 'schedule'`, `started_by NULL`.
It then reads chunks for up to ~100 s (one rate limiter for the whole invocation, ≤ 4 req/s);
a ~570-product catalogue takes two ticks. When the run ends, the closer runs.

**One reader — the lease.** Every chunk (manual `continue` and scheduled) first takes
`page365_inventory_lease(run, holder, 120 s)`; the claim/read/store happens under it and it is
released after. A caller that finds it taken gets `{busy: true}`: the browser waits 3 s and
tries again (not counted as a stall); the tick waits 2 s. A crashed holder's lease lapses by
itself. A staff "Fetch" during a scheduled read resumes that run ("Join scheduled fetch"), so
the two take turns rather than read twice.

**The closer — `page365_inventory_auto_apply_run(run)`** (service role only; the ONLY
automatic stock writer). Once per scheduled run (`auto_apply_at`), it records
`auto_apply_state`:
`not_ready` (partial/failed — nothing) · `off` (switch off — nothing) · `window_passed`
(now > created_at + 30 min — nothing) · `superseded` (a newer ready run — nothing) ·
`applied`. Only `applied` writes stock, and only rows with `category = 'decrease'`,
`status = 'review'`, `proposed < seen`, the product not switched off (live), no #195 hold in
`invoice` mode, and `UPDATE … WHERE stock_qty = seen_stock AND stock_qty > proposed` — a
website sale since the read is `changed_since_fetch`, never overwritten. Applied rows:
`status applied`, `applied_by NULL`, `result_note 'auto_applied'` (the review shows
"Auto-applied"). Skipped rows keep `status review` with a note. Audit: one
`page365_inventory_auto_applied` per row (entity `website_product_variant`, `source:
'schedule'`, performed_by NULL) and one `page365_inventory_auto_apply` per run while the
switch is on. Bells, at most one per run: `page365_inventory_run_failed` (partial/failed
scheduled read) or `page365_inventory_auto_applied` (≥ 1 decrease, codes listed); both open
Website → Page365 stock. A Page365 outage therefore rings once per 30-minute run.

**Manual apply is unchanged.** Staff can still tick increases (and any decrease the closer
skipped) on a scheduled run, within its 24 h, until a newer ready run supersedes it. Because a
scheduled run finishes every 30 minutes, a review left open longer is superseded — fetch or
open the newest run.

**Retention — `page365_inventory_retention(p_keep_days default 14, floor 7)`.** Runs older than
the window, never a fetching run and never the latest ready run: nothing applied → the run and
all its rows are deleted; something applied (stock or a draft) → the run row, every applied
item and the product rows they point at are KEPT, the rest (unapplied items, other products,
chunk log) deleted once (`pruned_at`). `audit_logs` is never touched. Called by the tick before
each new run.

**Hub UI.** Website → Page365 stock: new card "Automatic decreases every 30 minutes" (switch
with confirm dialog, last change and who, last scheduled run time/status/what was applied, run
history of the last 10 runs with source Scheduled/Manual). The inventory card shows the run's
source, polls while a scheduled read is in progress, and marks auto-applied rows.

## HIDE-FOLLOW — hidden in Page365 → hidden on the website (added 2026-10-01, PR 3b)

Migration `20261001100000_page365_hide_follow.sql` (owner runs it after the release is on
main; **no edge function deploy** — it hangs off `page365_inventory_finish` and
`page365_inventory_auto_apply_run`, which `page365-inventory-fetch` already calls). Local SQL
tests: `docs/sql/20261001_page365_hide_follow_local_{stub,tests}.sql` (95 checks; the PR 3
suite still passes on top). Unit and pins: `src/test/page365-hide-follow.test.tsx`.

**Owner rule (approved 2026-09-26).** Page365 hides sold pieces, so they vanish from its
public catalogue. When a synced Hub product is MISSING from **2 COMPLETE reads in a row**, the
Hub sets its website stock to 0 AND unpublishes it.
- Only a product that was **seen** — matched on its code in an earlier complete read — and
  then went missing. A Hub-only product (never matched) is NEVER hidden. A product whose SKU
  code was changed in the Hub since it was seen counts as never seen under the new code.
- Never a product switched to "Don't sync with Page365" (at the read, and again LIVE at
  apply). Never a product that is not published (`active`) — staff unpublished it already.
- Never from a partial/failed read. "In a row" counts complete reads only: finish's
  `missing_runs` chains over READY runs, so a partial read in between neither counts nor
  breaks the row.
- Scheduled reads hide by themselves ONLY while `page365_inventory_auto_apply` is on — the
  same gate as the decreases (ready, inside its 30-minute window, not superseded). A manual
  read (or a scheduled one with the switch off) shows the rows **pre-ticked** in "Hide on
  website"; "Apply selected" applies them.
- Compare-and-set: only if the product is still `active` and every variant's stock equals
  the read's snapshot (`hide_snapshot`); otherwise `changed_since_fetch`, reported.
- **Never re-published automatically.** A hidden product Page365 lists again is flagged
  `back_in_page365` → group "Back in Page365 — re-publish?", never pre-ticked. Re-publishing
  goes through `website_publish_products` (the Catalog bulk Publish) with its usual checks.
  Its stock row is proposed as an increase (0 → available). PR 3b: never automatic. Since
  PR 3c the increase IS automatic on a scheduled read with the switch on (and pre-ticked on a
  manual one) — the stock follows Page365, the product stays a draft until staff re-publish.
- Orders and reservations are never touched (a pending web order that is later cancelled
  returns its piece to a draft product — invisible on the website).
- To keep a piece on the website that Page365 hides, switch it to "Don't sync with Page365".
  Re-publishing it while Page365 still lacks it gets it hidden again on the next complete read.

**Unpublished = `draft`.** `website_products.status` is the enum `website_product_status`
(`draft | active | archived`). `draft` is the Hub's own unpublished state and exactly what
Catalog's bulk Publish turns back into `active`. `archived` means retired and is dropped from
Page365 matching altogether (finish's Hub-only list skips it), so a piece coming back could
never be flagged.

**Seen — `page365_product_presence`.** One row per Hub product matched in a READY run: the
code it was matched on, first/last seen (the read's start), and the hide mark (`hidden_at`,
`hidden_run_id`, `hidden_by` NULL = schedule, `hidden_source`). Backfilled by the migration
from the complete runs still kept (retention keeps 14 days). Written only by
`page365_inventory_follow` and `page365_inventory_hide_item`.

**The proposal — `page365_inventory_follow(run)`**, from trigger `trg_page365_inventory_follow`
(AFTER UPDATE OF status ON `page365_inventory_runs`, WHEN fetching → ready), i.e. inside
finish's own transaction; finish's body is unchanged. It (a) flags back-in-Page365 rows,
(b) clears the hide mark of a product seen again that is no longer a draft, (c) records seen,
(d) turns `hub_only` rows into `hide` when missing_runs ≥ 2 AND seen on the same code before
this read AND `active` AND not switched off. It never writes stock or status. If it fails,
the read still completes with no proposals and an `audit_logs` row
`page365_inventory_follow_failed` says why.

**The writer — `page365_inventory_hide_item(item, run, actor, source)`** (service role
only): refuses `sync_disabled` (live) / `never_seen` (row stays under review with the note),
compare-and-set, then every variant `stock_qty = 0`, product `status = 'draft'`, presence
`hidden_at`, item `applied` (`result_note` `hidden` | `auto_hidden`), one `audit_logs` row
`page365_inventory_hidden` (entity `website_product`, old `{status: active, variant_stock}`,
new `{status: draft, stock_qty: 0, run_id, missing_runs, last_seen_at, …}`).
- Staff: `page365_inventory_hide(run, item_ids)` — `manage_website_catalog`; the same run
  refusals as `page365_inventory_apply` (not ready / older than 24 h / superseded); one run
  audit `page365_inventory_hide` per call.
- Schedule: `page365_inventory_auto_apply_run` (PR 3 body, md5-guarded) hides after the
  decreases, inside the `applied` gate. Run audit `page365_inventory_auto_apply` gains
  `hidden`, `hide_changed_since_fetch`, `hide_skipped`, `hide_failed`, `hidden_codes`.
- Bells: ONE per run that hid anything, `page365_inventory_hidden` (opens Website → Page365
  stock). A scheduled run that hid and also decreased rings this one bell (it mentions the
  decreases); `page365_inventory_auto_applied` rings only when nothing was hidden. Staff
  hides ring on the first Apply that hid something in that run (`hide_notified_at`).
- `page365_inventory_runs.hidden_count` = products hidden from the run (both paths).

**Hub UI.** Review card: "Hide on website" (pre-ticked; "Hidden"/"Auto-hidden" badges) and
"Back in Page365 — re-publish?" (tick to re-publish; applied after the stock rows). Hub-only
flagged rows explain why they are not hidden. Schedule card: a "Hidden" column in the run
history, and the automatic text says "N products hidden on the website". Catalog: a draft the
Hub hid shows "Hidden — no longer on Page365 (YYYY-MM-DD)" (PHT day) under its status.

## QUICK FETCH — quick reads, a nightly full read, automatic increases (added 2026-10-02, PR 3c)

Migration `20261002100000_page365_quick_fetch.sql` (owner runs it after the release is on
main, BEFORE `page365-inventory-fetch` is redeployed). Local SQL tests:
`docs/sql/20261002_page365_quick_fetch_local_tests.sql` (92 checks; the PR 3 and PR 3b suites
pass on top — their "increases never automatic" checks were updated to the new rule). Unit
and pins: `src/test/page365-quick-fetch.test.tsx`.

**Owner decisions (final, 2026-09-26).**
1. **Automatic increases.** Staff confirm every website sale in Page365, so Page365 is the full
   truth. With the switch ON, a scheduled read applies increases as well as decreases and
   hides. Unchanged safety: target = Page365 available − unconfirmed website holds (− unpaid
   invoice holds while `page365_hold_unpaid_invoices`); compare-and-set; never below zero;
   "Don't sync with Page365" products never touched (read live); partial/failed runs change
   nothing; the 30-minute window and the superseded check. STILL MANUAL: Create drafts, photo
   copies, price differences, re-publishing hidden products. On the review screen increases
   are pre-ticked like decreases (still sent only in the increase list).
2. **Quick reads.** Every scheduled 30-minute read, and the default "Fetch Page365 inventory"
   button, read the catalogue LIST (two requests — it is cumulative) and open a product page
   ONLY for listings that can hold a Hub product.
3. **Full reads** open every page: once a night on the schedule, and the secondary "Full fetch"
   button. They feed "New in Page365".
4. **Create drafts reads each ticked listing FRESH** (quantity, variants, all photos).

**Which pages a quick read opens — `page365_inventory_plan_quick(run)`** (service role, called
by the edge function right after the list is queued). A Hub code is `page365_first_word(sku)`
of a product that is not `archived` and not switched off. A listing's page is opened when
(a) the first word of its LIST name is a Hub code, or (b) an earlier kept read found a Hub code
on one of its variants (multi-variant listings put the codes on the variants: E1053 / E2057),
or (c) a Hub product was drafted from it (`website_products.page365_product_id`). Every other
listing becomes `page365_inventory_products.status = 'listed'` (seen on the list, page not
opened — never claimed, never open, never an error). `runs.products_total` = pages to open,
`runs.listed_total` = listed-only, `runs.page365_count` = the LIST count. If the plan fails,
the run is switched to `full` and reads everything (the safe side).

**What stays the same for a quick read.** The shrink guard compares the LIST count
(`page365_count`) with the previous ready run's, as before. "Missing" for hide-follow: a Hub
product whose code is absent from the read is Hub-only exactly as in a full read — its listing
would have been opened by (a)/(b)/(c) if it were on the list. A quick read is complete (ready)
only if the list read is complete AND every opened page was read; a page error makes it
partial and nothing is applied or counted, as before. Presence (`page365_product_presence`) is
recorded from the matched rows of the read. The one change in `page365_inventory_finish`: a
quick read leaves products switched to "Don't sync" out of the Hub-only list (it never opened
their pages, so it cannot say they are missing). Known limit: a Hub code that moves onto a
variant of a listing never read before and whose list name starts with another code is not
seen by quick reads until the next full read; if its old listing is gone meanwhile, hide-follow
may hide it, and the full read then flags it "Back in Page365 — re-publish?".

**The nightly full read — `page365_inventory_next_kind()`.** The first SCHEDULED read that
starts at or after `system_settings.page365_inventory_full_hour_pht` (default `2` = 02:00 PHT =
03:00 JST) each day is `full`; so is the next one if that read failed outright. A staff "Full
fetch" does not replace it. The pg_cron job is unchanged (`page365-inventory-schedule`, every
5 minutes); a full read of ~570 pages takes two or three ticks, well inside its 30-minute
window. The hour is in PHT (the canonical timezone), not Asia/Tokyo.

**Automatic increases — `page365_inventory_auto_apply_run`** (PR 3b body, md5-guarded): rows
with `category IN ('decrease','increase')`, direction checked (`not_a_stock_change`
otherwise), `UPDATE … WHERE stock_qty = seen_stock AND stock_qty <> proposed`. Audit rows carry
`direction` = decrease | increase. `runs.auto_increased` counts the increases among
`auto_applied`. The one bell per run: `page365_inventory_auto_applied`, title "Page365 stock
updated automatically", body "N decrease(s) and M increase(s) … Down: … Up: …"; the hidden
bell mentions both counts. A product back in Page365 that the Hub hid gets its increase
automatically but stays a draft (never re-published by itself).

**New in Page365 and Create drafts.** The review list shows New in Page365 from the latest
READY FULL run, labelled "Quantities as of the full fetch of <time> PHT"; "In stock only" uses
those quantities. A row whose listing is missing from the latest read's list (any kind) is
greyed out and cannot be ticked. `page365_inventory_create_drafts` (PR 4 body, md5-guarded)
now: refuses a run that is not `full` (`not_full_fetch`); counts as superseded only by a newer
ready FULL run (quick runs every 30 minutes do not supersede it); allows 48 h (one nightly
read may fail); skips a row whose listing was not read in the last 15 minutes (`not_fresh`) or
is gone (`gone_from_page365`). The Hub's "Create drafts" first calls the edge action
`refresh` in a loop: it re-reads each ticked listing (≤ 40 per call, ≤ 4 req/s) through
`page365_inventory_refresh_product`, which updates the listing (name, prices, photos,
`fetched_at`) and its NEW rows under review (quantity, price, names, code) in place, marks new
rows whose variant or listing (HTTP 404) left Page365 `gone_from_page365`, and never touches a
stock row. Then the drafts are created, and the photo copier copies the fresh gallery.

**One reader.** A refresh takes `page365_inventory_reader` (a one-row lease,
`page365_inventory_reader_lease`) only while no run lease is held; a chunk reader takes its
run lease first and then backs off (`busy`) while the reader lease is held — so the two never
read at once. The browser waits and retries on `busy`.

**Hub UI.** Inventory card: "Fetch Page365 inventory" = quick (default), secondary "Full
fetch"; the last-fetch line says quick/full, how long, and for quick reads "N products listed,
M page(s) read"; increases pre-ticked; New in Page365 from the latest full read with its "as
of" label. Schedule card: "Automatic updates every 30 minutes (decreases, increases, hiding)";
run history columns Kind (Quick/Full) and Took (duration); the automatic text counts decreases
and increases apart.

**Expected quick-read time.** 2 list requests (~1–3 s) + one page per Hub listing at 4
requests/s + one store call each. With H Hub listings: ≈ 3 s + H/4 s (e.g. 60 → ~20 s, 150 →
~40 s). Count H with verification (6) of the migration.

