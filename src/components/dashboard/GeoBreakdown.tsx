import { useMemo, useState } from 'react';
import { Globe, ChevronDown, ChevronRight } from 'lucide-react';
import { formatCurrency } from '@/lib/calculations';
import { AccountWithCustomer } from '@/hooks/use-supabase-data';
import { DbCustomer } from '@/hooks/use-supabase-data';
import { Currency } from '@/lib/types';
import { getContinent, CONTINENT_ORDER, CONTINENT_ICONS } from '@/lib/continent-mapping';
import { cn } from '@/lib/utils';

interface GeoBreakdownProps {
  accounts: AccountWithCustomer[];
  customers: DbCustomer[];
}

interface CountryData {
  country: string;
  count: number;
  amountPHP: number;
  amountJPY: number;
}

interface ContinentData {
  continent: string;
  count: number;
  amountPHP: number;
  amountJPY: number;
  countries: CountryData[];
}

export default function GeoBreakdown({ accounts, customers }: GeoBreakdownProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const continents = useMemo(() => {
    const customerMap = new Map(customers.map(c => [c.id, c]));
    const active = accounts.filter(a => a.status === 'active' || a.status === 'overdue');

    const map: Record<string, Record<string, { count: number; amountPHP: number; amountJPY: number }>> = {};

    for (const acc of active) {
      const cust = customerMap.get(acc.customer_id);
      const loc = (cust?.location || '').trim();
      const continent = getContinent(loc);
      const country = !loc ? 'Japan' : loc;
      const balance = Number(acc.remaining_balance);
      const cur = acc.currency as Currency;

      if (!map[continent]) map[continent] = {};
      if (!map[continent][country]) map[continent][country] = { count: 0, amountPHP: 0, amountJPY: 0 };
      map[continent][country].count++;
      if (cur === 'JPY') {
        map[continent][country].amountJPY += balance;
      } else {
        map[continent][country].amountPHP += balance;
      }
    }

    const result: ContinentData[] = [];
    for (const continent of CONTINENT_ORDER) {
      const countryMap = map[continent];
      if (!countryMap) continue;

      const countries = Object.entries(countryMap)
        .map(([country, data]) => ({ country, ...data }))
        .sort((a, b) => (b.amountPHP + b.amountJPY) - (a.amountPHP + a.amountJPY));

      const totals = countries.reduce(
        (s, c) => ({ count: s.count + c.count, amountPHP: s.amountPHP + c.amountPHP, amountJPY: s.amountJPY + c.amountJPY }),
        { count: 0, amountPHP: 0, amountJPY: 0 }
      );

      result.push({ continent, ...totals, countries });
    }

    return result;
  }, [accounts, customers]);

  const formatAmount = (php: number, jpy: number) => {
    const parts: string[] = [];
    if (php > 0) parts.push(formatCurrency(php, 'PHP'));
    if (jpy > 0) parts.push(formatCurrency(jpy, 'JPY'));
    return parts.length > 0 ? parts.join(' · ') : '₱ 0';
  };

  const toggle = (continent: string) => {
    setExpanded(prev => prev === continent ? null : continent);
  };

  if (continents.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <Globe className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No active accounts to display</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {continents.map((cont) => {
        const isOpen = expanded === cont.continent;
        const icon = CONTINENT_ICONS[cont.continent] || '🌐';

        return (
          <div
            key={cont.continent}
            className={cn(
              "rounded-xl border bg-card transition-all duration-300 overflow-hidden",
              isOpen
                ? "border-primary/30 shadow-md sm:col-span-2 lg:col-span-3"
                : "border-border hover:border-primary/20 hover:shadow-sm cursor-pointer"
            )}
          >
            {/* Continent Header */}
            <button
              onClick={() => toggle(cont.continent)}
              className="w-full flex items-center gap-3 p-4 text-left transition-colors hover:bg-muted/30"
            >
              <span className="text-xl leading-none">{icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-card-foreground truncate">
                    {cont.continent}
                  </h3>
                  <span className="shrink-0 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {cont.countries.length} {cont.countries.length === 1 ? 'country' : 'countries'}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {cont.count} active {cont.count === 1 ? 'account' : 'accounts'}
                </p>
              </div>
              <div className="text-right shrink-0">
                <div className="space-y-0.5">
                  {cont.amountJPY > 0 && (
                    <p className="text-sm font-semibold text-card-foreground tabular-nums">
                      {formatCurrency(cont.amountJPY, 'JPY')}
                    </p>
                  )}
                  {cont.amountPHP > 0 && (
                    <p className="text-sm font-semibold text-card-foreground tabular-nums">
                      {formatCurrency(cont.amountPHP, 'PHP')}
                    </p>
                  )}
                  {cont.amountPHP === 0 && cont.amountJPY === 0 && (
                    <p className="text-sm font-semibold text-card-foreground tabular-nums">₱ 0</p>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground">outstanding</p>
              </div>
              <div className="shrink-0 ml-1">
                {isOpen
                  ? <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
                }
              </div>
            </button>

            {/* Country Drilldown */}
            {isOpen && (
              <div className="border-t border-border px-4 pb-4 pt-3 animate-fade-in">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {cont.countries.map((c) => (
                    <div
                      key={c.country}
                      className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-card-foreground truncate">{c.country}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {c.count} {c.count === 1 ? 'account' : 'accounts'}
                        </p>
                      </div>
                      <p className="text-xs font-semibold text-card-foreground tabular-nums shrink-0 ml-3">
                        {formatAmount(c.amountPHP, c.amountJPY)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
