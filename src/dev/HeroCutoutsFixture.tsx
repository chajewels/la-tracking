import { HeroCutoutsCard } from '@/components/website/HeroCutoutsCard';

/** /__fixtures/?view=hero-cutouts[&role=staff] — seeded by hero-cutouts-fixture-data.ts. */
export default function HeroCutoutsFixture() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <HeroCutoutsCard />
    </div>
  );
}
