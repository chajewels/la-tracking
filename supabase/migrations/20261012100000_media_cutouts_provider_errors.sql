-- ===========================================================================
-- media_cutouts_provider_errors — product photo cut-outs: a provider or
-- ACCOUNT error is not the photo's fault, so it never lands in Failed; the
-- photo goes back by itself (owner rule 2026-09-28). And the Photos card
-- shows photos of PUBLISHED products only. docs/MEDIA-CUTOUTS.md
-- "PROVIDER ERRORS". The hero pipeline (website_hero_cutouts) is not touched.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- and after scripts/function-drift-audit shows 0 | 0 | 0 (excluding
-- 20261010200000_ddl_audit_log.sql). One transaction. CALLS NO PROVIDER.
-- No edge-function change: media-cutout-worker records every error through
-- public.media_cutout_error, which is where the classification lives.
--
-- Why (live, 2026-09-28 17:48 JST, switch On, provider Replicate): Failed 490,
-- almost all "photoroom HTTP 402 You have exhausted the number of images in
-- your plan"; ~12 Replicate rows Failed because their result URL expired
-- (Replicate keeps API outputs one hour) while the switch was Off.
--
-- What it does:
--
--   A. public.media_cutout_error_kind(stage, error, result_url) — ONE
--      classifier, pure (IMMUTABLE), for the worker path and the cleanup:
--        'account'        the provider REFUSED the request before doing any
--                         work: HTTP 401 / 402 / 403 / 429 from Photoroom,
--                         fal or Replicate; HTTP 404 on a fal / Replicate
--                         SUBMIT (model / version not found — a setting);
--                         "provider X not configured" / "no provider
--                         configured" (a missing secret)
--        'provider'       HTTP 5xx from the provider (its outage)
--        'result_expired' the provider no longer has the result: HTTP 404 /
--                         410 on a fal / Replicate status or result call, or
--                         "download 403/404/410" of a result URL that is the
--                         PROVIDER's (not our storage) at the poll / process
--                         step
--        'photo'          everything else (bad input, decode failure, the
--                         checks, our own storage) — the ONLY kind that may
--                         end in Failed
--      The worker's messages it reads (supabase/functions/_shared/
--      cutout-provider.ts failure(): "<what>: HTTP <status> <body>";
--      media-cutout-worker/index.ts download(): "download <status>", poll:
--      "provider <name> not configured"). The flags form ("api_error:
--      photoroom HTTP 402 …", colons stripped) is read too.
--
--   B. public.media_cutout_error (redefined). A photo error: unchanged. An
--      account / provider / expired error: NEVER Failed —
--        submit step, or result expired  → back to the queue (published
--                                          product) or Waiting for publish
--                                          (unpublished), on the existing
--                                          schedule (5 min, 30 min, then
--                                          every 3 h — counted in the new
--                                          column provider_errors, so the
--                                          photo's own 3 tries are untouched)
--        poll / process step, not expired → stays at that step (the job is
--                                          at the provider / the result is in
--                                          hand; re-buying it would be waste)
--      PAID CALLS (#235 "a failed submit counts") stay exactly as they were,
--      with ONE exception: an 'account' refusal is NOT counted. Photoroom:
--      "Calls that result in an error will not consume an image" (its
--      pricing page, quoted in _shared/cutout-provider.ts); a 401 / 402 /
--      403 / 429 is a refusal before any image is processed. Replicate and
--      fal bill a prediction / request that RUNS; a refused create (401,
--      402, 403, 429, 404 unknown version) creates none. A 5xx or a timeout
--      stays counted: the provider may have done (and billed) the work.
--      A photo already at its paid-call limit cannot go back to the queue:
--      it goes to Needs owner (hold_reason), never to Failed.
--
--   C. Staff lists: list_media_cutouts and get_media_cutout_tab_totals show
--      and count ONLY photos of published products (owner, 2026-09-28: no
--      "Waiting for publish" tab; those photos stay in the database, waiting,
--      and appear once the product is published). The 'waiting' filter / count
--      is kept for SQL use only. Each row gains error_kind.
--
--   D. One-time cleanup (first run only): every Failed row (status failed,
--      not held) whose last error is an account / provider / expired error →
--        published product    queued — but never past this month's limit:
--                             up to (cap − used − already queued) are due
--                             now; the rest stay queued and HELD until the 1st
--                             of next month (PHT), last_error says why
--        unpublished product  Waiting for publish
--        at its paid-call limit  Needs owner, with the reason
--      Completed, Rejected and Kept original are never touched; genuine photo
--      failures stay Failed. Before / after counts are RAISE NOTICEd and kept
--      in one audit_logs row (action media_cutouts_provider_errors).
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). The three functions
-- redefined here are md5-checked against the bodies of
-- 20261011100000_media_cutouts_publish_gate.sql (owner-verified applied on
-- live 2026-09-28). Any difference aborts with NOTHING changed — stop and send
-- the live pg_get_functiondef. Re-running the file is safe (the second run
-- accepts this file's own bodies; the cleanup and its audit row happen once).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_md5   text;
  v_fresh boolean;
  f       record;
BEGIN
  IF to_regclass('public.website_media_cutouts') IS NULL
     OR to_regprocedure('public.media_cutout_url_published(text)') IS NULL
     OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'media_cutouts_provider_errors: run 20261011100000_media_cutouts_publish_gate.sql first';
  END IF;

  v_fresh := to_regprocedure('public.media_cutout_error_kind(text,text,text)') IS NULL;
  PERFORM set_config('provider_errors.fresh', CASE WHEN v_fresh THEN 'yes' ELSE 'no' END, true);

  FOR f IN SELECT * FROM (VALUES
      ('public.media_cutout_error(text,text,text,boolean)',    '249c4bcb4565f8feedb93b744adb7394', 'a354c657c85d8d3c31daad50d65060e9'),
      ('public.list_media_cutouts(text,text,integer,integer)', '1e799101ccf81357f637cd567fdcc3ef', 'ec4f6921171743b8a57e52c2633eea5c'),
      ('public.get_media_cutout_tab_totals()',                 '7dde5ae28a2d09dba6e17d55f17c52b5', '8d6df689e92351bcb94b0aa791574dfb')
    ) AS t(sig, live_md5, this_md5)
  LOOP
    IF to_regprocedure(f.sig) IS NULL THEN
      RAISE EXCEPTION 'media_cutouts_provider_errors: % is missing', f.sig;
    END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF v_md5 IS DISTINCT FROM (CASE WHEN v_fresh THEN f.live_md5 ELSE f.this_md5 END) THEN
      RAISE EXCEPTION 'media_cutouts_provider_errors: live % differs from the repo (md5 %) — stop and send its pg_get_functiondef', f.sig, v_md5;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The backoff counter for provider / account errors (the photo's own
--    attempts stay for photo errors).
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_media_cutouts
  ADD COLUMN IF NOT EXISTS provider_errors integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.website_media_cutouts.provider_errors IS
  'Provider / account errors this photo met (HTTP 401/402/403/429/5xx, no provider configured, result expired). They never make it Failed; this only paces its return: 5 min, 30 min, then every 3 h. 20261012100000.';

-- ---------------------------------------------------------------------------
-- 2. The classifier.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_error_kind(p_stage text, p_error text, p_result_url text DEFAULT NULL)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $fn$
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
COMMENT ON FUNCTION public.media_cutout_error_kind(text,text,text) IS
  'account | provider | result_expired | photo. Only ''photo'' may end in Failed; the others go back by themselves (media_cutout_error). An ''account'' refusal is not a paid call. 20261012100000, docs/MEDIA-CUTOUTS.md "PROVIDER ERRORS".';

-- ---------------------------------------------------------------------------
-- 3. A step failed. Photo errors: unchanged (backoff, 3 tries, cut-once
--    counting, Failed / Needs owner). Provider / account / expired errors:
--    never Failed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_error(p_source_url text, p_stage text, p_error text, p_retryable boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r       public.website_media_cutouts%ROWTYPE;
  v_err   text := left(coalesce(p_error, 'unknown'), 300);
  v_short text := left(regexp_replace(coalesce(p_error, 'unknown'), '[^A-Za-z0-9_ .-]', '', 'g'), 60);
  v_pub   boolean;
  v_paid  integer;
  v_hold  text;
  v_kind  text;
  v_next  timestamptz;
BEGIN
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF p_stage NOT IN ('submit','poll','process') THEN RAISE EXCEPTION 'media_cutout_error: bad stage %', p_stage; END IF;

  v_kind := public.media_cutout_error_kind(p_stage, p_error, r.result_url);

  IF r.job_state = 'done' THEN
    IF p_stage = 'submit' AND v_kind <> 'account' THEN
      UPDATE public.website_media_cutouts SET paid_calls = paid_calls + 1, updated_at = now() WHERE source_url = p_source_url;
    END IF;
    RETURN 'kept_decision';
  END IF;

  -- A failed submit is a paid call (#235) — except a refusal ('account'):
  -- the provider did no work and charged nothing.
  v_paid := r.paid_calls + CASE WHEN p_stage = 'submit' AND r.job_state IN ('queued','waiting') AND v_kind <> 'account'
                                THEN 1 ELSE 0 END;

  -- ---- Provider / account / expired: not the photo's fault. Never Failed.
  IF v_kind <> 'photo' THEN
    v_next := now() + CASE r.provider_errors WHEN 0 THEN interval '5 minutes'
                                             WHEN 1 THEN interval '30 minutes'
                                             ELSE interval '3 hours' END;
    -- The job is at the provider / its result is in hand: stay at that step.
    IF p_stage IN ('poll','process') AND v_kind <> 'result_expired' THEN
      UPDATE public.website_media_cutouts
         SET job_state = CASE p_stage WHEN 'poll' THEN 'submitted' ELSE 'ready' END,
             provider_errors = provider_errors + 1, last_error = v_err, next_attempt_at = v_next, updated_at = now()
       WHERE source_url = p_source_url;
      RETURN 'returned';
    END IF;
    -- A re-run of a Completed (or locked Rejected) photo, in flight from
    -- before "Completed is final": the published version stays.
    IF r.status IN ('ok','auto_fixed','approved','kept_original') OR (r.status = 'rejected' AND NOT r.recut_allowed) THEN
      UPDATE public.website_media_cutouts
         SET job_state = 'done', rerun = false, high_detail = false, recut_allowed = false, paid_calls = v_paid,
             provider_errors = provider_errors + 1, last_error = v_err, finished_at = now(), updated_at = now()
       WHERE source_url = p_source_url;
      RETURN 'kept_decision';
    END IF;
    -- At its paid-call limit: it cannot go back to the queue — the owner decides.
    IF v_paid >= r.paid_call_limit OR r.hold_reason IS NOT NULL THEN
      UPDATE public.website_media_cutouts
         SET job_state = 'error', paid_calls = v_paid, provider_errors = provider_errors + 1, last_error = v_err,
             status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
             rerun = false, high_detail = false, recut_allowed = false,
             hold_reason = coalesce(r.hold_reason,
               format('Stopped: this photo has used %s of %s paid calls. The last try failed because of the provider or the account, not the photo (%s). An admin can allow one more.',
                      v_paid, r.paid_call_limit, left(v_err, 160))),
             held_at = coalesce(r.held_at, now()), finished_at = now(), updated_at = now()
       WHERE source_url = p_source_url;
      RETURN 'held';
    END IF;
    -- Back to the queue (published) or Waiting for publish (not published).
    UPDATE public.website_media_cutouts
       SET job_state = CASE WHEN public.media_cutout_url_published(p_source_url) THEN 'queued' ELSE 'waiting' END,
           status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
           paid_calls = v_paid, provider_errors = provider_errors + 1, last_error = v_err,
           cpu_fallback = false, next_attempt_at = v_next, updated_at = now()
     WHERE source_url = p_source_url;
    RETURN 'returned';
  END IF;

  -- ---- A photo error: unchanged from 20261011100000.
  -- A retry that would send a Completed photo again never happens (Completed is final).
  IF p_retryable AND r.attempts < 3 AND NOT (p_stage = 'submit' AND v_paid >= r.paid_call_limit)
     AND NOT (p_stage = 'submit' AND r.status IN ('ok','auto_fixed','approved','kept_original')) THEN
    UPDATE public.website_media_cutouts
       SET attempts = attempts + 1, last_error = v_err, paid_calls = v_paid,
           job_state = CASE p_stage WHEN 'submit' THEN 'queued' WHEN 'poll' THEN 'submitted' ELSE 'ready' END,
           next_attempt_at = now() + CASE r.attempts WHEN 0 THEN interval '5 minutes'
                                                     WHEN 1 THEN interval '30 minutes'
                                                     ELSE interval '3 hours' END,
           updated_at = now()
     WHERE source_url = p_source_url;
    RETURN 'retry';
  END IF;

  IF v_paid >= r.paid_call_limit THEN
    v_hold := format('Stopped after %s paid calls (the limit for this photo is %s). Last error: %s',
                     v_paid, r.paid_call_limit, left(v_err, 200));
  END IF;
  v_pub := r.status IN ('ok','auto_fixed','approved');
  UPDATE public.website_media_cutouts
     SET attempts = attempts + 1, last_error = v_err, job_state = 'error', paid_calls = v_paid,
         status = CASE WHEN r.rerun AND v_pub THEN status ELSE 'failed' END,
         flags = CASE WHEN r.rerun AND v_pub THEN flags ELSE ARRAY['api_error:' || v_short] END,
         last_rerun = CASE WHEN r.rerun AND v_pub
                           THEN jsonb_build_object('status', 'failed', 'flags', ARRAY['api_error:' || v_short], 'at', now())
                           ELSE last_rerun END,
         rerun = false, high_detail = false, recut_allowed = false,
         hold_reason = v_hold, held_at = CASE WHEN v_hold IS NOT NULL THEN now() END,
         finished_at = now(), updated_at = now()
   WHERE source_url = p_source_url;
  RETURN CASE WHEN v_hold IS NOT NULL THEN 'held' ELSE 'failed' END;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Staff lists: photos of PUBLISHED products only. 'waiting' stays as a
--    filter / count for SQL use; the Photos card does not show it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_media_cutouts(p_filter text, p_search text DEFAULT NULL,
                                                     p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_filter text := coalesce(p_filter, 'needs_review');
  v_q      text := nullif(btrim(coalesce(p_search, '')), '');
  v_total  integer;
  v_rows   jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF v_filter NOT IN ('needs_review','needs_owner','failed','auto_fixed','queue','waiting','completed','published',
                      'kept_original','rejected','all','test') THEN
    RETURN jsonb_build_object('error', 'invalid_filter');
  END IF;

  WITH base AS (
    SELECT c.*,
           public.media_cutout_url_published(c.source_url) AS published,
           public.media_cutout_error_kind(NULL, c.last_error, c.result_url) AS error_kind,
           (SELECT jsonb_build_object('id', p.id, 'sku', p.sku, 'name', p.name, 'slug', p.slug, 'status', p.status)
              FROM public.website_product_media m
              JOIN public.website_product_variants v ON v.id = m.variant_id
              JOIN public.website_products p ON p.id = v.product_id
             WHERE m.url = c.source_url
             ORDER BY p.status::text = 'active' DESC, p.sku LIMIT 1) AS product,
           (SELECT count(DISTINCT v.product_id)
              FROM public.website_product_media m
              JOIN public.website_product_variants v ON v.id = m.variant_id
             WHERE m.url = c.source_url) AS product_count
      FROM public.website_media_cutouts c
     WHERE c.orphaned_at IS NULL
  ), filtered AS (
    SELECT * FROM base
     WHERE (published OR v_filter = 'waiting')
       AND CASE v_filter
             WHEN 'needs_review'  THEN status = 'needs_review'
             WHEN 'needs_owner'   THEN hold_reason IS NOT NULL
             WHEN 'failed'        THEN status = 'failed' AND hold_reason IS NULL
             WHEN 'auto_fixed'    THEN status = 'auto_fixed'
             WHEN 'queue'         THEN hold_reason IS NULL
                                       AND (job_state IN ('submitted','ready','processing')
                                            OR (job_state = 'queued' AND published))
             WHEN 'waiting'       THEN job_state = 'waiting'
             WHEN 'completed'     THEN status IN ('ok','auto_fixed','approved','kept_original')
             WHEN 'published'     THEN status IN ('ok','auto_fixed','approved','kept_original')
             WHEN 'kept_original' THEN status = 'kept_original'
             WHEN 'rejected'      THEN status = 'rejected'
             WHEN 'test'          THEN test_batch IS NOT NULL
             ELSE true END
  ), hit AS (
    SELECT * FROM filtered
     WHERE v_q IS NULL
        OR (product ->> 'sku') ILIKE '%' || v_q || '%'
        OR (product ->> 'name') ILIKE '%' || v_q || '%'
        OR test_batch ILIKE '%' || v_q || '%'
  )
  SELECT (SELECT count(*) FROM hit),
         coalesce((SELECT jsonb_agg(to_jsonb(h) - 'provider_status_url' - 'provider_response_url'
                                    ORDER BY h.priority, h.updated_at DESC)
                     FROM (SELECT * FROM hit ORDER BY priority, updated_at DESC
                            LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
                           OFFSET greatest(coalesce(p_offset, 0), 0)) h), '[]'::jsonb)
    INTO v_total, v_rows;
  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$fn$;

-- Every tab: photos of published products and the paid calls they have cost.
-- 'waiting' (photos of unpublished products) is counted for SQL use only.
CREATE OR REPLACE FUNCTION public.get_media_cutout_tab_totals()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_price text := (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd');
  v_prov  text := (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_provider');
  v_tabs  jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  WITH a AS (
    SELECT status, job_state, hold_reason, test_batch, paid_calls,
           public.media_cutout_url_published(source_url) AS pub
      FROM public.website_media_cutouts WHERE orphaned_at IS NULL
  ), c AS (
    SELECT * FROM a WHERE pub
  )
  SELECT jsonb_build_object(
      'needs_review', jsonb_build_object('count', count(*) FILTER (WHERE status = 'needs_review'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'needs_review'), 0)),
      'needs_owner',  jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NOT NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NOT NULL), 0)),
      'failed',       jsonb_build_object('count', count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'failed' AND hold_reason IS NULL), 0)),
      'auto_fixed',   jsonb_build_object('count', count(*) FILTER (WHERE status = 'auto_fixed'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'auto_fixed'), 0)),
      'queue',        jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NULL AND job_state IN ('queued','submitted','ready','processing')), 0)),
      'waiting',      (SELECT jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(paid_calls), 0))
                         FROM a WHERE job_state = 'waiting'),
      'completed',    jsonb_build_object('count', count(*) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status IN ('ok','auto_fixed','approved','kept_original')), 0),
                                         'kept_original', count(*) FILTER (WHERE status = 'kept_original')),
      'rejected',     jsonb_build_object('count', count(*) FILTER (WHERE status = 'rejected'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'rejected'), 0)),
      'test',         jsonb_build_object('count', count(*) FILTER (WHERE test_batch IS NOT NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE test_batch IS NOT NULL), 0)),
      'all',          jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(paid_calls), 0)))
    INTO v_tabs
    FROM c;
  RETURN jsonb_build_object(
    'tabs', v_tabs,
    'is_admin', public.has_role(v_uid, 'admin'),
    'per_photo_limit', 2,
    'publish_gate', true,
    'published_only', true,
    'provider', CASE WHEN v_prov IN ('fal','replicate') THEN v_prov ELSE 'photoroom' END,
    'price_usd', CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. One-time cleanup (first run only), with before / after counts.
-- ---------------------------------------------------------------------------
DO $cleanup$
DECLARE
  v_before   jsonb;
  v_after    jsonb;
  v_mode     text := public.media_cutout_mode();
  v_cap      integer := public.media_cutout_cap();
  v_used     integer := coalesce((SELECT provider_calls FROM public.website_media_cutout_usage
                                   WHERE month = public.media_cutout_month()), 0);
  v_queued   integer;
  v_room     integer;
  v_next     timestamptz := (date_trunc('month', now() AT TIME ZONE 'Asia/Manila') + interval '1 month') AT TIME ZONE 'Asia/Manila';
  v_pub_now  integer;
  v_pub_held integer;
  v_waited   integer;
  v_owner    integer;
  v_setting  uuid := (SELECT id FROM public.system_settings WHERE key = 'media_cutout_mode');
BEGIN
  IF current_setting('provider_errors.fresh', true) <> 'yes' THEN RETURN; END IF;

  CREATE TEMP TABLE pe_rows ON COMMIT DROP AS
  SELECT c.source_url, c.priority, c.created_at, c.paid_calls, c.paid_call_limit,
         public.media_cutout_url_published(c.source_url) AS pub,
         public.media_cutout_error_kind(NULL, coalesce(c.last_error, c.flags[1]), c.result_url) AS kind
    FROM public.website_media_cutouts c
   WHERE c.status = 'failed' AND c.job_state = 'error' AND c.hold_reason IS NULL AND c.own_cutout_url IS NULL;

  -- Already queued and sendable now: they come first against this month's room.
  SELECT count(*) INTO v_queued FROM public.website_media_cutouts
   WHERE job_state = 'queued' AND next_attempt_at <= now() AND orphaned_at IS NULL AND own_cutout_url IS NULL
     AND hold_reason IS NULL AND paid_calls < paid_call_limit AND public.media_cutout_url_published(source_url);
  v_room := greatest(0, v_cap - v_used - v_queued);

  SELECT jsonb_build_object(
      'mode', v_mode, 'cap', v_cap, 'used', v_used, 'cap_left', greatest(0, v_cap - v_used),
      'queued', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued'),
      'queued_sendable', v_queued,
      'waiting', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'waiting'),
      'failed', (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'failed' AND hold_reason IS NULL),
      'failed_provider', (SELECT count(*) FROM pe_rows WHERE kind <> 'photo'),
      'failed_provider_published', (SELECT count(*) FROM pe_rows WHERE kind <> 'photo' AND pub),
      'failed_provider_unpublished', (SELECT count(*) FROM pe_rows WHERE kind <> 'photo' AND NOT pub),
      'failed_account', (SELECT count(*) FROM pe_rows WHERE kind = 'account'),
      'failed_provider_5xx', (SELECT count(*) FROM pe_rows WHERE kind = 'provider'),
      'failed_result_expired', (SELECT count(*) FROM pe_rows WHERE kind = 'result_expired'),
      'failed_photo', (SELECT count(*) FROM pe_rows WHERE kind = 'photo'),
      'failed_photo_published', (SELECT count(*) FROM pe_rows WHERE kind = 'photo' AND pub),
      'held', (SELECT count(*) FROM public.website_media_cutouts WHERE hold_reason IS NOT NULL),
      'completed', (SELECT count(*) FROM public.website_media_cutouts WHERE status IN ('ok','auto_fixed','approved','kept_original')),
      'rejected', (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'rejected'),
      'in_flight', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state IN ('submitted','ready','processing')),
      'rows', (SELECT count(*) FROM public.website_media_cutouts))
    INTO v_before;

  -- At the paid-call limit: cannot be sent again — Needs owner, with the reason.
  UPDATE public.website_media_cutouts c
     SET status = 'pending', flags = '{}', provider_errors = 0, held_at = now(), updated_at = now(),
         hold_reason = format('Stopped: this photo has used %s of %s paid calls. It was Failed only because of the provider or the account, not the photo (%s). An admin can allow one more.',
                              c.paid_calls, c.paid_call_limit, left(coalesce(c.last_error, c.flags[1], 'unknown'), 160))
    FROM pe_rows p
   WHERE c.source_url = p.source_url AND p.kind <> 'photo' AND p.paid_calls >= p.paid_call_limit;
  GET DIAGNOSTICS v_owner = ROW_COUNT;

  -- Unpublished product: Waiting for publish (cut once when it is published).
  UPDATE public.website_media_cutouts c
     SET job_state = 'waiting', status = 'pending', flags = '{}', attempts = 0, provider_errors = 0,
         cpu_fallback = false, next_attempt_at = now(), finished_at = NULL, updated_at = now()
    FROM pe_rows p
   WHERE c.source_url = p.source_url AND p.kind <> 'photo' AND NOT p.pub AND p.paid_calls < p.paid_call_limit;
  GET DIAGNOSTICS v_waited = ROW_COUNT;

  -- Published product: queued, in the order the worker sends (mains first),
  -- never past this month's limit. The rest stay queued, due on the 1st.
  WITH ranked AS (
    SELECT source_url, row_number() OVER (ORDER BY priority, created_at, source_url) AS n
      FROM pe_rows WHERE kind <> 'photo' AND pub AND paid_calls < paid_call_limit
  )
  UPDATE public.website_media_cutouts c
     SET job_state = 'queued', status = 'pending', flags = '{}', attempts = 0, provider_errors = 0,
         cpu_fallback = false, finished_at = NULL, updated_at = now(),
         next_attempt_at = CASE WHEN r.n <= v_room THEN now() ELSE v_next END,
         last_error = CASE WHEN r.n <= v_room THEN c.last_error
                           ELSE left(format('Back in the queue (the provider refused — not the photo). Held until %s PHT: this month''s limit is reached (%s of %s used). Last error: %s',
                                            to_char(v_next AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI'), v_used, v_cap,
                                            coalesce(c.last_error, 'unknown')), 300) END
    FROM ranked r
   WHERE c.source_url = r.source_url;
  SELECT count(*) FILTER (WHERE n <= v_room), count(*) FILTER (WHERE n > v_room) INTO v_pub_now, v_pub_held
    FROM (SELECT row_number() OVER (ORDER BY priority, created_at, source_url) AS n
            FROM pe_rows WHERE kind <> 'photo' AND pub AND paid_calls < paid_call_limit) x;

  SELECT jsonb_build_object(
      'queued', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued'),
      'queued_due_now', (SELECT count(*) FROM public.website_media_cutouts
                          WHERE job_state = 'queued' AND next_attempt_at <= now() AND orphaned_at IS NULL
                            AND own_cutout_url IS NULL AND hold_reason IS NULL AND paid_calls < paid_call_limit
                            AND public.media_cutout_url_published(source_url)),
      'queued_held_for_limit', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued' AND next_attempt_at >= v_next),
      'waiting', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'waiting'),
      'failed', (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'failed' AND hold_reason IS NULL),
      'failed_provider_left', (SELECT count(*) FROM public.website_media_cutouts
                                WHERE status = 'failed' AND hold_reason IS NULL
                                  AND public.media_cutout_error_kind(NULL, coalesce(last_error, flags[1]), result_url) <> 'photo'),
      'held', (SELECT count(*) FROM public.website_media_cutouts WHERE hold_reason IS NOT NULL),
      'completed', (SELECT count(*) FROM public.website_media_cutouts WHERE status IN ('ok','auto_fixed','approved','kept_original')),
      'rejected', (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'rejected'),
      'in_flight', (SELECT count(*) FROM public.website_media_cutouts WHERE job_state IN ('submitted','ready','processing')),
      'rows', (SELECT count(*) FROM public.website_media_cutouts),
      'requeued_now', v_pub_now, 'requeued_held_for_limit', v_pub_held, 'held_until', v_next,
      'moved_to_waiting', v_waited, 'moved_to_needs_owner', v_owner,
      'month_room', v_room,
      'will_send_now', CASE WHEN v_mode = 'on' THEN least(v_queued + v_pub_now, greatest(0, v_cap - v_used)) ELSE 0 END)
    INTO v_after;

  RAISE NOTICE 'media_cutouts_provider_errors BEFORE: %', v_before;
  RAISE NOTICE 'media_cutouts_provider_errors AFTER:  %', v_after;
  IF v_setting IS NOT NULL THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('system_setting', v_setting, 'media_cutouts_provider_errors', v_before, v_after, NULL, now());
  END IF;
