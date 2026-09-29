-- ===========================================================================
-- hero_order: the hero's pieces in the order they were TICKED (follow-up to
-- 20261013100000_hero_picks.sql). docs/HERO-PICKS.md "Running order".
--
-- OWNER REQUIREMENT (2026-09-29): publishing a product must never change the
-- hero by itself. Once system_settings.hero_photo_source = product_ticks:
--   1. The hero shows ONLY pieces with a ticked, usable "Use on hero" photo.
--   2. Per category slide: the ticked pieces in the ORDER THEY WERE TICKED
--      (website_hero_picks.picked_at, oldest first), up to 3. Extra ticks wait
--      their turn; they do not push others off.
--   3. A ticked piece that sells or is unpublished drops out; the next ticked
--      piece of that category takes its place. Never a fallback to untagged
--      pieces.
--   4. The Hub Hero tab shows, per category, which ticked pieces are ON the
--      hero now and which are WAITING.
--
-- OWNER DECISIONS (2026-09-29):
--   a. A piece with several ticked photos takes its place from its EARLIEST
--      photo that is still usable.
--   b. Untick then tick again = back of the queue (a new picked_at).
--   c. Carry-over ticks share one picked_at; ties are broken by the category's
--      current Hub order (website_category_products.sort_order, then the
--      product name) — the order GET /catalog/categories/:slug returns.
--   d. A sold piece back in stock keeps its original place.
--
-- NOTHING ON THE LIVE WEBSITE CHANGES WITH THIS FILE. The switch stays on
-- "hero_record" (it is never touched here); on hero_record the site function
-- returns exactly what it returns today (self-check below). The storefront
-- only reads the new picked_at after PR 3 (edge) and PR 4 (storefront).
--
-- What it does:
--
--   A. hero_lineup_rows(p_extra) — THE RUNNING ORDER, one row per (published
--      category, ticked product): place (1..n among the pieces that can show),
--      state on_hero (place <= 3) | waiting (place > 3) | not_showing, and for
--      not_showing the reason: not_published | cutout_not_usable | sold |
--      no_category (in no published category; category_id NULL). p_extra =
--      photos treated as ticked NOW (the carry-over preview). Service role
--      only (PR 3 may read it); the Hub reads it through get_hero_lineup.
--
--   B. hero_product_counts (patched from 20261013100000): products_on_hero now
--      counts the pieces actually ON a slide (at most 3 per category) and a
--      new hero_waiting counts ticked pieces in stock waiting their turn.
--      published_left_out = published in-stock products on no slide (waiting
--      ones included). get_media_cutout_tab_totals and the carry-over preview
--      read it, so both become true without being redefined.
--
--   C. hero_cutouts_for_site (patched from 20261013100000): on product_ticks
--      each ticked, usable photo also carries picked_at, so the storefront can
--      order a slide's pieces (earliest usable ticked photo, oldest first,
--      ties in the Hub's order). On hero_record: unchanged.
--
--   D. get_hero_lineup() — the Hub Hero tab's per-category view
--      (manage_website_catalog, like the Photos lists; read-only).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). The two redefined
-- functions are md5-checked (md5 of prosrc) against the bodies of
-- 20261013100000_hero_picks.sql, which is applied AS-IS on live. Any
-- difference aborts with NOTHING changed — stop and send the live
-- pg_get_functiondef. Re-running this file is safe (the second run accepts
-- this file's own bodies).
--
-- OWNER RUNS THIS in the SQL Editor, as-is, AFTER 20261013100000 is applied
-- and after scripts/function-drift-audit shows 0 | 0 | 0 (excluding
-- 20261010200000_ddl_audit_log.sql and this file). One transaction. Writes no
-- row anywhere; calls nothing; schedules nothing.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5   text;
  v_fresh boolean;
  v_got   text;
  f       record;
BEGIN
  IF to_regclass('public.website_hero_picks') IS NULL
     OR to_regprocedure('public.hero_photo_source()') IS NULL
     OR to_regprocedure('public.hero_pick_reason(text,text,integer,integer,boolean)') IS NULL THEN
    RAISE EXCEPTION 'hero_order: run 20261013100000_hero_picks.sql first';
  END IF;
  SELECT string_agg(t.tbl || '.' || t.col, ', ') INTO v_got
    FROM (VALUES ('website_categories','published'), ('website_categories','sort_order'),
                 ('website_categories','slug'), ('website_categories','name'),
                 ('website_category_products','category_id'), ('website_category_products','product_id'),
                 ('website_category_products','sort_order'),
                 ('website_products','status'), ('website_products','name'), ('website_products','sku'),
                 ('website_products','slug'), ('website_product_variants','stock_qty')) AS t(tbl, col)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns c
                      WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = t.col);
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'hero_order: column(s) missing: %', v_got;
  END IF;
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'hero_lineup_rows' AND pg_get_function_identity_arguments(p.oid) <> 'p_extra text[]')
       OR (p.proname = 'get_hero_lineup'  AND pg_get_function_identity_arguments(p.oid) <> ''));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'hero_order: function(s) already exist with another signature: %', v_got;
  END IF;

  v_fresh := to_regprocedure('public.hero_lineup_rows(text[])') IS NULL;
  FOR f IN SELECT * FROM (VALUES
      -- live_md5 = the 20261013100000 body; this_md5 = this file's body (re-run).
      ('public.hero_cutouts_for_site(text[])', 'c5d5edf56c8115469a586251d000f580', 'cff7614a4d0f0c211ed773b232a3b53b'),
      ('public.hero_product_counts(text[])',   'a8058344a9a46bdbf0fdc4fd49c85e9f', '9d3fc77467b8695bc84dc65ab6f636dc')
    ) AS t(sig, live_md5, this_md5)
  LOOP
    IF to_regprocedure(f.sig) IS NULL THEN
      RAISE EXCEPTION 'hero_order: % is missing', f.sig;
    END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF v_md5 IS DISTINCT FROM (CASE WHEN v_fresh THEN f.live_md5 ELSE f.this_md5 END) THEN
      RAISE EXCEPTION 'hero_order: live % differs from the repo (md5 %) — stop and send its pg_get_functiondef', f.sig, v_md5;
    END IF;
  END LOOP;

  PERFORM set_config('hero_order.source_before', public.hero_photo_source(), true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- A. The running order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_lineup_rows(p_extra text[] DEFAULT NULL)
RETURNS TABLE (category_id uuid, product_id uuid, first_picked_at timestamptz, place integer, state text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH ticks AS (
    SELECT k.source_url, k.picked_at FROM public.website_hero_picks k
    UNION ALL
    -- Carry-over preview: photos it would tick, ticked "now" (after every real tick).
    SELECT e.u, now() FROM unnest(coalesce(p_extra, '{}'::text[])) AS e(u)
     WHERE NOT EXISTS (SELECT 1 FROM public.website_hero_picks k WHERE k.source_url = e.u)
  ), photo AS (
    SELECT DISTINCT v.product_id, t.source_url, t.picked_at,
           public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h, true) IS NULL AS usable
      FROM ticks t
      JOIN public.website_media_cutouts c ON c.source_url = t.source_url
      JOIN public.website_product_media m ON m.url = t.source_url
      JOIN public.website_product_variants v ON v.id = m.variant_id
  ), prod AS (
    -- Owner decision a: the piece's place = its EARLIEST photo that is still usable.
    SELECT ph.product_id,
           min(ph.picked_at) FILTER (WHERE ph.usable) AS usable_from,
           min(ph.picked_at) AS ticked_from
      FROM photo ph
     GROUP BY ph.product_id
  ), judged AS (
    SELECT pr.product_id, coalesce(pr.usable_from, pr.ticked_from) AS first_picked_at, p.name AS pname,
           CASE WHEN p.status::text <> 'active' THEN 'not_published'
                WHEN pr.usable_from IS NULL THEN 'cutout_not_usable'
                -- Owner decision d: sold = no variant in stock now; back in stock keeps picked_at.
                WHEN NOT EXISTS (SELECT 1 FROM public.website_product_variants v
                                  WHERE v.product_id = p.id AND v.stock_qty > 0) THEN 'sold'
           END AS reason
      FROM prod pr
      JOIN public.website_products p ON p.id = pr.product_id
  ), member AS (
    SELECT cp.category_id, cp.product_id, min(cp.sort_order) AS sort_order
      FROM public.website_category_products cp
      JOIN public.website_categories cat ON cat.id = cp.category_id AND cat.published
     GROUP BY cp.category_id, cp.product_id
  ), placed AS (
    SELECT m.category_id, j.product_id, j.first_picked_at, j.reason,
           CASE WHEN j.reason IS NULL THEN
             -- Oldest tick first; ties (the carry-over) in the Hub's category order.
             row_number() OVER (PARTITION BY m.category_id, (j.reason IS NULL)
                                ORDER BY j.first_picked_at, m.sort_order, j.pname, j.product_id)
           END AS place
      FROM judged j
      JOIN member m ON m.product_id = j.product_id
  )
  SELECT pl.category_id, pl.product_id, pl.first_picked_at, pl.place::integer,
         CASE WHEN pl.reason IS NOT NULL THEN 'not_showing'
              WHEN pl.place <= 3 THEN 'on_hero'
              ELSE 'waiting' END,
         pl.reason
    FROM placed pl
  UNION ALL
  SELECT NULL::uuid, j.product_id, j.first_picked_at, NULL::integer, 'not_showing', 'no_category'
    FROM judged j
   WHERE NOT EXISTS (SELECT 1 FROM member m WHERE m.product_id = j.product_id)
$fn$;
REVOKE ALL ON FUNCTION public.hero_lineup_rows(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_lineup_rows(text[]) TO service_role;
COMMENT ON FUNCTION public.hero_lineup_rows(text[]) IS
  'The hero running order (owner 2026-09-29): per published category, every product with a ticked photo — place among the pieces that can show (published, a usable ticked photo, a variant in stock), ordered by the EARLIEST usable ticked photo (picked_at, oldest first), ties by website_category_products.sort_order then name; state on_hero (place <= 3) | waiting | not_showing (reason not_published | cutout_not_usable | sold | no_category). p_extra = photos treated as ticked now (carry-over preview). Service role only. 20261016100000, docs/HERO-PICKS.md.';

-- ---------------------------------------------------------------------------
-- B. True counts (patched from 20261013100000; same signature, same keys plus
--    hero_waiting).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_product_counts(p_extra text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH lineup AS (
    SELECT l.product_id, l.state FROM public.hero_lineup_rows(p_extra) l
  ), prod AS (
    SELECT p.id,
           EXISTS (SELECT 1 FROM lineup l WHERE l.product_id = p.id AND l.state = 'on_hero') AS on_hero,
           EXISTS (SELECT 1 FROM lineup l WHERE l.product_id = p.id AND l.state = 'waiting') AS waiting
      FROM public.website_products p
     WHERE p.status::text = 'active'
       AND EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = p.id AND v.stock_qty > 0)
  )
  SELECT jsonb_build_object('published_in_stock', count(*),
                            'products_on_hero', count(*) FILTER (WHERE on_hero),
                            'hero_waiting', count(*) FILTER (WHERE waiting AND NOT on_hero),
                            'published_left_out', count(*) FILTER (WHERE NOT on_hero))
    FROM prod
$fn$;
REVOKE ALL ON FUNCTION public.hero_product_counts(text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- C. picked_at on the website (patched from 20261013100000). The hero_record
--    branch is byte-for-byte the 20261013100000 one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_cutouts_for_site(p_urls text[])
RETURNS TABLE (source_url text, hero_cutout jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT h.source_url,
         CASE WHEN h.status = 'approved' THEN jsonb_build_object('status','approved','path',h.cutout_path,'width',h.width,'height',h.height)
              WHEN h.status IN ('needs_review','failed') THEN jsonb_build_object('status','held')
              WHEN h.status = 'rejected' THEN jsonb_build_object('status','rejected') END
    FROM public.website_hero_cutouts h
   WHERE h.source_url = ANY (p_urls)
     AND h.status IN ('approved','needs_review','failed','rejected')
     AND public.hero_photo_source() = 'hero_record'
  UNION ALL
  -- 20261013100000: ticked, usable product cut-outs (switch on "product_ticks").
  -- 20261016100000: + picked_at, the tick time the hero orders pieces by.
  SELECT c.source_url,
         jsonb_build_object('status','approved','path',c.cutout_path,'width',c.cutout_w,'height',c.cutout_h,
                            'picked_at',k.picked_at)
    FROM public.website_hero_picks k
    JOIN public.website_media_cutouts c ON c.source_url = k.source_url
   WHERE k.source_url = ANY (p_urls)
     AND public.hero_photo_source() = 'product_ticks'
     AND public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                 public.media_cutout_url_published(c.source_url)) IS NULL
$fn$;
REVOKE ALL ON FUNCTION public.hero_cutouts_for_site(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_cutouts_for_site(text[]) TO service_role;
COMMENT ON FUNCTION public.hero_cutouts_for_site(text[]) IS
  'For the website edge function. hero_photo_source = hero_record (default): per photo, approved → {status:approved, path, width, height}; needs_review|failed → {status:held}; rejected → {status:rejected}; ok|auto_fixed and no record → no row. hero_photo_source = product_ticks: ticked, usable product cut-outs (website_hero_picks, hero_pick_reason) → {status:approved, path, width, height, picked_at}; every other photo → no row. The hero orders a slide''s pieces by the earliest picked_at of their photos, oldest first (20261016100000). A file is never returned unless approved / usable. 20261013100000 + 20261016100000.';

-- ---------------------------------------------------------------------------
-- D. The Hub Hero tab, per category (read-only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_hero_lineup()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  WITH l AS (
    SELECT * FROM public.hero_lineup_rows(NULL)
  ), piece AS (
    SELECT l.category_id, l.place, l.state, l.reason, l.first_picked_at,
           jsonb_build_object(
             'product_id', p.id, 'sku', p.sku, 'name', p.name, 'slug', p.slug,
             'place', l.place, 'state', l.state, 'reason', l.reason, 'first_picked_at', l.first_picked_at,
             -- The photo the place comes from: earliest usable tick, else earliest tick.
             'photo', (SELECT jsonb_build_object('source_url', c.source_url,
                                                 'thumb_path', coalesce(c.catalog_small_path, c.cutout_path))
                         FROM public.website_hero_picks k
                         JOIN public.website_media_cutouts c ON c.source_url = k.source_url
                         JOIN public.website_product_media m ON m.url = k.source_url
                         JOIN public.website_product_variants v ON v.id = m.variant_id
                        WHERE v.product_id = p.id
                        ORDER BY public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h, true) IS NULL DESC,
                                 k.picked_at, k.source_url
                        LIMIT 1)) AS j
      FROM l
      JOIN public.website_products p ON p.id = l.product_id
  )
  SELECT jsonb_build_object(
      'hero_photo_source', public.hero_photo_source(),
      'slide_limit', 3,
      'categories', coalesce((
         SELECT jsonb_agg(jsonb_build_object(
                  'id', cat.id, 'slug', cat.slug, 'name', cat.name,
                  'on_hero', coalesce((SELECT jsonb_agg(pc.j ORDER BY pc.place) FROM piece pc
                                        WHERE pc.category_id = cat.id AND pc.state = 'on_hero'), '[]'::jsonb),
                  'waiting', coalesce((SELECT jsonb_agg(pc.j ORDER BY pc.place) FROM piece pc
                                        WHERE pc.category_id = cat.id AND pc.state = 'waiting'), '[]'::jsonb),
                  'not_showing', coalesce((SELECT jsonb_agg(pc.j ORDER BY pc.first_picked_at, pc.j ->> 'sku') FROM piece pc
                                            WHERE pc.category_id = cat.id AND pc.state = 'not_showing'), '[]'::jsonb))
                ORDER BY cat.sort_order, cat.name)
           FROM public.website_categories cat
          WHERE cat.published), '[]'::jsonb),
      'no_category', coalesce((SELECT jsonb_agg(pc.j ORDER BY pc.first_picked_at, pc.j ->> 'sku') FROM piece pc
                                WHERE pc.category_id IS NULL), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.get_hero_lineup() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_hero_lineup() TO authenticated;
COMMENT ON FUNCTION public.get_hero_lineup() IS
  'Hub Website → Photos → Hero: per published category (Hub order), the ticked pieces ON the hero now (at most 3, in tick order), WAITING their turn, and NOT SHOWING with the reason (hero_lineup_rows); plus ticked pieces in no published category. manage_website_catalog. Read-only. 20261016100000.';

-- ---------------------------------------------------------------------------
-- E. Self-check, inside the transaction. Aborts everything if not as written.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  IF public.hero_photo_source() IS DISTINCT FROM current_setting('hero_order.source_before', true) THEN
    RAISE EXCEPTION 'hero_order self-check: the switch changed';
  END IF;
  -- On hero_record the site function returns exactly today's rows.
  IF public.hero_photo_source() = 'hero_record' AND EXISTS (
       (SELECT s.source_url, s.hero_cutout FROM public.hero_cutouts_for_site(ARRAY(SELECT source_url FROM public.website_hero_cutouts)) s
        EXCEPT ALL
        SELECT h.source_url,
               CASE WHEN h.status = 'approved' THEN jsonb_build_object('status','approved','path',h.cutout_path,'width',h.width,'height',h.height)
                    WHEN h.status IN ('needs_review','failed') THEN jsonb_build_object('status','held')
                    WHEN h.status = 'rejected' THEN jsonb_build_object('status','rejected') END
          FROM public.website_hero_cutouts h WHERE h.status IN ('approved','needs_review','failed','rejected'))
       UNION ALL
       (SELECT h.source_url,
               CASE WHEN h.status = 'approved' THEN jsonb_build_object('status','approved','path',h.cutout_path,'width',h.width,'height',h.height)
                    WHEN h.status IN ('needs_review','failed') THEN jsonb_build_object('status','held')
                    WHEN h.status = 'rejected' THEN jsonb_build_object('status','rejected') END
          FROM public.website_hero_cutouts h WHERE h.status IN ('approved','needs_review','failed','rejected')
        EXCEPT ALL
        SELECT s.source_url, s.hero_cutout FROM public.hero_cutouts_for_site(ARRAY(SELECT source_url FROM public.website_hero_cutouts)) s)) THEN
    RAISE EXCEPTION 'hero_order self-check: hero_cutouts_for_site no longer returns today''s rows on hero_record';
  END IF;
  -- The lineup never puts more than 3 on a slide, and places are 1..n per category.
  IF EXISTS (SELECT 1 FROM public.hero_lineup_rows(NULL) GROUP BY category_id
              HAVING count(*) FILTER (WHERE state = 'on_hero') > 3
                  OR count(*) FILTER (WHERE place IS NOT NULL) <> coalesce(max(place), 0)) THEN
    RAISE EXCEPTION 'hero_order self-check: the running order is wrong';
  END IF;
  IF (public.hero_product_counts(NULL) ? 'hero_waiting') IS NOT TRUE THEN
    RAISE EXCEPTION 'hero_order self-check: hero_product_counts has no hero_waiting';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.hero_cutouts_for_site(text[])', 'public.hero_lineup_rows(text[])'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'hero_order self-check: service-only grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.hero_product_counts(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'hero_order self-check: hero_product_counts is reachable from the browser';
  END IF;
  IF has_function_privilege('anon', 'public.get_hero_lineup()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_hero_lineup()', 'EXECUTE') THEN
    RAISE EXCEPTION 'hero_order self-check: get_hero_lineup grants are wrong';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only, LIVE values): docs/sql/20261016_hero_order_verify.sql
-- Run its (P) preview BEFORE this file and its numbered checks AFTER it.
-- ===========================================================================
