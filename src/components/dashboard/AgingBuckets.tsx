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
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(status)')
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .eq('layaway_accounts.status', 'active');
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
    const amount = Number(item.total_due_amount) - Number(item.paid_amount);

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
