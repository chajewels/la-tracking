# Shopify Integration — Architecture & Roadmap

Status: Phase 5 go-live COMPLETE (2026-07-10) — real Shopify orders flow into the Hub end-to-end (create → customer match → items → paid → payment + loyalty award), verified with live orders SH-1002 (marked-paid) and SH-1003 (bank deposit). Loyalty opt-in at checkout enrolls customers (verified). OPEN: reversal handling (cancel/refund → store credit) and inventory writeback are not built — see Open items.
Owner: Cynthia. Single source of truth for the Shopify↔Hub integration.
CLAUDE.md points here; do not duplicate this content there.

## 1. Purpose & shape
One-way integration: Shopify → Hub. The Hub NEVER writes back to Shopify.
Shopify is the PRODUCT CATALOG MASTER. All jewelry products are uploaded to
Shopify (any status). Orders reach the Hub via two paths, both landing as
cash_orders under the matched customer, tagged by origin. Cash payment only —
no layaway/installment logic applies to Shopify-originated orders. JPY store
(chajewels-2.myshopify.com), pre-launch at time of design.

## 2. Two order-origination paths
PATH A — Social / live (Facebook Live, comments, Page365):
  Staff MANUALLY create the order in the Hub, PICKING product items from the
  synced Shopify catalog (selectable, not free-typed). Money may be collected
  at creation or later (order born 'pending', marked paid when payment recorded).

PATH B — Shopify storefront (direct online order):
  Order placed in Shopify → webhook → Hub ingests in real time with full
  line-item detail, matched to customer by email, tagged 'shopify_direct'.
  Payment recorded when orders/paid fires (checkout-captured OR COD-marked-paid;
  the webhook is the source of truth for "money in hand").

## 3. Product catalog — the four statuses (Admin API, version 2026-07)
The Hub syncs off the ADMIN API, which returns ALL statuses — unlike the
Storefront API, which filters. So EVERY uploaded product is pickable for a
manual Path-A order regardless of storefront visibility:
  - active   — sellable on storefront; discoverable
  - draft    — not ready to sell; NOT on storefront; still Admin-readable/pickable
  - unlisted — "hidden": live by direct link only, hidden from search/collections;
               still Admin-readable/pickable
  - archived — no longer sold
Sync MUST store the explicit status. API version MUST be >= 2025-10 (ours is
2026-07) — older versions mis-report unlisted as active. Known Admin-API quirks
to handle: drafts occasionally returned as status:ACTIVE; publications empty for
drafts. Key off the explicit status field; treat all non-archived as pickable
for manual orders.

## 4. Schema additions (Phase 1-2 — none built yet)
  - products (new): mirror of Shopify catalog — shopify_product_id, title, sku,
    price_jpy, vendor, status, handle, image_url, synced_at. Source for Path-A
    picker and Path-B line-item resolution.
  - cash_order_items (new): line-item child of cash_orders — resolves the fact
    that cash_orders today has ONLY item_description text, no line structure.
  - cash_orders.source_channel (new column): 'shopify_direct' | 'social_manual'
    (default preserves existing rows). Origin tagging.
Existing cash_orders lifecycle REUSED as-is: born 'pending', total_paid/
remaining_balance tracked, -> 'completed'. No change to total_amount (locked).

