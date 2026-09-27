-- ===========================================================================
-- hero_cutouts — the HERO-ONLY cut-out record (hero auto cut-out, PR 2 of 5).
--
-- Plan: ~/Code/reference/hero-comps/AUTO-HERO-CUTOUT.md (§3, §4, PR 2), owner
-- decisions 2026-09-28. Rules: docs/HERO-CUTOUTS.md.
--
-- OWNER RULE (2026-09-28): the storefront HERO shows only cut-outs made by the
-- original tool — BiRefNet-general via rembg, run by the storefront's
-- scheduled GitHub Actions workflow (cha-jewels-web scripts/hero-cutouts/).
-- PRODUCT pages and cards use Photoroom (website_media_cutouts) or the normal
-- photo. The two records never mix: this file does not read, write or
-- redefine anything of website_media_cutouts.
--
-- OWNER RUNS THIS in the SQL Editor, as-is. One transaction. It calls no
-- provider, schedules nothing and changes no existing function.
--
-- What it does:
--
--   A. website_hero_cutouts — ONE ROW PER SOURCE PHOTO URL (the same keying
--      rule as website_media_cutouts: the Catalog save re-inserts media rows,
--      the URL survives). Stores the check's verdict, flags, sizes, the file
--      path under promotions/website/derived/hero/, the model and pinned
--      toolchain, and the owner's decision. A replaced source (same URL, new
--      bytes → new sha256) is re-recorded; an unchanged one is NEVER
--      re-processed — including a held one (N3940 / W1451 at ~440 px are held
--      once, for good).
--      No browser role can read or write it. Staff read it through the two
--      Hub RPCs below; the WORKFLOW writes it only through
--      hero_cutout_record (service role, called by the website edge function
--      behind its own secret HERO_CUTOUT_KEY — EDGE-FUNCTION-SPEC.md).
--
--   B. status, one column:
--        ok | auto_fixed          passed the checks; WAITING for the owner
--        needs_review | failed    held by the checks (failed = no file)
--        approved                 the owner approved it → shown on the hero
--        rejected                 the owner rejected it → never shown
--      qa_status keeps the checks' own verdict after a decision.
--      The workflow can never write approved or rejected.
--
--   C. THE GO-LIVE SWITCH, system_settings.hero_cutout_mode:
--        "approve"  every new cut-out waits for the owner (seeded; the default)
--        "auto"     a cut-out that passed the checks (ok / auto_fixed) lands
--                   approved by itself (auto_approved = true, audited)
--      Anything else reads "approve" (fails safe). Changed ONLY through
--      set_hero_cutout_mode (ADMIN role, audited);
--      trg_guard_hero_cutout_settings refuses every other write. Switching it
--      on does not approve anything already waiting.
--
--   D. THE OWNER: review_hero_cutout(url, 'approve'|'reject', expected_status)
--      — ADMIN ROLE ONLY (by role, not permission key, so no override grants
--      it), one audit_logs row each (website_hero_cutout /
--      review_hero_cutout:<action>). Reject works at any time, including on a
--      cut-out that is live. The status the owner saw is re-checked (a stale
--      screen is refused).
--
--   E. trg_hero_cutout_revalidate — a new record or a status change
--      revalidates the storefront pages of every product using that photo
--      (the storefront revalidates "/" and the catalog tag on every call).
--
--   F. hero_cutouts_for_site(urls) — what the storefront may know, for the
--      website edge function (service role): approved → the file; held
--      (needs_review / failed) → "held"; rejected → "rejected"; waiting or
--      none → nothing. An anonymous read never gets a file that is not
--      approved.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). This file redefines
-- NO existing function: every function below is new, and the pre-flight
-- aborts if any of those names already exists with another signature. It
-- CALLS live helpers, checked by signature: has_role(uuid,app_role),
-- has_permission(uuid,text).
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is safe (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO
-- NOTHING; the switch value is never overwritten).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_got     text;
BEGIN
  IF to_regclass('public.website_products')         IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants') IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.website_product_media')    IS NULL THEN v_missing := v_missing || 'website_product_media'::text; END IF;
  IF to_regclass('public.system_settings')          IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.audit_logs')               IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.profiles')                 IS NULL THEN v_missing := v_missing || 'profiles'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'hero_cutouts: missing: %', array_to_string(v_missing, ', ');
  END IF;
  IF to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'hero_cutouts: public.has_role(uuid, app_role) missing';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'hero_cutouts: public.has_permission(uuid,text) missing';
  END IF;
  IF to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
    RAISE EXCEPTION 'hero_cutouts: net.http_post (pg_net) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'hero_cutouts: Vault secret email_queue_service_role_key missing — do not create a second key';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'hero_cutout_mode'
              AND coalesce(value #>> '{}', '') NOT IN ('approve','auto')) THEN
    RAISE EXCEPTION 'hero_cutouts: system_settings.hero_cutout_mode exists but is not approve/auto';
  END IF;
  -- A table of the same name that is not ours.
  IF to_regclass('public.website_hero_cutouts') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'website_hero_cutouts' AND column_name = 'qa_status') THEN
    RAISE EXCEPTION 'hero_cutouts: public.website_hero_cutouts exists with another shape';
  END IF;
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'hero_cutout_mode'               AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'hero_cutout_source_ok'          AND pg_get_function_identity_arguments(p.oid) <> 'p_url text')
       OR (p.proname = 'guard_hero_cutout_settings'     AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'guard_hero_cutout_writes'       AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'notify_hero_cutout_revalidate'  AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'hero_cutout_record'             AND pg_get_function_identity_arguments(p.oid) <> 'p jsonb')
       OR (p.proname = 'hero_cutouts_known'             AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'hero_cutouts_for_site'          AND pg_get_function_identity_arguments(p.oid) <> 'p_urls text[]')
       OR (p.proname = 'get_hero_cutout_overview'       AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'list_hero_cutouts'              AND pg_get_function_identity_arguments(p.oid) <> 'p_filter text, p_search text, p_limit integer, p_offset integer')
       OR (p.proname = 'set_hero_cutout_mode'           AND pg_get_function_identity_arguments(p.oid) <> 'p_mode text, p_expected_mode text')
       OR (p.proname = 'review_hero_cutout'             AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_action text, p_expected_status text, p_note text'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'hero_cutouts: function(s) already exist with another signature: %', v_got;
  END IF;
  PERFORM set_config('hero.mode_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'hero_cutout_mode'), 'absent'), true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The record.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_cutout_source_ok(p_url text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT p_url IS NOT NULL
     AND p_url ~ '^https://[^/]+/storage/v1/object/public/promotions/website/'
     AND p_url !~ '/promotions/website/derived/'
$fn$;

CREATE TABLE IF NOT EXISTS public.website_hero_cutouts (
  source_url     text PRIMARY KEY CHECK (public.hero_cutout_source_ok(source_url)),
  id             uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,   -- audit_logs.entity_id
  source_sha256  text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_width   integer CHECK (source_width > 0),
  source_height  integer CHECK (source_height > 0),
  status         text NOT NULL CHECK (status IN ('ok','auto_fixed','needs_review','failed','approved','rejected')),
  qa_status      text NOT NULL CHECK (qa_status IN ('ok','auto_fixed','needs_review','failed')),
  flags          text[] NOT NULL DEFAULT '{}',
  coverage       numeric CHECK (coverage >= 0 AND coverage <= 1),
  cutout_path    text CHECK (cutout_path ~ '^website/derived/hero/[0-9a-f]{32}/[0-9a-f]{8}/cutout\.webp$'),
  width          integer CHECK (width > 0),
  height         integer CHECK (height > 0),
  model          text NOT NULL,
  toolchain      jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_approved  boolean NOT NULL DEFAULT false,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- A file exactly when the checks produced one; a failed run has none.
  CONSTRAINT website_hero_cutouts_file CHECK ((qa_status = 'failed') = (cutout_path IS NULL)),
  CONSTRAINT website_hero_cutouts_size CHECK ((cutout_path IS NULL) = (width IS NULL AND height IS NULL)),
  -- A failed run can never be approved (nothing to show).
  CONSTRAINT website_hero_cutouts_failed CHECK (NOT (qa_status = 'failed' AND status = 'approved'))
);
CREATE INDEX IF NOT EXISTS website_hero_cutouts_status_idx ON public.website_hero_cutouts (status, updated_at DESC);
COMMENT ON TABLE public.website_hero_cutouts IS
  'HERO-ONLY cut-outs made by the original tool (BiRefNet-general via rembg, storefront workflow scripts/hero-cutouts/), separate from Photoroom''s website_media_cutouts (docs/HERO-CUTOUTS.md). ONE ROW PER SOURCE PHOTO URL. status: ok|auto_fixed = passed, waiting for the owner; needs_review|failed = held; approved = on the hero; rejected = never. Written ONLY by hero_cutout_record (service role, via the website edge function and HERO_CUTOUT_KEY) and review_hero_cutout (admin). No browser role can read or write it directly.';

ALTER TABLE public.website_hero_cutouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_hero_cutouts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.website_hero_cutouts TO service_role;

-- Even the service role writes only through the two functions: a stray
-- PostgREST write with the service key is refused.
CREATE OR REPLACE FUNCTION public.guard_hero_cutout_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF coalesce(current_setting('app.hero_cutout_writer', true), '') NOT IN ('record','review') THEN
    RAISE EXCEPTION 'website_hero_cutouts is written only by hero_cutout_record (the workflow) and review_hero_cutout (the owner).'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_hero_cutout_writes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_hero_cutout_writes ON public.website_hero_cutouts;
CREATE TRIGGER trg_guard_hero_cutout_writes
BEFORE INSERT OR UPDATE OR DELETE ON public.website_hero_cutouts
FOR EACH ROW EXECUTE FUNCTION public.guard_hero_cutout_writes();

-- ---------------------------------------------------------------------------
-- 2. The go-live switch. Seeded "approve" (approval-first); never overwritten.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('hero_cutout_mode', '"approve"'::jsonb,
        'Hero cut-outs (original tool): "approve" = every new cut-out waits for the owner; "auto" = a cut-out that passed the checks goes live by itself. Anything else reads "approve". Changed only from Hub → Website → Photos → Hero cut-outs (set_hero_cutout_mode; admin; audited).')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_hero_cutout_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key = 'hero_cutout_mode'
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key = 'hero_cutout_mode' AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_hero_cutout_mode_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Hero cut-out go-live is switched only from the Hub: Website → Photos → Hero cut-outs (set_hero_cutout_mode).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_hero_cutout_settings() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_hero_cutout_settings ON public.system_settings;
CREATE TRIGGER trg_guard_hero_cutout_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_hero_cutout_settings();

-- Fail-safe reader: anything but "auto" is "approve".
CREATE OR REPLACE FUNCTION public.hero_cutout_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'hero_cutout_mode') = 'auto'
              THEN 'auto' ELSE 'approve' END
$fn$;
REVOKE ALL ON FUNCTION public.hero_cutout_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_cutout_mode() TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Revalidate the storefront when what it may show changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_hero_cutout_revalidate()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_key  text;
  v_slug text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.cutout_path IS NOT DISTINCT FROM OLD.cutout_path THEN
    RETURN NEW;
  END IF;
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
    RAISE WARNING 'notify_hero_cutout_revalidate: %', SQLERRM;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.notify_hero_cutout_revalidate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_hero_cutout_revalidate ON public.website_hero_cutouts;
CREATE TRIGGER trg_hero_cutout_revalidate
AFTER INSERT OR UPDATE ON public.website_hero_cutouts
FOR EACH ROW EXECUTE FUNCTION public.notify_hero_cutout_revalidate();

-- ---------------------------------------------------------------------------
-- 4. THE WORKFLOW'S WRITER (service role only).
--    p = { source_url, source_sha256, source_width, source_height, status
--          (ok|auto_fixed|needs_review|failed), flags[], coverage, cutout_path,
--          width, height, model, toolchain }
--    → { result: inserted | replaced | unchanged, status }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hero_cutout_record(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_url    text := p ->> 'source_url';
  v_sha    text := lower(p ->> 'source_sha256');
  v_qa     text := p ->> 'status';
  v_path   text := nullif(p ->> 'cutout_path', '');
  v_old    public.website_hero_cutouts%ROWTYPE;
  v_status text;
  v_auto   boolean;
  v_flags  text[];
  v_now    timestamptz := now();
  v_result text;
BEGIN
  IF NOT public.hero_cutout_source_ok(v_url) THEN RAISE EXCEPTION 'hero_cutout_record: bad source_url'; END IF;
  IF v_qa IS NULL OR v_qa NOT IN ('ok','auto_fixed','needs_review','failed') THEN
    -- approved / rejected are the owner's, never the workflow's.
    RAISE EXCEPTION 'hero_cutout_record: status must be ok, auto_fixed, needs_review or failed (got %)', coalesce(v_qa, 'null');
  END IF;
  IF (v_qa = 'failed') <> (v_path IS NULL) THEN
    RAISE EXCEPTION 'hero_cutout_record: a file exactly when status is not failed';
  END IF;
  -- Only a photo a website product actually uses.
  IF NOT EXISTS (SELECT 1 FROM public.website_product_media WHERE url = v_url) THEN
    RETURN jsonb_build_object('error', 'unknown_photo');
  END IF;
  SELECT coalesce(array_agg(x), '{}') INTO v_flags FROM jsonb_array_elements_text(coalesce(p -> 'flags', '[]'::jsonb)) x;

  SELECT * INTO v_old FROM public.website_hero_cutouts WHERE source_url = v_url FOR UPDATE;
  -- Processed once per unchanged source: the same photo is never re-recorded,
  -- whatever its status — a held one stays held, a decision stands.
  IF v_old.source_url IS NOT NULL AND v_old.source_sha256 = v_sha THEN
    RETURN jsonb_build_object('result', 'unchanged', 'status', v_old.status);
  END IF;

  v_auto := v_qa IN ('ok','auto_fixed') AND public.hero_cutout_mode() = 'auto';
  v_status := CASE WHEN v_auto THEN 'approved' ELSE v_qa END;
  v_result := CASE WHEN v_old.source_url IS NULL THEN 'inserted' ELSE 'replaced' END;

  PERFORM set_config('app.hero_cutout_writer', 'record', true);
  INSERT INTO public.website_hero_cutouts AS h (source_url, source_sha256, source_width, source_height, status, qa_status,
                                              flags, coverage, cutout_path, width, height, model, toolchain,
                                              auto_approved, reviewed_by, reviewed_at, review_note, created_at, updated_at)
  VALUES (v_url, v_sha, (p ->> 'source_width')::integer, (p ->> 'source_height')::integer, v_status, v_qa,
          v_flags, (p ->> 'coverage')::numeric, v_path, (p ->> 'width')::integer, (p ->> 'height')::integer,
          coalesce(p ->> 'model', 'birefnet-general'), coalesce(p -> 'toolchain', '{}'::jsonb),
          v_auto, NULL, CASE WHEN v_auto THEN v_now END, NULL, v_now, v_now)
  ON CONFLICT (source_url) DO UPDATE SET
    source_sha256 = EXCLUDED.source_sha256, source_width = EXCLUDED.source_width, source_height = EXCLUDED.source_height,
    status = EXCLUDED.status, qa_status = EXCLUDED.qa_status, flags = EXCLUDED.flags, coverage = EXCLUDED.coverage,
    cutout_path = EXCLUDED.cutout_path, width = EXCLUDED.width, height = EXCLUDED.height, model = EXCLUDED.model,
    toolchain = EXCLUDED.toolchain, auto_approved = EXCLUDED.auto_approved, reviewed_by = NULL,
    reviewed_at = EXCLUDED.reviewed_at, review_note = NULL, updated_at = v_now;
  PERFORM set_config('app.hero_cutout_writer', '', true);

  -- The workflow's own audit trail (performed_by NULL = the workflow); a
  -- replaced source or an automatic go-live is always visible later.
  IF v_result = 'replaced' OR v_auto THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    SELECT 'website_hero_cutout', h.id, 'hero_cutout_record:' || CASE WHEN v_auto THEN 'auto_approved' ELSE v_result END,
           CASE WHEN v_old.source_url IS NULL THEN NULL
                ELSE jsonb_build_object('status', v_old.status, 'source_sha256', v_old.source_sha256, 'cutout_path', v_old.cutout_path) END,
           jsonb_build_object('status', v_status, 'qa_status', v_qa, 'flags', v_flags, 'source_url', v_url, 'actor', 'hero_cutout_workflow'),
           NULL, v_now
      FROM public.website_hero_cutouts h WHERE h.source_url = v_url;
  END IF;
  RETURN jsonb_build_object('result', v_result, 'status', v_status);
END
$fn$;
REVOKE ALL ON FUNCTION public.hero_cutout_record(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_cutout_record(jsonb) TO service_role;
COMMENT ON FUNCTION public.hero_cutout_record(jsonb) IS
  'The workflow''s ONLY writer of website_hero_cutouts (service role; called by the website edge function behind HERO_CUTOUT_KEY). Records the checks'' verdict (ok|auto_fixed|needs_review|failed — never approved/rejected). Same URL + same sha256 → unchanged (never re-processed). With hero_cutout_mode = auto a passed cut-out lands approved (auto_approved, audited).';

-- What the workflow already has (so it cuts nothing twice).
CREATE OR REPLACE FUNCTION public.hero_cutouts_known()
RETURNS TABLE (source_url text, source_sha256 text, status text, coverage numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT source_url, source_sha256, status, coverage FROM public.website_hero_cutouts ORDER BY source_url $fn$;
REVOKE ALL ON FUNCTION public.hero_cutouts_known() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_cutouts_known() TO service_role;

-- What the storefront may know about these photos (the website edge function).
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
$fn$;
REVOKE ALL ON FUNCTION public.hero_cutouts_for_site(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hero_cutouts_for_site(text[]) TO service_role;
COMMENT ON FUNCTION public.hero_cutouts_for_site(text[]) IS
  'For the website edge function: per photo, approved → {status:approved, path, width, height}; needs_review|failed → {status:held}; rejected → {status:rejected}; ok|auto_fixed (waiting for the owner) and no record → no row (the API sends null). A file is never returned unless approved.';

-- ---------------------------------------------------------------------------
-- 5. THE HUB (Website → Photos → Hero cut-outs). Reading: manage_website_catalog.
--    Approve / reject / the switch: ADMIN ROLE only, audited.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_hero_cutout_overview()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.system_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'hero_cutout_mode';
  RETURN jsonb_build_object(
    'mode', public.hero_cutout_mode(),
    'updated_at', v_row.updated_at,
    'updated_by_name', (SELECT full_name FROM public.profiles WHERE user_id = v_row.updated_by_user_id LIMIT 1),
    'can_review', public.has_role(v_uid, 'admin'::public.app_role),
    'status_counts', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM public.website_hero_cutouts GROUP BY status) s), '{}'::jsonb),
    'last_recorded_at', (SELECT max(updated_at) FROM public.website_hero_cutouts));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_hero_cutout_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_hero_cutout_overview() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_hero_cutouts(p_filter text, p_search text DEFAULT NULL,
                                                    p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_total  integer;
  v_rows   jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_filter NOT IN ('waiting','held','live','rejected','all') THEN RETURN jsonb_build_object('error', 'invalid_filter'); END IF;
  WITH base AS (
    SELECT h.*, pr.product
      FROM public.website_hero_cutouts h
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'slug', p.slug, 'status', p.status) AS product,
               p.sku, p.name
          FROM public.website_product_media m
          JOIN public.website_product_variants v ON v.id = m.variant_id
          JOIN public.website_products p ON p.id = v.product_id
         WHERE m.url = h.source_url
         ORDER BY p.status = 'active' DESC, p.sku
         LIMIT 1) pr ON true
     WHERE CASE p_filter
             WHEN 'waiting'  THEN h.status IN ('ok','auto_fixed')
             WHEN 'held'     THEN h.status IN ('needs_review','failed')
             WHEN 'live'     THEN h.status = 'approved'
             WHEN 'rejected' THEN h.status = 'rejected'
             ELSE true END
       AND (v_search IS NULL OR pr.sku ILIKE '%' || v_search || '%' OR pr.name ILIKE '%' || v_search || '%')
  )
  SELECT (SELECT count(*) FROM base),
         coalesce(jsonb_agg(to_jsonb(b) - 'toolchain' ORDER BY (b.product ->> 'sku'), b.source_url), '[]'::jsonb)
    INTO v_total, v_rows
    FROM (SELECT * FROM base ORDER BY (product ->> 'sku'), source_url
           LIMIT greatest(1, least(coalesce(p_limit, 20), 100)) OFFSET greatest(0, coalesce(p_offset, 0))) b;
  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$fn$;
REVOKE ALL ON FUNCTION public.list_hero_cutouts(text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_hero_cutouts(text, text, integer, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_hero_cutout_mode(p_mode text, p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.system_settings%ROWTYPE;
  v_old text;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  -- ADMIN ONLY — by role, not by permission key, so no override can grant it.
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('error', 'admin_only'); END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('approve','auto') THEN RETURN jsonb_build_object('error', 'invalid_mode'); END IF;
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'hero_cutout_mode' FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;
  v_old := public.hero_cutout_mode();
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old);
  END IF;
  IF v_row.value IS NOT DISTINCT FROM to_jsonb(p_mode) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old);
  END IF;
  PERFORM set_config('app.allow_hero_cutout_mode_change', 'on', true);
  UPDATE public.system_settings SET value = to_jsonb(p_mode), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_row.id;
  PERFORM set_config('app.allow_hero_cutout_mode_change', '', true);
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_row.id, 'set_hero_cutout_mode',
          jsonb_build_object('mode', v_old, 'raw', v_row.value), jsonb_build_object('mode', p_mode), v_uid, v_now);
  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', p_mode, 'old_mode', v_old, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_hero_cutout_mode(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_hero_cutout_mode(text, text) TO authenticated;
COMMENT ON FUNCTION public.set_hero_cutout_mode(text, text) IS
  'The ONLY writer of system_settings.hero_cutout_mode (approve|auto). ADMIN role only. One audit_logs row (system_setting / set_hero_cutout_mode). p_expected_mode = the mode the caller saw; a mismatch returns {error:"stale"}.';

CREATE OR REPLACE FUNCTION public.review_hero_cutout(p_source_url text, p_action text, p_expected_status text,
                                                     p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.website_hero_cutouts%ROWTYPE;
  v_new text;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('error', 'admin_only'); END IF;
  IF p_action NOT IN ('approve','reject') THEN RETURN jsonb_build_object('error', 'invalid_action'); END IF;
  SELECT * INTO v_old FROM public.website_hero_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF v_old.source_url IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF p_expected_status IS DISTINCT FROM v_old.status THEN
    RETURN jsonb_build_object('error', 'stale', 'status', v_old.status);
  END IF;
  IF p_action = 'approve' THEN
    IF v_old.qa_status = 'failed' THEN RETURN jsonb_build_object('error', 'nothing_to_approve'); END IF;
    IF v_old.status = 'approved' THEN RETURN jsonb_build_object('error', 'already', 'status', v_old.status); END IF;
    v_new := 'approved';
  ELSE
    -- Reject at any time, including a cut-out that is live.
    IF v_old.status = 'rejected' THEN RETURN jsonb_build_object('error', 'already', 'status', v_old.status); END IF;
    v_new := 'rejected';
  END IF;
  PERFORM set_config('app.hero_cutout_writer', 'review', true);
  UPDATE public.website_hero_cutouts
     SET status = v_new, auto_approved = false, reviewed_by = v_uid, reviewed_at = v_now,
         review_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = v_now
   WHERE source_url = p_source_url;
  PERFORM set_config('app.hero_cutout_writer', '', true);
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('website_hero_cutout', v_old.id, 'review_hero_cutout:' || p_action,
          jsonb_build_object('status', v_old.status, 'auto_approved', v_old.auto_approved),
          jsonb_build_object('status', v_new, 'note', nullif(btrim(coalesce(p_note, '')), ''), 'source_url', p_source_url),
          v_uid, v_now);
  RETURN jsonb_build_object('ok', true, 'status', v_new, 'old_status', v_old.status, 'reviewed_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.review_hero_cutout(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_hero_cutout(text, text, text, text) TO authenticated;
COMMENT ON FUNCTION public.review_hero_cutout(text, text, text, text) IS
  'The owner''s decision on a hero cut-out: approve (not a failed run) or reject (any time, also when live). ADMIN role only. p_expected_status = the status the reviewer saw (stale → refused). One audit_logs row (website_hero_cutout / review_hero_cutout:<action>).';

-- ---------------------------------------------------------------------------
-- 6. Self-check. Aborts the whole file if anything is not as written.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  IF current_setting('hero.mode_before', true) IN ('absent','approve') AND public.hero_cutout_mode() <> 'approve' THEN
    RAISE EXCEPTION 'hero_cutouts self-check: the switch is not "approve"';
  END IF;
  IF current_setting('hero.mode_before', true) = 'auto' AND public.hero_cutout_mode() <> 'auto' THEN
    RAISE EXCEPTION 'hero_cutouts self-check: an existing switch value was changed';
  END IF;
  IF has_table_privilege('anon', 'public.website_hero_cutouts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.website_hero_cutouts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.website_hero_cutouts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.website_hero_cutouts', 'UPDATE') THEN
    RAISE EXCEPTION 'hero_cutouts self-check: a browser role can reach website_hero_cutouts';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.hero_cutout_record(jsonb)', 'public.hero_cutouts_known()',
                               'public.hero_cutouts_for_site(text[])', 'public.hero_cutout_mode()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'hero_cutouts self-check: service-only grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.get_hero_cutout_overview()', 'public.list_hero_cutouts(text,text,integer,integer)',
                               'public.set_hero_cutout_mode(text,text)', 'public.review_hero_cutout(text,text,text,text)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'hero_cutouts self-check: Hub RPC grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_hero_cutout_settings' AND tgrelid = 'public.system_settings'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_hero_cutout_writes' AND tgrelid = 'public.website_hero_cutouts'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_hero_cutout_revalidate' AND tgrelid = 'public.website_hero_cutouts'::regclass) THEN
    RAISE EXCEPTION 'hero_cutouts self-check: a trigger is missing';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT; each block names what to expect.
--
-- (1) The switch: approval-first, guarded. Expect one row:  approve | t
-- SELECT public.hero_cutout_mode() AS mode,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_hero_cutout_settings') AS guarded;
--
-- (2) The record exists and is empty. Expect one row:  0
-- SELECT count(*) FROM public.website_hero_cutouts;
--
-- (3) Browser roles cannot reach the record. Expect one row:  f | f | f | f
-- SELECT has_table_privilege('anon','public.website_hero_cutouts','SELECT')          AS anon_read,
--        has_table_privilege('authenticated','public.website_hero_cutouts','SELECT') AS auth_read,
--        has_table_privilege('authenticated','public.website_hero_cutouts','INSERT') AS auth_insert,
--        has_function_privilege('authenticated','public.hero_cutout_record(jsonb)','EXECUTE') AS auth_record;
--
-- (4) The workflow's functions are service-role only. Expect one row:  t | t | t
-- SELECT has_function_privilege('service_role','public.hero_cutout_record(jsonb)','EXECUTE')       AS svc_record,
--        has_function_privilege('service_role','public.hero_cutouts_known()','EXECUTE')             AS svc_known,
--        has_function_privilege('service_role','public.hero_cutouts_for_site(text[])','EXECUTE')    AS svc_site;
--
-- (5) The three triggers. Expect three rows:
--     trg_guard_hero_cutout_settings | system_settings
--     trg_guard_hero_cutout_writes   | website_hero_cutouts
--     trg_hero_cutout_revalidate     | website_hero_cutouts
-- SELECT tgname, tgrelid::regclass FROM pg_trigger
--  WHERE tgname IN ('trg_guard_hero_cutout_settings','trg_guard_hero_cutout_writes','trg_hero_cutout_revalidate')
--  ORDER BY tgname;
--
-- (6) Photoroom untouched. Expect the same numbers as before running this file
--     (the file never reads or writes website_media_cutouts):
-- SELECT count(*), max(updated_at) FROM public.website_media_cutouts;
-- ===========================================================================
