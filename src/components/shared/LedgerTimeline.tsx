import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Vertical payment timeline (Hub visual refresh): a gold rail with one node
 * per entry. Presentational only — the caller decides order and content, so
 * each page keeps its own actions (edit / void / restore / proof) untouched.
 */
export function LedgerTimeline({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ol
      className={cn(
        'relative space-y-1 pl-6 before:absolute before:left-[7px] before:top-3 before:bottom-3 before:w-px before:bg-gradient-to-b before:from-gold-500/60 before:via-gold-500/25 before:to-gold-500/5',
        className,
      )}
    >
      {children}
    </ol>
  );
}

/** One entry: a filled gold node, or a hollow muted node when voided. */
export function LedgerTimelineItem({ voided = false, className, children }: { voided?: boolean; className?: string; children: ReactNode }) {
  return (
    <li className={cn('relative rounded-lg px-3 py-3 transition-colors hover:bg-gold-500/[0.03]', voided && 'opacity-60', className)}>
      <span
        aria-hidden
        className={cn(
          'absolute -left-[22px] top-[1.15rem] h-3 w-3 rounded-full border-2 ring-4 ring-card',
          voided ? 'border-muted-foreground/60 bg-card' : 'border-gold-300 bg-gold-500',
        )}
      />
      {children}
    </li>
  );
}
