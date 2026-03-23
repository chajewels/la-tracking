import { Clock, CalendarCheck, AlertTriangle, Gavel, Scale, MessageCircle, Eye, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { todayStr, categorizeByDueDate, remainingDue, alertTypeConfig } from '@/lib/business-rules';

interface OperationsPanelProps {
  summary: any;
  displayCurrency: Currency;
}

export default function OperationsPanel({ summary, displayCurrency }: OperationsPanelProps) {
  const { data: actionItems } = useQuery({
    queryKey: ['operations-action-items'],
    queryFn: async () => {
      const next7 = new Date();
      next7.setDate(next7.getDate() + 7);
      const next7Str = next7.toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(*, customers(*))')
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .in('layaway_accounts.status', ['active', 'overdue'])
        .lte('due_date', next7Str)
        .order('due_date', { ascending: true })
        .limit(10);
      if (error) throw error;
      return data;
    },
  });

  const today = todayStr();
  const items = actionItems || [];

  const overdueItems = items.filter(i => i.due_date < today);
  const dueTodayItems = items.filter(i => i.due_date === today);
  const upcomingItems = items.filter(i => i.due_date > today);

  const cards = [
    { label: 'Due in 7 Days', count: summary?.due_7_days_count ?? 0, icon: Calendar, color: 'text-primary', bg: 'bg-primary/10', link: '/monitoring?filter=due_7_days' },
    { label: 'Due in 3 Days', count: summary?.due_3_days_count ?? 0, icon: CalendarCheck, color: 'text-info', bg: 'bg-info/10', link: '/monitoring?filter=due_3_days' },
    { label: 'Due Today', count: summary?.due_today_count ?? 0, icon: Clock, color: 'text-warning', bg: 'bg-warning/10', link: '/monitoring?filter=due_today' },
    { label: 'Overdue', count: summary?.overdue_accounts ?? 0, icon: AlertTriangle, color: 'text-destructive', bg: 'bg-destructive/10', link: '/monitoring?filter=overdue' },
    { label: 'Penalties Today', count: summary?.penalties_today_count ?? 0, icon: Gavel, color: 'text-primary', bg: 'bg-primary/10', link: '/monitoring?filter=overdue' },
    { label: 'Waivers Pending', count: summary?.pending_waivers_count ?? 0, icon: Scale, color: 'text-warning', bg: 'bg-warning/10', link: '/waivers' },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-4">
      <h3 className="text-sm font-semibold text-card-foreground">Operations Center</h3>

      {/* Quick stat pills */}
      <div className="flex flex-wrap gap-2">
        {cards.map(c => (
          <Link key={c.label} to={c.link}>
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${c.bg}`}>
              <c.icon className={`h-3.5 w-3.5 ${c.color}`} />
              <span className={`text-xs font-semibold ${c.color}`}>{c.count}</span>
              <span className="text-xs text-muted-foreground">{c.label}</span>
            </div>
          </Link>
        ))}
      </div>

      {/* Action items */}
      {items.length > 0 && (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {[...overdueItems, ...dueTodayItems, ...upcomingItems].slice(0, 8).map((item: any) => {
            const acc = item.layaway_accounts;
            const cust = acc?.customers;
            const type = categorizeByDueDate(item.due_date);
            const config = alertTypeConfig[type];
            const remaining = remainingDue(item);

            return (
              <div key={item.id} className={`flex items-center justify-between p-3 rounded-lg border ${config.borderClass}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-card-foreground truncate">{cust?.full_name || 'Unknown'}</p>
                    <Badge variant="outline" className={`text-[10px] ${config.badgeClass}`}>
                      {config.label}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    INV #{acc?.invoice_number} · {formatCurrency(remaining, item.currency as Currency)} · Due {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <div className="flex gap-1 ml-2">
                  {cust?.messenger_link && (
                    <a href={cust.messenger_link} target="_blank" rel="noopener noreferrer">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-info" title="Open Messenger">
                        <MessageCircle className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  )}
                  <Link to={`/accounts/${acc?.id}`}>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" title="View Account">
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
