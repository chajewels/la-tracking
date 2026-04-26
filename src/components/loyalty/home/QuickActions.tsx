import { motion } from 'framer-motion';
import { Gift, Crown, Clock, Sparkles } from 'lucide-react';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface QuickActionsProps {
  setTab: (tab: LoyaltyTab) => void;
}

const ACTIONS: Array<{ label: string; icon: typeof Gift; tab: LoyaltyTab }> = [
  { label: 'Rewards', icon: Gift, tab: 'rewards' },
  { label: 'My Tier', icon: Crown, tab: 'tiers' },
  { label: 'History', icon: Clock, tab: 'points' },
  { label: 'Benefits', icon: Sparkles, tab: 'tiers' },
];

export default function QuickActions({ setTab }: QuickActionsProps) {
  return (
    <div className="grid grid-cols-4 gap-2.5">
      {ACTIONS.map((action, i) => {
        const Icon = action.icon;
        return (
          <motion.button
            key={action.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 * i + 0.3 }}
            onClick={() => setTab(action.tab)}
            className="flex flex-col items-center gap-2 py-3.5 bg-card rounded-xl shadow-card border-gold-accent hover:shadow-soft transition-shadow"
          >
            <div className="w-9 h-9 rounded-full bg-primary/8 flex items-center justify-center">
              <Icon size={16} className="text-primary" strokeWidth={1.8} />
            </div>
            <span className="text-[10px] font-body text-foreground font-medium tracking-wide">
              {action.label}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
