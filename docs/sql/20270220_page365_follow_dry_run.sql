-- ============================================================================
-- Page365 follow + Catalog delete — DRY RUN. READ-ONLY (SELECT only): paste it
-- into the SQL Editor BEFORE the migration 20270220100000 is applied, review
-- the three result sets, and approve (or stop). It writes nothing and needs no
-- function from the migration (it inlines the same rules).
--
--   A. LINK BACKFILL    must list exactly N1616, R7828, R3341 (the migration
--                       refuses anything else).
--   B. NAME ACTIONS     the one-time pass over the latest ready FULL read:
--                       UPDATE = Hub name is still exactly a Page365 name it
--                       was copied from (never completed) -> becomes Page365's
--                       text; KEEP = staff completed it -> left alone, counted
--                       in ONE summary bell; RECODE = the code itself changed
--                       (handled by the next read, not by this pass).
--   C. STRANDED CODES   linked products whose listing is now under another
--                       code (N1073 -> N9140 shape): renamed by the next read.
-- The comparison form is lower-case, whitespace (incl. U+3000 / NBSP) collapsed.
-- ============================================================================
WITH last_run AS (
  SELECT id, created_at FROM public.page365_inventory_runs
   WHERE kind = 'full' AND status = 'ready' ORDER BY created_at DESC LIMIT 1
)
-- A. LINK BACKFILL -----------------------------------------------------------
SELECT 'A backfill' AS section, wp.sku, wp.name AS hub_name, i.page365_product_id, i.page365_variant_id,
       i.page365_name AS page365_name, wp.status::text AS status
  FROM public.website_products wp
  JOIN last_run lr ON true
  JOIN public.page365_inventory_items i
    ON i.run_id = lr.id AND i.kind = 'page365' AND i.code = upper((regexp_match(wp.sku, ('^[\s' || chr(12288) || '' || chr(160) || ']*([^\s' || chr(12288) || '' || chr(160) || ']+)')))[1])
 WHERE wp.page365_product_id IS NULL AND NOT coalesce(wp.page365_sync_disabled, false)
   AND wp.status::text <> 'archived'
   AND wp.sku !~ ('[^\s' || chr(12288) || '' || chr(160) || '][\s' || chr(12288) || '' || chr(160) || ']+[^\s' || chr(12288) || '' || chr(160) || ']')
   AND (SELECT count(*) FROM public.page365_inventory_items j WHERE j.run_id = lr.id AND j.kind = 'page365' AND j.code = i.code) = 1
   AND NOT EXISTS (SELECT 1 FROM public.website_products o
                    WHERE o.page365_product_id = i.page365_product_id AND o.page365_variant_id = i.page365_variant_id)
   AND (SELECT count(*) FROM public.website_products w2
         WHERE upper((regexp_match(w2.sku, ('^[\s' || chr(12288) || '' || chr(160) || ']*([^\s' || chr(12288) || '' || chr(160) || ']+)')))[1])
             = upper((regexp_match(wp.sku, ('^[\s' || chr(12288) || '' || chr(160) || ']*([^\s' || chr(12288) || '' || chr(160) || ']+)')))[1])) = 1
 ORDER BY wp.sku;

