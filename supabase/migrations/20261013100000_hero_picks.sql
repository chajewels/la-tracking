-- ===========================================================================
-- hero_picks — the HERO shows product cut-outs the owner TICKED (PR 1 of the
-- hero-picks plan, owner-approved 2026-09-28). docs/HERO-PICKS.md.
--
-- OWNER RULES (2026-09-28):
--   * The storefront hero will show only product cut-outs (website_media_cutouts,
--     today Replicate men1scus/birefnet) that an ADMIN ticked "Use on hero".
--   * A photo can be ticked only when its cut-out is usable: Completed and
--     shown on the website (ok / auto_fixed / approved — never kept original
--     or rejected), with a file, and its product published.
--   * The category banner and the menu thumbnails follow the same rule
--     (storefront, PR 4).
--   * NOTHING ON THE LIVE WEBSITE CHANGES WITH THIS FILE. The new switch
--     system_settings.hero_photo_source is seeded "hero_record" (today's
--     behaviour: the approved hero record, website_hero_cutouts) and is flipped
--     to "product_ticks" only by the owner, from the Hub, after PR 3 (edge) is
--     deployed. hero_usable stays unused.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main and
-- after scripts/function-drift-audit shows 0 | 0 | 0 (excluding
-- 20261010200000_ddl_audit_log.sql and this file). One transaction. Calls no
-- provider, schedules nothing, changes no row of website_media_cutouts or
-- website_hero_cutouts.
--
-- What it does:
--
--   A. website_hero_picks — ONE ROW PER TICKED PHOTO, keyed on source_url (the
--      cut-out's own key; the Catalog save re-inserts media rows, the URL
--      survives). References website_media_cutouts and goes with it. No
--      browser role can read or write it; it is written ONLY by set_hero_pick
--      and hero_picks_carry_over (guard trigger).
--
--   B. THE SWITCH, system_settings.hero_photo_source:
--        "hero_record"    the hero record decides (seeded; today)
--        "product_ticks"  ticked, usable product cut-outs decide
--      Anything else reads "hero_record" (fails safe). Changed ONLY through
--      set_hero_photo_source (ADMIN role, audited, revalidates the website);
--      trg_guard_hero_photo_source refuses every other write.
--
--   C. hero_pick_reason(status, path, w, h, published) — ONE rule for "usable
--      on the hero": NULL = usable, else kept_original | rejected |
--      not_completed | no_cutout_file | not_published (no_cutout when there is
--      no cut-out row). Used by the tick, the carry-over, the site function
--      and the lists.
--
--   D. set_hero_pick(url, pick) — ADMIN ROLE ONLY (by role, like
--      review_hero_cutout). Ticking an unusable photo is refused with the
--      reason; unticking is always allowed. One audit_logs row per change
--      (website_media_cutout / set_hero_pick:tick|untick).
--
--   E. hero_picks_carry_over(apply) — ADMIN ROLE ONLY. Preview (apply false):
--      how many approved hero records carry over (same source_url, usable
--      product cut-out), which are left out and why, and how many published
--      in-stock products would then be on the hero. Apply: ticks them, once —
--      pressing it twice adds nothing (ON CONFLICT DO NOTHING, serialised).
--      One audit_logs row per apply that ticked anything.
--
--   F. trg_hero_pick_revalidate — a tick or untick revalidates the storefront,
--      but only while the switch is on "product_ticks" (on "hero_record" the
--      website cannot see ticks, so nothing is sent).
--
--   G. hero_cutouts_for_site (patched from LIVE): on "hero_record" it returns
--      exactly what it returns today; on "product_ticks" it returns
--      {status:approved, path, width, height} for ticked, usable photos only
--      and nothing for any other photo.
--
--   H. list_media_cutouts / get_media_cutout_tab_totals (patched from LIVE):
--      each row gains hero_pick and hero_pick_blocker; a new "hero" filter
--      lists the ticked photos (also those that stopped being usable, so they
--      can be unticked); the totals gain the Hero tab — ticked photos, usable
--      ones, products on the hero, published in-stock products left out — and
--      the switch value.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). The three functions
-- redefined here are md5-checked (md5 of prosrc) against the bodies of
-- 20261009100000_hero_cutouts.sql (hero_cutouts_for_site) and
-- 20261012100000_media_cutouts_provider_errors.sql (the two lists). Any
-- difference aborts with NOTHING changed — stop and send the live
-- pg_get_functiondef. Re-running the file is safe (the second run accepts this
-- file's own bodies; the switch value and the ticks are never overwritten).
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
  IF to_regclass('public.website_media_cutouts') IS NULL
     OR to_regclass('public.website_hero_cutouts') IS NULL
     OR to_regclass('public.system_settings') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'hero_picks: a table is missing — run 20261009100000_hero_cutouts.sql and the media-cutouts migrations first';
  END IF;
  IF to_regprocedure('public.media_cutout_url_published(text)') IS NULL
     OR to_regprocedure('public.media_cutout_error_kind(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'hero_picks: run 20261012100000_media_cutouts_provider_errors.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'website_product_variants' AND column_name = 'stock_qty') THEN
    RAISE EXCEPTION 'hero_picks: website_product_variants.stock_qty missing';
  END IF;
  IF to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL
     OR to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'hero_picks: has_role / has_permission missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
    RAISE EXCEPTION 'hero_picks: net.http_post (pg_net) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'hero_picks: Vault secret email_queue_service_role_key missing — do not create a second key';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'hero_photo_source'
              AND coalesce(value #>> '{}', '') NOT IN ('hero_record','product_ticks')) THEN
    RAISE EXCEPTION 'hero_picks: system_settings.hero_photo_source exists but is not hero_record/product_ticks';
  END IF;
  IF to_regclass('public.website_hero_picks') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'website_hero_picks' AND column_name = 'picked_via') THEN
    RAISE EXCEPTION 'hero_picks: public.website_hero_picks exists with another shape';
  END IF;
  -- New names that already exist with another signature.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'hero_photo_source'              AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'hero_pick_reason'               AND pg_get_function_identity_arguments(p.oid) <> 'p_status text, p_cutout_path text, p_cutout_w integer, p_cutout_h integer, p_published boolean')
       OR (p.proname = 'hero_product_counts'            AND pg_get_function_identity_arguments(p.oid) <> 'p_extra text[]')
       OR (p.proname = 'guard_hero_picks_writes'        AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'guard_hero_photo_source'        AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'notify_hero_pick_revalidate'    AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'set_hero_pick'                  AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_pick boolean')
       OR (p.proname = 'hero_picks_carry_over'          AND pg_get_function_identity_arguments(p.oid) <> 'p_apply boolean')
       OR (p.proname = 'set_hero_photo_source'          AND pg_get_function_identity_arguments(p.oid) <> 'p_source text, p_expected_source text'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'hero_picks: function(s) already exist with another signature: %', v_got;
  END IF;

  v_fresh := to_regclass('public.website_hero_picks') IS NULL;
  FOR f IN SELECT * FROM (VALUES
      ('public.hero_cutouts_for_site(text[])',                 '93ec0c65ca843f7737b19123762f8589', 'c5d5edf56c8115469a586251d000f580'),
      ('public.list_media_cutouts(text,text,integer,integer)', 'ec4f6921171743b8a57e52c2633eea5c', 'a2a202b784e468aef9be533d3608c117'),
      ('public.get_media_cutout_tab_totals()',                 '8d6df689e92351bcb94b0aa791574dfb', '7c7424236a6a867c209d26492f7b04c3')
    ) AS t(sig, live_md5, this_md5)
  LOOP
    IF to_regprocedure(f.sig) IS NULL THEN
      RAISE EXCEPTION 'hero_picks: % is missing', f.sig;
    END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF v_md5 IS DISTINCT FROM (CASE WHEN v_fresh THEN f.live_md5 ELSE f.this_md5 END) THEN
      RAISE EXCEPTION 'hero_picks: live % differs from the repo (md5 %) — stop and send its pg_get_functiondef', f.sig, v_md5;
    END IF;
  END LOOP;

  PERFORM set_config('hero_picks.source_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'hero_photo_source'), 'absent'), true);
  PERFORM set_config('hero_picks.site_before',
                     (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.hero_cutouts_for_site(text[])')), true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The ticks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.website_hero_picks (
  source_url  text PRIMARY KEY REFERENCES public.website_media_cutouts (source_url) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  picked_via  text NOT NULL CHECK (picked_via IN ('tick','carry_over')),
  picked_by   uuid,
  picked_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.website_hero_picks IS
  'Product cut-outs (website_media_cutouts) the owner ticked "Use on hero". ONE ROW PER TICKED PHOTO (source_url). The storefront hero uses them only while system_settings.hero_photo_source = product_ticks, and only while the cut-out is usable (hero_pick_reason). Written ONLY by set_hero_pick and hero_picks_carry_over (admin, audited). docs/HERO-PICKS.md.';

ALTER TABLE public.website_hero_picks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_hero_picks FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.website_hero_picks TO service_role;

-- Even the service role writes only through the two functions. The one other
-- path is the cascade when a cut-out row itself is deleted (nested trigger).
CREATE OR REPLACE FUNCTION public.guard_hero_picks_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;  -- ON DELETE CASCADE from website_media_cutouts
  END IF;
  IF coalesce(current_setting('app.hero_pick_writer', true), '') NOT IN ('pick','carry_over') THEN
    RAISE EXCEPTION 'website_hero_picks is written only from the Hub (set_hero_pick, hero_picks_carry_over).'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_hero_picks_writes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_hero_picks_writes ON public.website_hero_picks;
CREATE TRIGGER trg_guard_hero_picks_writes
BEFORE INSERT OR UPDATE OR DELETE ON public.website_hero_picks
FOR EACH ROW EXECUTE FUNCTION public.guard_hero_picks_writes();

-- ---------------------------------------------------------------------------
-- 2. The switch. Seeded "hero_record" (today's behaviour); never overwritten.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('hero_photo_source', '"hero_record"'::jsonb,
        'Where the website hero gets its cut-outs: "hero_record" = the approved hero record (website_hero_cutouts, the storefront workflow); "product_ticks" = product cut-outs an admin ticked "Use on hero" (website_hero_picks). Anything else reads "hero_record". Changed only from Hub → Website → Photos → Hero (set_hero_photo_source; admin; audited).')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_hero_photo_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key = 'hero_photo_source'
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key = 'hero_photo_source' AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_hero_photo_source_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'The hero photo source is switched only from the Hub: Website → Photos → Hero (set_hero_photo_source).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_hero_photo_source() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_hero_photo_source ON public.system_settings;
CREATE TRIGGER trg_guard_hero_photo_source
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_hero_photo_source();

-- Fail-safe reader: anything but "product_ticks" is "hero_record".
CREATE OR REPLACE FUNCTION public.hero_photo_source()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'hero_photo_source') = 'product_ticks'
              THEN 'product_ticks' ELSE 'hero_record' END
$fn$;
REVOKE ALL ON FUNCTION public.hero_photo_source() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_photo_source() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The one rule: may this cut-out be on the hero? NULL = yes.
--    Usable = Completed and shown on the website (ok / auto_fixed / approved),
--    a file with its size, and the product published.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_pick_reason(p_status text, p_cutout_path text, p_cutout_w integer,
                                                   p_cutout_h integer, p_published boolean)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_status IS NULL                                  THEN 'no_cutout'
    WHEN p_status = 'kept_original'                        THEN 'kept_original'
    WHEN p_status = 'rejected'                             THEN 'rejected'
    WHEN p_status NOT IN ('ok','auto_fixed','approved')    THEN 'not_completed'
    WHEN p_cutout_path IS NULL OR p_cutout_w IS NULL OR p_cutout_h IS NULL THEN 'no_cutout_file'
    WHEN NOT coalesce(p_published, false)                  THEN 'not_published'
  END
$fn$;
COMMENT ON FUNCTION public.hero_pick_reason(text, text, integer, integer, boolean) IS
  'Why a product cut-out may NOT be on the hero: kept_original | rejected | not_completed | no_cutout_file | not_published (no_cutout = no cut-out row). NULL = usable. 20261013100000, docs/HERO-PICKS.md.';

-- Published products with a variant in stock (the pieces the hero can show),
-- how many have at least one usable ticked photo (plus p_extra photos, for the
-- carry-over preview), and how many are left out.
CREATE OR REPLACE FUNCTION public.hero_product_counts(p_extra text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH usable AS (
    SELECT k.source_url
      FROM public.website_hero_picks k
      JOIN public.website_media_cutouts c ON c.source_url = k.source_url
     WHERE public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h, true) IS NULL
    UNION
    SELECT unnest(coalesce(p_extra, '{}'::text[]))
  ), prod AS (
    SELECT p.id,
           EXISTS (SELECT 1 FROM public.website_product_variants v
                     JOIN public.website_product_media m ON m.variant_id = v.id
                    WHERE v.product_id = p.id AND m.url IN (SELECT source_url FROM usable)) AS on_hero
      FROM public.website_products p
     WHERE p.status::text = 'active'
       AND EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = p.id AND v.stock_qty > 0)
  )
  SELECT jsonb_build_object('published_in_stock', count(*),
                            'products_on_hero', count(*) FILTER (WHERE on_hero),
                            'published_left_out', count(*) FILTER (WHERE NOT on_hero))
    FROM prod
$fn$;
REVOKE ALL ON FUNCTION public.hero_product_counts(text[]) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Revalidate the storefront when a tick changes — only when the website
--    reads ticks. One call per statement (the storefront refreshes "/" and the
--    catalog tag on every call).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_hero_pick_revalidate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_key text;
BEGIN
  IF public.hero_photo_source() <> 'product_ticks' THEN RETURN NULL; END IF;
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';
    IF v_key IS NULL THEN RETURN NULL; END IF;
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_hero_pick_revalidate: %', SQLERRM;
  END;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.notify_hero_pick_revalidate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_hero_pick_revalidate ON public.website_hero_picks;
CREATE TRIGGER trg_hero_pick_revalidate
AFTER INSERT OR DELETE ON public.website_hero_picks
FOR EACH STATEMENT EXECUTE FUNCTION public.notify_hero_pick_revalidate();

-- ---------------------------------------------------------------------------
-- 5. The tick (ADMIN role only, audited).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_hero_pick(p_source_url text, p_pick boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  c        public.website_media_cutouts%ROWTYPE;
  v_reason text;
  v_n      integer;
  v_now    timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  -- ADMIN ONLY — by role, not by permission key, so no override can grant it.
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('error', 'admin_only'); END IF;
  IF p_pick IS NULL THEN RETURN jsonb_build_object('error', 'invalid_pick'); END IF;
  -- KEY SHARE: the worker may keep updating the row; it may not delete it meanwhile.
  SELECT * INTO c FROM public.website_media_cutouts WHERE source_url = p_source_url FOR KEY SHARE;
  IF c.source_url IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  PERFORM set_config('app.hero_pick_writer', 'pick', true);
  IF p_pick THEN
    v_reason := public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                        public.media_cutout_url_published(c.source_url));
    IF v_reason IS NOT NULL THEN
      PERFORM set_config('app.hero_pick_writer', '', true);
      RETURN jsonb_build_object('error', v_reason);
    END IF;
    INSERT INTO public.website_hero_picks (source_url, picked_via, picked_by, picked_at)
    VALUES (c.source_url, 'tick', v_uid, v_now)
    ON CONFLICT (source_url) DO NOTHING;
  ELSE
    DELETE FROM public.website_hero_picks WHERE source_url = c.source_url;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.hero_pick_writer', '', true);

  IF v_n > 0 THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('website_media_cutout', c.id, 'set_hero_pick:' || CASE WHEN p_pick THEN 'tick' ELSE 'untick' END,
            jsonb_build_object('hero_pick', NOT p_pick),
            jsonb_build_object('hero_pick', p_pick, 'source_url', c.source_url, 'status', c.status,
                               'hero_photo_source', public.hero_photo_source()),
            v_uid, v_now);
  END IF;
  RETURN jsonb_build_object('ok', true, 'hero_pick', p_pick, 'changed', v_n > 0);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_hero_pick(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_hero_pick(text, boolean) TO authenticated;
COMMENT ON FUNCTION public.set_hero_pick(text, boolean) IS
  'Tick / untick "Use on hero" for one product cut-out. ADMIN role only. Ticking refuses an unusable cut-out with the reason (hero_pick_reason); unticking is always allowed. One audit_logs row per change (website_media_cutout / set_hero_pick:tick|untick). 20261013100000.';

-- ---------------------------------------------------------------------------
-- 6. The one-time carry-over (ADMIN role only). Preview first; apply ticks
--    every approved hero record whose product cut-out is usable. Safe to press
--    twice: nothing is ever ticked twice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_picks_carry_over(p_apply boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_now     timestamptz := now();
  v_setting uuid;
  v_urls    text[];
  v_done    text[];
  v_approved integer;
  v_already integer;
  v_left    jsonb;
  v_before  jsonb;
  v_after   jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('error', 'admin_only'); END IF;
  -- Two presses at once: the second waits, then finds nothing left to tick.
  IF coalesce(p_apply, false) THEN PERFORM pg_advisory_xact_lock(hashtext('hero_picks_carry_over')); END IF;

  WITH x AS (
    SELECT h.source_url,
           EXISTS (SELECT 1 FROM public.website_hero_picks k WHERE k.source_url = h.source_url) AS picked,
           CASE WHEN c.source_url IS NULL THEN 'no_cutout'
                ELSE public.hero_pick_reason(c.status, c.cutout_path, c.cutout_w, c.cutout_h,
                                             public.media_cutout_url_published(h.source_url)) END AS reason
      FROM public.website_hero_cutouts h
      LEFT JOIN public.website_media_cutouts c ON c.source_url = h.source_url
     WHERE h.status = 'approved'
  )
  SELECT count(*),
         count(*) FILTER (WHERE picked),
         coalesce(array_agg(source_url ORDER BY source_url) FILTER (WHERE NOT picked AND reason IS NULL), '{}'),
         coalesce((SELECT jsonb_object_agg(reason, n) FROM (SELECT reason, count(*) n FROM x WHERE NOT picked AND reason IS NOT NULL GROUP BY reason) r), '{}'::jsonb)
    INTO v_approved, v_already, v_urls, v_left
    FROM x;

  v_before := public.hero_product_counts(NULL);
  IF NOT coalesce(p_apply, false) THEN
    RETURN jsonb_build_object('ok', true, 'applied', false, 'approved_hero', v_approved, 'already_ticked', v_already,
                              'to_tick', coalesce(array_length(v_urls, 1), 0), 'left_out', v_left,
                              'products_now', v_before, 'products_after', public.hero_product_counts(v_urls));
  END IF;

  PERFORM set_config('app.hero_pick_writer', 'carry_over', true);
  WITH ins AS (
    INSERT INTO public.website_hero_picks (source_url, picked_via, picked_by, picked_at)
    SELECT u, 'carry_over', v_uid, v_now FROM unnest(v_urls) u
    ON CONFLICT (source_url) DO NOTHING
    RETURNING source_url)
  SELECT coalesce(array_agg(source_url ORDER BY source_url), '{}') INTO v_done FROM ins;
  PERFORM set_config('app.hero_pick_writer', '', true);
  v_after := public.hero_product_counts(NULL);

  IF coalesce(array_length(v_done, 1), 0) > 0 THEN
    SELECT id INTO v_setting FROM public.system_settings WHERE key = 'hero_photo_source';
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('system_setting', v_setting, 'hero_picks_carry_over',
            jsonb_build_object('products', v_before, 'already_ticked', v_already),
            jsonb_build_object('ticked', array_length(v_done, 1), 'source_urls', to_jsonb(v_done),
                               'left_out', v_left, 'products', v_after, 'hero_photo_source', public.hero_photo_source()),
            v_uid, v_now);
  END IF;
  RETURN jsonb_build_object('ok', true, 'applied', true, 'approved_hero', v_approved, 'already_ticked', v_already,
                            'ticked', coalesce(array_length(v_done, 1), 0), 'left_out', v_left,
                            'products_now', v_after);
END
$fn$;
REVOKE ALL ON FUNCTION public.hero_picks_carry_over(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hero_picks_carry_over(boolean) TO authenticated;
COMMENT ON FUNCTION public.hero_picks_carry_over(boolean) IS
  'Carry approved hero records over to ticks: the same photo (source_url) is ticked when its product cut-out is usable (hero_pick_reason). p_apply false = preview (counts, left out and why, products on the hero before / after); true = tick them, once, audited (system_setting / hero_picks_carry_over). ADMIN role only. Idempotent. 20261013100000.';

-- ---------------------------------------------------------------------------
-- 7. The switch (ADMIN role only, audited, revalidates the website).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_hero_photo_source(p_source text, p_expected_source text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.system_settings%ROWTYPE;
  v_old text;
  v_key text;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('error', 'admin_only'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('hero_record','product_ticks') THEN RETURN jsonb_build_object('error', 'invalid_source'); END IF;
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'hero_photo_source' FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;
  v_old := public.hero_photo_source();
  IF p_expected_source IS NOT NULL AND p_expected_source IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'source', v_old);
  END IF;
  IF v_row.value IS NOT DISTINCT FROM to_jsonb(p_source) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'source', v_old);
  END IF;
  PERFORM set_config('app.allow_hero_photo_source_change', 'on', true);
  UPDATE public.system_settings SET value = to_jsonb(p_source), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_row.id;
  PERFORM set_config('app.allow_hero_photo_source_change', '', true);
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_row.id, 'set_hero_photo_source',
          jsonb_build_object('source', v_old, 'raw', v_row.value),
          jsonb_build_object('source', p_source, 'products', public.hero_product_counts(NULL)), v_uid, v_now);
  -- What the hero may show changed: revalidate (fire-and-forget).
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';
    IF v_key IS NOT NULL THEN
      PERFORM net.http_post(
        url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
        body := '{}'::jsonb);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'set_hero_photo_source revalidate: %', SQLERRM;
  END;
  RETURN jsonb_build_object('ok', true, 'changed', true, 'source', p_source, 'old_source', v_old, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_hero_photo_source(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_hero_photo_source(text, text) TO authenticated;
COMMENT ON FUNCTION public.set_hero_photo_source(text, text) IS
  'The ONLY writer of system_settings.hero_photo_source (hero_record | product_ticks). ADMIN role only. One audit_logs row (system_setting / set_hero_photo_source). p_expected_source = the value the caller saw (stale → refused). Revalidates the website. 20261013100000.';

-- ---------------------------------------------------------------------------
-- 8. What the storefront may know (patched from LIVE). On "hero_record" the
--    first branch returns exactly today's rows; on "product_ticks" only the
--    second branch returns anything.
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
  SELECT c.source_url,
         jsonb_build_object('status','approved','path',c.cutout_path,'width',c.cutout_w,'height',c.cutout_h)
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
  'For the website edge function. hero_photo_source = hero_record (default): per photo, approved → {status:approved, path, width, height}; needs_review|failed → {status:held}; rejected → {status:rejected}; ok|auto_fixed and no record → no row. hero_photo_source = product_ticks: ticked, usable product cut-outs (website_hero_picks, hero_pick_reason) → {status:approved, path, width, height}; every other photo → no row. A file is never returned unless approved / usable. 20261013100000.';

-- ---------------------------------------------------------------------------
-- 9. Staff lists (patched from LIVE): hero_pick + hero_pick_blocker on every
--    row, a "hero" filter (ticked photos, also unusable ones so they can be
--    unticked), the Hero tab totals and the switch value.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_media_cutouts(p_filter text, p_search text DEFAULT NULL,
                                                     p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
  IF v_filter NOT IN ('needs_review','needs_owner','failed','auto_fixed','queue','waiting','completed','published',
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
             WHEN 'auto_fixed'    THEN status = 'auto_fixed'
             WHEN 'queue'         THEN hold_reason IS NULL
                                       AND (job_state IN ('submitted','ready','processing')
                                            OR (job_state = 'queued' AND published))
             WHEN 'waiting'       THEN job_state = 'waiting'
             WHEN 'completed'     THEN status IN ('ok','auto_fixed','approved','kept_original')
             WHEN 'published'     THEN status IN ('ok','auto_fixed','approved','kept_original')
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
$fn$;

CREATE OR REPLACE FUNCTION public.get_media_cutout_tab_totals()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
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
      'auto_fixed',   jsonb_build_object('count', count(*) FILTER (WHERE status = 'auto_fixed'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'auto_fixed'), 0)),
      'queue',        jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')), 0)),
      'waiting',      (SELECT jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(paid_calls), 0))
                         FROM a WHERE job_state = 'waiting'),
      'completed',    jsonb_build_object('count', count(*) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original')), 0),
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
    'hero_photo_source', public.hero_photo_source(),
    'provider', CASE WHEN v_prov IN ('fal','replicate') THEN v_prov ELSE 'photoroom' END,
    'price_usd', CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 10. Grants (re-asserted for the patched functions).
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.list_media_cutouts(text,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_media_cutouts(text,text,integer,integer) TO authenticated;
REVOKE ALL ON FUNCTION public.get_media_cutout_tab_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_media_cutout_tab_totals() TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. Self-check, inside the transaction. Aborts everything if not as written.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  -- NOTHING ON THE WEBSITE CHANGES: the switch is (still) hero_record.
  IF current_setting('hero_picks.source_before', true) IN ('absent','hero_record') AND public.hero_photo_source() <> 'hero_record' THEN
    RAISE EXCEPTION 'hero_picks self-check: the switch is not "hero_record"';
  END IF;
  IF current_setting('hero_picks.source_before', true) = 'product_ticks' AND public.hero_photo_source() <> 'product_ticks' THEN
    RAISE EXCEPTION 'hero_picks self-check: an existing switch value was changed';
  END IF;
  -- On hero_record the site function returns exactly what the old body returns.
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
    RAISE EXCEPTION 'hero_picks self-check: hero_cutouts_for_site no longer returns today''s rows on hero_record';
  END IF;
  IF public.hero_pick_reason('ok', 'p', 1, 1, true) IS NOT NULL
     OR public.hero_pick_reason('approved', 'p', 1, 1, true) IS NOT NULL
     OR public.hero_pick_reason('kept_original', 'p', 1, 1, true) <> 'kept_original'
     OR public.hero_pick_reason('rejected', 'p', 1, 1, true) <> 'rejected'
     OR public.hero_pick_reason('needs_review', 'p', 1, 1, true) <> 'not_completed'
     OR public.hero_pick_reason('ok', NULL, NULL, NULL, true) <> 'no_cutout_file'
     OR public.hero_pick_reason('ok', 'p', 1, 1, false) <> 'not_published'
     OR public.hero_pick_reason(NULL, NULL, NULL, NULL, NULL) <> 'no_cutout' THEN
    RAISE EXCEPTION 'hero_picks self-check: hero_pick_reason is wrong';
  END IF;
  IF has_table_privilege('anon', 'public.website_hero_picks', 'SELECT')
     OR has_table_privilege('authenticated', 'public.website_hero_picks', 'SELECT')
     OR has_table_privilege('authenticated', 'public.website_hero_picks', 'INSERT') THEN
    RAISE EXCEPTION 'hero_picks self-check: a browser role can reach website_hero_picks';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.hero_cutouts_for_site(text[])', 'public.hero_photo_source()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'hero_picks self-check: service-only grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.hero_product_counts(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'hero_picks self-check: hero_product_counts is reachable from the browser';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.set_hero_pick(text,boolean)', 'public.hero_picks_carry_over(boolean)',
                               'public.set_hero_photo_source(text,text)', 'public.list_media_cutouts(text,text,integer,integer)',
                               'public.get_media_cutout_tab_totals()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'hero_picks self-check: Hub RPC grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_hero_photo_source' AND tgrelid = 'public.system_settings'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_hero_picks_writes' AND tgrelid = 'public.website_hero_picks'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_hero_pick_revalidate' AND tgrelid = 'public.website_hero_picks'::regclass) THEN
    RAISE EXCEPTION 'hero_picks self-check: a trigger is missing';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only, LIVE values): docs/sql/20261013_hero_picks_verify.sql
-- Run its (P) preview BEFORE this file and its numbered checks AFTER it.
-- ===========================================================================
