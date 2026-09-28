-- LOCAL ONLY. Checks the limit guard after 20261012 ran on
-- docs/sql/20261012_media_cutouts_provider_errors_limit_fixture.sql.
DO $t$
DECLARE a jsonb; v_next timestamptz := (date_trunc('month', now() AT TIME ZONE 'Asia/Manila') + interval '1 month') AT TIME ZONE 'Asia/Manila';
BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN RAISE EXCEPTION 'local only'; END IF;
  SELECT new_value_json INTO a FROM public.audit_logs WHERE action = 'media_cutouts_provider_errors';
  IF concat_ws('/', a ->> 'month_room', a ->> 'requeued_now', a ->> 'requeued_held_for_limit', a ->> 'moved_to_needs_owner',
               a ->> 'queued', a ->> 'queued_due_now', a ->> 'queued_held_for_limit', a ->> 'will_send_now', a ->> 'failed')
     <> '15/15/15/1/35/20/15/20/0' THEN
    RAISE EXCEPTION 'limit: got %', a;
  END IF;
  -- the 15 due now are the first in send order (mains first, oldest first)
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts WHERE source_url LIKE '%/l/f%' AND next_attempt_at >= v_next AND priority = 0
               AND EXISTS (SELECT 1 FROM public.website_media_cutouts x WHERE x.source_url LIKE '%/l/f%' AND x.priority = 1 AND x.next_attempt_at < v_next)) THEN
    RAISE EXCEPTION 'limit: a main photo was held while a second photo was queued';
  END IF;
  IF (SELECT count(*) FROM public.website_media_cutouts
       WHERE next_attempt_at >= v_next AND last_error LIKE 'Back in the queue (the provider refused%this month''s limit is reached (580 of 600 used)%') <> 15 THEN
    RAISE EXCEPTION 'limit: the held rows must say why';
  END IF;
  -- the worker never goes past the limit: 20 room, 20 handed out at most
  IF jsonb_array_length(public.media_cutout_submit_batch(20) -> 'rows') > 20 THEN RAISE EXCEPTION 'limit: batch'; END IF;
  -- at its paid-call limit → Needs owner (not Failed, not queued)
  IF (SELECT job_state || '/' || status || '/' || (hold_reason LIKE '%not the photo%')::text
        FROM public.website_media_cutouts WHERE source_url LIKE '%/l/capped.jpg') <> 'error/pending/true' THEN
    RAISE EXCEPTION 'limit: capped row';
  END IF;
  -- Completed / Rejected / Kept original untouched
  IF (SELECT string_agg(job_state || '/' || status || '/' || provider_errors, ',' ORDER BY source_url)
        FROM public.website_media_cutouts WHERE source_url ~ '/l/(ok|rej|kept)\.jpg$')
     <> 'done/kept_original/0,done/approved/0,done/rejected/0' THEN
    RAISE EXCEPTION 'limit: a decided photo moved';
  END IF;
  RAISE NOTICE 'LIMIT GUARD ALL PASSED: 15 due now, 15 held until % PHT, 1 to Needs owner, decided photos untouched',
    to_char(v_next AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD');
END $t$;
