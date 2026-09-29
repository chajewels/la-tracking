-- ============================================================================
-- hero_picks (20261013100000) — READ-ONLY checks for the SQL Editor.
-- Nothing here writes. Every value printed is read from the LIVE database at
-- the moment you run it; nothing is a snapshot. Every column has its own name
-- (the SQL Editor collapses duplicate column names).
--
-- ORDER
--   1. scripts/function-drift-audit (without 20261010200000_ddl_audit_log.sql
--      and 20261013100000_hero_picks.sql) → 0 | 0 | 0
--   2. (P) below — BEFORE the migration. Run each (P.n) on its own.
--   3. supabase/migrations/20261013100000_hero_picks.sql, as-is
--   4. (1)–(9) below — AFTER the migration. Run each on its own.
-- ============================================================================


-- ============================================================================
-- (P) PREVIEW — BEFORE the migration. Changes nothing.
-- ============================================================================

-- (P.1) The switches as they are now.
--       Expect media_cutout_provider = replicate, hero_photo_source absent (no row).
SELECT key AS setting_key, value #>> '{}' AS setting_value
  FROM public.system_settings
 WHERE key IN ('media_cutout_provider','media_cutout_mode','hero_cutout_mode','hero_photo_source')
 ORDER BY key;

-- (P.2) md5 of the three live function bodies the migration patches.
--       The migration runs only if all three read "matches".
SELECT t.sig AS function_sig,
       md5(p.prosrc) AS live_md5,
       t.expected AS expected_md5,
       CASE WHEN md5(p.prosrc) = t.expected THEN 'matches' ELSE 'DIFFERS — stop, send pg_get_functiondef' END AS md5_verdict
  FROM (VALUES ('public.hero_cutouts_for_site(text[])',                 '93ec0c65ca843f7737b19123762f8589'),
               ('public.list_media_cutouts(text,text,integer,integer)', 'ec4f6921171743b8a57e52c2633eea5c'),
               ('public.get_media_cutout_tab_totals()',                 '8d6df689e92351bcb94b0aa791574dfb')) AS t(sig, expected)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
 ORDER BY t.sig;

-- (P.3) What the carry-over will tick: approved hero records, by outcome.
SELECT CASE WHEN c.source_url IS NULL THEN 'left out: no product cut-out for this photo'
            WHEN c.status = 'kept_original' THEN 'left out: kept original'
            WHEN c.status = 'rejected' THEN 'left out: product cut-out rejected'
            WHEN c.status NOT IN ('ok','auto_fixed','approved') THEN 'left out: product cut-out is ' || c.status
            WHEN c.cutout_path IS NULL OR c.cutout_w IS NULL OR c.cutout_h IS NULL THEN 'left out: no cut-out file'
            WHEN NOT public.media_cutout_url_published(h.source_url) THEN 'left out: product not published'
            ELSE 'CARRIES OVER' END AS carry_outcome,
       count(*) AS approved_hero_photos
  FROM public.website_hero_cutouts h
  LEFT JOIN public.website_media_cutouts c ON c.source_url = h.source_url
 WHERE h.status = 'approved'
 GROUP BY 1 ORDER BY 2 DESC;

-- (P.4) Published products with a variant in stock: on the hero after the
--       carry-over vs left out until a photo is ticked.
WITH carry AS (
  SELECT h.source_url FROM public.website_hero_cutouts h
    JOIN public.website_media_cutouts c ON c.source_url = h.source_url
   WHERE h.status = 'approved' AND c.status IN ('ok','auto_fixed','approved')
     AND c.cutout_path IS NOT NULL AND c.cutout_w IS NOT NULL AND c.cutout_h IS NOT NULL
     AND public.media_cutout_url_published(h.source_url)
), prod AS (
  SELECT p.id, EXISTS (SELECT 1 FROM public.website_product_variants v
                         JOIN public.website_product_media m ON m.variant_id = v.id
                        WHERE v.product_id = p.id AND m.url IN (SELECT source_url FROM carry)) AS on_hero
    FROM public.website_products p
   WHERE p.status::text = 'active'
     AND EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = p.id AND v.stock_qty > 0))
SELECT count(*) AS published_in_stock_products,
       count(*) FILTER (WHERE on_hero) AS on_hero_after_carry_over,
       count(*) FILTER (WHERE NOT on_hero) AS left_out_until_ticked
  FROM prod;

-- (P.5) What the website's hero reads today (hero_record), to compare with (6) after.
SELECT count(*) FILTER (WHERE status = 'approved') AS hero_record_approved,
       count(*) FILTER (WHERE status IN ('needs_review','failed')) AS hero_record_held,
       count(*) FILTER (WHERE status = 'rejected') AS hero_record_rejected,
       md5(string_agg(source_url || ':' || status || ':' || coalesce(cutout_path, ''), '|' ORDER BY source_url)) AS hero_record_fingerprint
  FROM public.website_hero_cutouts
 WHERE status IN ('approved','needs_review','failed','rejected');


-- ============================================================================
-- AFTER the migration. Each check prints LIVE values and says what to expect.
-- ============================================================================

-- (1) The switch is still hero_record — nothing on the website changed.
--     Expect: hero_record | hero_record | t
SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'hero_photo_source') AS stored_hero_photo_source,
       public.hero_photo_source() AS read_hero_photo_source,
       EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_hero_photo_source') AS switch_guarded;

