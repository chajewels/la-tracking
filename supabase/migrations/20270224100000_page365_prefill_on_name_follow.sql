-- ===========================================================================
-- Page365 prefill also after a NAME FOLLOW (owner 2026-10-30, after N5140).
--
-- When page365_follow_names copies a changed Page365 name into the Hub it
-- writes audit_logs action 'page365_name_followed'. An AFTER INSERT trigger on
-- audit_logs (only for that action) now runs the prefill for that product:
--   - never-published draft: the full landing prefill (page365_prefill_from_name);
--   - published / ever published: page365_prefill_blank_fields(product, true)
--     = Weight, Size, Stone (single variant) and Product types / Categories
--     only when the product has none. Condition, Origin, Brand are never
--     touched on a published product (owner decides them before publish).
-- Blank fields only; no stock, price, status or photo change; a prefill error
-- never undoes the name follow (savepoint in the trigger).
-- page365_follow_names and page365_prefill_from_name are NOT edited (md5s pinned).
--
-- One-time (owner 2026-10-30 "fill and apply", list of 25 approved in chat):
-- Weight / Size / Stone only (no types or categories) on the 24 products whose
-- names prove a blank value. ASCII only.
-- ===========================================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '300s';

DO $pre$
DECLARE
  v_bad text := '';
  v_got text;
  r     record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_follow_names(uuid,boolean)',   'df6874f35c21f527191d0d06153278c1'),
      ('page365_prefill_from_name(uuid)',      '63bd2f5b9bbc9374baa76eb14b176213'),
      ('page365_prefill_weight(text)',         '60cbd26d21743a7c030f29130e7d8bb8'),
      ('page365_prefill_ring_size(text)',      '75e80cfcaddb4e769c0e3039d0dae89e'),
      ('page365_prefill_length(text)',         'b244de33230399617b6b3e6e847fc092'),
      ('page365_prefill_mm(text)',             '05b9caefeb5e30b754542a6e41d000bc'),
      ('page365_prefill_stones(text)',         '3cbba9825ceda4e5a9266cbf914230a9'),
      ('page365_prefill_type_slug(text,text)', 'dcec12ebb1a5031ecb9bfab97af5d73b')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_prefill_on_name_follow: live is not what this was written against -- nothing changed:%', v_bad;
  END IF;
  -- Self-check baseline: everything except weight / size / stone, for every product.
  PERFORM set_config('page365.prefill_follow_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || wp.condition || ':' || wp.origin || ':'
                 || coalesce(wp.brand, '') || ':' || wp.name, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), ''))
          FROM public.website_product_variants v)
    || (SELECT count(*)::text FROM public.website_collection_products) || '|'
    || (SELECT count(*)::text FROM public.website_category_products),
    false);
END
$pre$;

