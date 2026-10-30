-- ============================================================================
-- LOCAL test for 20270226100000_page365_ja_names_keep_existing.sql
-- Local Postgres only (never live). Run:
--   createdb ja_names_test && psql -d ja_names_test -f docs/sql/20270226_page365_ja_names_local_test.sql
-- 1. Minimal stub of the two tables.
-- 2. The two functions EXACTLY as live had them on 2026-10-31 (their body md5
--    must equal the migration's pinned md5, which this file checks).
-- 3. Seed, apply the migration, check the behaviour. Prints
--    ALL JA-NAMES CHECKS PASSED.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE TABLE public.website_products (id uuid PRIMARY KEY, name text, name_ja text);
CREATE TABLE public.page365_listing_names (website_product_id uuid PRIMARY KEY, ja_pending boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());

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
  -- Only if the English name has not moved again since it was translated.
  UPDATE public.website_products SET name_ja = btrim(p_name_ja)
   WHERE id = p_product_id AND btrim(name) = btrim(coalesce(p_expected_name, ''));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN false; END IF;   -- stays pending; the next tick translates the newer name
  UPDATE public.page365_listing_names SET ja_pending = false, updated_at = now() WHERE website_product_id = p_product_id;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got % want %', label, got, want; END IF;
RAISE NOTICE 'ok  %', label; END $$;

-- The stubs are byte-identical to live (same md5 the migration pins).
SELECT pg_temp.eq('stub pending md5 = live', md5(prosrc), 'a23ec50466ad2c9e3a74585904afd2c8') FROM pg_proc WHERE proname = 'page365_pending_ja_names';
SELECT pg_temp.eq('stub set md5 = live',     md5(prosrc), '659b1c93cb8bf738cdd4e224f1a2518e') FROM pg_proc WHERE proname = 'page365_set_name_ja';

-- Seed: A missing (pending), B has a Japanese name typed meanwhile (pending), C whitespace-only (pending),
-- D not pending, E missing but English name changed since.
INSERT INTO public.website_products VALUES
  ('00000000-0000-0000-0000-00000000000a', 'N5140 Necklace', NULL),
  ('00000000-0000-0000-0000-00000000000b', 'C1426 Watch', 'C1426 時計'),
  ('00000000-0000-0000-0000-00000000000c', 'R3694 Ring', '   '),
  ('00000000-0000-0000-0000-00000000000d', 'B2200 Bracelet', 'B2200 ブレスレット'),
  ('00000000-0000-0000-0000-00000000000e', 'N2916 Necklace NEW', NULL);
INSERT INTO public.page365_listing_names VALUES
  ('00000000-0000-0000-0000-00000000000a', true,  '2026-10-30 02:15'),
  ('00000000-0000-0000-0000-00000000000b', true,  '2026-10-29 05:38'),
  ('00000000-0000-0000-0000-00000000000c', true,  '2026-10-30 01:27'),
  ('00000000-0000-0000-0000-00000000000d', false, '2026-10-29 00:00'),
  ('00000000-0000-0000-0000-00000000000e', true,  '2026-10-30 01:27');

-- Before: the old pending list includes B (the bug).
SELECT pg_temp.eq('before: old list includes the product that has a Japanese name',
  (SELECT count(*) FROM public.page365_pending_ja_names(20) WHERE o_product_id = '00000000-0000-0000-0000-00000000000b'), 1::bigint);

BEGIN;
\i supabase/migrations/20270226100000_page365_ja_names_keep_existing.sql
COMMIT;

-- One-time clear: B no longer pending, its Japanese name untouched; A, C, E still pending.
SELECT pg_temp.eq('B pending cleared', (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = '00000000-0000-0000-0000-00000000000b'), false);
SELECT pg_temp.eq('B name_ja untouched', (SELECT name_ja FROM public.website_products WHERE id = '00000000-0000-0000-0000-00000000000b'), 'C1426 時計');
SELECT pg_temp.eq('A still pending', (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = '00000000-0000-0000-0000-00000000000a'), true);
SELECT pg_temp.eq('C (whitespace) still pending', (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = '00000000-0000-0000-0000-00000000000c'), true);

-- New list: only missing Japanese names (A, C, E), oldest first.
SELECT pg_temp.eq('new list = A, C, E',
  (SELECT string_agg(right(o_product_id::text, 1), ',' ORDER BY ord) FROM (SELECT o_product_id, row_number() OVER () ord FROM public.page365_pending_ja_names(20)) t),
  'c,e,a');
SELECT pg_temp.eq('limit still honoured', (SELECT count(*) FROM public.page365_pending_ja_names(1)), 1::bigint);

-- set_name_ja: fills a missing name and clears pending.
SELECT pg_temp.eq('A filled', public.page365_set_name_ja('00000000-0000-0000-0000-00000000000a', 'N5140 Necklace', ' N5140 ネックレス '), true);
SELECT pg_temp.eq('A name_ja trimmed', (SELECT name_ja FROM public.website_products WHERE id = '00000000-0000-0000-0000-00000000000a'), 'N5140 ネックレス');
SELECT pg_temp.eq('A pending cleared', (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = '00000000-0000-0000-0000-00000000000a'), false);

-- set_name_ja: whitespace-only counts as missing.
SELECT pg_temp.eq('C filled', public.page365_set_name_ja('00000000-0000-0000-0000-00000000000c', 'R3694 Ring', 'R3694 リング'), true);

-- set_name_ja: English name moved -> nothing written, stays pending.
SELECT pg_temp.eq('E refused (English changed)', public.page365_set_name_ja('00000000-0000-0000-0000-00000000000e', 'N2916 Necklace', 'N2916 ネックレス'), false);
SELECT pg_temp.eq('E name_ja still null', (SELECT name_ja FROM public.website_products WHERE id = '00000000-0000-0000-0000-00000000000e'), NULL::text);
SELECT pg_temp.eq('E still pending', (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = '00000000-0000-0000-0000-00000000000e'), true);

-- set_name_ja: a Japanese name typed meanwhile is NEVER replaced; pending is cleared.
UPDATE public.page365_listing_names SET ja_pending = true WHERE website_product_id = '00000000-0000-0000-0000-00000000000d';
SELECT pg_temp.eq('D refused (has a Japanese name)', public.page365_set_name_ja('00000000-0000-0000-0000-00000000000d', 'B2200 Bracelet', 'B2200 別の訳'), false);
SELECT pg_temp.eq('D name_ja kept', (SELECT name_ja FROM public.website_products WHERE id = '00000000-0000-0000-0000-00000000000d'), 'B2200 ブレスレット');
SELECT pg_temp.eq('D pending cleared', (SELECT ja_pending FROM public.page365_listing_names WHERE website_product_id = '00000000-0000-0000-0000-00000000000d'), false);

-- Empty translation: nothing written.
SELECT pg_temp.eq('empty translation refused', public.page365_set_name_ja('00000000-0000-0000-0000-00000000000e', 'N2916 Necklace NEW', '  '), false);

\echo ALL JA-NAMES CHECKS PASSED
