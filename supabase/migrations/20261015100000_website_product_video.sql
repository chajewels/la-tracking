-- Product video (D2-1, owner 2026-09-29: "ready it for next time").
--
-- One MP4 per product — the owner's 360° turntable clip, shown as-is in the
-- website gallery (owner 2026-09-25: never converted to 3D). Staff upload it in
-- Website → Catalog → Edit product; the Hub stores the MP4 and a still taken
-- from it in the public media bucket, like product photos, and writes the two
-- URLs here. The `website` function sends them as Product.video_url /
-- video_poster_url, which the storefront gallery already reads (contract
-- "Proposed: item type, product video and size", 2026-09-27).
--
-- Both columns are nullable and empty for every existing product, so applying
-- this changes nothing on the website until a video is uploaded. A URL must be
-- https — the website embeds it directly. Additive only; idempotent.

BEGIN;

ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS video_poster_url text;

COMMENT ON COLUMN public.website_products.video_url IS
  'Public https URL of the product''s MP4 (360° turntable), shown in the website gallery. Null = no video.';
COMMENT ON COLUMN public.website_products.video_poster_url IS
  'Public https URL of a still from video_url, taken in the browser on upload. Null = the website shows a play button.';

ALTER TABLE public.website_products
  DROP CONSTRAINT IF EXISTS website_products_video_url_https,
  DROP CONSTRAINT IF EXISTS website_products_video_poster_https;
ALTER TABLE public.website_products
  ADD CONSTRAINT website_products_video_url_https
    CHECK (video_url IS NULL OR video_url ~ '^https://'),
  ADD CONSTRAINT website_products_video_poster_https
    CHECK (video_poster_url IS NULL OR (video_url IS NOT NULL AND video_poster_url ~ '^https://'));

DO $proof$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'website_products'
         AND column_name IN ('video_url', 'video_poster_url')) <> 2 THEN
    RAISE EXCEPTION 'website_products video columns missing';
  END IF;
END $proof$;

COMMIT;
