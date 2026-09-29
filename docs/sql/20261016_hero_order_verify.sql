-- ============================================================================
-- Hero order (20261016100000_hero_order.sql) — READ-ONLY checks, LIVE values.
-- Run (P) BEFORE the migration and the numbered checks AFTER it. Nothing here
-- writes. docs/HERO-PICKS.md "Running order".
-- ============================================================================

-- (P) PREVIEW — before the migration.
-- (P.1) The two functions this file redefines are the 20261013100000 bodies.
--       Want: hero_cutouts_for_site c5d5edf56c8115469a586251d000f580,
--             hero_product_counts   a8058344a9a46bdbf0fdc4fd49c85e9f.
SELECT 'P.1' AS chk, p.proname, md5(p.prosrc)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('hero_cutouts_for_site', 'hero_product_counts')
 ORDER BY 2;
-- (P.2) The new names do not exist yet. Want: 0.
SELECT 'P.2' AS chk, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('hero_lineup_rows', 'get_hero_lineup');
-- (P.3) The columns the running order reads. Want: 7 rows.
SELECT 'P.3' AS chk, table_name, column_name FROM information_schema.columns
 WHERE table_schema = 'public'
   AND (table_name, column_name) IN (('website_categories','published'), ('website_categories','sort_order'),
                                     ('website_categories','slug'), ('website_category_products','sort_order'),
                                     ('website_category_products','category_id'), ('website_category_products','product_id'),
                                     ('website_product_variants','stock_qty'))
 ORDER BY 2, 3;
-- (P.4) Today's switch and ticks (to compare after). Want: hero_record.
SELECT 'P.4' AS chk, public.hero_photo_source() AS switch,
       (SELECT count(*) FROM public.website_hero_picks) AS ticks,
       (SELECT count(*) FROM public.hero_cutouts_for_site(ARRAY(SELECT source_url FROM public.website_hero_cutouts))) AS site_rows;

-- AFTER the migration.
-- (1) The redefined bodies are this file's. Want: hero_cutouts_for_site cff7614a4d0f0c211ed773b232a3b53b,
--     hero_product_counts 9d3fc77467b8695bc84dc65ab6f636dc.
SELECT '1' AS chk, p.proname, md5(p.prosrc)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname IN ('hero_cutouts_for_site', 'hero_product_counts')
 ORDER BY 2;
-- (2) Nothing on the website changed: same switch, same ticks, same site rows as (P.4).
SELECT '2' AS chk, public.hero_photo_source() AS switch,
       (SELECT count(*) FROM public.website_hero_picks) AS ticks,
       (SELECT count(*) FROM public.hero_cutouts_for_site(ARRAY(SELECT source_url FROM public.website_hero_cutouts))) AS site_rows;
-- (3) The counts now carry hero_waiting.
SELECT '3' AS chk, public.hero_product_counts(NULL);
-- (4) The running order, per category (empty until something is ticked).
SELECT '4' AS chk, c.slug, l.state, l.place, p.sku, l.reason, l.first_picked_at
  FROM public.hero_lineup_rows(NULL) l
  JOIN public.website_products p ON p.id = l.product_id
  LEFT JOIN public.website_categories c ON c.id = l.category_id
 ORDER BY c.sort_order NULLS LAST, c.slug, l.place NULLS LAST, p.sku;
-- (5) Grants. Want: f | t | f | t.
SELECT '5' AS chk,
       has_function_privilege('authenticated', 'public.hero_lineup_rows(text[])', 'EXECUTE') AS lineup_browser,
       has_function_privilege('service_role', 'public.hero_lineup_rows(text[])', 'EXECUTE') AS lineup_service,
       has_function_privilege('anon', 'public.get_hero_lineup()', 'EXECUTE') AS hub_view_anon,
       has_function_privilege('authenticated', 'public.get_hero_lineup()', 'EXECUTE') AS hub_view_signed_in;
