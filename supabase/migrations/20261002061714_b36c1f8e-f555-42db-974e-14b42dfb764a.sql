-- ===========================================================================
-- Media cut-outs: APPROVAL FIRST (owner decision 2026-10-02, 10:16 JST).
-- docs/MEDIA-CUTOUTS.md "Approval first"; CLAUDE.md "MEDIA CUT-OUTS".
--
-- Until now a cut-out that passed every quality check (status ok /
-- auto_fixed) counted as COMPLETED in Website → Photos and could be ticked
-- "Use on hero" without a staff decision ("many go straight to Completed
-- without approve" — owner, 2026-10-02 08:47 JST). From this file:
--
--   1. A cut-out may be SHOWN or TICKED FOR THE HERO only when a staff member
--      APPROVED it. hero_pick_reason answers not_approved for ok / auto_fixed
--      (every caller — set_hero_pick, hero_cutouts_for_site, hero_lineup_rows,
--      hero_product_counts, the Hero tab — reads that one function).
--   2. Website → Photos: ok / auto_fixed are "TO APPROVE" (new tab, replacing
--      the Auto-fixed tab); Completed = approved + kept original.
--
-- NOTHING ELSE CHANGES. Cut once stays: ok / auto_fixed are still locked
-- against another paid call (trg_guard_media_cutout_cut_once untouched);
-- Approve / Reject already work on them (review_media_cutout untouched); the
-- cap, Keep original, the publish gate and the worker are untouched.
--
-- LIVE DATA at the time of writing: 26 ok, 0 auto_fixed, 232 approved,
-- 67 kept_original, 2 needs_review, 20 rejected, 630 waiting. The 26 "ok"
-- photos move from Completed to To approve. The website does not change: the
-- API never sent product cut-outs (PR 2 was not built) and every one of the
-- 34 hero ticks is on an approved row (self-check below refuses otherwise).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md "Migrations baseline"): the
-- three bodies below are the live pg_get_functiondef text of 2026-10-02 with
-- the edits marked "-- 20261026100000"; the guard refuses if live has moved.
-- Drift audit before writing: a_differs / b_live_only / c_repo_only all 0.
-- ===========================================================================

SET LOCAL lock_timeout = '15s';

DO $$
BEGIN
  IF md5(pg_get_functiondef('public.hero_pick_reason(text,text,integer,integer,boolean)'::regprocedure)) <> 'f069c49d92244abc4afe09a4f4e050ec' THEN
    RAISE EXCEPTION 'approval-first refused: hero_pick_reason drifted from the body this migration patches.';
  END IF;
  IF md5(pg_get_functiondef('public.get_media_cutout_tab_totals()'::regprocedure)) <> 'd32f9c94eef698107144ca2232c33904' THEN
    RAISE EXCEPTION 'approval-first refused: get_media_cutout_tab_totals drifted from the body this migration patches.';
  END IF;
  IF md5(pg_get_functiondef('public.list_media_cutouts(text,text,integer,integer)'::regprocedure)) <> 'ec2e202c3883b87256bcd2758776cff6' THEN
    RAISE EXCEPTION 'approval-first refused: list_media_cutouts drifted from the body this migration patches.';
  END IF;
  -- Every hero tick must already be on an approved row, or the hero would change.
  IF EXISTS (SELECT 1 FROM public.website_hero_picks k
               JOIN public.website_media_cutouts c ON c.source_url = k.source_url
              WHERE c.status IN ('ok','auto_fixed')) THEN
    RAISE EXCEPTION 'approval-first refused: a hero tick sits on an unapproved cut-out — approve or untick it first.';
  END IF;
END $$;

-- ------------------------------------------------------------ 1. hero_pick_reason
CREATE OR REPLACE FUNCTION public.hero_pick_reason(p_status text, p_cutout_path text, p_cutout_w integer, p_cutout_h integer, p_published boolean)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_status IS NULL                                  THEN 'no_cutout'
    WHEN p_status = 'kept_original'                        THEN 'kept_original'
    WHEN p_status = 'rejected'                             THEN 'rejected'
    WHEN p_status IN ('ok','auto_fixed')                   THEN 'not_approved'   -- 20261026100000: approval first
    WHEN p_status <> 'approved'                            THEN 'not_completed'
    WHEN p_cutout_path IS NULL OR p_cutout_w IS NULL OR p_cutout_h IS NULL THEN 'no_cutout_file'
    WHEN NOT coalesce(p_published, false)                  THEN 'not_published'
  END
$function$;

COMMENT ON FUNCTION public.hero_pick_reason(text, text, integer, integer, boolean) IS
  'Why a product cut-out may NOT be on the hero: kept_original | rejected | not_approved (passed the checks, no staff Approve yet — 20261026100000, approval first) | not_completed | no_cutout_file | not_published (no_cutout = no cut-out row). NULL = usable, i.e. APPROVED by staff. docs/HERO-PICKS.md.';

