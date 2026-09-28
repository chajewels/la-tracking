-- ============================================================================
-- The read-only verification queries from the tail of
-- 20261011100000_media_cutouts_publish_gate.sql, plus (LOCAL ONLY) the exact
-- results they must give on the live-shaped snapshot
-- (docs/sql/20261010_media_cutouts_cut_once_snapshot.sql + cut_once +
-- docs/sql/20261011_media_cutouts_publish_gate_snapshot.sql).
-- Every row this file PRINTS is a LIVE value, read from the tables when it
-- runs. The "LOCAL snapshot:" numbers in the comments are the local test
-- data's (with an ASSUMED published / unpublished split — see the snapshot
-- file); they are checked only by the LOCAL block at the end, which does
-- nothing on live. (Fixed 2026-09-28: this file used to end with a hard-coded
-- "SNAPSHOT EXPECTATIONS MET: queued 376 → 250 …" line that printed on live
-- too, while live was 0 queued / 345 waiting / 56 published failures.)
-- ============================================================================

-- (0) before / after, as the migration counted them ON LIVE (the audit row).
--     LOCAL snapshot BEFORE: queued 376 | queued_published 256 | queued_unpublished 120 | queued_completed_recuts 6 |
--                      recut_permissions 6 | failed 495 | failed_published 300 | failed_402 495 |
--                      failed_402_published 300 | failed_402_published_sendable 300 | in_flight 0 | held 2 | rows 1002
--     LOCAL snapshot AFTER:  queued 250 | queued_unpublished 0 | waiting 120 | recut_permissions 0 | in_flight 0 | held 2 |
--                      rows 1002 | moved_to_waiting 120 | completed_recuts_cancelled 6
SELECT '0 before', old_value_json::text FROM public.audit_logs WHERE action = 'media_cutouts_publish_gate' ORDER BY created_at DESC LIMIT 1;
SELECT '0 after ', new_value_json::text FROM public.audit_logs WHERE action = 'media_cutouts_publish_gate' ORDER BY created_at DESC LIMIT 1;

-- (1) the gate is in place.                      LOCAL snapshot: 8 | t | t | t
SELECT '1', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname IN ('media_cutout_url_published','media_cutout_queue_published',
                    'media_cutout_dequeue_unpublished','media_cutout_follow_product_publish','media_cutout_follow_media_publish',
                    'guard_media_cutout_cut_once','media_cutout_submit_batch','review_media_cutout')),
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_website_product_cutout_publish_gate'),
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_website_media_cutout_publish_gate'),
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_media_cutout_cut_once');

-- (2) nothing unpublished or Completed can be sent.   LOCAL snapshot: 0 | 0 | 0
SELECT '2', count(*) FILTER (WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url)),
       count(*) FILTER (WHERE job_state IN ('queued','waiting') AND status IN ('ok','auto_fixed','approved','kept_original')),
       count(*) FILTER (WHERE recut_allowed AND status IN ('ok','auto_fixed','approved','kept_original')
                        AND job_state NOT IN ('submitted','ready','processing'))
  FROM public.website_media_cutouts;

-- (3) the queue now and Waiting for publish.          LOCAL snapshot: 250 | 0 | 120
SELECT '3', count(*) FILTER (WHERE job_state = 'queued'),
       count(*) FILTER (WHERE job_state IN ('submitted','ready','processing')),
       count(*) FILTER (WHERE job_state = 'waiting')
  FROM public.website_media_cutouts;

-- (4) the Photoroom-402 failures on published products.   LOCAL snapshot: 495 | 300 | 300
SELECT '4', count(*),
       count(*) FILTER (WHERE public.media_cutout_url_published(source_url)),
       count(*) FILTER (WHERE public.media_cutout_url_published(source_url) AND hold_reason IS NULL
                        AND paid_calls < paid_call_limit AND own_cutout_url IS NULL)
  FROM public.website_media_cutouts
 WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%');

