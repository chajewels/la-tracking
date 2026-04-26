import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface PromoBannersProps {
  setTab: (tab: LoyaltyTab) => void;
}

export default function PromoBanners({ setTab }: PromoBannersProps) {
  const PROMOS = [
    {
      emoji: '🎂',
      title: 'Birthday Month Reward',
      body: 'Claim your 500 bonus points + birthday gift this March!',
      delay: 0.6,
      onClick: () => setTab('profile'),
    },
    {
      emoji: '💎',
      title: 'Everyday Layaway',
      body: 'Earn points on every layaway purchase or order — invest in gold your way!',
      delay: 0.7,
      onClick: () => {}, // TODO: wire to layaway info screen when available
    },
    {
      emoji: '👑',
      title: 'Tier Up & Earn More',
      body: 'Level up to unlock 2x and 3x points, free shipping, and exclusive perks!',
      delay: 0.8,
      onClick: () => setTab('tiers'),
    },
  ];

  return (
    <div className="space-y-3">
      {PROMOS.map((p) => (
        <motion.div
          key={p.title}
          onClick={p.onClick}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: p.delay }}
          className="bg-card rounded-2xl p-4 shadow-card border-gold-accent flex items-center gap-4 cursor-pointer hover:shadow-soft transition-shadow"
        >
          <div className="w-11 h-11 rounded-full bg-primary/8 flex items-center justify-center flex-shrink-0">
            <span className="text-xl">{p.emoji}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-display text-[15px] font-semibold text-foreground">{p.title}</p>
            <p className="text-[11px] text-muted-foreground font-body mt-0.5">{p.body}</p>
          </div>
          <ChevronRight size={16} className="text-primary/40 flex-shrink-0" />
        </motion.div>
      ))}
    </div>
  );
}