-- Blank fields on any product (published or not). Weight; Size and Stone on a
-- single-variant product; with p_lists also Product types / Categories when the
-- product has none. Never Condition, Origin, Brand, stock, price, status.
CREATE OR REPLACE FUNCTION public.page365_prefill_blank_fields(p_product_id uuid, p_lists boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_p      public.website_products%ROWTYPE;
  v_vid    uuid;
  v_vsize  text;
  v_vstone text;
  v_nvar   integer;
  v_kind   text;
  v_brand  text;
  v_weight numeric;
  v_type   text;
  v_cat    text;
  v_size   text;
  v_stone  text;
  v_filled text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_p FROM public.website_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF coalesce(v_p.page365_sync_disabled, false) THEN RETURN jsonb_build_object('ok', false, 'reason', 'sync_disabled'); END IF;
  v_kind  := v_p.item_kind;
  v_brand := nullif(btrim(coalesce(v_p.brand, '')), '');
  v_type  := public.page365_prefill_type_slug(v_p.name, v_kind);

  IF v_p.weight_g IS NULL THEN
    v_weight := public.page365_prefill_weight(v_p.name);
    IF v_weight IS NOT NULL THEN
      UPDATE public.website_products SET weight_g = v_weight WHERE id = p_product_id;
      v_filled := array_append(v_filled, 'weight_g');
    END IF;
  END IF;

  IF p_lists THEN
    IF NOT EXISTS (SELECT 1 FROM public.website_collection_products WHERE product_id = p_product_id) THEN
      INSERT INTO public.website_collection_products (collection_id, product_id, sort)
      SELECT c.id, p_product_id, 0 FROM public.website_collections c
       WHERE c.slug = v_type
          OR (c.slug = 'pearls' AND v_kind = 'jewelry'
              AND EXISTS (SELECT 1 FROM unnest(string_to_array(public.page365_prefill_stones(v_p.name), ', ')) st(x)
                           WHERE st.x ~ 'Pearl$' AND st.x <> 'Mother of Pearl'));
      IF FOUND THEN v_filled := array_append(v_filled, 'product_types'); END IF;
    END IF;
    v_cat := CASE
      WHEN v_kind = 'jewelry' AND v_p.condition = 'Preloved' AND v_brand IS NOT NULL THEN 'preloved-branded-jewelry'
      WHEN v_kind = 'jewelry' AND v_p.condition = 'Preloved' THEN 'preloved-jewelry'
      WHEN v_kind = 'jewelry' AND v_brand IS NULL THEN 'fine-jewelry'
      WHEN v_kind = 'watch' AND v_p.condition = 'Preloved' THEN 'preloved-watches'
      WHEN v_kind = 'accessory' AND v_p.condition = 'Preloved' THEN 'preloved-designer-accessories'
    END;
    IF v_cat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.website_category_products WHERE product_id = p_product_id) THEN
      INSERT INTO public.website_category_products (category_id, product_id, sort_order)
      SELECT c.id, p_product_id, 0 FROM public.website_categories c WHERE c.slug = v_cat;
      IF FOUND THEN v_filled := array_append(v_filled, 'categories'); END IF;
    END IF;
  END IF;

  SELECT count(*) INTO v_nvar FROM public.website_product_variants WHERE product_id = p_product_id;
  IF v_nvar = 1 THEN
    SELECT id, size, stone INTO v_vid, v_vsize, v_vstone FROM public.website_product_variants WHERE product_id = p_product_id;
    v_size := nullif(btrim(coalesce(v_vsize, '')), '');
    IF v_size IS NULL THEN
      v_size := CASE
        WHEN v_type = 'rings' THEN public.page365_prefill_ring_size(v_p.name)
        WHEN v_type IN ('earrings', 'pendants') THEN coalesce(public.page365_prefill_length(v_p.name),
                                                              public.page365_prefill_mm(v_p.name))
        WHEN v_kind IN ('jewelry', 'watch') OR v_type IN ('necklaces', 'bracelets', 'anklets')
          THEN public.page365_prefill_length(v_p.name) END;
      IF v_size IS NOT NULL THEN v_filled := array_append(v_filled, 'size'); END IF;
    END IF;
    v_stone := nullif(btrim(coalesce(v_vstone, '')), '');
    IF v_stone IS NULL AND v_kind = 'jewelry' THEN
      v_stone := public.page365_prefill_stones(v_p.name);
      IF v_stone IS NOT NULL THEN v_filled := array_append(v_filled, 'stone'); END IF;
    END IF;
    v_size  := coalesce(v_size, v_vsize);
    v_stone := coalesce(v_stone, v_vstone);
    IF v_size IS DISTINCT FROM v_vsize OR v_stone IS DISTINCT FROM v_vstone THEN
      UPDATE public.website_product_variants SET size = v_size, stone = v_stone WHERE id = v_vid;
    END IF;
  END IF;

  IF cardinality(v_filled) > 0 THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('website_product', p_product_id, 'page365_prefilled_blank_fields',
            jsonb_build_object('name', v_p.name, 'filled', to_jsonb(v_filled), 'weight_g', v_weight, 'size', v_size,
                               'stone', v_stone, 'product_type', v_type, 'category', v_cat, 'lists', p_lists),
            NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'filled', to_jsonb(v_filled));
END
$fn$;

