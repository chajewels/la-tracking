import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/calculations';
import { formatPHTDisplay, getPHTToday } from '@/lib/date-utils';
import { Currency } from '@/lib/types';
import { ordinal } from '@/lib/business-rules';
import type { TimelineInstallment } from '@/components/accounts/PaymentTimeline';

/**
 * Customer statement view with print stylesheet (the print button calls
 * window.print(); the @media print rules in index.css isolate
 * .statement-print-area onto white paper).
 *
 * LOCKED DISPLAY RULES apply in full — this is customer-visible financial
 * output:
 *  - penalties, services, and waivers itemized as labeled lines (waivers
 *    as credits), never netted
 *  - zero-amount penalty rows are never rendered
 *  - native currency only, formatting treatment only — no conversion
 *  - totals arrive from computeAccountSummary (layaway) or stored cash
 *    columns; the ONLY arithmetic here is presenting those values
 * Payment history shows created_at (when the payment was made); voided
 * payments stay visible, labeled.
 */

export interface StatementPayment {
  id: string;
  amount: number;
  createdAt: string;
  method?: string | null;
  reference?: string | null;
  voided?: boolean;
}

interface AccountStatementProps {
  open: boolean;
  onClose: () => void;
  kind: 'layaway' | 'cash';
  currency: Currency;
  customerName: string;
  customerCode?: string | null;
  invoiceNumber: string;
  status: string;
  planMonths?: number | null;
  orderDate?: string | null;
  itemDescription?: string | null;
  schedule?: TimelineInstallment[];
  waivers?: Array<{ id: string; amount: number; reason: string }>;
  services?: Array<{ id: string; label: string; amount: number }>;
  payments: StatementPayment[];
  /** From computeAccountSummary (layaway) or stored cash columns. */
  totals: { total: number; paid: number; remaining: number; penalties?: number; services?: number };
}

