import { cn } from '@/lib/utils';
import type { StatusTone } from '@/components/shared/status-tone';

/**
 * Status pill — a coloured dot plus a label, on a faint tint of the same
 * semantic token (success / warning / danger / info / gold / muted). The
 * overdue tone's dot breathes gently; that animation is declared only under
 * prefers-reduced-motion: no-preference (see .status-dot-pulse in index.css).
 *
 * Display-only: callers map their existing status value to a tone. The pill
 * never decides what a status means.
 */
const toneStyles: Record<StatusTone, { pill: string; dot: string }> = {
  success: { pill: 'bg-success/10 text-success border-success/25', dot: 'bg-success' },
  warning: { pill: 'bg-warning/10 text-warning border-warning/25', dot: 'bg-warning' },
  danger: { pill: 'bg-danger/10 text-danger border-danger/30', dot: 'bg-danger' },
  info: { pill: 'bg-info/10 text-info border-info/25', dot: 'bg-info' },
  gold: { pill: 'bg-gold-500/10 text-gold-300 border-gold-500/30', dot: 'bg-gold-500' },
  muted: { pill: 'bg-muted text-muted-foreground border-border', dot: 'bg-muted-foreground' },
};

interface StatusPillProps {
  label: string;
  tone: StatusTone;
  /** Breathing dot — used for overdue. */
  pulse?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export default function StatusPill({ label, tone, pulse = false, size = 'sm', className }: StatusPillProps) {
  const t = toneStyles[tone];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-xs',
        t.pill,
        className,
      )}
    >
      <span className={cn('relative inline-block h-1.5 w-1.5 rounded-full', t.dot, pulse && 'status-dot-pulse')} aria-hidden />
      {label}
    </span>
  );
}

/**
 * Reserve-first (A2): a website reservation staff must confirm or decline.
 * Warning tone with the breathing dot — it needs action, like Overdue — and
 * static under reduced motion. Callers decide visibility with
 * isAwaitingConfirmation() from lib/web-reservations; this is display only.
 */
export function ToConfirmPill({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  return <StatusPill label="To confirm" tone="warning" pulse size={size} className={className} />;
}
