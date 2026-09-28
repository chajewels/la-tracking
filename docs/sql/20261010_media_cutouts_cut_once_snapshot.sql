-- ============================================================================
-- LOCAL ONLY. A live-shaped snapshot of website_media_cutouts as the owner
-- described it on 2026-09-28, to test 20261010100000_media_cutouts_cut_once
-- against real proportions. Run after the stub + 20261006 + 20261007, BEFORE
-- the cut_once migration. NEVER ON LIVE.
--
--   59  finished by Replicate   (40 ok, 10 auto_fixed, 9 needs_review; 1 call each)
--   70  finished by Photoroom   (50 ok, 10 approved, 5 rejected, 5 needs_review; 1 call each)
--  378  queued                  370 never sent
--                                 6 re-runs staff asked for on Photoroom-approved photos (1 call so far)
--                                 2 re-runs of photos that already cost 2 calls (run 2)
--  495  failed at submit        Photoroom HTTP 402 (plan exhausted), 1 try + 3, never billed
--  provider calls: 135 this month, 10 the month before
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, provider, model,
                                          provider_request_id, run, cutout_path, finished_at)
SELECT pg_temp.u('page365/r/' || i || '.jpg'), 'page365', (i % 3 > 0)::int, 'done',
       CASE WHEN i <= 40 THEN 'ok' WHEN i <= 50 THEN 'auto_fixed' ELSE 'needs_review' END,
       'replicate', 'men1scus/birefnet:f74986db0355', 'rep-' || i, 1, 'website/derived/r' || i || '/cutout.webp', now()
  FROM generate_series(1, 59) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, provider, model,
                                          provider_request_id, run, cutout_path, finished_at)
SELECT pg_temp.u('page365/p/' || i || '.jpg'), 'page365', 0, 'done',
       CASE WHEN i <= 50 THEN 'ok' WHEN i <= 60 THEN 'approved' WHEN i <= 65 THEN 'rejected' ELSE 'needs_review' END,
       'photoroom', 'photoroom/v1/segment', 'pr-' || i, 1, 'website/derived/p' || i || '/cutout.webp', now()
  FROM generate_series(1, 70) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status)
SELECT pg_temp.u('page365/q/' || i || '.jpg'), 'page365', (i % 2), 'queued', 'pending'
  FROM generate_series(1, 370) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, rerun, provider, model,
                                          provider_request_id, run, cutout_path, test_batch)
SELECT pg_temp.u('page365/a/' || i || '.jpg'), 'page365', 0, 'queued', 'approved', true, 'photoroom', 'photoroom/v1/segment',
       'pra-' || i, 1, 'website/derived/a' || i || '/cutout.webp', 'Replicate 10'
  FROM generate_series(1, 6) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, rerun, provider, model,
                                          provider_request_id, run, cutout_path)
SELECT pg_temp.u('page365/x/' || i || '.jpg'), 'page365', 0, 'queued', 'needs_review', true, 'replicate', 'men1scus/birefnet:f74986db0355',
       'rex-' || i, 2, 'website/derived/x' || i || '/cutout.webp'
  FROM generate_series(1, 2) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, attempts, flags, last_error, finished_at)
SELECT pg_temp.u('page365/f/' || i || '.jpg'), 'page365', 1, 'error', 'failed', 4, ARRAY['api_error:photoroom HTTP 402'],
       'photoroom: HTTP 402 {"detail":"No credits left"}', now()
  FROM generate_series(1, 495) i;

INSERT INTO public.website_media_cutout_usage (month, provider_calls) VALUES
  (public.media_cutout_month(), 135),
  (to_char((now() AT TIME ZONE 'Asia/Manila') - interval '1 month', 'YYYY-MM'), 10);

SELECT 'SNAPSHOT ' || count(*) || ' rows, ' || (SELECT sum(provider_calls) FROM public.website_media_cutout_usage) || ' calls'
  FROM public.website_media_cutouts;
