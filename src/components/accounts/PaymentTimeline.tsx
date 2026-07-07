import { Check, Circle, Flag, AlertTriangle, Trophy, Banknote } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { formatPHTDisplay } from '@/lib/date-utils';
import { Currency } from '@/lib/types';
import { ordinal } from '@/lib/business-rules';

/**
 * Vertical payment timeline: DP → installments → completion.
 * DISPLAY-ONLY — every node renders from stored rows and DB statuses the
 * detail pages already load (schedule_with_actuals fields, penalty_fees
 * rows, waiver reasons). No penalty-window or balance computation here;
 * the only date handling is formatting.
 *
 * Penalty events are labeled warning nodes showing amount and the
 * stage/cycle reason ("Cycle 1 · week 2 late fee"); waived penalties show
 * the waiver's free-text reason as a labeled credit — never hidden,
 * never netted. Zero-amount penalties are never rendered (display rule).
 */

export interface TimelinePenalty {
  id: string;
  amount: number;
  status: string; // 'unpaid' | 'paid' | 'waived'
  date: string;
  cycle: number;
  stage: string;
  waiverReason?: string;
}

export interface TimelineInstallment {
  id: string;
  installmentNumber: number;
  dueDate: string;
  base: number;
  allocated: number;
  remaining: number;
  /** computed_status from schedule_with_actuals. */
  status: string;
  penalties: TimelinePenalty[];
}

interface PaymentTimelineProps {
  currency: Currency;
  downpayment: { amount: number; paid: number } | null;
  installments: TimelineInstallment[];
  completed: boolean;
}

const PENALTY_PILL: Record<string, { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-success/10 text-success border-success/20' },
  waived: { label: 'Waived', className: 'bg-muted text-muted-foreground border-border line-through' },
  unpaid: { label: 'Applied', className: 'bg-danger/10 text-danger border-danger/20' },
};

function stageLabel(stage: string, cycle: number): string {
  const week = stage === 'week1' ? 'week 1' : stage === 'week2' ? 'week 2' : stage;
  return `Cycle ${cycle} · ${week} late fee`;
}

