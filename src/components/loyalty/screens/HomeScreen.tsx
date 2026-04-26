import MemberCard from '@/components/loyalty/MemberCard';
import VipProgressSection from '@/components/loyalty/VipProgressSection';
import PointsSnapshot from '@/components/loyalty/PointsSnapshot';
import RecentActivity from '@/components/loyalty/RecentActivity';
import { Button } from '@/components/ui/button';

interface HomeScreenProps {
  canRedeem: boolean;
  onRedeemClick: () => void;
  onShowTiers: () => void;
}

export default function HomeScreen({ canRedeem, onRedeemClick, onShowTiers }: HomeScreenProps) {
  return (
    <div className="px-5 pt-6 pb-4 space-y-5">
      {/* Phase 3 will replace this with HomeHeader, MilestoneBanner,
          QuickActions, BirthdayRewardCard, FeaturedBanner, PromoBanners,
          ReferralSection, ExclusiveOffers, MilestoneCard. */}
      <MemberCard />
      <VipProgressSection />
      <PointsSnapshot />

      <Button
        onClick={onRedeemClick}
        disabled={!canRedeem}
        className="w-full max-w-md mx-auto block"
        style={{
          background: canRedeem
            ? 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)'
            : '#1A1A1A',
          color: canRedeem ? '#1A1500' : '#9A8F7E',
          fontWeight: 600,
          border: 'none',
        }}
      >
        {canRedeem ? '💎 Redeem Points' : 'No points to redeem yet'}
      </Button>

      <RecentActivity />

      <button
        type="button"
        onClick={onShowTiers}
        className="block w-full text-center text-[11px] font-body text-primary underline-offset-4 hover:underline"
      >
        View all tiers →
      </button>
    </div>
  );
}
