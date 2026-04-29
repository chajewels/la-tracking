import { useState } from 'react';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toJpy } from '@/lib/currency-converter';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

type Scope = 'all_collectible' | 'active_flow';
type Variant = 'count' | 'amount';
type BucketKey = 'current' | 'd1_7' | 'd8_30' | 'd31_plus';

interface AgingBucketsProps {
  currency?: Currency;
  variant?: Variant;
  scope?: Scope;
  onScopeChange?: (next: Scope) => void;
}

interface BucketUI {
  key: BucketKey;
  label: string;
  color: string;
  count: number;
  amount: number;
}

interface RpcRow {
  bucket: BucketKey;
  currency: Currency;
  account_count: number;
  amount: number;
}

const BUCKET_DEFS: Array<{ key: BucketKey; label: string; color: string }> = [
  { key: 'current', label: 'Current', color: 'bg-success' },
  { key: 'd1_7', label: '1–7 days', color: 'bg-warning' },
  { key: 'd8_30', label: '8–30 days', color: 'bg-primary' },
  { key: 'd31_plus', label: '31+ days', color: 'bg-destructive' },
];

export default function AgingBuckets({
  currency = 'PHP',
  variant = 'amount',
  scope: scopeProp,
  onScopeChange,
}: AgingBucketsProps) {
  // Hybrid controlled/uncontrolled: parent can hoist via onScopeChange + scope,
  // otherwise component manages internally with the initial scope prop.
  const [internalScope, setInternalScope] = useState<Scope>(scopeProp ?? 'all_collectible');
  const isControlled = onScopeChange != null;
  const scope: Scope = isControlled ? (scopeProp ?? 'all_collectible') : internalScope;
  const setScope = (next: Scope) => {
    if (isControlled) onScopeChange!(next);
    else setInternalScope(next);
  };

  const { data: rpcRows } = useQuery({
    queryKey: ['aging-buckets', scope],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_aging_buckets', { p_scope: scope });
      if (error) throw error;
      return (data ?? []) as RpcRow[];
    },
  });

  const buckets: BucketUI[] = BUCKET_DEFS.map(b => ({ ...b, count: 0, amount: 0 }));
  const indexByKey: Record<BucketKey, number> = {
    current: 0, d1_7: 1, d8_30: 2, d31_plus: 3,
  };

  for (const row of rpcRows ?? []) {
    const i = indexByKey[row.bucket];
    if (i == null) continue;
    buckets[i].count += Number(row.account_count) || 0;
    if (variant === 'amount') {
      const amt = Number(row.amount) || 0;
      if (currency === 'JPY') {
        buckets[i].amount += row.currency === 'JPY' ? amt : toJpy(amt, 'PHP');
      } else {
        if (row.currency === 'PHP') buckets[i].amount += amt;
        // PHP display: ignore JPY rows (no inverse conversion in this codebase)
      }
    }
  }

  const total = variant === 'count'
    ? buckets.reduce((s, b) => s + b.count, 0)
    : buckets.reduce((s, b) => s + b.amount, 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-card-foreground">Aging Buckets</h3>
        <div className="flex gap-1 rounded-lg border border-border p-0.5 bg-card">
          {(['all_collectible', 'active_flow'] as const).map(s => {
            const active = scope === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {s === 'all_collectible' ? 'All collectible' : 'Active flow'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bar */}
      <div className="flex h-3 rounded-full overflow-hidden mb-4">
        {buckets.map((b) => {
          const value = variant === 'count' ? b.count : b.amount;
          return (
            <div
              key={b.key}
              className={`${b.color} transition-all`}
              style={{ width: total > 0 ? `${(value / total) * 100}%` : '25%' }}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="space-y-2.5">
        {buckets.map((b) => (
          <div key={b.key} className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <div className={`h-2.5 w-2.5 rounded-full ${b.color}`} />
              <span className="text-muted-foreground">{b.label}</span>
            </div>
            <div className="flex items-center gap-3">
              {variant === 'count' ? (
                <span className="font-medium text-card-foreground tabular-nums">
                  {b.count} {b.count === 1 ? 'acct' : 'accts'}
                </span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">{b.count} accts</span>
                  <span className="font-medium text-card-foreground tabular-nums">
                    {formatCurrency(Math.round(b.amount), currency)}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
