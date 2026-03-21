import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Copy, Check, CheckCircle2, MessageCircle, Calendar, AlertTriangle, MapPin, Pencil, X, Ban, Wrench } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import MultiInvoicePaymentDialog from '@/components/payments/MultiInvoicePaymentDialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useCustomerAccounts, useForfeitAccount } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';

export default function CustomerDetail() {
  const { customerId } = useParams();
  const { data, isLoading } = useCustomerAccounts(customerId);
  const [copied, setCopied] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [locationType, setLocationType] = useState<'japan' | 'international'>('japan');
  const [country, setCountry] = useState('');
  const queryClient = useQueryClient();
  const forfeitAccount = useForfeitAccount();

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

  const sortPaymentsNewestFirst = (a: any, b: any) => {
    const createdDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (createdDiff !== 0) return createdDiff;
    return new Date(b.date_paid).getTime() - new Date(a.date_paid).getTime();
  };

  // Build consolidated message across all accounts
  const buildConsolidatedMessage = () => {
    const allActivePayments = accounts.flatMap((acct) =>
      (acct.payments || [])
        .filter((p: any) => !p.voided_at)
        .map((p: any) => ({
          ...p,
          invoice_number: acct.account.invoice_number,
          currency: acct.account.currency as Currency,
        }))
    );

    const latestPayment = [...allActivePayments].sort(sortPaymentsNewestFirst)[0];
    const latestPaymentIsSplitBatch =
      !!latestPayment?.reference_number &&
      typeof latestPayment?.remarks === 'string' &&
      latestPayment.remarks.startsWith('[Multi-invoice]');

    const latestPaymentEvent = latestPayment
      ? latestPaymentIsSplitBatch
        ? allActivePayments
            .filter((p: any) => p.reference_number === latestPayment.reference_number)
            .sort(sortPaymentsNewestFirst)
        : [latestPayment]
      : [];

    const recentByCurrency = latestPaymentEvent.reduce<Record<Currency, number>>(
      (totals, payment: any) => {
        totals[payment.currency] += Number(payment.amount_paid);
        return totals;
      },
      { PHP: 0, JPY: 0 }
    );

    const thankYouParts = (Object.entries(recentByCurrency) as [Currency, number][])
      .filter(([, amt]) => amt > 0)
      .map(([cur, amt]) => formatCurrency(amt, cur));

    let msg = `✨ Cha Jewels Layaway Payment Summary\n\n`;
    msg += `Dear ${customer.full_name},\n\n`;
    if (thankYouParts.length > 0) {
      msg += `Thank you for your payment. ${thankYouParts.join(' and ')} has been received.\n\n`;

      if (latestPaymentEvent.length > 1) {
        latestPaymentEvent.forEach((payment: any) => {
          msg += `Inv # ${payment.invoice_number} - ${formatCurrency(Number(payment.amount_paid), payment.currency)}\n`;
        });
        msg += `\n`;
      }
    }

    for (const acct of accounts) {
      const currency = acct.account.currency as Currency;
      const totalAmount = Number(acct.account.total_amount);
      const totalPaid = Number(acct.account.total_paid);
      const remainingBalance = Number(acct.account.remaining_balance);
      const unpaidPenalties = (acct.penalties || []).filter(p => p.status === 'unpaid');
      const totalPenalty = unpaidPenalties.reduce((s, p) => s + Number(p.penalty_amount), 0);
      const activePayments = [...(acct.payments || [])]
        .filter((p: any) => !p.voided_at)
        .sort((a: any, b: any) => {
          const dateDiff = new Date(a.date_paid).getTime() - new Date(b.date_paid).getTime();
          if (dateDiff !== 0) return dateDiff;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

      // Build payment breakdown with split-payment annotations
      const paymentParts = activePayments.map((p: any) => {
        const amt = formatCurrency(Number(p.amount_paid), currency);
        const isSplit = p.remarks && typeof p.remarks === 'string' && p.remarks.startsWith('[Multi-invoice]');
        return isSplit ? `${amt} (split)` : amt;
      });
      const paymentBreakdownText = activePayments.length > 0
        ? `${paymentParts.join(' + ')} = ${formatCurrency(totalPaid, currency)}`
        : formatCurrency(totalPaid, currency);

      // Collect split payment batches for this account
      const splitPayments = activePayments.filter(
        (p: any) => p.remarks && typeof p.remarks === 'string' && p.remarks.startsWith('[Multi-invoice]') && p.reference_number
      );
      // Group by batch reference_number to find sibling invoices
      const batchRefs = [...new Set(splitPayments.map((p: any) => p.reference_number as string))];
      // Find sibling payments in other accounts that share the same batch ref
      const batchSiblings: Array<{ date: string; totalBatch: number; invoices: string[] }> = [];
      for (const ref of batchRefs) {
        const allBatchPayments: Array<{ invoice: string; amount: number; date: string }> = [];
        for (const otherAcct of accounts) {
          const match = (otherAcct.payments || []).find(
            (op: any) => !op.voided_at && op.reference_number === ref
          );
          if (match) {
            allBatchPayments.push({
              invoice: otherAcct.account.invoice_number,
              amount: Number((match as any).amount_paid),
              date: (match as any).date_paid,
            });
          }
        }
        if (allBatchPayments.length > 1) {
          batchSiblings.push({
            date: new Date(allBatchPayments[0].date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            totalBatch: allBatchPayments.reduce((s, b) => s + b.amount, 0),
            invoices: allBatchPayments.map(
              (b) => `#${b.invoice} → ${formatCurrency(b.amount, currency)}`
            ),
          });
        }
      }

      const scheduleItems = acct.schedule || [];

      const getRemainingDue = (item: { total_due_amount: number | string; paid_amount: number | string }) =>
        Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));

      // An item is effectively paid if status is 'paid' OR paid_amount covers total_due
      const isEffectivelyPaid = (item: any) =>
        item.status === 'paid' || (Number(item.paid_amount) > 0 && Number(item.paid_amount) >= Number(item.total_due_amount));
      const unpaidSchedule = scheduleItems.filter(s => !isEffectivelyPaid(s) && s.status !== 'cancelled');

      msg += `━━━━━━━━━━━━━━━━━━\n`;
      msg += `📋 Inv # ${acct.account.invoice_number}\n`;
      if (totalPenalty > 0) {
        msg += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)} + ${formatCurrency(totalPenalty, currency)} (Penalty)\n`;
      } else {
        msg += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)}\n`;
      }
      msg += `Amount Paid: ${paymentBreakdownText}\n`;

      // Services in message
      const acctServices = (acct as any).services || [];
      const SERVICE_LABELS: Record<string, string> = {
        resize: 'Resize', certificate: 'Certificate', polish: 'Polish',
        change_color: 'Change Color', engraving: 'Engraving', repair: 'Repair', other: 'Other',
      };
      if (acctServices.length > 0) {
        const totalSvcAmt = acctServices.reduce((s: number, svc: any) => s + Number(svc.amount), 0);
        msg += `\n🔧 Additional Services:\n`;
        acctServices.forEach((svc: any) => {
          const label = SERVICE_LABELS[svc.service_type] || svc.service_type;
          msg += `  • ${label}${svc.description ? ` - ${svc.description}` : ''}: ${formatCurrency(Number(svc.amount), currency)}\n`;
        });
        msg += `  Services Total: ${formatCurrency(totalSvcAmt, currency)}\n`;
      }

      // Show split payment allocation details
      if (batchSiblings.length > 0) {
        for (const batch of batchSiblings) {
          msg += `💳 Split payment (${batch.date}): ${formatCurrency(batch.totalBatch, currency)} total\n`;
          for (const inv of batch.invoices) {
            msg += `   ${inv}\n`;
          }
        }
      }

      const laMonth = new Date(acct.account.end_date || acct.account.order_date).toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
      msg += `================\n`;
      const unpaidCount = unpaidSchedule.length;
      msg += `LA ${laMonth} remaining balance - ${formatCurrency(remainingBalance, currency)} to pay in ${unpaidCount} month${unpaidCount !== 1 ? 's' : ''}\n\n`;

      msg += `Monthly Payment:\n`;
      scheduleItems.forEach((item, idx) => {
        const effPaid = isEffectivelyPaid(item);
        const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
        const penalty = Number(item.penalty_amount);
        const baseAmt = Number(item.base_installment_amount);
        const paidAmt = Number(item.paid_amount);
        const totalDue = Number(item.total_due_amount);
        const displayAmt = effPaid ? Math.max(paidAmt, totalDue) : totalDue;
        const remainingDue = getRemainingDue(item);

        if (effPaid) {
          if (penalty > 0) {
            msg += `✅ ${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(displayAmt, currency)} (PAID)\n`;
          } else {
            msg += `✅ ${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(displayAmt, currency)} (PAID)\n`;
          }
        } else if (penalty > 0) {
          msg += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)}\n`;
        } else {
          msg += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(remainingDue, currency)}\n`;
        }
      });

      if (unpaidSchedule.length > 0) {
        const nextDate = new Date(unpaidSchedule[0].due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
        msg += `\nPlease note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n`;
      }
      msg += `\n`;
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
              {customer.customer_code} · {accounts.filter(a => a.account.status !== 'forfeited' && a.account.status !== 'cancelled').length} active account{accounts.filter(a => a.account.status !== 'forfeited' && a.account.status !== 'cancelled').length !== 1 ? 's' : ''}
              {customer.facebook_name && ` · @${customer.facebook_name}`}
            </p>
            {/* Location */}
            <div className="flex items-center gap-2 mt-1">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              {editingLocation ? (
                <div className="flex items-center gap-2">
                  <Select value={locationType} onValueChange={(v) => setLocationType(v as 'japan' | 'international')}>
                    <SelectTrigger className="h-7 text-xs w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="japan">Japan</SelectItem>
                      <SelectItem value="international">International</SelectItem>
                    </SelectContent>
                  </Select>
                  {locationType === 'international' && (
                    <Input
                      value={country}
                      onChange={e => setCountry(e.target.value)}
                      placeholder="Country"
                      className="h-7 text-xs w-32"
                      autoFocus
                    />
                  )}
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-emerald-500" onClick={async () => {
                    const loc = locationType === 'japan' ? 'Japan' : country.trim();
                    if (locationType === 'international' && !loc) { toast.error('Enter a country'); return; }
                    const { error } = await supabase.from('customers').update({ location: loc } as any).eq('id', customer.id);
                    if (error) { toast.error(error.message); return; }
                    toast.success('Location updated');
                    queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });
                    queryClient.invalidateQueries({ queryKey: ['customers'] });
                    setEditingLocation(false);
                  }}><Check className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => setEditingLocation(false)}><X className="h-3.5 w-3.5" /></Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 group">
                  <span className="text-xs text-muted-foreground">{(customer as any).location || 'Not set'}</span>
                  <Button variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" onClick={() => {
                    const loc = (customer as any).location || '';
                    if (loc === 'Japan' || !loc) { setLocationType('japan'); setCountry(''); }
                    else { setLocationType('international'); setCountry(loc); }
                    setEditingLocation(true);
                  }}><Pencil className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <MultiInvoicePaymentDialog
              customerId={customer.id}
              customerName={customer.full_name}
              accounts={accounts.map(({ account }) => ({
                id: account.id,
                invoice_number: account.invoice_number,
                currency: account.currency,
                remaining_balance: Number(account.remaining_balance),
                total_amount: Number(account.total_amount),
                total_paid: Number(account.total_paid),
                status: account.status,
              }))}
            />
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
        {accounts.map(({ account, schedule, penalties, schedulePaymentDates, services: acctServices }) => {
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
                    account.status === 'forfeited' ? 'bg-muted text-muted-foreground border-border' :
                    'bg-primary/10 text-primary border-primary/20'
                  }`}>
                    {account.status}
                  </Badge>
                  <Badge variant="outline" className="text-xs">{currency}</Badge>
                </div>
                <div className="flex gap-2 items-center">
                  {account.status !== 'completed' && account.status !== 'forfeited' && remainingBalance > 0 && (
                    <>
                      <RecordPaymentDialog
                        accountId={account.id}
                        currency={currency}
                        remainingBalance={remainingBalance}
                      />
                      <RecordPaymentDialog
                        accountId={account.id}
                        currency={currency}
                        remainingBalance={remainingBalance}
                        payFullBalance
                      />
                    </>
                  )}
                  {account.status !== 'completed' && account.status !== 'forfeited' && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="outline" size="sm" className="text-xs border-destructive/30 text-destructive hover:bg-destructive/10">
                          <Ban className="h-3 w-3 mr-1" /> Forfeit
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Forfeit INV #{account.invoice_number}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will mark the account as forfeited. The remaining balance of {formatCurrency(remainingBalance, currency)} will be written off. This action cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => {
                              forfeitAccount.mutate(account.id, {
                                onSuccess: () => {
                                  toast.success(`INV #${account.invoice_number} forfeited`);
                                  queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });
                                },
                                onError: (err) => toast.error(err.message),
                              });
                            }}
                          >
                            Forfeit
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
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
                  {account.status === 'completed' && (
                    <Badge variant="outline" className="text-[10px] bg-success/10 text-success border-success/20 ml-1">Paid in Full</Badge>
                  )}
                </h3>
                {schedule.filter(item => item.status !== 'cancelled').map((item) => {
                  const isPaid = item.status === 'paid';
                  const penaltyAmt = Number(item.penalty_amount);
                  const baseAmt = Number(item.base_installment_amount);
                  const paidAmt = Number(item.paid_amount);
                  const actualPayDate = schedulePaymentDates?.[item.id];
                  const displayDate = isPaid && actualPayDate
                    ? new Date(actualPayDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
                            {displayDate}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {isPaid ? `Paid${actualPayDate ? '' : ''}` : `Due · Month ${item.installment_number}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        {penaltyAmt > 0 ? (
                          <div>
                            <p className={`text-xs font-semibold tabular-nums ${isPaid ? 'text-success' : 'text-card-foreground'}`}>
                              {formatCurrency(Number(item.total_due_amount), currency)}
                            </p>
                            <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                              <AlertTriangle className="h-2.5 w-2.5" />
                              {isPaid ? 'Incl.' : '+'}{formatCurrency(penaltyAmt, currency)}
                            </p>
                          </div>
                        ) : (
                          <p className={`text-xs font-semibold tabular-nums ${isPaid ? 'text-success' : 'text-card-foreground'}`}>
                            {isPaid ? formatCurrency(Number(item.total_due_amount), currency) : formatCurrency(baseAmt, currency)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Additional Services */}
              {(acctServices as any[] || []).length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                    <Wrench className="h-3.5 w-3.5 text-primary" /> Additional Services
                    <span className="ml-auto text-xs font-bold text-card-foreground tabular-nums">
                      Total: {formatCurrency((acctServices as any[]).reduce((s: number, svc: any) => s + Number(svc.amount), 0), currency)}
                    </span>
                  </h3>
                  {(acctServices as any[]).map((svc: any) => (
                    <div key={svc.id} className="flex items-center justify-between p-2 rounded-lg border border-border bg-card">
                      <div className="flex items-center gap-2">
                        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-primary">
                          <Wrench className="h-2.5 w-2.5" />
                        </div>
                        <div>
                          <p className="text-xs font-medium text-card-foreground">
                            {svc.service_type === 'change_color' ? 'Change Color' : svc.service_type.charAt(0).toUpperCase() + svc.service_type.slice(1)}
                          </p>
                          {svc.description && <p className="text-[10px] text-muted-foreground">{svc.description}</p>}
                        </div>
                      </div>
                      <p className="text-xs font-semibold tabular-nums text-card-foreground">
                        {formatCurrency(Number(svc.amount), currency)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
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
