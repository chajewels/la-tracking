-- ============================================================================
-- Verification for 20261012100000_media_cutouts_provider_errors.sql.
-- READ-ONLY. Every line it prints is a LIVE value, read from the tables when
-- you run it — nothing here is a snapshot or test number. The exact values the
-- LOCAL live-shaped snapshot gives are written next to each query as
-- "snapshot:"; they are for the local run only and are checked (and printed,
-- clearly labelled LOCAL) by the block at the end, which does nothing on live.
--
-- (P) PREVIEW — run BEFORE the migration: what it will move, from the live
--     rows. It defines the classifier as a temporary copy (pg_temp, gone
--     when the session ends) because the real one does not exist yet.
-- (0)…(6) run AFTER the migration.
-- ============================================================================

-- (P) Preview (before). One row per class × published. Expect on live: the
--     Photoroom 402s as account, the expired Replicate rows as result_expired,
--     real photo failures as photo. Nothing is changed.
--     snapshot: account|f|420 · account|t|56 · photo|t|2 · result_expired|f|4 · result_expired|t|8
CREATE OR REPLACE FUNCTION pg_temp.kind(p_stage text, p_error text, p_result_url text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN e ~* '^(photoroom|fal|replicate)\M[^:]*:? HTTP (401|402|403|429)\M'                 THEN 'account'
    WHEN e ~* '^(fal|replicate) submit:? HTTP 404\M'                                            THEN 'account'
    WHEN e ~* '^provider [A-Za-z0-9_-]+ not configured' OR e ~* '^no provider configured'       THEN 'account'
    WHEN e ~* '^(fal|replicate) (status|result):? HTTP (404|410)\M'                             THEN 'result_expired'
    WHEN e ~* '^download (403|404|410)\M'
         AND coalesce(p_stage, 'process') IN ('poll','process')
         AND coalesce(p_result_url, '') ~ '^https://'
         AND p_result_url !~ '/storage/v1/object/public/promotions/website/'                   THEN 'result_expired'
    WHEN e ~* '^(photoroom|fal|replicate)\M[^:]*:? HTTP 5[0-9][0-9]\M'                          THEN 'provider'
    ELSE 'photo' END
    FROM (SELECT btrim(regexp_replace(coalesce(p_error, ''), '^api_error:', '')) AS e) s
$fn$;
SELECT 'P preview' AS q, pg_temp.kind(NULL, coalesce(last_error, flags[1]), result_url) AS kind,
       public.media_cutout_url_published(source_url) AS published,
       count(*) AS failed_rows,
       count(*) FILTER (WHERE paid_calls >= paid_call_limit) AS at_paid_limit,
       min(left(coalesce(last_error, flags[1]), 90)) AS example_error
  FROM public.website_media_cutouts
 WHERE status = 'failed' AND job_state = 'error' AND hold_reason IS NULL AND own_cutout_url IS NULL
 GROUP BY 2, 3 ORDER BY 2, 3;

-- (0) BEFORE / AFTER, exactly as the migration counted them on live inside
--     its transaction (one row each). Rules: after.failed_provider_left = 0;
--     after.failed = before.failed_photo; after.completed = before.completed;
--     after.rejected = before.rejected;
--     requeued_now + requeued_held_for_limit = before.failed_provider_published
--       (minus any at their paid-call limit, which are in moved_to_needs_owner);
--     moved_to_waiting = before.failed_provider_unpublished (same exception).
--     snapshot BEFORE: failed 490 | failed_provider 488 (published 64, unpublished 424) | failed_photo 2 |
--                      waiting 377 | queued 0 | used 135 of 600 | completed 130 | rejected 5
--     snapshot AFTER:  failed 2 | queued 64 (due now 64, held for the limit 0) | waiting 801 | completed 130 |
--                      rejected 5 | moved_to_waiting 424 | moved_to_needs_owner 0 | will_send_now 64
SELECT '0 before' AS q, old_value_json::text FROM public.audit_logs
 WHERE action = 'media_cutouts_provider_errors' ORDER BY created_at DESC LIMIT 1;
SELECT '0 after ' AS q, new_value_json::text FROM public.audit_logs
 WHERE action = 'media_cutouts_provider_errors' ORDER BY created_at DESC LIMIT 1;

-- (1) LIVE state now: queued | waiting | failed | failed that are NOT photo problems (must be 0) | needs owner | completed | rejected
--     snapshot: 64 | 801 | 2 | 0 | 2 | 130 | 5
SELECT '1 live now' AS q,
       count(*) FILTER (WHERE job_state = 'queued')                                     AS queued,
       count(*) FILTER (WHERE job_state = 'waiting')                                    AS waiting,
       count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL)                AS failed,
       count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL
                          AND public.media_cutout_error_kind(NULL, coalesce(last_error, flags[1]), result_url) <> 'photo') AS failed_not_photo,
       count(*) FILTER (WHERE hold_reason IS NOT NULL)                                  AS needs_owner,
       count(*) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original')) AS completed,
       count(*) FILTER (WHERE status = 'rejected')                                      AS rejected
  FROM public.website_media_cutouts;

