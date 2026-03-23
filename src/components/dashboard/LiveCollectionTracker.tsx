import { Activity } from 'lucide-react';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { useRecentPaymentsWithAccount } from '@/hooks/use-supabase-data';
import { toJpy } from '@/lib/currency-converter';
import { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useMemo } from 'react';

interface LiveCollectionTrackerProps {
  currencyFilter: CurrencyFilter;
  displayCurrency: Currency;
}

export default function LiveCollectionTracker({ currencyFilter, displayCurrency }: LiveCollectionTrackerProps) {
  const { data: paymentsWithAccounts, isLoading } = useRecentPaymentsWithAccount();

  // Weekly collections - SINGLE query instead of 7 serial queries
  const { data: weeklyData } = useQuery({
    queryKey: ['weekly-collections'],
    staleTime: 60_000,
    queryFn: async () => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      const startStr = sevenDaysAgo.toISOString().split('T')[0];

      const { data } = await supabase
        .from('payments')
        .select('amount_paid, currency, date_paid')
        .gte('date_paid', startStr)
        .is('voided_at', null);

      // Group by date
      const dayMap = new Map<string, number>();
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dayMap.set(d.toISOString().split('T')[0], 0);
      }

      for (const p of data || []) {
        if (!dayMap.has(p.date_paid)) continue;
        dayMap.set(p.date_paid, dayMap.get(p.date_paid)! + toJpy(Number(p.amount_paid), p.currency as Currency));
      }

      return [...dayMap.entries()].map(([dateStr, amount]) => ({
        label: new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }),
        amount,
      }));
    },
  });

  const sorted = (paymentsWithAccounts || [])
    .filter(p => currencyFilter === 'ALL' || p.currency === currencyFilter)
    .slice(0, 8);

  const maxDay = useMemo(() => Math.max(...(weeklyData || []).map(d => d.amount), 1), [weeklyData]);

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-success" />
        <h3 className="text-sm font-semibold text-card-foreground">Live Collection Tracker</h3>
      </div>

      {/* Mini bar chart - last 7 days */}
      {weeklyData && (
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Last 7 Days</p>
          <div className="flex items-end gap-1.5 h-16">
            {weeklyData.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-success/60 transition-all min-h-[2px]"
                  style={{ height: `${Math.max((d.amount / maxDay) * 100, 3)}%` }}
                />
                <span className="text-[9px] text-muted-foreground">{d.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent feed */}
      <div>
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recent Payments</p>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">No payments yet</p>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {sorted.map(p => {
              const currency = p.currency as Currency;
              const customerName = p.account?.customers?.full_name || 'Unknown';
              return (
                <div key={p.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-success/10 text-success text-[10px] font-bold">
                      {customerName.charAt(0)}
                    </div>
                    <div>
                      <p className="text-xs font-medium text-card-foreground">{customerName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(p.date_paid).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {p.voided_at && ' · VOIDED'}
                      </p>
                    </div>
                  </div>
                  <span className={`text-xs font-semibold tabular-nums ${p.voided_at ? 'text-muted-foreground line-through' : 'text-success'}`}>
                    +{formatCurrency(Number(p.amount_paid), currency)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