-- (2) md5 of the patched bodies. Expect three rows reading "this migration".
SELECT t.sig AS patched_function,
       md5(p.prosrc) AS live_md5_now,
       CASE WHEN md5(p.prosrc) = t.mine THEN 'this migration' ELSE 'OTHER — stop' END AS body_is
  FROM (VALUES ('public.hero_cutouts_for_site(text[])',                 'c5d5edf56c8115469a586251d000f580'),
               ('public.list_media_cutouts(text,text,integer,integer)', 'a2a202b784e468aef9be533d3608c117'),
               ('public.get_media_cutout_tab_totals()',                 '7c7424236a6a867c209d26492f7b04c3')) AS t(sig, mine)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
 ORDER BY t.sig;

-- (3) No ticks yet (the carry-over is a Hub button, pressed later).
--     Expect: 0
SELECT count(*) AS hero_picks_rows FROM public.website_hero_picks;

-- (4) Browser roles cannot reach the ticks; the Hub RPCs are signed-in only;
--     the site function stays service-role only. Expect: f | f | t | t | t | f | t
SELECT has_table_privilege('anon', 'public.website_hero_picks', 'SELECT')                     AS anon_reads_picks,
       has_table_privilege('authenticated', 'public.website_hero_picks', 'INSERT')             AS auth_inserts_picks,
       has_function_privilege('authenticated', 'public.set_hero_pick(text,boolean)', 'EXECUTE') AS auth_set_pick,
       has_function_privilege('authenticated', 'public.hero_picks_carry_over(boolean)', 'EXECUTE') AS auth_carry_over,
       has_function_privilege('authenticated', 'public.set_hero_photo_source(text,text)', 'EXECUTE') AS auth_set_source,
       has_function_privilege('authenticated', 'public.hero_cutouts_for_site(text[])', 'EXECUTE') AS auth_site_fn,
       has_function_privilege('service_role', 'public.hero_cutouts_for_site(text[])', 'EXECUTE')  AS svc_site_fn;

-- (5) The three new triggers. Expect three rows:
--     trg_guard_hero_photo_source | system_settings
--     trg_guard_hero_picks_writes | website_hero_picks
--     trg_hero_pick_revalidate    | website_hero_picks
SELECT tgname AS trigger_name, tgrelid::regclass::text AS on_table
  FROM pg_trigger
 WHERE NOT tgisinternal AND tgname IN ('trg_guard_hero_photo_source','trg_guard_hero_picks_writes','trg_hero_pick_revalidate')
 ORDER BY tgname;

-- (6) The website's answer is unchanged: every hero-record photo, through the
--     patched site function, returns what the record says.
--     Expect: the same four numbers as (P.5), and rows_differing = 0.
WITH site AS (
  SELECT s.source_url, s.hero_cutout
    FROM public.hero_cutouts_for_site(ARRAY(SELECT source_url FROM public.website_hero_cutouts)) s
), rec AS (
  SELECT h.source_url,
         CASE WHEN h.status = 'approved' THEN jsonb_build_object('status','approved','path',h.cutout_path,'width',h.width,'height',h.height)
              WHEN h.status IN ('needs_review','failed') THEN jsonb_build_object('status','held')
              WHEN h.status = 'rejected' THEN jsonb_build_object('status','rejected') END AS hero_cutout
    FROM public.website_hero_cutouts h WHERE h.status IN ('approved','needs_review','failed','rejected')
)
SELECT (SELECT count(*) FROM site WHERE hero_cutout ->> 'status' = 'approved') AS site_approved,
       (SELECT count(*) FROM site WHERE hero_cutout ->> 'status' = 'held')     AS site_held,
       (SELECT count(*) FROM site WHERE hero_cutout ->> 'status' = 'rejected') AS site_rejected,
       (SELECT md5(string_agg(h.source_url || ':' || h.status || ':' || coalesce(h.cutout_path, ''), '|' ORDER BY h.source_url))
          FROM public.website_hero_cutouts h WHERE h.status IN ('approved','needs_review','failed','rejected')) AS record_fingerprint_now,
       (SELECT count(*) FROM ((SELECT * FROM site EXCEPT ALL SELECT * FROM rec) UNION ALL (SELECT * FROM rec EXCEPT ALL SELECT * FROM site)) d) AS rows_differing;

-- (7) The one rule, on live rows: how many product cut-outs could be ticked
--     now, and why the others cannot (published products only, as the Photos card).
SELECT coalesce(public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                        public.media_cutout_url_published(c.source_url)), 'USABLE — can be ticked') AS tick_rule,
       count(*) AS product_cutouts
  FROM public.website_media_cutouts c
 WHERE c.orphaned_at IS NULL AND public.media_cutout_url_published(c.source_url)
 GROUP BY 1 ORDER BY 2 DESC;

-- (8) The Hero tab's product counts as the Hub will show them (nothing ticked
--     yet). Expect products_on_hero = 0 and published_left_out = published_in_stock
--     = (P.4) published_in_stock_products.
SELECT (public.hero_product_counts(NULL) ->> 'published_in_stock')::int AS published_in_stock_now,
       (public.hero_product_counts(NULL) ->> 'products_on_hero')::int   AS products_on_hero_now,
       (public.hero_product_counts(NULL) ->> 'published_left_out')::int AS published_left_out_now;

-- (9) Nothing else moved: cut-out rows and hero records untouched, no audit
--     rows yet from the new functions. Expect: the row counts you know, and 0 | 0 | 0.
SELECT (SELECT count(*) FROM public.website_media_cutouts) AS media_cutout_rows,
       (SELECT count(*) FROM public.website_hero_cutouts)  AS hero_record_rows,
       (SELECT count(*) FROM public.audit_logs WHERE action LIKE 'set_hero_pick:%')     AS audit_ticks,
       (SELECT count(*) FROM public.audit_logs WHERE action = 'hero_picks_carry_over')  AS audit_carry_over,
       (SELECT count(*) FROM public.audit_logs WHERE action = 'set_hero_photo_source')  AS audit_switch;
