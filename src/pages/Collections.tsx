import { Activity, TrendingUp } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import { mockPayments, mockAccounts } from '@/lib/mock-data';
import { formatCurrency } from '@/lib/calculations';

export default function Collections() {
  const sorted = [...mockPayments].sort((a, b) =>
    new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()
  );

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Activity className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Live Collections</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Real-time payment tracking</p>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard title="Today" value="₱ 0" icon={TrendingUp} variant="gold" />
          <StatCard title="Yesterday" value="₱ 9,723" icon={TrendingUp} />
          <StatCard title="This Week" value="₱ 9,723" icon={TrendingUp} />
          <StatCard title="This Month" value="₱ 34,716" icon={TrendingUp} variant="success" />
          <StatCard title="This Year" value="₱ 125,049" icon={TrendingUp} />
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
                <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">CSR</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(p => {
                const account = mockAccounts.find(a => a.id === p.account_id);
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
