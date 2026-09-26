-- ===========================================================================
-- media_cutouts — automatic background removal for website product photos,
-- PR 1 of 3 (Hub): queue, worker schedule, quality verdicts, staff review.
--
-- Plan: ~/Code/reference/background-removal-investigation.md (owner approved
-- D1–D10, 2026-09-26). Rules: docs/MEDIA-CUTOUTS.md.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, AFTER the release PR is on main
-- AND media-cutout-worker is deployed (the cron job below calls it; before the
-- deploy every tick is answered 404 and nothing happens). One transaction.
-- CALLS NO PROVIDER AND SPENDS NOTHING: the switch is seeded 'off' and the
-- self-check aborts the whole file if it is anything else on a first run.
-- NO BACKFILL: existing photos are enqueued by PR 2. Until then only NEW
-- photos (the trigger) and the owner's named test batch are queued.
--
-- What it does:
--
--   A. website_media_cutouts — ONE ROW PER SOURCE PHOTO, keyed by the photo's
--      public URL, NOT by website_product_media.id: the Catalog save deletes
--      and re-inserts every media row (ProductsCard.tsx), so a media id is
--      gone on every edit while the URL survives. A replaced Page365 photo is
--      a new URL (version stamp) → a new row → processed again; the old row
--      and any staff decision on it are never touched.
--      Staff read it (RLS is_staff); only the functions below write it.
--
--   B. trg_website_media_enqueue_cutout — AFTER INSERT OR UPDATE OF url on
--      website_product_media: one INSERT … ON CONFLICT (source_url) DO NOTHING
--      for URLs under promotions/website/ (never our own derived/ files). It
--      enqueues whatever the switch says (cheap; an honest backlog) and can
--      never fail the media write: any error is a WARNING. The Page365
--      scheduled fetch never writes media at all, so it is untouched.
--
--   C. THE SWITCH + CAP, two system_settings rows, guarded like
--      page365_inventory_auto_apply (20260930100000):
--        media_cutout_mode         "off" | "test" | "on"   (anything else = OFF)
--        media_cutout_monthly_cap  provider calls per calendar month (PHT);
--                                  anything invalid = 0 (nothing submitted)
--      set_media_cutout_settings(...)  the ONLY writer; manage_website_catalog;
--                                      one audit_logs row per change
--      trg_guard_media_cutout_settings refuses every other write
--      Seeded "off" and 600. An existing row is NEVER written here.
--      At 80 % of the cap: ONE staff bell per month (media_cutout_cap_near).
--      At 100 %: nothing more is submitted; the queue waits, nothing is lost.
--
--   D. THE WORKER'S SQL (service role only): lease, submit batch, submitted,
--      result ready, process batch/claim, finish, error (retries: 1 try + 3,
--      backoff 5 min → 30 min → 3 h, then 'failed'), housekeeping (a URL no
--      longer used by any media row is kept 30 days, then forgotten and its
--      files removed by the worker).
--
--   E. STAFF (Hub → Website → Photos): overview, list, review (approve /
--      reject / re-run / re-run high detail / use re-run / own cut-out), test
--      batch by SKU. manage_website_catalog; every action audited.
--
--   F. trg_media_cutout_revalidate — a verdict or file change revalidates the
--      storefront pages of every product using that photo (the media row did
--      not change, so the existing media trigger would not fire).
--
--   G. pg_cron 'media-cutout-worker' every 2 minutes on odd minutes
--      (1-59/2), Vault-backed key (CRON AUTH RULE).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). This file redefines
-- NO existing function — every function below is new, and the pre-flight
-- aborts if any of those names already exists with another signature. So
-- there is no live body to md5-guard. It CALLS live helpers, checked by
-- signature: is_staff(uuid), has_permission(uuid,text).
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is safe (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING;
-- the cron job is replaced by name; the switch values are never written).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_got     text;
BEGIN
  IF to_regclass('public.website_products')          IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants')  IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.website_product_media')     IS NULL THEN v_missing := v_missing || 'website_product_media'::text; END IF;
  IF to_regclass('public.website_categories')        IS NULL THEN v_missing := v_missing || 'website_categories'::text; END IF;
  IF to_regclass('public.website_category_products') IS NULL THEN v_missing := v_missing || 'website_category_products'::text; END IF;
  IF to_regclass('public.system_settings')           IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.staff_notifications')       IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF to_regclass('public.audit_logs')                IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.profiles')                  IS NULL THEN v_missing := v_missing || 'profiles'::text; END IF;
  IF to_regclass('cron.job')                         IS NULL THEN v_missing := v_missing || 'cron.job (pg_cron)'::text; END IF;
  IF to_regclass('vault.secrets')                    IS NULL THEN v_missing := v_missing || 'vault.secrets (Supabase Vault)'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutouts: missing: %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('website_products','id'), ('website_products','sku'), ('website_products','slug'), ('website_products','name'),
      ('website_products','status'),
      ('website_product_variants','id'), ('website_product_variants','product_id'),
      ('website_product_media','id'), ('website_product_media','variant_id'), ('website_product_media','url'),
      ('website_product_media','sort'), ('website_product_media','page365_photo_id'),
      ('website_categories','id'), ('website_categories','slug'), ('website_categories','name'),
      ('website_category_products','category_id'), ('website_category_products','product_id'),
      ('system_settings','id'), ('system_settings','key'), ('system_settings','value'), ('system_settings','description'),
      ('system_settings','updated_by_user_id'), ('system_settings','updated_at'),
      ('staff_notifications','type'), ('staff_notifications','title'), ('staff_notifications','body'),
      ('staff_notifications','metadata'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'), ('audit_logs','old_value_json'),
      ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id'),
      ('profiles','user_id'), ('profiles','full_name')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutouts: missing column(s) — Page365 inventory PR 1 must be live: %', array_to_string(v_cols, ', ');
  END IF;

  IF to_regprocedure('public.is_staff(uuid)') IS NULL THEN
    RAISE EXCEPTION 'media_cutouts: public.is_staff(uuid) missing';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'media_cutouts: public.has_permission(uuid,text) missing';
  END IF;
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL OR to_regprocedure('cron.unschedule(text)') IS NULL THEN
    RAISE EXCEPTION 'media_cutouts: pg_cron (cron.schedule / cron.unschedule) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
    RAISE EXCEPTION 'media_cutouts: net.http_post (pg_net) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'media_cutouts: Vault secret email_queue_service_role_key missing — do not create a second key';
  END IF;

  -- An existing switch must already hold a value this file understands; the
  -- file never rewrites it.
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'media_cutout_mode'
               AND coalesce(value #>> '{}', '') NOT IN ('off','test','on')) THEN
    RAISE EXCEPTION 'media_cutouts: system_settings.media_cutout_mode exists but is not off/test/on';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'media_cutout_monthly_cap'
               AND coalesce(value #>> '{}', '') !~ '^[0-9]{1,6}$') THEN
    RAISE EXCEPTION 'media_cutouts: system_settings.media_cutout_monthly_cap exists but is not a whole number';
  END IF;

  -- A table of the same name that is not ours.
  IF to_regclass('public.website_media_cutouts') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'website_media_cutouts' AND column_name = 'source_url') THEN
    RAISE EXCEPTION 'media_cutouts: public.website_media_cutouts exists with another shape';
  END IF;

  -- Name collisions: the new functions must not exist with another signature.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'media_cutout_mode'              AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'media_cutout_cap'               AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'media_cutout_month'             AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'media_cutout_source_ok'         AND pg_get_function_identity_arguments(p.oid) <> 'p_url text')
       OR (p.proname = 'enqueue_media_cutout'           AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'notify_media_cutout_revalidate' AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'guard_media_cutout_settings'    AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'media_cutout_allow_pairs'       AND pg_get_function_identity_arguments(p.oid) <> 'p_url text')
       OR (p.proname = 'media_cutout_lease'             AND pg_get_function_identity_arguments(p.oid) <> 'p_holder text, p_seconds integer')
       OR (p.proname = 'media_cutout_release'           AND pg_get_function_identity_arguments(p.oid) <> 'p_holder text, p_summary jsonb')
       OR (p.proname = 'media_cutout_submit_batch'      AND pg_get_function_identity_arguments(p.oid) <> 'p_limit integer')
       OR (p.proname = 'media_cutout_submitted'         AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_provider text, p_model text, p_request_id text, p_status_url text, p_response_url text')
       OR (p.proname = 'media_cutout_poll_batch'        AND pg_get_function_identity_arguments(p.oid) <> 'p_limit integer')
       OR (p.proname = 'media_cutout_result_ready'      AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_result_url text')
       OR (p.proname = 'media_cutout_process_batch'     AND pg_get_function_identity_arguments(p.oid) <> 'p_limit integer')
       OR (p.proname = 'media_cutout_claim_process'     AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text')
       OR (p.proname = 'media_cutout_finish'            AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_result jsonb')
       OR (p.proname = 'media_cutout_error'             AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_stage text, p_error text, p_retryable boolean')
       OR (p.proname = 'media_cutout_housekeeping'      AND pg_get_function_identity_arguments(p.oid) <> 'p_limit integer')
       OR (p.proname = 'media_cutout_forget'            AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text')
       OR (p.proname = 'get_media_cutout_overview'      AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'list_media_cutouts'             AND pg_get_function_identity_arguments(p.oid) <> 'p_filter text, p_search text, p_limit integer, p_offset integer')
       OR (p.proname = 'set_media_cutout_settings'      AND pg_get_function_identity_arguments(p.oid) <> 'p_mode text, p_cap integer, p_expected_mode text')
       OR (p.proname = 'review_media_cutout'            AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_action text, p_note text, p_own_cutout_url text, p_expected_status text')
       OR (p.proname = 'add_media_cutout_test_batch'    AND pg_get_function_identity_arguments(p.oid) <> 'p_skus text[], p_batch text, p_main_only boolean'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutouts: function(s) already exist with another signature: %', v_got;
  END IF;

  PERFORM set_config('cutout.mode_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_mode'), 'absent'),
                     true);
  PERFORM set_config('cutout.cap_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_monthly_cap'), 'absent'),
                     true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.website_media_cutouts (
  source_url            text PRIMARY KEY
                        CHECK (source_url ~ '^https://[^/]+/storage/v1/object/public/promotions/website/'
                               AND source_url !~ '/promotions/website/derived/'),
  id                    uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,  -- audit_logs.entity_id
  source_kind           text NOT NULL DEFAULT 'staff' CHECK (source_kind IN ('page365','staff')),
  priority              smallint NOT NULL DEFAULT 1,                     -- 0 = a main photo (D6: mains first)
  test_batch            text,
  job_state             text NOT NULL DEFAULT 'queued'
                        CHECK (job_state IN ('queued','submitted','ready','processing','done','error')),
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','ok','auto_fixed','needs_review','approved','rejected','failed')),
  flags                 text[] NOT NULL DEFAULT '{}',
  rerun                 boolean NOT NULL DEFAULT false,
  high_detail           boolean NOT NULL DEFAULT false,
  own_cutout_url        text,
  provider              text,
  model                 text,
  provider_request_id   text,
  provider_status_url   text,
  provider_response_url text,
  result_url            text,
  attempts              smallint NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  last_error            text,
  submitted_at          timestamptz,
  processing_started_at timestamptz,
  cpu_fallback          boolean NOT NULL DEFAULT false,
  finished_at           timestamptz,
  run                   integer NOT NULL DEFAULT 0,
  source_sha256         text,
  source_w              integer,
  source_h              integer,
  output_kind           text CHECK (output_kind IN ('baked','cutout_only')),
  master_path           text,
  cutout_path           text,
  cutout_w              integer,
  cutout_h              integer,
  catalog_path          text,
  catalog_w             integer,
  catalog_h             integer,
  catalog_small_path    text,
  catalog_small_w       integer,
  catalog_small_h       integer,
  edges                 text[] NOT NULL DEFAULT '{}',
  coverage              numeric(6,4),
  detail_kept           numeric(6,4),
  hero_usable           boolean,
  timings               jsonb,
  last_rerun            jsonb,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  review_note           text,
  orphaned_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_cutouts_queue ON public.website_media_cutouts (job_state, priority, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_media_cutouts_status ON public.website_media_cutouts (status);
CREATE INDEX IF NOT EXISTS idx_media_cutouts_test_batch ON public.website_media_cutouts (test_batch) WHERE test_batch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_website_product_media_url ON public.website_product_media (url);
COMMENT ON TABLE public.website_media_cutouts IS
  'Background-removed versions of website product photos (docs/MEDIA-CUTOUTS.md). ONE ROW PER SOURCE PHOTO URL — never per media row (the Catalog save re-inserts media rows). status = the verdict: pending | ok | auto_fixed | needs_review | approved | rejected | failed; only ok / auto_fixed / approved may be shown. job_state = the machinery. Originals are never touched; files live under promotions/website/derived/. Written only by the media_cutout_* functions (service role) and review_media_cutout (staff).';
COMMENT ON COLUMN public.website_media_cutouts.output_kind IS
  'baked = cut-out + chalk-ivory squares stored (D10 path A sizes); cutout_only = D10 path B, stored when a job''s compositor ran out of CPU once — the storefront draws the chalk well itself.';
COMMENT ON COLUMN public.website_media_cutouts.last_rerun IS
  'A re-run whose verdict was worse than the published one: kept here for staff (Use re-run) while the published version stays.';

ALTER TABLE public.website_media_cutouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_media_cutouts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.website_media_cutouts TO authenticated;
GRANT ALL ON public.website_media_cutouts TO service_role;
DROP POLICY IF EXISTS website_media_cutouts_staff_select ON public.website_media_cutouts;
CREATE POLICY website_media_cutouts_staff_select ON public.website_media_cutouts
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.website_media_cutout_usage (
  month          text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),  -- PHT calendar month
  provider_calls integer NOT NULL DEFAULT 0,
  bell_80_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.website_media_cutout_usage IS
  'Provider calls (background-removal submissions) per PHT calendar month, against system_settings.media_cutout_monthly_cap. bell_80_at: the one staff bell at 80 %.';
ALTER TABLE public.website_media_cutout_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_media_cutout_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.website_media_cutout_usage TO authenticated;
GRANT ALL ON public.website_media_cutout_usage TO service_role;
DROP POLICY IF EXISTS website_media_cutout_usage_staff_select ON public.website_media_cutout_usage;
CREATE POLICY website_media_cutout_usage_staff_select ON public.website_media_cutout_usage
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

CREATE TABLE IF NOT EXISTS public.website_media_cutout_lease (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder       text,
  lease_until  timestamptz,
  last_tick_at timestamptz,
  last_tick    jsonb
);
INSERT INTO public.website_media_cutout_lease (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE public.website_media_cutout_lease IS
  'One worker tick at a time (media_cutout_lease). last_tick = the last tick''s summary, shown on the Photos tab.';
ALTER TABLE public.website_media_cutout_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_media_cutout_lease FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.website_media_cutout_lease TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The switch rows. Inserted only when absent; an existing value is NEVER
--    written here.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('media_cutout_mode', '"off"'::jsonb,
        'Automatic background removal for website photos: "off" | "test" (only photos in a named test batch) | "on" (every queued photo). Anything else reads as off. Changed only from Hub → Website → Photos (set_media_cutout_settings; manage_website_catalog; audited). docs/MEDIA-CUTOUTS.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('media_cutout_monthly_cap', '600'::jsonb,
        'Most background-removal provider calls per calendar month (PHT). A staff bell rings at 80 %; at 100 % nothing more is submitted until next month. Anything invalid reads as 0. Changed only from Hub → Website → Photos (set_media_cutout_settings; audited).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Guard: both values move only through set_media_cutout_settings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_media_cutout_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('media_cutout_mode','media_cutout_monthly_cap')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('media_cutout_mode','media_cutout_monthly_cap')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_media_cutout_settings_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Background removal is switched only from the Hub: Website → Photos (set_media_cutout_settings).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_media_cutout_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_media_cutout_settings ON public.system_settings;
CREATE TRIGGER trg_guard_media_cutout_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_media_cutout_settings();

-- ---------------------------------------------------------------------------
-- 4. Helpers. Fail-closed: mode anything but test/on → off; cap anything but
--    a whole number → 0.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v IN ('test','on') THEN v ELSE 'off' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_mode') AS v) s
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_cap()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v ~ '^[0-9]{1,6}$' THEN v::integer ELSE 0 END
    FROM (SELECT coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_monthly_cap'), '') AS v) s
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_month()
RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$ SELECT to_char(now() AT TIME ZONE 'Asia/Manila', 'YYYY-MM') $fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_source_ok(p_url text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT p_url IS NOT NULL
     AND p_url ~ '^https://[^/]+/storage/v1/object/public/promotions/website/'
     AND p_url !~ '/promotions/website/derived/'
$fn$;

-- D7: earrings and sets — a second piece of similar size is part of the photo.
CREATE OR REPLACE FUNCTION public.media_cutout_allow_pairs(p_url text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.website_product_media m
      JOIN public.website_product_variants v ON v.id = m.variant_id
      JOIN public.website_products p ON p.id = v.product_id
      LEFT JOIN public.website_category_products cp ON cp.product_id = p.id
      LEFT JOIN public.website_categories c ON c.id = cp.category_id
     WHERE m.url = p_url
       AND (coalesce(c.slug, '') || ' ' || coalesce(c.name, '') || ' ' || p.name)
           ~* '(earring|pierce|stud|hoop|set\M|ピアス|イヤリング|セット)')
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Enqueue on every new / changed photo URL. Never fails the media write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_media_cutout()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT public.media_cutout_source_ok(NEW.url) THEN
    RETURN NEW;
  END IF;
  BEGIN
    INSERT INTO public.website_media_cutouts (source_url, source_kind, priority)
    VALUES (NEW.url,
            CASE WHEN NEW.page365_photo_id IS NOT NULL THEN 'page365' ELSE 'staff' END,
            CASE WHEN coalesce(NEW.sort, 0) = 0 THEN 0 ELSE 1 END)
    ON CONFLICT (source_url) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'enqueue_media_cutout: % (photo saved; cut-out not queued)', SQLERRM;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.enqueue_media_cutout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_website_media_enqueue_cutout ON public.website_product_media;
CREATE TRIGGER trg_website_media_enqueue_cutout
AFTER INSERT OR UPDATE OF url ON public.website_product_media
FOR EACH ROW EXECUTE FUNCTION public.enqueue_media_cutout();

-- ---------------------------------------------------------------------------
-- 6. Revalidate the storefront when a verdict or a file changes. Never fails
--    the worker's write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_media_cutout_revalidate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_key  text;
  v_slug text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';
    IF v_key IS NULL THEN RETURN NEW; END IF;
    FOR v_slug IN
      SELECT DISTINCT p.slug
        FROM public.website_product_media m
        JOIN public.website_product_variants v ON v.id = m.variant_id
        JOIN public.website_products p ON p.id = v.product_id
       WHERE m.url = NEW.source_url
       LIMIT 20
    LOOP
      PERFORM net.http_post(
        url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
        headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
        body := jsonb_build_object('productSlug', v_slug));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_media_cutout_revalidate: %', SQLERRM;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.notify_media_cutout_revalidate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_media_cutout_revalidate ON public.website_media_cutouts;
CREATE TRIGGER trg_media_cutout_revalidate
AFTER UPDATE ON public.website_media_cutouts
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status
      OR OLD.cutout_path IS DISTINCT FROM NEW.cutout_path
      OR OLD.catalog_path IS DISTINCT FROM NEW.catalog_path)
EXECUTE FUNCTION public.notify_media_cutout_revalidate();

-- ---------------------------------------------------------------------------
-- 7. The worker's SQL. Service role only (grants in §9).
-- ---------------------------------------------------------------------------

-- One tick at a time. A lease a crashed tick left behind lapses by itself.
CREATE OR REPLACE FUNCTION public.media_cutout_lease(p_holder text, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_holder IS NULL OR p_holder = '' THEN RETURN false; END IF;
  UPDATE public.website_media_cutout_lease
     SET holder = p_holder,
         lease_until = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 110), 10), 300))
   WHERE id = 1 AND (lease_until IS NULL OR lease_until < now() OR holder = p_holder);
  RETURN FOUND;
END
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_release(p_holder text, p_summary jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  UPDATE public.website_media_cutout_lease
     SET holder = NULL, lease_until = NULL, last_tick_at = now(), last_tick = p_summary
   WHERE id = 1 AND holder = p_holder;
$fn$;

-- What to send to the provider now: obeys the switch and the monthly cap,
-- mains of active products first. A row handed out is pushed 10 minutes ahead
-- so a tick that dies between here and media_cutout_submitted does not lose it.
CREATE OR REPLACE FUNCTION public.media_cutout_submit_batch(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_mode text := public.media_cutout_mode();
  v_used integer;
  v_left integer;
  v_rows jsonb;
BEGIN
  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('mode', v_mode, 'rows', '[]'::jsonb, 'cap_left', NULL);
  END IF;
  SELECT coalesce((SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()), 0)
    INTO v_used;
  v_left := greatest(0, public.media_cutout_cap() - v_used);
  IF v_left = 0 THEN
    RETURN jsonb_build_object('mode', v_mode, 'rows', '[]'::jsonb, 'cap_left', 0);
  END IF;

  WITH picked AS (
    SELECT c.source_url
      FROM public.website_media_cutouts c
     WHERE c.job_state = 'queued'
       AND c.next_attempt_at <= now()
       AND c.orphaned_at IS NULL
       AND c.own_cutout_url IS NULL
       AND (v_mode = 'on' OR c.test_batch IS NOT NULL)
     ORDER BY c.priority,
              NOT EXISTS (SELECT 1 FROM public.website_product_media m
                            JOIN public.website_product_variants v ON v.id = m.variant_id
                            JOIN public.website_products p ON p.id = v.product_id
                           WHERE m.url = c.source_url AND p.status::text = 'active'),
              c.created_at
     LIMIT least(greatest(coalesce(p_limit, 8), 1), 20, v_left)
     FOR UPDATE OF c SKIP LOCKED
  ), upd AS (
    UPDATE public.website_media_cutouts c
       SET next_attempt_at = now() + interval '10 minutes', updated_at = now()
      FROM picked
     WHERE c.source_url = picked.source_url
    RETURNING c.source_url, c.high_detail, c.rerun
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('source_url', source_url, 'high_detail', high_detail, 'rerun', rerun)), '[]'::jsonb)
    INTO v_rows FROM upd;
  RETURN jsonb_build_object('mode', v_mode, 'rows', v_rows, 'cap_left', v_left);
END
$fn$;

-- The provider accepted the job: count the call, ring the 80 % bell once.
CREATE OR REPLACE FUNCTION public.media_cutout_submitted(
  p_source_url text, p_provider text, p_model text, p_request_id text, p_status_url text, p_response_url text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_month text := public.media_cutout_month();
  v_cap   integer := public.media_cutout_cap();
  v_used  integer;
  v_bell  timestamptz;
BEGIN
  UPDATE public.website_media_cutouts
     SET job_state = 'submitted', provider = p_provider, model = p_model, provider_request_id = p_request_id,
         provider_status_url = p_status_url, provider_response_url = p_response_url,
         submitted_at = now(), next_attempt_at = now(), last_error = NULL, updated_at = now()
   WHERE source_url = p_source_url;

  INSERT INTO public.website_media_cutout_usage (month, provider_calls) VALUES (v_month, 1)
  ON CONFLICT (month) DO UPDATE SET provider_calls = website_media_cutout_usage.provider_calls + 1, updated_at = now()
  RETURNING provider_calls, bell_80_at INTO v_used, v_bell;

  IF v_bell IS NULL AND v_cap > 0 AND v_used * 5 >= v_cap * 4 THEN
    UPDATE public.website_media_cutout_usage SET bell_80_at = now() WHERE month = v_month AND bell_80_at IS NULL;
    IF FOUND THEN
      INSERT INTO public.staff_notifications (type, title, body, metadata)
      VALUES ('media_cutout_cap_near',
              'Background removal: ' || v_used || ' of ' || v_cap || ' photos used this month',
              'Automatic background removal has used 80% of this month''s limit (' || v_cap
                || ' photos). At the limit it pauses until next month; nothing is lost. Raise the limit in Website → Photos if needed.',
              jsonb_build_object('month', v_month, 'used', v_used, 'cap', v_cap));
    END IF;
  END IF;
  RETURN jsonb_build_object('used', v_used, 'cap', v_cap);
END
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_poll_batch(p_limit integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'source_url', c.source_url, 'provider', c.provider, 'request_id', c.provider_request_id,
           'status_url', c.provider_status_url, 'response_url', c.provider_response_url,
           'submitted_at', c.submitted_at)), '[]'::jsonb)
    FROM (SELECT * FROM public.website_media_cutouts
           WHERE job_state = 'submitted' AND next_attempt_at <= now()
           ORDER BY submitted_at
           LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) c
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_result_ready(p_source_url text, p_result_url text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  UPDATE public.website_media_cutouts
     SET job_state = 'ready', result_url = p_result_url, next_attempt_at = now(), updated_at = now()
   WHERE source_url = p_source_url AND job_state = 'submitted';
$fn$;

-- Jobs whose result is in hand. A job still 'processing' after 5 minutes had
-- its invocation killed (the 2 s CPU limit): the next try stores the cut-out
-- only (D10 path B); a second kill fails the job.
CREATE OR REPLACE FUNCTION public.media_cutout_process_batch(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  UPDATE public.website_media_cutouts
     SET job_state = 'error', status = CASE WHEN rerun AND status IN ('ok','auto_fixed','approved') THEN status ELSE 'failed' END,
         flags = CASE WHEN rerun AND status IN ('ok','auto_fixed','approved') THEN flags ELSE ARRAY['api_error:cpu_limit'] END,
         last_rerun = CASE WHEN rerun AND status IN ('ok','auto_fixed','approved')
                           THEN jsonb_build_object('status', 'failed', 'flags', ARRAY['api_error:cpu_limit'], 'at', now())
                           ELSE last_rerun END,
         rerun = false, last_error = 'compositor exceeded the CPU limit twice', finished_at = now(), updated_at = now()
   WHERE job_state = 'processing' AND processing_started_at < now() - interval '5 minutes' AND cpu_fallback;
  UPDATE public.website_media_cutouts
     SET job_state = 'ready', cpu_fallback = true, updated_at = now()
   WHERE job_state = 'processing' AND processing_started_at < now() - interval '5 minutes' AND NOT cpu_fallback;

  SELECT coalesce(jsonb_agg(c.source_url), '[]'::jsonb) INTO v_rows
    FROM (SELECT source_url FROM public.website_media_cutouts
           WHERE job_state = 'ready' AND next_attempt_at <= now()
           ORDER BY priority, updated_at
           LIMIT least(greatest(coalesce(p_limit, 4), 1), 10)) c;
  RETURN v_rows;
END
$fn$;

-- One job, one invocation. Returns null when the job is not ready any more.
CREATE OR REPLACE FUNCTION public.media_cutout_claim_process(p_source_url text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r public.website_media_cutouts%ROWTYPE;
BEGIN
  UPDATE public.website_media_cutouts
     SET job_state = 'processing', processing_started_at = now(), run = run + 1, updated_at = now()
   WHERE source_url = p_source_url AND job_state = 'ready'
  RETURNING * INTO r;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'source_url', r.source_url, 'result_url', r.result_url, 'own_cutout_url', r.own_cutout_url,
    'run', r.run, 'cpu_fallback', r.cpu_fallback, 'rerun', r.rerun,
    'allow_pairs', public.media_cutout_allow_pairs(r.source_url));
END
$fn$;

-- Record a finished job. A staff decision is never overwritten by automation:
-- only a re-run or an own cut-out (both staff-started) replaces approved /
-- rejected. A re-run that came back WORSE than what is published keeps the
-- published version and parks the new result in last_rerun.
CREATE OR REPLACE FUNCTION public.media_cutout_finish(p_source_url text, p_result jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r      public.website_media_cutouts%ROWTYPE;
  v_new  text := p_result ->> 'status';
  v_pub  boolean;
BEGIN
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND OR r.job_state <> 'processing' THEN RETURN 'not_processing'; END IF;
  IF v_new NOT IN ('ok','auto_fixed','needs_review','approved') THEN
    RAISE EXCEPTION 'media_cutout_finish: bad status %', v_new;
  END IF;
  IF v_new = 'approved' AND r.own_cutout_url IS NULL THEN
    RAISE EXCEPTION 'media_cutout_finish: only an own cut-out lands approved';
  END IF;

  IF r.status IN ('approved','rejected') AND NOT r.rerun AND r.own_cutout_url IS NULL THEN
    UPDATE public.website_media_cutouts SET job_state = 'done', finished_at = now(), updated_at = now()
     WHERE source_url = p_source_url;
    RETURN 'kept_staff_decision';
  END IF;

  v_pub := r.status IN ('ok','auto_fixed','approved');
  IF r.rerun AND v_pub AND v_new NOT IN ('ok','auto_fixed') THEN
    UPDATE public.website_media_cutouts
       SET job_state = 'done', rerun = false, high_detail = false, finished_at = now(), updated_at = now(),
           last_rerun = p_result || jsonb_build_object('at', now())
     WHERE source_url = p_source_url;
    RETURN 'kept_published';
  END IF;

  UPDATE public.website_media_cutouts SET
    job_state = 'done', status = v_new,
    flags = coalesce(ARRAY(SELECT jsonb_array_elements_text(p_result -> 'flags')), '{}'),
    edges = coalesce(ARRAY(SELECT jsonb_array_elements_text(p_result -> 'edges')), '{}'),
    coverage = (p_result ->> 'coverage')::numeric, detail_kept = (p_result ->> 'detail_kept')::numeric,
    hero_usable = (p_result ->> 'hero_usable')::boolean,
    source_sha256 = p_result ->> 'source_sha256',
    source_w = (p_result ->> 'source_w')::integer, source_h = (p_result ->> 'source_h')::integer,
    output_kind = p_result ->> 'output_kind', master_path = p_result ->> 'master_path',
    cutout_path = p_result ->> 'cutout_path',
    cutout_w = (p_result ->> 'cutout_w')::integer, cutout_h = (p_result ->> 'cutout_h')::integer,
    catalog_path = p_result ->> 'catalog_path',
    catalog_w = (p_result ->> 'catalog_w')::integer, catalog_h = (p_result ->> 'catalog_h')::integer,
    catalog_small_path = p_result ->> 'catalog_small_path',
    catalog_small_w = (p_result ->> 'catalog_small_w')::integer, catalog_small_h = (p_result ->> 'catalog_small_h')::integer,
    timings = p_result -> 'timings',
    rerun = false, high_detail = false, last_rerun = NULL, last_error = NULL,
    reviewed_by = CASE WHEN v_new = 'approved' THEN reviewed_by ELSE NULL END,
    reviewed_at = CASE WHEN v_new = 'approved' THEN reviewed_at ELSE NULL END,
    finished_at = now(), updated_at = now()
  WHERE source_url = p_source_url;
  RETURN 'recorded';
END
$fn$;

-- A step failed. 1 try + 3 retries (5 min → 30 min → 3 h), then 'failed'.
-- A retry goes back to the step that failed: a result already paid for is
-- re-processed, not re-bought.
CREATE OR REPLACE FUNCTION public.media_cutout_error(p_source_url text, p_stage text, p_error text, p_retryable boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r       public.website_media_cutouts%ROWTYPE;
  v_err   text := left(coalesce(p_error, 'unknown'), 300);
  v_short text := left(regexp_replace(coalesce(p_error, 'unknown'), '[^A-Za-z0-9_ .-]', '', 'g'), 60);
  v_pub   boolean;
BEGIN
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF p_stage NOT IN ('submit','poll','process') THEN RAISE EXCEPTION 'media_cutout_error: bad stage %', p_stage; END IF;

  IF p_retryable AND r.attempts < 3 THEN
    UPDATE public.website_media_cutouts
       SET attempts = attempts + 1, last_error = v_err,
           job_state = CASE p_stage WHEN 'submit' THEN 'queued' WHEN 'poll' THEN 'submitted' ELSE 'ready' END,
           next_attempt_at = now() + CASE r.attempts WHEN 0 THEN interval '5 minutes'
                                                     WHEN 1 THEN interval '30 minutes'
                                                     ELSE interval '3 hours' END,
           updated_at = now()
     WHERE source_url = p_source_url;
    RETURN 'retry';
  END IF;

  v_pub := r.status IN ('ok','auto_fixed','approved');
  UPDATE public.website_media_cutouts
     SET attempts = attempts + 1, last_error = v_err, job_state = 'error',
         status = CASE WHEN r.rerun AND v_pub THEN status ELSE 'failed' END,
         flags = CASE WHEN r.rerun AND v_pub THEN flags ELSE ARRAY['api_error:' || v_short] END,
         last_rerun = CASE WHEN r.rerun AND v_pub
                           THEN jsonb_build_object('status', 'failed', 'flags', ARRAY['api_error:' || v_short], 'at', now())
                           ELSE last_rerun END,
         rerun = false, high_detail = false, finished_at = now(), updated_at = now()
   WHERE source_url = p_source_url;
  RETURN 'failed';
END
$fn$;

-- Orphans: a URL no longer used by any media row is marked, kept 30 days,
-- then handed to the worker (which removes its derived files and calls
-- media_cutout_forget). A URL used again is un-marked.
CREATE OR REPLACE FUNCTION public.media_cutout_housekeeping(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  UPDATE public.website_media_cutouts c SET orphaned_at = NULL, updated_at = now()
   WHERE c.orphaned_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.website_product_media m WHERE m.url = c.source_url);
  UPDATE public.website_media_cutouts c SET orphaned_at = now(), updated_at = now()
   WHERE c.orphaned_at IS NULL
     AND c.job_state IN ('done','error','queued')
     AND NOT EXISTS (SELECT 1 FROM public.website_product_media m WHERE m.url = c.source_url);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'source_url', c.source_url,
           'paths', to_jsonb(array_remove(ARRAY[c.master_path, c.cutout_path, c.catalog_path, c.catalog_small_path,
                                                c.last_rerun ->> 'cutout_path', c.last_rerun ->> 'catalog_path',
                                                c.last_rerun ->> 'catalog_small_path', c.last_rerun ->> 'master_path'], NULL)))),
           '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.website_media_cutouts
           WHERE orphaned_at < now() - interval '30 days'
           ORDER BY orphaned_at LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) c;
  RETURN v_rows;
END
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_forget(p_source_url text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  DELETE FROM public.website_media_cutouts c
   WHERE c.source_url = p_source_url AND c.orphaned_at < now() - interval '30 days'
     AND NOT EXISTS (SELECT 1 FROM public.website_product_media m WHERE m.url = c.source_url);
  RETURN FOUND;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Staff (Hub → Website → Photos). manage_website_catalog.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_media_cutout_overview()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_mode public.system_settings%ROWTYPE;
  v_cap  public.system_settings%ROWTYPE;
  v_by   uuid;
  v_at   timestamptz;
  v_name text;
  v_use  public.website_media_cutout_usage%ROWTYPE;
  v_tick public.website_media_cutout_lease%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_mode FROM public.system_settings WHERE key = 'media_cutout_mode';
  SELECT * INTO v_cap  FROM public.system_settings WHERE key = 'media_cutout_monthly_cap';
  IF v_cap.updated_at IS NOT NULL AND (v_mode.updated_at IS NULL OR v_cap.updated_at > v_mode.updated_at)
     AND v_cap.updated_by_user_id IS NOT NULL THEN
    v_by := v_cap.updated_by_user_id; v_at := v_cap.updated_at;
  ELSE
    v_by := v_mode.updated_by_user_id; v_at := v_mode.updated_at;
  END IF;
  IF v_by IS NOT NULL THEN SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1; END IF;
  SELECT * INTO v_use FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month();
  SELECT * INTO v_tick FROM public.website_media_cutout_lease WHERE id = 1;

  RETURN jsonb_build_object(
    'found', v_mode.id IS NOT NULL AND v_cap.id IS NOT NULL,
    'mode', public.media_cutout_mode(),
    'raw_mode', v_mode.value,
    'cap', public.media_cutout_cap(),
    'month', public.media_cutout_month(),
    'used', coalesce(v_use.provider_calls, 0),
    'bell_80_at', v_use.bell_80_at,
    'updated_at', v_at, 'updated_by_name', v_name,
    'can_change', true,
    'last_tick_at', v_tick.last_tick_at,
    'last_tick', v_tick.last_tick,
    'status_counts', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                        FROM (SELECT status, count(*) n FROM public.website_media_cutouts
                               WHERE orphaned_at IS NULL GROUP BY status) s),
    'state_counts', (SELECT coalesce(jsonb_object_agg(job_state, n), '{}'::jsonb)
                       FROM (SELECT job_state, count(*) n FROM public.website_media_cutouts
                              WHERE orphaned_at IS NULL GROUP BY job_state) s),
    'test_batches', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', test_batch, 'count', n, 'done', d) ORDER BY test_batch), '[]'::jsonb)
                       FROM (SELECT test_batch, count(*) n, count(*) FILTER (WHERE job_state IN ('done','error')) d
                               FROM public.website_media_cutouts WHERE test_batch IS NOT NULL GROUP BY test_batch) s),
    'cpu_ms_p95', (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY (timings ->> 'total')::numeric)
                     FROM (SELECT timings FROM public.website_media_cutouts
                            WHERE timings ? 'total' ORDER BY finished_at DESC NULLS LAST LIMIT 200) t),
    'cpu_ms_max', (SELECT max((timings ->> 'total')::numeric)
                     FROM (SELECT timings FROM public.website_media_cutouts
                            WHERE timings ? 'total' ORDER BY finished_at DESC NULLS LAST LIMIT 200) t),
    'cpu_fallbacks', (SELECT count(*) FROM public.website_media_cutouts WHERE output_kind = 'cutout_only'));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_media_cutout_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_media_cutout_overview() TO authenticated, service_role;

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
  IF v_filter NOT IN ('needs_review','failed','auto_fixed','queue','published','rejected','all','test') THEN
    RETURN jsonb_build_object('error', 'invalid_filter');
  END IF;

  WITH base AS (
    SELECT c.*,
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
       AND CASE v_filter
             WHEN 'needs_review' THEN c.status = 'needs_review'
             WHEN 'failed'       THEN c.status = 'failed'
             WHEN 'auto_fixed'   THEN c.status = 'auto_fixed'
             WHEN 'queue'        THEN c.status = 'pending' OR c.job_state IN ('queued','submitted','ready','processing')
             WHEN 'published'    THEN c.status IN ('ok','auto_fixed','approved')
             WHEN 'rejected'     THEN c.status = 'rejected'
             WHEN 'test'         THEN c.test_batch IS NOT NULL
             ELSE true END
  ), hit AS (
    SELECT * FROM base
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
REVOKE ALL ON FUNCTION public.list_media_cutouts(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_media_cutouts(text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_media_cutout_settings(p_mode text, p_cap integer DEFAULT NULL,
                                                            p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_mode_row public.system_settings%ROWTYPE;
  v_cap_row  public.system_settings%ROWTYPE;
  v_old_mode text;
  v_new_mode text;
  v_old_cap  integer;
  v_new_cap  integer;
  v_mode_changed boolean;
  v_cap_changed  boolean;
  v_now      timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'media_cutout_mode' FOR UPDATE;
  SELECT * INTO v_cap_row  FROM public.system_settings WHERE key = 'media_cutout_monthly_cap' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_cap_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;

  v_old_mode := public.media_cutout_mode();
  v_old_cap  := public.media_cutout_cap();
  v_new_mode := coalesce(btrim(p_mode), v_old_mode);
  IF v_new_mode NOT IN ('off','test','on') THEN RETURN jsonb_build_object('error', 'invalid_mode'); END IF;
  v_new_cap := coalesce(p_cap, v_old_cap);
  IF v_new_cap < 0 OR v_new_cap > 100000 THEN RETURN jsonb_build_object('error', 'invalid_cap'); END IF;
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old_mode THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old_mode);
  END IF;

  v_mode_changed := v_mode_row.value IS DISTINCT FROM to_jsonb(v_new_mode);
  v_cap_changed  := v_cap_row.value IS DISTINCT FROM to_jsonb(v_new_cap);
  IF NOT v_mode_changed AND NOT v_cap_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old_mode, 'cap', v_old_cap);
  END IF;

  PERFORM set_config('app.allow_media_cutout_settings_change', 'on', true);
  IF v_mode_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_mode), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_mode_row.id;
  END IF;
  IF v_cap_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_cap), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_cap_row.id;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_media_cutout_settings',
          jsonb_build_object('mode', v_old_mode, 'raw_mode', v_mode_row.value, 'cap', v_old_cap, 'raw_cap', v_cap_row.value),
          jsonb_build_object('mode', v_new_mode, 'cap', v_new_cap,
                             'mode_changed', v_mode_changed, 'cap_changed', v_cap_changed),
          v_uid, v_now);
  PERFORM set_config('app.allow_media_cutout_settings_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new_mode, 'old_mode', v_old_mode,
                            'cap', v_new_cap, 'old_cap', v_old_cap, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_media_cutout_settings(text, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_media_cutout_settings(text, integer, text) TO authenticated;
COMMENT ON FUNCTION public.set_media_cutout_settings(text, integer, text) IS
  'The ONLY writer of system_settings.media_cutout_mode (off|test|on) and media_cutout_monthly_cap (0–100000 provider calls per PHT month); trg_guard_media_cutout_settings refuses every other write. manage_website_catalog. One audit_logs row (system_setting / set_media_cutout_settings, old -> new). p_expected_mode = the mode the caller saw; a mismatch returns {error:"stale"}.';

-- Staff decisions. One RPC, audited per action.
--   approve            → approved (needs files: a cut-out exists)
--   reject             → rejected (the site shows the original)
--   rerun              → queued again; the published version stays until the
--   rerun_high_detail    new result is ok / auto_fixed (BiRefNet Dynamic 2304)
--   use_rerun          → the parked re-run result becomes the version, approved
--   own_cutout         → staff's own transparent PNG/WebP (already uploaded to
--                        promotions/website/derived/own/) is composited by the
--                        worker and lands approved
CREATE OR REPLACE FUNCTION public.review_media_cutout(p_source_url text, p_action text, p_note text DEFAULT NULL,
                                                      p_own_cutout_url text DEFAULT NULL,
                                                      p_expected_status text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  r      public.website_media_cutouts%ROWTYPE;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_now  timestamptz := now();
  v_new  text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_action NOT IN ('approve','reject','rerun','rerun_high_detail','use_rerun','own_cutout') THEN
    RETURN jsonb_build_object('error', 'invalid_action');
  END IF;
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF p_expected_status IS NOT NULL AND p_expected_status IS DISTINCT FROM r.status THEN
    RETURN jsonb_build_object('error', 'stale', 'status', r.status);
  END IF;
  IF r.job_state IN ('submitted','ready','processing') THEN
    RETURN jsonb_build_object('error', 'busy', 'job_state', r.job_state);
  END IF;

  IF p_action = 'approve' THEN
    IF r.cutout_path IS NULL THEN RETURN jsonb_build_object('error', 'no_cutout'); END IF;
    UPDATE public.website_media_cutouts
       SET status = 'approved', reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := 'approved';
  ELSIF p_action = 'reject' THEN
    UPDATE public.website_media_cutouts
       SET status = 'rejected', job_state = CASE WHEN job_state = 'queued' THEN 'done' ELSE job_state END,
           reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := 'rejected';
  ELSIF p_action IN ('rerun','rerun_high_detail') THEN
    UPDATE public.website_media_cutouts
       SET job_state = 'queued', rerun = r.status NOT IN ('pending','failed'),
           high_detail = (p_action = 'rerun_high_detail'), attempts = 0, next_attempt_at = v_now,
           own_cutout_url = NULL, cpu_fallback = false, last_error = NULL, last_rerun = NULL,
           status = CASE WHEN r.status = 'failed' THEN 'pending' ELSE r.status END,
           review_note = coalesce(v_note, review_note), updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := CASE WHEN r.status = 'failed' THEN 'pending' ELSE r.status END;
  ELSIF p_action = 'use_rerun' THEN
    IF r.last_rerun IS NULL OR (r.last_rerun ->> 'cutout_path') IS NULL THEN
      RETURN jsonb_build_object('error', 'no_rerun');
    END IF;
    UPDATE public.website_media_cutouts SET
      status = 'approved',
      flags = coalesce(ARRAY(SELECT jsonb_array_elements_text(r.last_rerun -> 'flags')), '{}'),
      edges = coalesce(ARRAY(SELECT jsonb_array_elements_text(r.last_rerun -> 'edges')), '{}'),
      output_kind = r.last_rerun ->> 'output_kind', master_path = r.last_rerun ->> 'master_path',
      cutout_path = r.last_rerun ->> 'cutout_path',
      cutout_w = (r.last_rerun ->> 'cutout_w')::integer, cutout_h = (r.last_rerun ->> 'cutout_h')::integer,
      catalog_path = r.last_rerun ->> 'catalog_path',
      catalog_w = (r.last_rerun ->> 'catalog_w')::integer, catalog_h = (r.last_rerun ->> 'catalog_h')::integer,
      catalog_small_path = r.last_rerun ->> 'catalog_small_path',
      catalog_small_w = (r.last_rerun ->> 'catalog_small_w')::integer, catalog_small_h = (r.last_rerun ->> 'catalog_small_h')::integer,
      hero_usable = (r.last_rerun ->> 'hero_usable')::boolean, timings = r.last_rerun -> 'timings',
      last_rerun = NULL, reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
    WHERE source_url = p_source_url;
    v_new := 'approved';
  ELSE -- own_cutout
    IF p_own_cutout_url IS NULL
       OR p_own_cutout_url !~ '^https://[^/]+/storage/v1/object/public/promotions/website/derived/own/[A-Za-z0-9_.-]+\.(png|webp)$' THEN
      RETURN jsonb_build_object('error', 'invalid_own_cutout_url');
    END IF;
    UPDATE public.website_media_cutouts
       SET own_cutout_url = p_own_cutout_url, result_url = p_own_cutout_url, job_state = 'ready',
           rerun = false, high_detail = false, attempts = 0, next_attempt_at = v_now, cpu_fallback = false,
           last_error = NULL, reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := r.status;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('website_media_cutout', r.id, 'review_media_cutout:' || p_action,
          jsonb_build_object('source_url', r.source_url, 'status', r.status, 'job_state', r.job_state,
                             'cutout_path', r.cutout_path, 'flags', to_jsonb(r.flags)),
          jsonb_build_object('source_url', r.source_url, 'status', v_new, 'action', p_action, 'note', v_note,
                             'own_cutout_url', p_own_cutout_url),
          v_uid, v_now);
  RETURN jsonb_build_object('ok', true, 'status', v_new, 'action', p_action);
END
$fn$;
REVOKE ALL ON FUNCTION public.review_media_cutout(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_media_cutout(text, text, text, text, text) TO authenticated;

-- The owner's test batch (mode "test" processes ONLY rows in a batch).
-- Resolves SKUs to their photos, queues any that are not queued yet, and
-- names them. Never touches a row a staff member has decided.
CREATE OR REPLACE FUNCTION public.add_media_cutout_test_batch(p_skus text[], p_batch text, p_main_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_batch   text := nullif(btrim(coalesce(p_batch, '')), '');
  v_skus    text[];
  v_unknown text[];
  v_urls    text[];
  v_added   integer;
  v_tagged  integer;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF v_batch IS NULL OR length(v_batch) > 60 THEN RETURN jsonb_build_object('error', 'batch_name_required'); END IF;
  SELECT array_agg(DISTINCT upper(btrim(s))) INTO v_skus FROM unnest(coalesce(p_skus, '{}')) s WHERE btrim(s) <> '';
  IF v_skus IS NULL OR array_length(v_skus, 1) > 100 THEN RETURN jsonb_build_object('error', 'skus_required_max_100'); END IF;

  SELECT array_agg(s) INTO v_unknown FROM unnest(v_skus) s
   WHERE NOT EXISTS (SELECT 1 FROM public.website_products p WHERE upper(p.sku) = s);

  SELECT array_agg(DISTINCT m.url) INTO v_urls
    FROM public.website_products p
    JOIN public.website_product_variants v ON v.product_id = p.id
    JOIN public.website_product_media m ON m.variant_id = v.id
   WHERE upper(p.sku) = ANY (v_skus)
     AND public.media_cutout_source_ok(m.url)
     AND (NOT coalesce(p_main_only, false) OR m.sort = 0);

  INSERT INTO public.website_media_cutouts (source_url, source_kind, priority)
  SELECT DISTINCT ON (m.url) m.url, CASE WHEN m.page365_photo_id IS NOT NULL THEN 'page365' ELSE 'staff' END,
         CASE WHEN m.sort = 0 THEN 0 ELSE 1 END
    FROM public.website_product_media m
   WHERE m.url = ANY (coalesce(v_urls, '{}'))
   ORDER BY m.url, m.sort
  ON CONFLICT (source_url) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;

  UPDATE public.website_media_cutouts SET test_batch = v_batch, updated_at = now()
   WHERE source_url = ANY (coalesce(v_urls, '{}')) AND test_batch IS DISTINCT FROM v_batch;
  GET DIAGNOSTICS v_tagged = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', (SELECT id FROM public.system_settings WHERE key = 'media_cutout_mode'),
          'add_media_cutout_test_batch', NULL,
          jsonb_build_object('batch', v_batch, 'skus', to_jsonb(v_skus), 'main_only', coalesce(p_main_only, false),
                             'photos', coalesce(array_length(v_urls, 1), 0), 'queued_new', v_added),
          v_uid, now());
  RETURN jsonb_build_object('ok', true, 'batch', v_batch, 'photos', coalesce(array_length(v_urls, 1), 0),
                            'queued_new', v_added, 'tagged', v_tagged, 'unknown_skus', coalesce(to_jsonb(v_unknown), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.add_media_cutout_test_batch(text[], text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_media_cutout_test_batch(text[], text, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. Service-role functions: no browser role may call them.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.media_cutout_mode()', 'public.media_cutout_cap()', 'public.media_cutout_month()',
    'public.media_cutout_source_ok(text)', 'public.media_cutout_allow_pairs(text)',
    'public.media_cutout_lease(text,integer)', 'public.media_cutout_release(text,jsonb)',
    'public.media_cutout_submit_batch(integer)',
    'public.media_cutout_submitted(text,text,text,text,text,text)',
    'public.media_cutout_poll_batch(integer)', 'public.media_cutout_result_ready(text,text)',
    'public.media_cutout_process_batch(integer)', 'public.media_cutout_claim_process(text)',
    'public.media_cutout_finish(text,jsonb)', 'public.media_cutout_error(text,text,text,boolean)',
    'public.media_cutout_housekeeping(integer)', 'public.media_cutout_forget(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 10. The schedule: every 2 minutes on odd minutes. Vault-backed service key
--     resolved at fire time (CRON AUTH RULE), pattern from
--     web-payment-reminder-sweep. The worker itself does nothing while the
--     switch is off.
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('media-cutout-worker')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker');
SELECT cron.schedule('media-cutout-worker', '1-59/2 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/media-cutout-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"tick"}'::jsonb
  );
$cron$);

-- ---------------------------------------------------------------------------
-- 11. Self-check, still inside the transaction. Any failure aborts the whole
--     file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_mode'), 'absent')
     IS DISTINCT FROM (CASE WHEN current_setting('cutout.mode_before', true) = 'absent'
                            THEN 'off' ELSE current_setting('cutout.mode_before', true) END) THEN
    RAISE EXCEPTION 'media_cutouts self-check: the switch changed during this file';
  END IF;
  IF current_setting('cutout.mode_before', true) = 'absent' AND public.media_cutout_mode() <> 'off' THEN
    RAISE EXCEPTION 'media_cutouts self-check: a first run must leave background removal off';
  END IF;
  IF current_setting('cutout.cap_before', true) = 'absent' AND public.media_cutout_cap() <> 600 THEN
    RAISE EXCEPTION 'media_cutouts self-check: the cap must be seeded at 600';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.website_media_cutouts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.website_media_cutout_usage'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.website_media_cutout_lease'::regclass) THEN
    RAISE EXCEPTION 'media_cutouts self-check: RLS is off on a cut-out table';
  END IF;
  IF has_table_privilege('authenticated', 'public.website_media_cutouts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.website_media_cutouts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.website_media_cutouts', 'DELETE')
     OR has_table_privilege('anon', 'public.website_media_cutouts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.website_media_cutout_usage', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.website_media_cutout_lease', 'SELECT') THEN
    RAISE EXCEPTION 'media_cutouts self-check: a browser role can write a cut-out table';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.media_cutout_submit_batch(integer)', 'public.media_cutout_submitted(text,text,text,text,text,text)',
    'public.media_cutout_finish(text,jsonb)', 'public.media_cutout_error(text,text,text,boolean)',
    'public.media_cutout_claim_process(text)', 'public.media_cutout_lease(text,integer)',
    'public.media_cutout_forget(text)', 'public.enqueue_media_cutout()', 'public.guard_media_cutout_settings()',
    'public.notify_media_cutout_revalidate()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'media_cutouts self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.media_cutout_submit_batch(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_finish(text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'media_cutouts self-check: service_role cannot run the worker functions';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.get_media_cutout_overview()', 'public.list_media_cutouts(text,text,integer,integer)',
    'public.set_media_cutout_settings(text,integer,text)', 'public.review_media_cutout(text,text,text,text,text)',
    'public.add_media_cutout_test_batch(text[],text,boolean)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'media_cutouts self-check: Hub RPC grants are wrong on %', v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_guard_media_cutout_settings'
                    AND t.tgrelid = 'public.system_settings'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_website_media_enqueue_cutout'
                       AND t.tgrelid = 'public.website_product_media'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_media_cutout_revalidate'
                       AND t.tgrelid = 'public.website_media_cutouts'::regclass) THEN
    RAISE EXCEPTION 'media_cutouts self-check: a trigger is missing';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'media-cutout-worker') <> 1
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker' AND schedule = '1-59/2 * * * *'
                       AND command ILIKE '%vault.decrypted_secrets%' AND command ILIKE '%/functions/v1/media-cutout-worker%') THEN
    RAISE EXCEPTION 'media_cutouts self-check: worker cron job not registered as written';
  END IF;
  IF public.media_cutout_mode() = 'off'
     AND jsonb_array_length(public.media_cutout_submit_batch(5) -> 'rows') <> 0 THEN
    RAISE EXCEPTION 'media_cutouts self-check: the submit batch returned rows while off';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Switch OFF, cap 600, both guarded. Expect one row:  off | 600 | t
-- SELECT public.media_cutout_mode() AS mode, public.media_cutout_cap() AS cap,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_media_cutout_settings') AS guarded;
--
-- (2) The cron job. Expect one row:  media-cutout-worker | 1-59/2 * * * * | t
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'media-cutout-worker';
--
-- (3) The two triggers. Expect two rows:
--     trg_media_cutout_revalidate      | website_media_cutouts
--     trg_website_media_enqueue_cutout | website_product_media
-- SELECT tgname, tgrelid::regclass FROM pg_trigger
--  WHERE tgname IN ('trg_website_media_enqueue_cutout','trg_media_cutout_revalidate') ORDER BY tgname;
--
-- (4) Browser roles. Expect: f | f | t | t | t
-- SELECT has_function_privilege('authenticated','public.media_cutout_submit_batch(integer)','EXECUTE')          AS auth_submit,
--        has_function_privilege('authenticated','public.media_cutout_finish(text,jsonb)','EXECUTE')             AS auth_finish,
--        has_function_privilege('authenticated','public.review_media_cutout(text,text,text,text,text)','EXECUTE') AS auth_review,
--        has_function_privilege('authenticated','public.set_media_cutout_settings(text,integer,text)','EXECUTE') AS auth_set,
--        has_function_privilege('authenticated','public.get_media_cutout_overview()','EXECUTE')                 AS auth_overview;
--
-- (5) Nothing processed, nothing spent. Expect: 0 | 0
--     (rows appear only when a photo is added or changed after this ran;
--      they wait as queued/pending while the switch is off)
-- SELECT (SELECT count(*) FROM public.website_media_cutouts WHERE job_state <> 'queued') AS not_queued,
--        (SELECT coalesce(sum(provider_calls), 0) FROM public.website_media_cutout_usage) AS provider_calls;
--
-- (6) Informational: how many photos PR 2's backfill will queue (any number):
-- SELECT count(DISTINCT url) FROM public.website_product_media WHERE public.media_cutout_source_ok(url);
-- ===========================================================================
