-- ============================================================================
-- Media cut-outs "cut once" — LOCAL tests for
-- 20261010100000_media_cutouts_cut_once.sql. NEVER ON LIVE.
--
-- In an EMPTY throwaway Postgres:
--   export PGOPTIONS='-c cutout.local_stub=yes'
--   $P docs/sql/20261005_media_cutouts_local_stub.sql
--   $P supabase/migrations/20261006100000_media_cutouts.sql
--   $P supabase/migrations/20261007100000_media_cutout_photoroom.sql
--   $P supabase/migrations/20261010100000_media_cutouts_cut_once.sql
--   $P supabase/migrations/20261010100000_media_cutouts_cut_once.sql   # re-run
--   $P docs/sql/20261010_media_cutouts_cut_once_local_tests.sql
-- (~/Code/reference/media-cutouts/cut-once/run-sql-tests.sh does all of it.)
--
-- The PR 1 suite (20261005_media_cutouts_local_tests.sql) describes the rules
-- BEFORE this migration — plain staff re-runs of approved / rejected photos,
-- 1 try + 3 paid retries. Those are exactly what the owner's rule replaces, so
-- that suite is run BEFORE this migration as the baseline; the behaviours it
-- proves that did NOT change (staff decisions kept, CPU-kill fallback, own
-- cut-outs, orphans, the enqueue never failing a media write) are re-proven
-- here AFTER it (C12–C15).
--
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
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'R1', 'r1', 'Ring one', 'active'),
  ('b0000000-0000-0000-0000-000000000002', 'N2', 'n2', 'Fine chain necklace', 'active');
