import { TIER_STATIC, TierName } from '@/components/loyalty/loyaltyData';

interface LoyaltyTierBadgeProps {
  tierName: string | null | undefined;
  className?: string;
}

// Small inline tier badge. Renders nothing when the customer is not a
// loyalty member (tierName null/empty). Color + icon come from the
// shared TIER_STATIC map so this stays in sync with MemberCard.
export default function LoyaltyTierBadge({ tierName, className }: LoyaltyTierBadgeProps) {
  if (!tierName) return null;
  const tier = TIER_STATIC[tierName as TierName];
  const accent = tier?.accent ?? '#9A8F7E';
  const icon = tier?.icon ?? '✦';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none ${className ?? ''}`}
      style={{
        color: accent,
        borderColor: accent,
        backgroundColor: `${accent}1A`,
      }}
      title={`Loyalty member — ${tierName}`}
    >
      <span aria-hidden>{icon}</span>
      {tierName}
    </span>
  );
}
