-- ===========================================================================
-- Background removal → PHOTOROOM (owner decision 2026-09-27, after "Test 30")
-- docs/MEDIA-CUTOUTS.md "PROVIDERS", "SPEED", "COST".
--
-- The OWNER runs this in the SQL Editor (one transaction). It:
--   1. adds website_media_cutouts.provider_uncertainty (Photoroom's
--      x-uncertainty-score, 0–1; the checks hold a photo at >= 0.45)
--   2. adds two settings, inserted only when absent:
--        media_cutout_provider  "photoroom" | "fal" | "replicate"
--                               (anything else reads as photoroom)
--        media_cutout_price_usd "0.02"  (US$ per photo, for the estimate on
--                               the Photos card; not used for billing)
--      guarded like the switch: they change ONLY through
--      set_media_cutout_provider (manage_website_catalog, audited)
--   3. adds media_cutout_sync_result — the worker's one call when a SYNC
--      provider (Photoroom) has answered: counts the call against the monthly
--      cap (via media_cutout_submitted, bell included), marks the row ready
--      (via media_cutout_result_ready) and stores the uncertainty
--   4. adds get_media_cutout_provider / set_media_cutout_provider (Hub)
--   5. runs the worker EVERY MINUTE (was every 2 minutes on odd minutes)
--
-- It does NOT touch media_cutout_mode or media_cutout_monthly_cap (the owner
-- has set the mode to off; it stays off).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). This file redefines
-- NO existing function. It CALLS media_cutout_submitted and
-- media_cutout_result_ready, whose behaviour it relies on, so their LIVE
-- bodies are md5-checked against the bodies in
-- 20261006100000_media_cutouts.sql; any difference aborts with nothing
-- changed. Re-running the file is safe (IF NOT EXISTS / CREATE OR REPLACE /
-- ON CONFLICT DO NOTHING / cron job replaced by name).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_got     text;
  v_md5     text;
BEGIN
  IF to_regclass('public.website_media_cutouts') IS NULL THEN v_missing := v_missing || 'website_media_cutouts'::text; END IF;
  IF to_regclass('public.system_settings')       IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.audit_logs')            IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.profiles')              IS NULL THEN v_missing := v_missing || 'profiles'::text; END IF;
  IF to_regclass('cron.job')                     IS NULL THEN v_missing := v_missing || 'cron.job (pg_cron)'::text; END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN v_missing := v_missing || 'has_permission(uuid,text)'::text; END IF;
  IF to_regprocedure('public.media_cutout_submitted(text,text,text,text,text,text)') IS NULL THEN
    v_missing := v_missing || 'media_cutout_submitted(text,text,text,text,text,text)'::text;
  END IF;
  IF to_regprocedure('public.media_cutout_result_ready(text,text)') IS NULL THEN
    v_missing := v_missing || 'media_cutout_result_ready(text,text)'::text;
  END IF;
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL OR to_regprocedure('cron.unschedule(text)') IS NULL THEN
    v_missing := v_missing || 'cron.schedule / cron.unschedule'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker') THEN
    v_missing := v_missing || 'cron job media-cutout-worker'::text;
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutout_photoroom: missing: % (is 20261006100000_media_cutouts applied?)', array_to_string(v_missing, ', ');
  END IF;

  -- The two callees must be exactly what this was written against.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.media_cutout_submitted(text,text,text,text,text,text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'ca732b540ffce05c1ede53ea1317c1b2' THEN
    RAISE EXCEPTION 'media_cutout_photoroom: live media_cutout_submitted differs from the repo (md5 %) — stop and report', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.media_cutout_result_ready(text,text)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'd8ae98dfc64f5d6336ab7ad08b29c9e5' THEN
    RAISE EXCEPTION 'media_cutout_photoroom: live media_cutout_result_ready differs from the repo (md5 %) — stop and report', v_md5;
  END IF;

  -- New names must be free, or already exactly this (a re-run).
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'media_cutout_sync_result'
           AND pg_get_function_identity_arguments(p.oid) <> 'p_source_url text, p_provider text, p_model text, p_request_id text, p_result_url text, p_uncertainty numeric')
       OR (p.proname = 'get_media_cutout_provider' AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'set_media_cutout_provider'
           AND pg_get_function_identity_arguments(p.oid) <> 'p_provider text, p_price_usd numeric, p_expected_provider text')
       OR (p.proname = 'guard_media_cutout_provider_settings' AND pg_get_function_identity_arguments(p.oid) <> ''));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutout_photoroom: function(s) already exist with another signature: %', v_got;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The provider's own doubt.
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_media_cutouts
  ADD COLUMN IF NOT EXISTS provider_uncertainty numeric(5,4)
  CHECK (provider_uncertainty IS NULL OR (provider_uncertainty >= 0 AND provider_uncertainty <= 1));
