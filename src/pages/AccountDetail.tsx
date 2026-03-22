import { useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Copy, MessageCircle, Check, AlertTriangle, Calendar, Pencil, Ban, X, Save, RotateCcw, Trash2, DollarSign, Wrench, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { canPerformAction, type AppRole } from '@/lib/role-permissions';
import StatementShareMenu from '@/components/statement/StatementShareMenu';
import RestorePaymentDialog from '@/components/payments/RestorePaymentDialog';
import ReassignOwnerDialog from '@/components/accounts/ReassignOwnerDialog';
import AddServiceDialog from '@/components/services/AddServiceDialog';
import ServicesList, { AccountService } from '@/components/services/ServicesList';
import AddPenaltyDialog from '@/components/penalties/AddPenaltyDialog';
import ApplyPenaltyCapDialog from '@/components/penalties/ApplyPenaltyCapDialog';
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
import { useAccount, useSchedule, usePayments, usePenalties, useVoidPayment, useEditPayment, useRestorePayment, useDeleteAccount, useForfeitAccount, useAccountServices, usePenaltyCapOverride } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import {
  isEffectivelyPaid, isPartiallyPaid, remainingDue, remainingPrincipalDue, computeRemainingBalance,
  getUnpaidScheduleItems, getActivePayments, accountProgress,
  ordinal, SERVICE_LABELS, getNextPaymentStatementDate,
  isPenaltyOverCap, isFinalSettlement, isExtensionActive, isFinalForfeited,
  getForfeitureWarning,
  canReactivate, canAcceptPayment, canAddService, canAddPenalty,
  computeAccountSummary,
} from '@/lib/business-rules';

export default function AccountDetail() {
  const { id } = useParams();
  const { data: account, isLoading: accountLoading } = useAccount(id);
  const { data: schedule } = useSchedule(id);
  const { data: payments } = usePayments(id);
  const { data: penalties } = usePenalties(id);
  const { data: services } = useAccountServices(id);
  const { data: penaltyCapOverride } = usePenaltyCapOverride(id);
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
  const [restoreTarget, setRestoreTarget] = useState<{ id: string; amount: number; date: string } | null>(null);
  const [forfeitConfirmOpen, setForfeitConfirmOpen] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [editScheduleAmount, setEditScheduleAmount] = useState('');
  const [editScheduleLoading, setEditScheduleLoading] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState(false);
  const [invoiceInput, setInvoiceInput] = useState('');
  const [invoiceSaving, setInvoiceSaving] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const r = roles as AppRole[];
  const can = (action: Parameters<typeof canPerformAction>[1]) => canPerformAction(r, action);


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
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
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
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['accounts', id] });
      queryClient.invalidateQueries({ queryKey: ['penalties', id] });
      queryClient.invalidateQueries({ queryKey: ['account-services', id] });
      queryClient.invalidateQueries({ queryKey: ['payments', id] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
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
  const principalTotal = Number(account.total_amount);
  const scheduleItems = schedule || [];
  const downpaymentAmount = Number((account as any).downpayment_amount || 0);

  // SINGLE SOURCE OF TRUTH: derive totalPaid from actual confirmed payment records,
  // NOT from the stored account.total_paid field which may be stale.
  const confirmedActivePayments = getActivePayments(payments || []);
  const totalPaid = confirmedActivePayments.reduce((sum, p) => sum + Number(p.amount_paid), 0);
  const remainingBalance = computeRemainingBalance(scheduleItems, principalTotal, totalPaid);
  const accountServices = ((services || []) as AccountService[]);
  const totalServicesAmount = accountServices.reduce((s, svc) => s + Number(svc.amount), 0);
  const unpaidPenalties = (penalties || []).filter(p => p.status === 'unpaid');
  const unpaidPenaltySum = unpaidPenalties.reduce((sum, penalty) => sum + Number(penalty.penalty_amount), 0);

  // SINGLE SOURCE OF TRUTH: shared summary values used by cards, message, statement, portal
  const summary = computeAccountSummary({
    principalTotal,
    totalPaid,
    unpaidPenaltySum,
    totalServicesAmount,
  });

  // Keep principal-based totals as the single source of truth.
  // Penalties and services are shown separately and must not inflate the layaway principal.
  const scheduleBaseSum = scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount), 0);
  const schedulePenaltySum = scheduleItems.reduce((s, i) => s + Number(i.penalty_amount), 0);
  const originalPrincipal = downpaymentAmount + scheduleBaseSum;
  const progress = summary.progressPercent;

  // Reconciliation validation: principal total - paid must equal remaining principal balance
  const reconciliationValid = Math.abs(principalTotal - totalPaid - remainingBalance) < 1;

  const unpaidSchedule = getUnpaidScheduleItems(scheduleItems);
  const activePayments = [...confirmedActivePayments]
    .sort((a, b) => {
      const dateDiff = new Date(a.date_paid).getTime() - new Date(b.date_paid).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  const paymentBreakdownText = activePayments.length > 0
    ? `${activePayments.map(payment => formatCurrency(Number(payment.amount_paid), payment.currency as Currency)).join(' + ')} = ${formatCurrency(totalPaid, currency)}`
    : formatCurrency(totalPaid, currency);

  // Find the most recent payment for the thank-you line
  const mostRecentPayment = activePayments.length > 0
    ? [...activePayments].sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    : null;

  const isForfeited = account.status === 'forfeited';
  const isSettlement = account.status === 'final_settlement';
  const isFinalForfeit = account.status === 'final_forfeited';
  const isExtension = account.status === 'extension_active';


  let message = `✨ Cha Jewels Layaway Payment Summary\n\n`;

  // Shared message block for summary values (used across all statuses)
  const appendSummaryBlock = () => {
    message += `Total Layaway Amount: ${formatCurrency(summary.principalTotal, currency)}\n`;
    if (summary.totalServices > 0) message += `Additional Services: ${formatCurrency(summary.totalServices, currency)}\n`;
    if (summary.outstandingPenalties > 0) message += `Outstanding Penalties: ${formatCurrency(summary.outstandingPenalties, currency)}\n`;
    message += `Amount Paid: ${paymentBreakdownText}\n`;
  };

  const appendPayableBlock = () => {
    message += `================\n`;
    message += `Remaining Principal: ${formatCurrency(summary.remainingPrincipal, currency)}\n`;
    if (summary.outstandingPenalties > 0) {
      message += `Current Total Payable: ${formatCurrency(summary.currentTotalPayable, currency)}\n`;
    }
  };

  if (isFinalForfeit) {
    message += `🚫 PERMANENT FORFEITURE NOTICE\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Status: PERMANENTLY FORFEITED\n`;
    appendSummaryBlock();
    message += `\nYour account is permanently forfeited.\nNo further reactivation or negotiation is allowed.\n`;
    message += `\nFor any questions, please contact Cha Jewels directly.`;
  } else if (isForfeited) {
    message += `⛔ NOTICE: This layaway account has been FORFEITED due to extended non-payment.\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Status: FORFEITED\n`;
    appendSummaryBlock();
    message += `\nNo further installment payments are being accepted for this account.\n`;
    message += `\nFor any questions, please contact Cha Jewels directly.`;
  } else if (isExtension) {
    message += `🔄 REACTIVATION NOTICE\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Your account has been reactivated as a one-time consideration.\n`;
    message += `You are given a final extension of 1 month${(account as any).extension_end_date ? ` (until ${new Date((account as any).extension_end_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })})` : ''}.\n`;
    message += `Penalty charges will continue to apply based on the existing schedule.\n`;
    message += `No further extensions will be allowed.\n\n`;
    appendSummaryBlock();
    appendPayableBlock();
    message += `\nMonthly Payment:\n`;
    scheduleItems.forEach((item, idx) => {
      const effPaid = isEffectivelyPaid(item);
      const partial = isPartiallyPaid(item);
      const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      const penalty = Number(item.penalty_amount);
      const baseAmt = Number(item.base_installment_amount);
      const paidAmt = Number(item.paid_amount);
      const totalDue = baseAmt + penalty;
      if (effPaid) {
        message += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} (PAID)\n`;
      } else if (partial) {
        const itemRemaining = Math.max(0, baseAmt - paidAmt);
        message += `🔶 ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}`;
        if (penalty > 0) message += ` + ${formatCurrency(penalty, currency)} (Penalty)`;
        message += ` — ${formatCurrency(paidAmt, currency)} paid, ${formatCurrency(itemRemaining, currency)} remaining\n`;
      } else if (penalty > 0) {
        message += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}  + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)}\n`;
      } else {
        message += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}\n`;
      }
    });
    message += `\nPlease settle promptly to avoid permanent forfeiture. 💛`;
  } else if (isSettlement) {
    message += `⚠️ FINAL SETTLEMENT NOTICE\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Your account has reached final settlement.\nThe total amount is final and must be settled.\n\n`;
    appendSummaryBlock();
    message += `================\n`;
    message += `Remaining Principal: ${formatCurrency(summary.remainingPrincipal, currency)}\n`;
    if (summary.outstandingPenalties > 0) {
      message += `⚠️ FINAL SETTLEMENT AMOUNT: ${formatCurrency(summary.currentTotalPayable, currency)}\n\n`;
      message += `This amount includes:\n`;
      message += `  • Remaining principal: ${formatCurrency(summary.remainingPrincipal, currency)}\n`;
      message += `  • Outstanding penalties: ${formatCurrency(summary.outstandingPenalties, currency)}\n`;
    } else {
      message += `⚠️ FINAL SETTLEMENT AMOUNT: ${formatCurrency(summary.remainingPrincipal, currency)}\n\n`;
    }
    message += `\nRegular installment schedule is no longer active.\n`;
    message += `Please settle the full amount above to complete your layaway.\n\n`;
    message += `Monthly Payment History:\n`;
    scheduleItems.forEach((item, idx) => {
      const effPaid = isEffectivelyPaid(item);
      const partial = isPartiallyPaid(item);
      const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      const penalty = Number(item.penalty_amount);
      const baseAmt = Number(item.base_installment_amount);
      const paidAmt = Number(item.paid_amount);
      const totalDue = baseAmt + penalty;
      const displayAmt = effPaid ? Math.max(paidAmt, totalDue) : totalDue;
      const itemRemaining = Math.max(0, totalDue - paidAmt);
      if (effPaid) {
        message += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(displayAmt, currency)} (PAID)\n`;
      } else if (partial) {
        const principalRemaining = Math.max(0, baseAmt - paidAmt);
        message += `🔶 ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}`;
        if (penalty > 0) message += ` + ${formatCurrency(penalty, currency)} (Penalty)`;
        message += ` — ${formatCurrency(paidAmt, currency)} paid, ${formatCurrency(principalRemaining, currency)} remaining (PARTIAL)\n`;
      } else if (penalty > 0) {
        message += `❌ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(itemRemaining, currency)} (UNPAID)\n`;
      } else {
        message += `❌ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(itemRemaining, currency)} (UNPAID)\n`;
      }
    });
    message += `\nFor any questions, please contact Cha Jewels directly. 💛`;
  } else {
    // Normal active/overdue message
    if (mostRecentPayment) {
      message += `Thank you for your payment. ${formatCurrency(Number((mostRecentPayment as any).amount_paid), currency)} has been received.\n\n`;
    }
    message += `Inv # ${account.invoice_number}\n`;
    appendSummaryBlock();
    if (accountServices.length > 0) {
      message += `\n🔧 Additional Services:\n`;
      accountServices.forEach(svc => {
        const label = SERVICE_LABELS[svc.service_type] || svc.service_type;
        message += `  • ${label}${svc.description ? ` - ${svc.description}` : ''}: ${formatCurrency(Number(svc.amount), currency)}\n`;
      });
      message += `  Services Total: ${formatCurrency(summary.totalServices, currency)}\n`;
    }
    appendPayableBlock();
    const unpaidCount = unpaidSchedule.length;
    message += `${unpaidCount} month${unpaidCount !== 1 ? 's' : ''} remaining\n`;
    message += `\nMonthly Payment:\n`;
    scheduleItems.forEach((item, idx) => {
      const effPaid = isEffectivelyPaid(item);
      const partial = isPartiallyPaid(item);
      const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      const penalty = Number(item.penalty_amount);
      const baseAmt = Number(item.base_installment_amount);
      const paidAmt = Number(item.paid_amount);
      const totalDue = baseAmt + penalty;

      if (effPaid) {
        if (penalty > 0) {
          message += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)} (PAID)\n`;
        } else {
          message += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} (PAID)\n`;
        }
      } else if (partial) {
        const principalRemaining = Math.max(0, baseAmt - paidAmt);
        message += `🔶 ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}`;
        if (penalty > 0) message += ` + ${formatCurrency(penalty, currency)} (Penalty)`;
        message += ` — ${formatCurrency(paidAmt, currency)} paid, ${formatCurrency(principalRemaining, currency)} remaining\n`;
      } else if (penalty > 0) {
        message += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}  + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)}\n`;
      } else {
        message += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}\n`;
      }
    });
    // Forfeiture notification warning for near-forfeit overdue accounts
    const forfeitWarning = getForfeitureWarning(account.status, scheduleItems);
    if (forfeitWarning && forfeitWarning.monthsOverdue >= 2) {
      message += `\n⚠️ IMPORTANT NOTICE: Your account is ${forfeitWarning.monthsOverdue} months overdue.`;
      if (forfeitWarning.daysUntilForfeit > 0) {
        message += ` If payment is not received by ${new Date(forfeitWarning.forfeitDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}, your account will be subject to forfeiture.`;
      }
      message += `\nPlease settle your outstanding balance immediately to avoid forfeiture. 💛`;
    } else {
      const nextStatement = getNextPaymentStatementDate(scheduleItems);
      if (nextStatement) {
        const nextDate = new Date(nextStatement.date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
        message += `\nPlease note your next monthly payment is on ${nextDate}. Please expect another payment reminder from us.\n\n`;
        message += `Thank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;
      }
    }
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
                  {can('edit_invoice') && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => { setInvoiceInput(account.invoice_number); setEditingInvoice(true); }}
                    title="Edit invoice number"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  )}
                </div>
              )}
              <Badge variant="outline" className={
                account.status === 'final_forfeited' ? 'bg-destructive/10 text-destructive border-destructive/20 text-xs' :
                account.status === 'forfeited' ? 'bg-orange-500/10 text-orange-500 border-orange-500/20 text-xs' :
                account.status === 'extension_active' ? 'bg-info/10 text-info border-info/20 text-xs' :
                account.status === 'final_settlement' ? 'bg-amber-600/10 text-amber-600 border-amber-600/20 text-xs' :
                account.status === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/20 text-xs' :
                account.status === 'completed' ? 'bg-primary/10 text-primary border-primary/20 text-xs' :
                'bg-success/10 text-success border-success/20 text-xs'
              }>
                {account.status === 'final_settlement' ? 'FINAL SETTLEMENT' :
                 account.status === 'extension_active' ? 'EXTENSION ACTIVE' :
                 account.status === 'final_forfeited' ? 'PERMANENTLY FORFEITED' :
                 account.status.toUpperCase()}
              </Badge>
              {(account as any).is_reactivated && (
                <Badge variant="outline" className="bg-info/10 text-info border-info/20 text-xs">
                  🔄 Reactivated
                </Badge>
              )}
              {isExtension && (account as any).extension_end_date && (
                <Badge variant="outline" className="bg-warning/10 text-warning border-warning/20 text-xs">
                  Extension until {new Date((account as any).extension_end_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })}
                </Badge>
              )}
              {penaltyCapOverride && (
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 text-xs">
                  <ShieldCheck className="h-3 w-3 mr-1" /> Penalty Override Active ✅
                </Badge>
              )}
            </div>
            {/* Forfeiture Notification Warning Banner */}
            {(() => {
              const warning = getForfeitureWarning(account.status, scheduleItems);
              if (!warning) return null;
              return (
                <div className="mt-2 p-3 rounded-lg border border-orange-500/30 bg-orange-500/5">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-orange-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-orange-500">⚠️ FORFEITURE NOTIFICATION</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    This account is <strong>{warning.monthsOverdue} month{warning.monthsOverdue !== 1 ? 's' : ''} overdue</strong> since first unpaid due date
                    {warning.firstUnpaidDueDate ? ` (${new Date(warning.firstUnpaidDueDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })})` : ''}.
                    {warning.daysUntilForfeit > 0
                      ? ` Auto-forfeiture will trigger on ${new Date(warning.forfeitDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })} (${warning.daysUntilForfeit} day${warning.daysUntilForfeit !== 1 ? 's' : ''} remaining).`
                      : ` Forfeiture date (${new Date(warning.forfeitDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })}) has been reached — pending engine run.`
                    }
                  </p>
                </div>
              );
            })()}
            <p className="text-sm text-muted-foreground mt-0.5">
              {account.customers?.full_name} · {account.payment_plan_months}-Month Plan · {currency}
            </p>
            {penaltyCapOverride && (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                  Manual Override Active — Penalty capped at {currency === 'PHP' ? '₱1,000' : '¥2,000'}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            {can('reassign_owner') && (
            <ReassignOwnerDialog
              accountId={account.id}
              currentCustomerId={account.customer_id}
              currentCustomerName={account.customers?.full_name || 'Unknown'}
              invoiceNumber={account.invoice_number}
            />
            )}
            {remainingBalance > 0 && canAcceptPayment(account.status) && can('record_payment') && (
              <>
                <RecordPaymentDialog
                  accountId={account.id}
                  currency={currency}
                  remainingBalance={remainingBalance}
                  schedule={scheduleItems}
                />
                <RecordPaymentDialog
                  accountId={account.id}
                  currency={currency}
                  remainingBalance={remainingBalance}
                  payFullBalance
                  schedule={scheduleItems}
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
            {canAddService(account.status) && can('add_service') && (
              <AddServiceDialog accountId={account.id} currency={currency} />
            )}
            {/* Reactivate button — only for forfeited, non-reactivated accounts */}
            {canReactivate(account.status, !!(account as any).is_reactivated) && can('reactivate_account') && (
              <Button
                variant="outline"
                className="border-info/30 text-info hover:bg-info/10"
                disabled={reactivating}
                onClick={async () => {
                  setReactivating(true);
                  try {
                    const user = (await supabase.auth.getUser()).data.user;
                    const { data, error } = await supabase.functions.invoke('reactivate-account', {
                      body: { account_id: account.id, staff_user_id: user?.id },
                    });
                    if (error) throw error;
                    if (data?.error) throw new Error(data.error);
                    toast.success(data.message || 'Account reactivated');
                    queryClient.invalidateQueries({ queryKey: ['accounts', account.id] });
                    queryClient.invalidateQueries({ queryKey: ['accounts'] });
                    queryClient.invalidateQueries({ queryKey: ['schedule', id] });
                    queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to reactivate');
                  } finally {
                    setReactivating(false);
                  }
                }}
              >
                <RotateCcw className="h-4 w-4 mr-2" /> {reactivating ? 'Reactivating…' : 'Reactivate (One-Time)'}
              </Button>
            )}
            {canAddPenalty(account.status) && can('add_penalty') && (
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
                {can('apply_cap_fix') && (
                <ApplyPenaltyCapDialog
                  accountId={account.id}
                  invoiceNumber={account.invoice_number}
                  currency={currency}
                  hasOverride={!!penaltyCapOverride}
                />
                )}
                {can('forfeit_account') && (
                <Button
                  variant="outline"
                  className="border-orange-500/30 text-orange-500 hover:bg-orange-500/10"
                  onClick={() => setForfeitConfirmOpen(true)}
                >
                  <AlertTriangle className="h-4 w-4 mr-2" /> Forfeit
                </Button>
                )}
              </>
            )}
            <StatementShareMenu
              accountId={account.id}
              invoiceNumber={account.invoice_number}
              customerName={account.customers?.full_name || 'Customer'}
              currency={currency}
              remainingBalance={remainingBalance}
              totalPaid={totalPaid}
              totalAmount={principalTotal}
              scheduleItems={scheduleItems}
              messengerLink={account.customers?.messenger_link}
            />
            {can('delete_account') && (
            <Button
              variant="outline"
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Delete Account
            </Button>
            )}
          </div>
        </div>

        {/* Reconciliation Warning */}
        {!reconciliationValid && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
            <p className="text-xs text-destructive font-medium">
              Reconciliation Error: Total ({formatCurrency(principalTotal, currency)}) − Paid ({formatCurrency(totalPaid, currency)}) = {formatCurrency(principalTotal - totalPaid, currency)} ≠ Remaining ({formatCurrency(remainingBalance, currency)})
            </p>
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Layaway Amount</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(summary.principalTotal, currency)}
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
              {formatCurrency(summary.totalPaid, currency)}
            </p>
          </div>
          <div className="rounded-xl border border-primary/20 bg-card p-3 sm:p-4">
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Remaining Principal</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(summary.remainingPrincipal, currency)}
            </p>
          </div>
          {summary.outstandingPenalties > 0 && (
            <div className="rounded-xl border border-destructive/20 bg-card p-3 sm:p-4">
              <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Outstanding Penalties</p>
              <p className="text-lg sm:text-xl font-bold text-destructive font-display tabular-nums">
                {formatCurrency(summary.outstandingPenalties, currency)}
              </p>
            </div>
          )}
          {totalServicesAmount > 0 && (
            <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
              <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Services</p>
              <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
                {formatCurrency(summary.totalServices, currency)}
              </p>
            </div>
          )}
          <div className={`rounded-xl border ${summary.outstandingPenalties > 0 ? 'border-warning/30 bg-warning/5' : 'border-primary/20 bg-card'} p-3 sm:p-4`}>
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">
              {summary.outstandingPenalties > 0 ? 'Current Total Payable' : 'Remaining Balance'}
            </p>
            <p className={`text-lg sm:text-xl font-bold font-display tabular-nums ${summary.outstandingPenalties > 0 ? 'text-warning' : 'text-card-foreground'}`}>
              {formatCurrency(summary.currentTotalPayable, currency)}
            </p>
            {summary.outstandingPenalties > 0 && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                = Principal {formatCurrency(summary.remainingPrincipal, currency)} + Penalties {formatCurrency(summary.outstandingPenalties, currency)}
              </p>
            )}
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
              {/* Schedule Header */}
              <div className="hidden sm:grid grid-cols-[2.5rem_1fr_5.5rem_5.5rem_5.5rem_5.5rem_2rem] gap-1 px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                <span>#</span>
                <span>Due Date</span>
                <span className="text-right">Base Amt</span>
                <span className="text-right">Penalty</span>
                <span className="text-right">Total Due</span>
                <span className="text-right">Status</span>
                <span />
              </div>
              {scheduleItems.map((item) => {
                const effPaid = isEffectivelyPaid(item);
                const partial = isPartiallyPaid(item);
                const penaltyAmt = Number(item.penalty_amount);
                const paidAmt = Number(item.paid_amount);
                const baseAmt = Number(item.base_installment_amount);
                const totalDue = baseAmt + penaltyAmt;
                const itemRemaining = remainingDue(item);
                const isEditingThis = editingScheduleId === item.id;
                const canEdit = account.status !== 'forfeited' && account.status !== 'cancelled' && item.status !== 'cancelled';
                const overCap = penaltyCapOverride && isPenaltyOverCap(currency as 'PHP' | 'JPY', item.installment_number, penaltyAmt);
                return (
                  <div key={item.id}
                    className={`group rounded-lg border p-2.5 sm:p-3 ${
                      effPaid ? 'bg-success/5 border-success/10' : partial ? 'bg-warning/5 border-warning/10' : 'bg-card border-border'
                    }`}
                  >
                    {/* Mobile layout */}
                    <div className="sm:hidden flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ${
                          effPaid ? 'bg-success/20 text-success' : partial ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground'
                        }`}>
                          {effPaid ? <Check className="h-3 w-3" /> : item.installment_number}
                        </div>
                        <div>
                          <p className="text-xs font-medium text-card-foreground">
                            {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {effPaid ? 'Paid' : partial ? `Partial — ${formatCurrency(paidAmt, currency)} paid` : `Month ${item.installment_number}`}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-xs font-semibold tabular-nums ${effPaid ? 'text-success' : partial ? 'text-warning' : 'text-card-foreground'}`}>
                          {formatCurrency(effPaid ? Math.max(paidAmt, totalDue) : totalDue, currency)}
                        </p>
                        {partial && (
                          <p className="text-[10px] text-warning tabular-nums">
                            Remaining: {formatCurrency(itemRemaining, currency)}
                          </p>
                        )}
                      </div>
                    </div>
                    {/* Mobile penalty detail */}
                    {penaltyAmt > 0 && (
                      <div className="sm:hidden mt-1.5 ml-8 flex items-center gap-2 text-[10px]">
                        <span className="text-muted-foreground">Base: {formatCurrency(baseAmt, currency)}</span>
                        <span className="text-destructive font-medium flex items-center gap-0.5">
                          <AlertTriangle className="h-2.5 w-2.5" />
                          Penalty: {formatCurrency(penaltyAmt, currency)}
                          {effPaid ? ' (Paid)' : ''}
                        </span>
                        {penaltyCapOverride && item.installment_number <= 5 && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-primary/10 text-primary border-primary/20">
                            Capped
                          </Badge>
                        )}
                      </div>
                    )}
                    {penaltyAmt === 0 && !effPaid && (
                      <div className="sm:hidden mt-1 ml-8 text-[10px] text-muted-foreground">
                        Penalty: {formatCurrency(0, currency)}
                      </div>
                    )}

                    {/* Desktop layout: columnar */}
                    <div className="hidden sm:grid grid-cols-[2.5rem_1fr_5.5rem_5.5rem_5.5rem_5.5rem_2rem] gap-1 items-center">
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                        effPaid ? 'bg-success/20 text-success' : partial ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground'
                      }`}>
                        {effPaid ? <Check className="h-3 w-3" /> : item.installment_number}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-card-foreground">
                          {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Month {item.installment_number}
                          {partial && <span className="text-warning ml-1">(Paid: {formatCurrency(paidAmt, currency)})</span>}
                        </p>
                      </div>
                      {/* Base Amount */}
                      <p className="text-xs tabular-nums text-right text-card-foreground">
                        {formatCurrency(baseAmt, currency)}
                      </p>
                      {/* Penalty Amount */}
                      <div className="text-right">
                        {penaltyAmt > 0 ? (
                          <div>
                            <p className="text-xs tabular-nums text-destructive font-medium">
                              {formatCurrency(penaltyAmt, currency)}
                            </p>
                            <p className="text-[9px] text-destructive/70">
                              {effPaid ? 'Paid' : 'Applied'}
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs tabular-nums text-muted-foreground">—</p>
                        )}
                      </div>
                      {/* Total Due / Remaining */}
                      <div className="text-right">
                        <p className={`text-xs font-semibold tabular-nums ${effPaid ? 'text-success' : partial ? 'text-warning' : 'text-card-foreground'}`}>
                          {formatCurrency(effPaid ? Math.max(paidAmt, totalDue) : totalDue, currency)}
                        </p>
                        {partial && (
                          <p className="text-[9px] text-warning tabular-nums">
                            Rem: {formatCurrency(itemRemaining, currency)}
                          </p>
                        )}
                      </div>
                      {/* Status */}
                      <div className="text-right">
                        {effPaid ? (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-success/10 text-success border-success/20">Paid</Badge>
                        ) : partial ? (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-warning/10 text-warning border-warning/20">Partial</Badge>
                        ) : penaltyCapOverride && item.installment_number <= 5 && penaltyAmt > 0 ? (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-primary/10 text-primary border-primary/20">Capped</Badge>
                        ) : item.status === 'overdue' ? (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-destructive/10 text-destructive border-destructive/20">Overdue</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-muted text-muted-foreground border-border">Pending</Badge>
                        )}
                      </div>
                      {/* Edit button */}
                      <div>
                        {!isEditingThis && canEdit && can('edit_schedule') ? (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Edit installment amount"
                            onClick={() => {
                              setEditingScheduleId(item.id);
                              setEditScheduleAmount(String(baseAmt));
                            }}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    {/* Edit row - rendered below grid when editing */}
                    {isEditingThis && (
                      <div className="hidden sm:flex items-center gap-2 mt-2 pl-10">
                        <span className="text-xs text-muted-foreground">New amount:</span>
                        <Input
                          type="number"
                          value={editScheduleAmount}
                          onChange={(e) => setEditScheduleAmount(e.target.value)}
                          className="h-7 w-28 text-xs bg-background tabular-nums"
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
                    )}
                  </div>
                );
              })}
              {/* Schedule Totals Summary */}
              {scheduleItems.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border space-y-1.5">
                  <div className="flex justify-between text-xs text-muted-foreground px-1">
                    <span>Sum of Base Installments</span>
                    <span className="tabular-nums font-medium">{formatCurrency(scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount), 0), currency)}</span>
                  </div>
                  <div className="flex justify-between text-xs px-1">
                    <span className="text-destructive/80 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Total Penalties in Schedule
                    </span>
                    <span className="tabular-nums font-medium text-destructive">
                      {formatCurrency(scheduleItems.reduce((s, i) => s + Number(i.penalty_amount), 0), currency)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm font-semibold px-1 pt-1 border-t border-border">
                    <span className="text-card-foreground">Grand Total (Schedule)</span>
                    <span className="tabular-nums text-card-foreground">
                      {formatCurrency(scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount) + Number(i.penalty_amount), 0), currency)}
                    </span>
                  </div>
                  {penaltyCapOverride && (
                    <div className="flex items-center gap-1.5 px-1 pt-1">
                      <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] text-primary font-medium">
                        Penalty Cap Active: Max {currency === 'PHP' ? '₱1,000' : '¥2,000'} for months 1–5
                      </span>
                    </div>
                  )}
                </div>
              )}
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
                          {can('void_payment') && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => { setVoidTarget(p.id); setVoidReason(''); }}>
                            <Ban className="h-3 w-3" />
                          </Button>
                          )}
                        </div>
                      )}
                      {isVoided && can('restore_payment') && (
                        <Button variant="ghost" size="sm"
                          className="h-7 text-xs text-muted-foreground hover:text-success"
                          style={{ textDecoration: 'none' }}
                          onClick={() => setRestoreTarget({ id: p.id, amount: Number(p.amount_paid), date: p.date_paid })}>
                          <RotateCcw className="h-3 w-3 mr-1" />
                          Restore
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Restore Payment Dialog */}
        <RestorePaymentDialog
          open={!!restoreTarget}
          onOpenChange={(open) => { if (!open) setRestoreTarget(null); }}
          paymentId={restoreTarget?.id || ''}
          paymentAmount={restoreTarget?.amount || 0}
          paymentDate={restoreTarget?.date || ''}
          currency={account.currency as Currency}
          schedule={scheduleItems}
          onRestore={async (paymentId, selectedScheduleIds) => {
            try {
              await restorePayment.mutateAsync({
                payment_id: paymentId,
                selected_schedule_ids: selectedScheduleIds,
              });
              toast.success('Payment restored successfully');
              setRestoreTarget(null);
            } catch (err: any) {
              toast.error(err.message || 'Failed to restore payment');
            }
          }}
          isPending={restorePayment.isPending}
        />

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
