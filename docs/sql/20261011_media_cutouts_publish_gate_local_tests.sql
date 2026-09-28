-- ============================================================================
-- Media cut-outs PUBLISH GATE — LOCAL tests for
-- 20261011100000_media_cutouts_publish_gate.sql. NEVER ON LIVE.
--
-- In an EMPTY throwaway Postgres:
--   export PGOPTIONS='-c cutout.local_stub=yes'
--   $P docs/sql/20261005_media_cutouts_local_stub.sql
--   $P supabase/migrations/20261006100000_media_cutouts.sql
--   $P supabase/migrations/20261007100000_media_cutout_photoroom.sql
--   $P supabase/migrations/20261010100000_media_cutouts_cut_once.sql
--   $P supabase/migrations/20261011100000_media_cutouts_publish_gate.sql
--   $P supabase/migrations/20261011100000_media_cutouts_publish_gate.sql   # re-run
--   $P docs/sql/20261011_media_cutouts_publish_gate_local_tests.sql
-- (~/Code/reference/media-cutouts/publish-gate/run-sql-tests.sh does all of it.)
--
-- The cut_once suite describes "Unlock and re-cut", which this migration
-- removes (owner rule 2026-09-28: Completed is final), so that suite is run
-- BEFORE this migration as the baseline, and this migration is then applied on
-- top of its data.
--
-- "Published" = website_products.status = 'active'. Every block raises on
-- failure; the last line prints ALL PASSED.
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
--   PUB  published        DRAFT  unpublished      SHARE  unpublished, shares a photo with PUB
--   ARCH published, archived in G9                 LATE   unpublished, published in G3
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'PUB',   'pub',   'Published ring',   'active'),
  ('b0000000-0000-0000-0000-000000000002', 'DRAFT', 'draft', 'Draft ring',       'draft'),
  ('b0000000-0000-0000-0000-000000000003', 'SHARE', 'share', 'Draft twin',       'draft'),
  ('b0000000-0000-0000-0000-000000000004', 'ARCH',  'arch',  'Soon archived',    'active'),
  ('b0000000-0000-0000-0000-000000000005', 'LATE',  'late',  'Published later',  'draft');