-- (2) What the worker will SEND now, from LIVE settings and rows, and the
--     estimated cost at US$0.002–0.005 a photo (Replicate) and at the price
--     set in Website → Photos. "sendable" = queued, published, due, not held,
--     under its paid-call limit; "will_send" also obeys the switch (Off → 0;
--     Test → only test-batch photos) and this month's limit.
--     snapshot: on | replicate | 135 | 600 | 64 | 64 | 0.13 | 0.32 | 0.26
WITH s AS (
  SELECT public.media_cutout_mode() AS mode,
         (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_provider') AS provider,
         coalesce((SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()), 0) AS used,
         public.media_cutout_cap() AS cap,
         (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd') AS price
), q AS (
  SELECT count(*) AS sendable, count(*) FILTER (WHERE test_batch IS NOT NULL) AS sendable_test
    FROM public.website_media_cutouts
   WHERE job_state = 'queued' AND next_attempt_at <= now() AND orphaned_at IS NULL AND own_cutout_url IS NULL
     AND hold_reason IS NULL AND paid_calls < paid_call_limit AND public.media_cutout_url_published(source_url)
), w AS (
  SELECT s.*, q.sendable,
         CASE s.mode WHEN 'on' THEN least(q.sendable, greatest(0, s.cap - s.used))
                     WHEN 'test' THEN least(q.sendable_test, greatest(0, s.cap - s.used)) ELSE 0 END AS will_send
    FROM s, q
)
SELECT '2 send now' AS q, mode, coalesce(provider, 'photoroom') AS provider, used, cap, sendable, will_send,
       round(will_send * 0.002, 2) AS cost_low_usd, round(will_send * 0.005, 2) AS cost_high_usd,
       CASE WHEN price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN round(will_send * price::numeric, 2) END AS cost_at_set_price_usd
  FROM w;

-- (3) Queued but HELD for the monthly limit (due on the 1st, PHT), with the reason. Expect 0 unless the room ran out.
--     snapshot: 0
SELECT '3 held for limit' AS q, count(*) AS rows, min(next_attempt_at) AS due, min(left(last_error, 120)) AS reason
  FROM public.website_media_cutouts
 WHERE job_state = 'queued' AND last_error LIKE 'Back in the queue (the provider refused%';

-- (4) What the Photos card shows (published products only) vs what it hides.
--     snapshot: 2 | 5 | 2 | 64 | 130 | 801
SELECT '4 card' AS q,
       count(*) FILTER (WHERE pub AND hold_reason IS NOT NULL)                                   AS card_needs_owner,
       count(*) FILTER (WHERE pub AND status = 'rejected')                                       AS card_rejected,
       count(*) FILTER (WHERE pub AND status = 'failed' AND hold_reason IS NULL)                 AS card_failed,
       count(*) FILTER (WHERE pub AND hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')) AS card_queue,
       count(*) FILTER (WHERE pub AND status IN ('ok','auto_fixed','approved','kept_original'))  AS card_completed,
       count(*) FILTER (WHERE NOT pub)                                                           AS hidden_unpublished
  FROM (SELECT c.*, public.media_cutout_url_published(c.source_url) AS pub
          FROM public.website_media_cutouts c WHERE c.orphaned_at IS NULL) c;

-- (5) Nothing Completed / Rejected / Kept original moved: none of them has
--     provider_errors > 0 or was queued. Expect: 0 | 0
SELECT '5 untouched' AS q,
       count(*) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original','rejected') AND job_state IN ('queued','waiting')),
       count(*) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original','rejected') AND provider_errors > 0)
  FROM public.website_media_cutouts;

-- (6) Grants and the function set. Expect: t | f | f | t | t
SELECT '6 grants' AS q,
       to_regprocedure('public.media_cutout_error_kind(text,text,text)') IS NOT NULL,
       has_function_privilege('authenticated', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE'),
       has_function_privilege('anon', 'public.list_media_cutouts(text,text,integer,integer)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.get_media_cutout_tab_totals()', 'EXECUTE'),
       has_function_privilege('service_role', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE');

-- LOCAL ONLY (the throwaway stub sets cutout.local_stub): the snapshot's exact
-- expectations. Prints nothing on live.
DO $snap$
DECLARE b jsonb; a jsonb; v text;
BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN RETURN; END IF;
  SELECT old_value_json, new_value_json INTO b, a FROM public.audit_logs WHERE action = 'media_cutouts_provider_errors';
  v := concat_ws('/', b ->> 'failed', b ->> 'failed_provider', b ->> 'failed_provider_published', b ->> 'failed_provider_unpublished',
                 b ->> 'failed_photo', b ->> 'waiting', b ->> 'queued', b ->> 'used', b ->> 'cap', b ->> 'completed', b ->> 'rejected');
  IF v <> '490/488/64/424/2/377/0/135/600/130/5' THEN RAISE EXCEPTION 'LOCAL snapshot BEFORE: got %', v; END IF;
  v := concat_ws('/', a ->> 'failed', a ->> 'queued', a ->> 'queued_due_now', a ->> 'requeued_held_for_limit', a ->> 'waiting',
                 a ->> 'completed', a ->> 'rejected', a ->> 'moved_to_waiting', a ->> 'moved_to_needs_owner', a ->> 'will_send_now',
                 a ->> 'failed_provider_left');
  IF v <> '2/64/64/0/801/130/5/424/0/64/0' THEN RAISE EXCEPTION 'LOCAL snapshot AFTER: got %', v; END IF;
  IF (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued') <> 64
     OR (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'waiting') <> 801
     OR (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'failed' AND hold_reason IS NULL) <> 2 THEN
    RAISE EXCEPTION 'LOCAL snapshot: the tables disagree with the audit row';
  END IF;
  RAISE NOTICE 'LOCAL SNAPSHOT EXPECTATIONS MET (local test data, not live): failed 490 -> 2, queued 0 -> 64 (64 due now), waiting 377 -> 801';
END
$snap$;
