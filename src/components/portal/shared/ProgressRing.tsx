import { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { countUpTransition } from '@/theme/portal-motion';
import { palette } from '@/theme/portal-tokens';

/**
 * Circular progress ring — % paid of an account. DISPLAY-ONLY: the
 * percentage is the server-provided progress_percent field, passed in as-
 * is; this component never derives or estimates it. Mirrors the Hub's
 * src/components/shared/ProgressRing.tsx semantics but draws its gradient
 * and timing from portal-tokens.ts / portal-motion.ts — separate token
 * source, per the namespace-discipline guardrail.
 *
 * The arc animates from 0 to the target once on mount; static under
 * prefers-reduced-motion.
 */
interface ProgressRingProps {
  percent: number;
  size?: number;
  strokeWidth?: number;
  /** Small caption under the % (e.g. "paid"). */
  label?: string;
}

export default function ProgressRing({ percent, size = 96, strokeWidth = 8, label }: ProgressRingProps) {
  const gradientId = useId();
  const prefersReducedMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const targetOffset = circumference * (1 - clamped / 100);

  return (
    <div className="relative inline-flex items-center justify-center" role="img" aria-label={`${Math.round(clamped)} percent ${label ?? 'paid'}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={palette.gold400} />
            <stop offset="100%" stopColor={palette.gold600} />
          </linearGradient>
        </defs>
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc — rotated so it starts at 12 o'clock */}
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: prefersReducedMotion ? targetOffset : circumference }}
          animate={{ strokeDashoffset: targetOffset }}
          transition={prefersReducedMotion ? { duration: 0 } : countUpTransition}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          data-testid="portal-progress-ring-arc"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold font-display text-primary tabular-nums">{Math.round(clamped)}%</span>
        {label && (
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
        )}
      </div>
    </div>
  );
}
