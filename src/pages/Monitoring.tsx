import { useMemo, useState } from 'react';
import { Bell, MessageCircle, Clock, AlertTriangle, CalendarCheck, Send, Copy, Check, Mail, Loader2 } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Link } from 'react-router-dom';
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

function generateMessengerMessage(alert: AlertItem): string {
  const dueStr = new Date(alert.dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const amtStr = formatCurrency(alert.amount, alert.currency);

  if (alert.type === 'overdue') {
    return `Hi ${alert.customer}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment for INV #${alert.invoice} was due on ${dueStr} (${alert.daysOverdue} days ago).\n\nRemaining amount due: ${amtStr}\n\nPlease settle at your earliest convenience to avoid additional penalties. Thank you! 💎`;
  } else if (alert.type === 'due_today') {
    return `Hi ${alert.customer}! 👋\n\nJust a reminder from Cha Jewels — your layaway payment for INV #${alert.invoice} is due today!\n\nAmount due: ${amtStr}\n\nThank you for your prompt payment! 💎`;
  } else {
    return `Hi ${alert.customer}! 👋\n\nThis is a friendly heads-up from Cha Jewels — your next layaway payment for INV #${alert.invoice} is coming up on ${dueStr}.\n\nAmount due: ${amtStr}\n\nThank you for staying on track! 💎`;
  }
}

export default function Monitoring() {
  const accounts: any[] = []; // accounts loaded via joined query below
  const [sending, setSending] = useState(false);
  const [messengerDialog, setMessengerDialog] = useState<{ alert: AlertItem; message: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Fetch schedule items directly without filtering by account IDs (avoids .in() limit issues)
  const { data: scheduleItems, isLoading: schedLoading } = useQuery({
    queryKey: ['monitoring-schedules'],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const next7 = new Date();
      next7.setDate(next7.getDate() + 7);
      const next7Str = next7.toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(id, invoice_number, currency, status, customers(full_name, messenger_link))')
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .in('layaway_accounts.status', ['active', 'overdue'])
        .lte('due_date', next7Str)
        .order('due_date', { ascending: true })
        .limit(500);
      if (error) throw error;
      return data;
    },
  });

  const alerts: AlertItem[] = useMemo(() => {
    if (!scheduleItems) return [];
    const today = new Date().toISOString().split('T')[0];

    return scheduleItems.map((s: any) => {
      const acc = s.layaway_accounts;
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
  }, [scheduleItems]);

  const sortedAlerts = useMemo(() => {
    const order = { overdue: 0, due_today: 1, upcoming: 2 };
    return [...alerts].sort((a, b) => order[a.type] - order[b.type] || b.daysOverdue - a.daysOverdue);
  }, [alerts]);

  const isLoading = schedLoading;

  const handleSendReminders = async () => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-reminders');
      if (error) throw error;
      const result = data;
      if (result?.success) {
        toast.success(
          `Reminders sent! ${result.summary.totalAlerts} alerts processed. ${result.summary.emailsSent} emails sent to ${result.summary.staffNotified} staff.`,
          { duration: 5000 }
        );
      } else {
        throw new Error(result?.error || 'Unknown error');
      }
    } catch (err: any) {
      toast.error(`Failed to send reminders: ${err.message}`);
    } finally {
      setSending(false);
    }
  };

  const handleOpenMessenger = (alert: AlertItem) => {
    const message = generateMessengerMessage(alert);
    setMessengerDialog({ alert, message });
    setCopied(false);
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
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Bell className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">CSR Monitoring Center</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Payment alerts & reminders</p>
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
                <div key={`${alert.accountId}-${alert.dueDate}-${idx}`} className={`rounded-xl border bg-card p-4 ${config.borderClass} hover:bg-muted/30 transition-colors`}>
                  <div className="flex items-center justify-between">
                    <Link to={`/accounts/${alert.accountId}`} className="flex items-center gap-4 flex-1 cursor-pointer">
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
                    </Link>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-bold text-card-foreground tabular-nums">
                        {formatCurrency(alert.amount, alert.currency)}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-info"
                          title="Generate Messenger message"
                          onClick={() => handleOpenMessenger(alert)}
                        >
                          <MessageCircle className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Messenger Message Dialog */}
      <Dialog open={!!messengerDialog} onOpenChange={(open) => !open && setMessengerDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-info" />
              Messenger Reminder — {messengerDialog?.alert.customer}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={`text-[10px] ${messengerDialog?.alert.type === 'overdue' ? 'text-destructive border-destructive/20' : messengerDialog?.alert.type === 'due_today' ? 'text-warning border-warning/20' : 'text-info border-info/20'}`}>
                {messengerDialog?.alert.type === 'overdue' ? 'Overdue' : messengerDialog?.alert.type === 'due_today' ? 'Due Today' : 'Upcoming'}
              </Badge>
              <span className="text-xs text-muted-foreground">INV #{messengerDialog?.alert.invoice}</span>
            </div>
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