WITH last_run AS (
  SELECT id FROM public.page365_inventory_runs WHERE kind = 'full' AND status = 'ready' ORDER BY created_at DESC LIMIT 1
),
cur AS (   -- what Page365 calls each linked listing now (page365_listing_text's rule)
  SELECT wp.id AS pid, wp.sku, wp.name AS hub_name,
         btrim(CASE WHEN count(*) OVER (PARTITION BY i.inventory_product_id) > 1
                         AND btrim(coalesce(i.variant_name, '')) ~ '\S\s+\S'
                    THEN i.variant_name ELSE coalesce(i.page365_name, p.name, p.list_name) END) AS p365_name,
         wp.page365_product_id AS ppid, wp.page365_variant_id AS pvid
    FROM public.page365_inventory_items i
    JOIN last_run lr ON lr.id = i.run_id
    LEFT JOIN public.page365_inventory_products p ON p.id = i.inventory_product_id
    JOIN public.website_products wp
      ON wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
   WHERE i.kind = 'page365' AND NOT coalesce(wp.page365_sync_disabled, false)
),
hist AS (  -- every Page365 name this listing has had in the whole item history
  SELECT DISTINCT c.pid,
         lower(btrim(regexp_replace(
           CASE WHEN btrim(h.txt) = '' THEN '' ELSE regexp_replace(h.txt, ('^[\s' || chr(12288) || '' || chr(160) || ']*[^\s' || chr(12288) || '' || chr(160) || ']+'), 'CODE') END,
           ('[\s' || chr(12288) || '' || chr(160) || ']+'), ' ', 'g'))) AS norm_rest
    FROM cur c
    JOIN LATERAL (
      SELECT btrim(CASE WHEN count(*) OVER (PARTITION BY i2.inventory_product_id) > 1
                             AND btrim(coalesce(i2.variant_name, '')) ~ '\S\s+\S'
                        THEN i2.variant_name ELSE coalesce(i2.page365_name, p2.name, p2.list_name) END) AS txt
        FROM public.page365_inventory_items i2
        LEFT JOIN public.page365_inventory_products p2 ON p2.id = i2.inventory_product_id
       WHERE i2.kind = 'page365' AND i2.page365_product_id = c.ppid AND i2.page365_variant_id = c.pvid
    ) h ON true
)
-- B. NAME ACTIONS ------------------------------------------------------------
SELECT 'B names' AS section, c.sku,
       CASE
         WHEN upper((regexp_match(c.hub_name, ('^[\s' || chr(12288) || '' || chr(160) || ']*([^\s' || chr(12288) || '' || chr(160) || ']+)')))[1])
              IS DISTINCT FROM upper((regexp_match(c.p365_name, ('^[\s' || chr(12288) || '' || chr(160) || ']*([^\s' || chr(12288) || '' || chr(160) || ']+)')))[1]) THEN 'RECODE (next read)'
         WHEN EXISTS (SELECT 1 FROM hist h WHERE h.pid = c.pid
                       AND h.norm_rest = lower(btrim(regexp_replace(regexp_replace(c.hub_name, ('^[\s' || chr(12288) || '' || chr(160) || ']*[^\s' || chr(12288) || '' || chr(160) || ']+'), 'CODE'),
                                                                    ('[\s' || chr(12288) || '' || chr(160) || ']+'), ' ', 'g')))) THEN 'UPDATE (never completed)'
         ELSE 'KEEP (completed by staff)' END AS action,
       c.hub_name, c.p365_name
  FROM cur c
 WHERE lower(btrim(regexp_replace(c.hub_name, ('[\s' || chr(12288) || '' || chr(160) || ']+'), ' ', 'g')))
    <> lower(btrim(regexp_replace(c.p365_name, ('[\s' || chr(12288) || '' || chr(160) || ']+'), ' ', 'g')))
 ORDER BY 3, c.sku;

-- C. STRANDED CODES (linked product, listing now under another code) ----------
SELECT 'C stranded' AS section, wp.sku AS hub_sku, wp.status::text AS status, wp.page365_product_id, i.code AS page365_code,
       i.page365_name, i.page365_available
  FROM public.page365_inventory_items i
  JOIN public.website_products wp
    ON wp.page365_product_id = i.page365_product_id AND wp.page365_variant_id = i.page365_variant_id
 WHERE i.run_id = (SELECT id FROM public.page365_inventory_runs WHERE kind = 'full' AND status = 'ready' ORDER BY created_at DESC LIMIT 1)
   AND i.kind = 'page365' AND i.code IS NOT NULL AND NOT coalesce(wp.page365_sync_disabled, false)
   AND upper((regexp_match(wp.sku, ('^[\s' || chr(12288) || '' || chr(160) || ']*([^\s' || chr(12288) || '' || chr(160) || ']+)')))[1]) IS DISTINCT FROM i.code
 ORDER BY wp.sku;
