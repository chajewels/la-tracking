-- ===========================================================================
-- page365_auto_land — new Page365 products land in the Catalog by themselves
-- (owner decisions 2026-09-26; replaces "Create drafts").
--
-- Owner evidence: ticking wallets (W3356, W1451, …) and pressing Create drafts
-- gave "0 draft(s) created" and left result_note NULL. Root cause (PR 4 / PR 3c
-- page365_inventory_create_drafts): item kind knew only "watch", so wallets,
-- bags and belts were drafted as JEWELRY and refused 'no_metal'; the stamp
-- reader matched only bare words, so K18WG / 750WG / 750PG / 18KWG / K18g /
-- SV925 were never read; a refused row never stored why. On the live
-- catalogue (642 listings, 2026-09-26) 164 listings failed that way.
--
-- WHAT THIS FILE DOES (owner decisions 1-6):
--   1. ITEM TYPES: exactly jewelry | watch | accessory (JA 小物). 'other'
--      becomes 'accessory' (existing rows converted). New
--      page365_item_kind_for(name, category), whole words Page365 prints:
--      watch(es) -> watch; wallet, bag, handbag, clutch, tote, purse, pouch,
--      backpack, cardholder, card holder/case, coin/key/pass case, key chain,
--      key holder/ring, belt, scarf/scarves, sunglasses -> accessory; else
--      jewelry. Watch wins.
--   2. METAL: page365_metals_from_text reads a stamp + gold colour code as the
--      stamp (K18WG -> K18, 750PG -> 750, 18KWG -> 18K, K18g -> K18); SV925 ->
--      SILVER925 ("Silver 925"); a bare SV -> SILVER ("Silver", JA シルバー, a
--      NEW metal value: website_products_metals_values and the karat enum gain
--      it). "0.750ct" is still not a stamp.
--   3. NO "CREATE DRAFTS" STEP. page365_inventory_finish, for a READY
--      (complete) read, calls the new page365_inventory_land_run: every NEW
--      code with Page365 available > 0 that is not "Don't sync with Page365"
--      (read live) becomes an UNPUBLISHED product (status draft) with name,
--      yen price, stock, item kind, metal, category (when clear), condition,
--      description; page365_landings records it and its photos are copied by
--      the scheduled page365-inventory-fetch. Sold-out new codes do not land.
--      NEVER publishes. page365_inventory_create_drafts and
--      page365_inventory_refresh_product are DROPPED (the flow is gone).
--      DETECTION: a quick read now also opens a listing it has NEVER read
--      before (page365_inventory_plan_quick (d)), so a new in-stock code lands
--      within one scheduled interval; a known listing that comes back in stock
--      lands at the nightly full read (or a staff "Full fetch").
--   4. INCOMPLETE PRODUCTS STILL LAND. The jewelry-metal rule moves from
--      creation to PUBLISH: CHECK website_products_metals_jewelry now applies
--      to status 'active' only, so a jewelry draft with no readable stamp lands
--      and shows "needs metal stamp"; website_publish_products,
--      trg_page365_draft_publish_guard and the CHECK all still refuse to
--      publish it (unchanged: website_product_publish_missing).
--   6. Every row not landed keeps its reason in result_note.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- and BEFORE page365-inventory-fetch / page365-inventory-photos are
-- redeployed. One transaction. It creates NO product, publishes nothing and
-- changes no stock (the self-check proves it; landing starts with the next
-- complete read). Re-running it is a no-op.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_inventory_finish          6bf16430aedfd4068b45024b8d860e95 -> e44762490fc64019a4cadfd9496fcbc6   (PR 3c body; land a ready run)
--              page365_inventory_plan_quick      9d59a540b184f1e3d95ae57027f63a88 -> fb80f4f913334ce6da422840bf1de86e   (PR 3c body; (d) never-read listings)
--              page365_metals_from_text          3164641c287f98c715ef0785281f2b62 -> 59e64019d2958da8fedefb9f19db1763
--   new        page365_item_kind_for                                              -> a6b681d6010cbf56115c6ebb0229fb63
--              page365_inventory_land_run                                         -> 7f27675ecd45453b1577fa5f6e6ba738
--   dropped    page365_inventory_create_drafts   9ae1eb47496736b925db9625b1e2d373
--              page365_inventory_refresh_product d2405310274ddd3fc18c9deaffcce03d
--   relied on, proved unchanged after:
--              website_product_publish_missing   e485724ed9c85a248bfe5508d9f43941
--              page365_draft_publish_guard       e7f6748cf401ff6d9c87e0a785dbeb8a
--              website_publish_products          72db495e4e9123f159b5b72ed629c0cd
--              page365_inventory_record_photo    c8f94536cf40167fe43a24967a6eefe9
--              page365_inventory_auto_apply_run  d9d251fb68aac0acf9a5360b22fddc07
--              page365_inventory_follow          6e26568441fc308c42426de238fb165f
--              sync_website_product_metals       9e648e37e6c4079e0ee9cd3e9a68a829
--   The "before" bodies are the repo text of 20261002100000 / 20260929100000 /
--   20260928100000 / 20261003100000, which the owner applied as-is
--   (verification (2) of 20261002100000 and 20261003100000).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_bad text := '';
  v_got text;
  r     record;
