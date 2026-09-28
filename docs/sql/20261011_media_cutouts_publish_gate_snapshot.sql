-- ============================================================================
-- LOCAL ONLY. Gives the 2026-09-28 live-shaped snapshot
-- (docs/sql/20261010_media_cutouts_cut_once_snapshot.sql, then cut_once
-- applied: 145 calls | 139 backfilled | 376 queued | 2 held | 6 re-cut
-- permissions | 495 failed at 0) the PRODUCTS its photos belong to, so the
-- publish gate has something to decide. Run after cut_once, BEFORE
-- 20261011100000_media_cutouts_publish_gate. NEVER ON LIVE.
--
-- The owner's counts do not say how the photos split between published and
-- unpublished products. This file ASSUMES a split (so every expectation below
-- is exact for the snapshot, not a prediction for live):
--   100 published products (status active), 40 unpublished (draft)
--   queued, never sent   370 → 250 on published products, 120 on unpublished
--   queued re-cuts         6 → on published products (Photoroom-approved)
--   held (Needs owner)     2 → on published products
--   finished             129 → on published products
--   failed with 402      495 → 300 on published products, 195 on unpublished
-- On live, verification (0) prints the REAL split before and after.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;

INSERT INTO public.website_products (id, sku, slug, name, status)
SELECT ('b1000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'A' || lpad(i::text, 3, '0'),
       'a' || i, 'Published piece ' || i, 'active'
  FROM generate_series(1, 100) i;
INSERT INTO public.website_products (id, sku, slug, name, status)
SELECT ('b2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'D' || lpad(i::text, 3, '0'),
       'd' || i, 'Unpublished piece ' || i, 'draft'
  FROM generate_series(1, 40) i;
INSERT INTO public.website_product_variants (id, product_id)
SELECT ('d1000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, ('b1000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid
  FROM generate_series(1, 100) i;
INSERT INTO public.website_product_variants (id, product_id)
SELECT ('d2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, ('b2000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid
  FROM generate_series(1, 40) i;

-- Which variant each photo belongs to.
CREATE FUNCTION pg_temp.pub(n integer) RETURNS uuid LANGUAGE sql AS
  $$ SELECT ('d1000000-0000-0000-0000-' || lpad(((n % 100) + 1)::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.unpub(n integer) RETURNS uuid LANGUAGE sql AS
  $$ SELECT ('d2000000-0000-0000-0000-' || lpad(((n % 40) + 1)::text, 12, '0'))::uuid $$;

INSERT INTO public.website_product_media (variant_id, url, sort)
SELECT CASE WHEN g.kind = 'q' AND g.i > 250 THEN pg_temp.unpub(g.i)
            WHEN g.kind = 'f' AND g.i > 300 THEN pg_temp.unpub(g.i)
            ELSE pg_temp.pub(g.i) END,
       pg_temp.u('page365/' || g.kind || '/' || g.i || '.jpg'), g.i
  FROM (SELECT 'r' kind, i FROM generate_series(1, 59) i
        UNION ALL SELECT 'p', i FROM generate_series(1, 70) i
        UNION ALL SELECT 'q', i FROM generate_series(1, 370) i
        UNION ALL SELECT 'a', i FROM generate_series(1, 6) i
        UNION ALL SELECT 'x', i FROM generate_series(1, 2) i
        UNION ALL SELECT 'f', i FROM generate_series(1, 495) i) g;

DO $chk$ BEGIN
  IF (SELECT count(*) FROM public.website_media_cutouts c
       WHERE NOT EXISTS (SELECT 1 FROM public.website_product_media m WHERE m.url = c.source_url)) <> 0 THEN
    RAISE EXCEPTION 'snapshot: every cut-out row must have its photo';
  END IF;
  IF (SELECT count(*) FROM public.website_media_cutouts) <> 1002 THEN RAISE EXCEPTION 'snapshot: 1002 rows'; END IF;
END $chk$;

SELECT 'SNAPSHOT products: 100 published, 40 unpublished; 1002 photos placed' AS publish_gate_snapshot;
