import { useState } from 'react';
import { DollarSign, TrendingUp, BarChart3, Sparkles } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { formatCurrency } from '@/lib/calculations';
import { generateCashflowForecast, getExpectedNextMonthCollection, getPredictedRevenue } from '@/lib/analytics-engine';
import { Currency } from '@/lib/types';
import { getDashboardStats } from '@/lib/mock-data';

export default function Finance() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const currency = currencyFilter === 'ALL' ? undefined : currencyFilter;
  const displayCurrency: Currency = currency || 'PHP';

  const stats = getDashboardStats(currency);
  const forecastData = generateCashflowForecast(currency, 6);
  const nextMonth = getExpectedNextMonthCollection(currency);
  const predicted30 = getPredictedRevenue(30, currency);
  const predicted90 = getPredictedRevenue(90, currency);
  const maxForecast = Math.max(...forecastData.map(d => d.expected), 1);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Finance Dashboard</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Receivables and cashflow intelligence</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard title="Total Receivables" value={formatCurrency(stats.totalReceivables, displayCurrency)} icon={DollarSign} variant="gold" />
          <StatCard title="Expected Next Month" value={formatCurrency(nextMonth.adjusted, displayCurrency)} icon={Sparkles} variant="gold" />
          <StatCard title="Predicted (30d)" value={formatCurrency(predicted30, displayCurrency)} icon={TrendingUp} variant="success" />
          <StatCard title="Predicted (90d)" value={formatCurrency(predicted90, displayCurrency)} icon={TrendingUp} />
          <StatCard title="Collections This Month" value={formatCurrency(stats.collectionsThisMonth, displayCurrency)} icon={BarChart3} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AgingBuckets currency={displayCurrency} />

          {/* 6-Month Forecast */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">6-Month Cashflow Forecast</h3>
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
            <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-2 rounded-full gold-gradient" /> Risk-Adjusted
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <div className="h-2 w-2 rounded-full bg-primary/20" /> Expected
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
