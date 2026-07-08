import { differenceInCalendarDays } from 'date-fns';
import { ChevronRight } from 'lucide-react';
import ProgressRing from '@/components/portal/shared/ProgressRing';
import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';
import { getPHTToday } from '@/lib/date-utils';
import { pt } from '@/i18n/portal';

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
    dueBadge = { text: pt('home.overdue'), tone: 'danger' };
  } else if (account.nextDueDate) {
    const days = differenceInCalendarDays(new Date(`${account.nextDueDate}T00:00:00Z`), new Date(`${getPHTToday()}T00:00:00Z`));
    if (days <= 0) dueBadge = { text: pt('home.dueToday'), tone: 'warning' };
    else if (days <= 3) dueBadge = { text: pt(days === 1 ? 'home.dueInDays_one' : 'home.dueInDays_other', { days }), tone: 'warning' };
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
            {isCompleted ? pt('home.eyebrowPaid') : pt('home.eyebrowActive')}
          </p>
          <p className="font-display text-2xl text-foreground">{pt('common.invoiceHash', { number: account.invoiceNumber })}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{pt('home.planSubtitle', { months: account.planMonths })}</p>
        </div>
        <ProgressRing percent={account.progressPercent} size={72} strokeWidth={6} label={pt('home.ringLabel')} />
      </div>

      {isCompleted ? (
        <div className="rounded-lg bg-secondary px-4 py-3 mb-5">
          <p className="text-sm text-foreground">{pt('home.fullyPaidThanks')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {pt('home.paidOfTotal', { paid: fmt(account.totalPaid, account.currency), total: fmt(account.totalObligation, account.currency) })}
          </p>
        </div>
      ) : isPayable ? (
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[10px] uppercase text-muted-foreground" style={{ letterSpacing: '0.2em' }}>{pt('home.nextPayment')}</p>
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
          <p className="text-xs text-muted-foreground mt-0.5">{pt('home.dueDate', { date: fmtDate(account.nextDueDate!) })}</p>
        </div>
      ) : null}

      <div className="flex gap-3">
        {isPayable && (
          <button
            type="button"
            onClick={onPay}
            className="flex-1 h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm transition-all duration-300 hover:opacity-90"
          >
            {pt('common.payNow')}
          </button>
        )}
        <button
          type="button"
          onClick={onViewDetails}
          className={`h-12 rounded-lg border border-border text-foreground text-sm font-medium transition-colors hover:bg-secondary flex items-center justify-center gap-1 ${isPayable ? 'px-5' : 'flex-1'}`}
        >
          {pt('common.viewDetails')} <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
