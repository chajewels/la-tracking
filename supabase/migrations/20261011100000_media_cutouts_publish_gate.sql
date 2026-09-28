-- ===========================================================================
-- media_cutouts_publish_gate — product photo cut-outs: a photo is cut ONLY
-- while its product is published; Completed is final; "Keep original"
-- (owner rules 2026-09-28). docs/MEDIA-CUTOUTS.md "PUBLISH GATE". The hero
-- pipeline (website_hero_cutouts, the storefront workflow) is not touched.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- and after scripts/function-drift-audit shows 0 | 0 | 0. One transaction.
-- CALLS NO PROVIDER, SPENDS NOTHING. Safe in any switch position (Off is the
-- quiet choice). No edge-function change: media-cutout-worker only reaches
-- the queue through the SQL functions redefined here.
--
-- "PUBLISHED" = website_products.status = 'active' (enum website_product_status
-- draft | active | archived, 20260908030829). It is the one test the website
-- API uses for every product it serves (supabase/functions/website/index.ts
-- .eq("status", "active") on /catalog/products and /catalog/products/:slug)
-- and the one the cut-out queue already used to put live mains first. A photo
-- (one source URL) is published when ANY product using it is published:
-- public.media_cutout_url_published(url).
--
-- What it does:
--
--   A. A new job_state 'waiting' = "Waiting for publish": recorded, never
--      sent, not in the queue, not counted. A new status 'kept_original' =
--      "Kept original": Completed, the storefront shows the normal photo (it
--      is not ok / auto_fixed / approved, the only statuses the website may
--      show), hero_usable = false, locked, zero cost.
--
--   B. THE GATE, in the database, for every writer:
--        - trg_guard_media_cutout_cut_once (redefined): a row ENTERING the
--          queue whose photo is not published is written as 'waiting'
--          instead. So the enqueue trigger, the test batch, Re-run, the admin
--          actions and the worker's retries all queue nothing for an
--          unpublished product — none of them had to change.
--        - media_cutout_submit_batch (redefined): before picking, queued rows
--          of unpublished photos move to 'waiting', waiting rows of published
--          photos move back; it never hands out an unpublished photo.
--        - trg_website_product_cutout_publish_gate (new, website_products
--          AFTER UPDATE OF status):
--            published   → its photos not yet cut are queued ONCE: waiting
--                          rows, missing rows, and failed rows that are
--                          below their paid-call limit, not held and not an
--                          own cut-out. Completed, Rejected, Kept original,
--                          Needs review (a result is waiting for staff) and
--                          Needs owner are never queued.
--            unpublished → its queued, not-yet-sent photos move to 'waiting'
--                          (no paid call, no failure, not counted). A photo
--                          already at the provider finishes normally:
--                          media_cutout_sync_result / media_cutout_error
--                          accept a 'waiting' row the worker had in hand.
--        - trg_website_media_cutout_publish_gate (new, website_product_media
--          AFTER INSERT OR UPDATE OF url): a waiting photo added to a
--          published product is queued. It never re-queues failed photos
--          (the Catalog save re-inserts media rows on every save).
--      Both triggers turn any error into a WARNING: a publish or a photo
--      save never fails because of cut-outs; submit_batch is the backstop.
--
--   C. COMPLETED IS FINAL: "Unlock and re-cut" is gone. The guard refuses a
--      Completed photo (ok / auto_fixed / approved / kept_original) entering
--      the queue for EVERY writer, the owner override included;
--      review_media_cutout answers unlock_recut with completed_is_final. A
--      rejected photo keeps "Try once more" (admin). Re-cut permissions still
--      queued on Completed photos (the 6 from 20261010100000's backfill) are
--      cancelled here; one already at the provider finishes normally.
--
--   D. KEEP ORIGINAL: review_media_cutout 'keep_original' on any photo not
--      yet Completed and not being processed (Needs review, Needs owner,
--      Failed, Rejected, Waiting for publish, In the queue). Free, audited
--      (estimated_cost_usd 0).
--
--   E. Staff lists: list_media_cutouts gains 'waiting' and a per-row
--      'published'; 'queue' counts only publish-eligible photos; 'completed'
--      includes kept_original. get_media_cutout_tab_totals likewise.
--      media_cutout_housekeeping also forgets waiting photos no product uses.
--
--   F. One-time cleanup (first run only): queued photos of unpublished
--      products → 'waiting'; queued re-cuts of Completed photos → cancelled.
--      Before / after counts are RAISE NOTICEd and kept in one audit_logs row
--      (action media_cutouts_publish_gate) — verification (0) reads them back.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). The eight
-- functions redefined here are md5-checked against the bodies of
-- 20261010100000_media_cutouts_cut_once.sql (owner-verified applied on live
-- 2026-09-28 14:29 JST) and, for media_cutout_housekeeping,
-- 20261006100000_media_cutouts.sql. Any difference aborts with NOTHING
-- changed — stop and send the live pg_get_functiondef. Re-running the file is
-- safe (the second run accepts this file's own bodies; the cleanup and its
-- audit row happen once).
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
  IF to_regclass('public.website_products') IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_media') IS NULL THEN v_missing := v_missing || 'website_product_media'::text; END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regprocedure('public.media_cutout_source_ok(text)') IS NULL THEN v_missing := v_missing || 'media_cutout_source_ok(text)'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                   AND table_name = 'website_media_cutouts' AND column_name = 'paid_calls') THEN
    v_missing := v_missing || 'website_media_cutouts.paid_calls (20261010100000_media_cutouts_cut_once)'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                  WHERE t.typname = 'website_product_status' AND e.enumlabel = 'active') THEN
    v_missing := v_missing || 'website_product_status.active'::text;
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate: missing: %', array_to_string(v_missing, ', ');
  END IF;

  v_fresh := to_regprocedure('public.media_cutout_url_published(text)') IS NULL;
  PERFORM set_config('pubgate.fresh', CASE WHEN v_fresh THEN 'yes' ELSE 'no' END, true);

  -- Live must be exactly what this was written against: the cut_once bodies
  -- (and PR 1's housekeeping) on the first run, this file's own on a re-run.
  FOR f IN SELECT * FROM (VALUES
      ('public.guard_media_cutout_cut_once()',                              '69f95c0a6984a704b98aa6e35873a6b3', '1e19b5efb56d55660d64bea22257855e'),
      ('public.media_cutout_submit_batch(integer)',                         '8b12cd478a5f8265422be4e9f6515a4f', '0c5dda50ed9f6fa7f4987bf789974aa6'),
      ('public.media_cutout_sync_result(text,text,text,text,text,numeric)', '59fd238c773aaa56966060e6273d17c8', '3ca3e1b0b25156975157842228226de3'),
      ('public.media_cutout_error(text,text,text,boolean)',                 '7dd8d58f9e75411de559aa1ab4fc0a5b', '249c4bcb4565f8feedb93b744adb7394'),
      ('public.media_cutout_housekeeping(integer)',                         '4c03fc9b177bfc7cde6e401a46837e7f', 'fb9d17f7756ce2440bed9c4b664d2621'),
      ('public.list_media_cutouts(text,text,integer,integer)',              'd9ce4d65fe7fcc7da66bd4af5bfe445d', '1e799101ccf81357f637cd567fdcc3ef'),
      ('public.get_media_cutout_tab_totals()',                              'b1fa9296540d8354930919d22f1bf766', '7dde5ae28a2d09dba6e17d55f17c52b5'),
      ('public.review_media_cutout(text,text,text,text,text)',              '82a1048055beeb8b9402bc644e71666f', '154475285a68d6d7b86763359ef06f62')
    ) AS t(sig, live_md5, this_md5)
  LOOP
    IF to_regprocedure(f.sig) IS NULL THEN
      RAISE EXCEPTION 'media_cutouts_publish_gate: % is missing', f.sig;
    END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(f.sig);
    IF v_md5 IS DISTINCT FROM (CASE WHEN v_fresh THEN f.live_md5 ELSE f.this_md5 END) THEN
      RAISE EXCEPTION 'media_cutouts_publish_gate: live % differs from the repo (md5 %) — stop and send its pg_get_functiondef', f.sig, v_md5;
    END IF;
  END LOOP;

  IF v_fresh AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                          WHERE n.nspname = 'public'
                            AND p.proname IN ('media_cutout_url_published','media_cutout_queue_published',
                                              'media_cutout_dequeue_unpublished','media_cutout_follow_product_publish',
                                              'media_cutout_follow_media_publish')) THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate: a new function name already exists';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The two new values. The CHECKs are replaced by named ones (the old ones
