import { MediaCutoutReviewCard, MediaCutoutSettingsCard } from '@/components/website/MediaCutoutsCard';

/** /__fixtures/?view=media-cutouts — seeded by media-cutouts-fixture-data.ts. */
export default function MediaCutoutsFixture() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <MediaCutoutSettingsCard />
      <MediaCutoutReviewCard />
    </div>
  );
}
