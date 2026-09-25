-- ===========================================================================
-- page365_inventory_drafts — "Create drafts" from the codes Page365 has and
-- the Hub does not, and bulk "Publish" in Catalog (PR 4 of 4).
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- and AFTER 20260927100000_page365_inventory_fetch (PR 1) and PR 2's migration.
-- One transaction. It is INERT until someone presses "Create drafts" or
-- "Publish": nothing below touches an existing product, variant or photo.
--
-- Plan: ~/Code/reference/page365-inventory-fetch-investigation.md (PR 4,
-- owner-approved). Owner rules this file enforces:
--   * NOTHING APPEARS ON THE WEBSITE UNTIL A PERSON PUBLISHES IT. Every
--     product created here is status 'draft'. The storefront shows 'active'
--     only.
--   * ONE HUB PRODUCT PER NEW PAGE365 CODE. The code is the review item's
--     (PR 1's per-VARIANT rule): a single-variant listing gives one product; a
--     listing carrying several codes (E1053 / E2057) gives one product per
--     code, each with ONE variant, because #195's matcher only ever matches a
--     code to a product with exactly one variant. sku = the code.
--   * IDEMPOTENT. A code already in the Hub is skipped (code_exists), a Page365
--     listing+variant already drafted is skipped (already_created), and sku is
--     UNIQUE, so a second press or a race never duplicates.
--   * MONEY FROM THE HUB, YEN IS THE PRICE OF RECORD. The draft's price_jpy is
--     Page365's yen price for that variant, stored once; nothing converts.
--   * STOCK = max(0, Page365 available - website holds). A brand-new variant
--     has no website holds, so it is Page365's available as the fetch saw it.
--   * ORIGIN IS NEVER GUESSED. Every draft is origin 'UNKNOWN' and flagged
--     "needs origin"; publishing is refused until staff set it.
--   * CATEGORY only where Page365's category names a jewelry type the Hub has
--     exactly one category for ("Rings MIJ" -> Rings). Supplier listings and
--     anything else stay uncategorised and are flagged "needs category";
--     publishing is refused until staff set one.
--   * METAL STAMPS only as Page365 printed them (a whole word equal to one of
--     the Hub's stamps: K18, PT900, ...). None printed -> not created (the
--     column requires one), reported as failed with the reason.
--   * DESCRIPTION only if Page365's text is clean (no links, e-mail, phone,
--     @handles, HTML, or banned gold wording); otherwise left empty. Customer
--     reviews are never read: the text comes from the catalogue LIST, which
--     carries none, and review blocks are dropped by the PR 1 parser.
--   * PHOTOS: the review item becomes 'matched' to the new variant, so the PR 1
--     copier (page365-inventory-photos -> page365_inventory_record_photo) copies
--     every photo in Page365's order, first = main, deduplicated per photo id.
--   * BULK PUBLISH (website_publish_products) refuses any product missing
--     origin, category, a brand name (origin BRAND), a metal stamp or a price,
--     and names what is missing. A trigger backs this for Page365 drafts, so
--     the product dialog cannot publish one around it.
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if the live schema is not what this was written against.
-- md5 guards (section 0b) pin the PR 1 function BODIES this relies on.
--   >>> PROVISIONAL: computed against PR 1 as merged (#197). They are
--   >>> regenerated against the post-PR 2 bodies before this PR leaves draft.
-- Re-running the file is safe (IF NOT EXISTS / CREATE OR REPLACE / DROP IF
-- EXISTS on objects this file owns).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0a. Pre-flight: tables, columns, helpers.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_n       integer;
BEGIN
  IF to_regclass('public.page365_inventory_runs')     IS NULL THEN v_missing := v_missing || 'page365_inventory_runs (PR 1: run 20260927100000 first)'::text; END IF;
  IF to_regclass('public.page365_inventory_products') IS NULL THEN v_missing := v_missing || 'page365_inventory_products'::text; END IF;
  IF to_regclass('public.page365_inventory_items')    IS NULL THEN v_missing := v_missing || 'page365_inventory_items'::text; END IF;
  IF to_regclass('public.website_products')           IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants')   IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.website_categories')         IS NULL THEN v_missing := v_missing || 'website_categories'::text; END IF;
  IF to_regclass('public.website_category_products')  IS NULL THEN v_missing := v_missing || 'website_category_products'::text; END IF;
  IF to_regclass('public.audit_logs')                 IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_drafts: missing table(s): %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('website_products','id'), ('website_products','sku'), ('website_products','slug'), ('website_products','name'),
      ('website_products','status'), ('website_products','origin'), ('website_products','brand'),
      ('website_products','condition'), ('website_products','metals'), ('website_products','description_en'),
      ('website_product_variants','id'), ('website_product_variants','product_id'), ('website_product_variants','price_jpy'),
      ('website_product_variants','stock_qty'), ('website_product_variants','sort'),
      ('website_categories','id'), ('website_categories','slug'), ('website_categories','name'),
      ('website_category_products','category_id'), ('website_category_products','product_id'),
      ('website_category_products','sort_order'),
      ('page365_inventory_runs','status'), ('page365_inventory_runs','finished_at'), ('page365_inventory_runs','created_at'),
      ('page365_inventory_products','id'), ('page365_inventory_products','price_jpy'), ('page365_inventory_products','photos'),
      ('page365_inventory_items','inventory_product_id'), ('page365_inventory_items','category'),
      ('page365_inventory_items','match_result'), ('page365_inventory_items','status'), ('page365_inventory_items','code'),
      ('page365_inventory_items','page365_available'), ('page365_inventory_items','page365_price_jpy'),
      ('page365_inventory_items','photos_total'), ('page365_inventory_items','photos_to_copy'),
      ('page365_inventory_items','result_note'), ('page365_inventory_items','applied_at'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'),
      ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_drafts: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;

  IF to_regprocedure('public.page365_first_word(text)') IS NULL
     OR to_regprocedure('public.has_permission(uuid,text)') IS NULL
     OR to_regprocedure('public.page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)') IS NULL
     OR to_regprocedure('public.page365_inventory_apply(uuid,uuid[],uuid[])') IS NULL
     OR to_regprocedure('public.page365_inventory_finish(uuid)') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_drafts: PR 1 / #195 functions missing (run 20260926120000 and 20260927100000 first)';
  END IF;

  -- The draft's origin is the column's own "not set" value.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.website_products'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) ILIKE '%origin%' AND pg_get_constraintdef(k.oid) ILIKE '%UNKNOWN%') THEN
    RAISE EXCEPTION 'page365_inventory_drafts: website_products.origin CHECK without UNKNOWN';
  END IF;
  -- The metal stamps a draft may carry must be the CHECK's.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.website_products'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) ILIKE '%metals%' AND pg_get_constraintdef(k.oid) ILIKE '%SILVER925%') THEN
    RAISE EXCEPTION 'page365_inventory_drafts: website_products.metals value CHECK missing';
  END IF;
  -- The item CHECKs this writes into: status 'applied', match_result 'matched'.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.page365_inventory_items'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) ILIKE '%status%' AND pg_get_constraintdef(k.oid) ILIKE '%applied%') THEN
    RAISE EXCEPTION 'page365_inventory_drafts: page365_inventory_items.status CHECK without applied';
  END IF;

  -- Name collisions: refuse same-named columns of a different type.
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'website_products' AND column_name IN ('page365_product_id','page365_variant_id') AND data_type <> 'bigint')
       OR (table_name = 'website_products' AND column_name = 'page365_category' AND data_type <> 'text')
       OR (table_name = 'page365_inventory_products' AND column_name = 'list_category_id' AND data_type <> 'bigint')
       OR (table_name = 'page365_inventory_products' AND column_name IN ('list_category','list_description') AND data_type <> 'text'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_inventory_drafts: a page365_* / list_* column already exists with a different type';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_inventory_create_drafts' AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid, p_item_ids uuid[]')
       OR (p.proname = 'website_publish_products'        AND pg_get_function_identity_arguments(p.oid) <> 'p_product_ids uuid[]')
       OR (p.proname = 'page365_category_for'            AND pg_get_function_identity_arguments(p.oid) <> 'p_page365_category text')
       OR (p.proname = 'page365_metals_from_text'        AND pg_get_function_identity_arguments(p.oid) <> 'p_text text')
       OR (p.proname = 'page365_clean_description'       AND pg_get_function_identity_arguments(p.oid) <> 'p_text text'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'page365_inventory_drafts: a function this file owns already exists with a different signature';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 0b. md5 guards on the PR 1 bodies whose behaviour this relies on
--     (md5 of pg_proc.prosrc — the text between the dollar quotes, which is
--     what was written and does not depend on the server's formatting):
--       page365_inventory_finish       unmatched code -> category 'new'
--       page365_inventory_apply        refuses category 'new' (not a stock change)
--       page365_inventory_record_photo copies onto any MATCHED item of a ready run
--     >>> PROVISIONAL — regenerate after PR 2 is merged (PR 2 changes finish
--     >>> and apply). A mismatch means the body is not the one this file was
--     >>> checked against: stop, nothing is written.
-- ---------------------------------------------------------------------------
DO $md5$
DECLARE
  v_expect CONSTANT jsonb := jsonb_build_object(
    'page365_inventory_finish(uuid)',                                    '725c035cb7785957c6e72c5c4fcc8ece',
    'page365_inventory_apply(uuid,uuid[],uuid[])',                       '57c3077bc1cdc43b9d8f13114be73b18',
    'page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)', '9ae3317140d44dae7f626996bb8c63c7');
  v_fn  text;
  v_got text;
BEGIN
  FOR v_fn IN SELECT jsonb_object_keys(v_expect) LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || v_fn);
    IF v_got IS DISTINCT FROM v_expect->>v_fn THEN
      RAISE EXCEPTION 'page365_inventory_drafts: public.% body md5 is %, expected % — not the body this file was checked against',
        v_fn, coalesce(v_got, 'missing'), v_expect->>v_fn;
    END IF;
  END LOOP;
END
$md5$;

-- ---------------------------------------------------------------------------
-- 1. What the catalogue LIST says about each product (the list carries no
--    reviews). Written by page365-inventory-fetch at "start". Older runs have
--    NULLs: their drafts are simply uncategorised and without description.
-- ---------------------------------------------------------------------------
ALTER TABLE public.page365_inventory_products
  ADD COLUMN IF NOT EXISTS list_category_id bigint,
  ADD COLUMN IF NOT EXISTS list_category    text,
  ADD COLUMN IF NOT EXISTS list_description text;
COMMENT ON COLUMN public.page365_inventory_products.list_category IS
  'Page365 category name from the catalogue list (e.g. "Rings MIJ", "SUPPLIER LISTINGS - JEWELRY"). Drives the review filter and the draft category mapping (page365_category_for).';
COMMENT ON COLUMN public.page365_inventory_products.list_description IS
  'Page365 product description from the catalogue list, verbatim. A draft copies it only through page365_clean_description. The list carries no customer reviews.';

-- ---------------------------------------------------------------------------
-- 2. Where a website product came from. NULL = made in the Hub (form or
--    spreadsheet). One Hub product per Page365 listing+variant.
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS page365_product_id bigint,
  ADD COLUMN IF NOT EXISTS page365_variant_id bigint,
  ADD COLUMN IF NOT EXISTS page365_category   text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_website_products_page365_source
  ON public.website_products (page365_product_id, page365_variant_id) WHERE page365_product_id IS NOT NULL;
COMMENT ON COLUMN public.website_products.page365_product_id IS
  'Page365 listing this product was drafted from (page365_inventory_create_drafts). Publishing such a product requires origin and a category (trg_page365_draft_publish_guard).';
COMMENT ON COLUMN public.website_products.page365_category IS
  'Page365 category name when drafted, kept for staff reference only. The website category is the website_category_products row.';

-- ---------------------------------------------------------------------------
-- 3. Helpers. Pure, deterministic; nothing is inferred beyond what they say.
-- ---------------------------------------------------------------------------

-- Page365 category -> the ONE website category of that jewelry type, or NULL.
-- Only a category whose first word is a jewelry type maps ("Rings MIJ",
-- "Necklace MIJ"); "SUPPLIER LISTINGS - …", "- BRANDED PRELOVED" and anything
-- else do not. The Hub category must match by slug or name (singular or
-- plural) and be the only one that does.
CREATE OR REPLACE FUNCTION public.page365_category_for(p_page365_category text)
RETURNS uuid
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH w AS (
    SELECT regexp_replace(lower((regexp_match(coalesce(p_page365_category, ''), '^\s*([A-Za-z]+)'))[1]), 's$', '') AS word
  ), t AS (
    SELECT word FROM w
     WHERE word IN ('ring','necklace','pendant','bracelet','earring','bangle','anklet','brooch','charm','chain')
  ), hits AS (
    SELECT c.id FROM public.website_categories c, t
     WHERE lower(c.slug) IN (t.word, t.word || 's') OR lower(btrim(c.name)) IN (t.word, t.word || 's')
  )
  SELECT CASE WHEN (SELECT count(*) FROM hits) = 1 THEN (SELECT id FROM hits) END
$fn$;

-- Metal stamps exactly as printed: whole words (split on spaces, slashes,
-- commas, brackets) equal to a Hub stamp, in first-seen order. "0.750ct" is
-- one word, never "750".
CREATE OR REPLACE FUNCTION public.page365_metals_from_text(p_text text)
RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce(array_agg(tok ORDER BY first_at), ARRAY[]::text[])
    FROM (
      SELECT upper(t.tok) AS tok, min(t.ord) AS first_at
        FROM regexp_split_to_table(coalesce(p_text, ''), '[\s　/,()\[\]]+') WITH ORDINALITY AS t(tok, ord)
       WHERE upper(t.tok) = ANY (ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925'])
       GROUP BY upper(t.tok)
    ) s
$fn$;

-- Page365's description, only if clean. Lines trimmed, runs of blank lines
-- collapsed. NULL when empty, over 2,000 characters, or carrying a link,
-- e-mail, @handle, phone number, HTML, or banned gold wording.
CREATE OR REPLACE FUNCTION public.page365_clean_description(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  WITH n AS (
    SELECT btrim(regexp_replace(
             regexp_replace(replace(replace(coalesce(p_text, ''), E'\r\n', E'\n'), E'\r', E'\n'), '[ \t]+\n', E'\n', 'g'),
             '\n{3,}', E'\n\n', 'g'), E' \t\n') AS t
  )
  SELECT CASE
    WHEN t = '' OR length(t) > 2000                                   THEN NULL
    WHEN t ~* '(https?://|www\.|\.com\M|\.net\M|\.jp\M)'              THEN NULL
    WHEN t ~ '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'                       THEN NULL
    WHEN t ~ '(^|\s)@[A-Za-z0-9_.]+'                                  THEN NULL
    WHEN t ~ '\+?[0-9][0-9 \-]{8,}[0-9]'                              THEN NULL
    WHEN t ~ '<[A-Za-z/!]'                                            THEN NULL
    WHEN t ~* '\m(japan(ese)?|saudi|italian|dubai|hk|chinese) gold\M' THEN NULL
    ELSE t END
  FROM n
$fn$;

REVOKE ALL ON FUNCTION public.page365_category_for(text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.page365_metals_from_text(text)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.page365_clean_description(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_category_for(text), public.page365_metals_from_text(text),
                          public.page365_clean_description(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Create drafts for ticked "New in Page365" rows. A signed-in user with
--    manage_website_catalog (same gate as apply). One product per item, each
--    in its own sub-transaction: one bad row never undoes the others.
--    Returns created / skipped / failed with the item and product ids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_create_drafts(p_run_id uuid, p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_id       uuid;
  v_it       public.page365_inventory_items%ROWTYPE;
  v_prod     public.page365_inventory_products%ROWTYPE;
  v_found    boolean;
  v_multi    boolean;
  v_name     text;
  v_price    integer;
  v_stock    integer;
  v_metals   text[];
  v_desc     text;
  v_cond     text;
  v_cat      uuid;
  v_slug     text;
  v_n        integer;
  v_pid      uuid;
  v_vid      uuid;
  v_existing uuid;
  v_needs    text[];
  v_created  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_failed   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF cardinality(coalesce(p_item_ids, '{}')) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_selected');
  END IF;
  IF cardinality(p_item_ids) > 700 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many');
  END IF;

  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready', 'status', v_run.status);
  END IF;
  IF v_run.finished_at < now() - interval '24 hours' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_stale');
  END IF;
  IF EXISTS (SELECT 1 FROM public.page365_inventory_runs r
              WHERE r.status = 'ready' AND r.created_at > v_run.created_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'superseded');
  END IF;

  FOR v_id IN SELECT DISTINCT x FROM unnest(p_item_ids) x ORDER BY 1 LOOP
    SELECT * INTO v_it FROM public.page365_inventory_items WHERE id = v_id AND run_id = p_run_id FOR UPDATE;
    v_found := FOUND;
    IF NOT v_found THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'reason', 'not_in_run');
      CONTINUE;
    END IF;
    IF v_it.result_note = 'draft_created' THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'already_created',
                                                   'product_id', v_it.website_product_id);
      CONTINUE;
    END IF;
    IF v_it.kind <> 'page365' OR v_it.category <> 'new' OR v_it.match_result <> 'unmatched' OR v_it.status <> 'review'
       OR v_it.code IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'not_new');
      CONTINUE;
    END IF;

    -- The code is in the Hub now (made by hand since the fetch, or a sku with
    -- the code as its first word): never a second product.
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE public.page365_first_word(wp.sku) = v_it.code ORDER BY wp.created_at LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_exists',
                                                   'product_id', v_existing);
      UPDATE public.page365_inventory_items SET result_note = 'code_exists' WHERE id = v_id;
      CONTINUE;
    END IF;
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id;
    IF v_existing IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'already_created',
                                                   'product_id', v_existing);
      CONTINUE;
    END IF;

    SELECT * INTO v_prod FROM public.page365_inventory_products WHERE id = v_it.inventory_product_id;
    SELECT count(*) INTO v_n FROM public.page365_inventory_items j WHERE j.inventory_product_id = v_it.inventory_product_id;
    v_multi := v_n > 1;
    -- A listing carrying several codes: each product is named by its variant.
    v_name  := btrim(CASE WHEN v_multi AND btrim(coalesce(v_it.variant_name, '')) ~ '\S\s+\S' THEN v_it.variant_name
                          ELSE coalesce(v_it.page365_name, v_prod.name, v_prod.list_name) END);
    v_price := coalesce(v_it.page365_price_jpy, v_prod.price_jpy);
    v_stock := greatest(0, coalesce(v_it.page365_available, 0));
    v_metals := public.page365_metals_from_text(v_name || ' ' || coalesce(v_it.page365_name, '') || ' '
                                                || coalesce(v_prod.list_description, ''));
    v_desc  := public.page365_clean_description(v_prod.list_description);
    v_cond  := CASE WHEN v_name ~* '\[\s*pre-?loved\s*\]' OR coalesce(v_prod.list_category, '') ~* 'pre-?loved'
                    THEN 'Preloved' ELSE 'New' END;
    v_cat   := public.page365_category_for(v_prod.list_category);

    -- A listing whose name starts with a word, not a code ("Necklace K18 …"):
    -- the first-word rule would make "NECKLACE" the sku. Never.
    IF regexp_replace(lower(v_it.code), 's$', '') IN ('ring','necklace','pendant','bracelet','earring','bangle','anklet',
                                                      'brooch','charm','chain','pearl','set','new','preloved')
       OR upper(v_it.code) = ANY (ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925']) THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_is_a_word');
      CONTINUE;
    END IF;
    IF v_price IS NULL OR v_price <= 0 THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'no_price');
      CONTINUE;
    END IF;
    IF cardinality(v_metals) = 0 THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'no_metal');
      CONTINUE;
    END IF;

    v_slug := left(btrim(regexp_replace(lower(v_it.code || '-' || regexp_replace(v_name, '^\S+\s*', '')),
                                        '[^a-z0-9]+', '-', 'g'), '-'), 90);
    IF v_slug = '' THEN v_slug := lower(v_it.code); END IF;
    IF EXISTS (SELECT 1 FROM public.website_products WHERE slug = v_slug) THEN
      v_slug := v_slug || '-' || v_it.page365_variant_id;
    END IF;

    BEGIN
      INSERT INTO public.website_products (sku, slug, name, status, origin, condition, metals, description_en,
                                           page365_product_id, page365_variant_id, page365_category)
      VALUES (v_it.code, v_slug, v_name, 'draft', 'UNKNOWN', v_cond, v_metals, v_desc,
              v_it.page365_product_id, v_it.page365_variant_id, v_prod.list_category)
      RETURNING id INTO v_pid;

      INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
      VALUES (v_pid, v_price, v_stock, 0)
      RETURNING id INTO v_vid;

      IF v_cat IS NOT NULL THEN
        INSERT INTO public.website_category_products (category_id, product_id, sort_order) VALUES (v_cat, v_pid, 0);
      END IF;

      -- The item is now matched to the new variant: the PR 1 copier copies its
      -- photos, and the next fetch sees it as an ordinary matched piece.
      UPDATE public.page365_inventory_items
         SET match_result = 'matched', website_product_id = v_pid, variant_id = v_vid, hub_sku = v_it.code,
             hub_price_jpy = v_price, seen_stock = v_stock, web_holds = 0, invoice_holds = 0, proposed_stock = v_stock,
             photos_total = jsonb_array_length(v_prod.photos), photos_to_copy = jsonb_array_length(v_prod.photos),
             photos_removed = 0, price_differs = false,
             status = 'applied', applied_at = now(), applied_by = v_uid, result_note = 'draft_created'
       WHERE id = v_id;

      v_needs := ARRAY['origin']
              || CASE WHEN v_cat IS NULL THEN ARRAY['category'] ELSE ARRAY[]::text[] END;
      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES ('website_product', v_pid, 'page365_draft_created',
              jsonb_build_object('run_id', p_run_id, 'item_id', v_id, 'sku', v_it.code, 'name', v_name,
                                 'price_jpy', v_price, 'stock_qty', v_stock, 'metals', to_jsonb(v_metals),
                                 'condition', v_cond, 'category_id', v_cat, 'page365_category', v_prod.list_category,
                                 'description_copied', v_desc IS NOT NULL, 'photos', jsonb_array_length(v_prod.photos),
                                 'page365_product_id', v_it.page365_product_id, 'page365_variant_id', v_it.page365_variant_id,
                                 'needs', to_jsonb(v_needs)),
              v_uid);
      v_created := v_created || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'product_id', v_pid,
                                                   'variant_id', v_vid, 'name', v_name, 'needs', to_jsonb(v_needs),
                                                   'photos', jsonb_array_length(v_prod.photos));
    EXCEPTION
      WHEN unique_violation THEN
        -- A concurrent press made the same sku between the check and the insert.
        v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_exists');
      WHEN OTHERS THEN
        v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', left(SQLERRM, 300));
    END;
  END LOOP;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_create_drafts',
          jsonb_build_object('created', jsonb_array_length(v_created), 'skipped', jsonb_array_length(v_skipped),
                             'failed', jsonb_array_length(v_failed), 'sent', cardinality(p_item_ids)),
          v_uid);

  RETURN jsonb_build_object('ok', true,
    'created', jsonb_array_length(v_created), 'skipped', jsonb_array_length(v_skipped),
    'failed', jsonb_array_length(v_failed),
    'created_items', v_created, 'skipped_items', v_skipped, 'failed_items', v_failed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_create_drafts(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_inventory_create_drafts(uuid, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. What a product still needs before it may be published. One definition,
--    used by the bulk publish and by the guard trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.website_product_publish_missing(p_product_id uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT array_remove(ARRAY[
    CASE WHEN wp.origin IS NULL OR wp.origin = 'UNKNOWN' THEN 'origin' END,
    CASE WHEN wp.origin = 'BRAND' AND coalesce(btrim(wp.brand), '') = '' THEN 'brand' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.website_category_products c WHERE c.product_id = wp.id) THEN 'category' END,
    CASE WHEN cardinality(wp.metals) = 0 THEN 'metal' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = wp.id)
              OR EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = wp.id AND coalesce(v.price_jpy, 0) <= 0)
         THEN 'price' END
  ], NULL)
  FROM public.website_products wp WHERE wp.id = p_product_id
$fn$;
REVOKE ALL ON FUNCTION public.website_product_publish_missing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.website_product_publish_missing(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Bulk publish (Catalog → select → Publish). A signed-in user with
--    manage_website_catalog. Each complete draft goes 'active'; each
--    incomplete one is left a draft and listed with what it is missing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.website_publish_products(p_product_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_id        uuid;
  v_p         public.website_products%ROWTYPE;
  v_missing   text[];
  v_published jsonb := '[]'::jsonb;
  v_blocked   jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF cardinality(coalesce(p_product_ids, '{}')) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_selected');
  END IF;
  IF cardinality(p_product_ids) > 1000 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many');
  END IF;

  FOR v_id IN SELECT DISTINCT x FROM unnest(p_product_ids) x ORDER BY 1 LOOP
    SELECT * INTO v_p FROM public.website_products WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_found');
      CONTINUE;
    END IF;
    IF v_p.status::text <> 'draft' THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'sku', v_p.sku, 'reason', 'not_a_draft', 'status', v_p.status::text);
      CONTINUE;
    END IF;
    v_missing := public.website_product_publish_missing(v_id);
    IF cardinality(v_missing) > 0 THEN
      v_blocked := v_blocked || jsonb_build_object('id', v_id, 'sku', v_p.sku, 'name', v_p.name, 'missing', to_jsonb(v_missing));
      CONTINUE;
    END IF;
    UPDATE public.website_products SET status = 'active' WHERE id = v_id;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
    VALUES ('website_product', v_id, 'website_product_published',
            jsonb_build_object('status', 'draft'),
            jsonb_build_object('status', 'active', 'sku', v_p.sku, 'origin', v_p.origin,
                               'page365_product_id', v_p.page365_product_id),
            v_uid);
    v_published := v_published || jsonb_build_object('id', v_id, 'sku', v_p.sku);
  END LOOP;

  RETURN jsonb_build_object('ok', true,
    'published', jsonb_array_length(v_published), 'blocked', jsonb_array_length(v_blocked),
    'skipped', jsonb_array_length(v_skipped),
    'published_items', v_published, 'blocked_items', v_blocked, 'skipped_items', v_skipped);
END
$fn$;
REVOKE ALL ON FUNCTION public.website_publish_products(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.website_publish_products(uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. A Page365 draft never goes live around the bulk publish (the product
--    dialog, a spreadsheet row, a hand UPDATE): origin and a category first.
--    Hub-made products are unaffected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_draft_publish_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_missing text[];
BEGIN
  IF NEW.page365_product_id IS NULL OR NEW.status::text <> 'active' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status::text = 'active' THEN RETURN NEW; END IF;
  -- origin / brand / metals from the row being written; category and price
  -- from their own tables (an INSERT has neither yet, so it is refused).
  v_missing := array_remove(ARRAY[
    CASE WHEN NEW.origin IS NULL OR NEW.origin = 'UNKNOWN' THEN 'origin' END,
    CASE WHEN NEW.origin = 'BRAND' AND coalesce(btrim(NEW.brand), '') = '' THEN 'brand' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.website_category_products c WHERE c.product_id = NEW.id) THEN 'category' END,
    CASE WHEN cardinality(NEW.metals) = 0 THEN 'metal' END,
    CASE WHEN NOT EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = NEW.id)
              OR EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = NEW.id AND coalesce(v.price_jpy, 0) <= 0)
         THEN 'price' END
  ], NULL);
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Cannot publish %: set % first.', NEW.sku, array_to_string(v_missing, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_draft_publish_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_page365_draft_publish_guard ON public.website_products;
CREATE TRIGGER trg_page365_draft_publish_guard
  BEFORE INSERT OR UPDATE OF status ON public.website_products
  FOR EACH ROW EXECUTE FUNCTION public.page365_draft_publish_guard();

-- ---------------------------------------------------------------------------
-- 8. Self-check, still inside the transaction. Pure reads (plus helper calls
--    on literals); any failure aborts the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.page365_category_for(text)', 'public.page365_metals_from_text(text)',
                              'public.page365_clean_description(text)', 'public.page365_draft_publish_guard()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_inventory_drafts self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.page365_inventory_create_drafts(uuid,uuid[])', 'public.website_publish_products(uuid[])'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_inventory_drafts self-check: % grants are wrong', v_fn;
    END IF;
  END LOOP;
  IF public.page365_metals_from_text('R1155 Ring PT900 11.60g Diamond 1.55ct') IS DISTINCT FROM ARRAY['PT900']
     OR public.page365_metals_from_text('Diamond 0.750ct K18/PT900') IS DISTINCT FROM ARRAY['K18','PT900']
     OR cardinality(public.page365_metals_from_text('Pearl 45cm')) <> 0 THEN
    RAISE EXCEPTION 'page365_inventory_drafts self-check: page365_metals_from_text';
  END IF;
  IF public.page365_clean_description(E'K18 \nSSP White Pearl \n45cm') IS DISTINCT FROM E'K18\nSSP White Pearl\n45cm'
     OR public.page365_clean_description('DM us @chajewels') IS NOT NULL
     OR public.page365_clean_description('see https://x.example') IS NOT NULL
     OR public.page365_clean_description('Japan gold chain') IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_drafts self-check: page365_clean_description';
  END IF;
  IF public.page365_category_for('SUPPLIER LISTINGS - JEWELRY') IS NOT NULL
     OR public.page365_category_for('- BRANDED PRELOVED') IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_drafts self-check: page365_category_for maps a non-type category';
  END IF;
  IF to_regclass('public.uq_website_products_page365_source') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_drafts self-check: source uniqueness index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_page365_draft_publish_guard'
                    AND tgrelid = 'public.website_products'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'page365_inventory_drafts self-check: publish guard trigger missing';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Objects exist; expect: t | t | t | t | t | t
-- SELECT to_regprocedure('public.page365_inventory_create_drafts(uuid,uuid[])') IS NOT NULL AS create_drafts,
--        to_regprocedure('public.website_publish_products(uuid[])') IS NOT NULL           AS publish,
--        to_regprocedure('public.website_product_publish_missing(uuid)') IS NOT NULL      AS missing,
--        to_regclass('public.uq_website_products_page365_source') IS NOT NULL            AS source_uniq,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_page365_draft_publish_guard') AS guard,
--        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'page365_inventory_products'
--                   AND column_name = 'list_category')                                AS list_category;
--
-- (2) Nothing created yet; expect: 0
-- SELECT count(*) FROM public.website_products WHERE page365_product_id IS NOT NULL;
--
-- (3) Browser roles; expect: t | f | t | f | f
-- SELECT has_function_privilege('authenticated','public.page365_inventory_create_drafts(uuid,uuid[])','EXECUTE') AS auth_create,
--        has_function_privilege('anon','public.page365_inventory_create_drafts(uuid,uuid[])','EXECUTE')          AS anon_create,
--        has_function_privilege('authenticated','public.website_publish_products(uuid[])','EXECUTE')             AS auth_publish,
--        has_function_privilege('anon','public.website_publish_products(uuid[])','EXECUTE')                      AS anon_publish,
--        has_function_privilege('authenticated','public.page365_category_for(text)','EXECUTE')                   AS auth_helper;
--
-- (4) The category mapping as it stands today (informational): which Page365
--     categories the latest run carries and the Hub category each maps to
--     (NULL = drafts from it will say "needs category").
-- SELECT p.list_category, count(*) AS products, c.name AS hub_category
--   FROM public.page365_inventory_products p
--   LEFT JOIN public.website_categories c ON c.id = public.page365_category_for(p.list_category)
--  WHERE p.run_id = (SELECT id FROM public.page365_inventory_runs ORDER BY created_at DESC LIMIT 1)
--  GROUP BY 1, 3 ORDER BY 2 DESC;
--     (Empty until a fetch runs on the redeployed page365-inventory-fetch.)
--
-- (5) Existing products are untouched: every product live before this file is
--     Hub-made; expect: 0
-- SELECT count(*) FROM public.website_products WHERE page365_product_id IS NOT NULL AND created_at < now() - interval '1 minute';
-- ===========================================================================
