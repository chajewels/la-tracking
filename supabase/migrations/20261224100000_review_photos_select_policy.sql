-- Review photos: moderators can READ the public review-photos bucket (2026-10-18)
--
-- Bug: Website → Reviews → Approve on a review WITH a photo failed with
-- "new row violates row-level security policy" and the review stayed Pending.
-- ReviewsCard.publishPhotos copies each photo into review-photos with
-- storage.upload(..., { upsert: true }). An upsert is INSERT ... ON CONFLICT
-- DO UPDATE, which Postgres RLS checks against the SELECT policy as well as
-- INSERT and UPDATE; Supabase documents that upsert uploads need SELECT and
-- UPDATE in addition to INSERT. Live had INSERT / UPDATE / DELETE moderator
-- policies on review-photos but no SELECT policy (the PR-R1 staged SQL never
-- had one), so every photo approval was refused. The bucket being public only
-- serves anonymous public URLs; it does not satisfy RLS on storage.objects.
-- The same gap made Hide's remove() unable to see the files it deletes.
--
-- Fix: one SELECT policy, same predicate as the existing three. It exposes
-- nothing new: review-photos is a public bucket by design.
-- Guarded (catalog check) so a re-run is a no-op.

DO $p$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Moderators can read review photos'
  ) THEN
    CREATE POLICY "Moderators can read review photos" ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'review-photos'
             AND (SELECT public.has_permission((SELECT auth.uid()), 'moderate_reviews')));
  END IF;
END
$p$;