COMMENT ON COLUMN public.website_media_cutouts.provider_uncertainty IS
  'Photoroom x-uncertainty-score of the last result (0 sure – 1 unsure; null = none given). The quality checks hold a photo at >= 0.45 (flag uncertain:…). docs/MEDIA-CUTOUTS.md.';

-- ---------------------------------------------------------------------------
-- 2. Settings. Inserted only when absent; an existing value is NEVER written.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('media_cutout_provider', '"photoroom"'::jsonb,
        'Background-removal provider: "photoroom" (default; Remove Background API, needs edge secret PHOTOROOM_API_KEY) | "fal" (FAL_KEY) | "replicate" (REPLICATE_API_TOKEN + REPLICATE_BIREFNET_VERSION). Anything else reads as photoroom. Changed only from Hub → Website → Photos (set_media_cutout_provider; audited). docs/MEDIA-CUTOUTS.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('media_cutout_price_usd', '"0.02"'::jsonb,
        'US$ per background-removal call, for the estimated cost on Website → Photos only (Photoroom Basic plan: $0.02). Not used for billing or for the cap. Changed only through set_media_cutout_provider (audited).')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_media_cutout_provider_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('media_cutout_provider','media_cutout_price_usd')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('media_cutout_provider','media_cutout_price_usd')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_media_cutout_provider_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'The background-removal provider is changed only from the Hub: Website → Photos (set_media_cutout_provider).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_media_cutout_provider_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_media_cutout_provider_settings ON public.system_settings;
CREATE TRIGGER trg_guard_media_cutout_provider_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_media_cutout_provider_settings();

