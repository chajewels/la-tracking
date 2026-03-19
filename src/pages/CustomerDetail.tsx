import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy, Check, MessageCircle, Calendar, AlertTriangle } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useCustomerAccounts } from '@/hooks/use-supabase-data';

export default function CustomerDetail() {
  const { customerId } = useParams();
  const { data, isLoading } = useCustomerAccounts(customerId);
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6 max-w-5xl">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!data || !data.customer) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Customer not found</p>
        </div>
      </AppLayout>
    );
  }

  const { customer, accounts } = data;
  const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

  // Build consolidated message across all accounts
  const buildConsolidatedMessage = () => {
    let msg = `✨ Cha Jewels Layaway Payment Summary\n\n`;
    msg += `Dear ${customer.full_name},\n\n`;

    for (const acct of accounts) {
      const currency = acct.account.currency as Currency;
      const totalAmount = Number(acct.account.total_amount);
      const totalPaid = Number(acct.account.total_paid);
      const remainingBalance = Number(acct.account.remaining_balance);
      const unpaidPenalties = (acct.penalties || []).filter(p => p.status === 'unpaid');
      const totalPenalty = unpaidPenalties.reduce((s, p) => s + Number(p.penalty_amount), 0);

      msg += `━━━━━━━━━━━━━━━━━━\n`;
      msg += `📋 Inv # ${acct.account.invoice_number}\n`;
      if (totalPenalty > 0) {
        msg += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)} + ${formatCurrency(totalPenalty, currency)} (Penalty)\n`;
      } else {
        msg += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)}\n`;
      }
      msg += `Amount Paid: ${formatCurrency(totalPaid, currency)}\n`;
      msg += `Remaining Balance: ${formatCurrency(remainingBalance, currency)}\n\n`;

      msg += `Payment Schedule:\n`;
      acct.schedule.forEach((item, idx) => {
        const isPaid = item.status === 'paid';
        const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
        const penalty = Number(item.penalty_amount);
        const base = Number(item.base_installment_amount);

        if (isPaid) {
          msg += `✅ ${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(base, currency)} — PAID\n`;
        } else if (penalty > 0) {
          msg += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(base, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(Number(item.total_due_amount), currency)}\n`;
        } else {
          msg += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(base, currency)}\n`;
        }
      });
      msg += `\n`;
    }

    // Find next due date across all accounts
    const allUnpaid = accounts.flatMap(a =>
      a.schedule.filter(s => s.status !== 'paid').map(s => s.due_date)
    );
    if (allUnpaid.length > 0) {
      allUnpaid.sort();
      const nextDate = new Date(allUnpaid[0]).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      msg += `Please note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n\n`;
    }
    msg += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;
    return msg;
  };

  const message = buildConsolidatedMessage();

  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link to="/customers">
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">{customer.full_name}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {customer.customer_code} · {accounts.length} account{accounts.length !== 1 ? 's' : ''}
              {customer.facebook_name && ` · @${customer.facebook_name}`}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {customer.messenger_link && (
              <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-4 w-4 mr-2" /> Messenger
                </Button>
              </a>
            )}
          </div>
        </div>

        {/* All Accounts */}
        {accounts.map(({ account, schedule, penalties }) => {
          const currency = account.currency as Currency;
          const totalAmount = Number(account.total_amount);
          const totalPaid = Number(account.total_paid);
          const remainingBalance = Number(account.remaining_balance);
          const progress = totalAmount > 0 ? (totalPaid / totalAmount) * 100 : 0;

          return (
            <div key={account.id} className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-3">
                  <Link to={`/accounts/${account.id}`} className="hover:text-primary transition-colors">
                    <h2 className="text-base sm:text-lg font-bold text-card-foreground font-display">
                      INV #{account.invoice_number}
                    </h2>
                  </Link>
                  <Badge variant="outline" className={`text-xs ${
                    account.status === 'completed' ? 'bg-success/10 text-success border-success/20' :
                    account.status === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/20' :
                    'bg-primary/10 text-primary border-primary/20'
                  }`}>
                    {account.status}
                  </Badge>
                  <Badge variant="outline" className="text-xs">{currency}</Badge>
                </div>
                {remainingBalance > 0 && (
                  <RecordPaymentDialog
                    accountId={account.id}
                    currency={currency}
                    remainingBalance={remainingBalance}
                  />
                )}
              </div>

              {/* Summary row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Total</p>
                  <p className="text-sm font-bold text-card-foreground tabular-nums">{formatCurrency(totalAmount, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Paid</p>
                  <p className="text-sm font-bold text-success tabular-nums">{formatCurrency(totalPaid, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Remaining</p>
                  <p className="text-sm font-bold text-card-foreground tabular-nums">{formatCurrency(remainingBalance, currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase">Progress</p>
                  <p className="text-sm font-bold text-primary">{Math.round(progress)}%</p>
                  <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full gold-gradient rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              </div>

              {/* Schedule */}
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-primary" /> Schedule
                </h3>
                {schedule.map((item) => {
                  const isPaid = item.status === 'paid';
                  const penaltyAmt = Number(item.penalty_amount);
                  const baseAmt = Number(item.base_installment_amount);
                  const paidAmt = Number(item.paid_amount);
                  return (
                    <div key={item.id}
                      className={`flex items-center justify-between p-2.5 rounded-lg border ${
                        isPaid ? 'bg-success/5 border-success/10' : 'bg-card border-border'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                          isPaid ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
                        }`}>
                          {isPaid ? <Check className="h-3 w-3" /> : item.installment_number}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-card-foreground">
                            {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {isPaid ? 'Paid' : `Month ${item.installment_number}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        {penaltyAmt > 0 ? (
                          <div>
                            <p className="text-xs font-semibold text-card-foreground tabular-nums">
                              {formatCurrency(Number(item.total_due_amount), currency)}
                            </p>
                            <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                              <AlertTriangle className="h-2.5 w-2.5" />
                              +{formatCurrency(penaltyAmt, currency)}
                            </p>
                          </div>
                        ) : (
                          <p className={`text-xs font-semibold tabular-nums ${isPaid ? 'text-success' : 'text-card-foreground'}`}>
                            {isPaid ? formatCurrency(paidAmt, currency) : formatCurrency(baseAmt, currency)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Consolidated Customer Message */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-info" /> Consolidated Customer Message
          </h3>
          <div className="rounded-lg bg-muted/50 p-3 sm:p-4 border border-border">
            <pre className="text-[10px] sm:text-xs text-card-foreground whitespace-pre-wrap font-body leading-relaxed">
              {message}
            </pre>
          </div>
          <div className="flex gap-2 mt-4 flex-wrap">
            <Button onClick={handleCopy} variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
              {copied ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
              {copied ? 'Copied!' : 'Copy Message'}
            </Button>
            {customer.messenger_link && (
              <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-3.5 w-3.5 mr-1" /> Messenger
                </Button>
              </a>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
