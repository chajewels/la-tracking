import { useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, MessageCircle, Check, AlertTriangle, Calendar, Pencil, Ban, X, Save, RotateCcw, Trash2, DollarSign, Wrench } from 'lucide-react';
import ReassignOwnerDialog from '@/components/accounts/ReassignOwnerDialog';
import AddServiceDialog from '@/components/services/AddServiceDialog';
import ServicesList, { AccountService } from '@/components/services/ServicesList';
import AddPenaltyDialog from '@/components/penalties/AddPenaltyDialog';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import RecordPaymentDialog from '@/components/payments/RecordPaymentDialog';
import PenaltyWaiverPanel from '@/components/penalties/PenaltyWaiverPanel';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useAccount, useSchedule, usePayments, usePenalties, useVoidPayment, useEditPayment, useRestorePayment, useDeleteAccount, useForfeitAccount, useAccountServices } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';

export default function AccountDetail() {
  const { id } = useParams();
  const { data: account, isLoading: accountLoading } = useAccount(id);
  const { data: schedule } = useSchedule(id);
  const { data: payments } = usePayments(id);
  const { data: penalties } = usePenalties(id);
  const { data: services } = useAccountServices(id);
  const [copied, setCopied] = useState(false);
  const voidPayment = useVoidPayment();
  const editPayment = useEditPayment();
  const restorePayment = useRestorePayment();
  const deleteAccount = useDeleteAccount();
  const forfeitAccount = useForfeitAccount();
  const navigate = useNavigate();
  const [voidTarget, setVoidTarget] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editMethod, setEditMethod] = useState('');
  const [editRemarks, setEditRemarks] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [forfeitConfirmOpen, setForfeitConfirmOpen] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [editScheduleAmount, setEditScheduleAmount] = useState('');
  const [editScheduleLoading, setEditScheduleLoading] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState(false);
  const [invoiceInput, setInvoiceInput] = useState('');
  const [invoiceSaving, setInvoiceSaving] = useState(false);
  const queryClient = useQueryClient();

  const handleInvoiceSave = useCallback(async () => {
    const trimmed = invoiceInput.trim();
    if (!trimmed || !account) return;
    if (trimmed === account.invoice_number) {
      setEditingInvoice(false);
      return;
    }
    setInvoiceSaving(true);
    try {
      const { error } = await supabase
        .from('layaway_accounts')
        .update({ invoice_number: trimmed })
        .eq('id', account.id);
      if (error) {
        if (error.message.includes('duplicate key') || error.message.includes('invoice_number')) {
          toast.error(`Invoice number "${trimmed}" already exists.`);
        } else {
          toast.error(error.message);
        }
        return;
      }
      await supabase.from('audit_logs').insert({
        entity_type: 'layaway_account',
        entity_id: account.id,
        action: 'update_invoice_number',
        old_value_json: { invoice_number: account.invoice_number },
        new_value_json: { invoice_number: trimmed },
        performed_by_user_id: (await supabase.auth.getUser()).data.user?.id,
      });
      queryClient.invalidateQueries({ queryKey: ['account', account.id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(`Invoice number updated to ${trimmed}`);
      setEditingInvoice(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setInvoiceSaving(false);
    }
  }, [invoiceInput, account, queryClient]);

  const handleEditScheduleSubmit = useCallback(async (scheduleId: string) => {
    const amount = parseFloat(editScheduleAmount);
    if (isNaN(amount) || amount < 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setEditScheduleLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('edit-schedule-item', {
        body: { schedule_id: scheduleId, new_base_amount: amount },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success('Installment amount updated');
      queryClient.invalidateQueries({ queryKey: ['schedule', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts', id] });
      setEditingScheduleId(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setEditScheduleLoading(false);
    }
  }, [editScheduleAmount, id, queryClient]);

  if (accountLoading) {
    return (
      <AppLayout>
        <div className="space-y-6 max-w-5xl">
          <Skeleton className="h-10 w-64" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!account) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Account not found</p>
        </div>
      </AppLayout>
    );
  }

  const currency = account.currency as Currency;
  const totalAmount = Number(account.total_amount);
  const totalPaid = Number(account.total_paid);
  // Compute remaining balance from schedule to account for overpayment reductions
  const remainingBalance = (schedule || []).reduce((sum, item) => {
    if (item.status === 'paid' || item.status === 'cancelled') return sum;
    return sum + Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
  }, 0);
  const downpaymentAmount = Number((account as any).downpayment_amount || 0);
  const accountServices = ((services || []) as AccountService[]);
  const totalServicesAmount = accountServices.reduce((s, svc) => s + Number(svc.amount), 0);
  const totalLayawayAmount = totalAmount + totalServicesAmount;
  const progress = totalLayawayAmount > 0 ? (totalPaid / totalLayawayAmount) * 100 : 0;

  const unpaidPenalties = (penalties || []).filter(p => p.status === 'unpaid');
  const totalPenalty = unpaidPenalties.reduce((s, p) => s + Number(p.penalty_amount), 0);
  const accountServices = (services || []) as AccountService[];
  const totalServicesAmount = accountServices.reduce((s, svc) => s + Number(svc.amount), 0);

  const SERVICE_LABELS: Record<string, string> = {
    resize: 'Resize', certificate: 'Certificate', polish: 'Polish',
    change_color: 'Change Color', engraving: 'Engraving', repair: 'Repair', other: 'Other',
  };

  // Build message from schedule + active payment data
  const scheduleItems = schedule || [];
  const unpaidSchedule = scheduleItems.filter(s => s.status !== 'paid');
  const activePayments = [...(payments || [])]
    .filter(payment => !payment.voided_at)
    .sort((a, b) => {
      const dateDiff = new Date(a.date_paid).getTime() - new Date(b.date_paid).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  const paymentBreakdownText = activePayments.length > 0
    ? `${activePayments.map(payment => formatCurrency(Number(payment.amount_paid), payment.currency as Currency)).join(' + ')} = ${formatCurrency(totalPaid, currency)}`
    : formatCurrency(totalPaid, currency);
  let paymentCounter = 0;
  const paymentDetails = activePayments.map((payment) => {
    const dateStr = new Date(payment.date_paid).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    const isDownpayment = payment.remarks?.toLowerCase().includes('downpayment') ||
      (downpaymentAmount > 0 && Math.abs(Number(payment.amount_paid) - downpaymentAmount) < 1);
    const label = isDownpayment ? '30% Downpayment' : `Payment ${++paymentCounter}`;
    return `${label} ${dateStr}: ${formatCurrency(Number(payment.amount_paid), payment.currency as Currency)}`;
  });
  const ordinals = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
  const getRemainingDue = (item: { total_due_amount: number | string; paid_amount: number | string }) =>
    Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
  const getOverpaymentCredit = (item: { total_due_amount: number | string; paid_amount: number | string; status: string }) =>
    item.status === 'paid'
      ? Math.max(0, Number(item.paid_amount) - Number(item.total_due_amount))
      : 0;

  // Find the most recent payment for the thank-you line
  const mostRecentPayment = activePayments.length > 0
    ? [...activePayments].sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    : null;

  let message = `✨ Cha Jewels Layaway Payment Summary\n\n`;
  if (mostRecentPayment) {
    message += `Thank you for your payment. ${formatCurrency(Number((mostRecentPayment as any).amount_paid), currency)} has been received.\n\n`;
  }
  message += `Inv # ${account.invoice_number}\n`;
  if (totalPenalty > 0) {
    message += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)} + ${formatCurrency(totalPenalty, currency)} (Penalty)\n`;
  } else {
    message += `Total Layaway Amount: ${formatCurrency(totalAmount, currency)}\n`;
  }
  message += `Amount Paid: ${paymentBreakdownText}\n`;
  // Services in message
  if (accountServices.length > 0) {
    message += `\n🔧 Additional Services:\n`;
    accountServices.forEach(svc => {
      const label = SERVICE_LABELS[svc.service_type] || svc.service_type;
      message += `  • ${label}${svc.description ? ` - ${svc.description}` : ''}: ${formatCurrency(Number(svc.amount), currency)}\n`;
    });
    message += `  Services Total: ${formatCurrency(totalServicesAmount, currency)}\n`;
  }
  const laRemainingText = `LA ${new Date(account.end_date || account.order_date).toLocaleDateString('en-US', { month: 'short' }).toUpperCase()} remaining balance`;
  message += `================\n`;
  const unpaidCount = scheduleItems.filter(s => s.status !== 'paid' && s.status !== 'cancelled').length;
  message += `${laRemainingText} - ${formatCurrency(remainingBalance, currency)} to pay in ${unpaidCount} months\n\n`;

  message += `Payment Schedule:\n\n`;
  scheduleItems.forEach((item, idx) => {
    const isPaid = item.status === 'paid';
    const isPartial = item.status === 'partially_paid';
    const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    const penalty = Number(item.penalty_amount);
    const totalDue = Number(item.total_due_amount);
    const paid = Number(item.paid_amount);
    const remainingDue = getRemainingDue(item);
    const overpaymentCredit = getOverpaymentCredit(item);

    if (isPaid) {
      if (penalty > 0) {
        message += `✅ ${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(Number(item.base_installment_amount), currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)} (PAID)\n`;
      } else {
        message += `✅ ${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(totalDue, currency)} (PAID)\n`;
      }
    } else if (isPartial) {
      message += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(totalDue, currency)}${penalty > 0 ? ` (includes ${formatCurrency(penalty, currency)} penalty)` : ''}\n`;
    } else if (penalty > 0) {
      message += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(Number(item.base_installment_amount), currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)}\n`;
    } else {
      message += `${ordinals[idx] || `${idx + 1}th`} month ${dateStr}: ${formatCurrency(remainingDue, currency)}\n`;
    }
  });
  if (unpaidSchedule.length > 0) {
    const nextDate = new Date(unpaidSchedule[0].due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    message += `\nPlease note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n\n`;
    message += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;
  }

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
          <Link to="/accounts">
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              {editingInvoice ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={invoiceInput}
                    onChange={e => setInvoiceInput(e.target.value)}
                    className="h-8 w-40 text-sm"
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleInvoiceSave();
                      if (e.key === 'Escape') setEditingInvoice(false);
                    }}
                  />
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleInvoiceSave} disabled={invoiceSaving}>
                    <Check className="h-3.5 w-3.5 text-success" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingInvoice(false)}>
                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">INV #{account.invoice_number}</h1>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => { setInvoiceInput(account.invoice_number); setEditingInvoice(true); }}
                    title="Edit invoice number"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
              <Badge variant="outline" className={
                account.status === 'forfeited' ? 'bg-orange-500/10 text-orange-500 border-orange-500/20 text-xs' :
                account.status === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/20 text-xs' :
                account.status === 'completed' ? 'bg-primary/10 text-primary border-primary/20 text-xs' :
                'bg-success/10 text-success border-success/20 text-xs'
              }>
                {account.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              {account.customers?.full_name} · {account.payment_plan_months}-Month Plan · {currency}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <ReassignOwnerDialog
              accountId={account.id}
              currentCustomerId={account.customer_id}
              currentCustomerName={account.customers?.full_name || 'Unknown'}
              invoiceNumber={account.invoice_number}
            />
            {remainingBalance > 0 && account.status !== 'forfeited' && account.status !== 'cancelled' && (
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
            {account.customers?.messenger_link && (
              <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="border-info/30 text-info hover:bg-info/10">
                  <MessageCircle className="h-4 w-4 mr-2" /> Messenger
                </Button>
              </a>
            )}
            {account.status !== 'forfeited' && account.status !== 'cancelled' && (
              <AddServiceDialog accountId={account.id} currency={currency} />
            )}
            {(account.status === 'active' || account.status === 'overdue') && (
              <>
                <AddPenaltyDialog
                  accountId={account.id}
                  currency={currency}
                  scheduleItems={(schedule || []).map(s => ({
                    id: s.id,
                    installment_number: s.installment_number,
                    due_date: s.due_date,
                    base_installment_amount: Number(s.base_installment_amount),
                    status: s.status,
                  }))}
                />
                <Button
                  variant="outline"
                  className="border-orange-500/30 text-orange-500 hover:bg-orange-500/10"
                  onClick={() => setForfeitConfirmOpen(true)}
                >
                  <AlertTriangle className="h-4 w-4 mr-2" /> Forfeit
                </Button>
              </>
            )}
            <Button
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Delete Account
            </Button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4">
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Amount</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(totalAmount, currency)}
            </p>
          </div>
          {downpaymentAmount > 0 && (
            <div className="rounded-xl border border-primary/20 bg-card p-3 sm:p-4">
              <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">30% Downpayment</p>
              <p className="text-lg sm:text-xl font-bold text-primary font-display tabular-nums">
                {formatCurrency(downpaymentAmount, currency)}
              </p>
            </div>
          )}
          <div className="rounded-xl border border-success/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Paid</p>
            <p className="text-lg sm:text-xl font-bold text-success font-display tabular-nums">
              {formatCurrency(totalPaid, currency)}
            </p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Remaining</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(remainingBalance, currency)}
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
              {/* 30% Downpayment row */}
              {downpaymentAmount > 0 && (
                <div className="flex items-center justify-between p-2.5 sm:p-3 rounded-lg border bg-primary/5 border-primary/10">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="flex h-6 w-6 sm:h-7 sm:w-7 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold bg-primary/20 text-primary">
                      DP
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm font-medium text-card-foreground">30% Downpayment</p>
                      <p className="text-[10px] sm:text-xs text-muted-foreground">Due on order date</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs sm:text-sm font-semibold tabular-nums text-primary">
                      {formatCurrency(downpaymentAmount, currency)}
                    </p>
                  </div>
                </div>
              )}
              {scheduleItems.map((item) => {
                const isPaid = item.status === 'paid';
                const isPartial = item.status === 'partially_paid';
                const penaltyAmt = Number(item.penalty_amount);
                const paidAmt = Number(item.paid_amount);
                const totalDue = Number(item.total_due_amount);
                const baseAmt = Number(item.base_installment_amount);
                const remainingDue = getRemainingDue(item);
                const overpaymentCredit = getOverpaymentCredit(item);
                const isEditingThis = editingScheduleId === item.id;
                const canEdit = account.status !== 'forfeited' && account.status !== 'cancelled' && item.status !== 'cancelled';
                return (
                  <div key={item.id}
                    className={`group flex items-center justify-between p-2.5 sm:p-3 rounded-lg border ${
                      isPaid ? 'bg-success/5 border-success/10' : 'bg-card border-border'
                    }`}
                  >
                    <div className="flex items-center gap-2 sm:gap-3">
                      <div className={`flex h-6 w-6 sm:h-7 sm:w-7 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold ${
                        isPaid ? 'bg-success/20 text-success' : 'bg-muted text-muted-foreground'
                      }`}>
                        {isPaid ? <Check className="h-3 w-3" /> : item.installment_number}
                      </div>
                      <div>
                        <p className="text-xs sm:text-sm font-medium text-card-foreground">
                          {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        <p className="text-[10px] sm:text-xs text-muted-foreground">
                          {isPaid ? 'Paid' : `Month ${item.installment_number}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isEditingThis ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            type="number"
                            value={editScheduleAmount}
                            onChange={(e) => setEditScheduleAmount(e.target.value)}
                            className="h-7 w-24 text-xs bg-background tabular-nums"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleEditScheduleSubmit(item.id);
                              if (e.key === 'Escape') setEditingScheduleId(null);
                            }}
                          />
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-success" disabled={editScheduleLoading}
                            onClick={() => handleEditScheduleSubmit(item.id)}>
                            <Save className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground"
                            onClick={() => setEditingScheduleId(null)}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <>
                           <div className="text-right">
                            <p className={`text-xs sm:text-sm font-semibold tabular-nums ${isPaid ? 'text-success' : 'text-card-foreground'}`}>
                              {formatCurrency(isPaid ? totalDue : totalDue, currency)}
                            </p>
                            {paidAmt > 0 && !isPaid ? (
                              <p className="text-[10px] text-muted-foreground tabular-nums">
                                Paid {formatCurrency(paidAmt, currency)} of {formatCurrency(totalDue, currency)}
                              </p>
                            ) : penaltyAmt > 0 ? (
                              <p className="text-[10px] text-destructive flex items-center gap-1 justify-end">
                                <AlertTriangle className="h-2.5 w-2.5" />
                                {isPaid ? 'Incl.' : 'Includes'} {formatCurrency(penaltyAmt, currency)} penalty
                              </p>
                            ) : null}
                          </div>
                          {canEdit && (
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Edit installment amount"
                              onClick={() => {
                                setEditingScheduleId(item.id);
                                setEditScheduleAmount(String(baseAmt));
                              }}>
                              <Pencil className="h-3 w-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {scheduleItems.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No schedule generated yet</p>
              )}
            </div>
          </div>

          {/* Additional Services */}
          {accountServices.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <ServicesList services={accountServices} currency={currency} accountId={account.id} />
            </div>
          )}

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
              {account.customers?.messenger_link && (
                <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="border-info/30 text-info hover:bg-info/10">
                    <MessageCircle className="h-3.5 w-3.5 mr-1" /> Messenger
                  </Button>
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Penalty Waiver Panel */}
        {unpaidPenalties.length > 0 && (
          <PenaltyWaiverPanel
            accountId={account.id}
            invoiceNumber={account.invoice_number}
            currency={currency}
            penalties={unpaidPenalties.map(p => ({
              id: p.id,
              scheduleId: p.schedule_id,
              amount: Number(p.penalty_amount),
              stage: p.penalty_stage,
            }))}
          />
        )}

        {/* Payment History */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4">Payment History</h3>
          {(!payments || payments.length === 0) ? (
            <p className="text-sm text-muted-foreground">No payments recorded yet</p>
          ) : (
            <div className="space-y-2">
              {payments.map((p) => {
                const isVoided = !!(p as any).voided_at;
                const isEditing = editingId === p.id;

                if (isEditing) {
                  return (
                    <div key={p.id} className="p-3 rounded-lg border border-primary/30 bg-muted/30 space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Date</label>
                          <Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} className="h-8 text-xs bg-background" />
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Method</label>
                          <Select value={editMethod} onValueChange={setEditMethod}>
                            <SelectTrigger className="h-8 text-xs bg-background"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cash">Cash</SelectItem>
                              <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                              <SelectItem value="gcash">GCash</SelectItem>
                              <SelectItem value="other">Other</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Amount (read-only)</label>
                          <Input disabled value={formatCurrency(Number(p.amount_paid), p.currency as Currency)} className="h-8 text-xs bg-muted" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground uppercase">Notes</label>
                        <Textarea value={editRemarks} onChange={(e) => setEditRemarks(e.target.value)} rows={1} className="text-xs bg-background resize-none" />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                          <X className="h-3 w-3 mr-1" /> Cancel
                        </Button>
                        <Button size="sm" className="gold-gradient text-primary-foreground" disabled={editPayment.isPending}
                          onClick={async () => {
                            try {
                              await editPayment.mutateAsync({
                                id: p.id,
                                date_paid: editDate,
                                payment_method: editMethod,
                                remarks: editRemarks || undefined,
                              });
                              toast.success('Payment updated');
                              setEditingId(null);
                            } catch (err: any) {
                              toast.error(err.message || 'Failed to update');
                            }
                          }}>
                          <Save className="h-3 w-3 mr-1" /> Save
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={p.id} className={`flex items-center justify-between py-2 px-2 rounded-lg border-b border-border last:border-0 ${isVoided ? 'opacity-50 line-through' : ''}`}>
                    <div className="flex-1">
                      <p className="text-xs sm:text-sm text-card-foreground">
                        {new Date(p.date_paid).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                      </p>
                      <p className="text-[10px] sm:text-xs text-muted-foreground">
                        {p.payment_method || 'Cash'}
                        {p.remarks && ` · ${p.remarks}`}
                        {isVoided && ` · VOIDED${(p as any).void_reason ? `: ${(p as any).void_reason}` : ''}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className={`text-xs sm:text-sm font-semibold tabular-nums ${isVoided ? 'text-muted-foreground' : 'text-success'}`}>
                        {isVoided ? '' : '+'}{formatCurrency(Number(p.amount_paid), p.currency as Currency)}
                      </p>
                      {!isVoided && (
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => {
                              setEditingId(p.id);
                              setEditDate(p.date_paid);
                              setEditMethod(p.payment_method || 'cash');
                              setEditRemarks(p.remarks || '');
                            }}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => { setVoidTarget(p.id); setVoidReason(''); }}>
                            <Ban className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                      {isVoided && (
                        <Button variant="ghost" size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-success"
                          style={{ textDecoration: 'none' }}
                          disabled={restorePayment.isPending}
                          onClick={async () => {
                            try {
                              await restorePayment.mutateAsync({ payment_id: p.id });
                              toast.success('Payment restored successfully');
                            } catch (err: any) {
                              toast.error(err.message || 'Failed to restore payment');
                            }
                          }}>
                          <RotateCcw className="h-3 w-3 mr-1" />
                          {restorePayment.isPending ? 'Restoring…' : 'Restore'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Void Confirmation Dialog */}
        <AlertDialog open={!!voidTarget} onOpenChange={(open) => { if (!open) setVoidTarget(null); }}>
          <AlertDialogContent className="bg-card border-border">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-card-foreground">Void Payment</AlertDialogTitle>
              <AlertDialogDescription>
                This will reverse the payment and restore the balance. The payment record will be kept for audit purposes. Amount changes require voiding and re-entering.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground">Reason (optional)</label>
              <Textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={2} placeholder="e.g. Recorded wrong amount" className="bg-background border-border text-sm resize-none" />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-border">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={voidPayment.isPending}
                onClick={async () => {
                  if (!voidTarget) return;
                  try {
                    await voidPayment.mutateAsync({ payment_id: voidTarget, reason: voidReason || undefined });
                    toast.success('Payment voided successfully');
                    setVoidTarget(null);
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to void payment');
                  }
                }}>
                {voidPayment.isPending ? 'Voiding…' : 'Void Payment'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Forfeit Account Confirmation */}
        <AlertDialog open={forfeitConfirmOpen} onOpenChange={setForfeitConfirmOpen}>
          <AlertDialogContent className="bg-card border-border">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-card-foreground">Forfeit Account?</AlertDialogTitle>
              <AlertDialogDescription>
                This will mark INV #{account.invoice_number} as forfeited. The customer will be flagged as a high-risk payer. Payments can no longer be recorded on this account.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-border">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-orange-600 text-white hover:bg-orange-700"
                disabled={forfeitAccount.isPending}
                onClick={async () => {
                  try {
                    await forfeitAccount.mutateAsync(account.id);
                    toast.success(`Account INV #${account.invoice_number} forfeited`);
                    setForfeitConfirmOpen(false);
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to forfeit account');
                  }
                }}>
                {forfeitAccount.isPending ? 'Forfeiting…' : 'Forfeit Account'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete Account Confirmation */}
        <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <AlertDialogContent className="bg-card border-border">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-card-foreground">Delete Account?</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently delete INV #{account.invoice_number} and all associated payments, schedule, and penalties. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-border">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteAccount.isPending}
                onClick={async () => {
                  try {
                    await deleteAccount.mutateAsync(account.id);
                    toast.success(`Account INV #${account.invoice_number} deleted`);
                    navigate('/accounts');
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to delete account');
                  }
                }}>
                {deleteAccount.isPending ? 'Deleting…' : 'Delete Account'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AppLayout>
  );
}
