-- ===========================================================================
-- page365_drafts_designer — "Create drafts" makes designer pieces too
-- (fix, 2026-09-26). Owner evidence: ticking wallets (W3356, W1451, …) and
-- pressing Create drafts gave "0 draft(s) created" and left result_note NULL.
--
-- ROOT CAUSE (page365_inventory_create_drafts, PR 4 / PR 3c body):
--   (a) item_kind knew only "watch" — every other listing was drafted as
--       JEWELRY, and jewelry needs a printed metal stamp. A wallet, bag, key
--       case or belt has none, so every one FAILED 'no_metal'. On the live
--       Page365 catalogue (642 listings, read 2026-09-26) that is all 35
--       wallets/bags/cases/belts in "SUPPLIER LISTINGS - BRANDS".
--   (b) page365_metals_from_text matched a stamp only as a bare word, so the
--       way Page365 actually prints most stamps — K18WG, K18YG/WG, 750WG,
--       750PG, 18KWG, K18g, SV925 — was never read: 118 more jewelry listings
--       (branded jewelry, Akoya/SV925 pearls, white-gold pieces) failed
--       'no_metal' too.
--   (c) a skipped or failed row never wrote result_note (only sync_disabled
--       and code_exists did), so after a reload nothing said why.
--
-- THE FIX (nothing else changes):
--   1. NEW public.page365_item_kind_for(name, category): only what Page365
--      printed, whole words — watch(es) -> 'watch'; wallet, bag, handbag,
--      clutch, tote, purse, pouch, backpack, cardholder / card holder / card
--      case, coin / key / pass case, key chain / key holder / key ring, belt,
--      scarf, sunglasses -> 'other'; anything else 'jewelry'. Watch wins.
--   2. page365_metals_from_text reads a printed stamp followed by a gold
--      colour code (WG YG PG RG CG G) as that stamp (K18WG -> K18, 750PG ->
--      750, 18KWG -> 18K), and SV925 as the Hub's SILVER925. Still whole
--      tokens only: "0.750ct" is not 750; a bare "SV" (no purity) is no stamp.
--   3. page365_inventory_create_drafts: uses (1); returns item_kind per
--      created item; writes result_note = the reason on EVERY review row it
--      skipped or failed. The CHECK website_products_metals_jewelry is NOT
--      touched: jewelry with no printed stamp still fails 'no_metal' — now
--      with the reason stored and shown.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main.
-- No edge function changes. One transaction. It creates no product, changes
-- no stock and publishes nothing (the self-check proves it). Re-running it is
-- a no-op.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_inventory_create_drafts   9ae1eb47496736b925db9625b1e2d373 -> dedae875710844cca4e15979e2902820   (PR 3c body + 3 edits)
--              page365_metals_from_text          3164641c287f98c715ef0785281f2b62 -> 21b25895ee0b9dcf4be02d337b77abff
--   new        page365_item_kind_for                                              -> f88fbe7867972f46ae606bcf04d1d58f
--   The "before" bodies are the repo text of 20261002100000 / 20260929100000,
--   which the owner applied as-is (verification (2) of 20261002100000).
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
  IF to_regclass('public.page365_inventory_items') IS NULL OR to_regclass('public.website_products') IS NULL THEN
    RAISE EXCEPTION 'page365_drafts_designer: Page365 inventory tables missing (PR 1 / PR 4 first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_products_metals_jewelry') THEN
    RAISE EXCEPTION 'page365_drafts_designer: CHECK website_products_metals_jewelry missing (PR 4, 20260929100000, first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_products_item_kind_check'
                  AND pg_get_constraintdef(oid) LIKE '%''other''%') THEN
    RAISE EXCEPTION 'page365_drafts_designer: website_products.item_kind must allow ''other'' (PR 4 first)';
  END IF;
  IF to_regprocedure('public.page365_item_kind_for(text,text)') IS NOT NULL
     AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.page365_item_kind_for(text,text)'))
         IS DISTINCT FROM 'f88fbe7867972f46ae606bcf04d1d58f' THEN
    RAISE EXCEPTION 'page365_drafts_designer: a different public.page365_item_kind_for(text,text) already exists';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_create_drafts(uuid,uuid[])', '9ae1eb47496736b925db9625b1e2d373', 'dedae875710844cca4e15979e2902820'),
      ('page365_metals_from_text(text)',               '3164641c287f98c715ef0785281f2b62', '21b25895ee0b9dcf4be02d337b77abff')
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_drafts_designer: live is not what this was written against — nothing changed:%', v_bad;
  END IF;

  -- For the self-check: nothing on the website may move during this file.
  PERFORM set_config('page365.designer_catalog_before',
    (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v),
    true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. What the piece is, from what Page365 printed (whole words only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_item_kind_for(p_name text, p_category text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE
    WHEN (coalesce(p_name, '') || ' ' || coalesce(p_category, '')) ~* '\mwatch(es)?\M' THEN 'watch'
    WHEN (coalesce(p_name, '') || ' ' || coalesce(p_category, ''))
         ~* '\m(wallets?|bags?|handbags?|clutch(es)?|totes?|purses?|pouch(es)?|backpacks?|cardholders?|card\s+(holder|case)s?|(coin|key|pass)\s+cases?|key\s*chains?|key\s+(holder|ring)s?|belts?|scarf|scarves|sunglasses)\M'
      THEN 'other'
    ELSE 'jewelry'
  END
$fn$;
REVOKE ALL ON FUNCTION public.page365_item_kind_for(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_item_kind_for(text, text) TO service_role;
COMMENT ON FUNCTION public.page365_item_kind_for(text, text) IS
  'Create drafts (2026-09-26): website_products.item_kind from the Page365 name and category, whole words only — watch(es) -> watch; wallet, bag, key/card/coin/pass case, belt … -> other; else jewelry. Watch wins. Staff can change it in the product dialog.';

-- ---------------------------------------------------------------------------
-- 2. Metal stamps as Page365 prints them. Only this file's caller uses it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_metals_from_text(p_text text)
RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT coalesce(array_agg(s.stamp ORDER BY s.first_at), ARRAY[]::text[])
    FROM (
      SELECT t.stamp, min(t.ord) AS first_at
        FROM (
          SELECT CASE WHEN upper(x.tok) = 'SV925' THEN 'SILVER925'
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
-- 3. page365_inventory_create_drafts — PR 3c body; edits: item kind from (1),
--    item_kind in created_items, result_note on every skipped/failed row.
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
  v_kind     text;
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
  -- PR 3c: "New in Page365" comes from the latest FULL read (quick reads open
  -- only Hub products' pages). Quick reads every 30 minutes do not supersede
  -- it; the next full read does. 48 h: one nightly full read may fail.
  IF v_run.kind IS DISTINCT FROM 'full' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_full_fetch');
  END IF;
  IF v_run.finished_at < now() - interval '48 hours' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_stale');
  END IF;
  IF EXISTS (SELECT 1 FROM public.page365_inventory_runs r
              WHERE r.status = 'ready' AND r.kind = 'full' AND r.created_at > v_run.created_at) THEN
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
    -- "Don't sync with Page365" (PR 2): a code whose Hub product is switched
    -- off is never drafted — whether the fetch already saw the switch
    -- (category not_synced) or it was switched on since.
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE wp.page365_sync_disabled
       AND (public.page365_first_word(wp.sku) = v_it.code
         OR (wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id))
     ORDER BY wp.created_at LIMIT 1;
    IF v_it.category = 'not_synced' OR v_existing IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'sync_disabled',
                                                   'product_id', coalesce(v_existing, v_it.website_product_id));
      IF v_it.status = 'review' THEN
        UPDATE public.page365_inventory_items SET result_note = 'sync_disabled' WHERE id = v_id;
      END IF;
      CONTINUE;
    END IF;
    IF v_it.kind <> 'page365' OR v_it.category <> 'new' OR v_it.match_result <> 'unmatched' OR v_it.status <> 'review'
       OR v_it.code IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'not_new');
      CONTINUE;
    END IF;
    -- PR 3c: a draft is made from a FRESH read of the listing — the edge
    -- function re-reads it just before this call (page365_inventory_refresh_product)
    -- — never from the nightly copy. Gone from Page365 since: never drafted.
    IF v_it.result_note = 'gone_from_page365' THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'gone_from_page365');
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.page365_inventory_products p
                    WHERE p.id = v_it.inventory_product_id AND p.fetched_at >= now() - interval '15 minutes') THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'not_fresh');
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
    -- Only what Page365 printed (page365_item_kind_for): "watch" in the name
    -- or category makes a watch; a wallet, bag, key/card/coin case, belt …
    -- makes an OTHER item. Neither needs a stamp. Anything else is jewelry.
    -- Staff can change it in the product dialog.
    v_kind  := public.page365_item_kind_for(v_name || ' ' || coalesce(v_it.page365_name, ''), v_prod.list_category);

    -- A listing whose name starts with a word, not a code ("Necklace K18 …"):
    -- the first-word rule would make "NECKLACE" the sku. Never.
    IF regexp_replace(regexp_replace(lower(v_it.code), 'es$', ''), 's$', '')
         IN ('ring','necklace','pendant','bracelet','earring','bangle','anklet',
             'brooch','charm','chain','pearl','set','new','preloved','watch')
       OR upper(v_it.code) = ANY (ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925']) THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_is_a_word');
      CONTINUE;
    END IF;
    IF v_price IS NULL OR v_price <= 0 THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'no_price');
      CONTINUE;
    END IF;
    IF cardinality(v_metals) = 0 AND v_kind = 'jewelry' THEN
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
                                 'price_jpy', v_price, 'stock_qty', v_stock, 'metals', to_jsonb(v_metals), 'item_kind', v_kind,
                                 'condition', v_cond, 'category_id', v_cat, 'page365_category', v_prod.list_category,
                                 'description_copied', v_desc IS NOT NULL, 'photos', jsonb_array_length(v_prod.photos),
                                 'page365_product_id', v_it.page365_product_id, 'page365_variant_id', v_it.page365_variant_id,
                                 'needs', to_jsonb(v_needs)),
              v_uid);
      v_created := v_created || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'product_id', v_pid,
                                                   'variant_id', v_vid, 'name', v_name, 'needs', to_jsonb(v_needs),
                                                   'item_kind', v_kind,
                                                   'photos', jsonb_array_length(v_prod.photos));
    EXCEPTION
      WHEN unique_violation THEN
        -- A concurrent press made the same sku between the check and the insert.
        v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_exists');
      WHEN OTHERS THEN
        v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', left(SQLERRM, 300));
    END;
  END LOOP;

  -- Every row that was not drafted keeps WHY on its review row, so the list
  -- shows it after a reload (never a silent "0 drafts"). A row already
  -- drafted, or no longer under review, is left alone.
  UPDATE public.page365_inventory_items i
     SET result_note = x.reason
    FROM (SELECT DISTINCT ON ((e->>'item_id')::uuid) (e->>'item_id')::uuid AS item_id, e->>'reason' AS reason
            FROM jsonb_array_elements(v_skipped || v_failed) e
           WHERE e->>'reason' IS NOT NULL) x
   WHERE i.id = x.item_id AND i.run_id = p_run_id AND i.status = 'review'
     AND i.result_note IS DISTINCT FROM 'draft_created';

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
-- 4. Self-check, still inside the transaction. Pure reads; any failure aborts
--    the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_got text;
  r     record;
