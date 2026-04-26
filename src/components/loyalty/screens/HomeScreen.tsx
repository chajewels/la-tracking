import MemberCard from '@/components/loyalty/MemberCard';
import VipProgressSection from '@/components/loyalty/VipProgressSection';
import PointsSnapshot from '@/components/loyalty/PointsSnapshot';
import RecentActivity from '@/components/loyalty/RecentActivity';
import HomeHeader from '@/components/loyalty/home/HomeHeader';
import MilestoneBanner from '@/components/loyalty/home/MilestoneBanner';
import QuickActions from '@/components/loyalty/home/QuickActions';
import BirthdayRewardCard from '@/components/loyalty/home/BirthdayRewardCard';
import FeaturedBanner from '@/components/loyalty/home/FeaturedBanner';
import PromoBanners from '@/components/loyalty/home/PromoBanners';
import ReferralSection from '@/components/loyalty/home/ReferralSection';
import ExclusiveOffers from '@/components/loyalty/home/ExclusiveOffers';
import MilestoneCard from '@/components/loyalty/home/MilestoneCard';
import { Button } from '@/components/ui/button';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface HomeScreenProps {
  canRedeem: boolean;
  onRedeemClick: () => void;
  setTab: (tab: LoyaltyTab) => void;
}

export default function HomeScreen({ canRedeem, onRedeemClick, setTab }: HomeScreenProps) {
  return (
    <div className="px-5 pt-6 pb-4 space-y-5">
      <HomeHeader setTab={setTab} />
      <MemberCard />
      <MilestoneBanner />
      <VipProgressSection onExploreTiers={() => setTab('tiers')} />
      <PointsSnapshot />
      <QuickActions setTab={setTab} />
      <BirthdayRewardCard setTab={setTab} />
      <FeaturedBanner />
      <PromoBanners />

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
      <ReferralSection />
      <ExclusiveOffers />
      <MilestoneCard setTab={setTab} />
    </div>
  );
}
