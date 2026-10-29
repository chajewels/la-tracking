-- ============================================================================
-- READ-ONLY dry run for 20270221100000_page365_follow_recode_name.sql.
-- Run in the Supabase SQL Editor BEFORE applying the migration. Writes nothing.
--
-- 1. Is live's page365_follow_names the body this migration starts from?
--    f94cc7a8650f239d705095e95dd677f1 = 20270220100000 applied from the repo text
--    (SQL Editor). Anything else: STOP, read pg_get_functiondef and compare.
--    df6874f35c21f527191d0d06153278c1 = already this migration (re-run is a no-op).
-- 2. What its one-time pass would do on the latest ready FULL read: every
--    matched, linked, not-switched-off product whose Hub name differs from
--    Page365's current text, with the action the pass takes:
--      update  Hub name is still a Page365 text seen before (never completed)
--      keep    staff completed it (no bell from the pass; one summary bell)
--    The N1073 / N9140 piece (listing 80622155) shows here only if a read
--    after 20270220100000 already renamed it; otherwise the first read after
--    this migration handles it (step a3 + the fixed step h).
-- ============================================================================
SELECT 'page365_follow_names' AS fn, md5(p.prosrc) AS md5, length(p.prosrc) AS len,
       CASE md5(p.prosrc) WHEN 'f94cc7a8650f239d705095e95dd677f1' THEN 'OK: 20270220100000 body'
                          WHEN 'df6874f35c21f527191d0d06153278c1' THEN 'OK: already 20270221100000'
                          ELSE 'STOP: unknown body' END AS verdict
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_follow_names(uuid,boolean)');

WITH run AS (
  SELECT r.id FROM public.page365_inventory_runs r
   WHERE r.kind = 'full' AND r.status = 'ready' ORDER BY r.created_at DESC LIMIT 1
)
SELECT wp.sku, wp.name AS hub_name, public.page365_listing_text(i.id) AS page365_now,
       ln.last_p365_name AS page365_last_seen, cardinality(ln.seen_names) AS names_seen,
       CASE WHEN EXISTS (SELECT 1 FROM unnest(ln.seen_names) s
                          WHERE public.page365_norm_name(public.page365_swap_code(s, public.page365_first_word(wp.name)))
                                = public.page365_norm_name(wp.name))
            THEN 'update' ELSE 'keep' END AS pass_action,
       i.result_note, wp.first_published_at IS NULL AS never_public
  FROM public.page365_inventory_items i
  JOIN run ON run.id = i.run_id
  JOIN public.website_products wp ON wp.id = i.website_product_id
  JOIN public.page365_listing_names ln ON ln.website_product_id = wp.id
 WHERE i.kind = 'page365' AND i.match_result = 'matched' AND i.category <> 'not_synced'
   AND NOT coalesce(wp.page365_sync_disabled, false)
   AND wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
   AND public.page365_first_word(public.page365_listing_text(i.id)) = public.page365_first_word(wp.name)
   AND public.page365_norm_name(public.page365_listing_text(i.id)) IS DISTINCT FROM public.page365_norm_name(wp.name)
   AND ln.bell_name IS DISTINCT FROM btrim(public.page365_listing_text(i.id))
 ORDER BY pass_action, wp.sku;
