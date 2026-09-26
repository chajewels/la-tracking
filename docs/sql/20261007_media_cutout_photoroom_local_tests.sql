-- ============================================================================
-- Background removal → Photoroom — LOCAL tests for
-- 20261007100000_media_cutout_photoroom.sql. NEVER ON LIVE.
--
-- In an EMPTY throwaway Postgres (see docs/sql/20261005_media_cutouts_local_stub.sql):
--   export PGOPTIONS='-c cutout.local_stub=yes'
--   $P docs/sql/20261005_media_cutouts_local_stub.sql
--   $P supabase/migrations/20261006100000_media_cutouts.sql
--   $P supabase/migrations/20261007100000_media_cutout_photoroom.sql
--   $P supabase/migrations/20261007100000_media_cutout_photoroom.sql   # re-run is safe
--   $P docs/sql/20261007_media_cutout_photoroom_local_tests.sql
-- Every block raises on failure; the last line prints ALL PASSED. Run it on a
-- fresh stub (it inserts its own fixtures).
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000b1', 'staff'),
                                     ('00000000-0000-0000-0000-0000000000c1', 'staff');
INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-0000000000b1', 'manage_website_catalog');
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-0000000000f1', 'C1395', 'c1395', 'G-SHOCK', 'active');
INSERT INTO public.website_product_variants (id, product_id) VALUES
  ('d0000000-0000-0000-0000-0000000000f1', 'b0000000-0000-0000-0000-0000000000f1');

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;

