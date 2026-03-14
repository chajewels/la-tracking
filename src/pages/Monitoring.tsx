import { Bell, MessageCircle, Eye, Clock, AlertTriangle, CalendarCheck } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Link } from 'react-router-dom';

const alerts = [
  { type: 'overdue', customer: 'Ana Reyes', invoice: '19102', dueDate: '2025-02-20', amount: 9880, currency: 'PHP' as const, daysOverdue: 22, accountId: 'a4' },
  { type: 'due_today', customer: 'Ken Watanabe', invoice: '18900', dueDate: '2025-03-14', amount: 20000, currency: 'JPY' as const, daysOverdue: 0, accountId: 'a5' },
  { type: 'upcoming', customer: 'Maria Santos', invoice: '18351', dueDate: '2025-03-13', amount: 9719, currency: 'PHP' as const, daysOverdue: -1, accountId: 'a1' },
  { type: 'upcoming', customer: 'LA JUN', invoice: '17833', dueDate: '2025-03-16', amount: 8607, currency: 'JPY' as const, daysOverdue: -2, accountId: 'a2' },
  { type: 'upcoming', customer: 'Yuki Tanaka', invoice: '19001', dueDate: '2025-03-10', amount: 15000, currency: 'JPY' as const, daysOverdue: -4, accountId: 'a3' },
];

const typeConfig = {
  overdue: { icon: AlertTriangle, label: 'Overdue', badgeClass: 'bg-destructive/10 text-destructive border-destructive/20', borderClass: 'border-destructive/20' },
  due_today: { icon: Clock, label: 'Due Today', badgeClass: 'bg-warning/10 text-warning border-warning/20', borderClass: 'border-warning/20' },
  upcoming: { icon: CalendarCheck, label: 'Upcoming', badgeClass: 'bg-info/10 text-info border-info/20', borderClass: 'border-border' },
};

export default function Monitoring() {
  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">CSR Monitoring Center</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Payment alerts and reminders</p>
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Overdue', count: alerts.filter(a => a.type === 'overdue').length, color: 'text-destructive' },
            { label: 'Due Today', count: alerts.filter(a => a.type === 'due_today').length, color: 'text-warning' },
            { label: 'Upcoming (3 days)', count: alerts.filter(a => a.type === 'upcoming').length, color: 'text-info' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-4 text-center">
              <p className={`text-3xl font-bold font-display ${s.color}`}>{s.count}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Alert List */}
        <div className="space-y-3">
          {alerts.map((alert) => {
            const config = typeConfig[alert.type as keyof typeof typeConfig];
            const Icon = config.icon;
            return (
              <div key={alert.invoice} className={`rounded-xl border bg-card p-4 ${config.borderClass}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                      alert.type === 'overdue' ? 'bg-destructive/10' : alert.type === 'due_today' ? 'bg-warning/10' : 'bg-info/10'
                    }`}>
                      <Icon className={`h-5 w-5 ${
                        alert.type === 'overdue' ? 'text-destructive' : alert.type === 'due_today' ? 'text-warning' : 'text-info'
                      }`} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-card-foreground">{alert.customer}</p>
                        <Badge variant="outline" className={`text-[10px] ${config.badgeClass}`}>{config.label}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        INV #{alert.invoice} · Due {new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {alert.daysOverdue > 0 && ` · ${alert.daysOverdue} days overdue`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-card-foreground tabular-nums">
                      {formatCurrency(alert.amount, alert.currency)}
                    </span>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info">
                        <MessageCircle className="h-4 w-4" />
                      </Button>
                      <Link to={`/accounts/${alert.accountId}`}>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AppLayout>
  );
}
