-- ===========================================================================
-- media_cutouts_cut_once — product photo cut-outs: every photo is cut ONCE,
-- decisions are final unless the owner deliberately reopens them, and paid
-- provider calls are counted and capped PER PHOTO (owner rule 2026-09-28).
-- docs/MEDIA-CUTOUTS.md "CUT ONCE". The hero pipeline (website_hero_cutouts)
-- is not touched.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, with the switch OFF, after the
-- release PR is on main. One transaction. CALLS NO PROVIDER, SPENDS NOTHING.
-- No edge-function change: media-cutout-worker already goes through the SQL
-- functions redefined here for every decision.
--
-- What it does:
--
--   A. Four columns on website_media_cutouts:
--        paid_calls       provider calls this photo has cost, INCLUDING failed
--                         submits and automatic retries; a failed STATUS CHECK
--                         is never counted (it buys nothing). Never goes down.
--        paid_call_limit  2 (the hard cap). Raised only by an admin action,
--                         one call at a time, audited.
--        recut_allowed    the owner's one-shot permission to send a LOCKED photo
--                         again (Unlock and re-cut / Try once more). Cleared as
--                         soon as the job ends.
--        hold_reason      set = "Needs owner": the photo stopped at its paid-call
--                         limit; the reason is in plain words. held_at = when.
--      Backfilled once from what the row shows it has cost (see §2).
--
--   B. LOCKED = status ok / auto_fixed / approved ("Completed" — passed results
--      are what the website shows, lib/queries/products.ts usableCutout) or
--      rejected. trg_guard_media_cutout_cut_once refuses, for EVERY writer
--      (service role and SQL Editor included):
--        - a locked row entering the queue without recut_allowed
--        - any row entering the queue at or over its paid-call limit, or held
--        - paid_calls going down; paid_call_limit going up or recut_allowed
--          being granted outside the admin actions (GUC set only inside
--          review_media_cutout)
--      and media_cutout_submit_batch never hands such a row to the worker.
--
--   C. The worker's SQL, redefined from the repo bodies (md5-guarded against
--      live): submit_batch (the guard above; parks capped rows in Needs owner),
--      submitted and sync_result (+1 paid call), error (a failed submit is +1;
--      a retry that would need a paid call past the limit stops in Needs owner
--      instead), finish (the one-shot permission ends).
--
--   D. Staff: review_media_cutout refuses Re-run on a locked or capped photo
--      and gains three ADMIN actions, each audited with the estimated cost:
--        unlock_recut   Completed → one paid re-cut
--        retry_once     Rejected  → one paid re-cut
--        override_cap   Needs owner / at the limit → one more paid call
--      Approve / Reject cancel a pending re-run (a final decision).
--      list_media_cutouts gains the filters completed and needs_owner;
--      get_media_cutout_tab_totals (new) gives every tab's photos and paid
--      calls, whether the caller is an admin, and the price for the estimate.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). The seven functions
-- redefined here are md5-checked against the bodies in
-- 20261006100000_media_cutouts.sql / 20261007100000_media_cutout_photoroom.sql;
-- any difference aborts with NOTHING changed — stop and send the live
-- pg_get_functiondef. Re-running the file is safe (IF NOT EXISTS, the
-- backfill runs only when the columns are new, CREATE OR REPLACE; the second
-- run accepts the bodies this file wrote).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_md5     text;
  v_fresh   boolean;
  f         record;
