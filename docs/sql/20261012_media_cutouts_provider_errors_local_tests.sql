-- ============================================================================
-- Media cut-outs PROVIDER ERRORS — LOCAL tests for
-- 20261012100000_media_cutouts_provider_errors.sql. NEVER ON LIVE.
--
-- In an EMPTY throwaway Postgres (stub + 20261006 + 20261007 + 20261010 +
-- 20261011 + 20261012, then this file).
-- ~/Code/reference/media-cutouts/provider-errors/run-sql-tests.sh does it all.
-- Every block raises on failure; the last line prints ALL PASSED.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

-- ---------------------------------------------------------------- fixtures
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'admin'),
                                     ('00000000-0000-0000-0000-00000000000b', 'staff');
INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-00000000000b', 'manage_website_catalog');
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'PUB',   'pub',   'Published ring', 'active'),
  ('b0000000-0000-0000-0000-000000000002', 'DRAFT', 'draft', 'Draft ring',     'draft');
INSERT INTO public.website_product_variants (id, product_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;
CREATE FUNCTION pg_temp.row_of(p text) RETURNS public.website_media_cutouts LANGUAGE sql AS
  $$ SELECT * FROM public.website_media_cutouts WHERE source_url = pg_temp.u(p) $$;
CREATE FUNCTION pg_temp.st(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT job_state || '/' || status || '/' || paid_calls FROM public.website_media_cutouts WHERE source_url = pg_temp.u(p) $$;
CREATE FUNCTION pg_temp.pub(p text) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000001', pg_temp.u(p), 0) $$;
CREATE FUNCTION pg_temp.draft(p text) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000002', pg_temp.u(p), 0) $$;
-- The worker picks the photo (submit_batch) — as it does before every submit.
CREATE FUNCTION pg_temp.pick(p text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b jsonb;
BEGIN
  UPDATE public.website_media_cutouts SET next_attempt_at = now() - interval '1 second' WHERE source_url = pg_temp.u(p);
  b := public.media_cutout_submit_batch(20);
  RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(b -> 'rows') x WHERE x ->> 'source_url' = pg_temp.u(p));
END $$;
CREATE FUNCTION pg_temp.err(p text, stage text, e text, retry boolean) RETURNS text LANGUAGE sql AS
  $$ SELECT public.media_cutout_error(pg_temp.u(p), stage, e, retry) $$;
CREATE FUNCTION pg_temp.expect(label text, got text, want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '%: expected %, got %', label, want, got; END IF;
END $$;

DO $t$ BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.set_media_cutout_settings('on', 1000, NULL);
  PERFORM public.set_media_cutout_provider('replicate', 0.004, NULL);
END $t$;

-- ------------------------------------------------ E1. the classifier
DO $t$
DECLARE
  d constant text := 'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/a/photoroom.png';
  x constant text := 'https://replicate.delivery/xezq/abc/out.png';
BEGIN
  PERFORM pg_temp.expect('402 photoroom', public.media_cutout_error_kind('submit', 'photoroom: HTTP 402 {"detail":"You have exhausted the number of images in your plan"}'), 'account');
  PERFORM pg_temp.expect('402 flags form', public.media_cutout_error_kind(NULL, 'api_error:photoroom HTTP 402 detailYou have exhausted the n'), 'account');
  PERFORM pg_temp.expect('401', public.media_cutout_error_kind('submit', 'replicate submit: HTTP 401 {"detail":"Invalid token"}'), 'account');
  PERFORM pg_temp.expect('403', public.media_cutout_error_kind('submit', 'photoroom: HTTP 403 forbidden'), 'account');
  PERFORM pg_temp.expect('429', public.media_cutout_error_kind('submit', 'fal submit: HTTP 429 rate'), 'account');
  PERFORM pg_temp.expect('402 replicate', public.media_cutout_error_kind('submit', 'replicate submit: HTTP 402 {"title":"Insufficient credit"}'), 'account');
  PERFORM pg_temp.expect('404 version', public.media_cutout_error_kind('submit', 'replicate submit: HTTP 404 {"detail":"version not found"}'), 'account');
  PERFORM pg_temp.expect('no secret (poll)', public.media_cutout_error_kind('poll', 'provider replicate not configured'), 'account');
  PERFORM pg_temp.expect('no provider', public.media_cutout_error_kind('submit', 'no provider configured (PHOTOROOM_API_KEY not set)'), 'account');
  PERFORM pg_temp.expect('5xx', public.media_cutout_error_kind('submit', 'photoroom: HTTP 503 upstream'), 'provider');
  PERFORM pg_temp.expect('5xx status', public.media_cutout_error_kind('poll', 'replicate status: HTTP 500 oops'), 'provider');
  PERFORM pg_temp.expect('status 404', public.media_cutout_error_kind('poll', 'replicate status: HTTP 404 not found'), 'result_expired');
  PERFORM pg_temp.expect('fal result 410', public.media_cutout_error_kind('poll', 'fal result: HTTP 410 gone'), 'result_expired');
  PERFORM pg_temp.expect('download expired', public.media_cutout_error_kind('process', 'download 404', x), 'result_expired');
  PERFORM pg_temp.expect('download 403 expired', public.media_cutout_error_kind('process', 'download 403', x), 'result_expired');
  PERFORM pg_temp.expect('download ours', public.media_cutout_error_kind('process', 'download 404', d), 'photo');
  PERFORM pg_temp.expect('download at submit', public.media_cutout_error_kind('submit', 'download 404', x), 'photo');
  PERFORM pg_temp.expect('download no result', public.media_cutout_error_kind('process', 'download 404', NULL), 'photo');
  PERFORM pg_temp.expect('400 bad input', public.media_cutout_error_kind('submit', 'photoroom: HTTP 400 {"detail":"image too large"}'), 'photo');
  PERFORM pg_temp.expect('422', public.media_cutout_error_kind('submit', 'replicate submit: HTTP 422 invalid input'), 'photo');
  PERFORM pg_temp.expect('model failed', public.media_cutout_error_kind('poll', 'replicate: failed CUDA error'), 'photo');
  PERFORM pg_temp.expect('decode', public.media_cutout_error_kind('process', 'decode failed: not a PNG'), 'photo');
  PERFORM pg_temp.expect('storage', public.media_cutout_error_kind('submit', 'storage upload: 503'), 'photo');
  PERFORM pg_temp.expect('timeout', public.media_cutout_error_kind('submit', 'photoroom: no answer within 60 s'), 'photo');
  PERFORM pg_temp.expect('null', public.media_cutout_error_kind('submit', NULL), 'photo');
  PERFORM pg_temp.expect('not a prefix', public.media_cutout_error_kind('submit', 'decode failed near photoroom: HTTP 402'), 'photo');
END $t$;

-- ------------------------------------------------ E2. a 402 on a PUBLISHED photo: back to the queue, never Failed, no paid call
DO $t$
DECLARE r public.website_media_cutouts;
BEGIN
  PERFORM pg_temp.pub('e/pub-402.jpg');
  PERFORM pg_temp.expect('E2 queued', pg_temp.st('e/pub-402.jpg'), 'queued/pending/0');
  FOR i IN 1..5 LOOP
    IF NOT pg_temp.pick('e/pub-402.jpg') THEN RAISE EXCEPTION 'E2: not handed out (round %)', i; END IF;
    PERFORM pg_temp.expect('E2 returned ' || i,
      pg_temp.err('e/pub-402.jpg', 'submit', 'photoroom: HTTP 402 {"detail":"You have exhausted the number of images in your plan"}', true), 'returned');
    PERFORM pg_temp.expect('E2 state ' || i, pg_temp.st('e/pub-402.jpg'), 'queued/pending/0');
  END LOOP;
  r := pg_temp.row_of('e/pub-402.jpg');
  PERFORM pg_temp.expect('E2 attempts untouched', r.attempts::text, '0');
  PERFORM pg_temp.expect('E2 provider_errors', r.provider_errors::text, '5');
  IF r.next_attempt_at < now() + interval '2 hours 59 minutes' THEN RAISE EXCEPTION 'E2: backoff should be 3 h by now'; END IF;
  IF r.hold_reason IS NOT NULL OR r.last_error NOT LIKE 'photoroom: HTTP 402%' THEN RAISE EXCEPTION 'E2: reason'; END IF;
  -- five 402s later it is still sendable: the cap was not burnt
  IF NOT pg_temp.pick('e/pub-402.jpg') THEN RAISE EXCEPTION 'E2: still sendable'; END IF;
  -- and it can still be cut normally
  PERFORM public.media_cutout_submitted(pg_temp.u('e/pub-402.jpg'), 'replicate', 'm', 'req', 'https://api.replicate.com/s', 'https://api.replicate.com/s');
  PERFORM pg_temp.expect('E2 then a real call counts', pg_temp.st('e/pub-402.jpg'), 'submitted/pending/1');
END $t$;

-- ------------------------------------------------ E3. a 402 on an UNPUBLISHED photo the worker had in hand → Waiting for publish
DO $t$ BEGIN
  PERFORM pg_temp.pub('e/unpub-402.jpg');
  IF NOT pg_temp.pick('e/unpub-402.jpg') THEN RAISE EXCEPTION 'E3: not handed out'; END IF;
  -- unpublished while the worker holds it
  DELETE FROM public.website_product_media WHERE url = pg_temp.u('e/unpub-402.jpg');
  PERFORM pg_temp.draft('e/unpub-402.jpg');
  PERFORM pg_temp.expect('E3', pg_temp.err('e/unpub-402.jpg', 'submit', 'replicate submit: HTTP 402 {"title":"Insufficient credit"}', false), 'returned');
  PERFORM pg_temp.expect('E3 waiting', pg_temp.st('e/unpub-402.jpg'), 'waiting/pending/0');
END $t$;

-- ------------------------------------------------ E4. 5xx: returned, but counted (#235); at the limit → Needs owner, never Failed
DO $t$ BEGIN
  PERFORM pg_temp.pub('e/pub-503.jpg');
  PERFORM pg_temp.pick('e/pub-503.jpg');
  PERFORM pg_temp.expect('E4 1', pg_temp.err('e/pub-503.jpg', 'submit', 'photoroom: HTTP 503 upstream', true), 'returned');
  PERFORM pg_temp.expect('E4 1 state', pg_temp.st('e/pub-503.jpg'), 'queued/pending/1');
  PERFORM pg_temp.pick('e/pub-503.jpg');
  PERFORM pg_temp.expect('E4 2', pg_temp.err('e/pub-503.jpg', 'submit', 'photoroom: HTTP 502 bad gateway', true), 'held');
  PERFORM pg_temp.expect('E4 2 state', pg_temp.st('e/pub-503.jpg'), 'error/pending/2');
  IF (pg_temp.row_of('e/pub-503.jpg')).hold_reason NOT LIKE '%provider or the account, not the photo%' THEN
    RAISE EXCEPTION 'E4: reason';
  END IF;
END $t$;

-- ------------------------------------------------ E5. poll: no provider secret → stays at the provider step
DO $t$ BEGIN
  PERFORM pg_temp.pub('e/poll.jpg');
  PERFORM pg_temp.pick('e/poll.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('e/poll.jpg'), 'replicate', 'm', 'req', 'https://api.replicate.com/s', 'https://api.replicate.com/s');
  FOR i IN 1..4 LOOP
    PERFORM pg_temp.expect('E5 ' || i, pg_temp.err('e/poll.jpg', 'poll', 'provider replicate not configured', false), 'returned');
  END LOOP;
  PERFORM pg_temp.expect('E5 state', pg_temp.st('e/poll.jpg'), 'submitted/pending/1');
  -- the provider's 5xx on status: same
  PERFORM pg_temp.expect('E5 5xx', pg_temp.err('e/poll.jpg', 'poll', 'replicate status: HTTP 500 oops', true), 'returned');
  PERFORM pg_temp.expect('E5 5xx state', pg_temp.st('e/poll.jpg'), 'submitted/pending/1');
END $t$;

-- ------------------------------------------------ E6. result expired (process): sent again — published → queue, 1 paid call kept
DO $t$ BEGIN
  PERFORM pg_temp.pub('e/expired.jpg');
  PERFORM pg_temp.pick('e/expired.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('e/expired.jpg'), 'replicate', 'm', 'req', 'https://api.replicate.com/s', 'https://api.replicate.com/s');
  PERFORM public.media_cutout_result_ready(pg_temp.u('e/expired.jpg'), 'https://replicate.delivery/xezq/e/out.png');
  PERFORM public.media_cutout_claim_process(pg_temp.u('e/expired.jpg'));
  PERFORM pg_temp.expect('E6', pg_temp.err('e/expired.jpg', 'process', 'download 404', false), 'returned');
  PERFORM pg_temp.expect('E6 state', pg_temp.st('e/expired.jpg'), 'queued/pending/1');
  IF NOT pg_temp.pick('e/expired.jpg') THEN RAISE EXCEPTION 'E6: one paid call left — it must be sendable'; END IF;
  -- its second (and last) call also expires → Needs owner (the limit), never Failed
  PERFORM public.media_cutout_submitted(pg_temp.u('e/expired.jpg'), 'replicate', 'm', 'req2', 'https://api.replicate.com/s', 'https://api.replicate.com/s');
  PERFORM public.media_cutout_result_ready(pg_temp.u('e/expired.jpg'), 'https://replicate.delivery/xezq/e2/out.png');
  PERFORM public.media_cutout_claim_process(pg_temp.u('e/expired.jpg'));
  PERFORM pg_temp.expect('E6 at limit', pg_temp.err('e/expired.jpg', 'poll', 'replicate status: HTTP 404', false), 'held');
  PERFORM pg_temp.expect('E6 held', pg_temp.st('e/expired.jpg'), 'error/pending/2');
END $t$;

-- ------------------------------------------------ E7. photo errors are unchanged: Failed after their tries
DO $t$ BEGIN
  PERFORM pg_temp.pub('e/photo.jpg');
  PERFORM pg_temp.pick('e/photo.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('e/photo.jpg'), 'replicate', 'm', 'req', 'https://api.replicate.com/s', 'https://api.replicate.com/s');
  PERFORM public.media_cutout_result_ready(pg_temp.u('e/photo.jpg'),
    'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/p/photoroom.png');
  PERFORM public.media_cutout_claim_process(pg_temp.u('e/photo.jpg'));
  -- our own derived file missing: not the provider
  PERFORM pg_temp.expect('E7', pg_temp.err('e/photo.jpg', 'process', 'download 404', false), 'failed');
  PERFORM pg_temp.expect('E7 state', pg_temp.st('e/photo.jpg'), 'error/failed/1');
  PERFORM pg_temp.pub('e/photo2.jpg');
  PERFORM pg_temp.pick('e/photo2.jpg');
  PERFORM pg_temp.expect('E7 bad input', pg_temp.err('e/photo2.jpg', 'submit', 'photoroom: HTTP 400 {"detail":"image too small"}', false), 'failed');
  PERFORM pg_temp.expect('E7 bad input counts (#235)', pg_temp.st('e/photo2.jpg'), 'error/failed/1');
END $t$;

-- ------------------------------------------------ E8. a staff decision taken while the worker held it: kept; a 402 costs nothing
DO $t$ BEGIN
  PERFORM pg_temp.pub('e/decided.jpg');
  PERFORM pg_temp.pick('e/decided.jpg');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  PERFORM public.review_media_cutout(pg_temp.u('e/decided.jpg'), 'keep_original', 'shop photo is fine');
  PERFORM pg_temp.expect('E8 402', pg_temp.err('e/decided.jpg', 'submit', 'photoroom: HTTP 402 x', false), 'kept_decision');
  PERFORM pg_temp.expect('E8 state', pg_temp.st('e/decided.jpg'), 'done/kept_original/0');
  PERFORM pg_temp.expect('E8 5xx counts', pg_temp.err('e/decided.jpg', 'submit', 'photoroom: HTTP 500 x', false), 'kept_decision');
  PERFORM pg_temp.expect('E8 state 2', pg_temp.st('e/decided.jpg'), 'done/kept_original/1');
END $t$;

-- ------------------------------------------------ E9. the Photos card: published products only; Failed = photo problems
DO $t$
DECLARE l jsonb; t jsonb;
BEGIN
  -- a genuine failure on an UNPUBLISHED product
  PERFORM pg_temp.draft('e/draft-photo.jpg');
  PERFORM set_config('app.media_cutout_owner_override', 'on', false);
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed', last_error = 'decode failed', attempts = 4
   WHERE source_url = pg_temp.u('e/draft-photo.jpg');
  PERFORM set_config('app.media_cutout_owner_override', '', false);
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  l := public.list_media_cutouts('failed', NULL, 50, 0);
  PERFORM pg_temp.expect('E9 failed count', l ->> 'total', '2');
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(l -> 'rows') x WHERE NOT (x ->> 'published')::boolean) THEN
    RAISE EXCEPTION 'E9: an unpublished photo is listed';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(l -> 'rows') x WHERE x ->> 'error_kind' <> 'photo') THEN
    RAISE EXCEPTION 'E9: Failed lists a provider error';
  END IF;
  -- 'all' hides every unpublished photo; 'waiting' still answers for SQL use
  l := public.list_media_cutouts('all', NULL, 200, 0);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(l -> 'rows') x WHERE NOT (x ->> 'published')::boolean) THEN
    RAISE EXCEPTION 'E9: all lists an unpublished photo';
  END IF;
  PERFORM pg_temp.expect('E9 all = published', l ->> 'total',
    (SELECT count(*)::text FROM public.website_media_cutouts WHERE orphaned_at IS NULL AND public.media_cutout_url_published(source_url)));
  PERFORM pg_temp.expect('E9 waiting', public.list_media_cutouts('waiting', NULL, 50, 0) ->> 'total', '1');
  t := public.get_media_cutout_tab_totals();
  PERFORM pg_temp.expect('E9 tab failed', t #>> '{tabs,failed,count}', '2');
  PERFORM pg_temp.expect('E9 tab all', t #>> '{tabs,all,count}', l ->> 'total');
  PERFORM pg_temp.expect('E9 tab waiting (SQL only)', t #>> '{tabs,waiting,count}', '1');
  PERFORM pg_temp.expect('E9 flag', t ->> 'published_only', 'true');
  -- a photo returned after a 402 is in the queue tab, labelled 'account'
  PERFORM pg_temp.pub('e/queue-402.jpg');
  PERFORM pg_temp.pick('e/queue-402.jpg');
  PERFORM pg_temp.err('e/queue-402.jpg', 'submit', 'photoroom: HTTP 402 {"detail":"exhausted"}', true);
  l := public.list_media_cutouts('queue', NULL, 50, 0);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l -> 'rows') x
                  WHERE x ->> 'source_url' = pg_temp.u('e/queue-402.jpg') AND x ->> 'error_kind' = 'account') THEN
    RAISE EXCEPTION 'E9: the returned photo is not in the queue tab as account';
  END IF;
  PERFORM pg_temp.expect('E9 no permission', (SELECT public.list_media_cutouts('failed') ->> 'error'
                                                FROM (SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000ff')) s), 'permission_denied');
END $t$;

-- ------------------------------------------------ E10. grants
DO $t$ BEGIN
  IF has_function_privilege('authenticated', 'public.media_cutout_error_kind(text,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_media_cutout_tab_totals()', 'EXECUTE') THEN
    RAISE EXCEPTION 'E10: grants';
  END IF;
  -- the invariant, over everything this suite did
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE status = 'failed' AND hold_reason IS NULL
                AND public.media_cutout_error_kind(NULL, last_error, result_url) <> 'photo') THEN
    RAISE EXCEPTION 'E10: a provider error is Failed';
  END IF;
END $t$;

SELECT 'ALL PASSED' AS media_cutouts_provider_errors_local_tests;
