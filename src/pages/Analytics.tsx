import { BarChart3, Users, Target, TrendingUp } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import { Badge } from '@/components/ui/badge';

const csrPerformance = [
  { name: 'CSR Alice', collections: 97049, accounts: 4, reminders: 12, recoveries: 2 },
  { name: 'CSR Bob', collections: 62134, accounts: 3, reminders: 8, recoveries: 1 },
];

const completionPredictions = [
  { customer: 'Maria Santos', invoice: '18351', probability: 'high', progress: 42 },
  { customer: 'Ken Watanabe', invoice: '18900', probability: 'high', progress: 50 },
  { customer: 'Yuki Tanaka', invoice: '19001', probability: 'medium', progress: 33 },
  { customer: 'LA JUN', invoice: '17833', probability: 'medium', progress: 30 },
  { customer: 'Ana Reyes', invoice: '19102', probability: 'low', progress: 0 },
];

const probStyles = {
  high: 'bg-success/10 text-success border-success/20',
  medium: 'bg-warning/10 text-warning border-warning/20',
  low: 'bg-destructive/10 text-destructive border-destructive/20',
};

export default function Analytics() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Analytics & Intelligence</h1>
            <p className="text-sm text-muted-foreground mt-0.5">CSR performance and predictive insights</p>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Predicted Revenue (30d)" value="₱ 58,238" icon={TrendingUp} variant="gold" />
          <StatCard title="Predicted Revenue (90d)" value="₱ 145,557" icon={TrendingUp} />
          <StatCard title="Completion Rate" value="85%" icon={Target} variant="success" />
          <StatCard title="Avg Days to Pay" value="2.3" subtitle="days after due" icon={Users} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* CSR Performance */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">CSR Performance</h3>
            <div className="space-y-4">
              {csrPerformance.map((csr, i) => (
                <div key={csr.name} className="p-4 rounded-lg border border-border">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                        i === 0 ? 'gold-gradient text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}>
                        #{i + 1}
                      </div>
                      <p className="text-sm font-semibold text-card-foreground">{csr.name}</p>
                    </div>
                    {i === 0 && <Badge className="gold-gradient text-primary-foreground text-[10px] border-0">Top Collector</Badge>}
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {[
                      { label: 'Collections', value: `₱ ${csr.collections.toLocaleString()}` },
                      { label: 'Accounts', value: csr.accounts },
                      { label: 'Reminders', value: csr.reminders },
                      { label: 'Recoveries', value: csr.recoveries },
                    ].map(m => (
                      <div key={m.label}>
                        <p className="text-xs text-muted-foreground">{m.label}</p>
                        <p className="text-sm font-bold text-card-foreground">{m.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Completion Predictions */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">Layaway Completion Prediction</h3>
            <div className="space-y-3">
              {completionPredictions.map(p => (
                <div key={p.invoice} className="flex items-center justify-between p-3 rounded-lg border border-border">
                  <div>
                    <p className="text-sm font-medium text-card-foreground">{p.customer}</p>
                    <p className="text-xs text-muted-foreground">INV #{p.invoice}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-20">
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full gold-gradient rounded-full" style={{ width: `${p.progress}%` }} />
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-[10px] ${probStyles[p.probability as keyof typeof probStyles]}`}>
                      {p.probability}
                    </Badge>
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
