import { useMemo, useState, useCallback } from 'react';
import { Bell, Send, Copy, Check, Loader2, Filter, MessageCircle, AlertTriangle, Clock, Calendar, CheckCircle, RefreshCw, Shield, ShieldCheck, Gavel } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import PenaltyFollowUpSection from '@/components/monitoring/PenaltyFollowUpSection';
import PenaltyCapAuditPanel from '@/components/dashboard/PenaltyCapAuditPanel';
import { PenaltyAuditTab, OverdueDebugTab, WaiverAuditTab } from '@/pages/AdminAudit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { categorizeScheduleItems, alertTypeConfig } from '@/lib/business-rules';
import { formatCurrency } from '@/lib/calculations';
import RefreshControl from '@/components/common/RefreshControl';
import { getPHTToday } from '@/lib/date-utils';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
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
  getNextUnpaidDueDate, classifyAccountBucket,
  type AlertType, type AccountBucket,
} from '@/lib/business-rules';
import ReminderCard, { type AlertItem, generateReminderMessage } from '@/components/monitoring/ReminderCard';

type FilterTab = 'all' | 'overdue' | 'grace_period' | 'due_today' | 'due_3_days' | 'due_7_days';
type NotifFilter = 'all' | 'not_notified' | 'notified';
type SummaryFilter = FilterTab | 'notified' | 'not_notified';

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'grace_period', label: 'Grace Period' },
  { key: 'due_today', label: 'Due Today' },
  { key: 'due_3_days', label: 'Due in 3 Days' },
  { key: 'due_7_days', label: 'Due in 7 Days' },
];

