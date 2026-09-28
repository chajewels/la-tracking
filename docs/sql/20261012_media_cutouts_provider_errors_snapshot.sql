-- ============================================================================
-- LOCAL ONLY. A live-shaped snapshot of website_media_cutouts as the owner
-- saw it on 2026-09-28 17:48 JST — AFTER #235 (cut once) and #239 (publish
-- gate) — to test 20261012100000_media_cutouts_provider_errors against real
-- proportions. Run on an EMPTY stub after 20261006, 20261007, 20261010 and
-- 20261011, BEFORE 20261012. NEVER ON LIVE.
--
-- Owner's live counts:  Failed 490 (almost all Photoroom HTTP 402, paid calls
-- 0 of 2; ~12 Replicate rows whose result URL expired) | Waiting for publish
-- 377 | In the queue 0 | 135 of 600 photos this month | switch On, Replicate.
-- 56 of the 402s belong to published products.
--
-- ASSUMED where the owner gave no number (every expectation below is exact
-- for THIS snapshot, not a prediction for live — the live verification
-- prints live values):
--   Failed 490 = 476 Photoroom 402 (56 published, 420 unpublished)
--              +  12 Replicate result expired (8 published, 4 unpublished)
--              +   2 genuine photo failures (published)
--   Completed 130 (40 ok, 10 auto_fixed, 79 approved, 1 kept original),
--   Rejected 5, Needs review 14, Needs owner 2 — all on published products.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;

-- Switch On, Replicate at $0.004, limit 600 (as live).
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000ad', 'admin');
SELECT set_config('test.uid', '00000000-0000-0000-0000-0000000000ad', false);
SELECT public.set_media_cutout_settings('on', 600, NULL);
SELECT public.set_media_cutout_provider('replicate', 0.004, NULL);
SELECT set_config('test.uid', '', false);

-- The rows first (the enqueue trigger then finds them and does nothing).
SELECT set_config('app.media_cutout_owner_override', 'on', false);
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, provider, model,
                                          provider_request_id, run, cutout_path, finished_at, paid_calls)
SELECT pg_temp.u('page365/c/' || i || '.jpg'), 'page365', (i % 3 > 0)::int, 'done',
       CASE WHEN i <= 40 THEN 'ok' WHEN i <= 50 THEN 'auto_fixed' WHEN i <= 129 THEN 'approved' WHEN i = 130 THEN 'kept_original'
            WHEN i <= 135 THEN 'rejected' ELSE 'needs_review' END,
       'photoroom', 'photoroom/v1/segment', 'pr-' || i, 1, 'website/derived/c' || i || '/cutout.webp', now(),
       CASE WHEN i = 130 THEN 0 ELSE 1 END
  FROM generate_series(1, 149) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, paid_calls, hold_reason, held_at)
SELECT pg_temp.u('page365/h/' || i || '.jpg'), 'page365', 0, 'error', 'failed', 2,
       'Stopped after 2 paid calls (the limit for this photo is 2). Last error: decode failed', now()
  FROM generate_series(1, 2) i;

INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status)
SELECT pg_temp.u('page365/w/' || i || '.jpg'), 'page365', (i % 2), 'waiting', 'pending'
  FROM generate_series(1, 377) i;

-- 476 Photoroom 402s: never billed, 0 of 2 paid calls. Mains (priority 0) on even i.
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, attempts, flags, last_error, finished_at)
SELECT pg_temp.u('page365/f/' || i || '.jpg'), 'page365', (i % 2), 'error', 'failed', 4,
       ARRAY['api_error:photoroom HTTP 402 detailYou have exhausted the number of images in your pl'],
       'photoroom: HTTP 402 {"detail":"You have exhausted the number of images in your plan","status_code":402,"type":"payment_required"}', now()
  FROM generate_series(1, 476) i;

-- 12 Replicate jobs whose result expired (1 h retention) while the switch was Off: 1 paid call each.
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, attempts, flags, last_error,
                                          provider, model, provider_request_id, result_url, run, paid_calls, finished_at)
SELECT pg_temp.u('page365/e/' || i || '.jpg'), 'page365', 0, 'error', 'failed', 1, ARRAY['api_error:download 404'], 'download 404',
       'replicate', 'men1scus/birefnet:f74986db0355', 'rep-e' || i, 'https://replicate.delivery/xezq/e' || i || '/out.png', 1, 1, now()
  FROM generate_series(1, 12) i;