-- ---------------------------------------------------------------------------
-- 3. A sync provider answered (service role only). The result is already in
--    Storage under promotions/website/derived/; the call is counted exactly
--    like a queue submission (same cap, same 80 % bell) and the row goes
--    straight to ready. Photoroom bills only successful calls, and this runs
--    only after one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_sync_result(
  p_source_url text, p_provider text, p_model text, p_request_id text, p_result_url text, p_uncertainty numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_used jsonb;
BEGIN
  IF p_result_url IS NULL
     OR p_result_url !~ '^https://[^/]+/storage/v1/object/public/promotions/website/derived/' THEN
    RAISE EXCEPTION 'media_cutout_sync_result: result must be one of our derived files';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.website_media_cutouts WHERE source_url = p_source_url AND job_state = 'queued') THEN
    RETURN jsonb_build_object('error', 'not_queued');
  END IF;
  v_used := public.media_cutout_submitted(p_source_url, p_provider, p_model, p_request_id, NULL, NULL);
  PERFORM public.media_cutout_result_ready(p_source_url, p_result_url);
  UPDATE public.website_media_cutouts
     SET provider_uncertainty = CASE WHEN p_uncertainty >= 0 AND p_uncertainty <= 1 THEN round(p_uncertainty, 4) END
   WHERE source_url = p_source_url;
  RETURN v_used || jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.media_cutout_sync_result(text, text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_cutout_sync_result(text, text, text, text, text, numeric) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Hub: read / change the provider and the price used for the estimate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_media_cutout_provider()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_prov  public.system_settings%ROWTYPE;
  v_price public.system_settings%ROWTYPE;
  v_by    uuid;
  v_at    timestamptz;
  v_name  text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_prov  FROM public.system_settings WHERE key = 'media_cutout_provider';
  SELECT * INTO v_price FROM public.system_settings WHERE key = 'media_cutout_price_usd';
  IF v_price.updated_at IS NOT NULL AND (v_prov.updated_at IS NULL OR v_price.updated_at > v_prov.updated_at)
     AND v_price.updated_by_user_id IS NOT NULL THEN
    v_by := v_price.updated_by_user_id; v_at := v_price.updated_at;
  ELSE
    v_by := v_prov.updated_by_user_id; v_at := v_prov.updated_at;
  END IF;
  IF v_by IS NOT NULL THEN SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1; END IF;
  RETURN jsonb_build_object(
    'found', v_prov.id IS NOT NULL AND v_price.id IS NOT NULL,
    'provider', CASE WHEN v_prov.value #>> '{}' IN ('fal','replicate') THEN v_prov.value #>> '{}' ELSE 'photoroom' END,
    'raw_provider', v_prov.value,
    'price_usd', v_price.value #>> '{}',
    'updated_at', v_at, 'updated_by_name', v_name);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_media_cutout_provider() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_media_cutout_provider() TO authenticated, service_role;

-- p_price_usd NULL keeps the price when the provider is unchanged, and resets
-- it to the new provider's list price when it changes (photoroom 0.02, fal
-- 0.036 measured on "Test 30", replicate unknown → null).
CREATE OR REPLACE FUNCTION public.set_media_cutout_provider(p_provider text, p_price_usd numeric DEFAULT NULL,
                                                            p_expected_provider text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_prov_row  public.system_settings%ROWTYPE;
  v_price_row public.system_settings%ROWTYPE;
  v_old_prov  text;
  v_new_prov  text;
  v_new_price jsonb;
  v_prov_changed  boolean;
  v_price_changed boolean;
  v_now       timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_prov_row  FROM public.system_settings WHERE key = 'media_cutout_provider' FOR UPDATE;
  SELECT * INTO v_price_row FROM public.system_settings WHERE key = 'media_cutout_price_usd' FOR UPDATE;
  IF v_prov_row.id IS NULL OR v_price_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;

  v_old_prov := CASE WHEN v_prov_row.value #>> '{}' IN ('fal','replicate') THEN v_prov_row.value #>> '{}' ELSE 'photoroom' END;
  v_new_prov := coalesce(nullif(btrim(p_provider), ''), v_old_prov);
  IF v_new_prov NOT IN ('photoroom','fal','replicate') THEN RETURN jsonb_build_object('error', 'invalid_provider'); END IF;
  IF p_expected_provider IS NOT NULL AND p_expected_provider IS DISTINCT FROM v_old_prov THEN
    RETURN jsonb_build_object('error', 'stale', 'provider', v_old_prov);
  END IF;
  IF p_price_usd IS NOT NULL AND (p_price_usd < 0 OR p_price_usd > 10) THEN
    RETURN jsonb_build_object('error', 'invalid_price');
  END IF;
  v_new_price := CASE
    WHEN p_price_usd IS NOT NULL THEN to_jsonb(round(p_price_usd, 4)::text)
    WHEN v_new_prov IS DISTINCT FROM v_old_prov THEN
      CASE v_new_prov WHEN 'photoroom' THEN '"0.02"'::jsonb WHEN 'fal' THEN '"0.036"'::jsonb ELSE 'null'::jsonb END
    ELSE v_price_row.value END;

  v_prov_changed  := v_prov_row.value IS DISTINCT FROM to_jsonb(v_new_prov);
  v_price_changed := v_price_row.value IS DISTINCT FROM v_new_price;
  IF NOT v_prov_changed AND NOT v_price_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'provider', v_old_prov, 'price_usd', v_price_row.value #>> '{}');
  END IF;

  PERFORM set_config('app.allow_media_cutout_provider_change', 'on', true);
  IF v_prov_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_prov), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_prov_row.id;
  END IF;
  IF v_price_changed THEN
    UPDATE public.system_settings SET value = v_new_price, updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_price_row.id;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_prov_row.id, 'set_media_cutout_provider',
          jsonb_build_object('provider', v_old_prov, 'raw_provider', v_prov_row.value, 'price_usd', v_price_row.value),
          jsonb_build_object('provider', v_new_prov, 'price_usd', v_new_price,
                             'provider_changed', v_prov_changed, 'price_changed', v_price_changed),
          v_uid, v_now);
  PERFORM set_config('app.allow_media_cutout_provider_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'provider', v_new_prov, 'old_provider', v_old_prov,
                            'price_usd', v_new_price #>> '{}', 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_media_cutout_provider(text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_media_cutout_provider(text, numeric, text) TO authenticated;
COMMENT ON FUNCTION public.set_media_cutout_provider(text, numeric, text) IS
  'The ONLY writer of system_settings.media_cutout_provider (photoroom|fal|replicate) and media_cutout_price_usd (0–10, estimate only); trg_guard_media_cutout_provider_settings refuses every other write. manage_website_catalog. One audit_logs row (system_setting / set_media_cutout_provider). p_expected_provider = what the caller saw; a mismatch returns {error:"stale"}.';

-- ---------------------------------------------------------------------------
-- 5. Every minute. Same Vault-backed call as before (CRON AUTH RULE); the
--    worker still does nothing while the switch is off, and the lease keeps
--    ticks from overlapping (a tick stops starting work after 45 s).
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('media-cutout-worker')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker');
SELECT cron.schedule('media-cutout-worker', '* * * * *', $cron$
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
-- 6. Self-check. Any failure rolls the whole file back.
-- ---------------------------------------------------------------------------
DO $self$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'website_media_cutouts' AND column_name = 'provider_uncertainty') THEN
    RAISE EXCEPTION 'media_cutout_photoroom self-check: provider_uncertainty missing';
  END IF;
  IF (SELECT count(*) FROM public.system_settings WHERE key IN ('media_cutout_provider','media_cutout_price_usd')) <> 2 THEN
    RAISE EXCEPTION 'media_cutout_photoroom self-check: settings rows missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_guard_media_cutout_provider_settings'
                    AND t.tgrelid = 'public.system_settings'::regclass) THEN
    RAISE EXCEPTION 'media_cutout_photoroom self-check: guard trigger missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.media_cutout_sync_result(text,text,text,text,text,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_media_cutout_provider(text,numeric,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_media_cutout_provider(text,numeric,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_media_cutout_provider()', 'EXECUTE') THEN
    RAISE EXCEPTION 'media_cutout_photoroom self-check: grants are wrong';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'media-cutout-worker') <> 1
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker' AND schedule = '* * * * *'
                       AND command ILIKE '%vault.decrypted_secrets%' AND command ILIKE '%/functions/v1/media-cutout-worker%') THEN
    RAISE EXCEPTION 'media_cutout_photoroom self-check: worker cron job not registered as written';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Settings. Expect one row:  photoroom | 0.02 | off
--     (mode is whatever the owner set — it was 'off' on 2026-09-27 and this
--      file never writes it)
-- SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_provider')  AS provider,
--        (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd') AS price_usd,
--        public.media_cutout_mode() AS mode;
--
-- (2) The column. Expect one row:  provider_uncertainty | numeric
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'website_media_cutouts' AND column_name = 'provider_uncertainty';
--
-- (3) The cron job. Expect one row:  media-cutout-worker | * * * * * | t
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'media-cutout-worker';
--
-- (4) Guarded. Expect an ERROR "…changed only from the Hub…" (and nothing changed):
-- UPDATE public.system_settings SET value = '"fal"' WHERE key = 'media_cutout_provider';
--
-- (5) Browser roles. Expect:  f | t | t
-- SELECT has_function_privilege('authenticated','public.media_cutout_sync_result(text,text,text,text,text,numeric)','EXECUTE') AS auth_sync,
--        has_function_privilege('authenticated','public.set_media_cutout_provider(text,numeric,text)','EXECUTE')          AS auth_set,
--        has_function_privilege('authenticated','public.get_media_cutout_provider()','EXECUTE')                          AS auth_get;
-- ===========================================================================
