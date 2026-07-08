import { differenceInCalendarDays } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import ProgressRing from '@/components/portal/shared/ProgressRing';
import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';
import { getPHTToday } from '@/lib/date-utils';

/**
 * Home screen hero — the customer's most relevant layaway account (the
 * one the customer-portal edge function's summary.next_due_invoice
 * points to, or the most recent account if none is payable). All money/
 * date/percent values are display-only, passed through exactly as the
 * customer-portal response sent them — no client-side calculation.
 */
export interface HeroAccount {
  invoiceNumber: string;
  planMonths: number;
  statusLabel: string;
  progressPercent: number;
  currency: string;
  nextDueAmount: number | null;
  nextDueDate: string | null;
  totalPaid: number;
  totalObligation: number;
}

function fmt(amount: number, currency: string): string {
  return currency === 'JPY'
    ? `¥${Math.round(amount).toLocaleString('en-US')}`
    : `₱${amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 })}`;
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface HeroLayawayCardProps {
  account: HeroAccount;
  onPay: () => void;
  onViewDetails: () => void;
}

export default function HeroLayawayCard({ account, onPay, onViewDetails }: HeroLayawayCardProps) {
  const isOverdue = account.statusLabel === 'Overdue';
  const isCompleted = account.statusLabel === 'Fully Paid';
  const isPayable = account.nextDueAmount != null && account.nextDueDate != null;

  let dueBadge: { text: string; tone: 'default' | 'warning' | 'danger' } | null = null;
  if (isOverdue) {
    dueBadge = { text: 'Overdue', tone: 'danger' };
  } else if (account.nextDueDate) {
    const days = differenceInCalendarDays(new Date(`${account.nextDueDate}T00:00:00Z`), new Date(`${getPHTToday()}T00:00:00Z`));
    if (days <= 0) dueBadge = { text: 'Due today', tone: 'warning' };
    else if (days <= 3) dueBadge = { text: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
  }

  // NOTE: warning uses the raw --portal-warning arbitrary value, never the
  // `text-warning` Tailwind utility — that utility resolves to the Hub's
  // --warning CSS var (only --destructive is re-scoped for Maison in
  // .maison-portal), which would leak a Deco Ledger color into Maison.
  const badgeToneClass = {
    default: 'bg-secondary text-muted-foreground',
    warning: 'bg-[hsl(var(--portal-warning)/0.12)] text-[hsl(var(--portal-warning))]',
    danger: 'bg-destructive/10 text-destructive',
  } as const;

  return (
    <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-6 sm:p-7">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <p className="text-[10px] uppercase text-muted-foreground mb-1" style={{ letterSpacing: '0.2em' }}>
            {isCompleted ? 'Fully Paid' : 'Active Layaway'}
          </p>
          <p className="font-display text-2xl text-foreground">Invoice #{account.invoiceNumber}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{account.planMonths}-Month Layaway Plan</p>
        </div>
        <ProgressRing percent={account.progressPercent} size={72} strokeWidth={6} label="paid" />
      </div>

      {isCompleted ? (
        <div className="rounded-lg bg-secondary px-4 py-3 mb-5">
          <p className="text-sm text-foreground">🎉 Fully paid — Thank you!</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {fmt(account.totalPaid, account.currency)} of {fmt(account.totalObligation, account.currency)} paid in full.
          </p>
        </div>
      ) : isPayable ? (
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.2em' }}>Next Payment</p>
            {dueBadge && (
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${badgeToneClass[dueBadge.tone]}`}>
                {dueBadge.text}
              </span>
            )}
          </div>
          <p className="font-display text-3xl text-foreground tabular-nums">
            <AnimatedNumber
              value={account.nextDueAmount!}
              format={(n) => fmt(n, account.currency)}
            />
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Due {fmtDate(account.nextDueDate!)}</p>
        </div>
      ) : null}

      <div className="flex gap-3">
        {isPayable && (
          <button
            type="button"
            onClick={onPay}
            className="flex-1 h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90"
          >
            Pay Now
          </button>
        )}
        <button
          type="button"
          onClick={onViewDetails}
          className={`h-12 rounded-lg border border-border text-foreground text-sm font-medium transition-colors hover:bg-secondary flex items-center justify-center gap-1 ${isPayable ? 'px-5' : 'flex-1'}`}
        >
          View Details <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
