import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoyaltyBannersByType } from '@/hooks/loyalty-admin/useLoyaltyBanners';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import { dispatchBannerLink } from '@/components/loyalty/home/bannerLink';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface FeaturedBannerProps {
  setTab: (tab: LoyaltyTab) => void;
}

export default function FeaturedBanner({ setTab }: FeaturedBannerProps) {
  const { member } = useLoyaltyData();
  const { data: banners, isLoading } = useLoyaltyBannersByType(
    'featured',
    true,
    member?.current_tier ?? null,
  );

  if (isLoading) {
    return <Skeleton className="h-44 rounded-2xl" />;
  }

  // Hook returns banners ordered by display_priority DESC and filters by
  // schedule + active. Top result is the hero card.
  const banner = banners && banners.length > 0 ? banners[0] : null;
  if (!banner) return null;

  const hasLink = !!(banner.link_target && banner.link_target.trim());

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.5 }}
      className="relative overflow-hidden rounded-2xl shadow-soft"
    >
      {banner.image_url && (
        <div className="w-full aspect-[16/9] overflow-hidden bg-muted">
          <img
            src={banner.image_url}
            alt=""
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget.parentElement as HTMLElement).style.display = 'none';
            }}
          />
        </div>
      )}
      <div className="relative bg-gradient-to-br from-primary/8 via-accent/15 to-primary/5 p-6 border-gold-accent">
        <div className="absolute top-3 right-4 text-primary/20 animate-soft-glow">✦</div>
        <div
          className="absolute bottom-4 right-8 text-primary/10 animate-soft-glow"
          style={{ animationDelay: '1.5s' }}
        >
          ✦
        </div>

        {banner.subtitle && (
          <p className="text-[11px] tracking-[0.3em] uppercase text-primary font-body font-semibold">
            {banner.subtitle}
          </p>
        )}
        <h3 className="font-display text-xl font-semibold text-foreground mt-2 tracking-tight">
          {banner.title}
        </h3>
        {banner.description && (
          <p className="text-[13px] text-muted-foreground font-body mt-2 leading-relaxed max-w-[85%]">
            {banner.description}
          </p>
        )}
        {hasLink && (
          <button
            onClick={() => dispatchBannerLink(banner.link_target, setTab)}
            className="flex items-center gap-1.5 text-primary text-[13px] font-body font-semibold mt-4 group"
          >
            Explore
            <ArrowRight
              size={12}
              className="group-hover:translate-x-0.5 transition-transform"
            />
          </button>
        )}
      </div>
    </motion.div>
  );
}