-- 2 genuine photo failures.
INSERT INTO public.website_media_cutouts (source_url, source_kind, priority, job_state, status, attempts, flags, last_error,
                                          provider, result_url, run, paid_calls, finished_at)
SELECT pg_temp.u('page365/g/' || i || '.jpg'), 'page365', 0, 'error', 'failed', 1, ARRAY['api_error:decode failed unsupported JPEG'],
       'decode failed: unsupported JPEG (progressive, 12-bit)', 'replicate',
       'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/derived/g' || i || '/replicate.png', 1, 1, now()
  FROM generate_series(1, 2) i;
SELECT set_config('app.media_cutout_owner_override', '', false);

INSERT INTO public.website_media_cutout_usage (month, provider_calls) VALUES
  (public.media_cutout_month(), 135),
  (to_char((now() AT TIME ZONE 'Asia/Manila') - interval '1 month', 'YYYY-MM'), 10);

-- Products: 100 published, 60 unpublished; every photo placed.
INSERT INTO public.website_products (id, sku, slug, name, status)
SELECT ('b1000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'A' || lpad(i::text, 3, '0'), 'a' || i, 'Published piece ' || i, 'active'
  FROM generate_series(1, 100) i;
INSERT INTO public.website_products (id, sku, slug, name, status)
SELECT ('b2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'D' || lpad(i::text, 3, '0'), 'd' || i, 'Unpublished piece ' || i, 'draft'
  FROM generate_series(1, 60) i;
INSERT INTO public.website_product_variants (id, product_id)
SELECT ('d1000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, ('b1000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid
  FROM generate_series(1, 100) i;
INSERT INTO public.website_product_variants (id, product_id)
SELECT ('d2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, ('b2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid
  FROM generate_series(1, 60) i;
CREATE FUNCTION pg_temp.pub(n integer) RETURNS uuid LANGUAGE sql AS
  $$ SELECT ('d1000000-0000-0000-0000-' || lpad(((n % 100) + 1)::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.unpub(n integer) RETURNS uuid LANGUAGE sql AS
  $$ SELECT ('d2000000-0000-0000-0000-' || lpad(((n % 60) + 1)::text, 12, '0'))::uuid $$;

INSERT INTO public.website_product_media (variant_id, url, sort)
SELECT CASE WHEN g.kind = 'w' THEN pg_temp.unpub(g.i)
            WHEN g.kind = 'f' AND g.i > 56 THEN pg_temp.unpub(g.i)
            WHEN g.kind = 'e' AND g.i > 8 THEN pg_temp.unpub(g.i)
            ELSE pg_temp.pub(g.i) END,
       pg_temp.u('page365/' || g.kind || '/' || g.i || '.jpg'), g.i
  FROM (SELECT 'c' kind, i FROM generate_series(1, 149) i
        UNION ALL SELECT 'h', i FROM generate_series(1, 2) i
        UNION ALL SELECT 'w', i FROM generate_series(1, 377) i
        UNION ALL SELECT 'f', i FROM generate_series(1, 476) i
        UNION ALL SELECT 'e', i FROM generate_series(1, 12) i
        UNION ALL SELECT 'g', i FROM generate_series(1, 2) i) g;

DO $chk$ BEGIN
  IF (SELECT count(*) FROM public.website_media_cutouts) <> 1018 THEN RAISE EXCEPTION 'snapshot: 1018 rows'; END IF;
  IF (SELECT count(*) FROM public.website_media_cutouts WHERE status = 'failed' AND hold_reason IS NULL) <> 490
     OR (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'waiting') <> 377
     OR (SELECT count(*) FROM public.website_media_cutouts WHERE job_state = 'queued') <> 0
     OR (SELECT count(*) FROM public.website_media_cutouts
          WHERE status = 'failed' AND last_error LIKE 'photoroom: HTTP 402%' AND public.media_cutout_url_published(source_url)) <> 56 THEN
    RAISE EXCEPTION 'snapshot: not the live shape';
  END IF;
END $chk$;

SELECT 'SNAPSHOT (local, live-shaped): Failed 490 | Waiting 377 | queued 0 | 135 of 600 | On, Replicate' AS provider_errors_snapshot;