--    are found by what they check, not by name).
-- ---------------------------------------------------------------------------
DO $checks$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.website_media_cutouts'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ~ '\mstatus\M.*needs_review'
                   OR pg_get_constraintdef(oid) ~ '\mjob_state\M.*processing')
  LOOP
    EXECUTE format('ALTER TABLE public.website_media_cutouts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$checks$;
ALTER TABLE public.website_media_cutouts
  ADD CONSTRAINT website_media_cutouts_status_check
      CHECK (status IN ('pending','ok','auto_fixed','needs_review','approved','rejected','failed','kept_original')),
  ADD CONSTRAINT website_media_cutouts_job_state_check
      CHECK (job_state IN ('queued','waiting','submitted','ready','processing','done','error'));
COMMENT ON COLUMN public.website_media_cutouts.job_state IS
  'queued (will be sent) | waiting (Waiting for publish: its product is not published — never sent, not counted) | submitted | ready | processing | done | error. A row entering the queue for an unpublished photo is written as waiting by trg_guard_media_cutout_cut_once (20261011100000). docs/MEDIA-CUTOUTS.md "PUBLISH GATE".';
COMMENT ON COLUMN public.website_media_cutouts.status IS
  'pending | ok | auto_fixed | needs_review | approved | rejected | failed | kept_original. Only ok / auto_fixed / approved may be shown. kept_original = "Keep original": Completed, uncut, the storefront (and the hero) show the normal photo; locked; zero cost.';

-- ---------------------------------------------------------------------------
-- 2. What "published" means for a photo. SECURITY DEFINER: the guard runs as
--    whichever role writes the row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_url_published(p_url text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.website_product_media m
      JOIN public.website_product_variants v ON v.id = m.variant_id
      JOIN public.website_products p ON p.id = v.product_id
     WHERE m.url = p_url AND p.status::text = 'active')
$fn$;
COMMENT ON FUNCTION public.media_cutout_url_published(text) IS
  'A product photo is published when ANY product using it has website_products.status = ''active'' — the test the website API serves products by. The publish gate of background removal (20261011100000).';

-- ---------------------------------------------------------------------------
-- 3. The guard. Every writer, every row. Unchanged: paid calls never go down,
--    only admin actions raise the limit or grant a re-cut, a capped or held
--    photo never enters the queue. NEW: Completed is final for everyone; an
--    unpublished photo entering the queue waits instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_media_cutout_cut_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_owner boolean := coalesce(current_setting('app.media_cutout_owner_override', true), '') = 'on';
  v_enter boolean;
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

  -- Entering the queue (or Waiting for publish, which is the queue on hold).
  v_enter := NEW.job_state IN ('queued','waiting')
             AND (TG_OP = 'INSERT' OR OLD.job_state NOT IN ('queued','waiting'));
  IF v_enter THEN
    IF NEW.status IN ('ok','auto_fixed','approved','kept_original') THEN
      RAISE EXCEPTION 'media cut-out: this photo is % — Completed is final (locked); it is never sent again', NEW.status
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status = 'rejected' AND NOT NEW.recut_allowed THEN
      RAISE EXCEPTION 'media cut-out: this photo is rejected — locked; only "Try once more" can send it again'
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

  -- The publish gate: only a published photo is ever queued.
  IF NEW.job_state = 'queued' AND (TG_OP = 'INSERT' OR OLD.job_state IS DISTINCT FROM 'queued')
     AND NOT public.media_cutout_url_published(NEW.source_url) THEN
    NEW.job_state := 'waiting';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_media_cutout_cut_once() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Queue / dequeue by publish state. Service role only; called by the two
--    triggers below. Each returns what it moved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_cutout_queue_published(p_urls text[], p_include_failed boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_urls   text[];
  v_new    integer := 0;
  v_back   integer := 0;
  v_failed integer := 0;
BEGIN
  SELECT array_agg(DISTINCT u) INTO v_urls FROM unnest(coalesce(p_urls, '{}')) u
   WHERE public.media_cutout_source_ok(u) AND public.media_cutout_url_published(u);
  IF v_urls IS NULL THEN
    RETURN jsonb_build_object('new', 0, 'from_waiting', 0, 'from_failed', 0);
  END IF;

  -- Photos never recorded (e.g. older than background removal).
  INSERT INTO public.website_media_cutouts (source_url, source_kind, priority)
  SELECT DISTINCT ON (m.url) m.url, CASE WHEN m.page365_photo_id IS NOT NULL THEN 'page365' ELSE 'staff' END,
         CASE WHEN coalesce(m.sort, 0) = 0 THEN 0 ELSE 1 END
    FROM public.website_product_media m
   WHERE m.url = ANY (v_urls)
   ORDER BY m.url, m.sort
  ON CONFLICT (source_url) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- Waiting for publish → the queue. A photo the worker may still hold keeps
  -- its later next_attempt_at, so it is never handed out twice.
  UPDATE public.website_media_cutouts
     SET job_state = 'queued', next_attempt_at = greatest(next_attempt_at, now()), updated_at = now()
   WHERE source_url = ANY (v_urls) AND job_state = 'waiting'
     AND status NOT IN ('ok','auto_fixed','approved','kept_original')
     AND (status <> 'rejected' OR recut_allowed)
     AND paid_calls < paid_call_limit AND hold_reason IS NULL;
  GET DIAGNOSTICS v_back = ROW_COUNT;

  -- Failed and never cut: queued once more, on a publish only. Never a held
  -- photo, one at its limit, or a staff upload that failed to process.
  IF coalesce(p_include_failed, false) THEN
    UPDATE public.website_media_cutouts
       SET job_state = 'queued', status = 'pending', attempts = 0, next_attempt_at = now(),
           last_error = NULL, cpu_fallback = false, updated_at = now()
     WHERE source_url = ANY (v_urls) AND job_state = 'error' AND status = 'failed'
       AND hold_reason IS NULL AND paid_calls < paid_call_limit AND own_cutout_url IS NULL;
    GET DIAGNOSTICS v_failed = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('new', v_new, 'from_waiting', v_back, 'from_failed', v_failed);
END
$fn$;

CREATE OR REPLACE FUNCTION public.media_cutout_dequeue_unpublished(p_urls text[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.website_media_cutouts
     SET job_state = 'waiting', updated_at = now()
   WHERE source_url = ANY (coalesce(p_urls, '{}')) AND job_state = 'queued'
     AND NOT public.media_cutout_url_published(source_url);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

-- A product's publish state changed.
CREATE OR REPLACE FUNCTION public.media_cutout_follow_product_publish()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_urls text[];
BEGIN
  BEGIN
    SELECT array_agg(DISTINCT m.url) INTO v_urls
      FROM public.website_product_media m
      JOIN public.website_product_variants v ON v.id = m.variant_id
     WHERE v.product_id = NEW.id AND public.media_cutout_source_ok(m.url);
    IF v_urls IS NOT NULL THEN
      IF NEW.status::text = 'active' THEN
        PERFORM public.media_cutout_queue_published(v_urls, true);
      ELSIF OLD.status::text = 'active' THEN
        PERFORM public.media_cutout_dequeue_unpublished(v_urls);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'media_cutout_follow_product_publish: % (product saved; the worker re-checks every run)', SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

-- A photo was added to (or changed on) a product: a waiting photo that is now
-- published is queued. Never failed ones (the Catalog save re-inserts media
-- rows on every save; that is not a publish).
CREATE OR REPLACE FUNCTION public.media_cutout_follow_media_publish()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  BEGIN
    IF public.media_cutout_source_ok(NEW.url) THEN
      PERFORM public.media_cutout_queue_published(ARRAY[NEW.url], false);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'media_cutout_follow_media_publish: % (photo saved; the worker re-checks every run)', SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_website_product_cutout_publish_gate ON public.website_products;
CREATE TRIGGER trg_website_product_cutout_publish_gate
AFTER UPDATE OF status ON public.website_products
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.media_cutout_follow_product_publish();

DROP TRIGGER IF EXISTS trg_website_media_cutout_publish_gate ON public.website_product_media;
CREATE TRIGGER trg_website_media_cutout_publish_gate
AFTER INSERT OR UPDATE OF url ON public.website_product_media
FOR EACH ROW EXECUTE FUNCTION public.media_cutout_follow_media_publish();

-- ---------------------------------------------------------------------------
-- 5. The worker's SQL.
-- ---------------------------------------------------------------------------

-- What to send now. Unchanged: the switch, the monthly cap, mains first, the
-- 10-minute push, cut once. NEW: Completed is final (a re-cut permission on a
-- Completed photo is cancelled); the queue follows publish state; only a
-- published photo is ever handed out.
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

  -- Cut once / Completed is final: what may not be sent leaves the queue.
  UPDATE public.website_media_cutouts
     SET job_state = 'done', rerun = false, high_detail = false, recut_allowed = false, updated_at = now()
   WHERE job_state IN ('queued','waiting')
     AND (status IN ('ok','auto_fixed','approved','kept_original') OR (status = 'rejected' AND NOT recut_allowed));
  UPDATE public.website_media_cutouts
     SET job_state = 'error', held_at = now(), recut_allowed = false, rerun = false, high_detail = false, updated_at = now(),
         hold_reason = format('Stopped: this photo has already cost %s paid calls (the limit is %s). An admin can allow one more.',
                              paid_calls, paid_call_limit)
   WHERE job_state IN ('queued','waiting') AND paid_calls >= paid_call_limit;

  -- Publish gate: the queue follows the products (a backstop for the triggers).
  UPDATE public.website_media_cutouts
     SET job_state = 'waiting', updated_at = now()
   WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url);
  UPDATE public.website_media_cutouts
     SET job_state = 'queued', updated_at = now()
   WHERE job_state = 'waiting' AND hold_reason IS NULL AND public.media_cutout_url_published(source_url);

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
       AND c.status NOT IN ('ok','auto_fixed','approved','kept_original')
       AND (c.status <> 'rejected' OR c.recut_allowed)
       AND c.paid_calls < c.paid_call_limit
       AND c.hold_reason IS NULL
       AND public.media_cutout_url_published(c.source_url)
     ORDER BY c.priority, c.created_at
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

-- A sync provider answered. NEW: a photo the worker already had in hand when
-- its product was unpublished ('waiting') was really sent — it finishes
-- normally. Anything else that left the queue is counted and dropped, as before.
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
  IF NOT EXISTS (SELECT 1 FROM public.website_media_cutouts WHERE source_url = p_source_url AND job_state IN ('queued','waiting')) THEN
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

-- A step failed. Unchanged backoff and cut-once counting. NEW:
--   - a failed submit of a photo the worker had in hand when it was
--     unpublished ('waiting') is a paid call too; its retry goes back to
--     'queued' and the guard turns that into 'waiting' again
--   - a photo that already has a staff decision (job_state 'done': approved,
--     rejected or kept original while the worker held it) keeps it: the
--     failed call is counted, nothing else changes
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

  IF r.job_state = 'done' THEN
    IF p_stage = 'submit' THEN
      UPDATE public.website_media_cutouts SET paid_calls = paid_calls + 1, updated_at = now() WHERE source_url = p_source_url;
    END IF;
    RETURN 'kept_decision';
  END IF;

  v_paid := r.paid_calls + CASE WHEN p_stage = 'submit' AND r.job_state IN ('queued','waiting') THEN 1 ELSE 0 END;

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

-- Orphans: unchanged, except a photo Waiting for publish that no product uses
-- any more is forgotten too.
CREATE OR REPLACE FUNCTION public.media_cutout_housekeeping(p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rows jsonb;
BEGIN
  UPDATE public.website_media_cutouts c SET orphaned_at = NULL, updated_at = now()
   WHERE c.orphaned_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.website_product_media m WHERE m.url = c.source_url);
  UPDATE public.website_media_cutouts c SET orphaned_at = now(), updated_at = now()
   WHERE c.orphaned_at IS NULL
     AND c.job_state IN ('done','error','queued','waiting')
     AND NOT EXISTS (SELECT 1 FROM public.website_product_media m WHERE m.url = c.source_url);
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'source_url', c.source_url,
           'paths', to_jsonb(array_remove(ARRAY[c.master_path, c.cutout_path, c.catalog_path, c.catalog_small_path,
                                                c.last_rerun ->> 'cutout_path', c.last_rerun ->> 'catalog_path',
                                                c.last_rerun ->> 'catalog_small_path', c.last_rerun ->> 'master_path'], NULL)))),
           '[]'::jsonb)
    INTO v_rows
    FROM (SELECT * FROM public.website_media_cutouts
           WHERE orphaned_at < now() - interval '30 days'
           ORDER BY orphaned_at LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) c;
  RETURN v_rows;
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Staff.
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
     WHERE CASE v_filter
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