function NodeDot({ tone, icon: Icon }: { tone: 'gold' | 'muted' | 'warning' | 'danger'; icon: typeof Check }) {
  const toneClass =
    tone === 'gold' ? 'gold-gradient text-primary-foreground'
    : tone === 'warning' ? 'bg-warning/15 text-warning border border-warning/30'
    : tone === 'danger' ? 'bg-danger/15 text-danger border border-danger/30'
    : 'bg-muted text-muted-foreground border border-border';
  return (
    <span className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${toneClass}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

export default function PaymentTimeline({ currency, downpayment, installments, completed }: PaymentTimelineProps) {
  if (!downpayment && installments.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No schedule to display yet.</p>;
  }

  return (
    <ol className="relative space-y-5" aria-label="Payment timeline">
      {/* The ledger line — gold hairline running down the steps */}
      <span aria-hidden className="absolute left-[13px] top-2 bottom-2 w-px bg-gold-500/40" />

      {downpayment && (
        <li className="flex gap-3">
          <NodeDot
            tone={downpayment.paid >= downpayment.amount ? 'gold' : downpayment.paid > 0 ? 'warning' : 'muted'}
            icon={downpayment.paid >= downpayment.amount ? Check : Flag}
          />
          <div className="min-w-0 pt-0.5">
            <p className="text-sm font-semibold text-card-foreground">Downpayment</p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {formatCurrency(downpayment.amount, currency)}
              {downpayment.paid > 0 && downpayment.paid < downpayment.amount &&
                ` · paid ${formatCurrency(downpayment.paid, currency)}`}
              {downpayment.paid >= downpayment.amount && ' · paid in full'}
            </p>
          </div>
        </li>
      )}

      {installments.map(item => {
        const paid = item.status === 'paid';
        const partial = item.status === 'partially_paid';
        const overdue = item.status === 'overdue';
        const visiblePenalties = item.penalties.filter(p => Number(p.amount) > 0);
        return (
          <li key={item.id} className="flex gap-3">
            <NodeDot
              tone={paid ? 'gold' : partial ? 'warning' : overdue ? 'danger' : 'muted'}
              icon={paid ? Check : overdue ? AlertTriangle : Circle}
            />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <p className="text-sm font-semibold text-card-foreground">
                  {/* ordinal() is zero-based; installment_number is 1-based */}
                  {ordinal(item.installmentNumber - 1)} installment
                </p>
                <span className="text-xs text-muted-foreground">
                  due {formatPHTDisplay(item.dueDate)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatCurrency(item.base, currency)}
                {item.allocated > 0 && ` · paid ${formatCurrency(item.allocated, currency)}`}
                {!paid && item.remaining > 0 && ` · ${formatCurrency(item.remaining, currency)} remaining`}
              </p>
              {visiblePenalties.map(p => {
                const pill = PENALTY_PILL[p.status] ?? PENALTY_PILL.unpaid;
                return (
                  <div
                    key={p.id}
                    className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-warning/25 bg-warning/5 px-2 py-1"
                  >
                    <AlertTriangle className="h-3 w-3 text-warning shrink-0" />
                    <span className={`text-xs font-semibold tabular-nums ${p.status === 'waived' ? 'line-through text-muted-foreground' : 'text-warning'}`}>
                      {formatCurrency(Number(p.amount), currency)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{stageLabel(p.stage, p.cycle)}</span>
                    <Badge variant="outline" className={`text-[10px] ${pill.className}`}>{pill.label}</Badge>
                    {p.status === 'waived' && p.waiverReason && (
                      <span className="w-full text-[11px] text-muted-foreground italic">
                        Waived: {p.waiverReason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </li>
        );
      })}

      {completed && (
        <li className="flex gap-3">
          <NodeDot tone="gold" icon={Trophy} />
          <div className="pt-1">
            <p className="text-sm font-semibold gold-text">Layaway completed</p>
          </div>
        </li>
      )}
    </ol>
  );
}

/**
 * Cash-order timeline: order placed → each cash payment → terminal state.
 * Cash orders have no schedule or penalties — nodes come from the order's
 * stored columns and cash_payments rows only.
 */
export interface CashTimelinePayment {
  id: string;
  amount: number;
  createdAt: string;
  method?: string | null;
  reference?: string | null;
  voided?: boolean;
}

interface CashOrderTimelineProps {
  currency: Currency;
  orderDate: string | null;
  payments: CashTimelinePayment[];
  status: string; // 'pending' | 'completed' | 'cancelled' | 'expired'
  terminalAt?: string | null;
}

export function CashOrderTimeline({ currency, orderDate, payments, status, terminalAt }: CashOrderTimelineProps) {
  const terminalLabel =
    status === 'completed' ? 'Order completed'
    : status === 'cancelled' ? 'Order cancelled'
    : status === 'expired' ? 'Order expired'
    : null;

  return (
    <ol className="relative space-y-5" aria-label="Cash order timeline">
      <span aria-hidden className="absolute left-[13px] top-2 bottom-2 w-px bg-gold-500/40" />
      <li className="flex gap-3">
        <NodeDot tone="gold" icon={Flag} />
        <div className="pt-0.5">
          <p className="text-sm font-semibold text-card-foreground">Order placed</p>
          {orderDate && <p className="text-xs text-muted-foreground">{formatPHTDisplay(orderDate)}</p>}
        </div>
      </li>
      {payments.map(p => (
        <li key={p.id} className={`flex gap-3 ${p.voided ? 'opacity-50' : ''}`}>
          <NodeDot tone={p.voided ? 'muted' : 'gold'} icon={Banknote} />
          <div className="min-w-0 pt-0.5">
            <p className={`text-sm font-semibold tabular-nums ${p.voided ? 'line-through text-muted-foreground' : 'text-card-foreground'}`}>
              {formatCurrency(Number(p.amount), currency)}
              {p.voided ? ' · Voided' : ''}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {formatPHTDisplay(p.createdAt)}
              {[p.method, p.reference].filter(Boolean).length > 0 && ` · ${[p.method, p.reference].filter(Boolean).join(' · ')}`}
            </p>
          </div>
        </li>
      ))}
      {terminalLabel && (
        <li className="flex gap-3">
          <NodeDot tone={status === 'completed' ? 'gold' : 'danger'} icon={status === 'completed' ? Trophy : AlertTriangle} />
          <div className="pt-1">
            <p className={`text-sm font-semibold ${status === 'completed' ? 'gold-text' : 'text-danger'}`}>{terminalLabel}</p>
            {terminalAt && <p className="text-xs text-muted-foreground">{formatPHTDisplay(terminalAt)}</p>}
          </div>
        </li>
      )}
    </ol>
  );
}