function bucketToStage(bucket: AccountBucket): string | null {
  if (bucket === 'due_7_days') return '7_DAYS';
  if (bucket === 'due_3_days') return '3_DAYS';
  if (bucket === 'due_today') return 'DUE_TODAY';
  if (bucket === 'grace_period') return 'GRACE_PERIOD';
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

  const [monitoringTab, setMonitoringTab] = useState<'alerts' | 'reminders' | 'extensions' | 'audit'>('alerts');
  const queryClient = useQueryClient();

  const { lastRefreshedAt, refreshing, refresh } = useAutoRefresh([
    ['monitoring-schedules'],
    ['csr-notifications'],
    ['portal-tokens-with-auth'],
    ['reminder-logs'],
    ['reminder-actionable'],
  ]);

  // ── Reminders tab state ──
  const [reminderGenerating, setReminderGenerating] = useState(false);

  const { data: reminderLogs, isLoading: remLogsLoading } = useQuery({
    queryKey: ['reminder-logs'],
    queryFn: async () => {
      const { data, error } = await supabase.from('reminder_logs')
        .select('*, customers(full_name, messenger_link), layaway_accounts!inner(invoice_number, currency, remaining_balance)')
        .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$')
        .order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      return data;
    },
  });

  const { data: actionableItems } = useQuery({
    queryKey: ['reminder-actionable'],
    queryFn: async () => {
      // Day boundaries are PHT-anchored — see src/lib/date-utils.ts.
      const today = getPHTToday();
      const in7days = Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + 7 * 86400000));
      const past730 = Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() - 730 * 86400000));
      const { data, error } = await supabase.from('schedule_with_actuals')
        .select('*, layaway_accounts!inner(id, status, currency, invoice_number, customer_id, customers(full_name, messenger_link))')
        .in('layaway_accounts.status', ['active', 'overdue', 'final_settlement', 'extension_active'])
        .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$')
        .in('computed_status', ['pending', 'partially_paid', 'overdue'])
        .gte('due_date', past730).lte('due_date', in7days)
        .order('due_date', { ascending: true });
      if (error) throw error;
      return data;
    },
  });

  const { data: remSentCount = 0 } = useQuery({
    queryKey: ['reminder-sent-count'],
    queryFn: async () => {
      const { count, error } = await supabase.from('reminder_logs')
        .select('layaway_accounts!inner(invoice_number)', { count: 'exact', head: true })
        .eq('delivery_status', 'sent')
        .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$');
      if (error) throw error;
      return count ?? 0;
    },
  });

  const remCategorized = useMemo(() => {
    if (!actionableItems) return { overdue: [], dueToday: [], upcoming: [] };
    const accountMap = new Map<string, typeof actionableItems[0]>();
    for (const row of actionableItems) {
      if (remainingDue(row) <= 0) continue;
      const acctId = (row as any).account_id as string;
      const existing = accountMap.get(acctId);
      if (!existing || row.due_date < existing.due_date) accountMap.set(acctId, row);
    }
    return categorizeScheduleItems(Array.from(accountMap.values()));
  }, [actionableItems]);

  const handleGenerateReminders = useCallback(async () => {
    setReminderGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-reminders', { body: { dry_run: false } });
      if (error) throw error;
      toast.success(`Reminders processed: ${data?.sent || 0} sent`);
      queryClient.invalidateQueries({ queryKey: ['reminder-logs'] });
      queryClient.invalidateQueries({ queryKey: ['reminder-actionable'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate reminders');
    } finally {
      setReminderGenerating(false);
    }
  }, [queryClient]);

  const remIconMap = { overdue: AlertTriangle, due_today: Clock, upcoming: Bell };

  const renderRemScheduleGroup = (items: any[], type: 'overdue' | 'due_today' | 'upcoming') => {
    if (items.length === 0) return null;
    const config = alertTypeConfig[type];
    const Icon = remIconMap[type];
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 mb-2">
          <Icon className={`h-4 w-4 ${config.iconColor}`} />
          <h4 className="text-xs font-semibold text-card-foreground uppercase tracking-wider">{config.label}</h4>
          <Badge variant="outline" className={`text-[10px] ${config.badgeClass}`}>{items.length}</Badge>
        </div>
        {items.map((item: any) => {
          const acct = item.layaway_accounts;
          const customer = acct?.customers;
          const cur = acct?.currency as Currency;
          const rem = remainingDue(item);
          const daysFromDue = daysOverdueFromToday(item.due_date);
          return (
            <div key={item.id} className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${config.iconBg}`}><Icon className={`h-3.5 w-3.5 ${config.iconColor}`} /></div>
                <div className="min-w-0">
                  <Link to={`/accounts/${acct?.id}`} className="text-sm font-medium text-card-foreground hover:text-primary truncate block">{customer?.full_name || 'Unknown'}</Link>
                  <p className="text-[10px] text-muted-foreground">INV #{acct?.invoice_number} · Due {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{daysFromDue > 0 ? ` · ${daysFromDue}d overdue` : daysFromDue < 0 ? ` · in ${Math.abs(daysFromDue)}d` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-semibold text-card-foreground tabular-nums">{formatCurrency(rem, cur)}</span>
                {customer?.messenger_link && <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer"><Button size="sm" variant="outline" className="border-info/30 text-info hover:bg-info/10 text-xs h-7 px-2"><MessageCircle className="h-3 w-3" /></Button></a>}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Fetch ALL unpaid schedule items for active/overdue accounts
  const { data: scheduleItems, isLoading: schedLoading } = useQuery({
    queryKey: ['monitoring-schedules'],
    staleTime: 30_000,
    queryFn: async () => {
      // Day boundaries are PHT-anchored — see src/lib/date-utils.ts.
      const today = getPHTToday();
      const next7Str = Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + 7 * 86400000));

      const ACTIVE_STATUSES = ['active', 'overdue', 'final_settlement', 'extension_active'] as const;
      const [overdueRes, upcomingRes] = await Promise.all([
        supabase
          .from('schedule_with_actuals')
          .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customer_id, remaining_balance, customers(full_name, messenger_link))')
          .in('computed_status', ['pending', 'overdue', 'partially_paid'])
          .in('layaway_accounts.status', ACTIVE_STATUSES)
          .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$')
          .lt('due_date', today)
          .order('due_date', { ascending: true })
          .limit(500),
        supabase
          .from('schedule_with_actuals')
          .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customer_id, remaining_balance, customers(full_name, messenger_link))')
          .in('computed_status', ['pending', 'overdue', 'partially_paid'])
          .in('layaway_accounts.status', ACTIVE_STATUSES)
          .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$')
          .gte('due_date', today)
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
    staleTime: 30_000,
    queryFn: async () => {
      const PAGE_SIZE = 1000;
      let from = 0;
      let allRows: any[] = [];
      while (true) {
        const { data, error } = await supabase
          .from('csr_notifications')
          .select('schedule_id, reminder_stage, notified_by_name, notified_at')
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows = [...allRows, ...data];
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return allRows;
    },
  });

  // Fetch active portal tokens AND auth_user_id per customer
  const { data: portalTokens } = useQuery({
    queryKey: ['portal-tokens-with-auth'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [tokensRes, customersRes] = await Promise.all([
        supabase
          .from('customer_portal_tokens')
          .select('customer_id, token, expires_at')
          .eq('is_active', true)
          .order('created_at', { ascending: false }),
        supabase
          .from('customers')
          .select('id, auth_user_id'),
      ]);
      if (tokensRes.error) throw tokensRes.error;
      if (customersRes.error) throw customersRes.error;
      const authMap = new Map<string, string | null>();
      for (const c of customersRes.data || []) {
        authMap.set(c.id, c.auth_user_id);
      }
      const map = new Map<string, { token: string | null; authUserId: string | null }>();
      for (const t of tokensRes.data || []) {
        if (map.has(t.customer_id)) continue;
        if (t.expires_at && new Date(t.expires_at) < new Date()) continue;
        map.set(t.customer_id, { token: t.token, authUserId: authMap.get(t.customer_id) ?? null });
      }
      for (const [customerId, authUserId] of authMap.entries()) {
        if (!authUserId) continue;
        if (map.has(customerId)) continue;
        map.set(customerId, { token: null, authUserId });
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
        .filter((s: any) => s.computed_status !== 'paid' && s.computed_status !== 'cancelled')
        .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date))[0];

      if (!nextItem) continue;

      const type = bucket === 'grace_period' ? 'grace_period' as const : categorizeByDueDate(nextItem.due_date);
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
        portalToken: portalTokens?.get(acc.customer_id)?.token ?? null,
        authUserId: portalTokens?.get(acc.customer_id)?.authUserId ?? null,
      });
    }

    return result;
  }, [scheduleItems, portalTokens]);

  // Apply bucket filter
  const bucketFiltered = useMemo(() => {
    if (activeFilter === 'all') return alerts;
    if (activeFilter === 'overdue') return alerts.filter(a => a.bucket === 'overdue');
    if (activeFilter === 'grace_period') return alerts.filter(a => a.bucket === 'grace_period');
    if (activeFilter === 'due_today') return alerts.filter(a => a.bucket === 'due_today');
    if (activeFilter === 'due_3_days') return alerts.filter(a => a.bucket === 'due_3_days');
    if (activeFilter === 'due_7_days') return alerts.filter(a => a.bucket === 'due_7_days');
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
    const order: Record<string, number> = { overdue: 0, grace_period: 1, due_today: 2, due_3_days: 3, due_7_days: 4 };
    return [...filteredAlerts].sort((a, b) => (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9) || b.daysOverdue - a.daysOverdue);
  }, [filteredAlerts]);

  // Counts
  const counts = useMemo(() => ({
    overdue: alerts.filter(a => a.bucket === 'overdue').length,
    grace_period: alerts.filter(a => a.bucket === 'grace_period').length,
    due_today: alerts.filter(a => a.bucket === 'due_today').length,
    due_3_days: alerts.filter(a => a.bucket === 'due_3_days').length,
    due_7_days: alerts.filter(a => a.bucket === 'due_7_days').length,
  }), [alerts]);

  // Notification stats per bucket
  const notifStats = useMemo(() => {
    const stats = {
      due_today: { total: 0, notified: 0 },
      grace_period: { total: 0, notified: 0 },
      due_3_days: { total: 0, notified: 0 },
      due_7_days: { total: 0, notified: 0 },
    };
    for (const a of alerts) {
      const stage = bucketToStage(a.bucket);
      if (!stage) continue;
      const key = a.bucket as 'due_today' | 'grace_period' | 'due_3_days' | 'due_7_days';
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
              <h1 className="text-2xl font-bold text-foreground font-display">Monitoring & Audit</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Customer alerts, reminders, extensions, and data integrity audit</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <RefreshControl lastRefreshedAt={lastRefreshedAt} refreshing={refreshing} onRefresh={refresh} />
          <Button
            onClick={handleSendReminders}
            disabled={sending || sortedAlerts.length === 0}
            className="gap-2"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? 'Sending...' : 'Send All Reminders'}
          </Button>
          </div>
        </div>

        <Tabs value={monitoringTab} onValueChange={v => setMonitoringTab(v as 'alerts' | 'reminders' | 'extensions' | 'audit')} className="w-full">
          <TabsList className="grid grid-cols-4 w-full max-w-xl">
            <TabsTrigger value="alerts">CSR Alerts</TabsTrigger>
            <TabsTrigger value="reminders">Smart Reminders</TabsTrigger>
            <TabsTrigger value="extensions">Extensions</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>

          <TabsContent value="alerts" className="mt-5 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          {([
            { label: 'Overdue', count: counts.overdue, color: 'text-destructive', borderColor: 'border-destructive/40', activeRing: 'ring-destructive/40', activeBorder: 'border-destructive', filter: 'overdue' as FilterTab, statsKey: null },
            { label: 'Grace Period', count: counts.grace_period, color: 'text-amber-500', borderColor: 'border-amber-500/40', activeRing: 'ring-amber-500/40', activeBorder: 'border-amber-500', filter: 'grace_period' as FilterTab, statsKey: 'grace_period' as const },
            { label: 'Due Today', count: counts.due_today, color: 'text-warning', borderColor: 'border-warning/40', activeRing: 'ring-warning/40', activeBorder: 'border-warning', filter: 'due_today' as FilterTab, statsKey: 'due_today' as const },
            { label: 'Due in 3 Days', count: counts.due_3_days, color: 'text-info', borderColor: 'border-info/40', activeRing: 'ring-info/40', activeBorder: 'border-info', filter: 'due_3_days' as FilterTab, statsKey: 'due_3_days' as const },
            { label: 'Due in 7 Days', count: counts.due_7_days, color: 'text-primary', borderColor: 'border-primary/40', activeRing: 'ring-primary/40', activeBorder: 'border-primary', filter: 'due_7_days' as FilterTab, statsKey: 'due_7_days' as const },
          ]).map(s => {
            const stat = s.statsKey ? notifStats[s.statsKey] : null;
            const isActive = activeSummaryCard === s.filter;
            return (
              <button
                key={s.label}
                onClick={() => handleFilterChange(s.filter)}
                className={`rounded-xl border bg-card p-4 text-center transition-all hover:bg-muted/30 ${
                  isActive
                    ? `${s.activeBorder} ring-1 ${s.activeRing} bg-muted/20`
                    : `${s.borderColor} hover:${s.borderColor}`
                }`}
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
            onClick={() => handleNotifCardClick('notified')}
            className={`rounded-xl border bg-card p-4 text-center transition-all hover:bg-muted/30 ${activeSummaryCard === 'notified' ? 'border-success ring-1 ring-success/40 bg-muted/20' : 'border-success/40'}`}
          >
            <p className="text-3xl font-bold font-display text-success">{isLoading ? '—' : totalNotified}</p>
            <p className="text-xs text-muted-foreground mt-1">Notified</p>
          </button>
          <button
            onClick={() => handleNotifCardClick('not_notified')}
            className={`rounded-xl border bg-card p-4 text-center transition-all hover:bg-muted/30 ${activeSummaryCard === 'not_notified' ? 'border-warning ring-1 ring-warning/40 bg-muted/20' : 'border-warning/40'}`}
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
                onClick={() => { setNotifFilter(tab.key); setActiveSummaryCard(tab.key === 'all' ? activeFilter : tab.key); }}
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

        {/* Penalty Follow-Up Stages */}
        <PenaltyFollowUpSection
          totalOverdue={counts.overdue + counts.grace_period}
          gracePeriodCount={counts.grace_period}
        />

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

          </TabsContent>

          {/* ═══════ Reminders Tab ═══════ */}
          <TabsContent value="reminders" className="mt-5 space-y-6">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Automated daily at 8:00 AM PHT · Live data</p>
              <Button onClick={handleGenerateReminders} variant="outline" disabled={reminderGenerating} className="border-primary/30 text-primary hover:bg-primary/10">
                <RefreshCw className={`h-4 w-4 mr-1.5 ${reminderGenerating ? 'animate-spin' : ''}`} />
                {reminderGenerating ? 'Sending...' : 'Send Reminders Now'}
              </Button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-xl border border-destructive/20 bg-card p-4 text-center">
                <p className="text-2xl font-bold text-destructive font-display">{remCategorized.overdue.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Overdue</p>
              </div>
              <div className="rounded-xl border border-warning/20 bg-card p-4 text-center">
                <p className="text-2xl font-bold text-warning font-display">{remCategorized.dueToday.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Due Today</p>
              </div>
              <div className="rounded-xl border border-info/20 bg-card p-4 text-center">
                <p className="text-2xl font-bold text-info font-display">{remCategorized.upcoming.length}</p>
                <p className="text-xs text-muted-foreground mt-1">Upcoming (7d)</p>
              </div>
              <div className="rounded-xl border border-success/20 bg-card p-4 text-center">
                <p className="text-2xl font-bold text-success font-display">{remSentCount}</p>
                <p className="text-xs text-muted-foreground mt-1">Sent (total)</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2"><Calendar className="h-4 w-4 text-primary" /> Action Items</h3>
                {!actionableItems ? (
                  <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
                ) : (
                  <div className="space-y-4 max-h-[600px] overflow-y-auto">
                    {renderRemScheduleGroup(remCategorized.overdue, 'overdue')}
                    {renderRemScheduleGroup(remCategorized.dueToday, 'due_today')}
                    {renderRemScheduleGroup(remCategorized.upcoming, 'upcoming')}
                    {remCategorized.overdue.length === 0 && remCategorized.dueToday.length === 0 && remCategorized.upcoming.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-6">No pending reminders</p>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2"><Bell className="h-4 w-4 text-primary" /> Reminder History</h3>
                {remLogsLoading ? (
                  <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
                ) : (!reminderLogs || reminderLogs.length === 0) ? (
                  <div className="text-center py-12">
                    <Send className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-sm text-muted-foreground">No reminder history yet</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">Reminders are sent automatically at 8:00 AM PHT daily</p>
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[600px] overflow-y-auto">
                    {reminderLogs.map((log: any) => {
                      const customer = log.customers;
                      const account = log.layaway_accounts;
                      const isSent = log.delivery_status === 'sent';
                      const isFailed = log.delivery_status === 'failed';
                      return (
                        <div key={log.id} className="flex items-center justify-between p-2.5 rounded-lg border border-border">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] ${isSent ? 'bg-success/10 text-success' : isFailed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}>
                              {isSent ? <CheckCircle className="h-3 w-3" /> : isFailed ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                            </div>
                            <div className="min-w-0">
                              <p className="text-xs font-medium text-card-foreground truncate">{customer?.full_name || '—'}</p>
                              <p className="text-[10px] text-muted-foreground">INV #{account?.invoice_number || '—'} · {log.channel} · {log.template_type || 'reminder'}</p>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <Badge variant="outline" className={`text-[10px] ${isSent ? 'bg-success/10 text-success border-success/20' : isFailed ? 'bg-destructive/10 text-destructive border-destructive/20' : 'bg-muted text-muted-foreground border-border'}`}>{log.delivery_status || 'pending'}</Badge>
                            <p className="text-[10px] text-muted-foreground mt-0.5">{log.sent_at ? new Date(log.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="extensions" className="mt-5 space-y-6" tabIndex={-1}>
            <ExtensionRequestsPanel />
          </TabsContent>

          <TabsContent value="audit" className="mt-5 space-y-4" tabIndex={-1}>
            <Tabs defaultValue="penalty-cap" className="space-y-4">
              <TabsList className="bg-zinc-800 flex-wrap border border-zinc-700">
                <TabsTrigger value="penalty-cap" className="gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Penalty Cap</TabsTrigger>
                <TabsTrigger value="penalties" className="gap-1.5"><Gavel className="h-3.5 w-3.5" /> Penalty Audit</TabsTrigger>
                <TabsTrigger value="overdue" className="gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Overdue Debug</TabsTrigger>
                <TabsTrigger value="waivers" className="gap-1.5"><Shield className="h-3.5 w-3.5" /> Waiver History</TabsTrigger>
              </TabsList>

              <TabsContent value="penalty-cap"><PenaltyCapAuditPanel /></TabsContent>
              <TabsContent value="penalties"><PenaltyAuditTab /></TabsContent>
              <TabsContent value="overdue"><OverdueDebugTab /></TabsContent>
              <TabsContent value="waivers"><WaiverAuditTab /></TabsContent>
            </Tabs>
          </TabsContent>
        </Tabs>
      </div>

      {/* Messenger Message Dialog */}
      <Dialog open={!!messengerDialog} onOpenChange={(open) => !open && setMessengerDialog(null)}>
        <DialogContent className="max-w-lg flex flex-col max-h-[85vh]">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-info" />
              Reminder — {messengerDialog?.alert.customer}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0 py-1">
            <pre className="text-sm text-card-foreground whitespace-pre-wrap font-sans leading-relaxed">
              {messengerDialog?.message}
            </pre>
          </div>
          <div className="flex gap-2 pt-3 flex-shrink-0">
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
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function ExtensionRequestsPanel() {
  const [filter, setFilter] = useState<'pending' | 'reviewed'>('pending');
  const queryClient = useQueryClient();

  const { data: requests, isLoading } = useQuery({
    queryKey: ['extension-requests', filter],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('extension_requests' as any)
        .select('*, layaway_accounts!inner(id, invoice_number, currency, remaining_balance, status, customer_id, customers(full_name))')
        .filter('layaway_accounts.invoice_number', 'match', '^[0-9]+$')
        .eq('status', filter === 'pending' ? 'pending' : 'approved')
        .order('requested_at', { ascending: false });

      if (error) throw error;
      return (data || []) as any[];
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-card-foreground">Extension Requests</h3>
        <div className="flex gap-1 rounded-lg border border-border p-1 bg-card">
          {(['pending', 'reviewed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                filter === f ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f === 'pending' ? `Pending${requests && filter === 'pending' ? ` (${requests.length})` : ''}` : 'Reviewed'}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
        </div>
      ) : !requests || requests.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Clock className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground">
            {filter === 'pending' ? 'No pending extension requests' : 'No reviewed requests yet'}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Reason</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase">
                  {filter === 'pending' ? 'Requested' : 'Status'}
                </th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((req: any) => {
                const acct = req.layaway_accounts;
                const customerName = acct?.customers?.full_name || '—';
                const invoiceNumber = acct?.invoice_number || '—';
                return (
                  <tr key={req.id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-4 py-3 font-medium text-foreground">{customerName}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <Link to={`/accounts/${acct?.id}`} className="text-primary hover:underline font-mono">#{invoiceNumber}</Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs max-w-[200px] truncate">{req.reason || '—'}</td>
                    <td className="px-4 py-3">
                      {filter === 'pending' ? (
                        <span className="text-xs text-muted-foreground">
                          {new Date(req.requested_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                        </span>
                      ) : (
                        <Badge variant="outline" className={`text-[10px] ${
                          req.status === 'approved' ? 'bg-success/10 text-success border-success/20' : 'bg-destructive/10 text-destructive border-destructive/20'
                        }`}>
                          {req.status}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/accounts/${acct?.id}`}>
                        <Button variant="outline" size="sm" className="h-7 text-xs">
                          View Account
                        </Button>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
