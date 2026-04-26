import { motion } from 'framer-motion';
import { Zap, ArrowRight } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface MilestoneCardProps {
  setTab: (tab: LoyaltyTab) => void;
}

export default function MilestoneCard({ setTab }: MilestoneCardProps) {
  const { member, tiers } = useLoyaltyData();
  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier);
  if (!currentTier) return null;
  const nextTier = tiers[tiers.indexOf(currentTier) + 1];
  if (!nextTier) return null;

  const previewBenefits = nextTier.benefits.slice(0, 2).join(' · ');

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 }}
      className="bg-card rounded-xl p-4 shadow-card border-gold-accent"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
          <Zap size={16} className="text-primary" strokeWidth={2} />
        </div>
        <div className="flex-1">
          <p className="text-[11px] font-body font-semibold text-foreground">
            Next Tier: {nextTier.name}
          </p>
          <p className="text-[10px] text-muted-foreground font-body mt-1 leading-relaxed">
            Spend{' '}
            <span className="font-semibold text-foreground">
              ¥{member.amount_needed_for_next_tier.toLocaleString()}
            </span>{' '}
            more to unlock <span className="font-semibold text-primary">{nextTier.name}</span> and enjoy{' '}
            <span className="font-semibold text-foreground">{nextTier.multiplier}x points</span> on every purchase.
          </p>
          <p className="text-[9px] text-muted-foreground/70 font-body mt-1.5 italic">
            Unlock: {previewBenefits}
          </p>
          <button
            onClick={() => setTab('tiers')}
            className="flex items-center gap-1 text-primary text-[10px] font-body font-semibold mt-2 group"
          >
            View Tier Benefits
            <ArrowRight size={10} className="group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
