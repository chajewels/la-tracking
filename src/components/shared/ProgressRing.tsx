import { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { countUpTransition } from '@/theme/motion';
import { palette } from '@/theme/tokens';

/**
 * Circular progress ring — % paid of total. DISPLAY-ONLY: the percentage
 * is computed by the consuming page's existing canonical source
 * (summary.progressPercent for layaway, the stored-column convention for
 * cash orders) and passed in; this component never derives money values.
 *
 * The arc animates from 0 to the target once on mount (600ms ease-out,
 * same timing as KPI count-ups); static under prefers-reduced-motion.
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
    <div className="relative inline-flex items-center justify-center" role="img" aria-label={`${Math.round(clamped)} percent ${label ?? 'complete'}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={palette.gold300} />
            <stop offset="100%" stopColor={palette.gold500} />
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
          data-testid="progress-ring-arc"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold font-display text-primary tabular-nums">{Math.round(clamped)}%</span>
        {label && <span className="label-caps !text-[9px]">{label}</span>}
      </div>
    </div>
  );
}