INSERT INTO public.website_product_variants (id, product_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003'),
  ('d0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004'),
  ('d0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000005');

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;
CREATE FUNCTION pg_temp.row_of(p text) RETURNS public.website_media_cutouts LANGUAGE sql AS
  $$ SELECT * FROM public.website_media_cutouts WHERE source_url = pg_temp.u(p) $$;
CREATE FUNCTION pg_temp.st(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT job_state || '/' || status FROM public.website_media_cutouts WHERE source_url = pg_temp.u(p) $$;
CREATE FUNCTION pg_temp.add(variant text, p text, s integer) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO public.website_product_media (variant_id, url, sort) VALUES (variant::uuid, pg_temp.u(p), s) $$;
-- The batch the worker would get now (every queued row due).
CREATE FUNCTION pg_temp.batch() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE b jsonb;
BEGIN
  UPDATE public.website_media_cutouts SET next_attempt_at = now() - interval '1 second' WHERE job_state IN ('queued','waiting');
  b := public.media_cutout_submit_batch(20);
  RETURN coalesce(ARRAY(SELECT x ->> 'source_url' FROM jsonb_array_elements(b -> 'rows') x), '{}');
END $$;
CREATE FUNCTION pg_temp.handed(p text) RETURNS boolean LANGUAGE sql AS $$ SELECT pg_temp.u(p) = ANY (pg_temp.batch()) $$;
-- Walk one photo through a successful SYNC provider round (Photoroom) to a verdict.
CREATE FUNCTION pg_temp.cut(p text, verdict text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.media_cutout_sync_result(pg_temp.u(p), 'photoroom', 'photoroom/v1/segment', 'req-' || p,
    'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/' || md5(p) || '/photoroom.png', 0.1);
  PERFORM public.media_cutout_claim_process(pg_temp.u(p));
  RETURN public.media_cutout_finish(pg_temp.u(p), jsonb_build_object('status', verdict,
    'cutout_path', 'website/derived/' || p || '/cutout.webp', 'catalog_path', 'website/derived/' || p || '/catalog.webp'));
END $$;
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
CREATE FUNCTION pg_temp.expect(label text, got text, want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '%: expected %, got %', label, want, got; END IF;
END $$;

-- Switch ON, Photoroom at $0.02, cap 1000.
DO $t$ BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.set_media_cutout_settings('on', 1000, NULL);
  PERFORM public.set_media_cutout_provider('photoroom', 0.02, NULL);
END $t$;

-- ------------------------------------------------ G1. adding photos to an UNPUBLISHED product queues nothing
DO $t$ BEGIN
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000002', 'g/draft-main.jpg', 0);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000002', 'g/draft-2.jpg', 1);
  PERFORM pg_temp.expect('G1 main', pg_temp.st('g/draft-main.jpg'), 'waiting/pending');
  PERFORM pg_temp.expect('G1 second', pg_temp.st('g/draft-2.jpg'), 'waiting/pending');
  IF pg_temp.handed('g/draft-main.jpg') OR pg_temp.handed('g/draft-2.jpg') THEN RAISE EXCEPTION 'G1: an unpublished photo was handed out'; END IF;
  PERFORM pg_temp.expect('G1 still waiting after the batch', pg_temp.st('g/draft-main.jpg'), 'waiting/pending');
  -- changing the photo (a new URL) queues nothing either
  UPDATE public.website_product_media SET url = pg_temp.u('g/draft-2-v2.jpg') WHERE url = pg_temp.u('g/draft-2.jpg');
  PERFORM pg_temp.expect('G1 changed photo', pg_temp.st('g/draft-2-v2.jpg'), 'waiting/pending');
  -- no paid call, no usage
  IF (SELECT coalesce(sum(paid_calls), 0) FROM public.website_media_cutouts) <> 0
     OR EXISTS (SELECT 1 FROM public.website_media_cutout_usage) THEN RAISE EXCEPTION 'G1: something was spent'; END IF;
END $t$;

-- ------------------------------------------------ G2. a PUBLISHED product's photo is queued and sent
DO $t$ BEGIN
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-main.jpg', 0);
  PERFORM pg_temp.expect('G2 queued', pg_temp.st('g/pub-main.jpg'), 'queued/pending');
  IF NOT pg_temp.handed('g/pub-main.jpg') THEN RAISE EXCEPTION 'G2: a published photo must be sent'; END IF;
  PERFORM pg_temp.expect('G2 cut', pg_temp.cut('g/pub-main.jpg', 'ok'), 'recorded');
  PERFORM pg_temp.expect('G2 done', pg_temp.st('g/pub-main.jpg'), 'done/ok');
END $t$;

-- ------------------------------------------------ G3. publishing queues the product's uncut photos ONCE
DO $t$
DECLARE b text[];
BEGIN
  -- LATE (draft): a waiting photo, a failed one (402, never billed), a needs_review, a rejected,
  -- a kept original, a held one, a failed own upload, and one never recorded (older than the feature).
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-wait.jpg', 0);
  ALTER TABLE public.website_product_media DISABLE TRIGGER trg_website_media_enqueue_cutout;
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-unrecorded.jpg', 7);
  ALTER TABLE public.website_product_media ENABLE TRIGGER trg_website_media_enqueue_cutout;
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-failed.jpg', 1);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-review.jpg', 2);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-rejected.jpg', 3);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-kept.jpg', 4);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-held.jpg', 5);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-ownfail.jpg', 6);
  IF pg_temp.row_of('g/late-unrecorded.jpg') IS NOT NULL AND (pg_temp.row_of('g/late-unrecorded.jpg')).source_url IS NOT NULL THEN
    RAISE EXCEPTION 'G3: fixture — the unrecorded photo must have no row';
  END IF;
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed', attempts = 4,
         flags = ARRAY['api_error:photoroom HTTP 402'], last_error = 'photoroom: HTTP 402'
   WHERE source_url = pg_temp.u('g/late-failed.jpg');
  UPDATE public.website_media_cutouts SET job_state = 'done', status = 'needs_review', cutout_path = 'x/c.webp', paid_calls = 1
   WHERE source_url = pg_temp.u('g/late-review.jpg');
  UPDATE public.website_media_cutouts SET job_state = 'done', status = 'rejected', paid_calls = 1
   WHERE source_url = pg_temp.u('g/late-rejected.jpg');
  UPDATE public.website_media_cutouts SET job_state = 'done', status = 'kept_original'
   WHERE source_url = pg_temp.u('g/late-kept.jpg');
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed', paid_calls = 2,
         hold_reason = 'Stopped after 2 paid calls', held_at = now()
   WHERE source_url = pg_temp.u('g/late-held.jpg');
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed',
         own_cutout_url = 'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/own/a.png'
   WHERE source_url = pg_temp.u('g/late-ownfail.jpg');

  UPDATE public.website_products SET status = 'active' WHERE sku = 'LATE';

  PERFORM pg_temp.expect('G3 waiting → queued', pg_temp.st('g/late-wait.jpg'), 'queued/pending');
  PERFORM pg_temp.expect('G3 unrecorded → queued', pg_temp.st('g/late-unrecorded.jpg'), 'queued/pending');
  PERFORM pg_temp.expect('G3 failed (402) → queued once', pg_temp.st('g/late-failed.jpg'), 'queued/pending');
  IF (pg_temp.row_of('g/late-failed.jpg')).attempts <> 0 THEN RAISE EXCEPTION 'G3: attempts reset'; END IF;
  PERFORM pg_temp.expect('G3 needs_review untouched', pg_temp.st('g/late-review.jpg'), 'done/needs_review');
  PERFORM pg_temp.expect('G3 rejected untouched', pg_temp.st('g/late-rejected.jpg'), 'done/rejected');
  PERFORM pg_temp.expect('G3 kept original untouched', pg_temp.st('g/late-kept.jpg'), 'done/kept_original');
  PERFORM pg_temp.expect('G3 held untouched', pg_temp.st('g/late-held.jpg'), 'error/failed');
  PERFORM pg_temp.expect('G3 failed own upload untouched', pg_temp.st('g/late-ownfail.jpg'), 'error/failed');

  b := pg_temp.batch();
  IF NOT (pg_temp.u('g/late-wait.jpg') = ANY (b) AND pg_temp.u('g/late-failed.jpg') = ANY (b)
          AND pg_temp.u('g/late-unrecorded.jpg') = ANY (b)) THEN RAISE EXCEPTION 'G3: the published photos must be sent, got %', b; END IF;
  IF pg_temp.u('g/late-review.jpg') = ANY (b) OR pg_temp.u('g/late-rejected.jpg') = ANY (b) OR pg_temp.u('g/late-kept.jpg') = ANY (b)
     OR pg_temp.u('g/late-held.jpg') = ANY (b) OR pg_temp.u('g/late-ownfail.jpg') = ANY (b) THEN
    RAISE EXCEPTION 'G3: a decided / held photo was handed out';
  END IF;

  -- ONCE: the three are cut; saving the product again, or the Catalog's
  -- delete-and-reinsert of its media, queues nothing more.
  PERFORM pg_temp.expect('G3 cut wait', pg_temp.cut('g/late-wait.jpg', 'ok'), 'recorded');
  PERFORM pg_temp.expect('G3 cut unrecorded', pg_temp.cut('g/late-unrecorded.jpg', 'needs_review'), 'recorded');
  PERFORM public.media_cutout_error(pg_temp.u('g/late-failed.jpg'), 'submit', 'photoroom: HTTP 402', false);
  UPDATE public.website_products SET name = 'Published later (renamed)', status = 'active' WHERE sku = 'LATE';
  DELETE FROM public.website_product_media WHERE variant_id = 'd0000000-0000-0000-0000-000000000005';
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-wait.jpg', 0);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-failed.jpg', 1);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-unrecorded.jpg', 7);
  PERFORM pg_temp.expect('G3 completed stays', pg_temp.st('g/late-wait.jpg'), 'done/ok');
  PERFORM pg_temp.expect('G3 failed stays failed on a re-save', pg_temp.st('g/late-failed.jpg'), 'error/failed');
  IF (pg_temp.row_of('g/late-failed.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'G3: the failed submit is one paid call'; END IF;
  IF cardinality(pg_temp.batch()) <> 0 THEN RAISE EXCEPTION 'G3: a re-save queued something'; END IF;
  -- unpublish and publish again: the failed one (1 of 2 paid calls) is queued once more, nothing else
  UPDATE public.website_products SET status = 'draft' WHERE sku = 'LATE';
  UPDATE public.website_products SET status = 'active' WHERE sku = 'LATE';
  PERFORM pg_temp.expect('G3 re-publish: failed queued', pg_temp.st('g/late-failed.jpg'), 'queued/pending');
  PERFORM pg_temp.expect('G3 re-publish: completed stays', pg_temp.st('g/late-wait.jpg'), 'done/ok');
  PERFORM pg_temp.expect('G3 re-publish: needs_review stays', pg_temp.st('g/late-unrecorded.jpg'), 'done/needs_review');
  PERFORM public.media_cutout_error(pg_temp.u('g/late-failed.jpg'), 'submit', 'photoroom: HTTP 402', false);
  -- at the limit it is held (Needs owner), and publishing never queues it again
  PERFORM pg_temp.expect('G3 held at the limit', pg_temp.st('g/late-failed.jpg'), 'error/failed');
  IF (pg_temp.row_of('g/late-failed.jpg')).hold_reason IS NULL THEN RAISE EXCEPTION 'G3: held at 2 paid calls'; END IF;
  UPDATE public.website_products SET status = 'draft' WHERE sku = 'LATE';
  UPDATE public.website_products SET status = 'active' WHERE sku = 'LATE';
  PERFORM pg_temp.expect('G3 a held photo is never re-queued', pg_temp.st('g/late-failed.jpg'), 'error/failed');
END $t$;

-- ------------------------------------------------ G4. unpublishing: queued-not-sent leaves; sent finishes normally
DO $t$
DECLARE v jsonb; b text[]; u_before integer;
BEGIN
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-q.jpg', 1);        -- queued, not sent
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-hand.jpg', 2);     -- handed to the worker (sync)
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-sub.jpg', 3);      -- at a queue provider
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-ready.jpg', 4);    -- result in hand
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-handfail.jpg', 5); -- handed, then the call fails
  b := pg_temp.batch();
  IF NOT (pg_temp.u('g/pub-hand.jpg') = ANY (b)) THEN RAISE EXCEPTION 'G4: fixture batch %', b; END IF;
  -- the batch pushed every handed row 10 minutes out; pretend only three of them were really taken
  UPDATE public.website_media_cutouts SET next_attempt_at = now() WHERE source_url = pg_temp.u('g/pub-q.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('g/pub-sub.jpg'), 'fal', 'fal-ai/birefnet/v2', 'fal-1', 's', 'r');
  PERFORM public.media_cutout_sync_result(pg_temp.u('g/pub-ready.jpg'), 'photoroom', 'm', 'r-1',
    'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/ready/p.png', 0.1);
  SELECT coalesce(sum(provider_calls), 0) INTO u_before FROM public.website_media_cutout_usage;

  UPDATE public.website_products SET status = 'draft' WHERE sku = 'PUB';

  PERFORM pg_temp.expect('G4 queued → waiting', pg_temp.st('g/pub-q.jpg'), 'waiting/pending');
  PERFORM pg_temp.expect('G4 handed (still queued) → waiting', pg_temp.st('g/pub-hand.jpg'), 'waiting/pending');
  PERFORM pg_temp.expect('G4 at the provider untouched', pg_temp.st('g/pub-sub.jpg'), 'submitted/pending');
  PERFORM pg_temp.expect('G4 result in hand untouched', pg_temp.st('g/pub-ready.jpg'), 'ready/pending');
  PERFORM pg_temp.expect('G4 completed untouched', pg_temp.st('g/pub-main.jpg'), 'done/ok');
  IF (pg_temp.row_of('g/pub-q.jpg')).paid_calls <> 0 OR (pg_temp.row_of('g/pub-q.jpg')).status <> 'pending'
     OR (pg_temp.row_of('g/pub-q.jpg')).hold_reason IS NOT NULL THEN RAISE EXCEPTION 'G4: leaving the queue cost or failed something'; END IF;
  IF (SELECT coalesce(sum(provider_calls), 0) FROM public.website_media_cutout_usage) <> u_before THEN RAISE EXCEPTION 'G4: usage moved'; END IF;
  IF cardinality(pg_temp.batch()) <> 0 THEN RAISE EXCEPTION 'G4: something of an unpublished product was handed out'; END IF;

  -- the photo the worker already held comes back: it finishes NORMALLY
  v := public.media_cutout_sync_result(pg_temp.u('g/pub-hand.jpg'), 'photoroom', 'm', 'r-2',
    'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/hand/p.png', 0.1);
  IF v ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'G4: a sent photo must finish, got %', v; END IF;
  PERFORM public.media_cutout_claim_process(pg_temp.u('g/pub-hand.jpg'));
  PERFORM pg_temp.expect('G4 sent photo finishes', public.media_cutout_finish(pg_temp.u('g/pub-hand.jpg'),
    '{"status":"ok","cutout_path":"h/c.webp","catalog_path":"h/k.webp"}'::jsonb), 'recorded');
  PERFORM pg_temp.expect('G4 sent photo done', pg_temp.st('g/pub-hand.jpg'), 'done/ok');
  IF (pg_temp.row_of('g/pub-hand.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'G4: one paid call'; END IF;
  -- the queue provider's job and the ready one finish too
  PERFORM public.media_cutout_result_ready(pg_temp.u('g/pub-sub.jpg'), 'https://fal.media/x.png');
  PERFORM public.media_cutout_claim_process(pg_temp.u('g/pub-sub.jpg'));
  PERFORM pg_temp.expect('G4 queue provider finishes', public.media_cutout_finish(pg_temp.u('g/pub-sub.jpg'),
    '{"status":"auto_fixed","cutout_path":"s/c.webp"}'::jsonb), 'recorded');
  PERFORM public.media_cutout_claim_process(pg_temp.u('g/pub-ready.jpg'));
  PERFORM pg_temp.expect('G4 ready finishes', public.media_cutout_finish(pg_temp.u('g/pub-ready.jpg'),
    '{"status":"needs_review","cutout_path":"r/c.webp"}'::jsonb), 'recorded');

  -- a held photo whose call FAILS after the unpublish: counted (a real submit), retried later — but it waits
  PERFORM pg_temp.expect('G4 handfail waiting', pg_temp.st('g/pub-handfail.jpg'), 'waiting/pending');
  PERFORM pg_temp.expect('G4 handfail retry', public.media_cutout_error(pg_temp.u('g/pub-handfail.jpg'), 'submit', 'photoroom: HTTP 500', true), 'retry');
  PERFORM pg_temp.expect('G4 retry waits, never queued', pg_temp.st('g/pub-handfail.jpg'), 'waiting/pending');
  IF (pg_temp.row_of('g/pub-handfail.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'G4: a failed submit is a paid call'; END IF;
  IF cardinality(pg_temp.batch()) <> 0 THEN RAISE EXCEPTION 'G4: a retry of an unpublished photo was handed out'; END IF;

  -- publishing again queues the waiting photos (once)
  UPDATE public.website_products SET status = 'active' WHERE sku = 'PUB';
  PERFORM pg_temp.expect('G4 re-publish q', pg_temp.st('g/pub-q.jpg'), 'queued/pending');
  PERFORM pg_temp.expect('G4 re-publish handfail', pg_temp.st('g/pub-handfail.jpg'), 'queued/pending');
  b := pg_temp.batch();
  IF NOT (pg_temp.u('g/pub-q.jpg') = ANY (b) AND pg_temp.u('g/pub-handfail.jpg') = ANY (b)) THEN RAISE EXCEPTION 'G4: re-published photos must be sent'; END IF;
  IF pg_temp.u('g/pub-hand.jpg') = ANY (b) OR pg_temp.u('g/pub-main.jpg') = ANY (b) THEN RAISE EXCEPTION 'G4: a completed photo was sent again'; END IF;
  PERFORM pg_temp.cut('g/pub-q.jpg', 'ok');
  PERFORM pg_temp.cut('g/pub-handfail.jpg', 'ok');
END $t$;

-- ------------------------------------------------ G5. a photo shared with a published product stays in the queue
DO $t$ BEGIN
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000003', 'g/shared.jpg', 0);   -- SHARE is a draft
  PERFORM pg_temp.expect('G5 draft only', pg_temp.st('g/shared.jpg'), 'waiting/pending');
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/shared.jpg', 9);   -- now PUB uses it too
  PERFORM pg_temp.expect('G5 added to a published product → queued', pg_temp.st('g/shared.jpg'), 'queued/pending');
  UPDATE public.website_products SET status = 'archived' WHERE sku = 'SHARE';     -- no-op for the photo
  PERFORM pg_temp.expect('G5 still published through PUB', pg_temp.st('g/shared.jpg'), 'queued/pending');
  IF NOT public.media_cutout_url_published(pg_temp.u('g/shared.jpg')) THEN RAISE EXCEPTION 'G5: published through PUB'; END IF;
  DELETE FROM public.website_product_media WHERE url = pg_temp.u('g/shared.jpg') AND variant_id = 'd0000000-0000-0000-0000-000000000001';
  -- no trigger on delete: the worker's batch is the backstop
  IF pg_temp.handed('g/shared.jpg') THEN RAISE EXCEPTION 'G5: sent after PUB dropped it'; END IF;
  PERFORM pg_temp.expect('G5 backstop moved it to waiting', pg_temp.st('g/shared.jpg'), 'waiting/pending');
END $t$;

-- ------------------------------------------------ G6. test mode: a test batch of an unpublished product waits
DO $t$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.set_media_cutout_settings('test', NULL, 'on');
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000002', 'g/draft-3.jpg', 2);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-t.jpg', 6);
  v := public.add_media_cutout_test_batch(ARRAY['DRAFT','PUB'], 'Gate test', false);
  IF v ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'G6: batch %', v; END IF;
  PERFORM pg_temp.expect('G6 tagged, still waiting', pg_temp.st('g/draft-3.jpg'), 'waiting/pending');
  IF (pg_temp.row_of('g/draft-3.jpg')).test_batch <> 'Gate test' THEN RAISE EXCEPTION 'G6: tagged'; END IF;
  IF pg_temp.handed('g/draft-3.jpg') OR pg_temp.handed('g/draft-main.jpg') THEN RAISE EXCEPTION 'G6: test mode sent an unpublished photo'; END IF;
  IF NOT pg_temp.handed('g/pub-t.jpg') THEN RAISE EXCEPTION 'G6: test mode sends a published photo in the batch'; END IF;
  PERFORM pg_temp.cut('g/pub-t.jpg', 'ok');
  PERFORM public.set_media_cutout_settings('on', NULL, 'test');
END $t$;

-- ------------------------------------------------ G7. Re-run of an unpublished photo waits; the 402 failures
DO $t$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000002', 'g/draft-402.jpg', 3);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'g/pub-402.jpg', 7);
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed', attempts = 4,
         flags = ARRAY['api_error:photoroom HTTP 402'], last_error = 'photoroom: HTTP 402'
   WHERE source_url IN (pg_temp.u('g/draft-402.jpg'), pg_temp.u('g/pub-402.jpg'));
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.review_media_cutout(pg_temp.u('g/draft-402.jpg'), 'rerun', NULL, NULL, 'failed');
  IF v ->> 'ok' <> 'true' OR v ->> 'job_state' <> 'waiting' OR (v ->> 'waiting_for_publish')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'G7: a re-run of an unpublished photo waits, got %', v;
  END IF;
  PERFORM pg_temp.expect('G7 unpublished re-run', pg_temp.st('g/draft-402.jpg'), 'waiting/pending');
  v := public.review_media_cutout(pg_temp.u('g/pub-402.jpg'), 'rerun', NULL, NULL, 'failed');
  IF v ->> 'job_state' <> 'queued' OR (v ->> 'waiting_for_publish')::boolean THEN RAISE EXCEPTION 'G7: published re-run queues, got %', v; END IF;
  IF pg_temp.handed('g/draft-402.jpg') THEN RAISE EXCEPTION 'G7: sent while unpublished'; END IF;
  IF NOT pg_temp.handed('g/pub-402.jpg') THEN RAISE EXCEPTION 'G7: published re-run must be sent'; END IF;
  PERFORM pg_temp.cut('g/pub-402.jpg', 'ok');
  -- an admin override on a held photo of an unpublished product waits as well
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed', paid_calls = 2,
         hold_reason = 'Stopped after 2 paid calls', held_at = now()
   WHERE source_url = pg_temp.u('g/draft-2-v2.jpg');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  v := public.review_media_cutout(pg_temp.u('g/draft-2-v2.jpg'), 'override_cap', 'owner', NULL, 'failed');
  IF v ->> 'job_state' <> 'waiting' THEN RAISE EXCEPTION 'G7: override on an unpublished photo waits, got %', v; END IF;
  IF (pg_temp.row_of('g/draft-2-v2.jpg')).paid_call_limit <> 3 THEN RAISE EXCEPTION 'G7: one more call allowed'; END IF;
  IF pg_temp.handed('g/draft-2-v2.jpg') THEN RAISE EXCEPTION 'G7: override sent an unpublished photo'; END IF;
END $t$;

-- ------------------------------------------------ G8. COMPLETED IS FINAL — every role, every writer
DO $t$
DECLARE v jsonb; r text;
BEGIN
  -- no reopen path: admin and staff alike
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  v := public.review_media_cutout(pg_temp.u('g/pub-main.jpg'), 'unlock_recut', 'again', NULL, 'ok');
  PERFORM pg_temp.expect('G8 admin unlock', v ->> 'error', 'completed_is_final');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.review_media_cutout(pg_temp.u('g/pub-main.jpg'), 'unlock_recut', NULL, NULL, 'ok');
  PERFORM pg_temp.expect('G8 staff unlock', v ->> 'error', 'completed_is_final');
  FOREACH r IN ARRAY ARRAY['rerun','rerun_high_detail'] LOOP
    PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
    PERFORM pg_temp.expect('G8 admin ' || r, public.review_media_cutout(pg_temp.u('g/pub-main.jpg'), r, NULL, NULL, 'ok') ->> 'error', 'locked');
    PERFORM pg_temp.expect('G8 admin override_cap', public.review_media_cutout(pg_temp.u('g/pub-main.jpg'), 'override_cap', NULL, NULL, 'ok') ->> 'error', 'not_capped');
    PERFORM pg_temp.expect('G8 admin retry_once', public.review_media_cutout(pg_temp.u('g/pub-main.jpg'), 'retry_once', NULL, NULL, 'ok') ->> 'error', 'not_rejected');
  END LOOP;
  -- the database refuses the queue for every writer, the admin override included, for every Completed status
  UPDATE public.website_media_cutouts SET status = 'approved' WHERE source_url = pg_temp.u('g/pub-q.jpg');
  UPDATE public.website_media_cutouts SET status = 'auto_fixed' WHERE source_url = pg_temp.u('g/pub-handfail.jpg');
  FOREACH r IN ARRAY ARRAY['g/pub-main.jpg','g/pub-q.jpg','g/pub-handfail.jpg','g/late-kept.jpg'] LOOP
    PERFORM pg_temp.refused(format($$UPDATE public.website_media_cutouts SET job_state = 'queued' WHERE source_url = %L$$, pg_temp.u(r)),
                            'Completed is final');
    PERFORM pg_temp.refused(format($$UPDATE public.website_media_cutouts SET job_state = 'waiting' WHERE source_url = %L$$, pg_temp.u(r)),
                            'Completed is final');
    PERFORM set_config('app.media_cutout_owner_override', 'on', false);
    PERFORM pg_temp.refused(format($$UPDATE public.website_media_cutouts SET job_state = 'queued', recut_allowed = true,
                                     paid_call_limit = 9 WHERE source_url = %L$$, pg_temp.u(r)), 'Completed is final');
    PERFORM set_config('app.media_cutout_owner_override', '', false);
  END LOOP;
  -- publishing / re-saving never re-queues them
  UPDATE public.website_products SET status = 'draft' WHERE sku = 'PUB';
  UPDATE public.website_products SET status = 'active' WHERE sku = 'PUB';
  PERFORM pg_temp.expect('G8 publish keeps completed', pg_temp.st('g/pub-main.jpg'), 'done/ok');
  -- a legacy re-cut permission on a Completed photo (queued before this migration) is cancelled by the worker, never sent
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER trg_guard_media_cutout_cut_once;
  UPDATE public.website_media_cutouts SET job_state = 'queued', rerun = true, recut_allowed = true, next_attempt_at = now()
   WHERE source_url = pg_temp.u('g/pub-q.jpg');
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER trg_guard_media_cutout_cut_once;
  IF pg_temp.handed('g/pub-q.jpg') THEN RAISE EXCEPTION 'G8: a Completed photo with a legacy permission was sent'; END IF;
  PERFORM pg_temp.expect('G8 legacy permission cancelled', pg_temp.st('g/pub-q.jpg'), 'done/approved');
  IF (pg_temp.row_of('g/pub-q.jpg')).recut_allowed THEN RAISE EXCEPTION 'G8: permission withdrawn'; END IF;
  -- a retry never sends a Completed photo again (e.g. a re-cut already at the provider before this migration)
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER trg_guard_media_cutout_cut_once;
  UPDATE public.website_media_cutouts SET job_state = 'submitted', rerun = true, recut_allowed = true
   WHERE source_url = pg_temp.u('g/pub-q.jpg');
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER trg_guard_media_cutout_cut_once;
  PERFORM pg_temp.expect('G8 timeout of a completed re-cut', public.media_cutout_error(pg_temp.u('g/pub-q.jpg'), 'submit', 'provider timeout (30 min)', true), 'failed');
  PERFORM pg_temp.expect('G8 completed kept after the failed re-cut', pg_temp.st('g/pub-q.jpg'), 'error/approved');
  -- Try once more stays for REJECTED photos (admin). (G3's re-save left this photo off LATE; put it back.)
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000005', 'g/late-rejected.jpg', 3);
  PERFORM pg_temp.expect('G8 re-adding a rejected photo never queues it', pg_temp.st('g/late-rejected.jpg'), 'done/rejected');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  v := public.review_media_cutout(pg_temp.u('g/late-rejected.jpg'), 'retry_once', 'owner', NULL, 'rejected');
  IF v ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'G8: retry_once on rejected, got %', v; END IF;
  PERFORM pg_temp.expect('G8 rejected retry queued (LATE is published)', pg_temp.st('g/late-rejected.jpg'), 'queued/rejected');
END $t$;

-- ------------------------------------------------ G9. KEEP ORIGINAL
DO $t$
DECLARE v jsonb; a record; r text;
BEGIN
  -- fixtures on PUB: one of each "not yet Completed" state
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/review.jpg', 11);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/failed.jpg', 12);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/rejected.jpg', 13);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/held.jpg', 14);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/queued.jpg', 15);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000002', 'k/waiting.jpg', 16);   -- DRAFT
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/busy.jpg', 17);
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000001', 'k/nothing-kept.jpg', 18);
  PERFORM pg_temp.batch();
  PERFORM pg_temp.cut('k/review.jpg', 'needs_review');
  PERFORM pg_temp.cut('k/nothing-kept.jpg', 'needs_review');
  UPDATE public.website_media_cutouts SET flags = ARRAY['coverage:0.012'], coverage = 0.012 WHERE source_url = pg_temp.u('k/nothing-kept.jpg');
  PERFORM public.media_cutout_error(pg_temp.u('k/failed.jpg'), 'submit', 'photoroom: HTTP 500', false);
  PERFORM pg_temp.cut('k/rejected.jpg', 'needs_review');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  PERFORM public.review_media_cutout(pg_temp.u('k/rejected.jpg'), 'reject', NULL, NULL, 'needs_review');
  UPDATE public.website_media_cutouts SET job_state = 'error', status = 'failed', paid_calls = 2,
         hold_reason = 'Stopped after 2 paid calls', held_at = now() WHERE source_url = pg_temp.u('k/held.jpg');
  UPDATE public.website_media_cutouts SET next_attempt_at = now() WHERE source_url = pg_temp.u('k/queued.jpg');
  PERFORM public.media_cutout_submitted(pg_temp.u('k/busy.jpg'), 'fal', 'm', 'fal-2', 's', 'r');
  PERFORM pg_temp.expect('G9 fixtures', pg_temp.st('k/review.jpg') || ' ' || pg_temp.st('k/failed.jpg') || ' ' ||
    pg_temp.st('k/rejected.jpg') || ' ' || pg_temp.st('k/held.jpg') || ' ' || pg_temp.st('k/queued.jpg') || ' ' || pg_temp.st('k/waiting.jpg'),
    'done/needs_review error/failed done/rejected error/failed queued/pending waiting/pending');

  -- STAFF (not admin) may keep the original, on each of them; free, audited, locked
  FOREACH r IN ARRAY ARRAY['k/review.jpg','k/failed.jpg','k/rejected.jpg','k/held.jpg','k/queued.jpg','k/waiting.jpg','k/nothing-kept.jpg'] LOOP
    SELECT paid_calls, status INTO a FROM public.website_media_cutouts WHERE source_url = pg_temp.u(r);
    v := public.review_media_cutout(pg_temp.u(r), 'keep_original', 'the photo is fine as it is', NULL, a.status);
    IF v ->> 'ok' <> 'true' OR v ->> 'status' <> 'kept_original' THEN RAISE EXCEPTION 'G9: keep_original on %: %', r, v; END IF;
    PERFORM pg_temp.expect('G9 ' || r, pg_temp.st(r), 'done/kept_original');
    IF (pg_temp.row_of(r)).paid_calls <> a.paid_calls THEN RAISE EXCEPTION 'G9: keep_original cost something on %', r; END IF;
    IF (pg_temp.row_of(r)).hero_usable IS DISTINCT FROM false OR (pg_temp.row_of(r)).hold_reason IS NOT NULL THEN
      RAISE EXCEPTION 'G9: hero_usable false / hold cleared on %', r;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'review_media_cutout:keep_original'
                    AND old_value_json ->> 'source_url' = pg_temp.u(r)
                    AND (new_value_json ->> 'estimated_cost_usd')::numeric = 0
                    AND performed_by_user_id = '00000000-0000-0000-0000-00000000000b') THEN
      RAISE EXCEPTION 'G9: audit row for %', r;
    END IF;
  END LOOP;
  -- not on Completed, not while processing, not without the permission
  PERFORM pg_temp.expect('G9 on completed', public.review_media_cutout(pg_temp.u('g/pub-main.jpg'), 'keep_original', NULL, NULL, 'ok') ->> 'error', 'already_completed');
  PERFORM pg_temp.expect('G9 on kept', public.review_media_cutout(pg_temp.u('k/review.jpg'), 'keep_original', NULL, NULL, 'kept_original') ->> 'error', 'already_completed');
  PERFORM pg_temp.expect('G9 busy', public.review_media_cutout(pg_temp.u('k/busy.jpg'), 'keep_original', NULL, NULL, 'pending') ->> 'error', 'busy');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  PERFORM pg_temp.expect('G9 no permission', public.review_media_cutout(pg_temp.u('k/busy.jpg'), 'keep_original', NULL, NULL, NULL) ->> 'error', 'permission_denied');

  -- locked like approved: no re-run, no admin reopen, never queued by any writer, publish never queues it
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM pg_temp.expect('G9 rerun', public.review_media_cutout(pg_temp.u('k/failed.jpg'), 'rerun', NULL, NULL, 'kept_original') ->> 'error', 'locked');
  PERFORM pg_temp.expect('G9 unlock', public.review_media_cutout(pg_temp.u('k/failed.jpg'), 'unlock_recut', NULL, NULL, 'kept_original') ->> 'error', 'completed_is_final');
  PERFORM pg_temp.expect('G9 retry_once', public.review_media_cutout(pg_temp.u('k/rejected.jpg'), 'retry_once', NULL, NULL, 'kept_original') ->> 'error', 'not_rejected');
  PERFORM pg_temp.expect('G9 override', public.review_media_cutout(pg_temp.u('k/held.jpg'), 'override_cap', NULL, NULL, 'kept_original') ->> 'error', 'not_capped');
  PERFORM set_config('app.media_cutout_owner_override', 'on', false);
  PERFORM pg_temp.refused($$UPDATE public.website_media_cutouts SET job_state = 'queued', recut_allowed = true
                            WHERE source_url = pg_temp.u('k/held.jpg')$$, 'Completed is final');
  PERFORM set_config('app.media_cutout_owner_override', '', false);
  UPDATE public.website_products SET status = 'active' WHERE sku = 'DRAFT';
  PERFORM pg_temp.expect('G9 publish keeps kept', pg_temp.st('k/waiting.jpg'), 'done/kept_original');
  UPDATE public.website_products SET status = 'draft' WHERE sku = 'DRAFT';
  -- the call that was in the worker's hand when staff kept the original: counted, the decision stays
  PERFORM pg_temp.expect('G9 in-hand failure', public.media_cutout_error(pg_temp.u('k/queued.jpg'), 'submit', 'photoroom: HTTP 500', true), 'kept_decision');
  PERFORM pg_temp.expect('G9 decision kept', pg_temp.st('k/queued.jpg'), 'done/kept_original');
  IF (pg_temp.row_of('k/queued.jpg')).paid_calls <> 1 THEN RAISE EXCEPTION 'G9: the in-hand call is counted'; END IF;
  v := public.media_cutout_sync_result(pg_temp.u('k/queued.jpg'), 'photoroom', 'm', 'r-9',
    'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/k/p.png', 0.1);
  IF v ->> 'error' <> 'not_queued' THEN RAISE EXCEPTION 'G9: a late result is dropped, got %', v; END IF;
  PERFORM pg_temp.expect('G9 late result dropped', pg_temp.st('k/queued.jpg'), 'done/kept_original');
  -- the website may show only ok / auto_fixed / approved: kept_original is not one
  IF (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'kept_original' AND status IN ('ok','auto_fixed','approved')) <> 0 THEN
    RAISE EXCEPTION 'G9: kept original must never be publishable';
  END IF;
  -- an own cut-out is still possible later (free), like on an approved photo
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.review_media_cutout(pg_temp.u('k/review.jpg'), 'own_cutout', NULL,
    'https://x.supabase.co/storage/v1/object/public/promotions/website/derived/own/k.png', 'kept_original');
  IF v ->> 'ok' <> 'true' THEN RAISE EXCEPTION 'G9: own cut-out after keep, got %', v; END IF;
END $t$;

-- ------------------------------------------------ G10. archiving is unpublishing; never fails the product write
DO $t$ BEGIN
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000004', 'g/arch.jpg', 0);
  PERFORM pg_temp.expect('G10 queued', pg_temp.st('g/arch.jpg'), 'queued/pending');
  UPDATE public.website_products SET status = 'archived' WHERE sku = 'ARCH';
  PERFORM pg_temp.expect('G10 archived → waiting', pg_temp.st('g/arch.jpg'), 'waiting/pending');
  UPDATE public.website_products SET status = 'active' WHERE sku = 'ARCH';
  PERFORM pg_temp.expect('G10 back', pg_temp.st('g/arch.jpg'), 'queued/pending');
  -- a broken gate function: the publish still saves (WARNING), and the worker's batch still gates
  BEGIN
    ALTER FUNCTION public.media_cutout_dequeue_unpublished(text[]) RENAME TO media_cutout_dequeue_unpublished_x;
    UPDATE public.website_products SET status = 'draft' WHERE sku = 'ARCH';
    IF (SELECT status::text FROM public.website_products WHERE sku = 'ARCH') <> 'draft' THEN RAISE EXCEPTION 'G10: the unpublish must save'; END IF;
    PERFORM pg_temp.expect('G10 trigger failed softly', pg_temp.st('g/arch.jpg'), 'queued/pending');
    IF pg_temp.handed('g/arch.jpg') THEN RAISE EXCEPTION 'G10: sent while unpublished'; END IF;
    PERFORM pg_temp.expect('G10 backstop', pg_temp.st('g/arch.jpg'), 'waiting/pending');
    RAISE EXCEPTION 'rollback-g10';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'rollback-g10' THEN RAISE; END IF;
  END;
  IF to_regprocedure('public.media_cutout_dequeue_unpublished(text[])') IS NULL THEN RAISE EXCEPTION 'G10: restore'; END IF;
  -- the enqueue on an unpublished product never fails the media write either
  PERFORM pg_temp.add('d0000000-0000-0000-0000-000000000002', 'g/draft-9.jpg', 9);
  PERFORM pg_temp.expect('G10 media save ok', pg_temp.st('g/draft-9.jpg'), 'waiting/pending');
END $t$;

-- ------------------------------------------------ G11. the lists and tab counts
DO $t$
DECLARE v jsonb; t jsonb; w integer; q integer;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.get_media_cutout_tab_totals();
  t := v -> 'tabs';
  SELECT count(*) FILTER (WHERE job_state = 'waiting'),
         count(*) FILTER (WHERE hold_reason IS NULL AND (job_state IN ('submitted','ready','processing')
                          OR (job_state = 'queued' AND public.media_cutout_url_published(source_url))))
    INTO w, q FROM public.website_media_cutouts WHERE orphaned_at IS NULL;
  IF w = 0 THEN RAISE EXCEPTION 'G11: fixture — something must be waiting'; END IF;
  IF (t -> 'waiting' ->> 'count')::int <> w OR (t -> 'queue' ->> 'count')::int <> q THEN RAISE EXCEPTION 'G11: tabs %', t; END IF;
  IF (t -> 'completed' ->> 'kept_original')::int <> (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'kept_original') THEN
    RAISE EXCEPTION 'G11: completed counts kept originals';
  END IF;
  IF (t -> 'completed' ->> 'count')::int <> (SELECT count(*) FROM public.website_media_cutouts
                                             WHERE status IN ('ok','auto_fixed','approved','kept_original')) THEN RAISE EXCEPTION 'G11: completed'; END IF;
  IF (v ->> 'publish_gate')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'G11: header'; END IF;
  -- the queue list never shows a waiting photo; the waiting list shows only them; each row says if it is published
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.list_media_cutouts('queue', NULL, 200, 0) -> 'rows') x
              WHERE x ->> 'job_state' = 'waiting' OR (x ->> 'job_state' = 'queued' AND NOT (x ->> 'published')::boolean)) THEN
    RAISE EXCEPTION 'G11: queue list';
  END IF;
  IF (public.list_media_cutouts('waiting', NULL, 200, 0) ->> 'total')::int <> w THEN RAISE EXCEPTION 'G11: waiting list'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.list_media_cutouts('waiting', NULL, 200, 0) -> 'rows') x
              WHERE (x ->> 'published')::boolean) THEN RAISE EXCEPTION 'G11: a waiting row says published'; END IF;
  IF (public.list_media_cutouts('kept_original', NULL, 200, 0) ->> 'total')::int
     <> (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'kept_original') THEN RAISE EXCEPTION 'G11: kept list'; END IF;
  IF (public.list_media_cutouts('waiting', 'DRAFT', 200, 0) ->> 'total')::int = 0 THEN RAISE EXCEPTION 'G11: search waiting'; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  PERFORM pg_temp.expect('G11 perm', public.list_media_cutouts('waiting', NULL, 50, 0) ->> 'error', 'permission_denied');
