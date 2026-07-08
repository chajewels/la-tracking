import { Check } from 'lucide-react';
import { differenceInCalendarDays } from 'date-fns';
import { getPHTToday } from '@/lib/date-utils';
import { pt } from '@/i18n/portal';

/**
 * Layaway detail — payment journey timeline. The Maison signature: a
 * vertical gold hairline connecting each payment milestone, filling in
 * as installments are paid. DISPLAY-ONLY — every amount/date/status here
 * is read straight off the customer-portal response; the classification
 * below (paid/overdue/due-soon/partial/pending) is the same presentation
 * logic the pre-Maison OverviewTab already used (date comparisons and
 * status-string matching), not a new business calculation.
 */
export type JourneyEntryState = 'paid' | 'partial' | 'overdue' | 'dueSoon' | 'pending' | 'cancelled';

export interface JourneyEntry {
  key: string;
  label: string;
  dateLabel: string;
  amount: number;
  currency: string;
  state: JourneyEntryState;
  stateLabel: string;
  paidAmount?: number;
  penalty?: { amount: number; status: string } | null;
}

interface PortalScheduleItem {
  installment_number: number;
  due_date: string;
  base_amount: number;
  penalty_amount: number;
  penalty_fee_status: string | null;
  total_due: number;
  paid_amount: number;
  status: string;
}

interface PortalPayment {
  amount: number;
  date: string;
  method: string | null;
  reference: string | null;
  remarks: string | null;
}

/** Pure formatting/classification of already-computed server fields — no arithmetic. */
export function buildJourneyEntries(args: {
  downpaymentAmount: number;
  currency: string;
  payments: PortalPayment[];
  schedule: PortalScheduleItem[];
}): JourneyEntry[] {
  const { downpaymentAmount, currency, payments, schedule } = args;
  const today = getPHTToday();
  const entries: JourneyEntry[] = [];

  if (downpaymentAmount > 0) {
    const taggedDpPaid = payments
      .filter(p => (p.reference && String(p.reference).startsWith('DP-')) || (p.remarks && String(p.remarks).toLowerCase() === 'downpayment'))
      .reduce((s, p) => s + p.amount, 0);
    const totalPaidAll = payments.reduce((s, p) => s + p.amount, 0);
    const dpPaid = taggedDpPaid > 0 ? taggedDpPaid : (totalPaidAll >= downpaymentAmount ? downpaymentAmount : 0);
    const dpFull = dpPaid >= downpaymentAmount;
    const dpPartial = dpPaid > 0 && !dpFull;
    entries.push({
      key: 'downpayment',
      label: pt('common.downpayment'),
      dateLabel: dpFull ? pt('detail.dpPaidStatus') : dpPartial ? pt('detail.dpPartial', { amount: dpPaid.toLocaleString('en-US') }) : pt('detail.dpDueOnOrder'),
      amount: downpaymentAmount,
      currency,
      state: dpFull ? 'paid' : dpPartial ? 'partial' : 'pending',
      stateLabel: dpFull ? pt('detail.statusPaid') : dpPartial ? pt('detail.statusPartial') : pt('detail.dpDueOnOrder'),
      paidAmount: dpPaid > 0 ? dpPaid : undefined,
    });
  }

  for (const item of schedule) {
    const isPaid = item.status === 'paid';
    const isOverdue = !isPaid && item.due_date < today && item.status !== 'cancelled';
    const isPartial = !isPaid && !isOverdue && item.status === 'partially_paid';
    const days = differenceInCalendarDays(new Date(`${item.due_date}T00:00:00Z`), new Date(`${today}T00:00:00Z`));
    const isDueSoon = !isPaid && !isOverdue && !isPartial && days >= 0 && days <= 7 && item.status !== 'cancelled';

    let state: JourneyEntryState = 'pending';
    let stateLabel = pt('detail.statusUpcoming');
    if (item.status === 'cancelled') { state = 'cancelled'; stateLabel = pt('detail.statusCancelled'); }
    else if (isPaid) { state = 'paid'; stateLabel = pt('detail.statusPaid'); }
    else if (isOverdue) { state = 'overdue'; stateLabel = pt('detail.statusOverdue'); }
    else if (isPartial) { state = 'partial'; stateLabel = pt('detail.statusPartial'); }
    else if (isDueSoon) { state = 'dueSoon'; stateLabel = days === 0 ? pt('detail.statusDueToday') : pt('detail.statusDueInDays', { days }); }

    entries.push({
      key: `installment-${item.installment_number}`,
      label: pt('detail.monthN', { n: item.installment_number }),
      dateLabel: item.due_date,
      amount: item.base_amount,
      currency,
      state,
      stateLabel,
      paidAmount: !isPaid && item.paid_amount > 0 ? item.paid_amount : undefined,
      penalty: item.penalty_amount > 0 && item.penalty_fee_status !== 'waived'
        ? { amount: item.penalty_amount, status: item.penalty_fee_status ?? 'unpaid' }
        : null,
    });
  }

  return entries;
}

