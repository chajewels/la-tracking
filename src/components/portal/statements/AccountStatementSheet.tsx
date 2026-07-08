import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Printer } from 'lucide-react';
import PaymentJourneyTimeline, { buildJourneyEntries } from '@/components/portal/detail/PaymentJourneyTimeline';
import ItemizedTotals from '@/components/portal/detail/ItemizedTotals';
import { pt, serviceLabel } from '@/i18n/portal';

/**
 * Layaway account statement — printable, customer-facing. DISPLAY-ONLY:
 * every figure is passed straight through from the server-provided
 * PortalAccount fields; this component computes nothing. Reuses the
 * Phase 3 PaymentJourneyTimeline/ItemizedTotals components rather than
 * re-deriving the same rows in a second format.
 *
 * Print isolation reuses the existing global `.statement-print-area`
 * rule (index.css, added for the Hub's AccountStatement.tsx) — it forces
 * a white/dark-ink page and hides everything else regardless of the
 * surrounding theme, so no Maison-specific print CSS was needed.
 */
export interface StatementScheduleItem {
  installment_number: number;
  due_date: string;
  base_amount: number;
  penalty_amount: number;
  penalty_fee_status: string | null;
  total_due: number;
  paid_amount: number;
  status: string;
}

export interface StatementPayment {
  amount: number;
  date: string;
  method: string | null;
  reference: string | null;
  remarks: string | null;
}

export interface StatementService {
  service_type: string;
  description: string | null;
  amount: number;
  currency: string;
}

export interface AccountStatementSheetProps {
  open: boolean;
  onClose: () => void;
  invoiceNumber: string;
  currency: string;
  customerName: string;
  customerCode: string;
  statusLabel: string;
  planMonths: number;
  orderDate: string | null;
  downpaymentAmount: number;
  totalAmount: number;
  totalServices: number;
  outstandingPenalties: number;
  totalPaid: number;
  remainingBalance: number;
  schedule: StatementScheduleItem[];
  payments: StatementPayment[];
  services: StatementService[];
}

function fmt(amount: number, currency: string): string {
  return currency === 'JPY'
    ? `¥${Math.round(amount).toLocaleString('en-US')}`
    : `₱${amount.toLocaleString('en-US', { minimumFractionDigits: amount % 1 === 0 ? 0 : 2, maximumFractionDigits: amount % 1 === 0 ? 0 : 2 })}`;
}

function fmtDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function AccountStatementSheet(props: AccountStatementSheetProps) {
  const {
    open, onClose, invoiceNumber, currency, customerName, customerCode, statusLabel,
    planMonths, orderDate, downpaymentAmount, totalAmount, totalServices,
    outstandingPenalties, totalPaid, remainingBalance, schedule, payments, services,
  } = props;

  const entries = buildJourneyEntries({ downpaymentAmount, currency, payments, schedule });
  const statementDate = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto p-0 maison-portal font-body bg-background">
        <div className="statement-print-area">
          {/* No custom close button here — SheetContent already renders shadcn's
              built-in one; a second button in the same corner duplicated it. */}
          <SheetHeader className="px-5 pt-5 pb-0">
            <p className="font-display text-xl text-primary" style={{ letterSpacing: '0.1em' }}>{pt('common.chaJewels')}</p>
            <SheetTitle className="font-display text-lg text-foreground mt-1">{pt('statements.title')}</SheetTitle>
            <p className="text-xs text-muted-foreground mt-0.5">{pt('statements.issued', { date: statementDate })}</p>
          </SheetHeader>

          <div className="px-5 py-5 space-y-5">
            {/* Customer / account meta */}
            <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[9px] uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>{pt('statements.customer')}</p>
                  <p className="text-[13px] font-medium text-foreground">{customerName}</p>
                  <p className="text-[11px] text-muted-foreground">{customerCode}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>{pt('statements.invoice')}</p>
                  <p className="text-[13px] font-medium text-foreground">#{invoiceNumber}</p>
                  <p className="text-[11px] text-muted-foreground">{statusLabel}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>{pt('statements.plan')}</p>
                  <p className="text-[13px] font-medium text-foreground">{pt('statements.planValue', { months: planMonths })}</p>
                </div>
                <div>
                  <p className="text-[9px] uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>{pt('statements.orderDate')}</p>
                  <p className="text-[13px] font-medium text-foreground">{orderDate ? fmtDate(orderDate) : '—'}</p>
                </div>
              </div>
            </div>

            <ItemizedTotals
              currency={currency}
              totalAmount={totalAmount}
              totalServices={totalServices}
              outstandingPenalties={outstandingPenalties}
              totalPaid={totalPaid}
              remainingBalance={remainingBalance}
            />

            <PaymentJourneyTimeline entries={entries} />

            {services.length > 0 && (
              <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6">
                <p className="text-[10px] uppercase text-muted-foreground mb-2" style={{ letterSpacing: '0.2em' }}>{pt('common.additionalServices')}</p>
                <div className="divide-y divide-border">
                  {services.map((svc, idx) => (
                    <div key={idx} className="flex items-center justify-between py-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{serviceLabel(svc.service_type)}</p>
                        {svc.description && <p className="text-xs text-muted-foreground mt-0.5">{svc.description}</p>}
                      </div>
                      <p className="text-sm font-semibold text-primary tabular-nums">{fmt(svc.amount, currency)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {payments.length > 0 && (
              <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6">
                <p className="text-[10px] uppercase text-muted-foreground mb-2" style={{ letterSpacing: '0.2em' }}>{pt('common.paymentHistory')}</p>
                <div className="divide-y divide-border">
                  {payments.map((p, idx) => {
                    const isDp = (p.reference && String(p.reference).startsWith('DP-')) || (p.remarks && String(p.remarks).toLowerCase() === 'downpayment');
                    return (
                      <div key={idx} className="flex items-center justify-between py-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm text-foreground">{fmtDate(p.date)}</p>
                            {isDp && <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary whitespace-nowrap">{pt('common.downpayment')}</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {p.method && <span className="text-[11px] text-muted-foreground capitalize">{p.method}</span>}
                            {p.reference && !isDp && <span className="text-[11px] text-muted-foreground">{pt('common.reference', { ref: p.reference })}</span>}
                          </div>
                        </div>
                        <p className="text-sm font-semibold tabular-nums" style={{ color: 'hsl(var(--portal-success))' }}>{fmt(p.amount, currency)}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => window.print()}
              className="print:hidden w-full h-12 rounded-lg bg-primary text-primary-foreground font-semibold text-sm flex items-center justify-center gap-2 transition-opacity hover:opacity-90"
            >
              <Printer className="h-4 w-4" />
              {pt('statements.print')}
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
