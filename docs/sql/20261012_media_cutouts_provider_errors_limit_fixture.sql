-- ============================================================================
-- LOCAL ONLY. The monthly-limit guard of the one-time cleanup in
-- 20261012100000_media_cutouts_provider_errors.sql: 30 Failed Photoroom 402s
-- on a PUBLISHED product, 5 already queued, 580 of 600 used this month.
-- Room = 600 − 580 − 5 = 15 → 15 of the 30 are due now, 15 stay queued and
-- held until the 1st (PHT) with the reason. Plus one 402 already at its
-- paid-call limit → Needs owner, and Completed / Rejected rows that must not
-- move. Run after 20261011, BEFORE 20261012; then
-- docs/sql/20261012_media_cutouts_provider_errors_limit_check.sql. NEVER ON LIVE.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;
CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;

INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000ad', 'admin');
SELECT set_config('test.uid', '00000000-0000-0000-0000-0000000000ad', false);
SELECT public.set_media_cutout_settings('on', 600, NULL);
SELECT set_config('test.uid', '', false);

SELECT set_config('app.media_cutout_owner_override', 'on', false);
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, attempts, flags, last_error, finished_at, created_at)
SELECT pg_temp.u('l/f' || i || '.jpg'), 'page365', (i % 2), 'error', 'failed', 4, ARRAY['api_error:photoroom HTTP 402'],
       'photoroom: HTTP 402 {"detail":"You have exhausted the number of images in your plan"}', now(), now() - (i || ' minutes')::interval
  FROM generate_series(1, 30) i;
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, paid_calls, attempts, last_error)
VALUES (pg_temp.u('l/capped.jpg'), 'page365', 0, 'error', 'failed', 2, 4, 'photoroom: HTTP 402 {"detail":"exhausted"}');
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status)
SELECT pg_temp.u('l/q' || i || '.jpg'), 'page365', 0, 'queued', 'pending' FROM generate_series(1, 5) i;
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, paid_calls, last_error)
VALUES (pg_temp.u('l/ok.jpg'), 'page365', 0, 'done', 'approved', 1, 'photoroom: HTTP 402 old'),
       (pg_temp.u('l/rej.jpg'), 'page365', 0, 'done', 'rejected', 1, 'photoroom: HTTP 402 old'),
       (pg_temp.u('l/kept.jpg'), 'page365', 0, 'done', 'kept_original', 0, 'photoroom: HTTP 402 old');
SELECT set_config('app.media_cutout_owner_override', '', false);
INSERT INTO public.website_media_cutout_usage (month, provider_calls) VALUES (public.media_cutout_month(), 580);

INSERT INTO public.website_products (id, sku, slug, name, status) VALUES ('b3000000-0000-0000-0000-000000000001', 'L1', 'l1', 'Live piece', 'active');
INSERT INTO public.website_product_variants (id, product_id) VALUES ('d3000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000001');
INSERT INTO public.website_product_media (variant_id, url, sort)
SELECT 'd3000000-0000-0000-0000-000000000001', source_url, 0 FROM public.website_media_cutouts;
SELECT 'SNAPSHOT limit fixture: 30 published 402s, 5 queued, 580 of 600 used' AS limit_fixture;
