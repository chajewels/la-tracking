import { useMemo } from 'react';
import { MapPin, Globe } from 'lucide-react';
import { formatCurrency } from '@/lib/calculations';
import { AccountWithCustomer } from '@/hooks/use-supabase-data';
import { DbCustomer } from '@/hooks/use-supabase-data';
import { Currency } from '@/lib/types';

interface GeoBreakdownProps {
  accounts: AccountWithCustomer[];
  customers: DbCustomer[];
}

export default function GeoBreakdown({ accounts, customers }: GeoBreakdownProps) {
  const PRIMARY_MARKETS = ['japan', 'philippines', 'united states', 'canada', 'australia'];

  const geo = useMemo(() => {
    const customerMap = new Map(customers.map(c => [c.id, c]));
    const active = accounts.filter(a => a.status === 'active' || a.status === 'overdue');

    const primaryMap: Record<string, { count: number; amountPHP: number; amountJPY: number }> = {};
    const intlMap: Record<string, { count: number; amountPHP: number; amountJPY: number }> = {};

    for (const acc of active) {
      const cust = customerMap.get(acc.customer_id);
      const loc = (cust?.location || '').trim();
      const locLower = loc.toLowerCase();
      const balance = Number(acc.remaining_balance);
      const cur = acc.currency as Currency;

      const isPrimary = !loc || PRIMARY_MARKETS.includes(locLower);
      const label = !loc ? 'Japan' : loc;
      const targetMap = isPrimary ? primaryMap : intlMap;

      if (!targetMap[label]) targetMap[label] = { count: 0, amountPHP: 0, amountJPY: 0 };
      targetMap[label].count++;
      if (cur === 'JPY') {
        targetMap[label].amountJPY += balance;
      } else {
        targetMap[label].amountPHP += balance;
      }
    }

    const toSorted = (map: typeof primaryMap) =>
      Object.entries(map)
        .map(([country, data]) => ({ country, ...data }))
        .sort((a, b) => (b.amountPHP + b.amountJPY) - (a.amountPHP + a.amountJPY));

    const primary = toSorted(primaryMap);
    const international = toSorted(intlMap);

    const sumGroup = (arr: typeof primary) =>
      arr.reduce(
        (s, i) => ({ count: s.count + i.count, amountPHP: s.amountPHP + i.amountPHP, amountJPY: s.amountJPY + i.amountJPY }),
        { count: 0, amountPHP: 0, amountJPY: 0 }
      );

    return { primary, primaryTotal: sumGroup(primary), international, intlTotal: sumGroup(international) };
  }, [accounts, customers]);

  const formatIntlAmount = (php: number, jpy: number) => {
    const parts: string[] = [];
    if (php > 0) parts.push(formatCurrency(php, 'PHP'));
    if (jpy > 0) parts.push(formatCurrency(jpy, 'JPY'));
    return parts.length > 0 ? parts.join(' · ') : '₱ 0';
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <MapPin className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-card-foreground">Japan</h3>
        </div>
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-2xl font-bold text-card-foreground font-display">{geo.japan.count}</p>
            <p className="text-xs text-muted-foreground">active accounts</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-card-foreground tabular-nums">
              {formatCurrency(geo.japan.amount, 'JPY')}
            </p>
            <p className="text-xs text-muted-foreground">outstanding</p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Globe className="h-4 w-4 text-info" />
          <h3 className="text-sm font-semibold text-card-foreground">International</h3>
          <span className="ml-auto text-xs text-muted-foreground">{geo.international.length} countries</span>
        </div>
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <p className="text-2xl font-bold text-card-foreground font-display">{geo.intlTotal.count}</p>
            <p className="text-xs text-muted-foreground">active accounts</p>
          </div>
          <div className="text-right space-y-0.5">
            {geo.intlTotal.amountPHP > 0 && (
              <p className="text-sm font-semibold text-card-foreground tabular-nums">
                {formatCurrency(geo.intlTotal.amountPHP, 'PHP')}
              </p>
            )}
            {geo.intlTotal.amountJPY > 0 && (
              <p className="text-sm font-semibold text-card-foreground tabular-nums">
                {formatCurrency(geo.intlTotal.amountJPY, 'JPY')}
              </p>
            )}
            {geo.intlTotal.amountPHP === 0 && geo.intlTotal.amountJPY === 0 && (
              <p className="text-sm font-semibold text-card-foreground tabular-nums">₱ 0</p>
            )}
            <p className="text-xs text-muted-foreground">outstanding</p>
          </div>
        </div>
        {geo.international.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-3">
            {geo.international.map(item => (
              <div key={item.country} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{item.country}</span>
                <span className="text-card-foreground font-medium tabular-nums">
                  {item.count} acct · {formatIntlAmount(item.amountPHP, item.amountJPY)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
