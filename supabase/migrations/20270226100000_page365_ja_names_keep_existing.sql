-- ===========================================================================
-- Page365 name follow: Japanese names (owner 2026-10-31, after N5140).
--
-- A name follow clears name_ja and sets page365_listing_names.ja_pending; the
-- scheduled page365-inventory-fetch then translates the pending names. Two
-- defects, both proven on live 2026-10-31:
--   1. The pending list kept returning products that ALREADY have a Japanese
--      name again (23 of 26 pending rows), so they block the 5-per-tick queue
--      and, once translation works, would have their Japanese name replaced.
--   2. page365_set_name_ja replaced name_ja whenever the English name matched,
--      even when staff had typed or regenerated a Japanese name meanwhile.
-- Rule (owner 2026-10-30/31, same as the product editor #680): an existing
-- Japanese name is never replaced automatically; only a MISSING one is filled.
--
-- This migration:
--   - page365_pending_ja_names: only products whose name_ja is missing
--     (null, empty or whitespace-only).
--   - page365_set_name_ja: writes only while name_ja is still missing and the
--     English name is unchanged; if a Japanese name exists, it clears
--     ja_pending and writes nothing (returns false).
--   - One-time: clears ja_pending on rows whose product already has a
--     Japanese name (no name_ja is changed).
-- Signatures, SECURITY DEFINER, search_path and grants are unchanged
-- (CREATE OR REPLACE keeps the ACL: postgres + service_role only).
-- The edge-function half (translate-product-description accepting the
-- service-role caller) ships in the same PR and is deployed separately.
-- ASCII only.
-- ===========================================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '120s';

DO $pre$
DECLARE
  v_bad text := '';
  v_got text;
  r     record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_pending_ja_names(integer)',   'a23ec50466ad2c9e3a74585904afd2c8'),
      ('page365_set_name_ja(uuid,text,text)', '659b1c93cb8bf738cdd4e224f1a2518e')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_ja_names_keep_existing: live is not what this was written against -- nothing changed:%', v_bad;
  END IF;
  -- Self-check baseline: every product's name and Japanese name.
  PERFORM set_config('page365.ja_names_before',
    (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.name || ':' || coalesce(wp.name_ja, '<null>'), ',' ORDER BY wp.id), ''))
       FROM public.website_products wp),
    false);
END
$pre$;

CREATE OR REPLACE FUNCTION public.page365_pending_ja_names(p_limit integer DEFAULT 5)
 RETURNS TABLE(o_product_id uuid, o_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT n.website_product_id, wp.name
    FROM public.page365_listing_names n
    JOIN public.website_products wp ON wp.id = n.website_product_id
   WHERE n.ja_pending AND btrim(coalesce(wp.name, '')) <> ''
     -- Only a MISSING Japanese name is translated; an existing one is never replaced.
     AND btrim(coalesce(wp.name_ja, '')) = ''
   ORDER BY n.updated_at, n.website_product_id
   LIMIT greatest(1, least(coalesce(p_limit, 5), 20))
$function$;

CREATE OR REPLACE FUNCTION public.page365_set_name_ja(p_product_id uuid, p_expected_name text, p_name_ja text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_n integer;
BEGIN
  IF btrim(coalesce(p_name_ja, '')) = '' THEN RETURN false; END IF;
  -- Only while the Japanese name is still missing AND the English name has not
  -- moved again since it was translated. An existing Japanese name is kept.
  UPDATE public.website_products SET name_ja = btrim(p_name_ja)
   WHERE id = p_product_id
     AND btrim(name) = btrim(coalesce(p_expected_name, ''))
     AND btrim(coalesce(name_ja, '')) = '';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    -- A Japanese name exists now (staff or another path filled it): nothing to translate.
    UPDATE public.page365_listing_names n SET ja_pending = false, updated_at = now()
      FROM public.website_products wp
     WHERE n.website_product_id = p_product_id AND wp.id = p_product_id
       AND n.ja_pending AND btrim(coalesce(wp.name_ja, '')) <> '';
    RETURN false;   -- otherwise stays pending; the next tick translates the newer name
  END IF;
  UPDATE public.page365_listing_names SET ja_pending = false, updated_at = now() WHERE website_product_id = p_product_id;
  RETURN true;
END
$function$;

-- One-time: pending rows whose product already has a Japanese name.
UPDATE public.page365_listing_names n SET ja_pending = false, updated_at = now()
  FROM public.website_products wp
 WHERE wp.id = n.website_product_id
   AND n.ja_pending
   AND btrim(coalesce(wp.name_ja, '')) <> '';

DO $post$
DECLARE
  v_after text;
  v_wrong integer;
BEGIN
  SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.name || ':' || coalesce(wp.name_ja, '<null>'), ',' ORDER BY wp.id), ''))
    INTO v_after FROM public.website_products wp;
  IF v_after IS DISTINCT FROM current_setting('page365.ja_names_before', true) THEN
    RAISE EXCEPTION 'page365_ja_names_keep_existing: a product name or Japanese name changed -- rolled back';
  END IF;
  SELECT count(*) INTO v_wrong
    FROM public.page365_listing_names n JOIN public.website_products wp ON wp.id = n.website_product_id
   WHERE n.ja_pending AND btrim(coalesce(wp.name_ja, '')) <> '';
  IF v_wrong <> 0 THEN
    RAISE EXCEPTION 'page365_ja_names_keep_existing: % pending rows still have a Japanese name -- rolled back', v_wrong;
  END IF;
END
$post$;