INSERT INTO public.website_product_variants (id, product_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;
CREATE FUNCTION pg_temp.row_of(p text) RETURNS public.website_media_cutouts LANGUAGE sql AS
  $$ SELECT * FROM public.website_media_cutouts WHERE source_url = pg_temp.u(p) $$;
-- Walk one photo through a successful provider round to a verdict.
CREATE FUNCTION pg_temp.cut(p text, verdict text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.media_cutout_submitted(pg_temp.u(p), 'replicate', 'men1scus/birefnet:f74986db0355', 'req-' || p, 's', 'r');
  PERFORM public.media_cutout_result_ready(pg_temp.u(p), 'https://replicate.delivery/x/' || p || '.png');
  PERFORM public.media_cutout_claim_process(pg_temp.u(p));
  RETURN public.media_cutout_finish(pg_temp.u(p), jsonb_build_object('status', verdict,
    'cutout_path', 'website/derived/' || p || '/cutout.webp', 'catalog_path', 'website/derived/' || p || '/catalog.webp'));
END $$;
-- Is this photo in the next submit batch?
CREATE FUNCTION pg_temp.handed(p text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b jsonb;
BEGIN
  UPDATE public.website_media_cutouts SET next_attempt_at = now() - interval '1 second' WHERE job_state = 'queued';
  b := public.media_cutout_submit_batch(20);
  RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(b -> 'rows') x WHERE x ->> 'source_url' = pg_temp.u(p));
END $$;
-- The statement must fail with this message fragment.
CREATE FUNCTION pg_temp.refused(sql text, frag text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%' || frag || '%' THEN RAISE EXCEPTION 'expected "%", got "%"', frag, SQLERRM; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'not refused: %', sql;
END $$;

-- Switch on in TEST (batch only), provider Replicate at $0.005, cap 100.
DO $t$ BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.set_media_cutout_settings('test', 100, NULL);
  PERFORM public.set_media_cutout_provider('replicate', 0.005, NULL);
END $t$;

INSERT INTO public.website_product_media (variant_id, url, sort) VALUES
  ('d0000000-0000-0000-0000-000000000001', pg_temp.u('c/done.jpg'), 0),
  ('d0000000-0000-0000-0000-000000000001', pg_temp.u('c/reject.jpg'), 1),
  ('d0000000-0000-0000-0000-000000000001', pg_temp.u('c/cap.jpg'), 2),
  ('d0000000-0000-0000-0000-000000000002', pg_temp.u('c/poll.jpg'), 0),
  ('d0000000-0000-0000-0000-000000000002', pg_temp.u('c/timeout.jpg'), 1),
  ('d0000000-0000-0000-0000-000000000002', pg_temp.u('c/sync.jpg'), 2),
  ('d0000000-0000-0000-0000-000000000002', pg_temp.u('c/own.jpg'), 3);
UPDATE public.website_media_cutouts SET test_batch = 'T' WHERE source_url LIKE '%/c/%';

-- ------------------------------------------------ C1. a new photo: 0 paid calls, limit 2, no permission, not held
DO $t$ BEGIN
  IF (SELECT count(*) FROM public.website_media_cutouts
       WHERE paid_calls = 0 AND paid_call_limit = 2 AND NOT recut_allowed AND hold_reason IS NULL AND job_state = 'queued') <> 7 THEN
    RAISE EXCEPTION 'C1: new rows';
  END IF;
END $t$;

-- ------------------------------------------------ C2. Completed is locked: no queue, no send, no plain re-run
DO $t$
DECLARE v jsonb;
BEGIN
  IF NOT pg_temp.handed('c/done.jpg') THEN RAISE EXCEPTION 'C2: a new photo must be sent'; END IF;
  IF pg_temp.cut('c/done.jpg', 'ok') <> 'recorded' THEN RAISE EXCEPTION 'C2: cut'; END IF;
  IF (pg_temp.row_of('c/done.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'C2: one paid call'; END IF;
  -- the database itself refuses, whoever writes (this runs as the superuser)
  PERFORM pg_temp.refused($$UPDATE public.website_media_cutouts SET job_state = 'queued'
                            WHERE source_url = pg_temp.u('c/done.jpg')$$, 'locked');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.review_media_cutout(pg_temp.u('c/done.jpg'), 'rerun', NULL, NULL, NULL);
  IF v ->> 'error' <> 'locked' THEN RAISE EXCEPTION 'C2: plain re-run must be refused, got %', v; END IF;
  v := public.review_media_cutout(pg_temp.u('c/done.jpg'), 'rerun_high_detail', NULL, NULL, NULL);
  IF v ->> 'error' <> 'locked' THEN RAISE EXCEPTION 'C2: high-detail re-run must be refused'; END IF;
  v := public.review_media_cutout(pg_temp.u('c/done.jpg'), 'unlock_recut', NULL, NULL, NULL);
  IF v ->> 'error' <> 'admin_only' THEN RAISE EXCEPTION 'C2: unlock is admin only, got %', v; END IF;
  -- approve locks it too (still no send)
  v := public.review_media_cutout(pg_temp.u('c/done.jpg'), 'approve', NULL, NULL, 'ok');
  IF v ->> 'status' <> 'approved' THEN RAISE EXCEPTION 'C2: approve'; END IF;
  IF pg_temp.handed('c/done.jpg') THEN RAISE EXCEPTION 'C2: a completed photo was handed out'; END IF;
  -- a test batch never re-queues it
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.add_media_cutout_test_batch(ARRAY['R1'], 'T2', false);
  IF (pg_temp.row_of('c/done.jpg')).job_state <> 'done' THEN RAISE EXCEPTION 'C2: a test batch re-queued a completed photo'; END IF;
  -- the media row saved again (the Catalog save re-inserts it) never re-queues it
  DELETE FROM public.website_product_media WHERE url = pg_temp.u('c/done.jpg');
  INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000001', pg_temp.u('c/done.jpg'), 0);
  IF (pg_temp.row_of('c/done.jpg')).job_state <> 'done' OR (pg_temp.row_of('c/done.jpg')).status <> 'approved' THEN
    RAISE EXCEPTION 'C2: re-saving the photo re-queued it';
  END IF;
END $t$;

-- ------------------------------------------------ C3. Unlock and re-cut (admin): exactly ONE paid call, audited with the cost
DO $t$
DECLARE v jsonb; a jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  v := public.review_media_cutout(pg_temp.u('c/done.jpg'), 'unlock_recut', 'owner wants another try', NULL, 'approved');
  IF v ->> 'ok' IS NULL THEN RAISE EXCEPTION 'C3: unlock %', v; END IF;
  IF (SELECT job_state || '/' || recut_allowed || '/' || paid_calls || '/' || paid_call_limit || '/' || rerun
        FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/done.jpg')) <> 'queued/true/1/2/true' THEN
    RAISE EXCEPTION 'C3: unlocked state %', (SELECT row_to_json(r) FROM pg_temp.row_of('c/done.jpg') r);
  END IF;
  SELECT new_value_json INTO a FROM public.audit_logs WHERE action = 'review_media_cutout:unlock_recut' ORDER BY created_at DESC LIMIT 1;
  IF a IS NULL OR (a ->> 'estimated_cost_usd')::numeric <> 0.005 OR (a ->> 'paid_calls_allowed')::int <> 1
     OR (a ->> 'paid_call_limit')::int <> 2 THEN
    RAISE EXCEPTION 'C3: audit row %', a;
  END IF;
  IF NOT pg_temp.handed('c/done.jpg') THEN RAISE EXCEPTION 'C3: the unlocked photo must be sent'; END IF;
  -- its one call fails at submit: counted, NOT retried (it was the only call allowed) → Needs owner
  IF public.media_cutout_error(pg_temp.u('c/done.jpg'), 'submit', 'HTTP 500', true) <> 'held' THEN RAISE EXCEPTION 'C3: must hold'; END IF;
  IF (SELECT paid_calls || '/' || job_state || '/' || recut_allowed || '/' || status FROM public.website_media_cutouts
       WHERE source_url = pg_temp.u('c/done.jpg')) <> '2/error/false/approved' THEN
    RAISE EXCEPTION 'C3: after the failed call %', (SELECT row_to_json(r) FROM pg_temp.row_of('c/done.jpg') r);
  END IF;
  IF (pg_temp.row_of('c/done.jpg')).hold_reason NOT LIKE 'Stopped after 2 paid calls%' THEN RAISE EXCEPTION 'C3: reason'; END IF;
  IF pg_temp.handed('c/done.jpg') THEN RAISE EXCEPTION 'C3: a held photo was handed out'; END IF;
END $t$;

-- ------------------------------------------------ C4. Rejected is locked; Try once more (admin) = one paid call; own cut-out is free
DO $t$
DECLARE v jsonb; b jsonb;
BEGIN
  PERFORM pg_temp.handed('c/reject.jpg');
  PERFORM pg_temp.cut('c/reject.jpg', 'needs_review');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'reject', 'chain broken', NULL, 'needs_review');
  IF v ->> 'status' <> 'rejected' THEN RAISE EXCEPTION 'C4: reject'; END IF;
  IF public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'rerun', NULL, NULL, NULL) ->> 'error' <> 'locked' THEN RAISE EXCEPTION 'C4: rerun'; END IF;
  IF public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'retry_once', NULL, NULL, NULL) ->> 'error' <> 'admin_only' THEN RAISE EXCEPTION 'C4: admin'; END IF;
  PERFORM pg_temp.refused($$UPDATE public.website_media_cutouts SET job_state = 'queued'
                            WHERE source_url = pg_temp.u('c/reject.jpg')$$, 'locked');
  IF pg_temp.handed('c/reject.jpg') THEN RAISE EXCEPTION 'C4: a rejected photo was handed out'; END IF;
  -- unlock_recut is for Completed only; retry_once for Rejected only
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  IF public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'unlock_recut', NULL, NULL, NULL) ->> 'error' <> 'not_completed' THEN RAISE EXCEPTION 'C4: wrong action'; END IF;
  v := public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'retry_once', NULL, NULL, 'rejected');
  IF v ->> 'ok' IS NULL THEN RAISE EXCEPTION 'C4: retry_once %', v; END IF;
  IF (pg_temp.row_of('c/reject.jpg')).paid_call_limit <> 2 OR NOT (pg_temp.row_of('c/reject.jpg')).recut_allowed THEN RAISE EXCEPTION 'C4: grant'; END IF;
  IF NOT pg_temp.handed('c/reject.jpg') THEN RAISE EXCEPTION 'C4: must be sent once'; END IF;
  IF pg_temp.cut('c/reject.jpg', 'ok') <> 'recorded' THEN RAISE EXCEPTION 'C4: the retry result replaces the rejection'; END IF;
  IF (SELECT status || '/' || paid_calls || '/' || recut_allowed FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/reject.jpg'))
     <> 'ok/2/false' THEN RAISE EXCEPTION 'C4: after retry'; END IF;
  -- reject again: now at the limit; own cut-out is still allowed and free
  PERFORM public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'reject', NULL, NULL, NULL);
  v := public.review_media_cutout(pg_temp.u('c/reject.jpg'), 'own_cutout', NULL, pg_temp.u('derived/own/abc.png'), 'rejected');
  IF v ->> 'ok' IS NULL THEN RAISE EXCEPTION 'C4: own cut-out on a rejected photo %', v; END IF;
  PERFORM public.media_cutout_claim_process(pg_temp.u('c/reject.jpg'));
  IF public.media_cutout_finish(pg_temp.u('c/reject.jpg'), '{"status":"approved","cutout_path":"website/derived/own/x/cutout.webp"}') <> 'recorded' THEN
    RAISE EXCEPTION 'C4: own';
  END IF;
  IF (SELECT status || '/' || paid_calls FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/reject.jpg')) <> 'approved/2' THEN
    RAISE EXCEPTION 'C4: own cut-out must cost nothing';
  END IF;
  -- the monthly counter counts real provider calls only (3 so far: done, reject x2)
  IF (SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()) <> 3 THEN
    RAISE EXCEPTION 'C4: monthly counter %', (SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month());
  END IF;
END $t$;

-- ------------------------------------------------ C5. the per-photo cap: failed submits count; 2 → Needs owner; admin override lifts it once
DO $t$
DECLARE v jsonb;
BEGIN
  IF NOT pg_temp.handed('c/cap.jpg') THEN RAISE EXCEPTION 'C5: send 1'; END IF;
  IF public.media_cutout_error(pg_temp.u('c/cap.jpg'), 'submit', 'HTTP 502', true) <> 'retry' THEN RAISE EXCEPTION 'C5: first failure retries'; END IF;
  IF (pg_temp.row_of('c/cap.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'C5: a failed submit is a paid call'; END IF;
  IF NOT pg_temp.handed('c/cap.jpg') THEN RAISE EXCEPTION 'C5: send 2'; END IF;
  IF public.media_cutout_error(pg_temp.u('c/cap.jpg'), 'submit', 'HTTP 502', true) <> 'held' THEN RAISE EXCEPTION 'C5: second failure holds'; END IF;
  IF (SELECT paid_calls || '/' || job_state || '/' || status FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/cap.jpg'))
     <> '2/error/failed' THEN RAISE EXCEPTION 'C5: held row'; END IF;
  IF pg_temp.handed('c/cap.jpg') THEN RAISE EXCEPTION 'C5: a capped photo was handed out'; END IF;
  PERFORM pg_temp.refused($$UPDATE public.website_media_cutouts SET job_state = 'queued', hold_reason = NULL
                            WHERE source_url = pg_temp.u('c/cap.jpg')$$, 'paid calls');
  PERFORM pg_temp.refused($$UPDATE public.website_media_cutouts SET paid_call_limit = 3
                            WHERE source_url = pg_temp.u('c/cap.jpg')$$, 'only an admin action');
  PERFORM pg_temp.refused($$UPDATE public.website_media_cutouts SET paid_calls = 0
                            WHERE source_url = pg_temp.u('c/cap.jpg')$$, 'never go down');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.review_media_cutout(pg_temp.u('c/cap.jpg'), 'rerun', NULL, NULL, NULL);
  IF v ->> 'error' <> 'needs_owner' THEN RAISE EXCEPTION 'C5: staff re-run must be refused, got %', v; END IF;
  IF public.review_media_cutout(pg_temp.u('c/cap.jpg'), 'override_cap', NULL, NULL, NULL) ->> 'error' <> 'admin_only' THEN RAISE EXCEPTION 'C5: admin'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  v := public.review_media_cutout(pg_temp.u('c/cap.jpg'), 'override_cap', 'one more', NULL, 'failed');
  IF v ->> 'status' <> 'pending' THEN RAISE EXCEPTION 'C5: override %', v; END IF;
  IF (SELECT paid_call_limit || '/' || job_state || '/' || coalesce(hold_reason, '-') FROM public.website_media_cutouts
       WHERE source_url = pg_temp.u('c/cap.jpg')) <> '3/queued/-' THEN RAISE EXCEPTION 'C5: after override'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'review_media_cutout:override_cap'
                   AND (new_value_json ->> 'estimated_cost_usd')::numeric = 0.005) THEN RAISE EXCEPTION 'C5: audit'; END IF;
  IF NOT pg_temp.handed('c/cap.jpg') THEN RAISE EXCEPTION 'C5: send 3'; END IF;
  IF public.media_cutout_error(pg_temp.u('c/cap.jpg'), 'submit', 'HTTP 502', true) <> 'held' THEN RAISE EXCEPTION 'C5: third failure holds again'; END IF;
  -- override on a photo that is neither held nor at the limit is refused
  IF public.review_media_cutout(pg_temp.u('c/poll.jpg'), 'override_cap', NULL, NULL, NULL) ->> 'error' <> 'not_capped' THEN RAISE EXCEPTION 'C5: not capped'; END IF;
END $t$;

-- ------------------------------------------------ C6. a failed STATUS CHECK is never counted
DO $t$ BEGIN
  PERFORM pg_temp.handed('c/poll.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('c/poll.jpg'), 'replicate', 'm', 'req-p', 's', 'r');
  IF public.media_cutout_error(pg_temp.u('c/poll.jpg'), 'poll', 'HTTP 503', true) <> 'retry' THEN RAISE EXCEPTION 'C6: poll retry'; END IF;
  IF public.media_cutout_error(pg_temp.u('c/poll.jpg'), 'poll', 'HTTP 503', true) <> 'retry' THEN RAISE EXCEPTION 'C6: poll retry 2'; END IF;
  IF (pg_temp.row_of('c/poll.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'C6: status checks were counted'; END IF;
  IF public.media_cutout_error(pg_temp.u('c/poll.jpg'), 'poll', 'replicate: failed', false) <> 'failed' THEN RAISE EXCEPTION 'C6: final'; END IF;
  IF (SELECT paid_calls || '/' || status || '/' || coalesce(hold_reason, '-') FROM public.website_media_cutouts
       WHERE source_url = pg_temp.u('c/poll.jpg')) <> '1/failed/-' THEN RAISE EXCEPTION 'C6: failed under the limit, not held'; END IF;
  -- under the limit a staff re-run is still allowed (its 2nd and last paid call)
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  IF public.review_media_cutout(pg_temp.u('c/poll.jpg'), 'rerun', NULL, NULL, 'failed') ->> 'status' <> 'pending' THEN RAISE EXCEPTION 'C6: rerun'; END IF;
END $t$;

-- ------------------------------------------------ C7. the 30-minute provider timeout: not a new call itself, but its retry would be
DO $t$ BEGIN
  PERFORM pg_temp.handed('c/timeout.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('c/timeout.jpg'), 'replicate', 'm', 'req-t', 's', 'r');
  IF public.media_cutout_error(pg_temp.u('c/timeout.jpg'), 'submit', 'provider timeout (30 min)', true) <> 'retry' THEN RAISE EXCEPTION 'C7: 1'; END IF;
  IF (SELECT paid_calls || '/' || job_state FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/timeout.jpg')) <> '1/queued' THEN
    RAISE EXCEPTION 'C7: a timeout is not a new call';
  END IF;
  PERFORM pg_temp.handed('c/timeout.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('c/timeout.jpg'), 'replicate', 'm', 'req-t2', 's', 'r');
  IF public.media_cutout_error(pg_temp.u('c/timeout.jpg'), 'submit', 'provider timeout (30 min)', true) <> 'held' THEN
    RAISE EXCEPTION 'C7: at the limit a timeout must hold, not buy a third call';
  END IF;
  IF (pg_temp.row_of('c/timeout.jpg')).paid_calls <> 2 THEN RAISE EXCEPTION 'C7: count'; END IF;
END $t$;

-- ------------------------------------------------ C8. a sync provider (Photoroom) call is counted, also when the row left the queue meanwhile
DO $t$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.handed('c/sync.jpg');
  v := public.media_cutout_sync_result(pg_temp.u('c/sync.jpg'), 'photoroom', 'photoroom/v1/segment', 'u1',
                                       pg_temp.u('derived/aa/photoroom-u1.png'), 0.1);
  IF (pg_temp.row_of('c/sync.jpg')).paid_calls <> 1 OR (pg_temp.row_of('c/sync.jpg')).job_state <> 'ready' THEN RAISE EXCEPTION 'C8: sync'; END IF;
  v := public.media_cutout_sync_result(pg_temp.u('c/sync.jpg'), 'photoroom', 'photoroom/v1/segment', 'u2',
                                       pg_temp.u('derived/aa/photoroom-u2.png'), 0.1);
  IF v ->> 'error' <> 'not_queued' OR (pg_temp.row_of('c/sync.jpg')).paid_calls <> 2 THEN
    RAISE EXCEPTION 'C8: a paid answer for a row no longer queued must still be counted';
  END IF;
END $t$;

-- ------------------------------------------------ C9. inserts cannot smuggle calls in; a new URL is a new photo
DO $t$ BEGIN
  PERFORM pg_temp.refused($$INSERT INTO public.website_media_cutouts (source_url, paid_call_limit)
                            VALUES (pg_temp.u('c/sneaky.jpg'), 9)$$, 'starts with 0 paid calls');
  PERFORM pg_temp.refused($$INSERT INTO public.website_media_cutouts (source_url, status)
                            VALUES (pg_temp.u('c/sneaky2.jpg'), 'approved')$$, 'locked');
  INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000001', pg_temp.u('c/done-v2.jpg'), 5);
  IF (SELECT job_state || '/' || paid_calls FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/done-v2.jpg')) <> 'queued/0' THEN
    RAISE EXCEPTION 'C9: a changed photo (new URL) must enter the queue on its own';
  END IF;
END $t$;

-- ------------------------------------------------ C10. approve / reject cancel a pending re-run (final decisions)
DO $t$ BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  -- c/poll.jpg is queued again (C6), status pending, no files: approve refused; reject cancels
  IF public.review_media_cutout(pg_temp.u('c/poll.jpg'), 'approve', NULL, NULL, NULL) ->> 'error' <> 'no_cutout' THEN RAISE EXCEPTION 'C10: approve'; END IF;
  PERFORM public.review_media_cutout(pg_temp.u('c/poll.jpg'), 'reject', NULL, NULL, NULL);
  IF (SELECT status || '/' || job_state FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/poll.jpg')) <> 'rejected/done' THEN
    RAISE EXCEPTION 'C10: reject must take the photo out of the queue';
  END IF;
  IF pg_temp.handed('c/poll.jpg') THEN RAISE EXCEPTION 'C10: handed after reject'; END IF;
END $t$;

-- ------------------------------------------------ C11. legacy rows (before this rule) are parked by the submit batch, never sent
DO $t$ BEGIN
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER trg_guard_media_cutout_cut_once;
  UPDATE public.website_media_cutouts SET job_state = 'queued', recut_allowed = false, hold_reason = NULL
   WHERE source_url = pg_temp.u('c/timeout.jpg');                                      -- queued at 2 of 2
  UPDATE public.website_media_cutouts SET job_state = 'queued', recut_allowed = false
   WHERE source_url = pg_temp.u('c/reject.jpg');                                       -- approved, queued, no permission
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER trg_guard_media_cutout_cut_once;
  IF pg_temp.handed('c/timeout.jpg') OR pg_temp.handed('c/reject.jpg') THEN RAISE EXCEPTION 'C11: legacy row handed out'; END IF;
  IF (SELECT job_state || '/' || (hold_reason IS NOT NULL) FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c/timeout.jpg'))
     <> 'error/true' THEN RAISE EXCEPTION 'C11: capped legacy row must go to Needs owner'; END IF;
  IF (pg_temp.row_of('c/reject.jpg')).job_state <> 'done' THEN RAISE EXCEPTION 'C11: locked legacy row must leave the queue'; END IF;
END $t$;

-- ------------------------------------------------ C12. unchanged: a staff decision is never overwritten by automation
DO $t$ BEGIN
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER trg_guard_media_cutout_cut_once;
  UPDATE public.website_media_cutouts SET job_state = 'processing' WHERE source_url = pg_temp.u('c/poll.jpg');  -- rejected
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER trg_guard_media_cutout_cut_once;
  IF public.media_cutout_finish(pg_temp.u('c/poll.jpg'), '{"status":"ok"}') <> 'kept_staff_decision' THEN RAISE EXCEPTION 'C12'; END IF;
  IF (pg_temp.row_of('c/poll.jpg')).status <> 'rejected' THEN RAISE EXCEPTION 'C12: status'; END IF;
END $t$;

-- ------------------------------------------------ C13. unchanged: CPU kill → cut-out only, then failed; no provider call
DO $t$
DECLARE u text := pg_temp.u('c/done-v2.jpg'); n int;
BEGIN
  PERFORM pg_temp.handed('c/done-v2.jpg');
  PERFORM public.media_cutout_submitted(u, 'replicate', 'm', 'req-d2', 's', 'r');
  PERFORM public.media_cutout_result_ready(u, 'https://replicate.delivery/d2.png');
  PERFORM public.media_cutout_claim_process(u);
  UPDATE public.website_media_cutouts SET processing_started_at = now() - interval '6 minutes' WHERE source_url = u;
  PERFORM public.media_cutout_process_batch(5);
  IF (SELECT job_state || '/' || cpu_fallback FROM public.website_media_cutouts WHERE source_url = u) <> 'ready/true' THEN RAISE EXCEPTION 'C13: fallback'; END IF;
  PERFORM public.media_cutout_claim_process(u);
  UPDATE public.website_media_cutouts SET processing_started_at = now() - interval '6 minutes' WHERE source_url = u;
  PERFORM public.media_cutout_process_batch(5);
  IF (SELECT status || '/' || job_state || '/' || paid_calls FROM public.website_media_cutouts WHERE source_url = u) <> 'failed/error/1' THEN
    RAISE EXCEPTION 'C13: second kill';
  END IF;
END $t$;

-- ------------------------------------------------ C14. unchanged: the enqueue never fails a media write
DO $t$ BEGIN
  ALTER TABLE public.website_media_cutouts ADD CONSTRAINT c14_block CHECK (source_url NOT LIKE '%blocked%');
  INSERT INTO public.website_product_media (variant_id, url, sort) VALUES ('d0000000-0000-0000-0000-000000000002', pg_temp.u('c/blocked.jpg'), 9);
  IF NOT EXISTS (SELECT 1 FROM public.website_product_media WHERE url = pg_temp.u('c/blocked.jpg')) THEN RAISE EXCEPTION 'C14: media write lost'; END IF;
  ALTER TABLE public.website_media_cutouts DROP CONSTRAINT c14_block;
END $t$;

-- ------------------------------------------------ C15. tabs: filters, per-tab photos + paid calls, admin flag, price; grants
DO $t$
DECLARE v jsonb; t jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.get_media_cutout_tab_totals();
  t := v -> 'tabs';
  IF (v ->> 'is_admin')::boolean OR (v ->> 'price_usd')::numeric <> 0.005 OR v ->> 'provider' <> 'replicate'
     OR (v ->> 'per_photo_limit')::int <> 2 THEN RAISE EXCEPTION 'C15: header %', v; END IF;
  -- needs owner: done (C3), cap (C5), timeout (C11)
  IF (t -> 'needs_owner' ->> 'count')::int <> 3 OR (t -> 'needs_owner' ->> 'paid_calls')::int <> 2 + 3 + 2 THEN RAISE EXCEPTION 'C15: needs_owner %', t; END IF;
  -- completed: done (approved, held) + reject.jpg (approved own) ; rejected: poll
  IF (t -> 'completed' ->> 'count')::int <> 2 OR (t -> 'rejected' ->> 'count')::int <> 1 THEN RAISE EXCEPTION 'C15: completed/rejected %', t; END IF;
  -- the failed tab leaves out held photos: done-v2 (CPU) only
  IF (t -> 'failed' ->> 'count')::int <> 1 THEN RAISE EXCEPTION 'C15: failed %', t; END IF;
  IF (t -> 'all' ->> 'paid_calls')::int <> (SELECT sum(paid_calls) FROM public.website_media_cutouts WHERE orphaned_at IS NULL) THEN
    RAISE EXCEPTION 'C15: all';
  END IF;
  IF (public.list_media_cutouts('needs_owner', NULL, 50, 0) ->> 'total')::int <> 3 THEN RAISE EXCEPTION 'C15: list needs_owner'; END IF;
  IF (public.list_media_cutouts('completed', NULL, 50, 0) ->> 'total')::int <> 2 THEN RAISE EXCEPTION 'C15: list completed'; END IF;
  IF (public.list_media_cutouts('published', NULL, 50, 0) ->> 'total')::int <> 2 THEN RAISE EXCEPTION 'C15: list published alias'; END IF;
  IF NOT (public.list_media_cutouts('needs_owner', NULL, 50, 0) -> 'rows' -> 0) ? 'paid_calls' THEN RAISE EXCEPTION 'C15: row carries paid_calls'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.list_media_cutouts('queue', NULL, 50, 0) -> 'rows') x WHERE x ->> 'hold_reason' IS NOT NULL) THEN
    RAISE EXCEPTION 'C15: a held photo is listed in the queue';
  END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  IF NOT (public.get_media_cutout_tab_totals() ->> 'is_admin')::boolean THEN RAISE EXCEPTION 'C15: admin flag'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  IF public.get_media_cutout_tab_totals() ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION 'C15: perm'; END IF;
  IF has_function_privilege('authenticated', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_media_cutout_tab_totals()', 'EXECUTE') THEN RAISE EXCEPTION 'C15: grants'; END IF;
END $t$;

SELECT 'ALL PASSED' AS media_cutouts_cut_once_local_tests;