function fmt(amount: number, currency: string): string {
  return currency === 'JPY'
    ? `¥${Math.round(amount).toLocaleString('en-US')}`
    : `₱${amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 })}`;
}

function fmtDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// NOTE: warning uses the raw --portal-warning arbitrary value, never the
// `warning`/`text-warning` Tailwind utility — that utility resolves to the
// Hub's --warning CSS var (only --destructive is re-scoped for Maison in
// .maison-portal), which would leak a Deco Ledger color into Maison.
const nodeToneClass: Record<JourneyEntryState, string> = {
  paid: 'bg-primary/15 text-primary',
  partial: 'bg-[hsl(var(--portal-warning)/0.15)] text-[hsl(var(--portal-warning))]',
  overdue: 'bg-destructive/10 text-destructive',
  dueSoon: 'bg-[hsl(var(--portal-warning)/0.15)] text-[hsl(var(--portal-warning))]',
  pending: 'bg-secondary text-muted-foreground',
  cancelled: 'bg-secondary text-muted-foreground line-through opacity-60',
};

const badgeToneClass: Record<JourneyEntryState, string> = {
  paid: 'bg-primary/10 text-primary',
  partial: 'bg-[hsl(var(--portal-warning)/0.12)] text-[hsl(var(--portal-warning))]',
  overdue: 'bg-destructive/10 text-destructive',
  dueSoon: 'bg-[hsl(var(--portal-warning)/0.12)] text-[hsl(var(--portal-warning))]',
  pending: 'bg-secondary text-muted-foreground',
  cancelled: 'bg-secondary text-muted-foreground',
};

export default function PaymentJourneyTimeline({ entries }: { entries: JourneyEntry[] }) {
  return (
    <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6">
      <p className="text-[10px] uppercase text-muted-foreground mb-4" style={{ letterSpacing: '0.2em' }}>{pt('detail.paymentJourney')}</p>
      <div>
        {entries.map((entry, idx) => {
          const isLast = idx === entries.length - 1;
          const lineFilled = entry.state === 'paid';
          return (
            <div key={entry.key} className="flex gap-3.5">
              <div className="flex flex-col items-center">
                <div className={`h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${nodeToneClass[entry.state]}`}>
                  {/* Node glyph derives the installment number from the key
                      (installment-N), not by string-replacing the English
                      word "Month" — locale-independent now that the label is
                      translated. */}
                  {entry.state === 'paid' ? <Check className="h-3.5 w-3.5" /> : entry.key === 'downpayment' ? pt('detail.dpNode') : entry.key.replace('installment-', '')}
                </div>
                {!isLast && (
                  <div className={`w-0.5 flex-1 min-h-[24px] ${lineFilled ? 'bg-primary' : 'bg-border'}`} />
                )}
              </div>
              <div className={`flex-1 min-w-0 ${isLast ? '' : 'pb-5'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-foreground">{entry.label}</p>
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${badgeToneClass[entry.state]}`}>
                        {entry.stateLabel}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {entry.key === 'downpayment' ? entry.dateLabel : fmtDate(entry.dateLabel)}
                    </p>
                    {entry.penalty && (
                      <span className={`inline-block text-[10px] font-medium px-2 py-0.5 rounded-full mt-1 ${entry.penalty.status === 'paid' ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>
                        {pt(entry.penalty.status === 'paid' ? 'detail.penaltyPaid' : 'detail.penalty', { amount: fmt(entry.penalty.amount, entry.currency) })}
                      </span>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-foreground tabular-nums">{fmt(entry.amount, entry.currency)}</p>
                    {entry.paidAmount != null && (
                      <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{pt('detail.paidAmount', { amount: fmt(entry.paidAmount, entry.currency) })}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