export default function AccountStatement({
  open,
  onClose,
  kind,
  currency,
  customerName,
  customerCode,
  invoiceNumber,
  status,
  planMonths,
  orderDate,
  itemDescription,
  schedule = [],
  waivers = [],
  services = [],
  payments,
  totals,
}: AccountStatementProps) {
  if (!open) return null;

  const fmt = (n: number) => formatCurrency(n, currency);
  const activePayments = payments.filter(p => !p.voided);
  const voidedPayments = payments.filter(p => p.voided);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 backdrop-blur-sm print:static print:overflow-visible print:bg-transparent print:backdrop-blur-none">
      <div className="mx-auto my-6 w-[min(720px,94vw)] print:my-0 print:w-full">
        {/* Screen-only toolbar */}
        <div className="mb-3 flex items-center justify-end gap-2 print:hidden">
          <Button size="sm" onClick={() => window.print()} className="gold-gradient text-primary-foreground">
            <Printer className="h-4 w-4 mr-1.5" /> Print
          </Button>
          <Button size="sm" variant="outline" onClick={onClose} aria-label="Close statement">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="statement-print-area rounded-xl border border-border bg-card p-6 sm:p-8 text-card-foreground">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 pb-4 hairline-b">
            <div>
              <p className="font-display text-lg tracking-wide text-gold-500">Cha Jewels</p>
              <p className="label-caps mt-0.5">{kind === 'cash' ? 'Cash order statement' : 'Layaway statement'}</p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>Statement date: {formatPHTDisplay(getPHTToday())}</p>
              <p className="tabular-nums">Invoice #{invoiceNumber}</p>
            </div>
          </div>

          {/* Parties / meta */}
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-4">
            <div>
              <dt className="label-caps !text-[9px]">Customer</dt>
              <dd className="font-medium">{customerName}</dd>
            </div>
            {customerCode && (
              <div>
                <dt className="label-caps !text-[9px]">Customer code</dt>
                <dd className="tabular-nums">{customerCode}</dd>
              </div>
            )}
            <div>
              <dt className="label-caps !text-[9px]">Status</dt>
              <dd className="capitalize">{status.replace(/_/g, ' ')}</dd>
            </div>
            {planMonths ? (
              <div>
                <dt className="label-caps !text-[9px]">Plan</dt>
                <dd>{planMonths} months</dd>
              </div>
            ) : null}
            {orderDate && (
              <div>
                <dt className="label-caps !text-[9px]">Order date</dt>
                <dd>{formatPHTDisplay(orderDate)}</dd>
              </div>
            )}
            {itemDescription && (
              <div className="col-span-2">
                <dt className="label-caps !text-[9px]">Item</dt>
                <dd>{itemDescription}</dd>
              </div>
            )}
          </dl>

          {/* Schedule (layaway) */}
          {kind === 'layaway' && schedule.length > 0 && (
            <section className="mt-6">
              <h3 className="label-caps mb-2">Payment schedule</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="hairline-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-2 font-medium">Installment</th>
                    <th className="py-1.5 pr-2 font-medium">Due date</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Amount</th>
                    <th className="py-1.5 pr-2 text-right font-medium">Paid</th>
                    <th className="py-1.5 text-right font-medium">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map(row => (
                    <tr key={row.id} className="border-b border-border/50 last:border-0">
                      {/* ordinal() is zero-based; installment_number is 1-based */}
                      <td className="py-1.5 pr-2">{ordinal(row.installmentNumber - 1)}</td>
                      <td className="py-1.5 pr-2">{formatPHTDisplay(row.dueDate)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{fmt(row.base)}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{fmt(row.allocated)}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.status === 'paid' ? '—' : fmt(row.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Penalties — itemized, zero rows never rendered */}
          {kind === 'layaway' && schedule.some(r => r.penalties.some(p => Number(p.amount) > 0)) && (
            <section className="mt-6">
              <h3 className="label-caps mb-2">Penalties</h3>
              <ul className="space-y-1 text-xs">
                {schedule.flatMap(row =>
                  row.penalties
                    .filter(p => Number(p.amount) > 0)
                    .map(p => (
                      <li key={p.id} className="flex items-baseline justify-between gap-2">
                        <span>
                          {ordinal(row.installmentNumber - 1)} installment · Cycle {p.cycle} ·{' '}
                          {p.stage === 'week1' ? 'week 1' : p.stage === 'week2' ? 'week 2' : p.stage} late fee ·{' '}
                          <span className="capitalize">{p.status === 'unpaid' ? 'applied' : p.status}</span>
                        </span>
                        <span className={`tabular-nums ${p.status === 'waived' ? 'line-through text-muted-foreground' : ''}`}>
                          {fmt(Number(p.amount))}
                        </span>
                      </li>
                    )),
                )}
              </ul>
            </section>
          )}

          {/* Waivers — labeled credits, never netted */}
          {waivers.length > 0 && (
            <section className="mt-6">
              <h3 className="label-caps mb-2">Waived penalties (credits)</h3>
              <ul className="space-y-1 text-xs">
                {waivers.map(w => (
                  <li key={w.id} className="flex items-baseline justify-between gap-2">
                    <span>Penalty waived — {w.reason}</span>
                    <span className="tabular-nums text-success">−{fmt(w.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Services — itemized */}
          {services.length > 0 && (
            <section className="mt-6">
              <h3 className="label-caps mb-2">Services</h3>
              <ul className="space-y-1 text-xs">
                {services.map(s => (
                  <li key={s.id} className="flex items-baseline justify-between gap-2">
                    <span>{s.label}</span>
                    <span className="tabular-nums">{fmt(s.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Payments received — created_at per display rules */}
          <section className="mt-6">
            <h3 className="label-caps mb-2">Payments received</h3>
            {activePayments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No payments recorded yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {activePayments.map(p => (
                  <li key={p.id} className="flex items-baseline justify-between gap-2">
                    <span>
                      {formatPHTDisplay(p.createdAt)}
                      {[p.method, p.reference].filter(Boolean).length > 0 &&
                        ` · ${[p.method, p.reference].filter(Boolean).join(' · ')}`}
                    </span>
                    <span className="tabular-nums text-success">{fmt(Number(p.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
            {voidedPayments.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs opacity-60">
                {voidedPayments.map(p => (
                  <li key={p.id} className="flex items-baseline justify-between gap-2">
                    <span>{formatPHTDisplay(p.createdAt)} · Voided</span>
                    <span className="tabular-nums line-through">{fmt(Number(p.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Totals — from computeAccountSummary / stored cash columns */}
          <section className="mt-6 hairline-t pt-4">
            <dl className="ml-auto w-full max-w-xs space-y-1.5 text-sm">
              {totals.services != null && totals.services > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <dt>Services included</dt>
                  <dd className="tabular-nums">{fmt(totals.services)}</dd>
                </div>
              )}
              {totals.penalties != null && totals.penalties > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <dt>Penalties (non-waived)</dt>
                  <dd className="tabular-nums">{fmt(totals.penalties)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Total obligation</dt>
                <dd className="font-semibold tabular-nums">{fmt(totals.total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Total paid</dt>
                <dd className="font-semibold text-success tabular-nums">{fmt(totals.paid)}</dd>
              </div>
              <div className="flex justify-between text-base">
                <dt className="font-semibold">Remaining balance</dt>
                <dd className="font-bold tabular-nums">{fmt(totals.remaining)}</dd>
              </div>
            </dl>
          </section>

          <p className="mt-6 text-center text-[10px] text-muted-foreground">
            Thank you for your continued trust in Cha Jewels! 🧡
          </p>
        </div>
      </div>
    </div>
  );
}
