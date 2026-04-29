import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { daysOverdueFromToday } from '@/lib/business-rules';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface Bucket {
  label: string;
  count: number;
  amount: number;
  color: string;
}

export default function AgingBuckets({ currency = 'PHP' }: { currency?: Currency }) {
  const { data: scheduleData } = useQuery({
    queryKey: ['aging-buckets'],
    staleTime: 60_000,
    queryFn: async () => {
      // Step 1: list active/overdue account IDs (excludes TEST per dashboard convention).
      // Two-step pattern because schedule_with_actuals is a view; PostgREST FK
      // resolution through views is fragile, so we filter account_id IN (...) instead.
      const { data: activeAccounts, error: acctErr } = await supabase
        .from('layaway_accounts')
        .select('id')
        .in('status', ['active', 'overdue'])
        .not('invoice_number', 'like', 'TEST-%');
      if (acctErr) throw acctErr;
      const accountIds = (activeAccounts || []).map(a => a.id);
      if (accountIds.length === 0) return [];

      // Step 2: read aging rows from canonical view (CLAUDE.md INVARIANT 2 compliant).
      // actual_remaining is the canonical per-row remaining; do NOT compute it
      // from total_due_amount - paid_amount (those are write-only caches).
      const { data, error } = await supabase
        .from('schedule_with_actuals')
        .select('due_date, actual_remaining, computed_status, account_id')
        .in('computed_status', ['pending', 'overdue', 'partially_paid'])
        .in('account_id', accountIds);
      if (error) throw error;
      return data;
    },
  });

  const items = scheduleData || [];

  const buckets: Bucket[] = [
    { label: 'Current', count: 0, amount: 0, color: 'bg-success' },
    { label: '1–7 days', count: 0, amount: 0, color: 'bg-warning' },
    { label: '8–30 days', count: 0, amount: 0, color: 'bg-primary' },
    { label: '31+ days', count: 0, amount: 0, color: 'bg-destructive' },
  ];

  items.forEach(item => {
    const overdueDays = daysOverdueFromToday(item.due_date);
    const amount = Number(item.actual_remaining);

    if (overdueDays <= 0) {
      buckets[0].count++;
      buckets[0].amount += amount;
    } else if (overdueDays <= 7) {
      buckets[1].count++;
      buckets[1].amount += amount;
    } else if (overdueDays <= 30) {
      buckets[2].count++;
      buckets[2].amount += amount;
    } else {
      buckets[3].count++;
      buckets[3].amount += amount;
    }
  });

  const total = buckets.reduce((s, b) => s + b.amount, 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-card-foreground mb-4">Aging Buckets</h3>

      {/* Bar */}
      <div className="flex h-3 rounded-full overflow-hidden mb-4">
        {buckets.map((b) => (
          <div
            key={b.label}
            className={`${b.color} transition-all`}
            style={{ width: total > 0 ? `${(b.amount / total) * 100}%` : '25%' }}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="space-y-2.5">
        {buckets.map((b) => (
          <div key={b.label} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <div className={`h-2.5 w-2.5 rounded-full ${b.color}`} />
              <span className="text-muted-foreground">{b.label}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{b.count} accts</span>
              <span className="font-medium text-card-foreground tabular-nums">
                {formatCurrency(Math.round(b.amount), currency)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
