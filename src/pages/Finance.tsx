import { DollarSign, TrendingUp, BarChart3 } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import { formatCurrency } from '@/lib/calculations';

const forecastData = [
  { month: 'Apr 2025', expected: 58238, currency: 'PHP' as const },
  { month: 'May 2025', expected: 48519, currency: 'PHP' as const },
  { month: 'Jun 2025', expected: 38800, currency: 'PHP' as const },
  { month: 'Jul 2025', expected: 29081, currency: 'PHP' as const },
  { month: 'Aug 2025', expected: 20000, currency: 'PHP' as const },
  { month: 'Sep 2025', expected: 9719, currency: 'PHP' as const },
];

export default function Finance() {
  const maxForecast = Math.max(...forecastData.map(d => d.expected));

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <DollarSign className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Finance Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Receivables and cashflow intelligence</p>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Total Receivables" value="₱ 188,233" icon={DollarSign} variant="gold" />
          <StatCard title="Overdue Balance" value="₱ 29,638" icon={TrendingUp} variant="danger" />
          <StatCard title="Collections This Week" value="₱ 9,723" icon={TrendingUp} variant="success" />
          <StatCard title="Collections This Month" value="₱ 34,716" icon={BarChart3} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <AgingBuckets currency="PHP" />

          {/* 6-Month Forecast */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">6-Month Cashflow Forecast</h3>
            <div className="space-y-3">
              {forecastData.map((d) => (
                <div key={d.month} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{d.month}</span>
                    <span className="font-medium text-card-foreground tabular-nums">
                      {formatCurrency(d.expected, d.currency)}
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full gold-gradient rounded-full transition-all"
                      style={{ width: `${(d.expected / maxForecast) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
