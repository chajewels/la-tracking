-- ============================================================================
-- Media cut-outs — LOCAL tests for 20261005100000_media_cutouts.sql.
-- Run after the stub and the migration (see the stub's header). NEVER ON LIVE.
-- Every block raises on failure; the last line prints ALL PASSED.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

-- ---------------------------------------------------------------- fixtures
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'admin'),
                                     ('00000000-0000-0000-0000-00000000000b', 'staff'),
                                     ('00000000-0000-0000-0000-00000000000c', 'staff');
INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-00000000000b', 'manage_website_catalog');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-00000000000a', 'Owner Admin');

INSERT INTO public.website_categories (id, slug, name) VALUES
  ('ca000000-0000-0000-0000-000000000001', 'rings', 'Rings'),
  ('ca000000-0000-0000-0000-000000000002', 'earrings', 'Earrings');
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'AL123', 'al123', 'K18 heart pendant', 'active'),
  ('b0000000-0000-0000-0000-000000000002', 'R3110', 'r3110', 'Branded ring', 'active'),
  ('b0000000-0000-0000-0000-000000000003', 'E100',  'e100',  'Pearl studs', 'draft');
INSERT INTO public.website_category_products VALUES
  ('ca000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 0),
  ('ca000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', 0);
INSERT INTO public.website_product_variants (id, product_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003');

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;

-- ------------------------------------------------ 1. enqueue on insert only for our photos
DO $t$ BEGIN
  INSERT INTO public.website_product_media (variant_id, url, sort, page365_photo_id) VALUES
    ('d0000000-0000-0000-0000-000000000001', pg_temp.u('page365/1/11-100.jpg'), 0, 11),
    ('d0000000-0000-0000-0000-000000000001', pg_temp.u('page365/1/12-100.jpg'), 1, 12),
    ('d0000000-0000-0000-0000-000000000002', pg_temp.u('aaaa.jpg'), 0, NULL),
    ('d0000000-0000-0000-0000-000000000003', 'https://cdn.example.com/other.jpg', 0, NULL),                 -- not ours
    ('d0000000-0000-0000-0000-000000000003', pg_temp.u('derived/abc/r1/cutout.webp'), 1, NULL);            -- our own output
  IF (SELECT count(*) FROM public.website_media_cutouts) <> 3 THEN
    RAISE EXCEPTION 'T1: expected 3 queued, got %', (SELECT count(*) FROM public.website_media_cutouts);
  END IF;
  IF (SELECT source_kind || '/' || priority || '/' || job_state || '/' || status FROM public.website_media_cutouts
       WHERE source_url = pg_temp.u('page365/1/11-100.jpg')) <> 'page365/0/queued/pending' THEN
    RAISE EXCEPTION 'T1: main Page365 photo row wrong';
  END IF;
  IF (SELECT priority FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/12-100.jpg')) <> 1 THEN
    RAISE EXCEPTION 'T1: a non-main photo must be priority 1';
  END IF;
  IF (SELECT source_kind FROM public.website_media_cutouts WHERE source_url = pg_temp.u('aaaa.jpg')) <> 'staff' THEN
    RAISE EXCEPTION 'T1: staff upload kind';
  END IF;
END $t$;

-- ------------------------------------------------ 2. switch fail-to-off; nothing handed out while off
DO $t$ BEGIN
  IF public.media_cutout_mode() <> 'off' OR public.media_cutout_cap() <> 600 THEN RAISE EXCEPTION 'T2: seeds'; END IF;
  IF jsonb_array_length(public.media_cutout_submit_batch(10) -> 'rows') <> 0 THEN RAISE EXCEPTION 'T2: off must hand out nothing'; END IF;
  -- A corrupted value (only possible with the guard bypassed) reads as OFF, a bad cap as 0.
  PERFORM set_config('app.allow_media_cutout_settings_change', 'on', true);
  UPDATE public.system_settings SET value = '"ON"' WHERE key = 'media_cutout_mode';
  UPDATE public.system_settings SET value = '"lots"' WHERE key = 'media_cutout_monthly_cap';
  IF public.media_cutout_mode() <> 'off' THEN RAISE EXCEPTION 'T2: "ON" must read off'; END IF;
  IF public.media_cutout_cap() <> 0 THEN RAISE EXCEPTION 'T2: a bad cap must read 0'; END IF;
  UPDATE public.system_settings SET value = '"off"' WHERE key = 'media_cutout_mode';
  UPDATE public.system_settings SET value = '600' WHERE key = 'media_cutout_monthly_cap';
  PERFORM set_config('app.allow_media_cutout_settings_change', '', true);
END $t$;

-- ------------------------------------------------ 3. the guard refuses a direct write
DO $t$ BEGIN
  BEGIN
    UPDATE public.system_settings SET value = '"on"' WHERE key = 'media_cutout_mode';
    RAISE EXCEPTION 'T3: guard did not fire';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Background removal is switched only from the Hub%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.system_settings WHERE key = 'media_cutout_monthly_cap';
    RAISE EXCEPTION 'T3: guard did not fire on delete';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Background removal is switched only from the Hub%' THEN RAISE; END IF;
  END;
END $t$;

-- ------------------------------------------------ 4. set_media_cutout_settings: permission, validation, audit, stale
DO $t$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');     -- staff WITHOUT the key
  IF public.set_media_cutout_settings('test', NULL, NULL) ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T4: perm'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');     -- staff WITH manage_website_catalog
  IF public.set_media_cutout_settings('sometimes', NULL, NULL) ->> 'error' <> 'invalid_mode' THEN RAISE EXCEPTION 'T4: mode'; END IF;
  IF public.set_media_cutout_settings(NULL, -1, NULL) ->> 'error' <> 'invalid_cap' THEN RAISE EXCEPTION 'T4: cap'; END IF;
  IF public.set_media_cutout_settings('on', NULL, 'test') ->> 'error' <> 'stale' THEN RAISE EXCEPTION 'T4: stale'; END IF;
  v := public.set_media_cutout_settings('test', 5, 'off');
  IF NOT (v ->> 'ok')::boolean OR v ->> 'mode' <> 'test' OR (v ->> 'cap')::int <> 5 THEN RAISE EXCEPTION 'T4: set %', v; END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE action = 'set_media_cutout_settings') <> 1 THEN RAISE EXCEPTION 'T4: audit'; END IF;
  IF public.media_cutout_mode() <> 'test' OR public.media_cutout_cap() <> 5 THEN RAISE EXCEPTION 'T4: not applied'; END IF;
END $t$;

-- ------------------------------------------------ 5. test mode hands out only the test batch; test batch by SKU
DO $t$
DECLARE v jsonb;
BEGIN
  IF jsonb_array_length(public.media_cutout_submit_batch(10) -> 'rows') <> 0 THEN RAISE EXCEPTION 'T5: nothing is in a batch yet'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.add_media_cutout_test_batch(ARRAY['al123', 'NOPE1'], 'Test 30', false);
  IF (v ->> 'photos')::int <> 2 OR (v ->> 'queued_new')::int <> 0 OR v -> 'unknown_skus' <> '["NOPE1"]'::jsonb THEN
    RAISE EXCEPTION 'T5: batch %', v;
  END IF;
  v := public.media_cutout_submit_batch(10);
  IF jsonb_array_length(v -> 'rows') <> 2 THEN RAISE EXCEPTION 'T5: expected the 2 batch photos, got %', v; END IF;
  IF (v -> 'rows' -> 0 ->> 'source_url') <> pg_temp.u('page365/1/11-100.jpg') THEN RAISE EXCEPTION 'T5: main photo first'; END IF;
  -- handed-out rows are pushed ahead (a dead tick does not lose them, nor double-send them now)
  IF jsonb_array_length(public.media_cutout_submit_batch(10) -> 'rows') <> 0 THEN RAISE EXCEPTION 'T5: soft claim'; END IF;
END $t$;

-- ------------------------------------------------ 6. cap + the single 80 % bell
DO $t$
DECLARE i int;
BEGIN
  PERFORM public.media_cutout_submitted(pg_temp.u('page365/1/11-100.jpg'), 'fal', 'birefnet/v2', 'req-1', 'https://s/1', 'https://r/1');
  PERFORM public.media_cutout_submitted(pg_temp.u('page365/1/12-100.jpg'), 'fal', 'birefnet/v2', 'req-2', 'https://s/2', 'https://r/2');
  IF (SELECT provider_calls FROM public.website_media_cutout_usage) <> 2 THEN RAISE EXCEPTION 'T6: count'; END IF;
  IF EXISTS (SELECT 1 FROM public.staff_notifications WHERE type = 'media_cutout_cap_near') THEN RAISE EXCEPTION 'T6: bell too early'; END IF;
  -- two more calls → 4 of 5 = 80 %
  FOR i IN 1..2 LOOP
    PERFORM public.media_cutout_submitted(pg_temp.u('nope-' || i || '.jpg'), 'fal', 'm', 'x', 's', 'r');
  END LOOP;
  IF (SELECT count(*) FROM public.staff_notifications WHERE type = 'media_cutout_cap_near') <> 1 THEN RAISE EXCEPTION 'T6: bell at 80%%'; END IF;
  PERFORM public.media_cutout_submitted(pg_temp.u('nope-3.jpg'), 'fal', 'm', 'x', 's', 'r');           -- 5 of 5
  IF (SELECT count(*) FROM public.staff_notifications WHERE type = 'media_cutout_cap_near') <> 1 THEN RAISE EXCEPTION 'T6: one bell only'; END IF;
  -- at the cap nothing more is handed out, even an eligible row
  UPDATE public.website_media_cutouts SET test_batch = 'Test 30', next_attempt_at = now() WHERE source_url = pg_temp.u('aaaa.jpg');
  IF (public.media_cutout_submit_batch(10) ->> 'cap_left')::int <> 0
     OR jsonb_array_length(public.media_cutout_submit_batch(10) -> 'rows') <> 0 THEN RAISE EXCEPTION 'T6: cap not enforced'; END IF;
END $t$;

-- ------------------------------------------------ 7. URL keying survives the Catalog's delete-reinsert
DO $t$
DECLARE v_id uuid; v_ids_before uuid[];
BEGIN
  SELECT id INTO v_id FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/11-100.jpg');
  SELECT array_agg(id ORDER BY id) INTO v_ids_before FROM public.website_product_media WHERE variant_id = 'd0000000-0000-0000-0000-000000000001';
  -- ProductsCard save: delete every media row of the variant, insert them again
  DELETE FROM public.website_product_media WHERE variant_id = 'd0000000-0000-0000-0000-000000000001';
  INSERT INTO public.website_product_media (variant_id, url, sort, page365_photo_id) VALUES
    ('d0000000-0000-0000-0000-000000000001', pg_temp.u('page365/1/11-100.jpg'), 0, 11),
    ('d0000000-0000-0000-0000-000000000001', pg_temp.u('page365/1/12-100.jpg'), 1, 12);
  IF (SELECT array_agg(id ORDER BY id) FROM public.website_product_media WHERE variant_id = 'd0000000-0000-0000-0000-000000000001') = v_ids_before THEN
    RAISE EXCEPTION 'T7: the test must really change the media ids';
  END IF;
  IF (SELECT id FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/11-100.jpg')) <> v_id
     OR (SELECT job_state FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/11-100.jpg')) <> 'submitted' THEN
    RAISE EXCEPTION 'T7: the cut-out row must survive untouched';
  END IF;
  IF (SELECT count(*) FROM public.website_media_cutouts WHERE source_url LIKE '%page365/1/1%') <> 2 THEN RAISE EXCEPTION 'T7: duplicates'; END IF;
END $t$;

-- ------------------------------------------------ 8. poll → ready → process → finish; revalidation fires
DO $t$
DECLARE v jsonb; v_calls int;
BEGIN
  IF jsonb_array_length(public.media_cutout_poll_batch(10)) <> 2 THEN RAISE EXCEPTION 'T8: poll list'; END IF;
  PERFORM public.media_cutout_result_ready(pg_temp.u('page365/1/11-100.jpg'), 'https://fal.media/out.png');
  IF public.media_cutout_process_batch(5) <> jsonb_build_array(pg_temp.u('page365/1/11-100.jpg')) THEN RAISE EXCEPTION 'T8: process list'; END IF;
  v := public.media_cutout_claim_process(pg_temp.u('page365/1/11-100.jpg'));
  IF (v ->> 'run')::int <> 1 OR (v ->> 'allow_pairs')::boolean OR (v ->> 'cpu_fallback')::boolean THEN RAISE EXCEPTION 'T8: claim %', v; END IF;
  IF public.media_cutout_claim_process(pg_temp.u('page365/1/11-100.jpg')) IS NOT NULL THEN RAISE EXCEPTION 'T8: double claim'; END IF;
  SELECT count(*) INTO v_calls FROM net.calls;
  IF public.media_cutout_finish(pg_temp.u('page365/1/11-100.jpg'), jsonb_build_object(
       'status', 'needs_review', 'flags', jsonb_build_array('extra_objects:1'), 'edges', '[]'::jsonb,
       'coverage', 0.12, 'hero_usable', false, 'source_w', 1512, 'source_h', 1512, 'output_kind', 'baked',
       'cutout_path', 'website/derived/aa/r1/cutout.webp', 'cutout_w', 600, 'cutout_h', 700,
       'catalog_path', 'website/derived/aa/r1/catalog.webp', 'timings', '{"total": 500}'::jsonb)) <> 'recorded' THEN
    RAISE EXCEPTION 'T8: finish';
  END IF;
  IF (SELECT status || '/' || job_state || '/' || flags[1] FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/11-100.jpg'))
     <> 'needs_review/done/extra_objects:1' THEN RAISE EXCEPTION 'T8: verdict'; END IF;
  IF (SELECT count(*) FROM net.calls WHERE body ->> 'productSlug' = 'al123') < 1 OR (SELECT count(*) FROM net.calls) <= v_calls THEN
    RAISE EXCEPTION 'T8: revalidation did not fire';
  END IF;
  -- a finish for a row that is not processing is ignored
  IF public.media_cutout_finish(pg_temp.u('page365/1/11-100.jpg'), '{"status":"ok"}') <> 'not_processing' THEN RAISE EXCEPTION 'T8: stray finish'; END IF;
  -- automation can never land 'approved'
  PERFORM public.media_cutout_result_ready(pg_temp.u('page365/1/12-100.jpg'), 'https://fal.media/out2.png');
  PERFORM public.media_cutout_claim_process(pg_temp.u('page365/1/12-100.jpg'));
  BEGIN
    PERFORM public.media_cutout_finish(pg_temp.u('page365/1/12-100.jpg'), '{"status":"approved"}');
    RAISE EXCEPTION 'T8: approved accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%only an own cut-out lands approved%' THEN RAISE; END IF;
  END;
END $t$;

-- ------------------------------------------------ 9. retries: 1 try + 3, backoff, then failed; process retry does not re-buy
DO $t$
DECLARE u text := pg_temp.u('page365/1/12-100.jpg');
BEGIN
  IF public.media_cutout_error(u, 'process', 'decode failed', true) <> 'retry' THEN RAISE EXCEPTION 'T9: 1'; END IF;
  IF (SELECT job_state FROM public.website_media_cutouts WHERE source_url = u) <> 'ready' THEN RAISE EXCEPTION 'T9: process retry goes back to ready'; END IF;
  IF (SELECT next_attempt_at FROM public.website_media_cutouts WHERE source_url = u) < now() + interval '4 minutes' THEN RAISE EXCEPTION 'T9: 5 min backoff'; END IF;
  PERFORM public.media_cutout_error(u, 'poll', 'timeout', true);
  IF (SELECT job_state FROM public.website_media_cutouts WHERE source_url = u) <> 'submitted' THEN RAISE EXCEPTION 'T9: poll retry'; END IF;
  PERFORM public.media_cutout_error(u, 'submit', '500', true);
  IF (SELECT job_state || '/' || attempts FROM public.website_media_cutouts WHERE source_url = u) <> 'queued/3' THEN RAISE EXCEPTION 'T9: 3 retries'; END IF;
  IF public.media_cutout_error(u, 'submit', 'HTTP 500 upstream', true) <> 'failed' THEN RAISE EXCEPTION 'T9: 4th failure fails'; END IF;
  IF (SELECT status || '/' || job_state || '/' || flags[1] FROM public.website_media_cutouts WHERE source_url = u)
     <> 'failed/error/api_error:HTTP 500 upstream' THEN RAISE EXCEPTION 'T9: failed row'; END IF;
END $t$;

-- ------------------------------------------------ 10. staff review: approve / reject / rerun / busy / audit
DO $t$
DECLARE u text := pg_temp.u('page365/1/11-100.jpg'); v jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  IF public.review_media_cutout(u, 'approve', NULL, NULL, NULL) ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T10: perm'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  IF public.review_media_cutout(u, 'approve', NULL, NULL, 'ok') ->> 'error' <> 'stale' THEN RAISE EXCEPTION 'T10: stale'; END IF;
  v := public.review_media_cutout(u, 'approve', 'inset is fine', NULL, 'needs_review');
  IF v ->> 'status' <> 'approved' THEN RAISE EXCEPTION 'T10: approve %', v; END IF;
  IF (SELECT reviewed_by FROM public.website_media_cutouts WHERE source_url = u) <> '00000000-0000-0000-0000-00000000000b' THEN RAISE EXCEPTION 'T10: reviewer'; END IF;
  IF public.review_media_cutout(pg_temp.u('page365/1/12-100.jpg'), 'approve', NULL, NULL, NULL) ->> 'error' <> 'no_cutout' THEN
    RAISE EXCEPTION 'T10: a failed row without files cannot be approved';
  END IF;
  -- re-run keeps the approved version published until a good result lands
  v := public.review_media_cutout(u, 'rerun_high_detail', NULL, NULL, NULL);
  IF (SELECT status || '/' || job_state || '/' || rerun || '/' || high_detail FROM public.website_media_cutouts WHERE source_url = u)
     <> 'approved/queued/true/true' THEN RAISE EXCEPTION 'T10: rerun state'; END IF;
  IF (SELECT count(*) FROM public.audit_logs WHERE entity_type = 'website_media_cutout') <> 2 THEN RAISE EXCEPTION 'T10: audit'; END IF;
END $t$;

-- ------------------------------------------------ 11. a worse re-run keeps the published version; use_rerun; better re-run replaces
DO $t$
DECLARE u text := pg_temp.u('page365/1/11-100.jpg');
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.set_media_cutout_settings(NULL, 100, NULL);
  PERFORM public.media_cutout_submitted(u, 'fal', 'm', 'req-9', 's', 'r');
  IF public.review_media_cutout(u, 'reject', NULL, NULL, NULL) ->> 'error' <> 'busy' THEN RAISE EXCEPTION 'T11: busy'; END IF;
  PERFORM public.media_cutout_result_ready(u, 'https://fal.media/rerun.png');
  PERFORM public.media_cutout_claim_process(u);
  IF public.media_cutout_finish(u, jsonb_build_object('status','needs_review','flags','["soft_matte:0.12"]'::jsonb,
       'cutout_path','website/derived/aa/r2/cutout.webp','catalog_path','website/derived/aa/r2/catalog.webp')) <> 'kept_published' THEN
    RAISE EXCEPTION 'T11: worse re-run must not replace';
  END IF;
  IF (SELECT status || '/' || cutout_path FROM public.website_media_cutouts WHERE source_url = u) <> 'approved/website/derived/aa/r1/cutout.webp' THEN
    RAISE EXCEPTION 'T11: published version changed';
  END IF;
  -- (each RPC in its own statement: a subquery in the same statement reads the snapshot from before it)
  IF public.review_media_cutout(u, 'use_rerun', NULL, NULL, 'approved') ->> 'status' <> 'approved' THEN RAISE EXCEPTION 'T11: use_rerun'; END IF;
  IF (SELECT cutout_path FROM public.website_media_cutouts WHERE source_url = u) <> 'website/derived/aa/r2/cutout.webp' THEN
    RAISE EXCEPTION 'T11: use_rerun paths';
  END IF;
  -- reject, then a rerun whose result is ok replaces the rejection
  PERFORM public.review_media_cutout(u, 'reject', 'wrong', NULL, NULL);
  PERFORM public.review_media_cutout(u, 'rerun', NULL, NULL, 'rejected');
  PERFORM public.media_cutout_submitted(u, 'fal', 'm', 'req-10', 's', 'r');
  PERFORM public.media_cutout_result_ready(u, 'https://fal.media/rerun3.png');
  PERFORM public.media_cutout_claim_process(u);
  IF public.media_cutout_finish(u, '{"status":"ok","cutout_path":"website/derived/aa/r4/cutout.webp"}') <> 'recorded' THEN RAISE EXCEPTION 'T11: better rerun'; END IF;
  IF (SELECT status FROM public.website_media_cutouts WHERE source_url = u) <> 'ok' THEN RAISE EXCEPTION 'T11: better rerun status'; END IF;
END $t$;

-- ------------------------------------------------ 12. a staff decision is never overwritten by automation; replaced photo = new row
DO $t$
DECLARE u text := pg_temp.u('aaaa.jpg');
BEGIN
  -- rejected by staff, then the worker somehow finishes a job for it: kept
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  PERFORM public.review_media_cutout(u, 'reject', NULL, NULL, NULL);
  UPDATE public.website_media_cutouts SET job_state = 'processing' WHERE source_url = u;
  IF public.media_cutout_finish(u, '{"status":"ok"}') <> 'kept_staff_decision' THEN RAISE EXCEPTION 'T12: decision overwritten'; END IF;
  IF (SELECT status FROM public.website_media_cutouts WHERE source_url = u) <> 'rejected' THEN RAISE EXCEPTION 'T12: decision overwritten (status)'; END IF;
  -- Page365 replaces the photo: page365_inventory_record_photo updates url in place
  UPDATE public.website_product_media SET url = pg_temp.u('page365/1/11-200.jpg'), page365_photo_version = '200'
   WHERE url = pg_temp.u('page365/1/11-100.jpg');
  IF (SELECT job_state || '/' || status FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/11-200.jpg')) <> 'queued/pending' THEN
    RAISE EXCEPTION 'T12: new version not queued';
  END IF;
  IF (SELECT status FROM public.website_media_cutouts WHERE source_url = pg_temp.u('page365/1/11-100.jpg')) <> 'ok' THEN
    RAISE EXCEPTION 'T12: old URL row must be left alone';
  END IF;
END $t$;

-- ------------------------------------------------ 13. CPU kill: first → cut-out only; second → failed
DO $t$
DECLARE u text := pg_temp.u('page365/1/11-200.jpg'); v jsonb;
BEGIN
  UPDATE public.website_media_cutouts SET job_state = 'processing', processing_started_at = now() - interval '6 minutes', result_url = 'https://x'
   WHERE source_url = u;
  PERFORM public.media_cutout_process_batch(5);
  IF (SELECT job_state || '/' || cpu_fallback FROM public.website_media_cutouts WHERE source_url = u) <> 'ready/true' THEN RAISE EXCEPTION 'T13: fallback'; END IF;
  v := public.media_cutout_claim_process(u);
  IF NOT (v ->> 'cpu_fallback')::boolean THEN RAISE EXCEPTION 'T13: claim must carry the fallback'; END IF;
  UPDATE public.website_media_cutouts SET processing_started_at = now() - interval '6 minutes' WHERE source_url = u;
  PERFORM public.media_cutout_process_batch(5);
  IF (SELECT status || '/' || job_state || '/' || flags[1] FROM public.website_media_cutouts WHERE source_url = u) <> 'failed/error/api_error:cpu_limit' THEN
    RAISE EXCEPTION 'T13: second kill must fail';
  END IF;
END $t$;

-- ------------------------------------------------ 14. own cut-out; D7 pairs; orphans kept 30 days
DO $t$
DECLARE u text := pg_temp.u('page365/1/12-100.jpg'); v jsonb; e text;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  IF public.review_media_cutout(u, 'own_cutout', NULL, 'https://evil.example/x.png', NULL) ->> 'error' <> 'invalid_own_cutout_url' THEN
    RAISE EXCEPTION 'T14: own url check';
  END IF;
  v := public.review_media_cutout(u, 'own_cutout', 'better photo', pg_temp.u('derived/own/5f1c.png'), NULL);
  IF (SELECT job_state || '/' || result_url FROM public.website_media_cutouts WHERE source_url = u) <> 'ready/' || pg_temp.u('derived/own/5f1c.png') THEN
    RAISE EXCEPTION 'T14: own ready';
  END IF;
  -- own cut-outs are processed even in test mode without a batch, and never buy a provider call
  UPDATE public.website_media_cutouts SET test_batch = NULL WHERE source_url = u;
  IF NOT public.media_cutout_process_batch(5) @> jsonb_build_array(u) THEN RAISE EXCEPTION 'T14: own must be processed'; END IF;
  PERFORM public.media_cutout_claim_process(u);
  IF public.media_cutout_finish(u, '{"status":"approved","cutout_path":"website/derived/bb/r1/cutout.webp"}') <> 'recorded' THEN RAISE EXCEPTION 'T14: own'; END IF;
  IF (SELECT status FROM public.website_media_cutouts WHERE source_url = u) <> 'approved' THEN RAISE EXCEPTION 'T14: own approved'; END IF;

  -- D7
  INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000003', pg_temp.u('e100.jpg'), 0);
  IF NOT public.media_cutout_allow_pairs(pg_temp.u('e100.jpg')) OR public.media_cutout_allow_pairs(pg_temp.u('aaaa.jpg')) THEN
    RAISE EXCEPTION 'T14: allow_pairs';
  END IF;

  -- orphan: the media row goes away → marked, not forgotten before 30 days
  DELETE FROM public.website_product_media WHERE url = pg_temp.u('e100.jpg');
  PERFORM public.media_cutout_housekeeping(10);
  IF (SELECT orphaned_at FROM public.website_media_cutouts WHERE source_url = pg_temp.u('e100.jpg')) IS NULL THEN RAISE EXCEPTION 'T14: orphan mark'; END IF;
  IF public.media_cutout_forget(pg_temp.u('e100.jpg')) THEN RAISE EXCEPTION 'T14: forgot too early'; END IF;
  UPDATE public.website_media_cutouts SET orphaned_at = now() - interval '31 days' WHERE source_url = pg_temp.u('e100.jpg');
  IF jsonb_array_length(public.media_cutout_housekeeping(10)) <> 1 THEN RAISE EXCEPTION 'T14: due list'; END IF;
  IF NOT public.media_cutout_forget(pg_temp.u('e100.jpg')) THEN RAISE EXCEPTION 'T14: forget'; END IF;
  -- used again → un-marked
  UPDATE public.website_media_cutouts SET orphaned_at = now() WHERE source_url = pg_temp.u('aaaa.jpg');
  PERFORM public.media_cutout_housekeeping(10);
  IF (SELECT orphaned_at FROM public.website_media_cutouts WHERE source_url = pg_temp.u('aaaa.jpg')) IS NOT NULL THEN RAISE EXCEPTION 'T14: un-mark'; END IF;
END $t$;

-- ------------------------------------------------ 15. Hub reads; browser roles cannot reach the worker's functions
DO $t$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.get_media_cutout_overview();
  IF v ->> 'mode' <> 'test' OR (v ->> 'cap')::int <> 100 OR (v ->> 'used')::int < 5 THEN RAISE EXCEPTION 'T15: overview %', v; END IF;
  v := public.list_media_cutouts('published', 'al123', 50, 0);
  IF (v ->> 'total')::int <> 1 OR (v -> 'rows' -> 0 -> 'product' ->> 'sku') <> 'AL123' OR (v -> 'rows' -> 0) ? 'provider_status_url' THEN
    RAISE EXCEPTION 'T15: list %', v;
  END IF;
  IF public.list_media_cutouts('bogus', NULL, 10, 0) ->> 'error' <> 'invalid_filter' THEN RAISE EXCEPTION 'T15: filter'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  IF public.get_media_cutout_overview() ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'T15: perm'; END IF;
  IF has_function_privilege('authenticated', 'public.media_cutout_finish(text,jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'T15: grant'; END IF;
END $t$;

-- ------------------------------------------------ 16. a media write can never be failed by the enqueue
DO $t$ BEGIN
  ALTER TABLE public.website_media_cutouts ADD CONSTRAINT t16_block CHECK (source_url NOT LIKE '%blocked%');
  INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000002', pg_temp.u('blocked.jpg'), 3);
  IF NOT EXISTS (SELECT 1 FROM public.website_product_media WHERE url = pg_temp.u('blocked.jpg')) THEN RAISE EXCEPTION 'T16: media write lost'; END IF;
  ALTER TABLE public.website_media_cutouts DROP CONSTRAINT t16_block;
END $t$;

SELECT 'ALL PASSED' AS media_cutouts_local_tests;