-- Every tab: photos and the paid calls they have cost. 'queue' is only what
-- can be sent (published, or already at the provider); 'waiting' is its own tab.
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
  WITH c AS (
    SELECT status, job_state, hold_reason, test_batch, paid_calls,
           (job_state = 'queued' AND public.media_cutout_url_published(source_url)) AS queued_published
      FROM public.website_media_cutouts WHERE orphaned_at IS NULL
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
      'queue',        jsonb_build_object('count', count(*) FILTER (WHERE hold_reason IS NULL AND (job_state IN ('submitted','ready','processing') OR queued_published)),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE hold_reason IS NULL AND (job_state IN ('submitted','ready','processing') OR queued_published)), 0)),
      'waiting',      jsonb_build_object('count', count(*) FILTER (WHERE job_state = 'waiting'),
                                         'paid_calls', coalesce(sum(paid_calls) FILTER (WHERE job_state = 'waiting'), 0)),
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
    'provider', CASE WHEN v_prov IN ('fal','replicate') THEN v_prov ELSE 'photoroom' END,
    'price_usd', CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END);
END
$fn$;

-- Staff decisions. One RPC, audited per action.
--   approve / reject   final decisions; a pending re-run or wait is cancelled
--   keep_original      NEW. Any photo not yet Completed and not being
--                      processed: stays uncut, the website shows the normal
--                      photo; Completed, locked, free
--   rerun              queued again (waits instead while its product is not
--   rerun_high_detail  published) — refused on a locked photo, at the
--                      paid-call limit, or held
--   use_rerun          the parked re-run result becomes the version, approved
--   own_cutout         staff's own transparent file (free: no provider call)
--   unlock_recut       REMOVED: Completed is final (completed_is_final)
--   retry_once         ADMIN. Rejected → ONE paid re-cut
--   override_cap       ADMIN. Needs owner / at the limit → ONE more paid call
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
  v_state  text;
  v_locked boolean;
  v_price  text := (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'media_cutout_price_usd');
  v_cost   numeric;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_action NOT IN ('approve','reject','rerun','rerun_high_detail','use_rerun','own_cutout','keep_original',
                      'unlock_recut','retry_once','override_cap') THEN
    RETURN jsonb_build_object('error', 'invalid_action');
  END IF;
  IF p_action = 'unlock_recut' THEN
    RETURN jsonb_build_object('error', 'completed_is_final');
  END IF;
  SELECT * INTO r FROM public.website_media_cutouts WHERE source_url = p_source_url FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF p_expected_status IS NOT NULL AND p_expected_status IS DISTINCT FROM r.status THEN
    RETURN jsonb_build_object('error', 'stale', 'status', r.status);
  END IF;
  IF r.job_state IN ('submitted','ready','processing') THEN
    RETURN jsonb_build_object('error', 'busy', 'job_state', r.job_state);
  END IF;
  v_locked := r.status IN ('ok','auto_fixed','approved','kept_original','rejected');
  v_cost := CASE WHEN v_price ~ '^[0-9]{1,2}(\.[0-9]{1,4})?$' THEN v_price::numeric END;

  IF p_action IN ('retry_once','override_cap') AND NOT public.has_role(v_uid, 'admin') THEN
    RETURN jsonb_build_object('error', 'admin_only');
  END IF;

  IF p_action = 'approve' THEN
    IF r.cutout_path IS NULL THEN RETURN jsonb_build_object('error', 'no_cutout'); END IF;
    UPDATE public.website_media_cutouts
       SET status = 'approved', reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now,
           job_state = CASE WHEN job_state IN ('queued','waiting') THEN 'done' ELSE job_state END,
           rerun = false, high_detail = false, recut_allowed = false, hold_reason = NULL, held_at = NULL
     WHERE source_url = p_source_url;
    v_new := 'approved';
  ELSIF p_action = 'reject' THEN
    UPDATE public.website_media_cutouts
       SET status = 'rejected', job_state = CASE WHEN job_state IN ('queued','waiting') THEN 'done' ELSE job_state END,
           rerun = false, high_detail = false, recut_allowed = false, hold_reason = NULL, held_at = NULL,
           reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := 'rejected';
  ELSIF p_action = 'keep_original' THEN
    IF r.status IN ('ok','auto_fixed','approved','kept_original') THEN
      RETURN jsonb_build_object('error', 'already_completed', 'status', r.status);
    END IF;
    UPDATE public.website_media_cutouts
       SET status = 'kept_original', job_state = 'done', hero_usable = false,
           rerun = false, high_detail = false, recut_allowed = false, hold_reason = NULL, held_at = NULL,
           reviewed_by = v_uid, reviewed_at = v_now, review_note = v_note, finished_at = v_now, updated_at = v_now
     WHERE source_url = p_source_url;
    v_new := 'kept_original';
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
  ELSIF p_action IN ('retry_once','override_cap') THEN
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

  SELECT job_state INTO v_state FROM public.website_media_cutouts WHERE source_url = p_source_url;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('website_media_cutout', r.id, 'review_media_cutout:' || p_action,
          jsonb_build_object('source_url', r.source_url, 'status', r.status, 'job_state', r.job_state,
                             'cutout_path', r.cutout_path, 'flags', to_jsonb(r.flags),
                             'paid_calls', r.paid_calls, 'paid_call_limit', r.paid_call_limit, 'hold_reason', r.hold_reason),
          jsonb_build_object('source_url', r.source_url, 'status', v_new, 'job_state', v_state, 'action', p_action,
                             'note', v_note, 'own_cutout_url', p_own_cutout_url)
            || CASE WHEN p_action IN ('retry_once','override_cap')
                    THEN jsonb_build_object('paid_call_limit', r.paid_calls + 1,
                                            'paid_calls_allowed', 1, 'estimated_cost_usd', v_cost)
                    WHEN p_action = 'keep_original'
                    THEN jsonb_build_object('paid_calls_allowed', 0, 'estimated_cost_usd', 0)
                    ELSE '{}'::jsonb END,
          v_uid, v_now);
  RETURN jsonb_build_object('ok', true, 'status', v_new, 'action', p_action, 'job_state', v_state,
                            'waiting_for_publish', v_state = 'waiting');
