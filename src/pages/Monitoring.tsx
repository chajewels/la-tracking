import { useMemo } from 'react';
import { Bell, MessageCircle, Eye, Clock, AlertTriangle, CalendarCheck } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Link } from 'react-router-dom';
import { useAccounts, useSchedule } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Currency } from '@/lib/types';

const typeConfig = {
  overdue: { icon: AlertTriangle, label: 'Overdue', badgeClass: 'bg-destructive/10 text-destructive border-destructive/20', borderClass: 'border-destructive/20' },
  due_today: { icon: Clock, label: 'Due Today', badgeClass: 'bg-warning/10 text-warning border-warning/20', borderClass: 'border-warning/20' },
  upcoming: { icon: CalendarCheck, label: 'Upcoming', badgeClass: 'bg-info/10 text-info border-info/20', borderClass: 'border-border' },
};

interface AlertItem {
  type: 'overdue' | 'due_today' | 'upcoming';
  customer: string;
  invoice: string;
  dueDate: string;
  amount: number;
  currency: Currency;
  daysOverdue: number;
  accountId: string;
  messengerLink?: string | null;
}

export default function Monitoring() {
  const { data: accounts, isLoading: acctLoading } = useAccounts();

  // Get all upcoming/overdue schedule items for active accounts
  const activeAccountIds = useMemo(() =>
    (accounts || []).filter(a => a.status === 'active' || a.status === 'overdue').map(a => a.id),
    [accounts]
  );

  const { data: scheduleItems, isLoading: schedLoading } = useQuery({
    queryKey: ['monitoring-schedules', activeAccountIds],
    enabled: activeAccountIds.length > 0,
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const next7 = new Date();
      next7.setDate(next7.getDate() + 7);
      const next7Str = next7.toISOString().split('T')[0];

      // Get overdue + upcoming 7 days
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*')
        .in('account_id', activeAccountIds)
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .lte('due_date', next7Str)
        .order('due_date', { ascending: true });
      if (error) throw error;
      return data;
    },
  });

  const alerts: AlertItem[] = useMemo(() => {
    if (!scheduleItems || !accounts) return [];
    const accountMap = new Map((accounts || []).map(a => [a.id, a]));
    const today = new Date().toISOString().split('T')[0];

    return scheduleItems.map(s => {
      const acc = accountMap.get(s.account_id);
      if (!acc) return null;
      const dueDate = s.due_date;
      const diffMs = new Date(today).getTime() - new Date(dueDate).getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

      let type: AlertItem['type'] = 'upcoming';
      if (diffDays > 0) type = 'overdue';
      else if (diffDays === 0) type = 'due_today';

      return {
        type,
        customer: acc.customers?.full_name || 'Unknown',
        invoice: acc.invoice_number,
        dueDate,
        amount: Number(s.total_due_amount) - Number(s.paid_amount),
        currency: acc.currency as Currency,
        daysOverdue: diffDays,
        accountId: acc.id,
        messengerLink: acc.customers?.messenger_link,
      } as AlertItem;
    }).filter(Boolean) as AlertItem[];
  }, [scheduleItems, accounts]);

  // Sort: overdue first, then due_today, then upcoming
  const sortedAlerts = useMemo(() => {
    const order = { overdue: 0, due_today: 1, upcoming: 2 };
    return [...alerts].sort((a, b) => order[a.type] - order[b.type] || b.daysOverdue - a.daysOverdue);
  }, [alerts]);

  const isLoading = acctLoading || schedLoading;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">CSR Monitoring Center</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Payment alerts & reminders</p>
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Overdue', count: sortedAlerts.filter(a => a.type === 'overdue').length, color: 'text-destructive' },
            { label: 'Due Today', count: sortedAlerts.filter(a => a.type === 'due_today').length, color: 'text-warning' },
            { label: 'Upcoming (7 days)', count: sortedAlerts.filter(a => a.type === 'upcoming').length, color: 'text-info' },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-4 text-center">
              <p className={`text-3xl font-bold font-display ${s.color}`}>{isLoading ? '—' : s.count}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Alert List */}
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
        ) : sortedAlerts.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">No upcoming or overdue payments in the next 7 days.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {sortedAlerts.map((alert, idx) => {
              const config = typeConfig[alert.type];
              const Icon = config.icon;
              return (
                <Link key={`${alert.accountId}-${alert.dueDate}-${idx}`} to={`/accounts/${alert.accountId}`} className={`block rounded-xl border bg-card p-4 ${config.borderClass} hover:bg-muted/30 transition-colors cursor-pointer`}>
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
                        <div className="flex items-center gap-2 flex-wrap">
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
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        {alert.messengerLink && (
                          <a href={alert.messengerLink} target="_blank" rel="noopener noreferrer" onClick={e => e.preventDefault()}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info" onClick={(e) => { e.stopPropagation(); window.open(alert.messengerLink!, '_blank'); }}>
                              <MessageCircle className="h-4 w-4" />
                            </Button>
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
