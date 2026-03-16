import { formatCurrency } from '@/lib/calculations';
import { toJpy } from '@/lib/currency-converter';
import { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { useRecentPaymentsWithAccount } from '@/hooks/use-supabase-data';
import { Currency } from '@/lib/types';
import { Skeleton } from '@/components/ui/skeleton';

interface RecentPaymentsProps {
  currencyFilter?: CurrencyFilter;
}

export default function RecentPayments({ currencyFilter = 'ALL' }: RecentPaymentsProps) {
  const isAllMode = currencyFilter === 'ALL';
  const { data: paymentsWithAccounts, isLoading } = useRecentPaymentsWithAccount();

  const sorted = (paymentsWithAccounts || []).slice(0, 6);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-card-foreground mb-4">Recent Payments</h3>
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No payments yet</p>
      ) : (
        <div className="space-y-3">
          {sorted.map((p) => {
            const currency = p.currency as Currency;
            if (currencyFilter !== 'ALL' && currency !== currencyFilter) return null;
            const customerName = p.account?.customers?.full_name || 'Unknown';
            const invoiceNumber = p.account?.invoice_number || '—';
            const jpyEquivalent = isAllMode ? toJpy(Number(p.amount_paid), currency) : null;
            return (
              <div key={p.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-success/10 text-success text-xs font-bold">
                    {customerName.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-card-foreground">{customerName}</p>
                    <p className="text-xs text-muted-foreground">INV #{invoiceNumber}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-success tabular-nums">
                    +{formatCurrency(Number(p.amount_paid), currency)}
                  </p>
                  {isAllMode && currency === 'PHP' && jpyEquivalent !== null && (
                    <p className="text-[10px] text-muted-foreground tabular-nums">
                      ≈ {formatCurrency(jpyEquivalent, 'JPY')}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {new Date(p.date_paid).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
