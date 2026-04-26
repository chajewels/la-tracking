import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Check, Lock } from 'lucide-react';
import { useLoyaltyData } from '@/components/loyalty/loyaltyData';

interface TiersScreenProps {
  onBack: () => void;
}

const formatSpend = (yen: number) => {
  if (yen === 0) return 'Free';
  if (yen >= 1_000_000) return `¥${(yen / 1_000_000).toFixed(0)}M+`;
  if (yen >= 1_000) return `¥${(yen / 1_000).toFixed(0)}k+`;
  return `¥${yen.toLocaleString()}+`;
};

export default function TiersScreen({ onBack }: TiersScreenProps) {
  const { member, tiers } = useLoyaltyData();
  const currentTierRef = useRef<HTMLDivElement | null>(null);

  // Scroll the user's current tier card into view on mount.
  // TiersScreen unmounts when leaving the tab, so this fires
  // each time the user opens Tiers from any source (Home, Profile).
  useEffect(() => {
    if (currentTierRef.current) {
      currentTierRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  if (!member || !tiers || tiers.length === 0) return null;

  const currentTierIndex = tiers.findIndex((t) => t.name === member.current_tier);
  const currentTier = tiers[currentTierIndex];
  const nextTier = tiers[currentTierIndex + 1];

  const progress = nextTier && currentTier
    ? Math.min(
        ((member.lifetime_spend_yen - currentTier.spendRequired) /
          (nextTier.spendRequired - currentTier.spendRequired)) *
          100,
        100,
      )
    : 100;

  return (
    <div className="px-5 pt-6 pb-24 space-y-5">
      {/* Header */}
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-[13px] text-primary font-body font-semibold"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">Tier Benefits</h1>
        <p className="text-[13px] text-muted-foreground font-body mt-1">
          Your current tier:{' '}
          <span className="font-semibold text-primary">{member.current_tier}</span>
        </p>
      </div>

      {/* Progress to next tier */}
      {nextTier && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-card rounded-2xl p-4 shadow-card border-gold-accent space-y-3"
        >
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-body font-semibold text-foreground">
              Progress to {nextTier.name}
            </p>
            <span className="text-[12px] font-body font-bold text-primary">
              {Math.round(progress)}%
            </span>
          </div>
          <div
            className="w-full h-2 rounded-full overflow-hidden"
            style={{ background: 'hsla(36,20%,40%,0.15)' }}
          >
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 1.4, ease: 'easeOut', delay: 0.3 }}
              className="h-full rounded-full gradient-gold"
            />
          </div>
          <p className="text-[12px] text-muted-foreground font-body">
            Spend{' '}
            <span className="font-bold text-primary">
              ¥{member.amount_needed_for_next_tier.toLocaleString()}
            </span>{' '}
            more to unlock {nextTier.name}
          </p>
        </motion.div>
      )}

      {/* Tier cards */}
      <div className="space-y-4">
        {tiers.map((tier, i) => {
          // derived at render — not stored
          const spendCeiling = tier.spendRequired;
          const pointsRate = Math.round(100 * tier.multiplier);

          const isCurrent = tier.name === member.current_tier;
          const isUnlocked = i < currentTierIndex;
          const isLocked = i > currentTierIndex;

          return (
            <motion.div
              key={tier.name}
              ref={isCurrent ? currentTierRef : undefined}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 * i + 0.15 }}
              className="rounded-2xl p-4 shadow-card bg-card scroll-mt-6"
              style={
                isCurrent
                  ? { border: `2px solid ${tier.accent}` }
                  : { border: '1px solid hsla(36,30%,60%,0.15)' }
              }
            >
              {/* Tier header row */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-lg flex-shrink-0"
                    style={{ background: `${tier.accent}1A` }}
                  >
                    {tier.icon}
                  </div>
                  <div>
                    <p
                      className="font-display text-base font-bold leading-tight"
                      style={{
                        background: tier.textGradient,
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                      }}
                    >
                      {tier.name}
                    </p>
                    <p className="text-[12px] text-muted-foreground font-body mt-0.5">
                      {tier.tagline}
                    </p>
                  </div>
                </div>

                {isCurrent && (
                  <span
                    className="text-[10px] tracking-[0.2em] uppercase font-body font-bold px-2 py-1 rounded-full flex-shrink-0"
                    style={{ background: `${tier.accent}28`, color: tier.accent }}
                  >
                    Current
                  </span>
                )}
                {isUnlocked && (
                  <span className="flex items-center gap-1 text-[10px] tracking-[0.15em] uppercase font-body font-semibold text-muted-foreground px-2 py-1 rounded-full bg-muted/30 flex-shrink-0">
                    <Check size={9} />
                    Unlocked
                  </span>
                )}
                {isLocked && (
                  <span className="flex items-center gap-1 text-[10px] tracking-[0.15em] uppercase font-body font-semibold text-muted-foreground/50 px-2 py-1 rounded-full bg-muted/20 flex-shrink-0">
                    <Lock size={9} />
                    Locked
                  </span>
                )}
              </div>

              {/* Stat pills */}
              <div className="flex gap-2 mb-3">
                <div className="flex-1 bg-background/60 rounded-xl p-2.5 text-center" style={{ border: '1px solid hsla(36,30%,60%,0.12)' }}>
                  <p className="text-[10px] text-muted-foreground/70 font-body tracking-wider uppercase mb-1">
                    Spend Required
                  </p>
                  <p className="font-display text-[13px] font-bold text-foreground">
                    {formatSpend(spendCeiling)}
                  </p>
                </div>
                <div className="flex-1 bg-background/60 rounded-xl p-2.5 text-center" style={{ border: '1px solid hsla(36,30%,60%,0.12)' }}>
                  <p className="text-[10px] text-muted-foreground/70 font-body tracking-wider uppercase mb-1">
                    Points Rate
                  </p>
                  <p
                    className="font-display text-[13px] font-bold"
                    style={{ color: tier.accent }}
                  >
                    {pointsRate} / ¥10k
                  </p>
                </div>
              </div>

              {/* Benefits list */}
              <div
                className="rounded-xl p-3"
                style={{ background: 'hsla(36,20%,40%,0.06)', border: '1px solid hsla(36,30%,60%,0.10)' }}
              >
                <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground/70 font-body font-semibold mb-2">
                  Benefits
                </p>
                <ul className="space-y-1.5">
                  {tier.benefits.map((b, j) => (
                    <li
                      key={j}
                      className={`flex items-start gap-2 text-[12px] font-body ${isLocked ? 'text-muted-foreground/40' : 'text-muted-foreground'}`}
                    >
                      <span
                        className="mt-0.5 text-[10px] flex-shrink-0"
                        style={{ color: isLocked ? 'hsla(36,30%,60%,0.3)' : tier.accent }}
                      >
                        ✦
                      </span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* What Changes When You Level Up? */}
      <div className="bg-card rounded-2xl p-5 shadow-card border-gold-accent">
        <h3 className="font-display text-lg font-semibold text-foreground mb-4">
          What Changes When You Level Up?
        </h3>
        <div className="space-y-3">
          {[
            { from: 'Glimmer', desc: 'Standard earning — 1x points on all purchases', icon: '✦' },
            { from: 'Radiant', desc: 'Double points on all purchases + exclusive promos', icon: '❖' },
            { from: 'Elite', desc: 'Double points + free shipping + 2% invoice discount', icon: '◆' },
            { from: 'Crown VIP', desc: 'Triple points + premium perks + mystery gift', icon: '♛' },
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="text-lg w-6 text-center">{item.icon}</span>
              <div className="flex-1">
                <p className="text-[13px] font-body font-semibold text-foreground">{item.from}</p>
                <p className="text-[12px] text-muted-foreground font-body">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Points Earning Examples */}
      <div className="bg-card rounded-2xl p-5 shadow-card border-gold-accent">
        <h3 className="font-display text-lg font-semibold text-foreground mb-3">
          Points Earning Examples
        </h3>
        <p className="text-[12px] text-muted-foreground font-body mb-3">
          Based on a ¥50,000 purchase:
        </p>
        <div className="space-y-2">
          {tiers.map((tier) => (
            <div key={tier.name} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-sm">{tier.icon}</span>
                <span className="text-[13px] font-body font-medium text-foreground">{tier.name}</span>
              </div>
              <div className="text-right">
                <span className="text-[13px] font-body font-bold text-primary">
                  {500 * tier.multiplier} points
                </span>
                <span className="text-[11px] text-muted-foreground font-body ml-1">
                  ({tier.multiplier}x)
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* How to Level Up */}
      <div className="bg-card rounded-2xl p-5 shadow-card border-gold-accent">
        <h3 className="font-display text-lg font-semibold text-foreground mb-3">
          How to Level Up
        </h3>
        <div className="space-y-3">
          {[
            { text: 'Purchase Japan Gold jewelry — every ¥1,000 counts', icon: '💎' },
            { text: 'Make layaway purchases or orders to grow your lifetime spend', icon: '💰' },
            { text: 'Stay active with at least 1 purchase every 6 months', icon: '✅' },
          ].map((tip, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="text-lg">{tip.icon}</span>
              <p className="text-[13px] font-body text-foreground">{tip.text}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center pb-2">
        <div className="divider-gold mb-3" />
        <p className="text-[11px] text-muted-foreground/60 font-body italic tracking-wide">
          Earn · Level Up · Unlock More
        </p>
      </div>
    </div>
  );
}
