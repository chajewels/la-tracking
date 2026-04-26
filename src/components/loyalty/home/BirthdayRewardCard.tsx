import { motion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import type { LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';

interface BirthdayRewardCardProps {
  setTab: (tab: LoyaltyTab) => void;
  // TODO: pass real birthday from Profile (Phase 8). String like "March 15"
  birthday?: string;
}

export default function BirthdayRewardCard({ setTab, birthday }: BirthdayRewardCardProps) {
  const { member } = useLoyaltyData();

  if (!birthday) return null;
  const currentMonth = new Date().toLocaleString('en', { month: 'long' });
  if (!birthday.toLowerCase().includes(currentMonth.toLowerCase())) return null;

  const isVip =
    member?.current_tier === 'Elite' || member?.current_tier === 'Crown VIP';

  return (
    <motion.button
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6 }}
      onClick={() => setTab('rewards')}
      className="w-full bg-gradient-to-r from-primary/8 via-accent/12 to-primary/5 rounded-2xl p-4 shadow-card border-gold-accent flex items-center gap-4 text-left"
    >
      <div className="w-12 h-12 rounded-full gradient-gold flex items-center justify-center flex-shrink-0 shadow-gold animate-golden-pulse">
        <span className="text-xl">🎂</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-display text-[15px] font-semibold text-foreground">
          Happy Birthday Month! 🎉
        </p>
        <p className="text-[13px] text-muted-foreground font-body mt-0.5 leading-relaxed">
          A special birthday reward has been unlocked for you. Celebrate with exclusive Cha Jewels rewards!
        </p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-[11px] gradient-gold text-primary-foreground px-2 py-0.5 rounded-full font-body font-semibold">
            500 Bonus Points
          </span>
          {isVip && (
            <span className="text-[11px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-body font-semibold">
              VIP Birthday Gift
            </span>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="text-primary/40 flex-shrink-0" />
    </motion.button>
  );
}