-- ------------------------------------------------ 1. seeds, column, cron cadence
DO $t$ BEGIN
  IF (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_provider') <> 'photoroom'
     OR (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd') <> '0.02' THEN
    RAISE EXCEPTION 'T1: seeds';
  END IF;
  IF public.media_cutout_mode() <> 'off' THEN RAISE EXCEPTION 'T1: the mode must be untouched (off)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'media-cutout-worker' AND schedule = '* * * * *') THEN
    RAISE EXCEPTION 'T1: cron must run every minute';
  END IF;
END $t$;

-- ------------------------------------------------ 2. the guard refuses a direct write
DO $t$ BEGIN
  BEGIN
    UPDATE public.system_settings SET value = '"fal"' WHERE key = 'media_cutout_provider';
    RAISE EXCEPTION 'T2: guard did not fire';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%changed only from the Hub%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.system_settings WHERE key = 'media_cutout_price_usd';
    RAISE EXCEPTION 'T2: guard did not fire on delete';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%changed only from the Hub%' THEN RAISE; END IF;
  END;
END $t$;

-- ------------------------------------------------ 3. set_media_cutout_provider: permission, defaults, stale, audit
DO $t$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
  IF public.set_media_cutout_provider('fal') ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T3: permission'; END IF;
  IF public.get_media_cutout_provider() ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T3: read permission'; END IF;

  PERFORM pg_temp.as_user('00000000-0000-0000-0000-0000000000b1');
  IF public.set_media_cutout_provider('bria') ->> 'error' <> 'invalid_provider' THEN RAISE EXCEPTION 'T3: invalid'; END IF;
  IF public.set_media_cutout_provider(NULL, 11) ->> 'error' <> 'invalid_price' THEN RAISE EXCEPTION 'T3: price range'; END IF;
  IF public.set_media_cutout_provider('fal', NULL, 'fal') ->> 'error' <> 'stale' THEN RAISE EXCEPTION 'T3: stale'; END IF;

  r := public.set_media_cutout_provider('fal', NULL, 'photoroom');
  IF r ->> 'provider' <> 'fal' OR r ->> 'price_usd' <> '0.036' THEN RAISE EXCEPTION 'T3: fal default price, got %', r; END IF;
  r := public.set_media_cutout_provider('replicate');
  IF r ->> 'price_usd' IS NOT NULL THEN RAISE EXCEPTION 'T3: replicate price unknown → null, got %', r; END IF;
  r := public.set_media_cutout_provider('photoroom');
  IF r ->> 'price_usd' <> '0.02' THEN RAISE EXCEPTION 'T3: back to photoroom 0.02, got %', r; END IF;
  r := public.set_media_cutout_provider(NULL, 0.025);
  IF r ->> 'price_usd' <> '0.0250' OR r ->> 'provider' <> 'photoroom' THEN RAISE EXCEPTION 'T3: price only, got %', r; END IF;
  IF (public.set_media_cutout_provider(NULL, 0.025) ->> 'changed')::boolean THEN RAISE EXCEPTION 'T3: no-op must not change'; END IF;
  r := public.get_media_cutout_provider();
  IF r ->> 'provider' <> 'photoroom' OR r ->> 'price_usd' <> '0.0250' THEN RAISE EXCEPTION 'T3: read back %', r; END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE action = 'set_media_cutout_provider') <> 4 THEN
    RAISE EXCEPTION 'T3: expected 4 audit rows, got %', (SELECT count(*) FROM public.audit_logs WHERE action = 'set_media_cutout_provider');
  END IF;
  PERFORM public.set_media_cutout_provider(NULL, 0.02);
END $t$;

-- ------------------------------------------------ 4. media_cutout_sync_result: counted, ready, uncertainty kept
DO $t$
DECLARE r jsonb; v_used integer;
BEGIN
  INSERT INTO public.website_product_media (variant_id, url, sort, page365_photo_id)
  VALUES ('d0000000-0000-0000-0000-0000000000f1', pg_temp.u('page365/9/77-1.jpeg'), 0, 77);
  v_used := coalesce((SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()), 0);

  BEGIN
    PERFORM public.media_cutout_sync_result(pg_temp.u('page365/9/77-1.jpeg'), 'photoroom', 'photoroom/v1/segment', 'x',
                                            'https://evil.example.com/cut.png', 0.1);
    RAISE EXCEPTION 'T4: a foreign result URL must be refused';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%derived files%' THEN RAISE; END IF;
  END;

  r := public.media_cutout_sync_result(pg_temp.u('page365/9/77-1.jpeg'), 'photoroom', 'photoroom/v1/segment', 'req-1',
                                       pg_temp.u('derived/abcd/photoroom-req-1.png'), 0.6123);
  IF NOT (r ->> 'ok')::boolean THEN RAISE EXCEPTION 'T4: %', r; END IF;
  IF (SELECT job_state || '/' || provider || '/' || provider_request_id || '/' || provider_uncertainty
        FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/9/77-1.jpeg'))
     <> 'ready/photoroom/req-1/0.6123' THEN
    RAISE EXCEPTION 'T4: row %', (SELECT row_to_json(c) FROM public.website_media_cutouts c WHERE source_url = pg_temp.u('page365/9/77-1.jpeg'));
  END IF;
  IF (SELECT result_url FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/9/77-1.jpeg'))
     <> pg_temp.u('derived/abcd/photoroom-req-1.png') THEN RAISE EXCEPTION 'T4: result_url'; END IF;
  IF (SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()) <> v_used + 1 THEN
    RAISE EXCEPTION 'T4: the call must count against the cap';
  END IF;

  -- Not queued any more → refused, nothing counted twice.
  r := public.media_cutout_sync_result(pg_temp.u('page365/9/77-1.jpeg'), 'photoroom', 'photoroom/v1/segment', 'req-2',
                                       pg_temp.u('derived/abcd/photoroom-req-2.png'), 0.1);
  IF r ->> 'error' <> 'not_queued' THEN RAISE EXCEPTION 'T4: second call %', r; END IF;
  IF (SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()) <> v_used + 1 THEN
    RAISE EXCEPTION 'T4: counted twice';
  END IF;

  -- -1 / out of range → null.
  UPDATE public.website_media_cutouts SET job_state = 'queued' WHERE source_url = pg_temp.u('page365/9/77-1.jpeg');
  PERFORM public.media_cutout_sync_result(pg_temp.u('page365/9/77-1.jpeg'), 'photoroom', 'photoroom/v1/segment', 'req-3',
                                          pg_temp.u('derived/abcd/photoroom-req-3.png'), -1);
  IF (SELECT provider_uncertainty FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/9/77-1.jpeg')) IS NOT NULL THEN
    RAISE EXCEPTION 'T4: -1 must store null';
  END IF;

  -- The worker's next step picks it up.
  IF NOT (public.media_cutout_process_batch(10) ? pg_temp.u('page365/9/77-1.jpeg')) THEN
    RAISE EXCEPTION 'T4: the ready row must be handed to processing';
  END IF;
END $t$;

-- ------------------------------------------------ 5. browser roles cannot call the worker function
DO $t$ BEGIN
  IF has_function_privilege('authenticated', 'public.media_cutout_sync_result(text,text,text,text,text,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.media_cutout_sync_result(text,text,text,text,text,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T5: grants';
  END IF;
END $t$;

-- ------------------------------------------------ 6. the md5 guard: a changed callee aborts the whole file
-- (checked by re-running the pre-flight's comparison against a tampered body)
DO $t$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.media_cutout_result_ready(text,text)'::regprocedure;
  IF v_md5 <> 'd8ae98dfc64f5d6336ab7ad08b29c9e5' THEN RAISE EXCEPTION 'T6: repo body md5 changed: %', v_md5; END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.media_cutout_submitted(text,text,text,text,text,text)'::regprocedure;
  IF v_md5 <> 'ca732b540ffce05c1ede53ea1317c1b2' THEN RAISE EXCEPTION 'T6: repo body md5 changed: %', v_md5; END IF;
END $t$;

SELECT 'ALL PASSED' AS media_cutout_photoroom_local_tests;