END
$fn$;

-- ---------------------------------------------------------------------------
-- 7. One-time cleanup (first run only), with before / after counts.
-- ---------------------------------------------------------------------------
DO $cleanup$
DECLARE
  v_before  jsonb;
  v_after   jsonb;
  v_waited  integer;
  v_cancel  integer;
  v_setting uuid := (SELECT id FROM public.system_settings WHERE key = 'media_cutout_mode');
BEGIN
  IF current_setting('pubgate.fresh', true) <> 'yes' THEN RETURN; END IF;

  SELECT jsonb_build_object(
      'queued',                     count(*) FILTER (WHERE job_state = 'queued'),
      'queued_published',           count(*) FILTER (WHERE job_state = 'queued' AND pub),
      'queued_unpublished',         count(*) FILTER (WHERE job_state = 'queued' AND NOT pub),
      'queued_completed_recuts',    count(*) FILTER (WHERE job_state = 'queued' AND status IN ('ok','auto_fixed','approved')),
      'recut_permissions',          count(*) FILTER (WHERE recut_allowed),
      'failed',                     count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL),
      'failed_published',           count(*) FILTER (WHERE status = 'failed' AND hold_reason IS NULL AND pub),
      'failed_402',                 count(*) FILTER (WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%')),
      'failed_402_published',       count(*) FILTER (WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%') AND pub),
      'failed_402_published_sendable', count(*) FILTER (WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%')
                                                         AND pub AND hold_reason IS NULL AND paid_calls < paid_call_limit
                                                         AND own_cutout_url IS NULL),
      'in_flight',                  count(*) FILTER (WHERE job_state IN ('submitted','ready','processing')),
      'held',                       count(*) FILTER (WHERE hold_reason IS NOT NULL),
      'rows',                       count(*))
    INTO v_before
    FROM (SELECT c.*, public.media_cutout_url_published(c.source_url) AS pub FROM public.website_media_cutouts c) c;

  -- Completed is final: queued re-cuts of Completed photos are cancelled; a
  -- permission on any Completed photo not at the provider is withdrawn.
  UPDATE public.website_media_cutouts
     SET job_state = CASE WHEN job_state IN ('queued','waiting') THEN 'done' ELSE job_state END,
         rerun = false, high_detail = false, recut_allowed = false, updated_at = now()
   WHERE status IN ('ok','auto_fixed','approved')
     AND job_state NOT IN ('submitted','ready','processing')
     AND (job_state IN ('queued','waiting') OR recut_allowed);
  GET DIAGNOSTICS v_cancel = ROW_COUNT;

  -- The publish gate: queued photos of unpublished products wait.
  UPDATE public.website_media_cutouts
     SET job_state = 'waiting', updated_at = now()
   WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url);
  GET DIAGNOSTICS v_waited = ROW_COUNT;

  SELECT jsonb_build_object(
      'queued',                 count(*) FILTER (WHERE job_state = 'queued'),
      'queued_unpublished',     count(*) FILTER (WHERE job_state = 'queued' AND NOT pub),
      'waiting',                count(*) FILTER (WHERE job_state = 'waiting'),
      'recut_permissions',      count(*) FILTER (WHERE recut_allowed),
      'in_flight',              count(*) FILTER (WHERE job_state IN ('submitted','ready','processing')),
      'held',                   count(*) FILTER (WHERE hold_reason IS NOT NULL),
      'rows',                   count(*),
      'moved_to_waiting',       v_waited,
      'completed_recuts_cancelled', v_cancel)
    INTO v_after
    FROM (SELECT c.*, public.media_cutout_url_published(c.source_url) AS pub FROM public.website_media_cutouts c) c;

  RAISE NOTICE 'media_cutouts_publish_gate BEFORE: %', v_before;
  RAISE NOTICE 'media_cutouts_publish_gate AFTER:  %', v_after;
  IF v_setting IS NOT NULL THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('system_setting', v_setting, 'media_cutouts_publish_gate', v_before, v_after, NULL, now());
  END IF;