BEGIN
  IF to_regclass('public.website_media_cutouts') IS NULL THEN v_missing := v_missing || 'website_media_cutouts'::text; END IF;
  IF to_regclass('public.website_media_cutout_usage') IS NULL THEN v_missing := v_missing || 'website_media_cutout_usage'::text; END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN v_missing := v_missing || 'has_permission(uuid,text)'::text; END IF;
  IF to_regprocedure('public.has_role(uuid,app_role)') IS NULL THEN v_missing := v_missing || 'has_role(uuid,app_role)'::text; END IF;
  IF to_regprocedure('public.media_cutout_mode()') IS NULL THEN v_missing := v_missing || 'media_cutout_mode()'::text; END IF;
  IF to_regprocedure('public.media_cutout_cap()') IS NULL THEN v_missing := v_missing || 'media_cutout_cap()'::text; END IF;
  IF to_regprocedure('public.media_cutout_month()') IS NULL THEN v_missing := v_missing || 'media_cutout_month()'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'website_media_cutouts' AND column_name = 'provider_uncertainty') THEN
    v_missing := v_missing || 'website_media_cutouts.provider_uncertainty (20261007100000_media_cutout_photoroom)'::text;
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutouts_cut_once: missing: %', array_to_string(v_missing, ', ');
  END IF;

  v_fresh := NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                           AND table_name = 'website_media_cutouts' AND column_name = 'paid_calls');
  PERFORM set_config('cutonce.fresh', CASE WHEN v_fresh THEN 'yes' ELSE 'no' END, true);

  -- Live must be exactly what this was written against: the repo bodies on
  -- the first run, this file's own bodies on a re-run (columns already there).
  FOR f IN SELECT * FROM (VALUES
      ('public.media_cutout_submit_batch(integer)',                          '8356fdd44f3fdbc644bc0848c99cc11e', '8b12cd478a5f8265422be4e9f6515a4f'),
      ('public.media_cutout_submitted(text,text,text,text,text,text)',       'ca732b540ffce05c1ede53ea1317c1b2', '0747b0e9afd805ebf486e652cf398e2e'),
      ('public.media_cutout_sync_result(text,text,text,text,text,numeric)',  '1edcbaccf3f01425b7e2ea5712bf9dc3', '59fd238c773aaa56966060e6273d17c8'),
      ('public.media_cutout_error(text,text,text,boolean)',                  'ead42caeb129e3059a5549af371f8110', '7dd8d58f9e75411de559aa1ab4fc0a5b'),
      ('public.media_cutout_finish(text,jsonb)',                             'f5c61b3e223f5d5d8426fdee48dc0feb', '339873fea823f8485b69b6e2b55c3eda'),
      ('public.list_media_cutouts(text,text,integer,integer)',               '74331a21b6df65107b0aa8fd3c2dfb3d', 'd9ce4d65fe7fcc7da66bd4af5bfe445d'),
      ('public.review_media_cutout(text,text,text,text,text)',               '16b9d378aca648f0b645b64bc7060041', '82a1048055beeb8b9402bc644e71666f')
    ) AS t(sig, repo_md5, this_md5)
  LOOP
    IF to_regprocedure(f.sig) IS NULL THEN
      RAISE EXCEPTION 'media_cutouts_cut_once: % is missing', f.sig;
    END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF v_md5 IS DISTINCT FROM (CASE WHEN v_fresh THEN f.repo_md5 ELSE f.this_md5 END) THEN
      RAISE EXCEPTION 'media_cutouts_cut_once: live % differs from the repo (md5 %) — stop and send its pg_get_functiondef', f.sig, v_md5;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND ((p.proname = 'get_media_cutout_tab_totals' AND pg_get_function_identity_arguments(p.oid) <> '')
                  OR (p.proname = 'guard_media_cutout_cut_once' AND pg_get_function_identity_arguments(p.oid) <> ''))) THEN
    RAISE EXCEPTION 'media_cutouts_cut_once: a new function name already exists with another signature';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.website_media_cutouts
  ADD COLUMN IF NOT EXISTS paid_calls      smallint NOT NULL DEFAULT 0 CHECK (paid_calls >= 0),
  ADD COLUMN IF NOT EXISTS paid_call_limit smallint NOT NULL DEFAULT 2 CHECK (paid_call_limit BETWEEN 0 AND 50),
  ADD COLUMN IF NOT EXISTS recut_allowed   boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_reason     text CHECK (hold_reason IS NULL OR length(hold_reason) <= 400),
  ADD COLUMN IF NOT EXISTS held_at         timestamptz;
COMMENT ON COLUMN public.website_media_cutouts.paid_calls IS
  'Paid provider calls this photo has cost: every successful submit AND every failed submit (automatic retries included); a failed status check is not counted. Never decreases (trg_guard_media_cutout_cut_once). Rows before 2026-09-28 were backfilled from what they show (20261010100000). docs/MEDIA-CUTOUTS.md "CUT ONCE".';
COMMENT ON COLUMN public.website_media_cutouts.paid_call_limit IS
  'Hard cap on paid_calls (2). Raised only by review_media_cutout admin actions (unlock_recut / retry_once / override_cap), one call at a time, audited.';
COMMENT ON COLUMN public.website_media_cutouts.recut_allowed IS
  'The owner''s one-shot permission to send a LOCKED photo (status ok / auto_fixed / approved / rejected) again. Granted only by review_media_cutout unlock_recut / retry_once; cleared when the job ends.';
COMMENT ON COLUMN public.website_media_cutouts.hold_reason IS
  'Non-null = "Needs owner": the photo stopped at its paid-call limit; the reason in plain words. Cleared by an admin override or a staff decision.';

-- ---------------------------------------------------------------------------
-- 2. Backfill — ONCE, when the columns are new. What a row shows it has cost:
--    a provider request id = at least one paid call; a parked re-run = one
--    more; `run` counts the results processed for it (not for staff's own
--    cut-outs). The greater of the two, never more than 50. Rows the
--    Photoroom 402s failed at submit carry no request id: 0.
--    A re-run staff had ALREADY asked for on a now-locked row keeps its
--    permission; a queued row already at the limit goes to Needs owner.
-- ---------------------------------------------------------------------------
DO $backfill$
BEGIN
  IF current_setting('cutonce.fresh', true) <> 'yes' THEN RETURN; END IF;
  UPDATE public.website_media_cutouts
     SET paid_calls = least(50, greatest(
           (provider_request_id IS NOT NULL)::int + (coalesce(last_rerun ? 'cutout_path', false))::int,
           CASE WHEN own_cutout_url IS NULL THEN run ELSE 0 END));
  UPDATE public.website_media_cutouts
     SET recut_allowed = true
   WHERE rerun AND job_state IN ('queued','submitted','ready','processing')
     AND status IN ('ok','auto_fixed','approved','rejected');
  UPDATE public.website_media_cutouts
     SET job_state = 'error', held_at = now(),
         hold_reason = format('Stopped: this photo has already cost %s paid calls (the limit is %s). An admin can allow one more.',
                              paid_calls, paid_call_limit)
   WHERE job_state = 'queued' AND paid_calls >= paid_call_limit;
