import { ChevronRight } from 'lucide-react';
import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';

/**
 * Home screen secondary strip — loyalty points balance and active plans
 * count, both read directly from the customer-portal response. A third
 * "latest statement" link is deferred until the Statements screen
 * (Phase 4) exists with a real data source — no placeholder/fake link is
 * shown in its place.
 */
interface TierStripProps {
  points: number | null;
  activePlans: number;
  onPointsClick: () => void;
  onPlansClick: () => void;
}

export default function TierStrip({ points, activePlans, onPointsClick, onPlansClick }: TierStripProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={onPointsClick}
        className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-4 text-left transition-transform hover:-translate-y-0.5"
      >
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.15em' }}>Points Balance</p>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <p className="font-display text-2xl text-foreground tabular-nums mt-1">
          {points == null ? '—' : <AnimatedNumber value={points} />}
        </p>
      </button>
      <button
        type="button"
        onClick={onPlansClick}
        className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-4 text-left transition-transform hover:-translate-y-0.5"
      >
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.15em' }}>Active Plans</p>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <p className="font-display text-2xl text-foreground tabular-nums mt-1">
          <AnimatedNumber value={activePlans} format={(n) => String(Math.round(n))} />
        </p>
      </button>
    </div>
  );
}
