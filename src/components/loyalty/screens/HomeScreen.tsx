import MemberCard from '@/components/loyalty/MemberCard';
import VipProgressSection from '@/components/loyalty/VipProgressSection';
import PointsSnapshot from '@/components/loyalty/PointsSnapshot';
import RecentActivity from '@/components/loyalty/RecentActivity';
import HomeHeader, { type HomeHeaderUnreadPreview } from '@/components/loyalty/home/HomeHeader';
import MilestoneBanner from '@/components/loyalty/home/MilestoneBanner';
import QuickActions from '@/components/loyalty/home/QuickActions';
import BirthdayRewardCard from '@/components/loyalty/home/BirthdayRewardCard';
import FeaturedBanner from '@/components/loyalty/home/FeaturedBanner';
import PromoBanners from '@/components/loyalty/home/PromoBanners';
import MilestoneCard from '@/components/loyalty/home/MilestoneCard';
import CommunityCard from '@/components/loyalty/home/CommunityCard';
import { Button } from '@/components/ui/button';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';
import { memberCard, disabledButton } from '@/theme/portal-tokens';

interface HomeScreenProps {
  canRedeem: boolean;
  onRedeemClick: () => void;
  setTab: (tab: LoyaltyTab) => void;
  unreadCount: number;
  latestUnread?: HomeHeaderUnreadPreview | null;
  birthdayReward: { bonus_points: number; claimable: boolean } | null;
  portalToken: string;
  onClaimed: () => void;
}

export default function HomeScreen({
  canRedeem,
  onRedeemClick,
  setTab,
  unreadCount,
  latestUnread,
  birthdayReward,
  portalToken,
  onClaimed,
}: HomeScreenProps) {
  return (
    <div className="px-5 pt-6 pb-4 space-y-5">
      <HomeHeader
        setTab={setTab}
        unreadCount={unreadCount}
        latestUnread={latestUnread}
      />
      <MemberCard />
      <MilestoneBanner />
      <VipProgressSection onExploreTiers={() => setTab('tiers')} />
      <PointsSnapshot />
      <QuickActions setTab={setTab} />
      <BirthdayRewardCard
        birthdayReward={birthdayReward}
        portalToken={portalToken}
        onClaimed={onClaimed}
      />
      <FeaturedBanner setTab={setTab} />
      <PromoBanners setTab={setTab} />

      <Button
        onClick={onRedeemClick}
        disabled={!canRedeem}
        className="w-full max-w-md mx-auto block"
        style={{
          background: canRedeem ? memberCard.gradient : disabledButton.background,
          color: canRedeem ? memberCard.ink : disabledButton.color,
          fontWeight: 600,
          border: 'none',
        }}
      >
        {canRedeem ? '💎 Redeem Points' : 'No points to redeem yet'}
      </Button>

      <RecentActivity onViewAll={() => setTab('points')} />
      <MilestoneCard setTab={setTab} />
      <CommunityCard />
    </div>
  );
}
