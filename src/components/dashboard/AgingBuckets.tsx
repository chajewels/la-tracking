import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

interface Bucket {
  label: string;
  count: number;
  amount: number;
  color: string;
}

const buckets: Bucket[] = [
  { label: 'Current', count: 3, amount: 108233, color: 'bg-success' },
  { label: '1–7 days', count: 1, amount: 29638, color: 'bg-warning' },
  { label: '8–30 days', count: 1, amount: 20000, color: 'bg-primary' },
  { label: '31+ days', count: 0, amount: 0, color: 'bg-destructive' },
];

export default function AgingBuckets({ currency = 'PHP' }: { currency?: Currency }) {
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
                {formatCurrency(b.amount, currency)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
