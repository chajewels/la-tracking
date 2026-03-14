import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy, MessageCircle, Check, AlertTriangle, Calendar, User } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { mockAccounts, mockPayments } from '@/lib/mock-data';
import { formatCurrency, buildSchedule, generateCustomerMessage } from '@/lib/calculations';
import { toast } from 'sonner';

export default function AccountDetail() {
  const { id } = useParams();
  const account = mockAccounts.find(a => a.id === id);
  const [copied, setCopied] = useState(false);

  if (!account) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Account not found</p>
        </div>
      </AppLayout>
    );
  }

  const payments = mockPayments.filter(p => p.account_id === account.id);
  const paidInstallments = Math.min(payments.length, account.payment_plan);

  // Example penalties for account a2
  const penalties = account.id === 'a2' ? [
    { monthNumber: 3, amount: 2000 },
    { monthNumber: 4, amount: 2000 },
    { monthNumber: 5, amount: 1000 },
  ] : [];

  const schedule = buildSchedule(
    account.id,
    account.total_amount,
    account.total_paid,
    account.order_date,
    account.payment_plan,
    paidInstallments,
    penalties
  );

  const totalPenalty = penalties.reduce((s, p) => s + p.amount, 0);
  const message = generateCustomerMessage(
    account.invoice_number,
    account.customer.name,
    account.total_amount,
    account.total_paid,
    account.currency,
    schedule,
    totalPenalty
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const progress = account.total_amount > 0 ? (account.total_paid / account.total_amount) * 100 : 0;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link to="/accounts">
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground font-display">INV #{account.invoice_number}</h1>
              <Badge variant="outline" className="bg-success/10 text-success border-success/20 text-xs">
                {account.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{account.customer.name} · {account.payment_plan}-Month Plan · {account.currency}</p>
          </div>
          {account.customer.messenger_link && (
            <a href={account.customer.messenger_link} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" className="border-info/30 text-info hover:bg-info/10">
                <MessageCircle className="h-4 w-4 mr-2" /> Open Messenger
              </Button>
            </a>
          )}
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Amount</p>
            <p className="text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(account.total_amount, account.currency)}
            </p>
          </div>
          <div className="rounded-xl border border-success/20 bg-card p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Paid</p>
            <p className="text-xl font-bold text-success font-display tabular-nums">
              {formatCurrency(account.total_paid, account.currency)}
            </p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-card p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Remaining</p>
            <p className="text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(account.remaining_balance, account.currency)}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Progress</p>
            <p className="text-xl font-bold text-primary font-display">{Math.round(progress)}%</p>
            <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full gold-gradient rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Payment Schedule */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" /> Payment Schedule
            </h3>
            <div className="space-y-2">
              {schedule.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    item.is_paid
                      ? 'bg-success/5 border-success/10'
                      : 'bg-card border-border'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                      item.is_paid
                        ? 'bg-success/20 text-success'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {item.is_paid ? <Check className="h-3.5 w-3.5" /> : item.month_number}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-card-foreground">
                        {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.is_paid ? 'Paid' : `Month ${item.month_number}`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    {item.penalty_amount > 0 ? (
                      <div>
                        <p className="text-sm font-semibold text-card-foreground tabular-nums">
                          {formatCurrency(item.total_due, account.currency)}
                        </p>
                        <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          +{formatCurrency(item.penalty_amount, account.currency)} penalty
                        </p>
                      </div>
                    ) : (
                      <p className={`text-sm font-semibold tabular-nums ${item.is_paid ? 'text-success' : 'text-card-foreground'}`}>
                        {item.is_paid ? formatCurrency(item.paid_amount, account.currency) : formatCurrency(item.base_amount, account.currency)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Customer Message */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-info" /> Customer Message
            </h3>
            <div className="rounded-lg bg-muted/50 p-4 border border-border">
              <pre className="text-xs text-card-foreground whitespace-pre-wrap font-body leading-relaxed">
                {message}
              </pre>
            </div>
            <div className="flex gap-2 mt-4">
              <Button onClick={handleCopy} variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
                {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                {copied ? 'Copied!' : 'Copy Message'}
              </Button>
              {account.customer.messenger_link && (
                <a href={account.customer.messenger_link} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                    <MessageCircle className="h-3.5 w-3.5 mr-1" /> Open Messenger
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Payment History */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4">Payment History</h3>
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div>
                  <p className="text-sm text-card-foreground">
                    {new Date(p.payment_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                  <p className="text-xs text-muted-foreground">Recorded by {p.recorded_by}</p>
                </div>
                <p className="text-sm font-semibold text-success tabular-nums">
                  +{formatCurrency(p.amount, p.currency)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
