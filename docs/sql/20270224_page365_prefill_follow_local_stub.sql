-- ============================================================================
-- Page365 prefill after a name follow (2026-10-30) -- LOCAL stub additions +
-- tests. Local Postgres only. Run after the 20270222 stub, 20270222100000 and
-- 20270223100000:
--   P docs/sql/20270224_page365_prefill_follow_local_tests.sql   (includes stub part)
-- page365_follow_names is created with its exact live text (md5 df6874f3...,
-- body from 20270221100000) so the migration's guard passes; it is not called.
-- ============================================================================
\set ON_ERROR_STOP 1
ALTER TABLE public.website_products ADD COLUMN IF NOT EXISTS page365_sync_disabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.website_products ADD COLUMN IF NOT EXISTS page365_product_id bigint;
SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.page365_follow_names(p_run_id uuid, p_once boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r         record;
  v_ln      public.page365_listing_names%ROWTYPE;
  v_cur     text;
  v_prev    text;
  v_changed boolean;
  v_never   boolean;
  v_done    boolean;
  v_keep    boolean;
  v_updated integer := 0;
  v_kept    integer := 0;
BEGIN
  FOR r IN
    SELECT i.id AS item_id, wp.id AS pid, i.page365_product_id AS ppid, i.page365_variant_id AS pvid,
           wp.name AS hub_name, wp.sku, wp.first_published_at,
           (i.result_note IS NOT DISTINCT FROM 'code_followed') AS recoded
      FROM public.page365_inventory_items i
      JOIN public.website_products wp ON wp.id = i.website_product_id
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched' AND i.category <> 'not_synced'
       AND NOT coalesce(wp.page365_sync_disabled, false)
       AND wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
     ORDER BY i.id
  LOOP
    v_cur := btrim(coalesce(public.page365_listing_text(r.item_id), ''));
    CONTINUE WHEN v_cur = '';
    CONTINUE WHEN public.page365_first_word(v_cur) IS DISTINCT FROM public.page365_first_word(r.hub_name);

    SELECT * INTO v_ln FROM public.page365_listing_names WHERE website_product_id = r.pid FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.page365_listing_names (website_product_id, page365_product_id, page365_variant_id, last_p365_name, seen_names)
      VALUES (r.pid, r.ppid, r.pvid, v_cur, ARRAY[v_cur])
      ON CONFLICT (website_product_id) DO NOTHING;
      CONTINUE;
    END IF;

    v_changed := CASE WHEN p_once THEN public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(r.hub_name)
                      ELSE public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(v_ln.last_p365_name)
                        OR (r.recoded AND public.page365_norm_name(v_cur) IS DISTINCT FROM public.page365_norm_name(r.hub_name)) END;
    IF NOT v_changed THEN CONTINUE; END IF;
    CONTINUE WHEN p_once AND v_ln.bell_name IS NOT DISTINCT FROM v_cur;
    v_keep := false;

    v_prev := v_ln.last_p365_name;
    IF public.page365_norm_name(v_prev) = public.page365_norm_name(v_cur) THEN
      SELECT t.s INTO v_prev FROM unnest(v_ln.seen_names) WITH ORDINALITY AS t(s, ord)
       WHERE public.page365_norm_name(t.s) <> public.page365_norm_name(v_cur)
       ORDER BY t.ord DESC LIMIT 1;
      v_prev := coalesce(v_prev, v_ln.last_p365_name);
    END IF;

    IF public.page365_norm_name(r.hub_name) = public.page365_norm_name(v_cur) THEN
      v_done := false; v_never := false;
    ELSE
      v_never := EXISTS (SELECT 1 FROM unnest(v_ln.seen_names) s
                          WHERE public.page365_norm_name(public.page365_swap_code(s, public.page365_first_word(r.hub_name)))
                                = public.page365_norm_name(r.hub_name));
      v_done := false;
      IF v_never THEN
        BEGIN
          UPDATE public.website_products
             SET name = v_cur, name_ja = NULL,
                 slug = CASE WHEN r.first_published_at IS NULL
                             THEN public.page365_make_slug(public.page365_first_word(v_cur), v_cur, r.pvid, r.pid) ELSE slug END
           WHERE id = r.pid;
          INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
          VALUES ('website_product', r.pid, 'page365_name_followed',
                  jsonb_build_object('name', r.hub_name),
                  jsonb_build_object('name', v_cur, 'run_id', p_run_id, 'once', p_once, 'recoded', r.recoded,
                                     'page365_product_id', r.ppid), NULL);
          v_done := true;
          v_updated := v_updated + 1;
        EXCEPTION WHEN OTHERS THEN
          v_done := false;
        END;
      END IF;
      IF NOT v_done THEN
        v_keep := true;
        v_kept := v_kept + 1;
        IF NOT p_once AND v_ln.bell_name IS DISTINCT FROM v_cur THEN
          INSERT INTO public.staff_notifications (type, title, body, metadata)
          VALUES ('page365_name_changed', 'Page365 changed a name you completed',
                  r.sku || ': Page365 changed its name from "' || coalesce(v_prev, '') || '" to "' || v_cur
                    || '". The Hub name was completed by staff and was left as "' || r.hub_name || '".',
                  jsonb_build_object('run_id', p_run_id, 'website_product_id', r.pid, 'code', r.sku,
                                     'page365_old', v_prev, 'page365_new', v_cur, 'hub_name', r.hub_name,
                                     'recoded', r.recoded));
        END IF;
      END IF;
    END IF;

    UPDATE public.page365_listing_names
       SET last_p365_name = v_cur,
           seen_names = CASE WHEN EXISTS (SELECT 1 FROM unnest(seen_names) s WHERE public.page365_norm_name(s) = public.page365_norm_name(v_cur))
                             THEN seen_names
                             ELSE (seen_names || v_cur)[greatest(1, cardinality(seen_names) + 1 - 29):] END,
           bell_name = CASE WHEN v_keep THEN v_cur ELSE bell_name END,
           ja_pending = ja_pending OR v_done,
           updated_at = now()
     WHERE website_product_id = r.pid;
  END LOOP;

  IF p_once AND (v_updated + v_kept) > 0 THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES ('page365_names_followed_summary', 'Page365 names compared with the Catalog',
            (v_updated + v_kept) || ' Catalog names differed from Page365: ' || v_updated
              || ' updated to Page365''s text (never completed), ' || v_kept
              || ' kept because staff completed them. From now on a Page365 change rings one bell for a completed name.',
            jsonb_build_object('run_id', p_run_id, 'updated', v_updated, 'kept', v_kept));
  END IF;
  RETURN jsonb_build_object('updated', v_updated, 'kept', v_kept);
END
$fn$;
RESET check_function_bodies;
-- Seed: two of the approved products (published) + a staff-filled one + a draft.
INSERT INTO public.website_products (sku, name, status, origin, condition, metals, first_published_at, page365_product_id) VALUES
 ('N5140', 'N5140 Necklace SV925 Akoya Pearl 7.0mm 40cm [Preloved]', 'active', 'JAPAN', 'Preloved', ARRAY['SILVER925'], now(), 1),
 ('R8913', 'R8913 Ring PT900 8.90g Sapp 0.95ct Diamond 0.71ct Halo Cocktail Sz# 13 [Preloved]', 'active', 'JAPAN', 'Preloved', ARRAY['PT900'], now(), 2),
 ('R3435', 'R3435 Ring Tiffany & Co. 750WG 3.40g Atlas 4P Diamond #53 Sz# 13.5 [Preloved]', 'active', 'BRAND', 'Preloved', ARRAY['750'], now(), 3),
 ('N2010', 'N2010 Necklace K10 Rose Quartz Fresh Water Pearl 47cm [Preloved]', 'active', 'JAPAN', 'Preloved', ARRAY['K10'], now(), 4),
 ('N4032', 'N4032 Necklace Saint Laurent K18 3.20g R0.05ct D0.10ct Logo YSL 40cm [Preloved]', 'draft', 'BRAND', 'Preloved', ARRAY['K18'], now(), 5),
 ('N2583', 'N2583 Necklace Tiffany & Co SV925 25.70g Dog Tag 40cm [Preloved]', 'active', 'BRAND', 'Preloved', ARRAY['SILVER925'], now(), 6),
 ('NLWTP', 'NLWTP Necklace K18 White Topaz Peridot 3 Layers 43-45cm', 'active', 'JAPAN', 'New', ARRAY['K18'], now(), 7),
 ('Y0001', 'Y0001 Necklace K18 3.0g Ruby 45cm', 'active', 'JAPAN', 'New', ARRAY['K18'], now(), 8);
UPDATE public.website_products SET brand = 'Tiffany & Co.' WHERE sku IN ('R3435', 'N2583');
UPDATE public.website_products SET brand = 'Saint Laurent' WHERE sku = 'N4032';
INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, size, stone)
SELECT id, 9999, 1, CASE WHEN sku = 'Y0001' THEN 'staff' END, CASE WHEN sku = 'Y0001' THEN 'Garnet' END
  FROM public.website_products WHERE sku IN ('N5140','R8913','R3435','N2010','N4032','N2583','NLWTP','Y0001');
INSERT INTO public.website_collection_products (collection_id, product_id)
SELECT c.id, p.id FROM public.website_products p, public.website_collections c
 WHERE p.sku IN ('N5140','N2010','N4032','N2583','NLWTP','Y0001') AND c.slug = 'necklaces'
    OR p.sku IN ('R8913','R3435') AND c.slug = 'rings';
INSERT INTO public.website_category_products (category_id, product_id)
SELECT c.id, p.id FROM public.website_products p, public.website_categories c
 WHERE p.sku IN ('N5140','R8913','N2010') AND c.slug = 'preloved-jewelry'
    OR p.sku IN ('R3435','N4032','N2583') AND c.slug = 'preloved-branded-jewelry';
