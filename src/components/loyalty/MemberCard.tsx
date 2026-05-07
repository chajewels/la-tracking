import { motion } from "framer-motion";
import { TrendingUp, Activity, Sparkles } from "lucide-react";
import { useLoyaltyData } from "@/components/loyalty/loyaltyData";

// Scoped keyframes + overlay layers for the diagonal gold-foil shine
// sweeping across the card surface, plus the damask metallic texture.
// Restored from commit 6f277d0. Self-contained — no Tailwind utility
// dependencies, so the effect renders regardless of global config.
const STYLE_BLOCK = `
@keyframes member-card-shimmer {
  0%   { transform: translateX(-120%) skewX(-12deg); }
  100% { transform: translateX(220%)  skewX(-12deg); }
}
.member-card-shimmer-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  border-radius: inherit;
}
.member-card-shimmer-layer::before {
  content: '';
  position: absolute;
  top: -20%;
  bottom: -20%;
  width: 35%;
  left: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255,255,255,0) 25%,
    rgba(255,255,255,0.55) 50%,
    rgba(255,255,255,0) 75%,
    transparent 100%
  );
  filter: blur(8px);
  mix-blend-mode: screen;
  animation: member-card-shimmer 7s linear infinite;
}
.member-card-damask {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  opacity: 0.08;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'><g fill='none' stroke='%233D2F0E' stroke-width='0.6'><path d='M20 4 L36 20 L20 36 L4 20 Z'/><circle cx='20' cy='20' r='3'/></g></svg>");
  background-size: 48px 48px;
}
`;

// Phase 3.1.1 — strip trailing zeros for the BONUS chip:
//   3.00 → "3", 2.50 → "2.5", 1.27 → "1.27"
// Same logic as fmtMultiplier in loyalty-admin/PromotionsTab.tsx;
// duplicated locally to avoid coupling the customer portal to the
// admin-portal helper file. Promote to a shared util when a third
// caller appears.
const fmtMultiplier = (n: number) => parseFloat(n.toFixed(2)).toString();