BEGIN
  IF (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
     IS DISTINCT FROM current_setting('page365.designer_catalog_before', true) THEN
    RAISE EXCEPTION 'page365_drafts_designer self-check: a product status or stock changed during this file';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_create_drafts(uuid,uuid[])', 'dedae875710844cca4e15979e2902820'),
      ('page365_metals_from_text(text)',               '21b25895ee0b9dcf4be02d337b77abff'),
      ('page365_item_kind_for(text,text)',             'f88fbe7867972f46ae606bcf04d1d58f')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_drafts_designer self-check: % body md5 %, expected %', r.fn, v_got, r.want;
    END IF;
  END LOOP;

  -- The rules, on the owner's own examples (Page365 text as printed).
  IF public.page365_item_kind_for('W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]', 'SUPPLIER LISTINGS - BRANDS') <> 'other'
     OR public.page365_item_kind_for('W2497 Key Case Louis Vuitton Monogram Multicle 4 [Preloved]', 'SUPPLIER LISTINGS - BRANDS') <> 'other'
     OR public.page365_item_kind_for('SB022 Bag Burberry Shoulder bag [Preloved]', 'SUPPLIER LISTINGS - BRANDS') <> 'other'
     OR public.page365_item_kind_for('B2948 Belt Louis Vuitton Belt - LV Dimension Reversible 85/34 [Preloved]', NULL) <> 'other'
     OR public.page365_item_kind_for('X1 Rolex Datejust', 'SUPPLIER LISTINGS - WATCH') <> 'watch'
     OR public.page365_item_kind_for('R1072 Ring Gucci 750WG 3.12g Icon Sz# 11 [Preloved]', 'SUPPLIER LISTINGS - BRANDED PRELOVED') <> 'jewelry'
     OR public.page365_item_kind_for('B3689 Bracelet Valentino Stud Bracelet 14-17cm [Preloved]', 'SUPPLIER LISTINGS - BRANDS') <> 'jewelry' THEN
    RAISE EXCEPTION 'page365_drafts_designer self-check: page365_item_kind_for is wrong';
  END IF;
  IF public.page365_metals_from_text('R1072 Ring Gucci 750WG 3.12g') <> ARRAY['750']
     OR public.page365_metals_from_text('N3876 Necklace K18YG/WG 1.90g') <> ARRAY['K18']
     OR public.page365_metals_from_text('R8633 Ring 18KWG 4.0g') <> ARRAY['18K']
     OR public.page365_metals_from_text('N1337 Necklace SV925 Tahiti SSP') <> ARRAY['SILVER925']
     OR public.page365_metals_from_text('Necklace PT900/K18 45cm') <> ARRAY['PT900', 'K18']
     OR public.page365_metals_from_text('Diamond 0.750ct') <> ARRAY[]::text[]
     OR public.page365_metals_from_text('N3178 Necklace SV 8.50g Emerald') <> ARRAY[]::text[] THEN
    RAISE EXCEPTION 'page365_drafts_designer self-check: page365_metals_from_text is wrong';
  END IF;

  IF has_function_privilege('anon', 'public.page365_inventory_create_drafts(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.page365_inventory_create_drafts(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_drafts_designer self-check: page365_inventory_create_drafts grants are wrong';
  END IF;
  IF has_function_privilege('authenticated', 'public.page365_item_kind_for(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.page365_item_kind_for(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.page365_metals_from_text(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_drafts_designer self-check: a helper is callable by a browser role';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Bodies; expect exactly:
--     page365_inventory_create_drafts dedae875710844cca4e15979e2902820 ·
--     page365_item_kind_for           f88fbe7867972f46ae606bcf04d1d58f ·
--     page365_metals_from_text        21b25895ee0b9dcf4be02d337b77abff
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_inventory_create_drafts','page365_item_kind_for','page365_metals_from_text')
--  ORDER BY 1;
--
-- (2) The owner's wallets, as the next Create drafts will see them; expect every row
--     kind = other (W-codes) and, for the jewelry rows, a non-empty stamps list.
-- SELECT i.code, public.page365_item_kind_for(i.page365_name, p.list_category) AS kind,
--        public.page365_metals_from_text(i.page365_name || ' ' || coalesce(p.list_description, '')) AS stamps,
--        i.result_note
--   FROM public.page365_inventory_items i
--   JOIN public.page365_inventory_products p ON p.id = i.inventory_product_id
--  WHERE i.run_id = (SELECT id FROM public.page365_inventory_runs WHERE status = 'ready' AND kind = 'full'
--                     ORDER BY created_at DESC LIMIT 1)
--    AND i.category = 'new' AND i.status = 'review'
--  ORDER BY kind, i.code;
--
-- (3) Browser roles; expect: t | f | f
-- SELECT has_function_privilege('authenticated','public.page365_inventory_create_drafts(uuid,uuid[])','EXECUTE') AS auth_drafts,
--        has_function_privilege('authenticated','public.page365_item_kind_for(text,text)','EXECUTE')             AS auth_kind,
--        has_function_privilege('authenticated','public.page365_metals_from_text(text)','EXECUTE')               AS auth_metals;
--
-- (4) Nothing was created by running this file; expect 0.
-- SELECT count(*) FROM public.audit_logs WHERE action = 'page365_draft_created' AND created_at > now() - interval '5 minutes';
-- ===========================================================================