BEGIN
  IF to_regclass('public.page365_inventory_items') IS NULL OR to_regclass('public.page365_inventory_products') IS NULL
     OR to_regclass('public.website_products') IS NULL OR to_regclass('public.website_product_variants') IS NULL
     OR to_regclass('public.website_category_products') IS NULL OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'page365_auto_land: Page365 inventory / website tables missing (PR 1 - PR 3d first)';
  END IF;
  IF to_regtype('public.website_product_karat') IS NULL THEN
    RAISE EXCEPTION 'page365_auto_land: enum public.website_product_karat missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_products_metals_jewelry')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_products_item_kind_check')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_products_metals_values') THEN
    RAISE EXCEPTION 'page365_auto_land: a website_products CHECK is missing (metals_jewelry / item_kind_check / metals_values)';
  END IF;
  IF to_regclass('public.page365_landings') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                      AND table_name = 'page365_landings' AND column_name = 'photos_done_at') THEN
    RAISE EXCEPTION 'page365_auto_land: a different public.page365_landings already exists';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- fn, live before, after this file (NULL = must be exactly "before")
      ('page365_inventory_finish(uuid)',                  '6bf16430aedfd4068b45024b8d860e95', 'e44762490fc64019a4cadfd9496fcbc6'),
      ('page365_inventory_plan_quick(uuid)',              '9d59a540b184f1e3d95ae57027f63a88', 'fb80f4f913334ce6da422840bf1de86e'),
      ('page365_metals_from_text(text)',                  '3164641c287f98c715ef0785281f2b62', '59e64019d2958da8fedefb9f19db1763'),
      ('website_product_publish_missing(uuid)',           'e485724ed9c85a248bfe5508d9f43941', NULL),
      ('page365_draft_publish_guard()',                   'e7f6748cf401ff6d9c87e0a785dbeb8a', NULL),
      ('website_publish_products(uuid[])',                '72db495e4e9123f159b5b72ed629c0cd', NULL),
      ('page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)', 'c8f94536cf40167fe43a24967a6eefe9', NULL),
      ('page365_inventory_auto_apply_run(uuid)',          'd9d251fb68aac0acf9a5360b22fddc07', NULL),
      ('page365_inventory_follow(uuid)',                  '6e26568441fc308c42426de238fb165f', NULL),
      ('sync_website_product_metals()',                   '9e648e37e6c4079e0ee9cd3e9a68a829', NULL)
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  -- Dropped here: live must still be the known body, or already gone (a re-run).
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_create_drafts(uuid,uuid[])',     '9ae1eb47496736b925db9625b1e2d373'),
      ('page365_inventory_refresh_product(uuid,jsonb,text)', 'd2405310274ddd3fc18c9deaffcce03d')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS NOT NULL AND v_got <> r.want THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s (or dropped)', r.fn, v_got, r.want);
    END IF;
  END LOOP;
  -- New here: absent, or already this file's body (a re-run).
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_item_kind_for(text,text)', 'a6b681d6010cbf56115c6ebb0229fb63'),
      ('page365_inventory_land_run(uuid)', '7f27675ecd45453b1577fa5f6e6ba738')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS NOT NULL AND v_got <> r.want THEN
      v_bad := v_bad || format(E'\n  %s: a different body already exists (md5 %s)', r.fn, v_got);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_auto_land: live is not what this was written against — nothing changed:%', v_bad;
  END IF;

  -- For the self-check: no product created, no status or stock moved.
  PERFORM set_config('page365.land_catalog_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v),
    true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Metal value SILVER ("Silver", JA シルバー) — for a piece Page365 marks
--    only "SV". The karat bridge mirrors metals[1] into the enum, so the enum
--    gains it too (usable once this transaction commits; nothing here writes it).
-- ---------------------------------------------------------------------------
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'SILVER';
ALTER TABLE public.website_products DROP CONSTRAINT website_products_metals_values;
ALTER TABLE public.website_products ADD CONSTRAINT website_products_metals_values CHECK (
  metals <@ ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925','SILVER']::text[]);

-- ---------------------------------------------------------------------------
-- 2. Item types: jewelry | watch | accessory. 'other' rows become 'accessory'.
--    The metal stamp is required for JEWELRY only, and only to be PUBLISHED
--    (status active): a jewelry draft may land without one.
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_products DROP CONSTRAINT website_products_item_kind_check;
UPDATE public.website_products SET item_kind = 'accessory' WHERE item_kind = 'other';
ALTER TABLE public.website_products ADD CONSTRAINT website_products_item_kind_check
  CHECK (item_kind IN ('jewelry', 'watch', 'accessory'));
ALTER TABLE public.website_products DROP CONSTRAINT website_products_metals_jewelry;
ALTER TABLE public.website_products ADD CONSTRAINT website_products_metals_jewelry
  CHECK (status <> 'active' OR item_kind <> 'jewelry' OR cardinality(metals) >= 1);
COMMENT ON COLUMN public.website_products.item_kind IS
  'What the piece is (2026-09-26): jewelry (default) | watch | accessory (JA 小物: wallets, bags, cases, belts …). A metal stamp is required ONLY for jewelry, and only to publish (CHECK website_products_metals_jewelry applies to status active; website_product_publish_missing names it for drafts).';

-- ---------------------------------------------------------------------------
-- 3. Helpers: item kind and metal stamps, from what Page365 prints.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_item_kind_for(p_name text, p_category text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE
    WHEN (coalesce(p_name, '') || ' ' || coalesce(p_category, '')) ~* '\mwatch(es)?\M' THEN 'watch'
    WHEN (coalesce(p_name, '') || ' ' || coalesce(p_category, ''))
         ~* '\m(wallets?|bags?|handbags?|clutch(es)?|totes?|purses?|pouch(es)?|backpacks?|cardholders?|card\s+(holder|case)s?|(coin|key|pass)\s+cases?|key\s*chains?|key\s+(holder|ring)s?|belts?|scarf|scarves|sunglasses)\M'
      THEN 'accessory'
    ELSE 'jewelry'
  END
$fn$;
REVOKE ALL ON FUNCTION public.page365_item_kind_for(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_item_kind_for(text, text) TO service_role;
COMMENT ON FUNCTION public.page365_item_kind_for(text, text) IS
  '2026-09-26: website_products.item_kind from the Page365 name and category, whole words only — watch(es) -> watch; wallet, bag, clutch, tote, purse, pouch, card/coin/key/pass case, key holder, belt, scarf, sunglasses … -> accessory; else jewelry. Watch wins. Staff can change it in the product dialog.';

CREATE OR REPLACE FUNCTION public.page365_metals_from_text(p_text text)
RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce(array_agg(s.stamp ORDER BY s.first_at), ARRAY[]::text[])
    FROM (
      SELECT t.stamp, min(t.ord) AS first_at
        FROM (
          SELECT CASE WHEN upper(x.tok) = 'SV925' THEN 'SILVER925'
                      WHEN upper(x.tok) = 'SV'    THEN 'SILVER'
                      ELSE (regexp_match(upper(x.tok),
                             '^(K24|K18|750|18K|K14|K10|PT1000|PT950|PT900|PT850|PM900|PM|SILVER925)(WG|YG|PG|RG|CG|G)?$'))[1]
                 END AS stamp, x.ord
            FROM regexp_split_to_table(coalesce(p_text, ''), '[\s　/,()\[\]]+') WITH ORDINALITY AS x(tok, ord)
        ) t
       WHERE t.stamp IS NOT NULL
       GROUP BY t.stamp
    ) s
$fn$;
REVOKE ALL ON FUNCTION public.page365_metals_from_text(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_metals_from_text(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. page365_landings — one row per product that landed by itself. Drives the
--    "Landed in Catalog" list and the photo backlog (photos_done_at NULL =
--    page365-inventory-fetch still has photos to copy).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_landings (
  product_id     uuid PRIMARY KEY REFERENCES public.website_products(id) ON DELETE CASCADE,
  variant_id     uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL,
  item_id        uuid REFERENCES public.page365_inventory_items(id) ON DELETE SET NULL,
  run_id         uuid,
  code           text NOT NULL,
  name           text,
  item_kind      text,
  landed_at      timestamptz NOT NULL DEFAULT now(),
  photos_total   integer NOT NULL DEFAULT 0,
  photos_done_at timestamptz,
  photo_attempts integer NOT NULL DEFAULT 0,
  photo_failures integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_page365_landings_landed ON public.page365_landings (landed_at DESC);
CREATE INDEX IF NOT EXISTS idx_page365_landings_photos ON public.page365_landings (landed_at) WHERE photos_done_at IS NULL;
ALTER TABLE public.page365_landings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Catalog staff read landings" ON public.page365_landings;
CREATE POLICY "Catalog staff read landings" ON public.page365_landings
  FOR SELECT TO authenticated USING (public.has_permission(auth.uid(), 'manage_website_catalog'));
REVOKE ALL ON public.page365_landings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.page365_landings TO authenticated;
GRANT ALL ON public.page365_landings TO service_role;
COMMENT ON TABLE public.page365_landings IS
  '2026-09-26. A Page365 product that landed in the Catalog by itself (page365_inventory_land_run), always unpublished. photos_done_at NULL = the scheduled page365-inventory-fetch is still copying its Page365 photos (<= 4 downloads/s, only when no read is running); photo_attempts / photo_failures count its tries (given up after 3).';

-- A quick read asks "has this listing ever been read?" (plan_quick (d)).
CREATE INDEX IF NOT EXISTS idx_page365_inventory_products_read
  ON public.page365_inventory_products (page365_product_id) WHERE status = 'fetched';

-- ---------------------------------------------------------------------------
-- 5. page365_inventory_land_run — lands a ready run's new, in-stock codes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_land_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_it       public.page365_inventory_items%ROWTYPE;
  v_prod     public.page365_inventory_products%ROWTYPE;
  v_multi    boolean;
  v_n        integer;
  v_name     text;
  v_price    integer;
  v_stock    integer;
  v_metals   text[];
  v_desc     text;
  v_cond     text;
  v_cat      uuid;
  v_slug     text;
  v_kind     text;
  v_pid      uuid;
  v_vid      uuid;
  v_existing uuid;
  v_note     text;
  v_landed   integer := 0;
  v_notes    jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  -- Only a COMPLETE read lands anything (a partial or failed one never does).
  IF v_run.status <> 'ready' THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready'); END IF;

  FOR v_it IN
    SELECT * FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.category = 'new'
       AND i.match_result = 'unmatched' AND i.status = 'review'
     ORDER BY i.code NULLS LAST, i.id
     FOR UPDATE
  LOOP
    v_note := NULL;
    -- "Don't sync with Page365" (PR 2), read live: never landed.
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE wp.page365_sync_disabled
       AND (public.page365_first_word(wp.sku) = v_it.code
         OR (wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id))
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_note := 'sync_disabled';
    ELSIF v_it.code IS NULL THEN
      v_note := 'no_code';
    ELSIF coalesce(v_it.page365_available, 0) <= 0 THEN
      -- Sold out on Page365: never lands; a later read lands it when back in stock.
      v_note := 'sold_out';
    ELSIF EXISTS (SELECT 1 FROM public.website_products wp WHERE public.page365_first_word(wp.sku) = v_it.code) THEN
      v_note := 'code_exists';
    ELSIF EXISTS (SELECT 1 FROM public.website_products wp
                   WHERE wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id) THEN
      v_note := 'already_landed';
    ELSIF regexp_replace(regexp_replace(lower(v_it.code), 'es$', ''), 's$', '')
            IN ('ring','necklace','pendant','bracelet','earring','bangle','anklet',
                'brooch','charm','chain','pearl','set','new','preloved','watch','wallet','bag','belt')
          OR upper(v_it.code) = ANY (ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900',
                                           'SILVER925','SV','SV925']) THEN
      -- The Page365 name starts with a word, not a code: there is no code to
      -- sync stock on. Fix the name on Page365; the next read lands it.
      v_note := 'code_is_a_word';
    END IF;
    IF v_note IS NOT NULL THEN
      UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;
      v_notes := jsonb_set(v_notes, ARRAY[v_note], to_jsonb(coalesce((v_notes->>v_note)::integer, 0) + 1));
      CONTINUE;
    END IF;

    SELECT * INTO v_prod FROM public.page365_inventory_products WHERE id = v_it.inventory_product_id;
    SELECT count(*) INTO v_n FROM public.page365_inventory_items j WHERE j.inventory_product_id = v_it.inventory_product_id;
    v_multi := v_n > 1;
    -- A listing carrying several codes: each product is named by its variant.
    v_name  := btrim(CASE WHEN v_multi AND btrim(coalesce(v_it.variant_name, '')) ~ '\S\s+\S' THEN v_it.variant_name
                          ELSE coalesce(v_it.page365_name, v_prod.name, v_prod.list_name) END);
    -- No price on Page365: lands at 0 and is "incomplete — needs price".
    v_price := greatest(0, coalesce(v_it.page365_price_jpy, v_prod.price_jpy, 0));
    v_stock := greatest(0, v_it.page365_available);
    v_metals := public.page365_metals_from_text(v_name || ' ' || coalesce(v_it.page365_name, '') || ' '
                                                || coalesce(v_prod.list_description, ''));
    v_desc  := public.page365_clean_description(v_prod.list_description);
    v_cond  := CASE WHEN v_name ~* '\[\s*pre-?loved\s*\]' OR coalesce(v_prod.list_category, '') ~* 'pre-?loved'
                    THEN 'Preloved' ELSE 'New' END;
    v_cat   := public.page365_category_for(v_prod.list_category);
    v_kind  := public.page365_item_kind_for(v_name || ' ' || coalesce(v_it.page365_name, ''), v_prod.list_category);

    v_slug := left(btrim(regexp_replace(lower(v_it.code || '-' || regexp_replace(v_name, '^\S+\s*', '')),
                                        '[^a-z0-9]+', '-', 'g'), '-'), 90);
    IF v_slug = '' THEN v_slug := lower(v_it.code); END IF;
    IF EXISTS (SELECT 1 FROM public.website_products WHERE slug = v_slug) THEN
      v_slug := v_slug || '-' || v_it.page365_variant_id;
    END IF;

    BEGIN
      -- ALWAYS a draft: nothing lands on the website until a person publishes it.
      INSERT INTO public.website_products (sku, slug, name, status, origin, condition, metals, item_kind, description_en,
                                           page365_product_id, page365_variant_id, page365_category)
      VALUES (v_it.code, v_slug, v_name, 'draft', 'UNKNOWN', v_cond, v_metals, v_kind, v_desc,
              v_it.page365_product_id, v_it.page365_variant_id, v_prod.list_category)
      RETURNING id INTO v_pid;

      INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
      VALUES (v_pid, v_price, v_stock, 0)
      RETURNING id INTO v_vid;

      IF v_cat IS NOT NULL THEN
        INSERT INTO public.website_category_products (category_id, product_id, sort_order) VALUES (v_cat, v_pid, 0);
      END IF;

      -- Matched to the new variant: its photos are copied by the scheduled
      -- page365-inventory-fetch (page365_landings), and the next read sees it
      -- as an ordinary matched piece whose stock follows Page365.
      UPDATE public.page365_inventory_items
         SET match_result = 'matched', website_product_id = v_pid, variant_id = v_vid, hub_sku = v_it.code,
             hub_price_jpy = v_price, seen_stock = v_stock, web_holds = 0, invoice_holds = 0, proposed_stock = v_stock,
             photos_total = jsonb_array_length(v_prod.photos), photos_to_copy = jsonb_array_length(v_prod.photos),
             photos_removed = 0, price_differs = false,
             status = 'applied', applied_at = now(), applied_by = NULL, result_note = 'landed'
       WHERE id = v_it.id;

      INSERT INTO public.page365_landings (product_id, variant_id, item_id, run_id, code, name, item_kind, photos_total,
                                           photos_done_at)
      VALUES (v_pid, v_vid, v_it.id, p_run_id, v_it.code, v_name, v_kind, jsonb_array_length(v_prod.photos),
              CASE WHEN jsonb_array_length(v_prod.photos) = 0 THEN now() END);

      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES ('website_product', v_pid, 'page365_product_landed',
              jsonb_build_object('run_id', p_run_id, 'run_kind', v_run.kind, 'item_id', v_it.id, 'sku', v_it.code,
                                 'name', v_name, 'price_jpy', v_price, 'stock_qty', v_stock, 'metals', to_jsonb(v_metals),
                                 'item_kind', v_kind, 'condition', v_cond, 'category_id', v_cat,
                                 'page365_category', v_prod.list_category, 'description_copied', v_desc IS NOT NULL,
                                 'photos', jsonb_array_length(v_prod.photos),
                                 'page365_product_id', v_it.page365_product_id, 'page365_variant_id', v_it.page365_variant_id,
                                 'missing', to_jsonb(public.website_product_publish_missing(v_pid))),
              NULL);
      v_landed := v_landed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- One bad row never undoes the others; the reason stays on the row.
      UPDATE public.page365_inventory_items SET result_note = left(SQLERRM, 300) WHERE id = v_it.id;
      v_notes := jsonb_set(v_notes, ARRAY['error'], to_jsonb(coalesce((v_notes->>'error')::integer, 0) + 1));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'landed', v_landed, 'not_landed', v_notes);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_land_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_land_run(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_land_run(uuid) IS
  '2026-09-26 (replaces Create drafts). Called by page365_inventory_finish for a READY run: every NEW code with Page365 available > 0 (not "Don''t sync with Page365", read live) becomes an UNPUBLISHED website product (status draft) with name, yen price, stock, item kind, metal stamps, category (when clear), condition and description from Page365; its photos follow via page365_landings. Never publishes, never touches an existing product. Every row not landed keeps its reason in result_note (sold_out, code_exists, sync_disabled, code_is_a_word, no_code, already_landed, or the error).';

-- ---------------------------------------------------------------------------
-- 6. page365_inventory_finish — PR 3c body; edit (g): land a ready run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_finish(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_prev     public.page365_inventory_runs%ROWTYPE;
  v_prev_count integer;
  v_open     integer;
  v_errors   integer;
  v_it       record;
  v_m        record;
  v_status   text;
  v_reason   text;
  -- PR 2
  v_mode     text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                 WHERE s.key = 'page365_stock_mode') = 'invoice'
                          THEN 'invoice' ELSE 'inventory_sync' END;
  v_hold_unpaid boolean := coalesce((SELECT s.value #>> '{}' FROM public.system_settings s
                                      WHERE s.key = 'page365_hold_unpaid_invoices'), 'true') <> 'false';
  v_off      boolean;
  -- 2026-09-26: new, in-stock codes land in the Catalog (unpublished).
  v_landed   jsonb;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'fetching' THEN
    RETURN jsonb_build_object('ok', true, 'status', v_run.status, 'already', true);
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('pending','claimed') OR (status = 'error' AND attempts < 2)),
         count(*) FILTER (WHERE status = 'error')
    INTO v_open, v_errors
    FROM public.page365_inventory_products WHERE run_id = p_run_id;
  IF v_open > 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_done', 'open', v_open); END IF;

  -- (a) No code / a code seen twice in this read: flagged, never matched.
  UPDATE public.page365_inventory_items SET match_result = 'no_code', category = 'flagged'
   WHERE run_id = p_run_id AND kind = 'page365' AND code IS NULL;
  UPDATE public.page365_inventory_items i SET match_result = 'duplicate_in_page365', category = 'flagged'
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.code IS NOT NULL
     AND (SELECT count(*) FROM public.page365_inventory_items j
           WHERE j.run_id = p_run_id AND j.kind = 'page365' AND j.code = i.code) > 1;

  -- (b) Match the rest on the code, exactly (#195's matcher, unchanged). A
  --     product switched to "Don't sync with Page365" is not_synced (PR 2).
  FOR v_it IN
    SELECT i.id, i.code, i.page365_available, i.page365_price_jpy, i.inventory_product_id
      FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'pending'
     ORDER BY i.id
  LOOP
    SELECT * INTO v_m FROM public.page365_match_line(v_it.code);
    v_off := coalesce((SELECT wp.page365_sync_disabled FROM public.website_products wp
                        WHERE wp.id = v_m.o_product_id), false);
    IF v_m.o_match_result = 'matched' THEN
      UPDATE public.page365_inventory_items i
         SET match_result = 'matched', website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             hub_sku = (SELECT sku FROM public.website_products WHERE id = v_m.o_product_id),
             hub_price_jpy = (SELECT price_jpy FROM public.website_product_variants WHERE id = v_m.o_variant_id),
             seen_stock = v_m.o_stock_qty,
             web_holds = public.page365_web_holds(v_m.o_variant_id),
             invoice_holds = CASE WHEN v_mode = 'invoice'
                                  THEN (SELECT count(*) FROM public.page365_stock_lines l
                                         WHERE l.variant_id = v_m.o_variant_id AND l.stock_state = 'held')
                                  ELSE public.page365_invoice_holds(v_m.o_variant_id) END,
             category = CASE WHEN v_off THEN 'not_synced' ELSE i.category END
       WHERE i.id = v_it.id;
    ELSE
      UPDATE public.page365_inventory_items i
         SET match_result = v_m.o_match_result, website_product_id = v_m.o_product_id,
             category = CASE WHEN v_off THEN 'not_synced'
                             WHEN v_m.o_match_result = 'unmatched' THEN 'new' ELSE 'flagged' END
       WHERE i.id = v_it.id;
    END IF;
  END LOOP;

  -- (c) The proposal: max(0, Page365 available - website holds [- unpaid
  --     invoice holds, PR 2]), and its direction. not_synced is never proposed.
  UPDATE public.page365_inventory_items i
     SET proposed_stock = greatest(0, i.page365_available - coalesce(i.web_holds, 0)
                                      - CASE WHEN v_mode = 'inventory_sync' AND v_hold_unpaid
                                             THEN coalesce(i.invoice_holds, 0) ELSE 0 END),
         price_differs = i.page365_price_jpy IS DISTINCT FROM i.hub_price_jpy
   WHERE i.run_id = p_run_id AND i.match_result = 'matched' AND i.category <> 'not_synced';
  UPDATE public.page365_inventory_items i
     SET category = CASE
           WHEN v_mode = 'invoice' AND i.invoice_holds > 0 THEN 'excluded'
           WHEN i.proposed_stock < i.seen_stock    THEN 'decrease'
           WHEN i.proposed_stock > i.seen_stock    THEN 'increase'
           ELSE 'no_change' END
   WHERE i.run_id = p_run_id AND i.match_result = 'matched' AND i.category <> 'not_synced';

  -- (d) Photos per matched variant: Page365 total, not yet copied (by id AND
  --     version), and copies whose Page365 photo is gone (flagged, not deleted).
  --     not_synced: never copied, so nothing to count.
  UPDATE public.page365_inventory_items i
     SET photos_total = jsonb_array_length(p.photos),
         photos_to_copy = (SELECT count(*) FROM jsonb_array_elements(p.photos) ph
                            WHERE NOT EXISTS (SELECT 1 FROM public.website_product_media m
                                               WHERE m.variant_id = i.variant_id
                                                 AND m.page365_photo_id = (ph->>'id')::bigint
                                                 AND m.page365_photo_version IS NOT DISTINCT FROM ph->>'version')),
         photos_removed = (SELECT count(*) FROM public.website_product_media m
                            WHERE m.variant_id = i.variant_id AND m.page365_photo_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.photos) ph
                                               WHERE (ph->>'id')::bigint = m.page365_photo_id))
    FROM public.page365_inventory_products p
   WHERE p.id = i.inventory_product_id AND i.run_id = p_run_id AND i.match_result = 'matched'
     AND i.category <> 'not_synced';

  -- (e) Hub-only: only a COMPLETE read can say a code is absent. Archived
  --     products are out of scope; a code with an inner space never matched.
  --     A switched-off product is listed as not_synced, never as missing.
  --     PR 3c: a QUICK read never opens a switched-off product's page, so it
  --     cannot say that product is missing — it is left out altogether.
  IF v_errors = 0 THEN
    SELECT * INTO v_prev FROM public.page365_inventory_runs r
     WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
     ORDER BY r.created_at DESC LIMIT 1;
    INSERT INTO public.page365_inventory_items (run_id, kind, website_product_id, hub_sku, match_result, category, missing_runs)
    SELECT p_run_id, 'hub_only', wp.id, wp.sku, 'hub_only',
           CASE WHEN wp.page365_sync_disabled THEN 'not_synced' ELSE 'hub_only' END,
           1 + coalesce((SELECT pi.missing_runs FROM public.page365_inventory_items pi
                          WHERE pi.run_id = v_prev.id AND pi.kind = 'hub_only' AND pi.website_product_id = wp.id), 0)
      FROM public.website_products wp
     WHERE wp.status <> 'archived'
       AND NOT (v_run.kind = 'quick' AND coalesce(wp.page365_sync_disabled, false))
       AND public.page365_first_word(wp.sku) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                        WHERE i.run_id = p_run_id AND i.kind = 'page365'
                          AND i.code = public.page365_first_word(wp.sku))
    ON CONFLICT DO NOTHING;
  END IF;

  -- (f) Ready only if the read was clean and the catalogue did not shrink by > 20 %.
  SELECT r.page365_count INTO v_prev_count FROM public.page365_inventory_runs r
   WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
   ORDER BY r.created_at DESC LIMIT 1;
  IF v_errors > 0 THEN
    v_status := 'partial'; v_reason := v_errors || ' product(s) could not be read';
  ELSIF v_prev_count IS NOT NULL AND v_run.page365_count < v_prev_count * 0.8 THEN
    v_status := 'partial';
    v_reason := 'catalogue count fell from ' || v_prev_count || ' to ' || v_run.page365_count;
  ELSE
    v_status := 'ready';
  END IF;

  UPDATE public.page365_inventory_runs
     SET status = v_status, error = v_reason, previous_count = v_prev_count,
         finished_at = now(), updated_at = now()
   WHERE id = p_run_id;
  -- (g) 2026-09-26, replaces Create drafts: a COMPLETE read lands every new,
  --     in-stock code as an UNPUBLISHED Catalog product. A landing failure
  --     never fails the read: the run stays ready and the reason is returned.
  IF v_status = 'ready' THEN
    BEGIN
      v_landed := public.page365_inventory_land_run(p_run_id);
    EXCEPTION WHEN OTHERS THEN
      v_landed := jsonb_build_object('ok', false, 'error', left(SQLERRM, 300));
    END;
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason, 'mode', v_mode, 'kind', v_run.kind,
                            'landed', v_landed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. page365_inventory_plan_quick — PR 3c body; edit (d): open never-read listings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_plan_quick(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run    public.page365_inventory_runs%ROWTYPE;
  v_listed integer;
  v_read   integer;
  v_codes  integer;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'fetching' OR v_run.kind <> 'quick' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_quick_fetching_run');
  END IF;

  -- Hub codes: the same set finish's Hub-only list uses (not archived, a
  -- code), less products switched to "Don't sync with Page365".
  SELECT count(DISTINCT public.page365_first_word(wp.sku)) INTO v_codes FROM public.website_products wp
   WHERE wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false)
     AND public.page365_first_word(wp.sku) IS NOT NULL;

  WITH hub AS (
    SELECT DISTINCT public.page365_first_word(wp.sku) AS code FROM public.website_products wp
     WHERE wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false)
       AND public.page365_first_word(wp.sku) IS NOT NULL)
  UPDATE public.page365_inventory_products p
     SET status = 'listed'
   WHERE p.run_id = p_run_id AND p.status = 'pending'
     -- (a) the list name's code is a Hub code;
     AND NOT EXISTS (SELECT 1 FROM hub WHERE hub.code = public.page365_first_word(p.list_name))
     -- (b) the listing held a Hub code in an earlier read (variant codes);
     AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                       JOIN hub ON hub.code = i.code
                      WHERE i.kind = 'page365' AND i.page365_product_id = p.page365_product_id AND i.run_id <> p_run_id)
     -- (c) a Hub product was drafted (landed) from it;
     AND NOT EXISTS (SELECT 1 FROM public.website_products wp
                      WHERE wp.page365_product_id = p.page365_product_id
                        AND wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false))
     -- (d) 2026-09-26: a listing never read before is NEW on Page365 — open it,
     --     so a new in-stock code lands in the Catalog within one interval.
     AND EXISTS (SELECT 1 FROM public.page365_inventory_products o
                  WHERE o.page365_product_id = p.page365_product_id AND o.run_id <> p_run_id AND o.status = 'fetched');
  GET DIAGNOSTICS v_listed = ROW_COUNT;

  SELECT count(*) INTO v_read FROM public.page365_inventory_products
   WHERE run_id = p_run_id AND status <> 'listed';
  UPDATE public.page365_inventory_runs
     SET products_total = v_read, listed_total = v_listed, updated_at = now()
   WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'to_read', v_read, 'listed', v_listed, 'hub_codes', v_codes);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_plan_quick(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_plan_quick(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_plan_quick(uuid) IS
  'PR 3c; 2026-09-26 (d). For a QUICK run that is still fetching: keep for reading only the listings that can hold a Hub product (list-name code is a Hub code; or the listing held a Hub code in an earlier read; or a Hub product was drafted/landed from it) AND every listing never read before (new on Page365, so it can land). Hub code = page365_first_word(sku), status not archived, not switched off. Every other listing -> status listed. Service role.';

-- ---------------------------------------------------------------------------
-- 8. The Create drafts flow is gone: its RPC and its fresh-read helper.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.page365_inventory_create_drafts(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.page365_inventory_refresh_product(uuid, jsonb, text);

-- ---------------------------------------------------------------------------
-- 9. Self-check, still inside the transaction. Pure reads (plus helper calls
--    on literals); any failure aborts the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_got text;
  v_fn  text;
  r     record;
BEGIN
  IF (SELECT count(*)::text FROM public.website_products) || '|'
     || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
     IS DISTINCT FROM current_setting('page365.land_catalog_before', true) THEN
    RAISE EXCEPTION 'page365_auto_land self-check: a product was created, or a status or stock changed, during this file';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',          'e44762490fc64019a4cadfd9496fcbc6'),
      ('page365_inventory_plan_quick(uuid)',      'fb80f4f913334ce6da422840bf1de86e'),
      ('page365_metals_from_text(text)',          '59e64019d2958da8fedefb9f19db1763'),
      ('page365_item_kind_for(text,text)',        'a6b681d6010cbf56115c6ebb0229fb63'),
      ('page365_inventory_land_run(uuid)',        '7f27675ecd45453b1577fa5f6e6ba738'),
      ('website_product_publish_missing(uuid)',   'e485724ed9c85a248bfe5508d9f43941'),
      ('page365_draft_publish_guard()',           'e7f6748cf401ff6d9c87e0a785dbeb8a'),
      ('website_publish_products(uuid[])',        '72db495e4e9123f159b5b72ed629c0cd'),
      ('page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)', 'c8f94536cf40167fe43a24967a6eefe9'),
      ('page365_inventory_auto_apply_run(uuid)',  'd9d251fb68aac0acf9a5360b22fddc07'),
      ('page365_inventory_follow(uuid)',          '6e26568441fc308c42426de238fb165f'),
      ('sync_website_product_metals()',           '9e648e37e6c4079e0ee9cd3e9a68a829')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_auto_land self-check: % body md5 %, expected %', r.fn, v_got, r.want;
    END IF;
  END LOOP;
  IF to_regprocedure('public.page365_inventory_create_drafts(uuid,uuid[])') IS NOT NULL
     OR to_regprocedure('public.page365_inventory_refresh_product(uuid,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'page365_auto_land self-check: the Create drafts functions still exist';
  END IF;

  -- The rules, on the owner's own Page365 text.
  IF public.page365_item_kind_for('W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]', 'SUPPLIER LISTINGS - BRANDS') <> 'accessory'
     OR public.page365_item_kind_for('W2497 Key Case Louis Vuitton Monogram Multicle 4 [Preloved]', NULL) <> 'accessory'
     OR public.page365_item_kind_for('SB022 Bag Burberry Shoulder bag [Preloved]', NULL) <> 'accessory'
     OR public.page365_item_kind_for('B2948 Belt Louis Vuitton Belt - LV Dimension Reversible 85/34', NULL) <> 'accessory'
     OR public.page365_item_kind_for('WT2 Cartier Tank watch leather belt', NULL) <> 'watch'
     OR public.page365_item_kind_for('X1 Rolex Datejust', 'SUPPLIER LISTINGS - WATCH') <> 'watch'
     OR public.page365_item_kind_for('R1072 Ring Gucci 750WG 3.12g Icon', 'SUPPLIER LISTINGS - BRANDED PRELOVED') <> 'jewelry'
     OR public.page365_item_kind_for('R5 Ring Baguette K18', NULL) <> 'jewelry' THEN
    RAISE EXCEPTION 'page365_auto_land self-check: page365_item_kind_for is wrong';
  END IF;
  IF public.page365_metals_from_text('R1072 Ring Gucci 750WG 3.12g') <> ARRAY['750']
     OR public.page365_metals_from_text('N3876 Necklace K18YG/WG 1.90g') <> ARRAY['K18']
     OR public.page365_metals_from_text('R8633 Ring 18KWG 4.0g') <> ARRAY['18K']
     OR public.page365_metals_from_text('N5245 Necklace K18g 5.28g') <> ARRAY['K18']
     OR public.page365_metals_from_text('N1337 Necklace SV925 Tahiti SSP') <> ARRAY['SILVER925']
     OR public.page365_metals_from_text('N3178 Necklace SV 8.50g Emerald') <> ARRAY['SILVER']
     OR public.page365_metals_from_text('Necklace PT900/K18 45cm') <> ARRAY['PT900', 'K18']
     OR public.page365_metals_from_text('Diamond 0.750ct') <> ARRAY[]::text[] THEN
    RAISE EXCEPTION 'page365_auto_land self-check: page365_metals_from_text is wrong';
  END IF;

  IF EXISTS (SELECT 1 FROM public.website_products WHERE item_kind NOT IN ('jewelry', 'watch', 'accessory')) THEN
    RAISE EXCEPTION 'page365_auto_land self-check: a product still has an old item kind';
  END IF;
  IF NOT (SELECT pg_get_constraintdef(oid) LIKE '%''SILVER''%' FROM pg_constraint WHERE conname = 'website_products_metals_values')
     OR NOT (SELECT pg_get_constraintdef(oid) LIKE '%active%' FROM pg_constraint WHERE conname = 'website_products_metals_jewelry') THEN
    RAISE EXCEPTION 'page365_auto_land self-check: the metal constraints are not as intended';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.page365_item_kind_for(text,text)', 'public.page365_metals_from_text(text)',
                              'public.page365_inventory_land_run(uuid)', 'public.page365_inventory_plan_quick(uuid)',
                              'public.page365_inventory_finish(uuid)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_auto_land self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.page365_landings', 'SELECT')
     OR has_table_privilege('authenticated', 'public.page365_landings', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.page365_landings', 'SELECT') THEN
    RAISE EXCEPTION 'page365_auto_land self-check: page365_landings grants are wrong';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Bodies; expect exactly these five, and NO rows for page365_inventory_create_drafts /
--     page365_inventory_refresh_product:
--     page365_inventory_finish      e44762490fc64019a4cadfd9496fcbc6 ·
--     page365_inventory_land_run    7f27675ecd45453b1577fa5f6e6ba738 ·
--     page365_inventory_plan_quick  fb80f4f913334ce6da422840bf1de86e ·
--     page365_item_kind_for         a6b681d6010cbf56115c6ebb0229fb63 ·
--     page365_metals_from_text      59e64019d2958da8fedefb9f19db1763
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_inventory_finish','page365_inventory_land_run','page365_inventory_plan_quick',
--                    'page365_item_kind_for','page365_metals_from_text',
--                    'page365_inventory_create_drafts','page365_inventory_refresh_product')
--  ORDER BY 1;
--
-- (2) Item kinds and the metal rules; expect: 0 | t | t | t
-- SELECT (SELECT count(*) FROM public.website_products WHERE item_kind NOT IN ('jewelry','watch','accessory')) AS old_kinds,
--        (SELECT pg_get_constraintdef(oid) LIKE '%accessory%' FROM pg_constraint WHERE conname = 'website_products_item_kind_check') AS kind_check,
--        (SELECT pg_get_constraintdef(oid) LIKE '%active%'    FROM pg_constraint WHERE conname = 'website_products_metals_jewelry')  AS metal_at_publish,
--        'SILVER' = ANY (enum_range(NULL::public.website_product_karat)::text[])                                               AS silver_enum;
--
-- (3) Nothing landed yet (landing starts with the next complete read); expect: 0 | 0
-- SELECT (SELECT count(*) FROM public.page365_landings) AS landings,
--        (SELECT count(*) FROM public.audit_logs WHERE action = 'page365_product_landed') AS landed_audits;
--
-- (4) Browser roles; expect: t | f | f
-- SELECT has_table_privilege('authenticated','public.page365_landings','SELECT')                  AS auth_read_landings,
--        has_function_privilege('authenticated','public.page365_inventory_land_run(uuid)','EXECUTE') AS auth_land,
--        has_table_privilege('anon','public.page365_landings','SELECT')                           AS anon_read_landings;
--
-- (5) AFTER the next complete read (staff "Full fetch", or the nightly one): what landed, with what is
--     missing to publish; expect W3356 etc. as accessory, status draft, missing including origin/category.
-- SELECT l.code, l.item_kind, wp.status, wp.metals, public.website_product_publish_missing(l.product_id) AS missing,
--        l.photos_total, l.photos_done_at
--   FROM public.page365_landings l JOIN public.website_products wp ON wp.id = l.product_id
--  ORDER BY l.landed_at DESC LIMIT 50;
-- ===========================================================================
