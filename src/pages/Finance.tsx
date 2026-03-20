import { useState, useMemo } from 'react';
import { DollarSign, TrendingUp, BarChart3, Sparkles, CalendarClock } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { useAccounts, useDashboardSummary } from '@/hooks/use-supabase-data';
import { useAuth } from '@/contexts/AuthContext';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';

export default function Finance() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const { session, loading: authLoading } = useAuth();
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );
  const { data: accounts } = useAccounts();

  const forecastData = summary?.forecast_6_months || [];
  const maxForecast = Math.max(...forecastData.map(d => d.expected), 1);

  // Recent completed accounts (this month)
  const recentCompleted = useMemo(() => {
    if (!accounts) return [];
    const now = new Date();
    return accounts
      .filter(a => a.status === 'completed')
      .filter(a => {
        const updated = new Date(a.updated_at);
        return updated.getMonth() === now.getMonth() && updated.getFullYear() === now.getFullYear();
      })
      .slice(0, 5);
  }, [accounts]);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Finance Dashboard</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Receivables and cashflow intelligence · Live data</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {summaryLoading ? (
            [...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : (
            <>
              <StatCard
                title="Total Receivables"
                value={formatCurrency(summary?.total_receivables ?? 0, displayCurrency)}
                icon={DollarSign}
                variant="gold"
              />
              <StatCard
                title="Expected Next Month"
                value={formatCurrency(summary?.next_month_adjusted ?? 0, displayCurrency)}
                subtitle={`of ${formatCurrency(summary?.next_month_expected ?? 0, displayCurrency)} due`}
                icon={Sparkles}
                variant="gold"
              />
              <StatCard
                title="Predicted (30d)"
                value={formatCurrency(summary?.predicted_30d ?? 0, displayCurrency)}
                subtitle={`of ${formatCurrency(summary?.predicted_30d_raw ?? 0, displayCurrency)} due`}
                icon={TrendingUp}
                variant="success"
              />
              <StatCard
                title="Predicted (90d)"
                value={formatCurrency(summary?.predicted_90d ?? 0, displayCurrency)}
                subtitle={`of ${formatCurrency(summary?.predicted_90d_raw ?? 0, displayCurrency)} due`}
                icon={TrendingUp}
              />
              <StatCard
                title="Collections This Month"
                value={formatCurrency(summary?.collections_this_month ?? 0, displayCurrency)}
                icon={BarChart3}
                variant="success"
              />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AgingBuckets currency={displayCurrency} />

          {/* 6-Month Forecast */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              6-Month Cashflow Forecast
            </h3>
            {summaryLoading || forecastData.length === 0 ? (
              <div className="flex items-center justify-center h-40">
                <Skeleton className="h-full w-full rounded-lg" />
              </div>
            ) : (
              <div className="space-y-3">
                {forecastData.map((d) => (
                  <div key={d.month} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{d.month}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground tabular-nums">
                          Adj: {formatCurrency(d.adjusted, displayCurrency)}
                        </span>
                        <span className="font-medium text-card-foreground tabular-nums">
                          {formatCurrency(d.expected, displayCurrency)}
                        </span>
                      </div>
                    </div>
                    <div className="relative h-2.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="absolute h-full bg-primary/20 rounded-full transition-all"
                        style={{ width: `${(d.expected / maxForecast) * 100}%` }}
                      />
                      <div
                        className="absolute h-full gold-gradient rounded-full transition-all"
                        style={{ width: `${(d.adjusted / maxForecast) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-2 rounded-full gold-gradient" /> Risk-Adjusted (85%)
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-2 rounded-full bg-primary/20" /> Expected (due)
              </div>
            </div>
          </div>
        </div>

        {/* Recent Completed */}
        {recentCompleted.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-3">Completed This Month</h3>
            <div className="space-y-2">
              {recentCompleted.map(a => (
                <Link key={a.id} to={`/accounts/${a.id}`}
                  className="flex items-center justify-between p-2.5 rounded-lg border border-border hover:border-primary/30 transition-colors">
                  <div>
                    <p className="text-xs font-medium text-card-foreground">INV #{a.invoice_number}</p>
                    <p className="text-[10px] text-muted-foreground">{a.customers?.full_name}</p>
                  </div>
                  <p className="text-xs font-semibold text-success tabular-nums">
                    {formatCurrency(Number(a.total_amount), a.currency as Currency)}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
