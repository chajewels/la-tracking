import { useState } from 'react';
import { Activity, TrendingUp } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { mockPayments, mockAccounts } from '@/lib/mock-data';
import { formatCurrency } from '@/lib/calculations';
import { toJpy, getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { Currency } from '@/lib/types';

export default function Collections() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const currency = currencyFilter === 'ALL' ? undefined : currencyFilter;
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const filtered = [...mockPayments]
    .filter(p => !currency || p.currency === currency)
    .sort((a, b) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime());

  // Compute stat totals with conversion
  const now = new Date();
  const todayTotal = filtered
    .filter(p => new Date(p.payment_date).toDateString() === now.toDateString())
    .reduce((s, p) => s + (isAllMode ? toJpy(p.amount, p.currency) : p.amount), 0);

  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayTotal = filtered
    .filter(p => new Date(p.payment_date).toDateString() === yesterdayDate.toDateString())
    .reduce((s, p) => s + (isAllMode ? toJpy(p.amount, p.currency) : p.amount), 0);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const weekTotal = filtered
    .filter(p => new Date(p.payment_date) >= startOfWeek)
    .reduce((s, p) => s + (isAllMode ? toJpy(p.amount, p.currency) : p.amount), 0);

  const monthTotal = filtered
    .filter(p => {
      const d = new Date(p.payment_date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, p) => s + (isAllMode ? toJpy(p.amount, p.currency) : p.amount), 0);

  const yearTotal = filtered
    .filter(p => new Date(p.payment_date).getFullYear() === now.getFullYear())
    .reduce((s, p) => s + (isAllMode ? toJpy(p.amount, p.currency) : p.amount), 0);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Live Collections</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Real-time payment tracking</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard title="Today" value={formatCurrency(todayTotal, displayCurrency)} icon={TrendingUp} variant="gold" />
          <StatCard title="Yesterday" value={formatCurrency(yesterdayTotal, displayCurrency)} icon={TrendingUp} />
          <StatCard title="This Week" value={formatCurrency(weekTotal, displayCurrency)} icon={TrendingUp} />
          <StatCard title="This Month" value={formatCurrency(monthTotal, displayCurrency)} icon={TrendingUp} variant="success" />
          <StatCard title="This Year" value={formatCurrency(yearTotal, displayCurrency)} icon={TrendingUp} />
        </div>

        {/* Live Feed */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-muted/30">
            <h3 className="text-sm font-semibold text-card-foreground">Payment Feed</h3>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Date</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
                <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Amount</th>
                {isAllMode && (
                  <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">JPY Equiv.</th>
                )}
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">CSR</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const account = mockAccounts.find(a => a.id === p.account_id);
                const jpyEquiv = toJpy(p.amount, p.currency);
                return (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-5 py-3 text-sm text-muted-foreground">
                      {new Date(p.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-5 py-3 text-sm font-medium text-card-foreground">{account?.customer.name}</td>
                    <td className="px-5 py-3 text-sm text-muted-foreground">#{account?.invoice_number}</td>
                    <td className="px-5 py-3 text-sm font-semibold text-success text-right tabular-nums">
                      +{formatCurrency(p.amount, p.currency)}
                    </td>
                    {isAllMode && (
                      <td className="px-5 py-3 text-sm text-right tabular-nums text-muted-foreground">
                        {p.currency === 'PHP' ? (
                          <span>¥ {jpyEquiv.toLocaleString()}</span>
                        ) : (
                          <span className="text-card-foreground font-medium">¥ {p.amount.toLocaleString()}</span>
                        )}
                      </td>
                    )}
                    <td className="px-5 py-3 text-sm text-muted-foreground">{p.recorded_by}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
