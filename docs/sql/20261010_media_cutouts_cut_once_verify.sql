-- ============================================================================
-- The read-only verification queries from the tail of
-- 20261010100000_media_cutouts_cut_once.sql, plus (LOCAL ONLY) the exact
-- results they must give on docs/sql/20261010_media_cutouts_cut_once_snapshot.sql.
-- On live, run only the SELECTs; compare with the expectations in the
-- migration's tail.
-- ============================================================================

-- (1) columns + guard.                         snapshot: 5 | t
SELECT '1', (SELECT count(*) FROM information_schema.columns WHERE table_name = 'website_media_cutouts'
              AND column_name IN ('paid_calls','paid_call_limit','recut_allowed','hold_reason','held_at')),
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_media_cutout_cut_once');

-- (2) backfill vs the month counter.           snapshot: 145 | 139 | {2} | 0 | 495
SELECT '2', (SELECT coalesce(sum(provider_calls), 0) FROM public.website_media_cutout_usage),
       (SELECT sum(paid_calls) FROM public.website_media_cutouts),
       (SELECT array_agg(DISTINCT paid_call_limit) FROM public.website_media_cutouts),
       (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued' AND paid_calls >= paid_call_limit),
       (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'failed' AND paid_calls = 0);

-- (3) the queue.                               snapshot: 376 | 2 | 0
SELECT '3', count(*) FILTER (WHERE job_state = 'queued'),
       count(*) FILTER (WHERE hold_reason IS NOT NULL),
       count(*) FILTER (WHERE job_state = 'queued' AND status IN ('ok','auto_fixed','approved','rejected') AND NOT recut_allowed)
  FROM public.website_media_cutouts;

-- (5) browser roles.                           snapshot: f | f | t | t
SELECT '5', has_function_privilege('authenticated','public.media_cutout_submit_batch(integer)','EXECUTE'),
       has_function_privilege('authenticated','public.media_cutout_error(text,text,text,boolean)','EXECUTE'),
       has_function_privilege('authenticated','public.review_media_cutout(text,text,text,text,text)','EXECUTE'),
       has_function_privilege('authenticated','public.get_media_cutout_tab_totals()','EXECUTE');

-- LOCAL ONLY: the snapshot's exact expectations, and the guard (4) on real rows.
DO $snap$
DECLARE v text;
BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN RETURN; END IF;
  SELECT (SELECT sum(provider_calls) FROM public.website_media_cutout_usage) || '/' ||
         (SELECT sum(paid_calls) FROM public.website_media_cutouts) || '/' ||
         (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued') || '/' ||
         (SELECT count(*) FROM public.website_media_cutouts WHERE hold_reason IS NOT NULL) || '/' ||
         (SELECT count(*) FROM public.website_media_cutouts WHERE recut_allowed) || '/' ||
         (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'failed' AND paid_calls = 0) || '/' ||
         (SELECT count(*) FROM public.website_media_cutouts WHERE paid_calls = 1)
    INTO v;
  -- calls / backfilled / queued / held / re-cut permissions / failed at 0 / rows at 1 call
  IF v <> '145/139/376/2/6/495/135' THEN RAISE EXCEPTION 'snapshot expectations: got %', v; END IF;
  BEGIN
    UPDATE public.website_media_cutouts SET job_state = 'queued'
     WHERE source_url = (SELECT source_url FROM public.website_media_cutouts WHERE status = 'approved' AND job_state = 'done' LIMIT 1);
    RAISE EXCEPTION 'guard did not fire';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%locked%' THEN RAISE; END IF;
  END;
  -- mode is OFF: nothing is handed out
  IF jsonb_array_length(public.media_cutout_submit_batch(20) -> 'rows') <> 0 THEN RAISE EXCEPTION 'handed out while off'; END IF;
  RAISE NOTICE 'snapshot ok';
END
$snap$;
SELECT 'SNAPSHOT EXPECTATIONS MET: 145 calls | 139 backfilled | 376 queued | 2 held | 6 re-cut permissions | 495 failed at 0 | guard refuses';
