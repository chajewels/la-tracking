import { useMemo, useState } from 'react';
import { Bell, Send, Copy, Check, Loader2, Filter, MessageCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  categorizeByDueDate, daysOverdueFromToday, remainingDue,
  isEffectivelyPaid, getNextUnpaidDueDate, classifyAccountBucket,
  type AlertType, type AccountBucket,
} from '@/lib/business-rules';
import ReminderCard, { type AlertItem, generateReminderMessage } from '@/components/monitoring/ReminderCard';

type FilterTab = 'all' | 'overdue' | 'due_today' | 'due_3_days' | 'due_7_days';
type NotifFilter = 'all' | 'not_notified' | 'notified';
type SummaryFilter = FilterTab | 'notified' | 'not_notified';

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'due_today', label: 'Due Today' },
  { key: 'due_3_days', label: 'Due in 3 Days' },
  { key: 'due_7_days', label: 'Due in 7 Days' },
];

function bucketToStage(bucket: AccountBucket): string | null {
  if (bucket === 'due_7_days') return '7_DAYS';
  if (bucket === 'due_3_days') return '3_DAYS';
  if (bucket === 'due_today') return 'DUE_TODAY';
  return null;
}

export default function Monitoring() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = (searchParams.get('filter') as FilterTab) || 'all';
  const [activeFilter, setActiveFilter] = useState<FilterTab>(initialFilter);
  const [notifFilter, setNotifFilter] = useState<NotifFilter>('all');
  const [activeSummaryCard, setActiveSummaryCard] = useState<SummaryFilter>(initialFilter === 'all' ? 'all' : initialFilter);
  const [sending, setSending] = useState(false);
  const [messengerDialog, setMessengerDialog] = useState<{ alert: AlertItem; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetch ALL unpaid schedule items for active/overdue accounts
  const { data: scheduleItems, isLoading: schedLoading } = useQuery({
    queryKey: ['monitoring-schedules'],
    queryFn: async () => {
      const next7 = new Date();
      next7.setDate(next7.getDate() + 7);
      const next7Str = next7.toISOString().split('T')[0];

      const [overdueRes, upcomingRes] = await Promise.all([
        supabase
          .from('layaway_schedule')
          .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customer_id, remaining_balance, customers(full_name, messenger_link))')
          .in('status', ['pending', 'overdue', 'partially_paid'])
          .in('layaway_accounts.status', ['active', 'overdue'])
          .lt('due_date', new Date().toISOString().split('T')[0])
          .order('due_date', { ascending: true })
          .limit(500),
        supabase
          .from('layaway_schedule')
          .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customer_id, remaining_balance, customers(full_name, messenger_link))')
          .in('status', ['pending', 'overdue', 'partially_paid'])
          .in('layaway_accounts.status', ['active', 'overdue'])
          .gte('due_date', new Date().toISOString().split('T')[0])
          .lte('due_date', next7Str)
          .order('due_date', { ascending: true })
          .limit(500),
      ]);

      if (overdueRes.error) throw overdueRes.error;
      if (upcomingRes.error) throw upcomingRes.error;

      const map = new Map<string, any>();
      for (const item of [...(overdueRes.data || []), ...(upcomingRes.data || [])]) {
        map.set(item.id, item);
      }
      return [...map.values()];
    },
  });

  // Fetch existing CSR notifications
  const { data: notifications } = useQuery({
    queryKey: ['csr-notifications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('csr_notifications')
        .select('schedule_id, reminder_stage, notified_by_name, notified_at');
      if (error) throw error;
      return data;
    },
  });

  // Fetch active portal tokens per customer
  const { data: portalTokens } = useQuery({
    queryKey: ['portal-tokens-active'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('customer_portal_tokens')
        .select('customer_id, token, expires_at')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Deduplicate: keep latest per customer, exclude expired
      const map = new Map<string, string>();
      for (const t of data || []) {
        if (map.has(t.customer_id)) continue;
        if (t.expires_at && new Date(t.expires_at) < new Date()) continue;
        map.set(t.customer_id, t.token);
      }
      return map;
    },
  });

  // Build notification lookup map
  const notifMap = useMemo(() => {
    const map = new Map<string, { notified_by_name: string; notified_at: string }>();
    for (const n of notifications || []) {
      map.set(`${n.schedule_id}_${n.reminder_stage}`, {
        notified_by_name: n.notified_by_name,
        notified_at: n.notified_at,
      });
    }
    return map;
  }, [notifications]);

  // Group schedule items by account → determine NEXT due date per account
  const alerts: AlertItem[] = useMemo(() => {
    if (!scheduleItems) return [];

    const byAccount = new Map<string, any[]>();
    for (const s of scheduleItems) {
      const acc = (s as any).layaway_accounts;
      if (!acc) continue;
      const list = byAccount.get(acc.id) || [];
      list.push(s);
      byAccount.set(acc.id, list);
    }

    const result: AlertItem[] = [];
    for (const [accountId, items] of byAccount.entries()) {
      const acc = (items[0] as any).layaway_accounts;
      const nextDue = getNextUnpaidDueDate(items);
      if (!nextDue) continue;

      const bucket = classifyAccountBucket(nextDue);
      if (bucket === 'fully_paid' || bucket === 'future') continue;

      const nextItem = items
        .filter((s: any) => !isEffectivelyPaid(s) && s.status !== 'cancelled')
        .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date))[0];

      if (!nextItem) continue;

      const type = categorizeByDueDate(nextItem.due_date);
      const overdueDays = daysOverdueFromToday(nextItem.due_date);

      result.push({
        type,
        bucket,
        customer: acc.customers?.full_name || 'Unknown',
        invoice: acc.invoice_number,
        dueDate: nextItem.due_date,
        amount: remainingDue(nextItem),
        remainingBalance: Number(acc.remaining_balance || 0),
        currency: acc.currency as Currency,
        daysOverdue: overdueDays,
        accountId: acc.id,
        scheduleId: nextItem.id,
        customerId: acc.customer_id,
        messengerLink: acc.customers?.messenger_link,
        portalToken: portalTokens?.get(acc.customer_id) || null,
      });
    }

    return result;
  }, [scheduleItems, portalTokens]);

  // Apply bucket filter
  const bucketFiltered = useMemo(() => {
    if (activeFilter === 'all') return alerts;
    if (activeFilter === 'overdue') return alerts.filter(a => a.bucket === 'overdue');
    if (activeFilter === 'due_today') return alerts.filter(a => a.bucket === 'due_today');
    if (activeFilter === 'due_3_days') return alerts.filter(a => a.bucket === 'due_3_days');
    if (activeFilter === 'due_7_days') return alerts.filter(a => ['due_3_days', 'due_7_days'].includes(a.bucket));
    return alerts;
  }, [alerts, activeFilter]);

  // Apply notification filter
  const filteredAlerts = useMemo(() => {
    if (notifFilter === 'all') return bucketFiltered;
    return bucketFiltered.filter(a => {
      const stage = bucketToStage(a.bucket);
      if (!stage) return notifFilter === 'not_notified';
      const isNotified = notifMap.has(`${a.scheduleId}_${stage}`);
      return notifFilter === 'notified' ? isNotified : !isNotified;
    });
  }, [bucketFiltered, notifFilter, notifMap]);

  const sortedAlerts = useMemo(() => {
    const order: Record<string, number> = { overdue: 0, due_today: 1, due_3_days: 2, due_7_days: 3 };
    return [...filteredAlerts].sort((a, b) => (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9) || b.daysOverdue - a.daysOverdue);
  }, [filteredAlerts]);

  // Counts
  const counts = useMemo(() => ({
    overdue: alerts.filter(a => a.bucket === 'overdue').length,
    due_today: alerts.filter(a => a.bucket === 'due_today').length,
    due_3_days: alerts.filter(a => a.bucket === 'due_3_days').length,
    due_7_days: alerts.filter(a => ['due_3_days', 'due_7_days'].includes(a.bucket)).length,
  }), [alerts]);

  // Notification stats per bucket
  const notifStats = useMemo(() => {
    const stats = {
      due_today: { total: 0, notified: 0 },
      due_3_days: { total: 0, notified: 0 },
      due_7_days: { total: 0, notified: 0 },
    };
    for (const a of alerts) {
      const stage = bucketToStage(a.bucket);
      if (!stage) continue;
      const key = a.bucket as 'due_today' | 'due_3_days' | 'due_7_days';
      if (!stats[key]) continue;
      stats[key].total++;
      if (notifMap.has(`${a.scheduleId}_${stage}`)) {
        stats[key].notified++;
      }
    }
    return stats;
  }, [alerts, notifMap]);

  // Total notified / pending across all stages
  const totalNotified = Object.values(notifStats).reduce((s, v) => s + v.notified, 0);
  const totalPending = Object.values(notifStats).reduce((s, v) => s + (v.total - v.notified), 0);

  const isLoading = schedLoading;

  const handleFilterChange = (filter: FilterTab) => {
    setActiveFilter(filter);
    setNotifFilter('all');
    setActiveSummaryCard(filter);
    if (filter === 'all') {
      searchParams.delete('filter');
    } else {
      searchParams.set('filter', filter);
    }
    setSearchParams(searchParams, { replace: true });
  };

  const handleNotifCardClick = (nf: 'notified' | 'not_notified') => {
    setActiveFilter('all');
    setNotifFilter(nf);
    setActiveSummaryCard(nf);
    searchParams.delete('filter');
    setSearchParams(searchParams, { replace: true });
  };

  const handleSendReminders = async () => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-reminders');
      if (error) throw error;
      if (data?.success) {
        toast.success(
          `Reminders sent! ${data.summary.totalAlerts} alerts processed. ${data.summary.emailsSent} emails sent to ${data.summary.staffNotified} staff.`,
          { duration: 5000 }
        );
      } else {
        throw new Error(data?.error || 'Unknown error');
      }
    } catch (err: any) {
      toast.error(`Failed to send reminders: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  const handleCopyMessage = async () => {
    if (!messengerDialog) return;
    try {
      await navigator.clipboard.writeText(messengerDialog.message);
      setCopied(true);
      toast.success('Message copied to clipboard!');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error('Failed to copy message');
    }
  };

  const handleCopyAndOpenMessenger = async () => {
    if (!messengerDialog) return;
    try {
      await navigator.clipboard.writeText(messengerDialog.message);
      setCopied(true);
      toast.success('Message copied! Opening Messenger...');
      if (messengerDialog.alert.messengerLink) {
        window.open(messengerDialog.alert.messengerLink, '_blank');
      }
    } catch {
      toast.error('Failed to copy message');
    }
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Smart Reminder Center</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Stage-based payment alerts with portal link integration</p>
            </div>
          </div>
          <Button
            onClick={handleSendReminders}
            disabled={sending || sortedAlerts.length === 0}
            className="gap-2"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? 'Sending...' : 'Send All Reminders'}
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {([
            { label: 'Overdue', count: counts.overdue, color: 'text-destructive', borderColor: 'border-destructive/20', filter: 'overdue' as FilterTab, statsKey: null },
            { label: 'Due Today', count: counts.due_today, color: 'text-warning', borderColor: 'border-warning/20', filter: 'due_today' as FilterTab, statsKey: 'due_today' as const },
            { label: 'Due in 3 Days', count: counts.due_3_days, color: 'text-info', borderColor: 'border-info/20', filter: 'due_3_days' as FilterTab, statsKey: 'due_3_days' as const },
            { label: 'Due in 7 Days', count: counts.due_7_days, color: 'text-primary', borderColor: 'border-primary/20', filter: 'due_7_days' as FilterTab, statsKey: 'due_7_days' as const },
          ]).map(s => {
            const stat = s.statsKey ? notifStats[s.statsKey] : null;
            return (
              <button
                key={s.label}
                onClick={() => handleFilterChange(s.filter)}
                className={`rounded-xl border bg-card p-4 text-center transition-colors hover:bg-muted/30 ${activeFilter === s.filter ? 'border-primary ring-1 ring-primary/30' : s.borderColor}`}
              >
                <p className={`text-3xl font-bold font-display ${s.color}`}>{isLoading ? '—' : s.count}</p>
                <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
                {stat && stat.total > 0 && (
                  <div className="mt-2 flex items-center justify-center gap-1.5">
                    <span className="text-[10px] font-medium text-success">{stat.notified} ✓</span>
                    <span className="text-[10px] text-muted-foreground">·</span>
                    <span className="text-[10px] font-medium text-warning">{stat.total - stat.notified} pending</span>
                  </div>
                )}
              </button>
            );
          })}
          {/* Total Notified / Pending */}
          <button
            onClick={() => setNotifFilter('notified')}
            className={`rounded-xl border bg-card p-4 text-center transition-colors hover:bg-muted/30 ${notifFilter === 'notified' ? 'border-success ring-1 ring-success/30' : 'border-success/20'}`}
          >
            <p className="text-3xl font-bold font-display text-success">{isLoading ? '—' : totalNotified}</p>
            <p className="text-xs text-muted-foreground mt-1">Notified</p>
          </button>
          <button
            onClick={() => setNotifFilter('not_notified')}
            className={`rounded-xl border bg-card p-4 text-center transition-colors hover:bg-muted/30 ${notifFilter === 'not_notified' ? 'border-warning ring-1 ring-warning/30' : 'border-warning/20'}`}
          >
            <p className="text-3xl font-bold font-display text-warning">{isLoading ? '—' : totalPending}</p>
            <p className="text-xs text-muted-foreground mt-1">Pending</p>
          </button>
        </div>

        {/* Filter Tabs + Notification Filter */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card w-fit">
            {filterTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleFilterChange(tab.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeFilter === tab.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card w-fit">
            {([
              { key: 'all' as NotifFilter, label: 'All' },
              { key: 'not_notified' as NotifFilter, label: 'Not Notified' },
              { key: 'notified' as NotifFilter, label: 'Notified' },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setNotifFilter(tab.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1 ${
                  notifFilter === tab.key
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.key === 'not_notified' && <Filter className="h-3 w-3" />}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Alert List */}
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : sortedAlerts.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {activeFilter === 'all' && notifFilter === 'all'
                ? 'No upcoming or overdue payments in the next 7 days.'
                : 'No accounts matching current filters.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{sortedAlerts.length} account{sortedAlerts.length !== 1 ? 's' : ''}</p>
            {sortedAlerts.map((alert, idx) => (
              <ReminderCard
                key={`${alert.accountId}-${alert.dueDate}-${idx}`}
                alert={alert}
                notifMap={notifMap}
                onOpenMessenger={(a, msg) => { setMessengerDialog({ alert: a, message: msg }); setCopied(false); }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Messenger Message Dialog */}
      <Dialog open={!!messengerDialog} onOpenChange={(open) => !open && setMessengerDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-info" />
              Reminder — {messengerDialog?.alert.customer}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <pre className="text-sm text-card-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {messengerDialog?.message}
              </pre>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1 gap-2" onClick={handleCopyMessage}>
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied!' : 'Copy Message'}
              </Button>
              {messengerDialog?.alert.messengerLink && (
                <Button className="flex-1 gap-2" onClick={handleCopyAndOpenMessenger}>
                  <MessageCircle className="h-4 w-4" />
                  Copy & Open Messenger
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