END
$cleanup$;

-- ---------------------------------------------------------------------------
-- 8. Grants.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.media_cutout_url_published(text)',
    'public.media_cutout_queue_published(text[],boolean)', 'public.media_cutout_dequeue_unpublished(text[])',
    'public.media_cutout_submit_batch(integer)',
    'public.media_cutout_sync_result(text,text,text,text,text,numeric)',
    'public.media_cutout_error(text,text,text,boolean)', 'public.media_cutout_housekeeping(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.guard_media_cutout_cut_once()', 'public.media_cutout_follow_product_publish()',
    'public.media_cutout_follow_media_publish()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
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
-- 9. Self-check, inside the transaction.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_website_product_cutout_publish_gate'
                    AND t.tgrelid = 'public.website_products'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_website_media_cutout_publish_gate'
                       AND t.tgrelid = 'public.website_product_media'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_guard_media_cutout_cut_once'
                       AND t.tgrelid = 'public.website_media_cutouts'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_website_media_enqueue_cutout'
                       AND t.tgrelid = 'public.website_product_media'::regclass) THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate self-check: a trigger is missing';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.media_cutout_url_published(text)', 'public.media_cutout_queue_published(text[],boolean)',
    'public.media_cutout_dequeue_unpublished(text[])', 'public.media_cutout_follow_product_publish()',
    'public.media_cutout_follow_media_publish()', 'public.media_cutout_submit_batch(integer)',
    'public.media_cutout_sync_result(text,text,text,text,text,numeric)', 'public.media_cutout_error(text,text,text,boolean)',
    'public.media_cutout_housekeeping(integer)', 'public.guard_media_cutout_cut_once()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'media_cutouts_publish_gate self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.media_cutout_submit_batch(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_sync_result(text,text,text,text,text,numeric)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_error(text,text,text,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.media_cutout_housekeeping(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate self-check: service_role cannot run the worker functions';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.list_media_cutouts(text,text,integer,integer)', 'public.review_media_cutout(text,text,text,text,text)',
    'public.get_media_cutout_tab_totals()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'media_cutouts_publish_gate self-check: Hub RPC grants are wrong on %', v_fn;
    END IF;
  END LOOP;
  -- Nothing unpublished and nothing Completed is waiting to be sent.
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url)) THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate self-check: a photo of an unpublished product is still queued';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state IN ('queued','waiting') AND status IN ('ok','auto_fixed','approved','kept_original')) THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate self-check: a Completed photo is still queued';
  END IF;
  IF public.media_cutout_mode() = 'off'
     AND jsonb_array_length(public.media_cutout_submit_batch(5) -> 'rows') <> 0 THEN
    RAISE EXCEPTION 'media_cutouts_publish_gate self-check: the submit batch returned rows while off';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT. Exact expectations on the
-- live-shaped snapshot are in docs/sql/20261011_media_cutouts_publish_gate_verify.sql.
--
-- (0) BEFORE / AFTER, as this file counted them inside its transaction (one row).
--     Expect after.queued_unpublished = 0 and after.recut_permissions = 0;
--     after.waiting = after.moved_to_waiting (nothing was waiting before);
--     after.queued = before.queued − moved_to_waiting − completed_recuts_cancelled.
-- SELECT old_value_json AS before, new_value_json AS after, created_at
--   FROM public.audit_logs WHERE action = 'media_cutouts_publish_gate' ORDER BY created_at DESC LIMIT 1;
--
-- (1) The gate is in place. Expect:  8 | t | t | t
-- SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--          WHERE n.nspname = 'public' AND p.proname IN ('media_cutout_url_published','media_cutout_queue_published',
--                'media_cutout_dequeue_unpublished','media_cutout_follow_product_publish','media_cutout_follow_media_publish',
--                'guard_media_cutout_cut_once','media_cutout_submit_batch','review_media_cutout')) AS functions,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_website_product_cutout_publish_gate') AS product_trigger,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_website_media_cutout_publish_gate') AS media_trigger,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_media_cutout_cut_once') AS guard;
--
-- (2) Nothing unpublished or Completed can be sent. Expect:  0 | 0 | 0
-- SELECT count(*) FILTER (WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url)) AS queued_unpublished,
--        count(*) FILTER (WHERE job_state IN ('queued','waiting') AND status IN ('ok','auto_fixed','approved','kept_original')) AS completed_queued,
--        count(*) FILTER (WHERE recut_allowed AND status IN ('ok','auto_fixed','approved','kept_original')
--                         AND job_state NOT IN ('submitted','ready','processing')) AS completed_recut_permissions
--   FROM public.website_media_cutouts;
--
-- (3) The queue now (publish-eligible only) and Waiting for publish.
--     Expect queue = (0).after.queued (+ anything in flight), waiting = (0).after.waiting.
-- SELECT count(*) FILTER (WHERE job_state = 'queued')                                  AS queue,
--        count(*) FILTER (WHERE job_state IN ('submitted','ready','processing'))       AS in_flight,
--        count(*) FILTER (WHERE job_state = 'waiting')                                 AS waiting
--   FROM public.website_media_cutouts;
--
-- (4) The Photoroom-402 failures: how many belong to PUBLISHED products (these, and
--     only these, can be sent again — by Re-run, or by being re-published). Expect
--     failed_402 = 495 (owner, 2026-09-28) and the other two equal (0).before
--     failed_402_published / failed_402_published_sendable.
-- SELECT count(*) AS failed_402,
--        count(*) FILTER (WHERE public.media_cutout_url_published(source_url)) AS failed_402_published,
--        count(*) FILTER (WHERE public.media_cutout_url_published(source_url) AND hold_reason IS NULL
--                         AND paid_calls < paid_call_limit AND own_cutout_url IS NULL) AS failed_402_published_sendable
--   FROM public.website_media_cutouts
--  WHERE status = 'failed' AND (last_error ILIKE '%402%' OR flags::text ILIKE '%402%');
--
-- (5) Completed is final for every writer, the SQL Editor and the admin override
--     included. Run the three lines together. Expect an ERROR "…Completed is final
--     (locked)…"; nothing changes (the transaction is rolled back).
-- BEGIN; SET LOCAL app.media_cutout_owner_override = 'on';
-- UPDATE public.website_media_cutouts SET job_state = 'queued', recut_allowed = true
--  WHERE source_url = (SELECT source_url FROM public.website_media_cutouts WHERE status = 'approved' LIMIT 1); ROLLBACK;
--
-- (6) Browser roles. Expect:  f | f | t | t
-- SELECT has_function_privilege('authenticated','public.media_cutout_queue_published(text[],boolean)','EXECUTE') AS auth_queue,
--        has_function_privilege('authenticated','public.media_cutout_submit_batch(integer)','EXECUTE')             AS auth_submit,
--        has_function_privilege('authenticated','public.review_media_cutout(text,text,text,text,text)','EXECUTE')   AS auth_review,
--        has_function_privilege('authenticated','public.get_media_cutout_tab_totals()','EXECUTE')                  AS auth_tabs;
-- ===========================================================================
