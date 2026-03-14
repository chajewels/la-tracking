import { AlertTriangle, MessageCircle, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/calculations';
import { Link } from 'react-router-dom';

const overdueItems = [
  { customer: 'Ana Reyes', invoice: '19102', dueDate: '2025-02-20', amount: 9880, currency: 'PHP' as const, daysOverdue: 22 },
  { customer: 'Ken Watanabe', invoice: '18900', dueDate: '2025-03-15', amount: 20000, currency: 'JPY' as const, daysOverdue: 0 },
];

export default function OverdueAlerts() {
  return (
    <div className="rounded-xl border border-destructive/20 bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <h3 className="text-sm font-semibold text-card-foreground">Overdue & Due Soon</h3>
      </div>
      <div className="space-y-3">
        {overdueItems.map((item) => (
          <div key={item.invoice} className="flex items-center justify-between p-3 rounded-lg bg-destructive/5 border border-destructive/10">
            <div>
              <p className="text-sm font-medium text-card-foreground">{item.customer}</p>
              <p className="text-xs text-muted-foreground">INV #{item.invoice} · Due {new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
              <p className="text-xs font-medium text-destructive mt-0.5">
                {item.daysOverdue > 0 ? `${item.daysOverdue} days overdue` : 'Due today'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-card-foreground tabular-nums">
                {formatCurrency(item.amount, item.currency)}
              </span>
              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                <MessageCircle className="h-4 w-4" />
              </Button>
              <Link to={`/accounts/${item.invoice}`}>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                  <Eye className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