END
$cleanup$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.media_cutout_error_kind(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_cutout_error_kind(text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.media_cutout_error(text,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.media_cutout_error(text,text,text,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.list_media_cutouts(text,text,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_media_cutouts(text,text,integer,integer) TO authenticated;
REVOKE ALL ON FUNCTION public.get_media_cutout_tab_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_media_cutout_tab_totals() TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Self-check, inside the transaction.
-- ---------------------------------------------------------------------------
DO $self$
BEGIN
  IF public.media_cutout_error_kind('submit', 'photoroom: HTTP 402 {"detail":"You have exhausted the number of images in your plan"}') <> 'account'
     OR public.media_cutout_error_kind(NULL, 'api_error:photoroom HTTP 402 detailYou have exhausted') <> 'account'
     OR public.media_cutout_error_kind('poll', 'provider replicate not configured') <> 'account'
     OR public.media_cutout_error_kind('submit', 'replicate submit: HTTP 503 upstream') <> 'provider'
     OR public.media_cutout_error_kind('process', 'download 404', 'https://replicate.delivery/x/out.png') <> 'result_expired'
     OR public.media_cutout_error_kind('process', 'download 404',
          'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/a/photoroom.png') <> 'photo'
     OR public.media_cutout_error_kind('submit', 'download 404', 'https://replicate.delivery/x/out.png') <> 'photo'
     OR public.media_cutout_error_kind('process', 'decode failed: not a PNG') <> 'photo' THEN
    RAISE EXCEPTION 'media_cutouts_provider_errors self-check: the classifier is wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE status = 'failed' AND hold_reason IS NULL
                AND public.media_cutout_error_kind(NULL, coalesce(last_error, flags[1]), result_url) <> 'photo') THEN
    RAISE EXCEPTION 'media_cutouts_provider_errors self-check: a provider / account error is still Failed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url)) THEN
    RAISE EXCEPTION 'media_cutouts_provider_errors self-check: a photo of an unpublished product is queued';
  END IF;
  IF has_function_privilege('authenticated', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.list_media_cutouts(text,text,integer,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_media_cutout_tab_totals()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'media_cutouts_provider_errors self-check: grants are wrong';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only, LIVE values): docs/sql/20261012_media_cutouts_provider_errors_verify.sql
-- Before running this file, the owner may preview what it will move with
-- query (P) there — it reads the live rows and changes nothing.
-- ===========================================================================