-- After a Page365 name follow. Never lets a prefill problem undo the follow.
CREATE OR REPLACE FUNCTION public.page365_name_followed_prefill_trg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_draft boolean;
BEGIN
  BEGIN
    SELECT wp.status::text = 'draft' AND wp.first_published_at IS NULL INTO v_draft
      FROM public.website_products wp WHERE wp.id = NEW.entity_id;
    IF v_draft THEN
      PERFORM public.page365_prefill_from_name(NEW.entity_id);
    ELSIF v_draft IS NOT NULL THEN
      PERFORM public.page365_prefill_blank_fields(NEW.entity_id, true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'page365 prefill after name follow (%) failed: %', NEW.entity_id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_page365_name_followed_prefill ON public.audit_logs;
CREATE TRIGGER trg_page365_name_followed_prefill
  AFTER INSERT ON public.audit_logs
  FOR EACH ROW
  WHEN (NEW.action = 'page365_name_followed' AND NEW.entity_type = 'website_product' AND NEW.entity_id IS NOT NULL)
  EXECUTE FUNCTION public.page365_name_followed_prefill_trg();

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['page365_prefill_blank_fields(uuid,boolean)', 'page365_name_followed_prefill_trg()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END
$grants$;

-- One-time: Weight / Size / Stone only, the 24 products approved 2026-10-30.
DO $once$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT wp.id FROM public.website_products wp
     WHERE wp.sku IN ('AL123', 'N1979', 'N5140', 'PDS55', 'R2112', 'R3435', 'R6814', 'WCC17',
                      'N1243', 'N1257', 'N2010', 'N2411', 'N4032', 'NLWTP', 'P7350', 'PPAK7', 'PPH13', 'R1155',
                      'E5994', 'N2583', 'N2676', 'P1560', 'R6512', 'R8913')
       AND wp.page365_product_id IS NOT NULL
  LOOP
    PERFORM public.page365_prefill_blank_fields(r.id, false);
  END LOOP;
END
$once$;

DO $chk$
DECLARE v_got text;
BEGIN
  IF current_setting('page365.prefill_follow_before', true) IS DISTINCT FROM
     (SELECT count(*)::text FROM public.website_products) || '|'
     || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || wp.condition || ':' || wp.origin || ':'
                  || coalesce(wp.brand, '') || ':' || wp.name, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), ''))
           FROM public.website_product_variants v)
     || (SELECT count(*)::text FROM public.website_collection_products) || '|'
     || (SELECT count(*)::text FROM public.website_category_products) THEN
    RAISE EXCEPTION 'page365_prefill_on_name_follow self-check: something other than weight / size / stone changed';
  END IF;
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_follow_names(uuid,boolean)');
  IF v_got IS DISTINCT FROM 'df6874f35c21f527191d0d06153278c1' THEN
    RAISE EXCEPTION 'page365_prefill_on_name_follow self-check: follow_names changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_page365_name_followed_prefill') THEN
    RAISE EXCEPTION 'page365_prefill_on_name_follow self-check: trigger missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_products wp JOIN public.website_product_variants v ON v.product_id = wp.id
              WHERE wp.page365_product_id IS NOT NULL AND (
                    (wp.sku = 'N5140' AND v.size IS DISTINCT FROM '40cm')
                 OR (wp.sku = 'R3435' AND v.size IS DISTINCT FROM '13.5')
                 OR (wp.sku = 'N2010' AND v.stone IS DISTINCT FROM 'Rose Quartz, Fresh Water Pearl')
                 OR (wp.sku = 'N4032' AND v.stone IS DISTINCT FROM 'Ruby, Diamond')
                 OR (wp.sku = 'R8913' AND wp.weight_g IS DISTINCT FROM 8.90)
                 OR (wp.sku = 'N2583' AND wp.weight_g IS DISTINCT FROM 25.70))) THEN
    RAISE EXCEPTION 'page365_prefill_on_name_follow self-check: a one-time value is wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname IN ('page365_prefill_blank_fields', 'page365_name_followed_prefill_trg')
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'page365_prefill_on_name_follow self-check: a new function is callable by anon / authenticated';
  END IF;
END
$chk$;