// Format a YYYY-MM-DD end_date for the chip's tooltip. Anchored at
// local noon so the timezone difference between UTC and the
// customer's locale never shifts the displayed day backwards.
const fmtEndDate = (yyyyMmDd: string) =>
  new Date(yyyyMmDd + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const MemberCard = () => {
  const { member, tiers, activePromo } = useLoyaltyData();

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTier = tiers.find((t) => t.name === member.current_tier);
  if (!currentTier) return null;
  const currentTierIndex = tiers.indexOf(currentTier);
  const nextTier = tiers[currentTierIndex + 1];

  const activeColor = 'hsl(142, 70%, 22%)';
  const inactiveColor = 'hsl(0, 70%, 32%)';
  const statusColor =
    member.activity_status === 'Active' ? activeColor : inactiveColor;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="relative overflow-hidden rounded-2xl shadow-elevated"
    >
      <div
        className="relative"
        style={{
          background:
            'linear-gradient(135deg, #C9A84C 0%, #E8C96D 50%, #C9A84C 100%)',
        }}
      >
        <style>{STYLE_BLOCK}</style>
        <div className="member-card-damask" />
        <div className="member-card-shimmer-layer" />
        <div
          className="absolute top-0 right-0 w-40 h-40 opacity-[0.10]"
          style={{
            background:
              'radial-gradient(circle at top right, hsla(36, 50%, 20%, 0.5), transparent 70%)',
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
                  className="text-[12px] tracking-[0.18em] uppercase font-semibold"
                  style={{ color: 'hsl(36, 60%, 18%)' }}
                >
                  {currentTier.name} Member
                </p>
                <p
                  className="text-[13px] font-medium mt-0.5"
                  style={{ color: 'hsl(36, 50%, 18%)' }}
                >
                  {member.member_id}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                style={{ background: 'hsla(36, 30%, 15%, 0.22)' }}
              >
                <TrendingUp size={10} style={{ color: 'hsl(42, 80%, 70%)' }} />
                <span
                  className="text-[11px] font-semibold tracking-wider"
                  style={{ color: 'hsl(42, 80%, 70%)' }}
                >
                  {currentTier.multiplier}x POINTS
                </span>
              </div>
              {activePromo && (
                <div
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
                  style={{
                    background:
                      'linear-gradient(135deg, hsla(45, 90%, 55%, 0.95), hsla(45, 100%, 65%, 0.95))',
                    boxShadow: '0 0 12px hsla(45, 90%, 55%, 0.4)',
                  }}
                  title={`${activePromo.name} — ends ${fmtEndDate(activePromo.end_date)}`}
                >
                  <Sparkles size={10} style={{ color: 'hsl(36, 80%, 15%)' }} />
                  <span
                    className="text-[11px] font-semibold tracking-wider"
                    style={{ color: 'hsl(36, 80%, 15%)' }}
                  >
                    {fmtMultiplier(activePromo.bonus_multiplier)}x BONUS
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="text-center mt-6 mb-2">
            <p
              className="text-[11px] tracking-[0.3em] uppercase font-medium"
              style={{ color: 'hsl(36, 50%, 22%)' }}
            >
              Available Points
            </p>
            <motion.p
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="font-display text-[56px] leading-none font-bold mt-2 tracking-tight"
              style={{ color: 'hsl(36, 60%, 12%)' }}
            >
              {member.available_points.toLocaleString()}
            </motion.p>
            <p
              className="text-[13px] mt-2.5 font-body leading-relaxed"
              style={{ color: 'hsl(36, 40%, 22%)' }}
            >
              Earn rewards every time you place a Cha Jewels order.
            </p>
            <p className="text-[13px] mt-3" style={{ color: 'hsl(36, 40%, 22%)' }}>
              Lifetime Spend:{' '}
              <span className="font-semibold" style={{ color: 'hsl(36, 70%, 18%)' }}>
                ¥{member.lifetime_spend_yen.toLocaleString()}
              </span>
            </p>
            <p className="text-[12px] mt-1" style={{ color: 'hsl(36, 35%, 28%)' }}>
              Base: ¥10,000 = 100 points
            </p>
          </div>
          <div className="flex items-center justify-center gap-1.5 mt-2">
            <Activity size={10} style={{ color: statusColor }} />
            <p
              className="text-[12px] font-body"
              style={{ color: 'hsl(36, 40%, 22%)' }}
            >
              Status:{' '}
              <span className="font-semibold" style={{ color: statusColor }}>
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
              style={{ background: 'hsla(36, 40%, 30%, 0.18)' }}
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
                          borderColor: 'hsla(36, 50%, 25%, 0.5)',
                          color: 'hsl(36, 50%, 28%)',
                        }),
                        ...(i <= currentTierIndex && {
                          color: 'hsl(40, 30%, 98%)',
                        }),
                      }}
                    >
                      {tier.icon}
                    </div>
                    <span
                      className="text-[10px] tracking-wider font-medium"
                      style={{
                        color:
                          i === currentTierIndex
                            ? 'hsl(36, 70%, 18%)'
                            : i < currentTierIndex
                            ? 'hsl(36, 60%, 22%)'
                            : 'hsl(36, 40%, 30%)',
                      }}
                    >
                      {tier.name.replace(' VIP', '')}
                    </span>
                  </div>
                ))}
              </div>
              <p
                className="text-[13px] mt-1 text-center font-body"
                style={{ color: 'hsl(36, 40%, 22%)' }}
              >
                Spend{' '}
                <span className="font-bold" style={{ color: 'hsl(36, 80%, 15%)' }}>
                  ¥{member.amount_needed_for_next_tier.toLocaleString()}
                </span>{' '}
                more to unlock{' '}
                <span className="font-semibold" style={{ color: 'hsl(36, 70%, 18%)' }}>
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