## 5. Security & idempotency (locked)
  - HMAC-SHA256 constant-time verification on every inbound webhook, using
    SHOPIFY_API_SECRET (Bug #168 pattern — never string equality).
  - Idempotency keyed on Shopify order ID per event type (Shopify retries on
    non-2xx; orders/create + orders/paid reference the same order).
  - Receiver returns 2xx immediately, processes async (Shopify 5s / retry rule).
  - Auth: Dev-Dashboard app — NO stored shpat_ token. Edge function derives a
    short-lived token at runtime via client-credentials grant from
    SHOPIFY_API_KEY + SHOPIFY_API_SECRET. (Exact grant flow verified at build.)

## 6. Customer matching (locked)
  Email primary -> mobile_number fallback -> create-and-flag. No silent fuzzy
  merges; no match creates a new customers row flagged for manual review.

## 7. Webhooks (registered in Phase 5, after receiver URL exists)
  orders/create, orders/paid, orders/cancelled, orders/updated,
  customers/create, products/create, products/update.

## 8. Credentials (Phase 0 — DONE, Supabase secrets)
  SHOPIFY_API_KEY. SHOPIFY_API_SECRET (shpss_, = HMAC key).
  SHOPIFY_STORE_DOMAIN = chajewels-2.myshopify.com.
  (No SHOPIFY_ADMIN_ACCESS_TOKEN — derived at runtime.)

## 9. Roadmap
  Phase 0 (DONE) — store, custom app, scopes (read_all_orders, read_customers,
              read_products, read_orders), install, credentials, schema verified.
  Phase 1 (DONE 2026-07-08) — Product catalog sync LIVE. products table +
            shopify-sync-products edge function (deployed). Client-credentials
            token grant, GraphQL Admin API 2026-07, full+delta modes,
            system_settings cursor. Verified: 173 products backfilled (2 pages),
            four-status mapping, collections array, inventory, upsert-on-
            shopify_product_id all proven against live data.
  Phase 2 (DONE 2026-07-08) — Line-item schema in place. cash_order_items
            child table (snapshot title/sku/unit_price; product_id FK to
            products;
            (shopify_line_item_id was NOT actually added in Phase 2 — it and
            cash_orders.shopify_order_id were added in Phase 4's P4-1 migration.)
            ON DELETE CASCADE) + cash_orders.source_channel text NOT NULL
            DEFAULT 'hub_manual' CHECK IN (hub_manual|shopify_direct|
            social_manual). All 97 existing cash orders backfilled to
            hub_manual (zero migration). RLS mirrors cash_payments
            (admin_all / staff_admin_insert / staff_finance_read). Schema
            only — no writer yet (Phase 3 picker + Phase 4 webhook write here).
  Phase 3 (DONE 2026-07-09) — Path A product picker LIVE in NewCashOrder
            (writes cash_order_items client-side, source_channel=social_manual
            best-effort, total_amount stays authoritative). Line-item DISPLAY
            also shipped: staff CashOrderDetail "Items" card + customer portal
            "View Items" toggle (Maison-themed, shows only when items exist).
            image_url snapshotted onto cash_order_items (durable; keeps portal
            off the Hub-internal catalog). Verified end-to-end: Test-0010 →
            A4724 anklet + image visible on both staff and portal surfaces.
  Phase 4 (DONE 2026-07-10) — Path B storefront webhook receiver BUILT + DEPLOYED.
            Edge function shopify-webhook: HMAC-SHA256 constant-time verify
            (SHOPIFY_API_SECRET), idempotency (shopify_webhook_events + unique
            indexes), orders/create → customer-match/create-and-flag → cash_order
            (source_channel=shopify_direct) + items, orders/paid → payment +
            award-loyalty-points. Deployed, 401 forged-request reject verified.
            IDLE until Phase 5 registers webhooks. cancel/update topics + the
            paid-before-create edge case are deferred to Phase 5.
  Phase 5 — Register orders/create + orders/paid webhooks (Shopify Admin API/UI)
            pointing at the shopify-webhook invoke URL; real test order end-to-end
            (order flows into Hub, customer matched-or-flagged, paid→payment+loyalty);
            then handle deferred topics (cancel/update), the paid-before-create
            fallback, and product/image enrichment (webhook items store
            product_id=null, image_url=null — no reliable catalog map from the
            order payload). Plus the unified per-customer order view. Q1 inventory
            writeback (Hub picking doesn't decrement Shopify stock) still deferred.

## 10. Open items
  - Loyalty on Shopify orders: fire award-loyalty-points on orders/paid, reusing
    the existing JPY formula (JPY-only store = no conversion). Confirm at Phase 4.
  - Whether A4724-style codes are set as true Shopify SKU fields vs. only in the
    title — sync must check per product (Phase 1).
  - REVERSAL HANDLING (not built) — Shopify orders/cancelled + refunds/create are
    NOT registered, so a cancelled/refunded Shopify order (e.g. SH-1002, refunded
    in Shopify) still shows Completed/paid in the Hub. Per business policy, reversals
    do NOT refund money — they convert to STORE CREDIT (usable up to 1 year). This
    requires a system-wide store-credit feature (no store_credit table/system exists
    today, even for native orders) and Cynthia's policy decisions (issuance, expiry,
    usage, cash+layaway scope, redeemed-points handling) BEFORE building. Must be
    built system-wide (native first), then Shopify reversals hook into it — not
    Shopify-only. Parked pending policy.
  - INVENTORY WRITEBACK (not built) — Hub picking / Shopify refunds do not sync stock
    back to Shopify (one-way design). A refunded Shopify item is not auto-restocked
    via the Hub. Deferred.

## 11. Phase 1 findings (live data, 2026-07-08)
  - 173 products in catalog; ALL currently status='active' (none draft/
    unlisted/archived at sync time).
  - Product codes (e.g. "A4724") live in the TITLE, not the Shopify sku field
    — sku synced as NULL. Picker matches/displays by title. (Resolves the
    §10 open item.)
  - inventory_quantity IS trackable and syncs correctly: setting the A4724
    anklet to 1pc in Shopify flowed through to inventory_quantity=1. At sync
    time 172/173 were inventory 0 (stock not yet entered pre-launch).
  - OPEN for Phase 3 (picker): availability signal choice — status is too
    coarse (all active), inventory is truthful only if stock is maintained in
    Shopify; may need a Hub-side sold-flag. Decide at picker build.
  - OPEN for Phase 3: inventory freshness — full backfill catches inventory
    edits; whether pure inventory edits are caught by DELTA mode (vs periodic
    full) is unproven. At 173 products a periodic full sync is cheap and may
    suffice; inventory_levels/update webhook is the alternative if delta misses.

## 12. Portal line-item display (2026-07-09)
  - customer-portal edge function nests each cash order's items into the
    payload (parallel cash_order_items fetch keyed on cashOrderIds, grouped
    into an `items` array per order). Deployed.
  - CashOrdersSection "View Items" bar mirrors the PAYMENT HISTORY bar
    (Maison ivory, portal-tokens only), renders only when items exist; older
    orders (no items) show no bar.
  - RLS NOTE / correction: a "Customers can view own cash order items" policy
    (auth.uid()-scoped) was added to cash_order_items, but it is INERT for the
    portal — the portal reads via the customer-portal EDGE FUNCTION using the
    service role (scoped by portal token server-side), NOT via authenticated
    client RLS. The policy is harmless and correct-if-ever-needed (if the
    portal moves to authenticated client reads), but it is not the mechanism.
    The edge-function payload is the actual read path.
  - image_url on cash_order_items is a SNAPSHOT (captured at pick time,
    backfilled for existing rows) so the portal never needs read access to the
    Hub-internal products catalog.
  - Thumbnails are click-to-zoom (2026-07-09): staff CashOrderDetail uses the
    existing shadcn Dialog (Deco Ledger); the portal uses a Maison inline-style
    full-screen overlay (tap-backdrop or × to close, image tap does not close;
    portal-tokens only, no shadcn/Hub styling). Non-null images only; the null
    placeholder is non-interactive.

## 13. Layaway picker + Account Financial Breakdown (2026-07-09)
  - Layaway picker: product picker added to NewAccount (mirrors the cash picker),
    writing layaway_account_items client-side after create-layaway-account returns
    account.id. No source_channel (layaway has none). Staff display: Items card +
    click-to-zoom on AccountDetail (items shown in ¥, catalog currency). Portal
    display: "View Items" toggle + zoom on the layaway account CARD in the portal
    list (matching the cash-order card), items shown in the ACCOUNT currency
    (JPY→PHP converted for display). Edge function customer-portal nests
    layaway_account_items into the accounts payload.
  - Currency-correctness: both pickers (cash + layaway) now convert the JPY items
    subtotal to the account currency when suggesting total_amount (PHP = JPY × rate,
    live rate from system_settings.php_jpy_rate). Items stay JPY; the suggested
    total is in account currency. Fixed a ~380× yen-as-pesos error on PHP accounts.
  - AFB (discount + shipping): see SCHEMA-FACTS "AFB" entry. Descriptive breakdown
    on both account types, creation + admin-gated edit, total stays authoritative.
  - Display currency rule: staff see items in ¥ (catalog truth); customers see items
    in their account currency (converted). Item tables store JPY; conversion is
    display-only.

## 14. Phase 4 — Shopify webhook receiver (2026-07-10)
  - Endpoint: supabase/functions/shopify-webhook (public; verify_jwt effectively
    off — the request reaches our HMAC gate, not a Supabase auth wall).
    Invoke URL: https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/shopify-webhook
  - SECURITY: reads raw body (req.text()) BEFORE parsing; computes
    base64(HMAC-SHA256(rawBody, SHOPIFY_API_SECRET)) via Web Crypto; constant-time
    compares to X-Shopify-Hmac-Sha256 (no ===, no early return); 401 before any DB
    access on mismatch. NOT the @lovable.dev/webhooks-js helper (that's a different
    scheme).
  - IDEMPOTENCY (two layers): shopify_webhook_events (shopify_order_id, topic) UNIQUE
    for retry-skip + audit; cash_orders.shopify_order_id UNIQUE + 
    cash_order_items.shopify_line_item_id UNIQUE as hard DB backstops (23505 treated
    as already-created, not fatal).
  - orders/create: §6 customer match (email ilike → mobile_number → create-and-flag
    with source='shopify', needs_review=true) → cash_order (invoice SH-{order#},
    currency JPY, total from total_price, expires_at +30d, loyalty_jpy_amount=total,
    source_channel=shopify_direct) → cash_order_items (upsert on shopify_line_item_id).
  - orders/paid: find by shopify_order_id (not found → 200 deferred, no create here) →
    cash_payments (ref SHOPIFY-{id}) → order completed → invoke award-loyalty-points
    (fire-and-forget; loyalty failure never fails the webhook).
  - Errors after HMAC: record status='error' event + 500 (Shopify retries;
    idempotency makes retries safe). Other topics: 200-acknowledged, ignored.
  - All DB writes via service role (public webhook, no user JWT).

## 15. Phase 4 fixes + Phase 5 go-live (2026-07-10)
  - Two receiver bugs found on the first real order and fixed:
    * Line items failed with "no unique or exclusion constraint matching the ON
      CONFLICT specification" — cash_order_items.shopify_line_item_id is a PARTIAL
      unique index (WHERE ... IS NOT NULL) which upsert onConflict cannot target.
      Fixed: plain .insert(rows) with 23505 treated as already-inserted. Added a
      line_items count diagnostic log.
    * orders/paid arrived before orders/create finished (near-simultaneous
      delivery) → order not found → paid was dropped. Fixed: paid-not-found now
      returns 500 { order_not_found_yet } (was 200) so Shopify RETRIES; by the
      retry orders/create has completed. No event row recorded for the not-found
      case so idempotency lets the retry through.
  - Webhooks registered via shopify-register-webhooks (admin-gated edge fn) using
    webhookSubscriptionCreate (ORDERS_CREATE + ORDERS_PAID), signed with the app's
    API secret = matches the receiver's HMAC. Idempotent (checks existing subs).
  - Verified end-to-end: SH-1002 (Create order → Mark as paid → completed + payment
    + loyalty), SH-1003 (bank-deposit → created Pending, then paid → completed).
    Bank-deposit orders correctly stay Pending until the deposit is marked paid in
    Shopify (orders/paid only fires then) — not a bug.

## 16. Loyalty opt-in at Shopify checkout (2026-07-10)
  - Goal: let Shopify customers join the loyalty program by opting in at checkout
    (Grow plan — no Checkout Extensibility, so a CART-ATTRIBUTE approach is used).
  - Storefront: a Custom Liquid block on the cart page renders a checkbox that, on
    change, POSTs to /cart/update.js setting cart attribute loyalty_opt_in='true'
    (cleared when unchecked). This flows into the order as a note_attribute.
  - Webhook (shopify-webhook, orders/create): reads order.note_attributes (primary)
    / order.attributes (fallback) for 'loyalty_opt_in' (case-insensitive, truthy).
    If opted-in AND customer resolved, calls join-loyalty-program via its
    internal-secret path to enroll. Best-effort — never fails the webhook.
  - Enrollment reuse (no duplication): join-loyalty-program gained a guarded
    internal auth branch — a caller presenting header 'x-internal-secret' matching
    the INTERNAL_FUNCTION_SECRET env + a body customer_id enrolls that customer,
    skipping portal/JWT auth. Wrong secret = explicit 401. All existing enrollment
    logic (member insert, enrolled tx, retro award, sheet/email) is unchanged, and
    the loyalty_enabled go-live gate still applies. REQUIRES the Supabase secret
    INTERNAL_FUNCTION_SECRET to be set (project-wide; both functions read it).
  - Enrollment happens on orders/create; points award on orders/paid (unchanged),
    so an opted-in customer is enrolled immediately and earns points once the order
    is paid. Verified: SH-1003 enrolled CYNTHIA LARGO (Glimmer).