END
$backfill$;

-- ---------------------------------------------------------------------------
-- 3. The guard. Every writer, every row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_media_cutout_cut_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_owner boolean := coalesce(current_setting('app.media_cutout_owner_override', true), '') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT v_owner AND (NEW.paid_calls <> 0 OR NEW.paid_call_limit > 2 OR NEW.recut_allowed) THEN
      RAISE EXCEPTION 'media cut-out: a new photo starts with 0 paid calls, a limit of 2 and no re-cut permission'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW.paid_calls < OLD.paid_calls THEN
      RAISE EXCEPTION 'media cut-out: paid calls never go down (% → %)', OLD.paid_calls, NEW.paid_calls USING ERRCODE = 'P0001';
    END IF;
    IF NOT v_owner AND (NEW.paid_call_limit > OLD.paid_call_limit OR (NEW.recut_allowed AND NOT OLD.recut_allowed)) THEN
      RAISE EXCEPTION 'media cut-out: only an admin action in Website → Photos can allow another paid call'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.job_state = 'queued' AND (TG_OP = 'INSERT' OR OLD.job_state IS DISTINCT FROM 'queued') THEN
    IF NEW.status IN ('ok','auto_fixed','approved','rejected') AND NOT NEW.recut_allowed THEN
      RAISE EXCEPTION 'media cut-out: this photo is % — locked; only "Unlock and re-cut" / "Try once more" can send it again', NEW.status
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.paid_calls >= NEW.paid_call_limit THEN
      RAISE EXCEPTION 'media cut-out: this photo has used % of % paid calls; only an admin override allows another', NEW.paid_calls, NEW.paid_call_limit
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.hold_reason IS NOT NULL THEN
      RAISE EXCEPTION 'media cut-out: this photo needs the owner (%)', NEW.hold_reason USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_media_cutout_cut_once() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_media_cutout_cut_once ON public.website_media_cutouts;
CREATE TRIGGER trg_guard_media_cutout_cut_once
BEFORE INSERT OR UPDATE ON public.website_media_cutouts
FOR EACH ROW EXECUTE FUNCTION public.guard_media_cutout_cut_once();

-- ---------------------------------------------------------------------------
-- 4. The worker's SQL (service role only; grants unchanged by CREATE OR
--    REPLACE and re-asserted in §7).
-- ---------------------------------------------------------------------------

-- What to send now. Unchanged: the switch, the monthly cap, mains of active
-- products first, the 10-minute push. NEW: a locked photo without the owner's
-- permission, a photo at its paid-call limit and a held photo are never handed
-- out; queued rows at the limit are parked in Needs owner with the reason.
CREATE OR REPLACE FUNCTION public.media_cutout_submit_batch(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_mode text := public.media_cutout_mode();
  v_used integer;
  v_left integer;
  v_rows jsonb;
BEGIN
  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('mode', v_mode, 'rows', '[]'::jsonb, 'cap_left', NULL);
  END IF;

  -- Cut once: what may not be sent leaves the queue, with its reason.
  UPDATE public.website_media_cutouts
     SET job_state = 'done', rerun = false, high_detail = false, updated_at = now()
   WHERE job_state = 'queued' AND status IN ('ok','auto_fixed','approved','rejected') AND NOT recut_allowed;
  UPDATE public.website_media_cutouts
     SET job_state = 'error', held_at = now(), recut_allowed = false, rerun = false, high_detail = false, updated_at = now(),
         hold_reason = format('Stopped: this photo has already cost %s paid calls (the limit is %s). An admin can allow one more.',
                              paid_calls, paid_call_limit)
   WHERE job_state = 'queued' AND paid_calls >= paid_call_limit;

  SELECT coalesce((SELECT provider_calls FROM public.website_media_cutout_usage WHERE month = public.media_cutout_month()), 0)
    INTO v_used;
  v_left := greatest(0, public.media_cutout_cap() - v_used);
  IF v_left = 0 THEN
    RETURN jsonb_build_object('mode', v_mode, 'rows', '[]'::jsonb, 'cap_left', 0);
  END IF;

  WITH picked AS (
    SELECT c.source_url
      FROM public.website_media_cutouts c
     WHERE c.job_state = 'queued'
       AND c.next_attempt_at <= now()
       AND c.orphaned_at IS NULL
       AND c.own_cutout_url IS NULL
       AND (v_mode = 'on' OR c.test_batch IS NOT NULL)
       AND (c.status NOT IN ('ok','auto_fixed','approved','rejected') OR c.recut_allowed)
       AND c.paid_calls < c.paid_call_limit
       AND c.hold_reason IS NULL
     ORDER BY c.priority,
              NOT EXISTS (SELECT 1 FROM public.website_product_media m
                            JOIN public.website_product_variants v ON v.id = m.variant_id
                            JOIN public.website_products p ON p.id = v.product_id
                           WHERE m.url = c.source_url AND p.status::text = 'active'),
              c.created_at
     LIMIT least(greatest(coalesce(p_limit, 8), 1), 20, v_left)
     FOR UPDATE OF c SKIP LOCKED
  ), upd AS (
    UPDATE public.website_media_cutouts c
       SET next_attempt_at = now() + interval '10 minutes', updated_at = now()
      FROM picked
     WHERE c.source_url = picked.source_url
    RETURNING c.source_url, c.high_detail, c.rerun
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('source_url', source_url, 'high_detail', high_detail, 'rerun', rerun)), '[]'::jsonb)
    INTO v_rows FROM upd;
  RETURN jsonb_build_object('mode', v_mode, 'rows', v_rows, 'cap_left', v_left);