-- ------------------------------------------------------------ 2. get_media_cutout_tab_totals
CREATE OR REPLACE FUNCTION public.get_media_cutout_tab_totals()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_price text := (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd');
  v_prov  text := (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_provider');
  v_tabs  jsonb;
  v_hero  jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  WITH a AS (
    SELECT status, job_state, hold_reason, test_batch, paid_calls,
           public.media_cutout_url_published(source_url) AS pub
      FROM public.website_media_cutouts WHERE orphaned_at IS NULL
  ), c AS (
    SELECT * FROM a WHERE pub
  )
  SELECT jsonb_build_object(
      'needs_review', jsonb_build_object('count', count(*) FILTER (WHERE status = 'needs_review'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'needs_review'), 0)),
      'needs_owner',  jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NOT NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NOT NULL), 0)),
      'failed',       jsonb_build_object('count', count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'failed' AND hold_reason IS NULL), 0)),
      -- 20261026100000: approval first — passed the checks, waiting for a staff Approve.
      'to_approve',   jsonb_build_object('count', count(*) FILTER (WHERE status IN ('ok','auto_fixed')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status IN ('ok','auto_fixed')), 0),
                                         'auto_fixed', count(*) FILTER (WHERE status = 'auto_fixed')),
      'queue',        jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')), 0)),
      'waiting',      (SELECT jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(paid_calls), 0))
                         FROM a WHERE job_state = 'waiting'),
      -- 20261026100000: Completed = a staff decision (approved) or kept original.
      'completed',    jsonb_build_object('count', count(*) FILTER (WHERE status IN ('approved','kept_original')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status IN ('approved','kept_original')), 0),
                                         'kept_original', count(*) FILTER (WHERE status = 'kept_original')),
      'rejected',     jsonb_build_object('count', count(*) FILTER (WHERE status = 'rejected'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'rejected'), 0)),
      'test',         jsonb_build_object('count', count(*) FILTER (WHERE test_batch IS NOT NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE test_batch IS NOT NULL), 0)),
      'all',          jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(paid_calls), 0)))
    INTO v_tabs
    FROM c;
  -- 20261013100000: the Hero tab — every ticked photo (also one that stopped
  -- being usable), how many are usable, and the products on / left off the hero.
  SELECT jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(c.paid_calls), 0),
                            'usable', count(*) FILTER (WHERE public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                                                                     public.media_cutout_url_published(c.source_url)) IS NULL))
         || public.hero_product_counts(NULL)
    INTO v_hero
    FROM public.website_hero_picks k
    JOIN public.website_media_cutouts c ON c.source_url = k.source_url
   WHERE c.orphaned_at IS NULL;
  RETURN jsonb_build_object(
    'tabs', v_tabs || jsonb_build_object('hero', v_hero),
    'is_admin', public.has_role(v_uid, 'admin'),
    'per_photo_limit', 2,
    'publish_gate', true,
    'published_only', true,
    'approval_first', true,
    'hero_photo_source', public.hero_photo_source(),
    'provider', CASE WHEN v_prov IN ('fal','replicate') THEN v_prov ELSE 'photoroom' END,
    'price_usd', CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END);
END
$function$;

