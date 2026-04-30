import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useLoyaltyBannersByType } from '@/hooks/loyalty-admin/useLoyaltyBanners';
import { dispatchBannerLink } from '@/components/loyalty/home/bannerLink';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface PromoBannersProps {
  setTab: (tab: LoyaltyTab) => void;
}

export default function PromoBanners({ setTab }: PromoBannersProps) {
  const { data: banners, isLoading } = useLoyaltyBannersByType('promo');

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
    );
  }

  if (!banners || banners.length === 0) return null;

  return (
    <div className="space-y-3">
      {banners.map((b, i) => (
        <motion.div
          key={b.id}
          onClick={() => dispatchBannerLink(b.link_target, setTab)}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.6 + i * 0.1 }}
          className="bg-card rounded-2xl p-4 shadow-card border-gold-accent flex items-center gap-4 cursor-pointer hover:shadow-soft transition-shadow"
        >
          <div className="w-11 h-11 rounded-full bg-primary/8 flex items-center justify-center flex-shrink-0 overflow-hidden">
            {b.image_url ? (
              <img
                src={b.image_url}
                alt=""
                className="h-full w-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <span className="text-xl">{b.emoji ?? '✨'}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display text-[15px] font-semibold text-foreground">
              {b.title}
            </p>
            {b.description && (
              <p className="text-[13px] text-muted-foreground font-body mt-0.5 line-clamp-2">
                {b.description}
              </p>
            )}
          </div>
          <ChevronRight size={16} className="text-primary/40 flex-shrink-0" />
        </motion.div>
      ))}
    </div>
  );
}
