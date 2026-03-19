import { useState, useMemo } from 'react';
import { DollarSign, FileText, AlertTriangle, TrendingUp, Sparkles, ShieldAlert, Globe, MapPin } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import RecentPayments from '@/components/dashboard/RecentPayments';
import OverdueAlerts from '@/components/dashboard/OverdueAlerts';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import RiskBadge from '@/components/dashboard/RiskBadge';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { Link } from 'react-router-dom';
import { useAccounts, useCustomers, useDashboardSummary } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';

export default function Dashboard() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(currencyFilter);
  const { data: accounts } = useAccounts();
  const { data: customers } = useCustomers();

  const activeAccounts = (accounts || []).filter(a => a.status === 'active' || a.status === 'overdue');

  // Build geo breakdown: Japan vs International (by country)
  const geoBreakdown = useMemo(() => {
    const customerMap = new Map((customers || []).map(c => [c.id, c]));
    const active = (accounts || []).filter(a => a.status === 'active' || a.status === 'overdue');

    let japanCount = 0, japanAmount = 0;
    const intlMap: Record<string, { count: number; amount: number }> = {};

    for (const acc of active) {
      const cust = customerMap.get(acc.customer_id);
      const loc = (cust?.location || '').trim();
      const balance = Number(acc.remaining_balance);

      if (!loc || loc.toLowerCase() === 'japan') {
        japanCount++;
        japanAmount += balance;
      } else {
        const country = loc;
        if (!intlMap[country]) intlMap[country] = { count: 0, amount: 0 };
        intlMap[country].count++;
        intlMap[country].amount += balance;
      }
    }

    const international = Object.entries(intlMap)
      .map(([country, data]) => ({ country, ...data }))
      .sort((a, b) => b.amount - a.amount);

    const intlTotal = international.reduce((s, i) => ({ count: s.count + i.count, amount: s.amount + i.amount }), { count: 0, amount: 0 });

    return { japan: { count: japanCount, amount: japanAmount }, international, intlTotal };
  }, [accounts, customers]);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Overview</p>
            <h1 className="text-2xl font-bold text-foreground font-display">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Cha Jewels · Layaway Payment Management</p>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {summaryLoading ? (
            <>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </>
          ) : (
            <>
              <StatCard
                title="Total Receivables"
                value={formatCurrency(summary?.total_receivables ?? 0, displayCurrency)}
                icon={DollarSign}
                variant="gold"
              />
              <StatCard
                title="Active Accounts"
                value={(summary?.active_layaways ?? 0).toString()}
                subtitle={currencyFilter === 'ALL' ? 'PHP & JPY (in ¥)' : `${currencyFilter} only`}
                icon={FileText}
              />
              <StatCard
                title="Collections Today"
                value={formatCurrency(summary?.payments_today ?? 0, displayCurrency)}
                icon={TrendingUp}
                variant="success"
              />
              <StatCard
                title="Overdue"
                value={(summary?.overdue_accounts ?? 0).toString()}
                subtitle="Requires attention"
                icon={AlertTriangle}
                variant="danger"
              />
            </>
          )}
        </div>

        {/* Geo Breakdown Widget */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Japan */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <MapPin className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold text-card-foreground">Japan</h3>
            </div>
            <div className="flex items-baseline justify-between">
              <div>
                <p className="text-2xl font-bold text-card-foreground font-display">{geoBreakdown.japan.count}</p>
                <p className="text-xs text-muted-foreground">active accounts</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-card-foreground tabular-nums">
                  {formatCurrency(geoBreakdown.japan.amount, 'JPY')}
                </p>
                <p className="text-xs text-muted-foreground">outstanding</p>
              </div>
            </div>
          </div>

          {/* International */}
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Globe className="h-4 w-4 text-info" />
              <h3 className="text-sm font-semibold text-card-foreground">International</h3>
              <span className="ml-auto text-xs text-muted-foreground">{geoBreakdown.international.length} countries</span>
            </div>
            <div className="flex items-baseline justify-between mb-3">
              <div>
                <p className="text-2xl font-bold text-card-foreground font-display">{geoBreakdown.intlTotal.count}</p>
                <p className="text-xs text-muted-foreground">active accounts</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-card-foreground tabular-nums">
                  {formatCurrency(geoBreakdown.intlTotal.amount, 'PHP')}
                </p>
                <p className="text-xs text-muted-foreground">outstanding</p>
              </div>
            </div>
            {geoBreakdown.international.length > 0 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                {geoBreakdown.international.map(item => (
                  <div key={item.country} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{item.country}</span>
                    <span className="text-card-foreground font-medium tabular-nums">{item.count} acct · {formatCurrency(item.amount, 'PHP')}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Active Accounts Quick View */}
        {activeAccounts.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-primary" />
                Active Layaway Accounts
              </h3>
              <Link to="/accounts" className="text-xs text-primary hover:underline">View all →</Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {activeAccounts.slice(0, 6).map(account => {
                if (currencyFilter !== 'ALL' && account.currency !== currencyFilter) return null;
                return (
                  <Link key={account.id} to={`/accounts/${account.id}`}>
                    <div className="p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-card-foreground">{account.customers?.full_name}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">INV #{account.invoice_number}</p>
                      <p className="text-xs font-semibold text-card-foreground mt-1">
                        {formatCurrency(Number(account.remaining_balance), account.currency as Currency)}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <RecentPayments currencyFilter={currencyFilter} />
          </div>
          <div className="space-y-6">
            <AgingBuckets currency={displayCurrency} />
            <OverdueAlerts />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}