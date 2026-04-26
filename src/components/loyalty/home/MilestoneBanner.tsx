import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useState } from 'react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';
import { MILESTONES } from '@/components/loyalty/staticFallback';

export default function MilestoneBanner() {
  const { member } = useLoyaltyData();
  const [dismissed, setDismissed] = useState<string[]>([]);

  // TODO: derive `reached` from member.lifetime_spend_yen — Phase 5+
  const lifetimeSpend = member?.lifetime_spend_yen ?? 0;

  const milestones = MILESTONES.map((m) => ({ ...m, reached: lifetimeSpend >= m.amount }));

  const latestReached = [...milestones]
    .filter((m) => m.reached && !dismissed.includes(m.id))
    .sort((a, b) => b.amount - a.amount)[0];

  const nextMilestone = milestones.find((m) => !m.reached);

  if (!latestReached && !nextMilestone) return null;

  return (
    <div className="space-y-2">
      {latestReached && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="relative overflow-hidden rounded-xl shadow-card border-gold-accent"
        >
          <div className="bg-gradient-to-r from-primary/8 via-accent/12 to-primary/5 p-4">
            <motion.span
              className="absolute top-2 right-8 text-primary/20 text-sm"
              animate={{ opacity: [0.3, 0.8, 0.3], scale: [0.8, 1, 0.8] }}
              transition={{ duration: 3, repeat: Infinity }}
            >
              ✦
            </motion.span>
            <motion.span
              className="absolute bottom-3 right-4 text-primary/15 text-xs"
              animate={{ opacity: [0.2, 0.6, 0.2], scale: [0.9, 1.1, 0.9] }}
              transition={{ duration: 2.5, repeat: Infinity, delay: 1 }}
            >
              ✦
            </motion.span>

            <button
              onClick={() => setDismissed([...dismissed, latestReached.id])}
              className="absolute top-3 right-3 p-0.5"
            >
              <X size={12} className="text-muted-foreground/40" />
            </button>

            <div className="flex items-center gap-3">
              <span className="text-2xl">{latestReached.emoji}</span>
              <div className="flex-1">
                <p className="text-[11px] font-body font-semibold text-foreground">
                  {latestReached.title}
                </p>
                <p className="text-[10px] text-muted-foreground font-body mt-0.5 leading-relaxed">
                  {latestReached.message}
                </p>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {nextMilestone && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-card rounded-xl p-3.5 shadow-card border-gold-accent"
        >
          <div className="flex items-center gap-3">
            <span className="text-lg opacity-50">{nextMilestone.emoji}</span>
            <div className="flex-1">
              <p className="text-[10px] text-muted-foreground font-body">
                Next milestone:{' '}
                <span className="font-semibold text-foreground">
                  ¥{nextMilestone.amount.toLocaleString()}
                </span>
              </p>
              <p className="text-[9px] text-muted-foreground/70 font-body mt-0.5">
                ¥{Math.max(0, nextMilestone.amount - lifetimeSpend).toLocaleString()} more to go
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