-- (6) browser roles.                               LOCAL snapshot: f | f | t | t
SELECT '6', has_function_privilege('authenticated','public.media_cutout_queue_published(text[],boolean)','EXECUTE'),
       has_function_privilege('authenticated','public.media_cutout_submit_batch(integer)','EXECUTE'),
       has_function_privilege('authenticated','public.review_media_cutout(text,text,text,text,text)','EXECUTE'),
       has_function_privilege('authenticated','public.get_media_cutout_tab_totals()','EXECUTE');

-- LOCAL ONLY: the snapshot's exact expectations, and (5) the guard on real rows.
DO $snap$
DECLARE b jsonb; a jsonb; v text;
BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN RETURN; END IF;
  SELECT old_value_json, new_value_json INTO b, a FROM public.audit_logs WHERE action = 'media_cutouts_publish_gate';
  v := concat_ws('/', b ->> 'queued', b ->> 'queued_published', b ->> 'queued_unpublished', b ->> 'queued_completed_recuts',
                 b ->> 'recut_permissions', b ->> 'failed', b ->> 'failed_published', b ->> 'failed_402',
                 b ->> 'failed_402_published', b ->> 'failed_402_published_sendable', b ->> 'in_flight', b ->> 'held', b ->> 'rows');
  IF v <> '376/256/120/6/6/495/300/495/300/300/0/2/1002' THEN RAISE EXCEPTION 'snapshot BEFORE: got %', v; END IF;
  v := concat_ws('/', a ->> 'queued', a ->> 'queued_unpublished', a ->> 'waiting', a ->> 'recut_permissions', a ->> 'in_flight',
                 a ->> 'held', a ->> 'rows', a ->> 'moved_to_waiting', a ->> 'completed_recuts_cancelled');
  IF v <> '250/0/120/0/0/2/1002/120/6' THEN RAISE EXCEPTION 'snapshot AFTER: got %', v; END IF;
  -- the live tables agree with the audit row
  IF (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued') <> 250
     OR (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'waiting') <> 120 THEN
    RAISE EXCEPTION 'snapshot: tables disagree with the audit row';
  END IF;
  -- (5) Completed is final, the admin override included
  BEGIN
    PERFORM set_config('app.media_cutout_owner_override', 'on', true);
    UPDATE public.website_media_cutouts SET job_state = 'queued', recut_allowed = true
     WHERE source_url = (SELECT source_url FROM public.website_media_cutouts WHERE status = 'approved' LIMIT 1);
    RAISE EXCEPTION 'guard did not fire';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Completed is final%' THEN RAISE; END IF;
  END;
  PERFORM set_config('app.media_cutout_owner_override', '', true);
  -- switched ON, the worker gets published photos only
  INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000ad', 'admin');
  PERFORM set_config('test.uid', '00000000-0000-0000-0000-0000000000ad', true);
  PERFORM public.set_media_cutout_settings('on', NULL, NULL);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.media_cutout_submit_batch(20) -> 'rows') x
              WHERE NOT public.media_cutout_url_published(x ->> 'source_url')) THEN
    RAISE EXCEPTION 'snapshot: an unpublished photo was handed out';
  END IF;
  RAISE EXCEPTION 'rollback-local-only';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'rollback-local-only' THEN RAISE; END IF;
  RAISE NOTICE 'LOCAL SNAPSHOT EXPECTATIONS MET (local test data, not live): queued 376 -> 250 | 120 moved to Waiting for publish | 6 Completed re-cuts cancelled | 402s on published products: 300 of 495 | Completed is final';
END
$snap$;

-- (7) LIVE summary, read now: queued | waiting | failed 402s on published products | failed 402s in all
SELECT '7 live now', count(*) FILTER (WHERE job_state = 'queued'),
       count(*) FILTER (WHERE job_state = 'waiting'),
       count(*) FILTER (WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%')
                          AND public.media_cutout_url_published(source_url)),
       count(*) FILTER (WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%'))
  FROM public.website_media_cutouts;
