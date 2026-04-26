import { motion } from "framer-motion";
import { TrendingUp, Activity } from "lucide-react";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";

const MemberCard = () => {
  const { member, tiers } = useLoyaltyData();

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier);
  if (!currentTier) return null;
  const currentTierIndex = tiers.indexOf(currentTier);
  const nextTier = tiers[currentTierIndex + 1];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="relative overflow-hidden rounded-2xl shadow-elevated"
    >
      <div className="gradient-hero relative">
        <div className="absolute inset-0 animate-shimmer opacity-30 pointer-events-none" />
        <div
          className="absolute top-0 right-0 w-40 h-40 opacity-[0.06]"
          style={{
            background:
              'radial-gradient(circle at top right, hsl(42, 60%, 62%), transparent 70%)',
          }}
        />
        <div className="p-6 pb-5 relative z-10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full gradient-gold flex items-center justify-center shadow-gold animate-golden-pulse">
                <span className="font-display text-xl text-primary-foreground">
                  {currentTier.icon}
                </span>
              </div>
              <div>
                <p
                  className="text-[10px] tracking-[0.18em] uppercase font-semibold"
                  style={{ color: 'hsl(42, 60%, 65%)' }}
                >
                  {currentTier.name} Member
                </p>
                <p
                  className="text-[11px] font-medium mt-0.5"
                  style={{ color: 'hsl(38, 30%, 75%)' }}
                >
                  {member.member_id}
                </p>
              </div>
            </div>
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
              style={{ background: 'hsla(42, 50%, 50%, 0.12)' }}
            >
              <TrendingUp size={10} style={{ color: 'hsl(42, 60%, 65%)' }} />
              <span
                className="text-[9px] font-semibold tracking-wider"
                style={{ color: 'hsl(42, 60%, 65%)' }}
              >
                {currentTier.multiplier}x POINTS
              </span>
            </div>
          </div>
          <div className="text-center mt-6 mb-2">
            <p
              className="text-[9px] tracking-[0.3em] uppercase font-medium"
              style={{ color: 'hsl(38, 18%, 50%)' }}
            >
              Available Points
            </p>
            <motion.p
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="font-display text-[56px] leading-none font-bold mt-2 tracking-tight"
              style={{ color: 'hsl(40, 50%, 93%)' }}
            >
              {member.available_points.toLocaleString()}
            </motion.p>
            <p
              className="text-[11px] mt-2.5 font-body leading-relaxed"
              style={{ color: 'hsl(38, 30%, 62%)' }}
            >
              Earn rewards every time you place a Cha Jewels order.
            </p>
            <p className="text-[11px] mt-3" style={{ color: 'hsl(38, 18%, 55%)' }}>
              Lifetime Spend:{' '}
              <span className="font-semibold" style={{ color: 'hsl(42, 55%, 65%)' }}>
                ¥{member.lifetime_spend_yen.toLocaleString()}
              </span>
            </p>
            <p className="text-[10px] mt-1" style={{ color: 'hsl(38, 18%, 50%)' }}>
              Base: ¥10,000 = 100 points
            </p>
          </div>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <Activity
              size={10}
              style={{
                color:
                  member.activity_status === 'Active'
                    ? 'hsl(142, 60%, 55%)'
                    : 'hsl(0, 60%, 55%)',
              }}
            />
            <p
              className="text-[10px] font-body"
              style={{ color: 'hsl(38, 18%, 55%)' }}
            >
              Status:{' '}
              <span
                className="font-semibold"
                style={{
                  color:
                    member.activity_status === 'Active'
                      ? 'hsl(142, 60%, 55%)'
                      : 'hsl(0, 60%, 55%)',
                }}
              >
                {member.activity_status === 'Active'
                  ? 'Active Member'
                  : 'Inactive — make a purchase to maintain your tier'}
              </span>
            </p>
          </div>
        </div>
        {nextTier && (
          <div className="px-6 pb-5 pt-0 relative z-10">
            <div
              className="rounded-xl p-4"
              style={{ background: 'hsla(36, 20%, 25%, 0.5)' }}
            >
              <div className="flex items-center justify-between mb-3">
                {tiers.map((tier, i) => (
                  <div
                    key={tier.name}
                    className="flex flex-col items-center gap-1.5 flex-1"
                  >
                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-display border transition-all ${
                        i === currentTierIndex
                          ? 'gradient-gold border-transparent shadow-gold animate-golden-pulse'
                          : i < currentTierIndex
                          ? 'gradient-gold border-transparent shadow-gold'
                          : i === currentTierIndex + 1
                          ? 'border-dashed'
                          : ''
                      }`}
                      style={{
                        ...(i > currentTierIndex && {
                          borderColor: 'hsla(42, 40%, 50%, 0.3)',
                          color: 'hsl(38, 15%, 45%)',
                        }),
                        ...(i <= currentTierIndex && {
                          color: 'hsl(40, 30%, 98%)',
                        }),
                      }}
                    >
                      {tier.icon}
                    </div>
                    <span
                      className="text-[8px] tracking-wider font-medium"
                      style={{
                        color:
                          i === currentTierIndex
                            ? 'hsl(42, 60%, 72%)'
                            : i < currentTierIndex
                            ? 'hsl(42, 55%, 62%)'
                            : 'hsl(38, 12%, 42%)',
                      }}
                    >
                      {tier.name.replace(' VIP', '')}
                    </span>
                  </div>
                ))}
              </div>
              <p
                className="text-[11px] mt-1 text-center font-body"
                style={{ color: 'hsl(38, 18%, 60%)' }}
              >
                Spend{' '}
                <span className="font-bold" style={{ color: 'hsl(42, 60%, 72%)' }}>
                  ¥{member.amount_needed_for_next_tier.toLocaleString()}
                </span>{' '}
                more to unlock{' '}
                <span className="font-semibold" style={{ color: 'hsl(42, 55%, 68%)' }}>
                  {nextTier.name}
                </span>
              </p>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default MemberCard;
