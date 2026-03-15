import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy, MessageCircle, Check, AlertTriangle, Calendar } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import RiskBadge from '@/components/dashboard/RiskBadge';
import CLVBadge from '@/components/dashboard/CLVBadge';
import CompletionBadge from '@/components/dashboard/CompletionBadge';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import PenaltyWaiverPanel from '@/components/penalties/PenaltyWaiverPanel';
import { mockAccounts, mockPayments as initialPayments } from '@/lib/mock-data';
import { formatCurrency, buildSchedule, generateCustomerMessage } from '@/lib/calculations';
import { assessAccountRisk, assessCustomerCLV, predictCompletion, riskStyles } from '@/lib/analytics-engine';
import { Payment } from '@/lib/types';
import { toast } from 'sonner';

export default function AccountDetail() {
  const { id } = useParams();
  const account = mockAccounts.find(a => a.id === id);
  const [copied, setCopied] = useState(false);
  const [localPayments, setLocalPayments] = useState<Payment[]>(initialPayments);

  const payments = localPayments.filter(p => p.account_id === id);
  const totalPaid = account ? payments.reduce((s, p) => s + p.amount, 0) : 0;
  const remainingBalance = account ? account.total_amount - totalPaid : 0;
  const paidInstallments = account ? Math.min(payments.length, account.payment_plan) : 0;

  const penalties = id === 'a2' ? [
    { monthNumber: 3, amount: 2000 },
    { monthNumber: 4, amount: 2000 },
    { monthNumber: 5, amount: 1000 },
  ] : [];

  const schedule = useMemo(() => account ? buildSchedule(
    account.id, account.total_amount, totalPaid,
    account.order_date, account.payment_plan, paidInstallments, penalties
  ) : [], [id, totalPaid, paidInstallments]);

  const risk = id ? assessAccountRisk(id) : null;
  const clv = account ? assessCustomerCLV(account.customer_id) : null;
  const completion = id ? predictCompletion(id) : null;

  if (!account) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Account not found</p>
        </div>
      </AppLayout>
    );
  }

  const totalPenalty = penalties.reduce((s, p) => s + p.amount, 0);
  const message = generateCustomerMessage(
    account.invoice_number, account.customer.name,
    account.total_amount, totalPaid, account.currency, schedule, totalPenalty
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePaymentRecorded = (payment: Payment) => {
    setLocalPayments(prev => [...prev, payment]);
  };

  const progress = account.total_amount > 0 ? (totalPaid / account.total_amount) * 100 : 0;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link to="/accounts">
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">INV #{account.invoice_number}</h1>
              <Badge variant="outline" className="bg-success/10 text-success border-success/20 text-xs">
                {account.status}
              </Badge>
              {risk && <RiskBadge level={risk.riskLevel} />}
              {clv && <CLVBadge tier={clv.tier} />}
              {completion && <CompletionBadge probability={completion.probability} />}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{account.customer.name} · {account.payment_plan}-Month Plan · {account.currency}</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {remainingBalance > 0 && (
              <RecordPaymentDialog
                accountId={account.id}
                currency={account.currency}
                remainingBalance={remainingBalance}
                onPaymentRecorded={handlePaymentRecorded}
              />
            )}
            {account.customer.messenger_link && (
              <a href={account.customer.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-4 w-4 mr-2" /> Messenger
                </Button>
              </a>
            )}
          </div>
        </div>

        {/* AI Insights Panel */}
        {risk && risk.riskLevel !== 'low' && (
          <div className={`rounded-xl border p-4 ${riskStyles[risk.riskLevel].border} ${riskStyles[risk.riskLevel].bg}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">{riskStyles[risk.riskLevel].emoji}</span>
              <p className={`text-sm font-semibold ${riskStyles[risk.riskLevel].text}`}>
                AI Risk Assessment — {riskStyles[risk.riskLevel].label}
              </p>
            </div>
            <ul className="space-y-1 ml-6">
              {risk.factors.map((f, i) => (
                <li key={i} className="text-xs text-muted-foreground list-disc">{f}</li>
              ))}
            </ul>
            <p className={`text-xs font-medium mt-2 ${riskStyles[risk.riskLevel].text}`}>
              ↳ Recommendation: {risk.recommendation}
            </p>
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Amount</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(account.total_amount, account.currency)}
            </p>
          </div>
          <div className="rounded-xl border border-success/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Paid</p>
            <p className="text-lg sm:text-xl font-bold text-success font-display tabular-nums">
              {formatCurrency(totalPaid, account.currency)}
            </p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Remaining</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(remainingBalance, account.currency)}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Progress</p>
            <p className="text-lg sm:text-xl font-bold text-primary font-display">{Math.round(progress)}%</p>
            <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full gold-gradient rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Payment Schedule */}
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" /> Payment Schedule
            </h3>
            <div className="space-y-2">
              {schedule.map((item) => (
                <div key={item.id}
                  className={`flex items-center justify-between p-2.5 sm:p-3 rounded-lg border ${
                    item.is_paid ? 'bg-success/5 border-success/10' : 'bg-card border-border'
                  }`}
                >
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className={`flex h-6 w-6 sm:h-7 sm:w-7 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold ${
                      item.is_paid ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
                    }`}>
                      {item.is_paid ? <Check className="h-3 w-3" /> : item.month_number}
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm font-medium text-card-foreground">
                        {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </p>
                      <p className="text-[10px] sm:text-xs text-muted-foreground">
                        {item.is_paid ? 'Paid' : `Month ${item.month_number}`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    {item.penalty_amount > 0 ? (
                      <div>
                        <p className="text-xs sm:text-sm font-semibold text-card-foreground tabular-nums">
                          {formatCurrency(item.total_due, account.currency)}
                        </p>
                        <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          +{formatCurrency(item.penalty_amount, account.currency)}
                        </p>
                      </div>
                    ) : (
                      <p className={`text-xs sm:text-sm font-semibold tabular-nums ${item.is_paid ? 'text-success' : 'text-card-foreground'}`}>
                        {item.is_paid ? formatCurrency(item.paid_amount, account.currency) : formatCurrency(item.base_amount, account.currency)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Customer Message */}
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-info" /> Customer Message
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
              {account.customer.messenger_link && (
                <a href={account.customer.messenger_link} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                    <MessageCircle className="h-3.5 w-3.5 mr-1" /> Messenger
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Penalty Waiver Panel */}
        <PenaltyWaiverPanel
          accountId={account.id}
          invoiceNumber={account.invoice_number}
          currency={account.currency}
          penalties={penalties}
        />

        {/* Payment History */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4">Payment History</h3>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments recorded yet</p>
          ) : (
            <div className="space-y-2">
              {[...payments].sort((a, b) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()).map((p) => (
                <div key={p.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <p className="text-xs sm:text-sm text-card-foreground">
                      {new Date(p.payment_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                    </p>
                    <p className="text-[10px] sm:text-xs text-muted-foreground">
                      Recorded by {p.recorded_by}
                      {p.notes && ` · ${p.notes}`}
                    </p>
                  </div>
                  <p className="text-xs sm:text-sm font-semibold text-success tabular-nums">
                    +{formatCurrency(p.amount, p.currency)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
