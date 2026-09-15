-- Web layaway item lines: the two columns 20260914110000 failed to add.
--
-- WHY THIS FILE EXISTS — CREATE TABLE IF NOT EXISTS IS THE WRONG TOOL FOR A
-- TABLE THAT MAY ALREADY EXIST IN A DIFFERENT SHAPE.
--
-- 20260914110000_web_layaway_schema.sql declared public.layaway_account_items
-- with CREATE TABLE IF NOT EXISTS, listing eleven columns including
-- website_product_id and variant_id. The table ALREADY EXISTED in the live
-- database, created earlier for the Hub's Shopify-style line-item picker with a
-- different column set. IF NOT EXISTS is all-or-nothing: it matches on the NAME
-- only, so Postgres saw the table, skipped the entire body, raised nothing, and
-- the migration reported success. Two columns silently never arrived.
--
-- That is the failure mode to remember: IF NOT EXISTS reports success while
-- doing nothing. It guards against re-running your own migration; it does NOT
-- reconcile a table someone else already created. For a table that may exist in
-- another shape the honest tools are ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- (per column, so each is independently checked) or an explicit catalog probe.
--
-- Everything else in that migration DID apply — verified against the live
-- catalogs on 2026-09-14, 25 objects checked, exactly these two missing:
--   applied: 13 columns, 3 check constraints, 3 indexes, 3 RLS policies,
--            1 trigger
--   missing: layaway_account_items.website_product_id
--            layaway_account_items.variant_id
-- The RLS policies were NOT skipped: they are separate statements after the
-- CREATE TABLE, each already guarded by DROP POLICY IF EXISTS. All three are
-- live and correctly scoped, so this migration adds no policy and no grant.
--
-- WHAT BREAKS WITHOUT THIS (all three verified against main@8ebe539a):
--   1. create_web_layaway_atomic INSERTs both columns -> the first web layaway
--      fails outright.
--   2. expire_web_layaway_atomic returns stock through variant_id -> the hourly
--      sweep silently returns no stock on expiry.
--   3. website/index.ts:1280, GET /layaway/:id, already SELECTs both columns ->
--      the customer's own plan detail page 400s on every load, for any web
--      layaway, from the moment that function deploys.
--
-- SHAPE: mirrored exactly from the sibling table public.cash_order_items, which
-- is live for both Shopify and the web path and already carries product_id,
-- website_product_id and variant_id side by side. product_id references the
-- Hub's internal catalog public.products (173 rows); website_product_id
-- references the storefront catalog public.website_products (3 rows). They are
-- different catalogs with different lifecycles — website_product_id is NOT a
-- duplicate of product_id, and the sibling proves the pair is the intended
-- design rather than an accident.
--
-- SAFETY: the table holds ZERO rows (verified 2026-09-14) and Shopify does not
-- write to it at all — shopify-webhook has no reference to it and writes only
-- cash_order_items. The one live writer, src/pages/NewAccount.tsx:628, inserts
-- a fixed eight-column list; the readers (AccountDetail.tsx:114,
-- customer-portal:334, website:1280) all name their columns explicitly. Two
-- nullable columns therefore break nothing. Nothing here alters, renames or
-- drops an existing column: Shopify's and the portal's columns are untouched.

ALTER TABLE public.layaway_account_items
  ADD COLUMN IF NOT EXISTS website_product_id uuid
    REFERENCES public.website_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_id uuid
    REFERENCES public.website_product_variants(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.layaway_account_items.website_product_id IS
  'Storefront catalog product (public.website_products) for a web layaway line. NULL for Hub-picker lines, which carry product_id against public.products instead. Mirrors cash_order_items.website_product_id.';

COMMENT ON COLUMN public.layaway_account_items.variant_id IS
  'Storefront variant (public.website_product_variants) this line holds stock against. expire_web_layaway_atomic returns stock through this column, so a NULL here means a web line whose stock cannot be released. Mirrors cash_order_items.variant_id.';

-- The two partial indexes cash_order_items already carries, same predicates.
CREATE INDEX IF NOT EXISTS idx_layaway_account_items_variant
  ON public.layaway_account_items (variant_id) WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_layaway_account_items_website_product
  ON public.layaway_account_items (website_product_id);

-- LEFT IN PLACE DELIBERATELY: idx_layaway_account_items_account duplicates the
-- pre-existing idx_layaway_items_account — same table, same single column,
-- same method. 20260914110000 added it without knowing the table was already
-- there with its own index. Dropping an index is a separate concern from
-- unblocking this release, and the table is empty, so the redundancy costs
-- nothing today beyond a second entry to maintain on future writes. If it is
-- ever tidied, drop idx_layaway_account_items_account (the newer, redundant
-- one) and keep idx_layaway_items_account.