END $t$;

-- ------------------------------------------------ G12. housekeeping forgets a waiting photo no product uses
DO $t$ BEGIN
  DELETE FROM public.website_product_media WHERE url = pg_temp.u('g/draft-9.jpg');
  PERFORM public.media_cutout_housekeeping(10);
  IF (pg_temp.row_of('g/draft-9.jpg')).orphaned_at IS NULL THEN RAISE EXCEPTION 'G12: a waiting orphan is marked'; END IF;
END $t$;

-- ------------------------------------------------ G13. off means no work; the gate functions are service-only
DO $t$ BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  PERFORM public.set_media_cutout_settings('off', NULL, 'on');
  IF jsonb_array_length(public.media_cutout_submit_batch(20) -> 'rows') <> 0 THEN RAISE EXCEPTION 'G13: off'; END IF;
  IF has_function_privilege('authenticated', 'public.media_cutout_queue_published(text[],boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_cutout_dequeue_unpublished(text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.media_cutout_url_published(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.review_media_cutout(text,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.review_media_cutout(text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'G13: grants';
  END IF;
  -- the invariant, over everything this suite did
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts
              WHERE job_state = 'queued' AND NOT public.media_cutout_url_published(source_url) AND orphaned_at IS NULL) THEN
    RAISE EXCEPTION 'G13: an unpublished photo is queued';
  END IF;
END $t$;

SELECT 'ALL PASSED' AS media_cutouts_publish_gate_local_tests;
