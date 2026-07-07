import { useEffect, useRef, useState } from 'react';
import { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { animate, useReducedMotion } from 'framer-motion';
import { countUpTransition } from '@/theme/motion';
import Sparkline from '@/components/dashboard/Sparkline';

interface StatCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: LucideIcon;
  trend?: { value: string; positive: boolean };
  variant?: 'default' | 'gold' | 'success' | 'warning' | 'danger';
  href?: string;
  staggerIndex?: number;
  /**
   * Phase 3 opt-in extensions — STRICTLY additive. When these props are
   * absent the component renders byte-identical markup to the pre-Phase-3
   * version (locked by src/test/statcard-legacy-markup.test.tsx).
   */
  /** Micro-trend under the value. `label` is the sr-only description. */
  sparkline?: { points: number[]; label: string };
  /** Animate the value 0→countUpValue once on first mount (600ms ease-out).
   *  `value` remains the canonical final display string. */
  countUpValue?: number;
  /** Formats intermediate count-up frames; default rounds + localizes. */
  formatValue?: (n: number) => string;
}

const defaultCountFormat = (n: number) => Math.round(n).toLocaleString('en-US');

const variantStyles = {
  default: 'bg-card border-border hover:border-primary/30',
  gold: 'bg-card border-primary/30 hover:border-primary/50',
  success: 'bg-card border-success/30 hover:border-success/50',
  warning: 'bg-card border-warning/30 hover:border-warning/50',
  danger: 'bg-card border-destructive/30 hover:border-destructive/50',
};

const iconVariantStyles = {
  default: 'bg-secondary text-secondary-foreground',
  gold: 'gold-gradient text-primary-foreground shadow-lg shadow-primary/20',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive',
};

const valueVariantStyles = {
  default: 'text-card-foreground',
  gold: 'gold-text',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const accentBarStyles = {
  default: 'bg-border',
  gold: 'bg-gradient-to-r from-primary/60 via-primary to-primary/60',
  success: 'bg-success/60',
  warning: 'bg-warning/60',
  danger: 'bg-destructive/60',
};

export default function StatCard({ title, value, subtitle, icon: Icon, trend, variant = 'default', href, staggerIndex, sparkline, countUpValue, formatValue }: StatCardProps) {
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();

  // Count-up: fires exactly once per mount (ref guard), never on re-render.
  // While animating, an intermediate string overrides `value`; on completion
  // it resets to null so the canonical `value` string is what remains.
  const [countFrame, setCountFrame] = useState<string | null>(null);
  const hasAnimatedRef = useRef(false);
  useEffect(() => {
    if (countUpValue === undefined || hasAnimatedRef.current || prefersReducedMotion) return;
    hasAnimatedRef.current = true;
    const fmt = formatValue ?? defaultCountFormat;
    const controls = animate(0, countUpValue, {
      ...countUpTransition,
      onUpdate: (v) => setCountFrame(fmt(v)),
      onComplete: () => setCountFrame(null),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const displayValue = countFrame ?? value;

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border p-4 sm:p-5 card-hover ${variantStyles[variant]} ${
        href ? 'cursor-pointer' : ''
      }${staggerIndex !== undefined ? ' animate-fade-in' : ''}`}
      style={staggerIndex !== undefined ? { animationDelay: `${staggerIndex * 80}ms` } : undefined}
      onClick={href ? () => navigate(href) : undefined}
      role={href ? 'link' : undefined}
    >
      {/* Top accent bar */}
      <div className={`absolute top-0 left-4 right-4 h-[2px] rounded-b-full ${accentBarStyles[variant]}`} />
      
      <div className="flex items-start justify-between">
        <div className="space-y-1.5 min-w-0 flex-1">
          <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider leading-tight">{title}</p>
          <p className={`text-xl sm:text-2xl font-bold font-display tabular-nums ${valueVariantStyles[variant]}`}>{displayValue}</p>
          {subtitle && <p className="text-[10px] sm:text-xs text-muted-foreground truncate">{subtitle}</p>}
          {trend && (
            <p className={`text-xs font-medium ${trend.positive ? 'text-success' : 'text-destructive'}`}>
              {trend.positive ? '↑' : '↓'} {trend.value}
            </p>
          )}
          {sparkline && sparkline.points.length >= 2 && (
            <Sparkline points={sparkline.points} label={sparkline.label} />
          )}
        </div>
        <div className={`flex h-9 w-9 sm:h-10 sm:w-10 items-center justify-center rounded-xl shrink-0 ml-2 transition-transform group-hover:scale-110 ${iconVariantStyles[variant]}`}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      </div>
      
      {/* Hover indicator for clickable cards */}
      {href && (
        <div className="absolute bottom-2 right-3 text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-colors">
          View →
        </div>
      )}
    </div>
  );
}
