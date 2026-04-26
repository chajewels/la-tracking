import { motion } from "framer-motion";
import { Coins, ArrowUpRight, Gift, Activity } from "lucide-react";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";

const PointsSnapshot = () => {
  const { member } = useLoyaltyData();
  if (!member) return null;

  const stats = [
    {
      label: "Lifetime Earned",
      value: member.lifetime_points_earned.toLocaleString(),
      icon: ArrowUpRight,
      color: "text-primary",
    },
    {
      label: "Redeemed",
      value: member.redeemed_points.toLocaleString(),
      icon: Gift,
      color: "text-primary",
    },
    {
      label: "Multiplier",
      value: `${member.current_multiplier}x`,
      icon: Coins,
      color: "text-primary",
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-lg font-semibold text-foreground">
          Points Overview
        </h3>
        <button
          onClick={() => {}}
          className="text-[11px] text-primary font-body font-semibold tracking-wide"
        >
          Details
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {stats.map((stat, i) => (
          <div
            key={i}
            className="bg-card rounded-xl p-3 shadow-card border-gold-accent text-center"
          >
            <stat.icon
              size={14}
              className={`${stat.color} mx-auto mb-1.5`}
              strokeWidth={2}
            />
            <p className="font-display text-lg font-bold text-foreground leading-none">
              {stat.value}
            </p>
            <p className="text-[8px] text-muted-foreground font-body mt-1 tracking-wider uppercase">
              {stat.label}
            </p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-1.5 mt-2">
        <Activity size={10} className="text-primary" />
        <p className="text-[10px] text-muted-foreground font-body">
          Status:{' '}
          <span className="font-semibold text-primary">
            {member.activity_status}
          </span>
        </p>
      </div>
    </motion.div>
  );
};

export default PointsSnapshot;
