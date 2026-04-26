import { motion } from "framer-motion";
import { ArrowRight, Sparkles } from "lucide-react";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";

interface VipProgressSectionProps {
  onExploreTiers?: () => void;
}

const VipProgressSection = ({ onExploreTiers }: VipProgressSectionProps = {}) => {
  const { member, tiers } = useLoyaltyData();
  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier);
  if (!currentTier) return null;
  const currentTierIndex = tiers.indexOf(currentTier);
  const nextTier = tiers[currentTierIndex + 1];
  if (!nextTier) return null;

  const progress =
    ((member.lifetime_spend_yen - currentTier.spendRequired) /
      (nextTier.spendRequired - currentTier.spendRequired)) *
    100;
  const remaining = member.amount_needed_for_next_tier;
  const isClose = progress > 70;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.35 }}
      className="bg-card rounded-2xl p-5 shadow-card border-gold-accent space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-primary" />
          <p className="text-[13px] font-body font-semibold text-foreground">
            Progress to {nextTier.name}
          </p>
        </div>
        <span className="text-[12px] font-body font-bold text-primary">
          {Math.round(progress)}%
        </span>
      </div>
      <div
        className="w-full h-2.5 rounded-full overflow-hidden"
        style={{ background: 'hsla(36, 20%, 40%, 0.15)' }}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(progress, 100)}%` }}
          transition={{ duration: 1.4, ease: "easeOut", delay: 0.5 }}
          className="h-full rounded-full gradient-gold relative"
        >
          <div
            className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full animate-golden-pulse"
            style={{ background: 'hsl(42, 60%, 65%)' }}
          />
        </motion.div>
      </div>
      <p className="text-[13px] text-muted-foreground font-body leading-relaxed">
        Spend{' '}
        <span className="font-bold text-primary">
          ¥{remaining.toLocaleString()}
        </span>{' '}
        more to unlock{' '}
        <span className="font-semibold text-foreground">{nextTier.name}</span>.
      </p>
      <p className="text-[12px] text-muted-foreground/70 font-body italic">
        {isClose
          ? `You're almost there! Just ¥${remaining.toLocaleString()} away from unlocking ${nextTier.name} benefits.`
          : `You are getting closer to ${nextTier.name} rewards.`}
      </p>
      <div className="bg-background/60 rounded-xl p-3.5 border-gold-accent">
        <p className="text-[11px] tracking-[0.2em] uppercase text-primary font-body font-semibold mb-2.5">
          Next Tier Benefits
        </p>
        <ul className="space-y-1.5">
          {nextTier.benefits.map((b, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-[12px] text-muted-foreground font-body"
            >
              <span className="text-primary mt-0.5 text-[10px]">✦</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between py-2 border-t border-border/50">
        <p className="text-[12px] text-muted-foreground font-body">
          Points Rule:{' '}
          <span className="font-semibold text-foreground">
            ¥10,000 = 100 loyalty points
          </span>
        </p>
      </div>
      <button
        onClick={onExploreTiers}
        className="flex items-center gap-1 text-primary text-[12px] font-body font-semibold group"
      >
        Explore Tier Benefits
        <ArrowRight
          size={10}
          className="group-hover:translate-x-0.5 transition-transform"
        />
      </button>
    </motion.div>
  );
};

export default VipProgressSection;
