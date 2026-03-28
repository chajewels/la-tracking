import { useState, useMemo } from 'react';
import { Bell, Send, Clock, AlertTriangle, CheckCircle, MessageCircle, RefreshCw, Calendar } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';
import { categorizeScheduleItems, remainingDue, daysOverdueFromToday, alertTypeConfig } from '@/lib/business-rules';

export default function Reminders() {
  const [generating, setGenerating] = useState(false);
  const queryClient = useQueryClient();

  const { data: reminderLogs, isLoading: logsLoading } = useQuery({
    queryKey: ['reminder-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reminder_logs')
        .select('*, customers(full_name, messenger_link), layaway_accounts(invoice_number, currency, remaining_balance)')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const { data: actionableItems } = useQuery({
    queryKey: ['reminder-actionable'],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const in7days = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      // 730-day lookback so all overdue accounts are captured regardless of age,
      // matching the dashboard's overdue definition (no lower-bound cutoff).
      const past730 = new Date(Date.now() - 730 * 86400000).toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(id, status, currency, invoice_number, customer_id, customers(full_name, messenger_link))')
        .in('layaway_accounts.status', ['active', 'overdue', 'final_settlement', 'extension_active'])
        .in('status', ['pending', 'partially_paid', 'overdue'])
        .gte('due_date', past730)
        .lte('due_date', in7days)
        .order('due_date', { ascending: true });
      if (error) throw error;
      return data;
    },
  });

  const sentCount = reminderLogs?.filter(r => r.delivery_status === 'sent').length || 0;

  // Deduplicate by account: keep earliest unpaid row per account so each account
  // counts as one, matching the dashboard's per-account overdue definition.
  const categorized = useMemo(() => {
    if (!actionableItems) return { overdue: [], dueToday: [], upcoming: [] };
    const accountMap = new Map<string, typeof actionableItems[0]>();
    for (const row of actionableItems) {
      if (remainingDue(row) <= 0) continue;
      const acctId = (row as any).account_id as string;
      const existing = accountMap.get(acctId);
      if (!existing || row.due_date < existing.due_date) {
        accountMap.set(acctId, row);
      }
    }
    return categorizeScheduleItems(Array.from(accountMap.values()));
  }, [actionableItems]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-reminders', {
        body: { dry_run: false },
      });
      if (error) throw error;
      toast.success(`Reminders processed: ${data?.sent || 0} sent`);
      queryClient.invalidateQueries({ queryKey: ['reminder-logs'] });
      queryClient.invalidateQueries({ queryKey: ['reminder-actionable'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate reminders');
    } finally {
      setGenerating(false);
    }
  };

  const iconMap = {
    overdue: AlertTriangle,
    due_today: Clock,
    upcoming: Bell,
  };

  const renderScheduleGroup = (items: any[], type: 'overdue' | 'due_today' | 'upcoming') => {
    if (items.length === 0) return null;
    const config = alertTypeConfig[type];
    const Icon = iconMap[type];

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 mb-2">
          <Icon className={`h-4 w-4 ${config.iconColor}`} />
          <h4 className="text-xs font-semibold text-card-foreground uppercase tracking-wider">{config.label}</h4>
          <Badge variant="outline" className={`text-[10px] ${config.badgeClass}`}>{items.length}</Badge>
        </div>
        {items.map(item => {
          const acct = (item as any).layaway_accounts;
          const customer = acct?.customers;
          const currency = acct?.currency as Currency;
          const remaining = remainingDue(item);
          const daysFromDue = daysOverdueFromToday(item.due_date);

          return (
            <div key={item.id} className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${config.iconBg}`}>
                  <Icon className={`h-3.5 w-3.5 ${config.iconColor}`} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link to={`/accounts/${acct?.id}`} className="text-sm font-medium text-card-foreground hover:text-primary transition-colors truncate">
                      {customer?.full_name || 'Unknown'}
                    </Link>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    INV #{acct?.invoice_number} · Due {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    {daysFromDue > 0 && ` · ${daysFromDue}d overdue`}
                    {daysFromDue < 0 && ` · in ${Math.abs(daysFromDue)}d`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-semibold text-card-foreground tabular-nums">
                  {formatCurrency(remaining, currency)}
                </span>
                {customer?.messenger_link && (
                  <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="outline" className="border-info/30 text-info hover:bg-info/10 text-xs h-7 px-2">
                      <MessageCircle className="h-3 w-3" />
                    </Button>
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Send className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Reminder Automation</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Automated daily at 8:00 AM PHT · Live data</p>
            </div>
          </div>
          <Button
            onClick={handleGenerate}
            variant="outline"
            disabled={generating}
            className="border-primary/30 text-primary hover:bg-primary/10"
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${generating ? 'animate-spin' : ''}`} />
            {generating ? 'Sending...' : 'Send Reminders Now'}
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-xl border border-destructive/20 bg-card p-4 text-center">
            <p className="text-2xl font-bold text-destructive font-display">{categorized.overdue.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Overdue</p>
          </div>
          <div className="rounded-xl border border-warning/20 bg-card p-4 text-center">
            <p className="text-2xl font-bold text-warning font-display">{categorized.dueToday.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Due Today</p>
          </div>
          <div className="rounded-xl border border-info/20 bg-card p-4 text-center">
            <p className="text-2xl font-bold text-info font-display">{categorized.upcoming.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Upcoming (7d)</p>
          </div>
          <div className="rounded-xl border border-success/20 bg-card p-4 text-center">
            <p className="text-2xl font-bold text-success font-display">{sentCount}</p>
            <p className="text-xs text-muted-foreground mt-1">Sent (total)</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Action Items */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" /> Action Items
            </h3>
            {!actionableItems ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
              </div>
            ) : (
              <div className="space-y-4 max-h-[600px] overflow-y-auto">
                {renderScheduleGroup(categorized.overdue, 'overdue')}
                {renderScheduleGroup(categorized.dueToday, 'due_today')}
                {renderScheduleGroup(categorized.upcoming, 'upcoming')}
                {categorized.overdue.length === 0 && categorized.dueToday.length === 0 && categorized.upcoming.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-6">No pending reminders</p>
                )}
              </div>
            )}
          </div>

          {/* Reminder History */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" /> Reminder History
            </h3>
            {logsLoading ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : (!reminderLogs || reminderLogs.length === 0) ? (
              <div className="text-center py-12">
                <Send className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">No reminder history yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Reminders are sent automatically at 8:00 AM PHT daily</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[600px] overflow-y-auto">
                {reminderLogs.map(log => {
                  const customer = (log as any).customers;
                  const account = (log as any).layaway_accounts;
                  const isSent = log.delivery_status === 'sent';
                  const isFailed = log.delivery_status === 'failed';

                  return (
                    <div key={log.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] ${
                          isSent ? 'bg-success/10 text-success' : isFailed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
                        }`}>
                          {isSent ? <CheckCircle className="h-3 w-3" /> : isFailed ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-card-foreground truncate">{customer?.full_name || '—'}</p>
                          <p className="text-[10px] text-muted-foreground">
                            INV #{account?.invoice_number || '—'} · {log.channel} · {log.template_type || 'reminder'}
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <Badge variant="outline" className={`text-[10px] ${
                          isSent ? 'bg-success/10 text-success border-success/20' :
                          isFailed ? 'bg-destructive/10 text-destructive border-destructive/20' :
                          'bg-muted text-muted-foreground border-border'
                        }`}>
                          {log.delivery_status || 'pending'}
                        </Badge>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          {log.sent_at ? new Date(log.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