END
$fn$;

-- The provider accepted the job: count the call (month AND this photo), ring
-- the 80 % bell once.
CREATE OR REPLACE FUNCTION public.media_cutout_submitted(
  p_source_url text, p_provider text, p_model text, p_request_id text, p_status_url text, p_response_url text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_month text := public.media_cutout_month();
  v_cap   integer := public.media_cutout_cap();
  v_used  integer;
  v_bell  timestamptz;
BEGIN
  UPDATE public.website_media_cutouts
     SET job_state = 'submitted', provider = p_provider, model = p_model, provider_request_id = p_request_id,
         provider_status_url = p_status_url, provider_response_url = p_response_url,
         submitted_at = now(), next_attempt_at = now(), last_error = NULL, updated_at = now(),
         paid_calls = paid_calls + 1
   WHERE source_url = p_source_url;

  INSERT INTO public.website_media_cutout_usage (month, provider_calls) VALUES (v_month, 1)
  ON CONFLICT (month) DO UPDATE SET provider_calls = website_media_cutout_usage.provider_calls + 1, updated_at = now()
  RETURNING provider_calls, bell_80_at INTO v_used, v_bell;

  IF v_bell IS NULL AND v_cap > 0 AND v_used * 5 >= v_cap * 4 THEN
    UPDATE public.website_media_cutout_usage SET bell_80_at = now() WHERE month = v_month AND bell_80_at IS NULL;
    IF FOUND THEN
      INSERT INTO public.staff_notifications (type, title, body, metadata)
      VALUES ('media_cutout_cap_near',
              'Background removal: ' || v_used || ' of ' || v_cap || ' photos used this month',
              'Automatic background removal has used 80% of this month''s limit (' || v_cap
                || ' photos). At the limit it pauses until next month; nothing is lost. Raise the limit in Website → Photos if needed.',
              jsonb_build_object('month', v_month, 'used', v_used, 'cap', v_cap));
    END IF;
  END IF;
  RETURN jsonb_build_object('used', v_used, 'cap', v_cap);
END
$fn$;

-- A sync provider answered. NEW: a call that answered after the row left the
-- queue (a staff decision in between) was still paid for — it is counted.
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
    UPDATE public.website_media_cutouts SET paid_calls = paid_calls + 1, updated_at = now() WHERE source_url = p_source_url;
    INSERT INTO public.website_media_cutout_usage (month, provider_calls) VALUES (public.media_cutout_month(), 1)
    ON CONFLICT (month) DO UPDATE SET provider_calls = website_media_cutout_usage.provider_calls + 1, updated_at = now();
    RETURN jsonb_build_object('error', 'not_queued', 'counted', true);
  END IF;
  v_used := public.media_cutout_submitted(p_source_url, p_provider, p_model, p_request_id, NULL, NULL);
  PERFORM public.media_cutout_result_ready(p_source_url, p_result_url);
  UPDATE public.website_media_cutouts
     SET provider_uncertainty = CASE WHEN p_uncertainty >= 0 AND p_uncertainty <= 1 THEN round(p_uncertainty, 4) END
   WHERE source_url = p_source_url;
  RETURN v_used || jsonb_build_object('ok', true);
END
$fn$;

-- Record a finished job. Unchanged, except: the owner's one-shot permission
-- ends here, and a finished job is no longer held.
CREATE OR REPLACE FUNCTION public.media_cutout_finish(p_source_url text, p_result jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  r      public.website_media_cutouts%ROWTYPE;
  v_new  text := p_result ->> 'status';
  v_pub  boolean;
BEGIN
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND OR r.job_state <> 'processing' THEN RETURN 'not_processing'; END IF;
  IF v_new NOT IN ('ok','auto_fixed','needs_review','approved') THEN
    RAISE EXCEPTION 'media_cutout_finish: bad status %', v_new;
  END IF;
  IF v_new = 'approved' AND r.own_cutout_url IS NULL THEN
    RAISE EXCEPTION 'media_cutout_finish: only an own cut-out lands approved';
  END IF;

  IF r.status IN ('approved','rejected') AND NOT r.rerun AND r.own_cutout_url IS NULL THEN
    UPDATE public.website_media_cutouts SET job_state = 'done', recut_allowed = false, finished_at = now(), updated_at = now()
     WHERE source_url = p_source_url;
    RETURN 'kept_staff_decision';
  END IF;

  v_pub := r.status IN ('ok','auto_fixed','approved');
  IF r.rerun AND v_pub AND v_new NOT IN ('ok','auto_fixed') THEN
    UPDATE public.website_media_cutouts
       SET job_state = 'done', rerun = false, high_detail = false, recut_allowed = false, finished_at = now(), updated_at = now(),
           last_rerun = p_result || jsonb_build_object('at', now())
     WHERE source_url = p_source_url;
    RETURN 'kept_published';
  END IF;

  UPDATE public.website_media_cutouts SET
    job_state = 'done', status = v_new,
    flags = coalesce(ARRAY(SELECT jsonb_array_elements_text(p_result -> 'flags')), '{}'),
    edges = coalesce(ARRAY(SELECT jsonb_array_elements_text(p_result -> 'edges')), '{}'),
    coverage = (p_result ->> 'coverage')::numeric, detail_kept = (p_result ->> 'detail_kept')::numeric,
    hero_usable = (p_result ->> 'hero_usable')::boolean,
    source_sha256 = p_result ->> 'source_sha256',
    source_w = (p_result ->> 'source_w')::integer, source_h = (p_result ->> 'source_h')::integer,
    output_kind = p_result ->> 'output_kind', master_path = p_result ->> 'master_path',
    cutout_path = p_result ->> 'cutout_path',
    cutout_w = (p_result ->> 'cutout_w')::integer, cutout_h = (p_result ->> 'cutout_h')::integer,
    catalog_path = p_result ->> 'catalog_path',
    catalog_w = (p_result ->> 'catalog_w')::integer, catalog_h = (p_result ->> 'catalog_h')::integer,
    catalog_small_path = p_result ->> 'catalog_small_path',
    catalog_small_w = (p_result ->> 'catalog_small_w')::integer, catalog_small_h = (p_result ->> 'catalog_small_h')::integer,
    timings = p_result -> 'timings',
    rerun = false, high_detail = false, last_rerun = NULL, last_error = NULL,
    recut_allowed = false, hold_reason = NULL, held_at = NULL,
    reviewed_by = CASE WHEN v_new = 'approved' THEN reviewed_by ELSE NULL END,
    reviewed_at = CASE WHEN v_new = 'approved' THEN reviewed_at ELSE NULL END,
    finished_at = now(), updated_at = now()
  WHERE source_url = p_source_url;
  RETURN 'recorded';
END
$fn$;

-- A step failed. Unchanged backoff (5 min → 30 min → 3 h, 1 try + 3). NEW:
--   - a failed SUBMIT of a row that was in the queue is a paid call (+1);
--     a failed status check or processing step is not
--   - a retry that needs another paid call (stage 'submit', including the
--     30-minute provider timeout) happens only below the photo's limit; at
--     the limit the row stops in Needs owner with the reason ('held')
--   - a final failure at the limit is held too; the one-shot permission ends
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
BEGIN
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF p_stage NOT IN ('submit','poll','process') THEN RAISE EXCEPTION 'media_cutout_error: bad stage %', p_stage; END IF;

  v_paid := r.paid_calls + CASE WHEN p_stage = 'submit' AND r.job_state = 'queued' THEN 1 ELSE 0 END;

  IF p_retryable AND r.attempts < 3 AND NOT (p_stage = 'submit' AND v_paid >= r.paid_call_limit) THEN
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
-- 5. Staff.
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
  IF v_filter NOT IN ('needs_review','needs_owner','failed','auto_fixed','queue','completed','published','rejected','all','test') THEN
    RETURN jsonb_build_object('error', 'invalid_filter');
  END IF;

  WITH base AS (
    SELECT c.*,
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
       AND CASE v_filter
             WHEN 'needs_review' THEN c.status = 'needs_review'
             WHEN 'needs_owner'  THEN c.hold_reason IS NOT NULL
             WHEN 'failed'       THEN c.status = 'failed' AND c.hold_reason IS NULL
             WHEN 'auto_fixed'   THEN c.status = 'auto_fixed'
             WHEN 'queue'        THEN c.hold_reason IS NULL AND (c.status = 'pending' OR c.job_state IN ('queued','submitted','ready','processing'))
             WHEN 'completed'    THEN c.status IN ('ok','auto_fixed','approved')
             WHEN 'published'    THEN c.status IN ('ok','auto_fixed','approved')
             WHEN 'rejected'     THEN c.status = 'rejected'
             WHEN 'test'         THEN c.test_batch IS NOT NULL
             ELSE true END
  ), hit AS (
    SELECT * FROM base
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

-- Every tab: photos and the paid calls they have cost. Plus who may reopen
-- (admin) and the price the confirms estimate with.
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
  SELECT jsonb_build_object(
      'needs_review', jsonb_build_object('count', count(*) FILTER (WHERE status = 'needs_review'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'needs_review'), 0)),
      'needs_owner',  jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NOT NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NOT NULL), 0)),
      'failed',       jsonb_build_object('count', count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'failed' AND hold_reason IS NULL), 0)),
      'auto_fixed',   jsonb_build_object('count', count(*) FILTER (WHERE status = 'auto_fixed'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'auto_fixed'), 0)),
      'queue',        jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NULL AND (status = 'pending' OR job_state IN ('queued','submitted','ready','processing'))),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NULL AND (status = 'pending' OR job_state IN ('queued','submitted','ready','processing'))), 0)),
      'completed',    jsonb_build_object('count', count(*) FILTER (WHERE status IN ('ok','auto_fixed','approved')),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status IN ('ok','auto_fixed','approved')), 0)),
      'rejected',     jsonb_build_object('count', count(*) FILTER (WHERE status = 'rejected'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE status = 'rejected'), 0)),
      'test',         jsonb_build_object('count', count(*) FILTER (WHERE test_batch IS NOT NULL),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE test_batch IS NOT NULL), 0)),
      'all',          jsonb_build_object('count', count(*), 'paid_calls', coalesce(sum(paid_calls), 0)))
    INTO v_tabs
    FROM public.website_media_cutouts WHERE orphaned_at IS NULL;
  RETURN jsonb_build_object(
    'tabs', v_tabs,
    'is_admin', public.has_role(v_uid, 'admin'),
    'per_photo_limit', 2,
    'provider', CASE WHEN v_prov IN ('fal','replicate') THEN v_prov ELSE 'photoroom' END,
    'price_usd', CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_media_cutout_tab_totals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_media_cutout_tab_totals() TO authenticated;

-- Staff decisions. One RPC, audited per action.
--   approve / reject   final decisions (lock the photo); a pending re-run is
--                      cancelled
--   rerun              queued again — refused on a LOCKED photo (use the
--   rerun_high_detail  admin actions), at the paid-call limit, or held
--   use_rerun          the parked re-run result becomes the version, approved
--   own_cutout         staff's own transparent file (free: no provider call)
--   unlock_recut       ADMIN. Completed → ONE paid re-cut
--   retry_once         ADMIN. Rejected  → ONE paid re-cut
--   override_cap       ADMIN. Needs owner / at the limit → ONE more paid call
-- The three admin actions set the photo's limit to paid_calls + 1 — exactly
-- one more paid call, automatic retries included — record the estimated cost in the audit row, and are the ONLY way a
-- locked or capped photo is sent again.
CREATE OR REPLACE FUNCTION public.review_media_cutout(p_source_url text, p_action text, p_note text DEFAULT NULL,
                                                      p_own_cutout_url text DEFAULT NULL,
                                                      p_expected_status text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  r        public.website_media_cutouts%ROWTYPE;
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_now    timestamptz := now();
  v_new    text;
  v_locked boolean;
  v_price  text := (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd');
  v_cost   numeric;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_action NOT IN ('approve','reject','rerun','rerun_high_detail','use_rerun','own_cutout',
                      'unlock_recut','retry_once','override_cap') THEN
    RETURN jsonb_build_object('error', 'invalid_action');
  END IF;
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF p_expected_status IS NOT NULL AND p_expected_status IS DISTINCT FROM r.status THEN
    RETURN jsonb_build_object('error', 'stale', 'status', r.status);
  END IF;
  IF r.job_state IN ('submitted','ready','processing') THEN
    RETURN jsonb_build_object('error', 'busy', 'job_state', r.job_state);
  END IF;
  v_locked := r.status IN ('ok','auto_fixed','approved','rejected');
  v_cost := CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END;

  IF p_action IN ('unlock_recut','retry_once','override_cap') AND NOT public.has_role(v_uid, 'admin') THEN
    RETURN jsonb_build_object('error', 'admin_only');
  END IF;

  IF p_action = 'approve' THEN
    IF r.cutout_path IS NULL THEN RETURN jsonb_build_object('error', 'no_cutout'); END IF;
    UPDATE public.website_media_cutouts
       SET status = 'approved', reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now,
           job_state = CASE WHEN job_state = 'queued' THEN 'done' ELSE job_state END,
           rerun = false, high_detail = false, recut_allowed = false, hold_reason = NULL, held_at = NULL
     WHERE source_url = p_source_url;
    v_new := 'approved';
  ELSIF p_action = 'reject' THEN
    UPDATE public.website_media_cutouts
       SET status = 'rejected', job_state = CASE WHEN job_state = 'queued' THEN 'done' ELSE job_state END,
           rerun = false, high_detail = false, recut_allowed = false, hold_reason = NULL, held_at = NULL,
           reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := 'rejected';
  ELSIF p_action IN ('rerun','rerun_high_detail') THEN
    IF v_locked THEN
      RETURN jsonb_build_object('error', 'locked', 'status', r.status);
    END IF;
    IF r.hold_reason IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'needs_owner', 'reason', r.hold_reason);
    END IF;
    IF r.paid_calls >= r.paid_call_limit THEN
      RETURN jsonb_build_object('error', 'paid_call_cap', 'paid_calls', r.paid_calls, 'limit', r.paid_call_limit);
    END IF;
    UPDATE public.website_media_cutouts
       SET job_state = 'queued', rerun = r.status NOT IN ('pending','failed'),
           high_detail = (p_action = 'rerun_high_detail'), attempts = 0, next_attempt_at = v_now,
           own_cutout_url = NULL, cpu_fallback = false, last_error = NULL, last_rerun = NULL,
           status = CASE WHEN r.status = 'failed' THEN 'pending' ELSE r.status END,
           review_note = coalesce(v_note, review_note), updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := CASE WHEN r.status = 'failed' THEN 'pending' ELSE r.status END;
  ELSIF p_action IN ('unlock_recut','retry_once','override_cap') THEN
    IF p_action = 'unlock_recut' AND r.status NOT IN ('ok','auto_fixed','approved') THEN
      RETURN jsonb_build_object('error', 'not_completed', 'status', r.status);
    END IF;
    IF p_action = 'retry_once' AND r.status <> 'rejected' THEN
      RETURN jsonb_build_object('error', 'not_rejected', 'status', r.status);
    END IF;
    IF p_action = 'override_cap' AND (v_locked OR (r.hold_reason IS NULL AND r.paid_calls < r.paid_call_limit)) THEN
      RETURN jsonb_build_object('error', 'not_capped', 'status', r.status);
    END IF;
    PERFORM set_config('app.media_cutout_owner_override', 'on', true);
    UPDATE public.website_media_cutouts
       SET paid_call_limit = paid_calls + 1,
           recut_allowed = v_locked, hold_reason = NULL, held_at = NULL,
           job_state = 'queued', rerun = r.status NOT IN ('pending','failed'),
           high_detail = false, attempts = 0, next_attempt_at = v_now,
           own_cutout_url = NULL, cpu_fallback = false, last_error = NULL, last_rerun = NULL,
           status = CASE WHEN r.status = 'failed' THEN 'pending' ELSE r.status END,
           review_note = coalesce(v_note, review_note), updated_at = v_now
     WHERE source_url = p_source_url;
    PERFORM set_config('app.media_cutout_owner_override', '', true);
    v_new := CASE WHEN r.status = 'failed' THEN 'pending' ELSE r.status END;
  ELSIF p_action = 'use_rerun' THEN
    IF r.last_rerun IS NULL OR (r.last_rerun ->> 'cutout_path') IS NULL THEN
      RETURN jsonb_build_object('error', 'no_rerun');
    END IF;
    UPDATE public.website_media_cutouts SET
      status = 'approved',
      flags = coalesce(ARRAY(SELECT jsonb_array_elements_text(r.last_rerun -> 'flags')), '{}'),
      edges = coalesce(ARRAY(SELECT jsonb_array_elements_text(r.last_rerun -> 'edges')), '{}'),
      output_kind = r.last_rerun ->> 'output_kind', master_path = r.last_rerun ->> 'master_path',
      cutout_path = r.last_rerun ->> 'cutout_path',
      cutout_w = (r.last_rerun ->> 'cutout_w')::integer, cutout_h = (r.last_rerun ->> 'cutout_h')::integer,
      catalog_path = r.last_rerun ->> 'catalog_path',
      catalog_w = (r.last_rerun ->> 'catalog_w')::integer, catalog_h = (r.last_rerun ->> 'catalog_h')::integer,
      catalog_small_path = r.last_rerun ->> 'catalog_small_path',
      catalog_small_w = (r.last_rerun ->> 'catalog_small_w')::integer, catalog_small_h = (r.last_rerun ->> 'catalog_small_h')::integer,
      hero_usable = (r.last_rerun ->> 'hero_usable')::boolean, timings = r.last_rerun -> 'timings',
      last_rerun = NULL, reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
    WHERE source_url = p_source_url;
    v_new := 'approved';
  ELSE -- own_cutout (free: no provider call)
    IF p_own_cutout_url IS NULL
       OR p_own_cutout_url !~ '^https://[^/]+/storage/v1/object/public/promotions/website/derived/own/[A-Za-z0-9_.-]+\.(png|webp)$' THEN
      RETURN jsonb_build_object('error', 'invalid_own_cutout_url');
    END IF;
    UPDATE public.website_media_cutouts
       SET own_cutout_url = p_own_cutout_url, result_url = p_own_cutout_url, job_state = 'ready',
           rerun = false, high_detail = false, attempts = 0, next_attempt_at = v_now, cpu_fallback = false,
           recut_allowed = false, hold_reason = NULL, held_at = NULL,
           last_error = NULL, reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := r.status;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('website_media_cutout', r.id, 'review_media_cutout:' || p_action,
          jsonb_build_object('source_url', r.source_url, 'status', r.status, 'job_state', r.job_state,
                             'cutout_path', r.cutout_path, 'flags', to_jsonb(r.flags),
                             'paid_calls', r.paid_calls, 'paid_call_limit', r.paid_call_limit, 'hold_reason', r.hold_reason),
          jsonb_build_object('source_url', r.source_url, 'status', v_new, 'action', p_action, 'note', v_note,
                             'own_cutout_url', p_own_cutout_url)
            || CASE WHEN p_action IN ('unlock_recut','retry_once','override_cap')
                    THEN jsonb_build_object('paid_call_limit', r.paid_calls + 1,
                                            'paid_calls_allowed', 1, 'estimated_cost_usd', v_cost)
                    ELSE '{}'::jsonb END,
          v_uid, v_now);
  RETURN jsonb_build_object('ok', true, 'status', v_new, 'action', p_action);
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Grants (re-asserted; CREATE OR REPLACE keeps them, this proves it).
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.media_cutout_submit_batch(integer)',
    'public.media_cutout_submitted(text,text,text,text,text,text)',
    'public.media_cutout_sync_result(text,text,text,text,text,numeric)',
    'public.media_cutout_finish(text,jsonb)', 'public.media_cutout_error(text,text,text,boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.list_media_cutouts(text,text,integer,integer)', 'public.review_media_cutout(text,text,text,text,text)',
    'public.get_media_cutout_tab_totals()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 8. Self-check, inside the transaction.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'website_media_cutouts'
        AND column_name IN ('paid_calls','paid_call_limit','recut_allowed','hold_reason','held_at')) <> 5 THEN
    RAISE EXCEPTION 'media_cutouts_cut_once self-check: columns missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_guard_media_cutout_cut_once'
                    AND t.tgrelid = 'public.website_media_cutouts'::regclass) THEN
    RAISE EXCEPTION 'media_cutouts_cut_once self-check: guard trigger missing';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.media_cutout_submit_batch(integer)', 'public.media_cutout_submitted(text,text,text,text,text,text)',
    'public.media_cutout_sync_result(text,text,text,text,text,numeric)', 'public.media_cutout_finish(text,jsonb)',
    'public.media_cutout_error(text,text,text,boolean)', 'public.guard_media_cutout_cut_once()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'media_cutouts_cut_once self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.media_cutout_submit_batch(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'media_cutouts_cut_once self-check: service_role cannot run the worker functions';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.list_media_cutouts(text,text,integer,integer)', 'public.review_media_cutout(text,text,text,text,text)',
    'public.get_media_cutout_tab_totals()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'media_cutouts_cut_once self-check: Hub RPC grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  -- Nothing the rule forbids is waiting to be sent.
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state = 'queued'
                AND ((status IN ('ok','auto_fixed','approved','rejected') AND NOT recut_allowed)
                     OR paid_calls >= paid_call_limit OR hold_reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'media_cutouts_cut_once self-check: a locked, capped or held photo is still queued';
  END IF;
  IF public.media_cutout_mode() = 'off'
     AND jsonb_array_length(public.media_cutout_submit_batch(5) -> 'rows') <> 0 THEN
    RAISE EXCEPTION 'media_cutouts_cut_once self-check: the submit batch returned rows while off';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) The columns and the guard. Expect one row:  5 | t
-- SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'website_media_cutouts'
--           AND column_name IN ('paid_calls','paid_call_limit','recut_allowed','hold_reason','held_at')) AS cols,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_media_cutout_cut_once') AS guarded;
--
-- (2) The backfill against the month's counter. Expect: backfilled <= calls_all_months,
--     every limit 2, nothing over the limit still queued. With the 2026-09-28 counts
--     (135 calls in 2026-09; ~59 finished by Replicate; 378 queued; 495 failed with
--     Photoroom 402) expect roughly:
--       calls_all_months = 135 (+ any earlier month) | backfilled between 59 and 135 |
--       limits = {2} | queued_over_limit = 0 | failed_at_zero ≈ 495
-- SELECT (SELECT coalesce(sum(provider_calls), 0) FROM public.website_media_cutout_usage)  AS calls_all_months,
--        (SELECT sum(paid_calls) FROM public.website_media_cutouts)                          AS backfilled,
--        (SELECT array_agg(DISTINCT paid_call_limit) FROM public.website_media_cutouts)      AS limits,
--        (SELECT count(*) FROM public.website_media_cutouts
--          WHERE job_state = 'queued' AND paid_calls >= paid_call_limit)                     AS queued_over_limit,
--        (SELECT count(*) FROM public.website_media_cutouts
--          WHERE status = 'failed' AND paid_calls = 0)                                       AS failed_at_zero;
--
-- (3) The queue is unchanged except for photos that had already used 2 paid
--     calls. Expect: queued ≈ 378 − held | held = photos that had cost 2+ | 0
-- SELECT count(*) FILTER (WHERE job_state = 'queued')            AS queued,
--        count(*) FILTER (WHERE hold_reason IS NOT NULL)          AS held,
--        count(*) FILTER (WHERE job_state = 'queued' AND status IN ('ok','auto_fixed','approved','rejected')
--                         AND NOT recut_allowed)                  AS locked_but_queued
--   FROM public.website_media_cutouts;
--
-- (4) The guard refuses. Expect an ERROR "…locked; only "Unlock and re-cut"…" and
--     nothing changed (it rolls back by itself):
-- UPDATE public.website_media_cutouts SET job_state = 'queued'
--  WHERE source_url = (SELECT source_url FROM public.website_media_cutouts WHERE status = 'approved' LIMIT 1);
--
-- (5) Browser roles. Expect:  f | f | t | t
-- SELECT has_function_privilege('authenticated','public.media_cutout_submit_batch(integer)','EXECUTE') AS auth_submit,
--        has_function_privilege('authenticated','public.media_cutout_error(text,text,text,boolean)','EXECUTE') AS auth_error,
--        has_function_privilege('authenticated','public.review_media_cutout(text,text,text,text,text)','EXECUTE') AS auth_review,
--        has_function_privilege('authenticated','public.get_media_cutout_tab_totals()','EXECUTE') AS auth_tabs;
-- ===========================================================================
