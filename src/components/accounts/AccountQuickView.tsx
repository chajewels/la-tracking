import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ReceiptText } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { formatPHTDisplay } from '@/lib/date-utils';
import { Currency } from '@/lib/types';

/**
 * Quick-view drawer for a layaway account — progressive disclosure so staff
 * can review payment history and penalties without leaving the list.
 *
 * Display-only: every figure comes from stored account columns or raw
 * payment/penalty rows. Nothing is recalculated client-side.
 * Payment History shows created_at (when the payment was made) per the
 * locked display rules; voided payments stay visible, labeled — never hidden.
 */

export interface QuickViewAccount {
  id: string;
  invoice_number: string;
  status: string;
  currency: string;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  payment_plan_months: number | null;
  customers?: { full_name: string | null } | null;
}

interface PaymentRow {
  id: string;
  amount_paid: number;
  payment_method: string | null;
  reference_number: string | null;
  created_at: string;
  voided_at: string | null;
}

interface PenaltyRow {
  id: string;
  penalty_amount: number;
  status: string;
  penalty_date: string;
  penalty_cycle: number;
  penalty_stage: string;
}

// Penalty status display per CLAUDE.md: paid → green "Paid",
// waived → gray strikethrough "Waived", unpaid → red "Applied".
const PENALTY_PILL: Record<string, { label: string; className: string }> = {
  paid: { label: 'Paid', className: 'bg-success/10 text-success border-success/20' },
  waived: { label: 'Waived', className: 'bg-muted text-muted-foreground border-border line-through' },
  unpaid: { label: 'Applied', className: 'bg-danger/10 text-danger border-danger/20' },
};

interface AccountQuickViewProps {
  account: QuickViewAccount | null;
  statusLabel: string;
  statusClassName: string;
  onClose: () => void;
}

export default function AccountQuickView({ account, statusLabel, statusClassName, onClose }: AccountQuickViewProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['account-quickview', account?.id],
    enabled: !!account,
    staleTime: 30_000,
    queryFn: async () => {
      const [payments, penalties] = await Promise.all([
        supabase
          .from('payments')
          .select('id, amount_paid, payment_method, reference_number, created_at, voided_at')
          .eq('account_id', account!.id)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('penalty_fees')
          .select('id, penalty_amount, status, penalty_date, penalty_cycle, penalty_stage')
          .eq('account_id', account!.id)
          .order('penalty_date', { ascending: false }),
      ]);
      if (payments.error) throw payments.error;
      if (penalties.error) throw penalties.error;
      return {
        payments: (payments.data ?? []) as PaymentRow[],
        penalties: (penalties.data ?? []) as PenaltyRow[],
      };
    },
  });

  const currency = (account?.currency ?? 'PHP') as Currency;
  // Never show zero-amount penalties (display rule).
  const penalties = (data?.penalties ?? []).filter(p => Number(p.penalty_amount) > 0);

  return (
    <Sheet open={!!account} onOpenChange={open => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto !duration-[280ms]">
        {account && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="flex items-center gap-2 text-champagne">
                <span className="font-display">#{account.invoice_number}</span>
                <Badge variant="outline" className={`text-[10px] ${statusClassName}`}>
                  {statusLabel}
                </Badge>
              </SheetTitle>
              <p className="text-sm text-muted-foreground">
                {account.customers?.full_name || 'Unknown customer'}
                {account.payment_plan_months ? ` · ${account.payment_plan_months}mo plan` : ''}
              </p>
            </SheetHeader>

            {/* Stored account totals — the ledger line divides each section */}
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="label-caps">Total</p>
                <p className="text-sm font-semibold tabular-nums">{formatCurrency(Number(account.total_amount), currency)}</p>
              </div>
              <div>
                <p className="label-caps">Paid</p>
                <p className="text-sm font-semibold text-success tabular-nums">{formatCurrency(Number(account.total_paid), currency)}</p>
              </div>
              <div>
                <p className="label-caps">Balance</p>
                <p className="text-sm font-bold tabular-nums">{formatCurrency(Number(account.remaining_balance), currency)}</p>
              </div>
            </div>

            <div className="hairline-gold my-4" />

            {/* Payment history — created_at, most recent first */}
            <section aria-label="Payment history">
              <h3 className="label-caps mb-2 flex items-center gap-1.5">
                <ReceiptText className="h-3.5 w-3.5" /> Payment History
              </h3>
              {isLoading ? (
                <div className="space-y-2">
                  {[...Array(4)].map((_, i) => (
                    <Skeleton key={i} className="h-9 rounded-md" />
                  ))}
                </div>
              ) : isError ? (
                <p className="text-xs text-muted-foreground py-2">
                  Couldn't load payment history. Open the full account to view it.
                </p>
              ) : (data?.payments.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No payments recorded yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data!.payments.map(p => (
                    <li
                      key={p.id}
                      className={`flex items-center justify-between gap-2 rounded-md bg-surface-2/60 px-2.5 py-1.5 ${p.voided_at ? 'opacity-50' : ''}`}
                    >
                      <div className="min-w-0">
                        <p className="text-xs text-champagne truncate">
                          {formatPHTDisplay(p.created_at)}
                        </p>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {[p.payment_method, p.reference_number].filter(Boolean).join(' · ') || '—'}
                          {p.voided_at ? ' · Voided' : ''}
                        </p>
                      </div>
                      <span className={`text-xs font-semibold tabular-nums text-right shrink-0 ${p.voided_at ? 'line-through' : 'text-success'}`}>
                        {formatCurrency(Number(p.amount_paid), currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {penalties.length > 0 && (
              <>
                <div className="hairline-gold my-4" />
                <section aria-label="Penalties">
                  <h3 className="label-caps mb-2">Penalties</h3>
                  <ul className="space-y-1.5">
                    {penalties.map(p => {
                      const pill = PENALTY_PILL[p.status] ?? PENALTY_PILL.unpaid;
                      return (
                        <li key={p.id} className="flex items-center justify-between gap-2 rounded-md bg-surface-2/60 px-2.5 py-1.5">
                          <div className="min-w-0">
                            <p className="text-xs text-champagne">{formatPHTDisplay(p.penalty_date)}</p>
                            <p className="text-[10px] text-muted-foreground">
                              Cycle {p.penalty_cycle} · {p.penalty_stage}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-xs font-semibold tabular-nums ${p.status === 'waived' ? 'line-through text-muted-foreground' : ''}`}>
                              {formatCurrency(Number(p.penalty_amount), currency)}
                            </span>
                            <Badge variant="outline" className={`text-[10px] ${pill.className}`}>
                              {pill.label}
                            </Badge>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </>
            )}

            <div className="hairline-gold my-4" />

            <Link to={`/accounts/${account.id}`} onClick={onClose}>
              <Button className="w-full gold-gradient text-primary-foreground font-medium">
                <ExternalLink className="h-4 w-4 mr-1.5" /> Open Full Account
              </Button>
            </Link>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