-- ------------------------------------------------------------ 3. list_media_cutouts
CREATE OR REPLACE FUNCTION public.list_media_cutouts(p_filter text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_filter text := coalesce(p_filter, 'needs_review');
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_total  integer;
  v_rows   jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  -- 20261026100000: 'to_approve' added (approval first); 'auto_fixed' kept for old callers.
  IF v_filter NOT IN ('needs_review','needs_owner','failed','to_approve','auto_fixed','queue','waiting','completed','published',
                      'kept_original','rejected','all','test','hero') THEN
    RETURN jsonb_build_object('error', 'invalid_filter');
  END IF;

  WITH base AS (
    SELECT c.*,
           public.media_cutout_url_published(c.source_url) AS published,
           public.media_cutout_error_kind(NULL, c.last_error, c.result_url) AS error_kind,
           EXISTS (SELECT 1 FROM public.website_hero_picks k WHERE k.source_url = c.source_url) AS hero_pick,
           public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                   public.media_cutout_url_published(c.source_url)) AS hero_pick_blocker,
           (SELECT jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'slug', p.slug, 'status', p.status)
              FROM public.website_product_media m
              JOIN public.website_product_variants v ON v.id = m.variant_id
              JOIN public.website_products p ON p.id = v.product_id
             WHERE m.url = c.source_url
             ORDER BY p.status::text = 'active' DESC, p.sku LIMIT 1) AS product,
           (SELECT count(DISTINCT v.product_id)
              FROM public.website_product_media m
              JOIN public.website_product_variants v ON v.id = m.variant_id
             WHERE m.url = c.source_url) AS product_count
      FROM public.website_media_cutouts c
     WHERE c.orphaned_at IS NULL
  ), filtered AS (
    SELECT * FROM base
     WHERE (published OR v_filter IN ('waiting','hero'))
       AND CASE v_filter
             WHEN 'needs_review'  THEN status = 'needs_review'
             WHEN 'needs_owner'   THEN hold_reason IS NOT NULL
             WHEN 'failed'        THEN status = 'failed' AND hold_reason IS NULL
             WHEN 'to_approve'    THEN status IN ('ok','auto_fixed')          -- 20261026100000
             WHEN 'auto_fixed'    THEN status = 'auto_fixed'
             WHEN 'queue'         THEN hold_reason IS NULL
                                       AND (job_state IN ('submitted','ready','processing')
                                            OR (job_state = 'queued' AND published))
             WHEN 'waiting'       THEN job_state = 'waiting'
             WHEN 'completed'     THEN status IN ('approved','kept_original')  -- 20261026100000
             WHEN 'published'     THEN status IN ('approved','kept_original')  -- 20261026100000
             WHEN 'kept_original' THEN status = 'kept_original'
             WHEN 'rejected'      THEN status = 'rejected'
             WHEN 'test'          THEN test_batch IS NOT NULL
             WHEN 'hero'          THEN hero_pick
             ELSE true END
  ), hit AS (
    SELECT * FROM filtered
     WHERE v_q IS NULL
        OR (product ->> 'sku') ILIKE '%' || v_q || '%'
        OR (product ->> 'name') ILIKE '%' || v_q || '%'
        OR test_batch ILIKE '%' || v_q || '%'
  )
  SELECT (SELECT count(*) FROM hit),
         coalesce((SELECT jsonb_agg(to_jsonb(h) - 'provider_status_url' - 'provider_response_url'
                                    ORDER BY h.priority, h.updated_at DESC)
                     FROM (SELECT * FROM hit ORDER BY priority, updated_at DESC
                            LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
                           OFFSET greatest(coalesce(p_offset, 0), 0)) h), '[]'::jsonb)
    INTO v_total, v_rows;
  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$function$;

-- ------------------------------------------------------------ 4. the table's rule
COMMENT ON TABLE public.website_media_cutouts IS
  'Background-removed versions of website product photos (docs/MEDIA-CUTOUTS.md). ONE ROW PER SOURCE PHOTO URL — never per media row (the Catalog save re-inserts media rows). status = the verdict: pending | ok | auto_fixed | needs_review | approved | rejected | failed | kept_original. APPROVAL FIRST (20261026100000): ok / auto_fixed = passed the checks, waiting for a staff Approve; ONLY approved may ever be shown on the website or ticked for the hero. job_state = the machinery. Originals are never touched; files live under promotions/website/derived/. Written only by the media_cutout_* functions (service role) and review_media_cutout (staff).';

-- ------------------------------------------------------------ 5. self-check
DO $$
DECLARE v_bad int; v_usable int; v_ticks int;
BEGIN
  IF public.hero_pick_reason('ok', 'x', 1, 1, true) IS DISTINCT FROM 'not_approved'
     OR public.hero_pick_reason('auto_fixed', 'x', 1, 1, true) IS DISTINCT FROM 'not_approved'
     OR public.hero_pick_reason('approved', 'x', 1, 1, true) IS NOT NULL
     OR public.hero_pick_reason('needs_review', 'x', 1, 1, true) IS DISTINCT FROM 'not_completed'
     OR public.hero_pick_reason('approved', NULL, 1, 1, true) IS DISTINCT FROM 'no_cutout_file'
     OR public.hero_pick_reason('approved', 'x', 1, 1, false) IS DISTINCT FROM 'not_published' THEN
    RAISE EXCEPTION 'approval-first self-check failed: hero_pick_reason';
  END IF;
  -- Every tick stays usable exactly as before (all on approved rows).
  SELECT count(*), count(*) FILTER (WHERE public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                                                   public.media_cutout_url_published(c.source_url)) IS NULL)
    INTO v_ticks, v_usable
    FROM public.website_hero_picks k JOIN public.website_media_cutouts c ON c.source_url = k.source_url;
  SELECT count(*) INTO v_bad FROM public.website_hero_picks k JOIN public.website_media_cutouts c ON c.source_url = k.source_url
   WHERE c.status IN ('ok','auto_fixed');
  IF v_bad > 0 THEN RAISE EXCEPTION 'approval-first self-check failed: % ticks on unapproved rows', v_bad; END IF;
  RAISE NOTICE 'approval first: % hero ticks, % usable; to approve now: %',
    v_ticks, v_usable, (SELECT count(*) FROM public.website_media_cutouts WHERE status IN ('ok','auto_fixed') AND orphaned_at IS NULL);
END $$;