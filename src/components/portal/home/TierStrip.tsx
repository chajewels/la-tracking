import { ChevronRight, FileText } from 'lucide-react';
import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';

/**
 * Home screen secondary strip — loyalty points balance and active plans
 * count, both read directly from the customer-portal response, plus a
 * "Latest Statement" link (Phase 4) opening AccountStatementSheet for the
 * same resolved account the hero card shows — no new account-selection
 * logic invented here.
 */
interface TierStripProps {
  points: number | null;
  activePlans: number;
  onPointsClick: () => void;
  onPlansClick: () => void;
  /** Omitted (not rendered) when there is no account to build a statement for. */
  onStatementClick?: () => void;
}

export default function TierStrip({ points, activePlans, onPointsClick, onPlansClick, onStatementClick }: TierStripProps) {
  return (
    <div className="space-y-3">
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
      {onStatementClick && (
        <button
          type="button"
          onClick={onStatementClick}
          className="w-full flex items-center justify-between rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] px-4 py-3 text-left transition-transform hover:-translate-y-0.5"
        >
          <span className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-foreground">Latest Statement</span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  );
}
