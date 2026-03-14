import { useState, useMemo } from 'react';
import { Bell, Send, Clock, AlertTriangle, CheckCircle, MessageCircle, RefreshCw } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { mockAccounts } from '@/lib/mock-data';
import { formatCurrency, generateScheduleDates } from '@/lib/calculations';
import { toast } from 'sonner';

interface Reminder {
  id: string;
  accountId: string;
  invoiceNumber: string;
  customerName: string;
  messengerLink?: string;
  type: 'upcoming' | 'due_today' | 'overdue';
  dueDate: string;
  amount: number;
  currency: 'PHP' | 'JPY';
  daysUntilDue: number;
  status: 'queued' | 'sent' | 'failed';
  message: string;
  queuedAt: string;
  sentAt?: string;
}

function generateReminderMessage(
  type: 'upcoming' | 'due_today' | 'overdue',
  customerName: string,
  invoiceNumber: string,
  amount: number,
  currency: 'PHP' | 'JPY',
  dueDate: string
): string {
  const symbol = currency === 'PHP' ? '₱' : '¥';
  const formattedAmount = `${symbol} ${Math.round(amount).toLocaleString()}`;
  const formattedDate = new Date(dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const firstName = customerName.split(' ')[0];

  if (type === 'upcoming') {
    return `Hi ${firstName}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment of ${formattedAmount} for Invoice #${invoiceNumber} is due on ${formattedDate}.\n\nPlease prepare your payment to keep your layaway on track.\n\nThank you for your continued trust in Cha Jewels! 💛`;
  } else if (type === 'due_today') {
    return `Hi ${firstName}! 👋\n\nYour Cha Jewels layaway payment of ${formattedAmount} for Invoice #${invoiceNumber} is due today, ${formattedDate}.\n\nPlease send your payment at your earliest convenience.\n\nWe appreciate your business! 💛\n\n— Cha Jewels Team`;
  } else {
    return `Hi ${firstName},\n\nWe noticed your layaway payment of ${formattedAmount} for Invoice #${invoiceNumber} was due on ${formattedDate} and has not yet been received.\n\nPlease send your payment as soon as possible to avoid additional penalties.\n\nIf you have any questions, please don't hesitate to reach out.\n\nThank you for your attention.\n\n— Cha Jewels Team`;
  }
}

export default function Reminders() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [generating, setGenerating] = useState(false);

  const generateReminders = () => {
    setGenerating(true);

    const now = new Date();
    const newReminders: Reminder[] = [];

    mockAccounts.filter(a => a.status === 'active').forEach(account => {
      const dates = generateScheduleDates(account.order_date, account.payment_plan);
      
      dates.forEach((dateStr, idx) => {
        const dueDate = new Date(dateStr);
        const diffDays = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        let type: 'upcoming' | 'due_today' | 'overdue' | null = null;
        if (diffDays >= 1 && diffDays <= 3) type = 'upcoming';
        else if (diffDays === 0) type = 'due_today';
        else if (diffDays < 0 && diffDays >= -30) type = 'overdue';

        if (!type) return;

        // Skip already-paid installments
        if (idx < Math.floor(account.total_paid / (account.total_amount / account.payment_plan))) return;

        const installmentAmount = Math.round(account.remaining_balance / (account.payment_plan - idx));

        const reminder: Reminder = {
          id: `rem-${account.id}-${idx}-${Date.now()}`,
          accountId: account.id,
          invoiceNumber: account.invoice_number,
          customerName: account.customer.name,
          messengerLink: account.customer.messenger_link,
          type,
          dueDate: dateStr,
          amount: installmentAmount > 0 ? installmentAmount : account.remaining_balance,
          currency: account.currency,
          daysUntilDue: diffDays,
          status: 'queued',
          message: generateReminderMessage(type, account.customer.name, account.invoice_number, installmentAmount, account.currency, dateStr),
          queuedAt: now.toISOString(),
        };

        // Avoid duplicates
        if (!newReminders.find(r => r.accountId === account.id && r.dueDate === dateStr)) {
          newReminders.push(reminder);
        }
      });
    });

    // Sort: overdue first, then due today, then upcoming
    newReminders.sort((a, b) => a.daysUntilDue - b.daysUntilDue);

    setTimeout(() => {
      setReminders(newReminders);
      setGenerating(false);
      toast.success(`Generated ${newReminders.length} reminder(s)`);
    }, 600);
  };

  const sendReminder = (id: string) => {
    setReminders(prev => prev.map(r =>
      r.id === id ? { ...r, status: 'sent' as const, sentAt: new Date().toISOString() } : r
    ));
    toast.success('Reminder sent via Messenger');
  };

  const sendAllQueued = () => {
    const queued = reminders.filter(r => r.status === 'queued');
    setReminders(prev => prev.map(r =>
      r.status === 'queued' ? { ...r, status: 'sent' as const, sentAt: new Date().toISOString() } : r
    ));
    toast.success(`Sent ${queued.length} reminder(s)`);
  };

  const typeConfig = {
    overdue: { icon: AlertTriangle, label: 'Overdue', badgeClass: 'bg-destructive/10 text-destructive border-destructive/20', color: 'text-destructive' },
    due_today: { icon: Clock, label: 'Due Today', badgeClass: 'bg-warning/10 text-warning border-warning/20', color: 'text-warning' },
    upcoming: { icon: Bell, label: 'Upcoming', badgeClass: 'bg-info/10 text-info border-info/20', color: 'text-info' },
  };

  const queuedCount = reminders.filter(r => r.status === 'queued').length;
  const sentCount = reminders.filter(r => r.status === 'sent').length;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Send className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Reminder Automation</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Generate & send Messenger payment reminders</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={generateReminders}
              variant="outline"
              disabled={generating}
              className="border-primary/30 text-primary hover:bg-primary/10"
            >
              <RefreshCw className={`h-4 w-4 mr-1.5 ${generating ? 'animate-spin' : ''}`} />
              {generating ? 'Generating...' : 'Generate Reminders'}
            </Button>
            {queuedCount > 0 && (
              <Button onClick={sendAllQueued} className="gold-gradient text-primary-foreground font-medium">
                <Send className="h-4 w-4 mr-1.5" /> Send All ({queuedCount})
              </Button>
            )}
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-border bg-card p-4 text-center">
            <p className="text-2xl font-bold text-foreground font-display">{reminders.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Total Reminders</p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-card p-4 text-center">
            <p className="text-2xl font-bold text-primary font-display">{queuedCount}</p>
            <p className="text-xs text-muted-foreground mt-1">Queued</p>
          </div>
          <div className="rounded-xl border border-success/20 bg-card p-4 text-center">
            <p className="text-2xl font-bold text-success font-display">{sentCount}</p>
            <p className="text-xs text-muted-foreground mt-1">Sent</p>
          </div>
        </div>

        {/* Reminder List */}
        {reminders.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Send className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No reminders generated yet</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Click "Generate Reminders" to scan active accounts for upcoming and overdue payments</p>
          </div>
        ) : (
          <div className="space-y-3">
            {reminders.map(reminder => {
              const config = typeConfig[reminder.type];
              const Icon = config.icon;
              return (
                <div key={reminder.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-col sm:flex-row sm:items-start gap-4">
                    {/* Left: Info */}
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                        reminder.type === 'overdue' ? 'bg-destructive/10' : reminder.type === 'due_today' ? 'bg-warning/10' : 'bg-info/10'
                      }`}>
                        <Icon className={`h-4 w-4 ${config.color}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-card-foreground">{reminder.customerName}</p>
                          <Badge variant="outline" className={`text-[10px] ${config.badgeClass}`}>{config.label}</Badge>
                          {reminder.status === 'sent' && (
                            <Badge variant="outline" className="text-[10px] bg-success/10 text-success border-success/20">
                              <CheckCircle className="h-2.5 w-2.5 mr-0.5" /> Sent
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          INV #{reminder.invoiceNumber} · Due {new Date(reminder.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          {reminder.daysUntilDue < 0 && ` · ${Math.abs(reminder.daysUntilDue)} days overdue`}
                          {reminder.daysUntilDue > 0 && ` · in ${reminder.daysUntilDue} days`}
                        </p>
                        {/* Message preview */}
                        <div className="mt-2 rounded-lg bg-muted/50 p-3 border border-border">
                          <pre className="text-[10px] text-card-foreground whitespace-pre-wrap font-body leading-relaxed line-clamp-4">
                            {reminder.message}
                          </pre>
                        </div>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 sm:flex-col sm:items-end shrink-0">
                      <span className="text-sm font-bold text-card-foreground tabular-nums">
                        {formatCurrency(reminder.amount, reminder.currency)}
                      </span>
                      <div className="flex gap-1.5">
                        {reminder.status === 'queued' && (
                          <Button
                            size="sm"
                            onClick={() => sendReminder(reminder.id)}
                            className="gold-gradient text-primary-foreground text-xs h-7"
                          >
                            <Send className="h-3 w-3 mr-1" /> Send
                          </Button>
                        )}
                        {reminder.messengerLink && (
                          <a href={reminder.messengerLink} target="_blank" rel="noopener noreferrer">
                            <Button size="sm" variant="outline" className="border-info/30 text-info hover:bg-info/10 text-xs h-7">
                              <MessageCircle className="h-3 w-3 mr-1" /> Open
                            </Button>
                          </a>
                        )}
                      </div>
                      {reminder.sentAt && (
                        <p className="text-[10px] text-muted-foreground">
                          Sent {new Date(reminder.sentAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
