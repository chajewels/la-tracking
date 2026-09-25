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
| `excluded` | the variant has a #195 `page365_stock_lines.stock_state = 'held'` line | shown, never tickable (until PR 2) |
| `flagged` | `no_code`, `duplicate_in_page365`, `ambiguous_sku`, `no_variant`, `ambiguous_variant` | shown with the reason |
| `new` | code not in the Hub | listed only — nothing created |
| `hub_only` | active/draft Hub product whose code is absent from a **complete** read | flagged with the count of consecutive runs; never zeroed |

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

**Still #195's job until PR 2:** invoice imports keep taking stock; that is why held
variants are excluded here. PR 2 switches imports to ledger-only (`inventory_sync`),
PR 3 adds the 30-min schedule (decreases only), PR 4 "Create draft" — docs/PENDING.md.
