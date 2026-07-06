import { motion, useReducedMotion } from 'framer-motion';
import { Crown, Gem, Sparkles, Star } from 'lucide-react';
import { formatPHTDisplay } from '@/lib/date-utils';

/**
 * Loyalty tier card with a metallic treatment per tier. Token-based
 * gradients only (gold family + surfaces via CSS variables); the DB's
 * loyalty_tiers.color_hex arrives as DATA and is used as a small accent.
 * Crown VIP gets one 800ms sheen sweep on mount, then static —
 * suppressed under prefers-reduced-motion.
 */

interface TierCardProps {
  tierName: string | null; // null = not enrolled
  colorHex?: string | null;
  remainingPoints?: number;
  totalEarned?: number;
  totalRedeemed?: number;
  totalExpired?: number;
  multiplier?: number | null;
  enrolledAt?: string | null;
}

// Metallic gradients per tier — all values are theme tokens.
const TIER_STYLES: Record<string, { gradient: string; icon: typeof Star; ring: string }> = {
  Glimmer: {
    gradient: 'linear-gradient(135deg, hsl(var(--surface-2)) 0%, hsl(var(--ink-muted) / 0.25) 50%, hsl(var(--surface-1)) 100%)',
    icon: Star,
    ring: 'border-ink-muted/40',
  },
  Radiant: {
    gradient: 'linear-gradient(135deg, hsl(var(--surface-2)) 0%, hsl(var(--gold-300) / 0.25) 50%, hsl(var(--surface-1)) 100%)',
    icon: Sparkles,
    ring: 'border-gold-300/40',
  },
  Elite: {
    gradient: 'linear-gradient(135deg, hsl(var(--gold-dark) / 0.35) 0%, hsl(var(--gold-500) / 0.3) 50%, hsl(var(--surface-1)) 100%)',
    icon: Gem,
    ring: 'border-gold-500/50',
  },
  'Crown VIP': {
    gradient: 'linear-gradient(135deg, hsl(var(--gold-dark) / 0.55) 0%, hsl(var(--gold-500) / 0.45) 45%, hsl(var(--gold-300) / 0.3) 70%, hsl(var(--surface-1)) 100%)',
    icon: Crown,
    ring: 'border-gold-300/60',
  },
};

export default function TierCard({
  tierName,
  colorHex,
  remainingPoints = 0,
  totalEarned = 0,
  totalRedeemed = 0,
  totalExpired = 0,
  multiplier,
  enrolledAt,
}: TierCardProps) {
  const prefersReducedMotion = useReducedMotion();

  if (!tierName) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 text-center">
        <p className="text-sm text-muted-foreground">Not enrolled in the loyalty program.</p>
      </div>
    );
  }

  const style = TIER_STYLES[tierName] ?? TIER_STYLES.Glimmer;
  const Icon = style.icon;
  const isCrownVip = tierName === 'Crown VIP';

  return (
    <div
      className={`relative overflow-hidden rounded-xl border p-5 ${style.ring}`}
      style={{ background: style.gradient }}
      data-testid="tier-card"
    >
      {/* Crown VIP sheen — one sweep on mount, then static. */}
      {isCrownVip && !prefersReducedMotion && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-1/3"
          style={{
            background:
              'linear-gradient(105deg, transparent 0%, hsl(var(--champagne) / 0.18) 50%, transparent 100%)',
          }}
          initial={{ left: '-40%' }}
          animate={{ left: '110%' }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label-caps">Loyalty tier</p>
          <p className="mt-1 flex items-center gap-2 text-xl font-bold font-display text-champagne">
            <Icon className="h-5 w-5 text-gold-300" />
            {tierName}
            {colorHex && (
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full border border-border"
                style={{ background: colorHex }}
                title={`Tier color ${colorHex}`}
              />
            )}
          </p>
          {multiplier != null && (
            <p className="text-xs text-muted-foreground mt-0.5">{multiplier}× points multiplier</p>
          )}
        </div>
        <div className="text-right">
          <p className="label-caps">Points balance</p>
          <p className="text-2xl font-bold font-display text-gold-300 tabular-nums">
            {remainingPoints.toLocaleString('en-US')}
          </p>
        </div>
      </div>

      <div className="hairline-gold my-4" />

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="label-caps !text-[9px]">Earned</p>
          <p className="text-sm font-semibold text-champagne tabular-nums">{totalEarned.toLocaleString('en-US')}</p>
        </div>
        <div>
          <p className="label-caps !text-[9px]">Redeemed</p>
          <p className="text-sm font-semibold text-champagne tabular-nums">{totalRedeemed.toLocaleString('en-US')}</p>
        </div>
        <div>
          <p className="label-caps !text-[9px]">Expired</p>
          <p className="text-sm font-semibold text-champagne tabular-nums">{totalExpired.toLocaleString('en-US')}</p>
        </div>
      </div>

      {enrolledAt && (
        <p className="mt-3 text-[11px] text-muted-foreground">Member since {formatPHTDisplay(enrolledAt)}</p>
      )}
    </div>
  );
}
