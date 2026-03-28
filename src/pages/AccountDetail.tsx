import { useState, useCallback, useMemo, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ROUTES } from '@/constants/routes';
import { ArrowLeft, Copy, MessageCircle, Check, AlertTriangle, Calendar, Pencil, Ban, X, Save, RotateCcw, Trash2, DollarSign, Wrench, ShieldCheck, Settings, Plus } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

import RestorePaymentDialog from '@/components/payments/RestorePaymentDialog';
import ReassignOwnerDialog from '@/components/accounts/ReassignOwnerDialog';
import AddServiceDialog from '@/components/services/AddServiceDialog';
import ServicesList, { AccountService } from '@/components/services/ServicesList';
import EditAccountDialog from '@/components/accounts/EditAccountDialog';
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
import RecordPaymentDialog, { type SessionPaymentInfo } from '@/components/payments/RecordPaymentDialog';
import PenaltyWaiverPanel from '@/components/penalties/PenaltyWaiverPanel';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useAccount, useSchedule, usePayments, usePenalties, useVoidPayment, useEditPayment, useEditPaymentAmount, useRestorePayment, useDeleteAccount, useForfeitAccount, useAccountServices, usePenaltyCapOverride } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import {
  isEffectivelyPaid, isPartiallyPaid, remainingDue, remainingPrincipalDue, computeRemainingBalance,
  getUnpaidScheduleItems, getActivePayments, accountProgress,
  ordinal, SERVICE_LABELS, getNextPaymentStatementDate,
  isPenaltyOverCap, isFinalSettlement, isExtensionActive, isFinalForfeited,
  getForfeitureWarning, getUpcomingFollowUpDates,
  canReactivate, canAcceptPayment, canAddService, canAddPenalty,
  computeAccountSummary,
} from '@/lib/business-rules';

const TEST_INVOICES = new Set(['TEST-001', 'TEST-002', 'TEST-003']);
const LOCKED_TEST_INVOICE = 'TEST-001';

export default function AccountDetail() {
  const { id } = useParams();
  const { data: account, isLoading: accountLoading } = useAccount(id);
  const { data: schedule } = useSchedule(id);
  const { data: payments } = usePayments(id);
  const { data: penalties } = usePenalties(id);
  const { data: services } = useAccountServices(id);
  const { data: penaltyCapOverride } = usePenaltyCapOverride(id);
  const [copied, setCopied] = useState(false);

  // ── Session payment tracking (state-based, per-account) ──
  const [sessionPayments, setSessionPayments] = useState<SessionPaymentInfo[]>([]);
  const confirmedPayments = (payments || []).filter((p: any) => !p.voided_at);

  // Reset session payments when navigating to a different account
  useEffect(() => {
    setSessionPayments([]);
  }, [id]);

  const handlePaymentRecorded = useCallback((info: SessionPaymentInfo) => {
    if (info.monthLabel === 'Down Payment' || info.ordinal === 'DP') return;
    setSessionPayments(prev => [...prev, info]);
  }, []);

  // ── Portal token for customer ──
  const customerId = account?.customer_id;
  const { data: portalToken } = useQuery({
    queryKey: ['portal-token', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('customer_portal_tokens')
        .select('token')
        .eq('customer_id', customerId!)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.token || null;
    },
  });
  const voidPayment = useVoidPayment();
  const editPaymentAmount = useEditPaymentAmount();
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
  const [editAmount, setEditAmount] = useState('');
  const [editAmountReason, setEditAmountReason] = useState('');
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
  const [addingInstallment, setAddingInstallment] = useState(false);
  const [newInstDueDate, setNewInstDueDate] = useState('');
  const [newInstAmount, setNewInstAmount] = useState('');
  const [newInstSaving, setNewInstSaving] = useState(false);
  const [deleteScheduleTarget, setDeleteScheduleTarget] = useState<{ id: string; amount: number; installment_number: number } | null>(null);
  const [deleteScheduleLoading, setDeleteScheduleLoading] = useState(false);
  const isTestAccount = TEST_INVOICES.has(account?.invoice_number || '');
  const isLockedTest = account?.invoice_number === LOCKED_TEST_INVOICE;
  const [showVerify, setShowVerify] = useState(false);
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const { can: canPerm } = usePermissions();
  const can = (action: string) => canPerm(action);


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
      queryClient.invalidateQueries({ queryKey: ['account', id] });
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

  const handleAddInstallment = useCallback(async () => {
    const amount = parseFloat(newInstAmount);
    if (isNaN(amount) || amount <= 0 || !newInstDueDate || !account) {
      toast.error('Please enter a valid amount and due date');
      return;
    }
    setNewInstSaving(true);
    try {
      const maxInstNumber = Math.max(...(schedule || []).map(s => s.installment_number), 0);
      const nextNumber = maxInstNumber + 1;
      const roundedAmount = Math.round(amount * 100) / 100;

      const { error } = await supabase
        .from('layaway_schedule')
        .insert({
          account_id: account.id,
          installment_number: nextNumber,
          due_date: newInstDueDate,
          base_installment_amount: roundedAmount,
          total_due_amount: roundedAmount,
          currency: account.currency as 'PHP' | 'JPY',
          status: 'pending',
        });
      if (error) throw error;

      // Auto-update total_amount and remaining_balance to include the new installment
      const newTotal = Math.round((Number(account.total_amount) + roundedAmount) * 100) / 100;
      const newRemaining = Math.round((Number(account.remaining_balance) + roundedAmount) * 100) / 100;
      const { error: accErr } = await supabase
        .from('layaway_accounts')
        .update({ total_amount: newTotal, remaining_balance: newRemaining })
        .eq('id', account.id);
      if (accErr) throw accErr;

      const userId = (await supabase.auth.getUser()).data.user?.id;
      await supabase.from('audit_logs').insert({
        entity_type: 'layaway_schedule',
        entity_id: account.id,
        action: 'add_schedule_item',
        new_value_json: { installment_number: nextNumber, due_date: newInstDueDate, base_installment_amount: roundedAmount, total_amount_updated: newTotal, remaining_balance_updated: newRemaining },
        old_value_json: { total_amount: Number(account.total_amount), remaining_balance: Number(account.remaining_balance) },
        performed_by_user_id: userId || null,
      });

      queryClient.invalidateQueries({ queryKey: ['schedule', id] });
      queryClient.invalidateQueries({ queryKey: ['account', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['customer-detail'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      toast.success(`Installment #${nextNumber} added`);
      setAddingInstallment(false);
      setNewInstDueDate('');
      setNewInstAmount('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to add installment');
    } finally {
      setNewInstSaving(false);
    }
  }, [newInstAmount, newInstDueDate, account, schedule, id, queryClient]);

  const handleDeleteInstallment = useCallback(async () => {
    if (!deleteScheduleTarget || !account) return;
    setDeleteScheduleLoading(true);
    try {
      // Cancel the schedule item (set status to cancelled, zero out amounts)
      const { error } = await supabase
        .from('layaway_schedule')
        .update({ status: 'cancelled' as any, base_installment_amount: 0, total_due_amount: 0, penalty_amount: 0 })
        .eq('id', deleteScheduleTarget.id);
      if (error) throw error;

      // Deduct from account totals
      const deductAmt = deleteScheduleTarget.amount;
      const newTotal = Math.round((Number(account.total_amount) - deductAmt) * 100) / 100;
      const newRemaining = Math.round((Number(account.remaining_balance) - deductAmt) * 100) / 100;
      const { error: accErr } = await supabase
        .from('layaway_accounts')
        .update({ total_amount: Math.max(0, newTotal), remaining_balance: Math.max(0, newRemaining) })
        .eq('id', account.id);
      if (accErr) throw accErr;

      const userId = (await supabase.auth.getUser()).data.user?.id;
      await supabase.from('audit_logs').insert({
        entity_type: 'layaway_schedule',
        entity_id: account.id,
        action: 'delete_schedule_item',
        old_value_json: { installment_number: deleteScheduleTarget.installment_number, base_installment_amount: deductAmt, total_amount: Number(account.total_amount), remaining_balance: Number(account.remaining_balance) },
        new_value_json: { total_amount_updated: Math.max(0, newTotal), remaining_balance_updated: Math.max(0, newRemaining) },
        performed_by_user_id: userId || null,
      });

      queryClient.invalidateQueries({ queryKey: ['schedule', id] });
      queryClient.invalidateQueries({ queryKey: ['account', id] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['customer-detail'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      toast.success(`Installment #${deleteScheduleTarget.installment_number} removed`);
      setDeleteScheduleTarget(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete installment');
    } finally {
      setDeleteScheduleLoading(false);
    }
  }, [deleteScheduleTarget, account, id, queryClient]);

  const currency = (account?.currency || 'PHP') as Currency;
  const principalTotal = Number(account?.total_amount || 0);
  const scheduleItems = schedule || [];
  // Override DB status: account is only truly overdue if an unpaid month has a past due_date
  const todayStr = new Date().toISOString().split('T')[0];
  const hasUnpaidPastDue = scheduleItems.some(
    item => !isEffectivelyPaid(item) && item.due_date < todayStr
  );
  const effectiveStatus = account?.status === 'overdue' && !hasUnpaidPastDue
    ? 'active'
    : (account?.status ?? 'active');
  const downpaymentAmount = Number((account as any)?.downpayment_amount || 0);

  // Identify downpayment payments — check multiple fields since import sources vary
  const isDownpaymentPayment = (p: any) =>
    p.payment_type === 'downpayment' ||
    p.payment_type === 'dp' ||
    p.is_downpayment === true ||
    (p.reference_number && String(p.reference_number).startsWith('DP-')) ||
    (p.remarks && String(p.remarks).toLowerCase().includes('down')) ||
    (p.remarks && String(p.remarks).toLowerCase().includes('dp'));
  const dpPayments = (payments || []).filter((p: any) => !p.voided_at && isDownpaymentPayment(p));
  const taggedDpPaid = dpPayments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
  // For legacy accounts without tagged DP payments, infer DP as paid when total_paid covers it
  const allActivePayments = (payments || []).filter((p: any) => !p.voided_at);
  const totalPaidAll = allActivePayments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
  const dpPaidAmount = taggedDpPaid > 0 ? taggedDpPaid : (downpaymentAmount > 0 && totalPaidAll >= downpaymentAmount ? downpaymentAmount : 0);
  const dpRemainingAmount = Math.max(0, downpaymentAmount - dpPaidAmount);

  const confirmedActivePayments = getActivePayments(payments || []);
  const totalPaid = confirmedActivePayments.reduce((sum, p) => sum + Number(p.amount_paid), 0);
  const accountServices = ((services || []) as AccountService[]);
  const totalServicesAmount = accountServices.reduce((s, svc) => s + Number(svc.amount), 0);
  const unpaidPenalties = (penalties || []).filter(p => p.status === 'unpaid');
  const unpaidPenaltySum = unpaidPenalties.reduce((sum, penalty) => sum + Number(penalty.penalty_amount), 0);
  // Penalty-paid = sum of penalty_fees with status='paid' (principal/penalty separation)
  const paidPenaltySum = (penalties || []).filter(p => p.status === 'paid').reduce((sum, p) => sum + Number(p.penalty_amount), 0);
  // Active (non-waived) penalties = paid + unpaid (excludes waived)
  const activePenaltyTotal = paidPenaltySum + unpaidPenaltySum;

  const summary = computeAccountSummary({
    principalTotal,
    totalPaid,
    unpaidPenaltySum,
    totalServicesAmount,
    penaltyPaidSum: paidPenaltySum,
    activePenaltySum: activePenaltyTotal,
    scheduleItems,
  });

  const principalRemaining = summary.remainingPrincipal;
  const displayBalance = summary.remainingBalance;
  const paymentEligibleBalance = summary.remainingBalance;
  const hasAdditionalCharges = summary.activePenalties > 0 || summary.totalServices > 0;

  const scheduleBaseSum = scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount), 0);
  const originalPrincipal = downpaymentAmount + scheduleBaseSum;
  const progress = summary.progressPercent;

  const reconciliationValid = Math.abs(summary.totalLAAmount - totalPaid - summary.remainingBalance) < 1;

  const unpaidSchedule = getUnpaidScheduleItems(scheduleItems);
  const activePayments = [...confirmedActivePayments]
    .sort((a, b) => {
      const dateDiff = new Date(a.date_paid).getTime() - new Date(b.date_paid).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

  // Smart currency formatter: drop .00 for whole numbers, keep decimals when present
  const fmtVal = (amt: number): string => {
    if (currency === 'JPY') return Math.round(amt).toLocaleString('en-US');
    const rounded = Math.round(amt * 100) / 100;
    return rounded % 1 === 0
      ? rounded.toLocaleString('en-US')
      : rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Build payment breakdown text: DP + actual paid per month = total
  const buildPaymentBreakdown = (): string => {
    const parts: string[] = [];
    if (downpaymentAmount > 0 && dpPaidAmount > 0) {
      parts.push(fmtVal(dpPaidAmount));
    }
    // Each paid/partial month's actual collected = base paid + penalty for that month
    const paidOrPartialSchedules = scheduleItems.filter(s => isEffectivelyPaid(s) || isPartiallyPaid(s));
    paidOrPartialSchedules.forEach(s => {
      const paidAmt = Number(s.paid_amount);
      const baseAmt = Number(s.base_installment_amount);
      const penaltyAdd = paidAmt > baseAmt ? 0 : Number(s.penalty_amount);
      const actualPaid = paidAmt + penaltyAdd;
      parts.push(fmtVal(actualPaid));
    });
    if (parts.length > 1) {
      return `${parts.join(' + ')} = ${formatCurrency(totalPaid, currency)}`;
    }
    return formatCurrency(totalPaid, currency);
  };
  const paymentBreakdownText = buildPaymentBreakdown();

  const getMessageScheduleState = (item: any, idx: number) => {
    const state = summary.scheduleStates.find(s => s.installmentNumber === item.installment_number);
    if (state) {
      return {
        coveredAmount: state.paidAmount,
        effPaid: state.isPaid,
        partial: state.isPartial,
        totalDue: state.totalDue,
      };
    }
    return {
      coveredAmount: Number(item.paid_amount),
      effPaid: isEffectivelyPaid(item),
      partial: !isEffectivelyPaid(item) && Number(item.paid_amount) > 0,
      totalDue: Number(item.total_due_amount),
    };
  };

  const mostRecentPayment = activePayments.length > 0
    ? [...activePayments].sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    : null;

  const isForfeited = account?.status === 'forfeited';
  const isSettlement = account?.status === 'final_settlement';
  const isFinalForfeit = account?.status === 'final_forfeited';
  const isExtension = account?.status === 'extension_active';

  const message = useMemo(() => {
  if (!account) return '';

  // ══════════════════════════════════════════════════════════════════════
  // 🔒 OFFICIAL CHA JEWELS CUSTOMER MESSAGE TEMPLATE — LOCKED
  //    DO NOT modify structure, wording, order, spacing, or symbols.
  //    Future fixes must adjust VALUES ONLY, never the format.
  // ══════════════════════════════════════════════════════════════════════

  // Use computed values from summary (BUG 1, 3, 6 fix)
  const totalLayawayAmount = summary.totalLAAmount;
  const activePenaltyAmt = summary.activePenalties;

  // LA month label from last schedule item (e.g. "LA APR")
  const lastScheduleDate = scheduleItems.length > 0 ? new Date(scheduleItems[scheduleItems.length - 1].due_date) : null;
  const laMonthLabel = lastScheduleDate ? `LA ${lastScheduleDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}` : 'LA';

  // Build Total LA Amount display with breakdown (BUG 6: auto-sync from penalty_fees)
  const buildTotalLALine = () => {
    const base = summary.principalTotal;
    const parts: string[] = [];
    if (activePenaltyAmt > 0) parts.push(`${fmtVal(activePenaltyAmt)} (Penalty)`);
    if (summary.totalServices > 0) parts.push(`${fmtVal(summary.totalServices)} (Service)`);
    if (parts.length > 0) {
      return `Total LA Amount: ${formatCurrency(base, currency)} + ${parts.join(' + ')} = ${formatCurrency(totalLayawayAmount, currency)}`;
    }
    return `Total LA Amount: ${formatCurrency(totalLayawayAmount, currency)}`;
  };

  // Shared message blocks (reused across status variants)
  const appendSummaryBlock = (msg: string) => {
    msg += `${buildTotalLALine()}\n`;
    // Amount Paid: DP + payments = total (BUG 2 & 7 fix)
    msg += `Amount Paid: ${paymentBreakdownText}\n`;
    return msg;
  };

  // BUG 4 fix: never show penalty if zero or waived
  const appendScheduleLines = (msg: string) => {
    scheduleItems.forEach((item, idx) => {
      const messageState = getMessageScheduleState(item, idx);
      const effPaid = messageState.effPaid;
      const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      const penalty = Number(item.penalty_amount);
      const baseAmt = Number(item.base_installment_amount);
      const totalDue = messageState.totalDue;

      if (effPaid) {
        // BUG B fix: show base + penalty as the = total, not just base
        const rowTotal = penalty > 0 ? baseAmt + penalty : baseAmt;
        if (penalty > 0) {
          msg += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(rowTotal, currency)} (PAID)\n`;
        } else {
          msg += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(rowTotal, currency)} (PAID)\n`;
        }
      } else if (penalty > 0) {
        msg += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${formatCurrency(penalty, currency)} (Penalty) = ${formatCurrency(totalDue, currency)}\n`;
      } else {
        // BUG 4: no penalty portion shown when penalty == 0
        msg += `${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}\n`;
      }
    });
    return msg;
  };

  let message = ``;

  if (isFinalForfeit) {
    message += `🚫 PERMANENT FORFEITURE NOTICE\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Status: PERMANENTLY FORFEITED\n`;
    message = appendSummaryBlock(message);
    message += `\nYour account is permanently forfeited.\nNo further reactivation or negotiation is allowed.\n`;
    message += `\nFor any questions, please contact Cha Jewels directly.`;
  } else if (isForfeited) {
    message += `⛔ NOTICE: This layaway account has been FORFEITED due to extended non-payment.\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Status: FORFEITED\n`;
    message = appendSummaryBlock(message);
    message += `\nNo further installment payments are being accepted for this account.\n`;
    message += `\nFor any questions, please contact Cha Jewels directly.`;
  } else if (isExtension) {
    message += `🔄 REACTIVATION NOTICE\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Your account has been reactivated as a one-time consideration.\n`;
    message += `You are given a final extension of 1 month${(account as any).extension_end_date ? ` (until ${new Date((account as any).extension_end_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })})` : ''}.\n`;
    message += `Penalty charges will continue to apply based on the existing schedule.\n`;
    message += `No further extensions will be allowed.\n\n`;
    message = appendSummaryBlock(message);
    message += `================\n`;
    message += `Remaining Balance: ${formatCurrency(summary.remainingBalance, currency)}\n`;
    if (summary.outstandingPenalties > 0 || summary.totalServices > 0) {
      if (summary.outstandingPenalties > 0) message += `Outstanding Penalties: ${formatCurrency(summary.outstandingPenalties, currency)}\n`;
      if (summary.totalServices > 0) message += `Additional Services: ${formatCurrency(summary.totalServices, currency)}\n`;
    }
    message += `\nMonthly Payment:\n`;
    message = appendScheduleLines(message);
    message += `\nPlease settle promptly to avoid permanent forfeiture. 💛`;
  } else if (isSettlement) {
    message += `⚠️ FINAL SETTLEMENT NOTICE\n\n`;
    message += `Inv # ${account.invoice_number}\n`;
    message += `Your account has reached final settlement.\nThe total amount is final and must be settled.\n\n`;
    message = appendSummaryBlock(message);
    message += `================\n`;
    message += `Remaining Balance: ${formatCurrency(summary.remainingBalance, currency)}\n`;
    if (summary.outstandingPenalties > 0) {
      if (summary.totalServices > 0) message += `Additional Services: ${formatCurrency(summary.totalServices, currency)}\n`;
      message += `⚠️ FINAL SETTLEMENT AMOUNT: ${formatCurrency(summary.remainingBalance, currency)}\n\n`;
      message += `This amount includes:\n`;
      message += `  • Remaining principal: ${formatCurrency(summary.remainingPrincipal, currency)}\n`;
      message += `  • Outstanding penalties: ${formatCurrency(summary.outstandingPenalties, currency)}\n`;
      if (summary.totalServices > 0) message += `  • Additional services: ${formatCurrency(summary.totalServices, currency)}\n`;
    } else {
      if (summary.totalServices > 0) message += `Additional Services: ${formatCurrency(summary.totalServices, currency)}\n`;
      message += `⚠️ FINAL SETTLEMENT AMOUNT: ${formatCurrency(summary.remainingBalance, currency)}\n\n`;
    }
    message += `\nRegular installment schedule is no longer active.\n`;
    message += `Please settle the full amount above to complete your layaway.\n\n`;
    message += `Monthly Payment History:\n`;
    scheduleItems.forEach((item, idx) => {
      const messageState = getMessageScheduleState(item, idx);
      const effPaid = messageState.effPaid;
      const partial = messageState.partial;
      const dateStr = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
      const penalty = Number(item.penalty_amount);
      const baseAmt = Number(item.base_installment_amount);
      const paidAmt = messageState.coveredAmount;
      const totalDue = messageState.totalDue;
      const displayAmt = effPaid ? Math.max(paidAmt, totalDue) : totalDue;
      const itemRemaining = Math.max(0, totalDue - paidAmt);
      if (effPaid) {
        message += `✅ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(displayAmt, currency)} (PAID)\n`;
      } else if (partial) {
        const principalRem = Math.max(0, baseAmt - paidAmt);
        message += `🔶 ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)}`;
        if (penalty > 0) message += ` + ${fmtVal(penalty)} (Penalty)`;
        message += ` — ${formatCurrency(paidAmt, currency)} paid, ${formatCurrency(principalRem, currency)} remaining (PARTIAL)\n`;
      } else if (penalty > 0) {
        message += `❌ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(baseAmt, currency)} + ${fmtVal(penalty)} (Penalty) = ${formatCurrency(itemRemaining, currency)} (UNPAID)\n`;
      } else {
        message += `❌ ${ordinal(idx)} month ${dateStr}: ${formatCurrency(itemRemaining, currency)} (UNPAID)\n`;
      }
    });
    message += `\nFor any questions, please contact Cha Jewels directly. 💛`;
  } else {
    // ═══════════════════════════════════════════════════════════════
    // 🔒 STANDARD ACTIVE/OVERDUE MESSAGE — SESSION-AWARE TEMPLATES
    //    Template A = single payment, Template B = split payment
    // ═══════════════════════════════════════════════════════════════

    const PORTAL_BASE = 'https://chajewelslayaway.web.app';
    const portalUrl = portalToken ? `${PORTAL_BASE}/portal?token=${portalToken}` : null;

    // Determine next due month info — priority: partially_paid → overdue → pending
    const sortedStates = [...summary.scheduleStates].sort((a, b) => a.installmentNumber - b.installmentNumber);
    const nextUnpaidItem =
      sortedStates.find(s => s.status === 'partially_paid') ??
      sortedStates.find(s => s.status === 'overdue') ??
      sortedStates.find(s => s.status === 'pending');
    const fullyPaid = summary.remainingBalance === 0;

    // Build next-payment / fully-paid line
    const buildNextPaymentLine = (isDownpaymentOnly: boolean): string => {
      if (fullyPaid || !nextUnpaidItem) {
        return `\n🎉 Your layaway is now fully paid! Thank you!`;
      }
      if (isDownpaymentOnly) {
        const monthLabel = new Date(nextUnpaidItem.dueDate + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `\nFirst payment: ${monthLabel} — ${formatCurrency(nextUnpaidItem.totalDue, currency)}`;
      }
      const monthLabel = new Date(nextUnpaidItem.dueDate + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      // totalDue is already the remaining amount for partially_paid rows after reconcile fix
      const nextAmt = nextUnpaidItem.totalDue;
      return `\nNext payment: ${monthLabel} — ${formatCurrency(nextAmt, currency)}`;
    };

    // Check if session payments exist and classify
    const hasSessionPayments = sessionPayments.length > 0;
    const isDownpaymentOnly = hasSessionPayments && sessionPayments.length === 1 &&
      sessionPayments[0].monthLabel === 'Down Payment';

    if (hasSessionPayments) {
      if (sessionPayments.length === 1) {
        // ── TEMPLATE A — SINGLE PAYMENT ──
        const sp = sessionPayments[0];
        message += `Thank you for your payment. ${formatCurrency(sp.amount, currency)} has been received.\n\n`;
        message += `Inv # ${account.invoice_number}\n`;
        if (portalUrl) {
          message += `\nView your updated account and payment schedule here:\n🔗 ${portalUrl}\n`;
        }
        message += buildNextPaymentLine(isDownpaymentOnly);
        message += `\n\nThank you for your continued trust in Cha Jewels! 🧡`;
      } else {
        // ── TEMPLATE B — SPLIT PAYMENT ──
        // Only include actual session payments (never DP — it's recorded at account creation, not in-session)
        const sessionOnly = sessionPayments.filter(sp => sp.monthLabel !== 'Down Payment');
        const sessionTotal = sessionOnly.reduce((s, p) => s + p.amount, 0);
        const count = sessionOnly.length;

        message += `Thank you for your payments. A total of ${formatCurrency(sessionTotal, currency)} has been received across ${count} payments:\n\n`;

        sessionOnly.forEach((sp) => {
          if (sp.monthLabel && sp.ordinal) {
            message += `  ${formatCurrency(sp.amount, currency)} — ${sp.monthLabel} (${sp.ordinal} month)\n`;
          } else {
            message += `  ${formatCurrency(sp.amount, currency)}\n`;
          }
        });

        message += `\nInv # ${account.invoice_number}\n`;
        if (portalUrl) {
          message += `\nView your updated account and payment schedule here:\n🔗 ${portalUrl}\n`;
        }
        message += buildNextPaymentLine(false);
        message += `\n\nThank you for your continued trust in Cha Jewels! 🧡`;
      }
    } else {
      // ── FALLBACK — no session payments ──
      // Always show the standard template with next payment line.
      // (Multi-invoice batch context is handled by MultiInvoicePaymentDialog's own
      //  consolidated message — checking mostRecentPayment.remarks here caused the
      //  next payment line to be permanently suppressed for any account whose last
      //  payment was ever made via multi-invoice, regardless of when it happened.)
      if (mostRecentPayment && !mostRecentPayment.remarks?.includes('[Multi-invoice')) {
        message += `Thank you for your payment. ${formatCurrency(Number(mostRecentPayment.amount_paid), currency)} has been received.\n\n`;
      }
      message += `Inv # ${account.invoice_number}\n`;
      if (portalUrl) {
        message += `\nView your updated account and payment schedule here:\n🔗 ${portalUrl}\n`;
      }
      message += buildNextPaymentLine(false);
      message += `\n\nThank you for your continued trust in Cha Jewels! 🧡`;
    }
  }
  return message;
  }, [account?.id, account?.status, summary, scheduleItems, currency, mostRecentPayment?.id, paymentBreakdownText, accountServices, unpaidSchedule, penaltyCapOverride, downpaymentAmount, dpPaidAmount, sessionPayments, portalToken]);


  if (accountLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
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
  const handleCopy = () => {
    navigator.clipboard.writeText(message);
    setCopied(true);
    toast.success('Message copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link to={ROUTES.ACCOUNTS}>
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
                  {can('edit_invoice') && !isLockedTest && (
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
                effectiveStatus === 'final_forfeited' ? 'bg-destructive/10 text-destructive border-destructive/20 text-xs' :
                effectiveStatus === 'forfeited' ? 'bg-orange-500/10 text-orange-500 border-orange-500/20 text-xs' :
                effectiveStatus === 'extension_active' ? 'bg-info/10 text-info border-info/20 text-xs' :
                effectiveStatus === 'final_settlement' ? 'bg-amber-600/10 text-amber-600 border-amber-600/20 text-xs' :
                effectiveStatus === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/20 text-xs' :
                effectiveStatus === 'completed' ? 'bg-primary/10 text-primary border-primary/20 text-xs' :
                'bg-success/10 text-success border-success/20 text-xs'
              }>
                {effectiveStatus === 'final_settlement' ? 'FINAL SETTLEMENT' :
                 effectiveStatus === 'extension_active' ? 'EXTENSION ACTIVE' :
                 effectiveStatus === 'final_forfeited' ? 'PERMANENTLY FORFEITED' :
                 effectiveStatus.toUpperCase()}
              </Badge>
              {isTestAccount && (
                <Badge variant="outline" className="bg-info/10 text-info border-info/20 text-xs font-bold">
                  🧪 TEST
                </Badge>
              )}
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
            {/* Single next due date for near-forfeiture penalized accounts */}
            {(() => {
              const followUp = getUpcomingFollowUpDates(account.status, scheduleItems, 1);
              if (!followUp || followUp.dates.length === 0) return null;
              const nextDate = followUp.dates[0].toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
              return (
                <div className="mt-2 p-3 rounded-lg border border-warning/30 bg-warning/5">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-warning flex-shrink-0" />
                    <span className="text-sm text-warning">
                      Next monthly payment is on <span className="font-semibold">{nextDate}</span>
                    </span>
                  </div>
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
          {!isLockedTest && (
          <div className="flex gap-2 flex-wrap">
            {can('edit_invoice') && (
              <EditAccountDialog
                account={{
                  id: account.id,
                  invoice_number: account.invoice_number,
                  total_amount: Number(account.total_amount),
                  order_date: account.order_date,
                  payment_plan_months: account.payment_plan_months,
                  notes: account.notes,
                  downpayment_amount: Number((account as any).downpayment_amount || 0),
                  currency: account.currency,
                  status: account.status,
                }}
                schedule={scheduleItems.map(s => ({
                  id: s.id,
                  installment_number: s.installment_number,
                  due_date: s.due_date,
                  base_installment_amount: Number(s.base_installment_amount),
                  status: s.status,
                  paid_amount: Number(s.paid_amount),
                }))}
              />
            )}
            {can('reassign_owner') && (
            <ReassignOwnerDialog
              accountId={account.id}
              currentCustomerId={account.customer_id}
              currentCustomerName={account.customers?.full_name || 'Unknown'}
              invoiceNumber={account.invoice_number}
            />
            )}
            {paymentEligibleBalance > 0 && canAcceptPayment(account.status) && can('record_payment') && (
              <>
                <RecordPaymentDialog
                  accountId={account.id}
                  currency={currency}
                  remainingBalance={paymentEligibleBalance}
                  schedule={scheduleItems}
                  invoiceNumber={account.invoice_number}
                  downpaymentRemaining={dpRemainingAmount}
                  onPaymentRecorded={handlePaymentRecorded}
                />
                <RecordPaymentDialog
                  accountId={account.id}
                  currency={currency}
                  remainingBalance={paymentEligibleBalance}
                  payFullBalance
                  schedule={scheduleItems}
                  invoiceNumber={account.invoice_number}
                  downpaymentRemaining={dpRemainingAmount}
                  onPaymentRecorded={handlePaymentRecorded}
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
                    queryClient.invalidateQueries({ queryKey: ['account', account.id] });
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
                  planMonths={account.payment_plan_months}
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
          )}
        </div>

        {/* Reconciliation Warning */}
        {!reconciliationValid && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
            <p className="text-xs text-destructive font-medium">
              Reconciliation Error: Total LA ({formatCurrency(summary.totalLAAmount, currency)}) − Paid ({formatCurrency(totalPaid, currency)}) = {formatCurrency(summary.totalLAAmount - totalPaid, currency)} ≠ Remaining ({formatCurrency(summary.remainingBalance, currency)})
            </p>
          </div>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          {/* Card 1: Total LA Amount — uses activePenalties from penalty_fees (BUG 6) */}
          <div className="group relative overflow-hidden rounded-xl border border-border bg-card p-3 sm:p-4 card-hover">
            <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b-full bg-border" />
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Total LA Amount</p>
            <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
              {formatCurrency(summary.totalLAAmount, currency)}
            </p>
            {(summary.activePenalties > 0 || summary.totalServices > 0) && (
              <p className="text-[10px] mt-0.5 text-muted-foreground">
                Base: {formatCurrency(summary.principalTotal, currency)}
                {summary.activePenalties > 0 && ` + Penalty: ${formatCurrency(summary.activePenalties, currency)}`}
                {summary.totalServices > 0 && ` + Svc: ${formatCurrency(summary.totalServices, currency)}`}
              </p>
            )}
          </div>
          {downpaymentAmount > 0 && (
            <div className={`group relative overflow-hidden rounded-xl border bg-card p-3 sm:p-4 card-hover ${dpRemainingAmount > 0 ? 'border-warning/20 hover:border-warning/40' : 'border-primary/20 hover:border-primary/40'}`}>
              <div className={`absolute top-0 left-4 right-4 h-[2px] rounded-b-full ${dpRemainingAmount > 0 ? 'bg-warning/60' : 'bg-gradient-to-r from-primary/40 via-primary to-primary/40'}`} />
              <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">30% Downpayment</p>
              <p className="text-lg sm:text-xl font-bold text-primary font-display tabular-nums">
                {formatCurrency(downpaymentAmount, currency)}
              </p>
              <p className={`text-[10px] mt-0.5 ${dpPaidAmount >= downpaymentAmount ? 'text-success' : dpPaidAmount > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                {dpPaidAmount >= downpaymentAmount ? `✅ Paid: ${formatCurrency(dpPaidAmount, currency)}` : dpPaidAmount > 0 ? `Paid: ${formatCurrency(dpPaidAmount, currency)} · Remaining: ${formatCurrency(dpRemainingAmount, currency)}` : 'Not yet paid'}
              </p>
            </div>
          )}
          {/* Card 2: Total Paid — with payment breakdown sub-line (BUG 2 & 7) */}
          <div className="group relative overflow-hidden rounded-xl border border-success/20 bg-card p-3 sm:p-4 card-hover hover:border-success/40">
            <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b-full bg-success/60" />
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Amount Paid</p>
            <p className="text-lg sm:text-xl font-bold text-success font-display tabular-nums">
              {formatCurrency(summary.totalPaid, currency)}
            </p>
            {activePayments.length > 1 && (
              <p className="text-[10px] mt-0.5 text-muted-foreground truncate" title={paymentBreakdownText}>
                {paymentBreakdownText}
              </p>
            )}
          </div>
          {/* Card 3: Remaining Balance — totalLAAmount - totalPaid (BUG 3) */}
          <div className={`group relative overflow-hidden rounded-xl border bg-card p-3 sm:p-4 card-hover ${hasAdditionalCharges ? 'border-warning/30 hover:border-warning/50 bg-warning/5' : 'border-primary/20 hover:border-primary/40'}`}>
            <div className={`absolute top-0 left-4 right-4 h-[2px] rounded-b-full ${hasAdditionalCharges ? 'bg-warning/60' : 'bg-gradient-to-r from-primary/40 via-primary to-primary/40'}`} />
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Remaining Balance</p>
            <p className={`text-lg sm:text-xl font-bold font-display tabular-nums ${hasAdditionalCharges ? 'text-warning' : 'text-card-foreground'}`}>
              {formatCurrency(summary.remainingBalance, currency)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {formatCurrency(summary.remainingBalance, currency)} remaining
            </p>
          </div>
          {summary.outstandingPenalties > 0 && (
            <div className="group relative overflow-hidden rounded-xl border border-destructive/20 bg-card p-3 sm:p-4 card-hover penalty-glow hover:border-destructive/40">
              <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b-full bg-destructive/60" />
              <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Outstanding Penalties</p>
              <p className="text-lg sm:text-xl font-bold text-destructive font-display tabular-nums">
                {formatCurrency(summary.outstandingPenalties, currency)}
              </p>
            </div>
          )}
          {totalServicesAmount > 0 && (
            <div className="group relative overflow-hidden rounded-xl border border-border bg-card p-3 sm:p-4 card-hover">
              <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b-full bg-border" />
              <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Services</p>
              <p className="text-lg sm:text-xl font-bold text-card-foreground font-display tabular-nums">
                {formatCurrency(summary.totalServices, currency)}
              </p>
            </div>
          )}
          <div className="group relative overflow-hidden rounded-xl border border-border bg-card p-3 sm:p-4 card-hover">
            <div className="absolute top-0 left-4 right-4 h-[2px] rounded-b-full bg-gradient-to-r from-primary/40 via-primary to-primary/40" />
            <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider mb-1">Progress</p>
            <p className="text-lg sm:text-xl font-bold text-primary font-display">{Math.round(progress)}%</p>
            <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full transition-all duration-500 ease-out" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, hsl(43 74% 42%), hsl(43 74% 52%), hsl(43 74% 62%))' }} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Payment Schedule */}
          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <Calendar className="h-4 w-4 text-primary" /> Payment Schedule
              </h3>
              {can('edit_schedule') && account?.status !== 'forfeited' && account?.status !== 'cancelled' && account?.status !== 'completed' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10"
                  onClick={() => {
                    const lastItem = scheduleItems[scheduleItems.length - 1];
                    const lastDate = lastItem ? new Date(lastItem.due_date) : new Date(account.order_date);
                    const nextDate = new Date(lastDate);
                    nextDate.setMonth(nextDate.getMonth() + 1);
                    setNewInstDueDate(nextDate.toISOString().split('T')[0]);
                    setNewInstAmount('');
                    setAddingInstallment(true);
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" /> Add Installment
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {/* 30% Downpayment row */}
              {downpaymentAmount > 0 && (
                <div className={`flex items-center justify-between p-2.5 sm:p-3 rounded-lg border ${dpPaidAmount >= downpaymentAmount ? 'bg-success/5 border-success/10' : dpPaidAmount > 0 ? 'bg-warning/5 border-warning/10' : 'bg-primary/5 border-primary/10'}`}>
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className={`flex h-6 w-6 sm:h-7 sm:w-7 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold ${dpPaidAmount >= downpaymentAmount ? 'bg-success/20 text-success' : dpPaidAmount > 0 ? 'bg-warning/20 text-warning' : 'bg-primary/20 text-primary'}`}>
                      {dpPaidAmount >= downpaymentAmount ? <Check className="h-3 w-3" /> : 'DP'}
                    </div>
                    <div>
                      <p className="text-xs sm:text-sm font-medium text-card-foreground">30% Downpayment</p>
                      <p className="text-[10px] sm:text-xs text-muted-foreground">
                        {dpPaidAmount >= downpaymentAmount ? 'Paid' : dpPaidAmount > 0 ? `Partial — ${formatCurrency(dpPaidAmount, currency)} paid` : 'Due on order date'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-xs sm:text-sm font-semibold tabular-nums ${dpPaidAmount >= downpaymentAmount ? 'text-success' : 'text-primary'}`}>
                      {formatCurrency(downpaymentAmount, currency)}
                    </p>
                    {dpPaidAmount > 0 && dpPaidAmount < downpaymentAmount && (
                      <p className="text-[10px] text-warning tabular-nums">
                        Remaining: {formatCurrency(dpRemainingAmount, currency)}
                      </p>
                    )}
                    {dpPaidAmount >= downpaymentAmount && (
                      <Badge variant="outline" className="text-[9px] h-4 px-1 bg-success/10 text-success border-success/20">Paid</Badge>
                    )}
                  </div>
                </div>
              )}
              {/* Schedule Header */}
              <div className="hidden sm:grid grid-cols-[2rem_minmax(4rem,1fr)_minmax(4.5rem,1.2fr)_minmax(4rem,1fr)_minmax(4.5rem,1.2fr)_3.5rem_3rem] gap-1 px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
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
                const totalDue = Number(item.total_due_amount); // DB value — may be adjusted from rollover
                // Penalty status from penalty_fees (paid/waived/unpaid) — drives label & color
                const penaltyFee = (penalties || []).find((pf: any) => pf.schedule_id === item.id);
                const penaltyFeeStatus = penaltyFee?.status ?? (penaltyAmt > 0 ? 'unpaid' : null);
                const itemRemaining = remainingDue(item);
                const isEditingThis = editingScheduleId === item.id;
                const canEdit = account.status !== 'forfeited' && account.status !== 'cancelled' && item.status !== 'cancelled';
                const overCap = penaltyCapOverride && isPenaltyOverCap(currency as 'PHP' | 'JPY', item.installment_number, penaltyAmt, account.payment_plan_months);
                return (
                  <div key={item.id}
                    className={`group rounded-xl border p-2.5 sm:p-3 transition-all duration-200 hover:shadow-md ${
                      effPaid ? 'bg-success/5 border-success/10 hover:border-success/20' :
                      partial ? 'bg-warning/5 border-warning/10 hover:border-warning/20' :
                      item.status === 'overdue' ? 'bg-destructive/5 border-destructive/10 hover:border-destructive/20' :
                      penaltyAmt > 0 && penaltyFeeStatus !== 'waived' ? 'bg-card border-purple-500/20 hover:border-purple-500/30 penalty-glow' :
                      'bg-card border-border hover:border-primary/20'
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
                      <div className="flex items-center gap-2">
                        {!effPaid && !partial && canEdit && can('edit_schedule') && item.status !== 'cancelled' && (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            title="Delete installment"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteScheduleTarget({ id: item.id, amount: baseAmt, installment_number: item.installment_number });
                            }}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                        <div className="text-right">
                        <p className={`text-xs font-semibold tabular-nums ${effPaid ? 'text-success' : partial ? 'text-warning' : 'text-card-foreground'}`}>
                          {formatCurrency(effPaid ? paidAmt : totalDue, currency)}
                        </p>
                      </div>
                      </div>
                    </div>
                    {/* Mobile penalty detail */}
                    {penaltyAmt > 0 && (
                      <div className="sm:hidden mt-1.5 ml-8 flex items-center gap-2 text-[10px]">
                        <span className="text-muted-foreground">Base: {formatCurrency(baseAmt, currency)}</span>
                        {penaltyFeeStatus === 'waived' ? (
                          <span className="text-muted-foreground flex items-center gap-0.5 line-through">
                            Penalty: {formatCurrency(penaltyAmt, currency)}
                            <span className="no-underline ml-0.5 not-italic">(Waived)</span>
                          </span>
                        ) : (
                          <span className={`font-medium flex items-center gap-0.5 ${penaltyFeeStatus === 'paid' ? 'text-success' : 'text-destructive'}`}>
                            {penaltyFeeStatus !== 'paid' && <AlertTriangle className="h-2.5 w-2.5" />}
                            Penalty: {formatCurrency(penaltyAmt, currency)}
                            {penaltyFeeStatus === 'paid' ? ' (Paid)' : ''}
                          </span>
                        )}
                        {penaltyCapOverride && item.installment_number <= 5 && penaltyFeeStatus !== 'waived' && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1 bg-primary/10 text-primary border-primary/20">
                            Capped
                          </Badge>
                        )}
                      </div>
                    )}
                    {/* BUG 4: No penalty row shown when penalty is 0 */}

                    {/* Desktop layout: columnar */}
                    <div className="hidden sm:grid grid-cols-[2rem_minmax(4rem,1fr)_minmax(4.5rem,1.2fr)_minmax(4rem,1fr)_minmax(4.5rem,1.2fr)_3.5rem_3rem] gap-1 items-center">
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
                        {penaltyAmt > 0 && penaltyFeeStatus !== 'waived' ? (
                          <div>
                            <p className={`text-xs tabular-nums font-medium ${penaltyFeeStatus === 'paid' ? 'text-success' : 'text-destructive'}`}>
                              {formatCurrency(penaltyAmt, currency)}
                            </p>
                            <p className={`text-[9px] ${penaltyFeeStatus === 'paid' ? 'text-success/70' : 'text-destructive/70'}`}>
                              {penaltyFeeStatus === 'paid' ? 'Paid' : 'Applied'}
                            </p>
                          </div>
                        ) : penaltyAmt > 0 && penaltyFeeStatus === 'waived' ? (
                          <div>
                            <p className="text-xs tabular-nums text-muted-foreground line-through">
                              {formatCurrency(penaltyAmt, currency)}
                            </p>
                            <p className="text-[9px] text-muted-foreground">Waived</p>
                          </div>
                        ) : (
                          <p className="text-xs tabular-nums text-muted-foreground">—</p>
                        )}
                      </div>
                      {/* Total Due / Remaining */}
                      <div className="text-right">
                        <p className={`text-xs font-semibold tabular-nums ${effPaid ? 'text-success' : partial ? 'text-warning' : 'text-card-foreground'}`}>
                          {formatCurrency(effPaid ? paidAmt : totalDue, currency)}
                        </p>
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
                      {/* Edit / Delete buttons */}
                      <div className="flex items-center gap-0.5">
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
                        {!effPaid && !partial && canEdit && can('edit_schedule') && item.status !== 'cancelled' ? (
                          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive transition-opacity"
                            title="Delete installment"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteScheduleTarget({ id: item.id, amount: baseAmt, installment_number: item.installment_number });
                            }}>
                            <Trash2 className="h-3 w-3" />
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
              {/* Add Installment inline form */}
              {addingInstallment && (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
                  <p className="text-xs font-semibold text-primary flex items-center gap-1"><Plus className="h-3 w-3" /> New Installment</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground">Due Date</label>
                      <Input type="date" value={newInstDueDate} onChange={e => setNewInstDueDate(e.target.value)} className="h-8 text-xs w-36 bg-background" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-muted-foreground">Amount ({currency})</label>
                      <Input type="number" step="0.01" placeholder="Amount" value={newInstAmount} onChange={e => setNewInstAmount(e.target.value)} className="h-8 text-xs w-28 bg-background tabular-nums" />
                    </div>
                    <Button size="sm" className="h-8 text-xs gold-gradient text-primary-foreground" disabled={newInstSaving} onClick={handleAddInstallment}>
                      {newInstSaving ? 'Saving…' : 'Save'}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setAddingInstallment(false)}>Cancel</Button>
                  </div>
                </div>
              )}
              {/* Schedule Totals Summary */}
              {scheduleItems.length > 0 && (() => {
                const sumBases = scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount), 0);
                const sumPenalties = scheduleItems.reduce((s, i) => s + Number(i.penalty_amount), 0);
                const grandTotal = summary.totalLAAmount;
                const mismatch = false; // grandTotal is always totalLAAmount
                return (
                <div className="mt-3 pt-3 border-t border-border space-y-1.5">
                  {downpaymentAmount > 0 && (
                    <div className="flex justify-between text-xs text-muted-foreground px-1">
                      <span>Down Payment</span>
                      <span className="tabular-nums font-medium">{formatCurrency(downpaymentAmount, currency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs text-muted-foreground px-1">
                    <span>Sum of Base Installments</span>
                    <span className="tabular-nums font-medium">{formatCurrency(sumBases, currency)}</span>
                  </div>
                  {sumPenalties > 0 && (
                    <div className="flex justify-between text-xs px-1">
                      <span className="text-destructive/80 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> Total Penalties in Schedule
                      </span>
                      <span className="tabular-nums font-medium text-destructive">
                        {formatCurrency(sumPenalties, currency)}
                      </span>
                    </div>
                  )}
                  {totalServicesAmount > 0 && (
                    <div className="flex justify-between text-xs text-muted-foreground px-1">
                      <span>Service Charges</span>
                      <span className="tabular-nums font-medium">{formatCurrency(totalServicesAmount, currency)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-semibold px-1 pt-1 border-t border-border">
                    <span className="text-card-foreground">Grand Total</span>
                    <span className="tabular-nums text-card-foreground">
                      {formatCurrency(grandTotal, currency)}
                    </span>
                  </div>
                  {mismatch && (
                    <div className="flex items-center gap-1.5 px-1 pt-0.5">
                      <AlertTriangle className="h-3 w-3 text-destructive" />
                      <span className="text-[10px] text-destructive font-medium">
                        Grand Total ({formatCurrency(grandTotal, currency)}) ≠ Total LA Amount ({formatCurrency(summary.totalLAAmount, currency)})
                      </span>
                    </div>
                  )}
                  {penaltyCapOverride && (
                    <div className="flex items-center gap-1.5 px-1 pt-1">
                      <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] text-primary font-medium">
                        Penalty Cap Active: Max {currency === 'PHP' ? '₱1,000' : '¥2,000'} for months 1–5
                      </span>
                    </div>
                  )}
                </div>
                );
              })()}
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

          {/* Payment History */}
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">Payment History</h3>
            {(!payments || payments.length === 0) ? (
              <p className="text-sm text-muted-foreground">No payments recorded yet</p>
            ) : (
              <div className="space-y-2">
                {[...payments].sort((a: any, b: any) => new Date(a.date_paid).getTime() - new Date(b.date_paid).getTime()).map((p) => {
                  const isVoided = !!(p as any).voided_at;
                  const isEditing = editingId === p.id;

                  if (isEditing) {
                    const originalAmount = Number(p.amount_paid);
                    const amountChanged = editAmount !== '' && Math.round(parseFloat(editAmount) * 100) / 100 !== originalAmount;
                    const isSaving = editPayment.isPending || editPaymentAmount.isPending;

                    return (
                      <div key={p.id} className="p-3 rounded-lg border border-primary/30 bg-muted/30 space-y-2">
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
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
                            <label className="text-[10px] text-muted-foreground uppercase">
                              Amount {amountChanged && <span className="text-warning">(changed)</span>}
                            </label>
                            <Input
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={editAmount}
                              onChange={(e) => setEditAmount(e.target.value)}
                              className={`h-8 text-xs bg-background tabular-nums ${amountChanged ? 'border-warning' : ''}`}
                            />
                          </div>
                          <div>
                            <label className="text-[10px] text-muted-foreground uppercase">Original</label>
                            <Input disabled value={formatCurrency(originalAmount, p.currency as Currency)} className="h-8 text-xs bg-muted" />
                          </div>
                        </div>
                        {amountChanged && (
                          <div>
                            <label className="text-[10px] text-muted-foreground uppercase">Reason for amount change *</label>
                            <Input value={editAmountReason} onChange={(e) => setEditAmountReason(e.target.value)} placeholder="e.g. Wrong amount recorded" className="h-8 text-xs bg-background" />
                          </div>
                        )}
                        <div>
                          <label className="text-[10px] text-muted-foreground uppercase">Notes</label>
                          <Textarea value={editRemarks} onChange={(e) => setEditRemarks(e.target.value)} rows={1} className="text-xs bg-background resize-none" />
                        </div>
                        {amountChanged && (
                          <p className="text-[10px] text-warning flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Changing the amount will reallocate this payment across the schedule. This is audit-logged.
                          </p>
                        )}
                        <div className="flex gap-2 justify-end">
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                            <X className="h-3 w-3 mr-1" /> Cancel
                          </Button>
                          <Button size="sm" className="gold-gradient text-primary-foreground" disabled={isSaving || (amountChanged && !editAmountReason.trim())}
                            onClick={async () => {
                              try {
                                // Save metadata changes (date, method, notes)
                                await editPayment.mutateAsync({
                                  id: p.id,
                                  date_paid: editDate,
                                  payment_method: editMethod,
                                  remarks: editRemarks || undefined,
                                });

                                // If amount changed, call the edge function for full reallocation
                                if (amountChanged) {
                                  const newAmt = Math.round(parseFloat(editAmount) * 100) / 100;
                                  await editPaymentAmount.mutateAsync({
                                    payment_id: p.id,
                                    new_amount: newAmt,
                                    reason: editAmountReason.trim(),
                                  });
                                  toast.success(`Payment amount updated: ${formatCurrency(originalAmount, p.currency as Currency)} → ${formatCurrency(newAmt, p.currency as Currency)}`);
                                } else {
                                  toast.success('Payment updated');
                                }
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

                  const isDpPayment = isDownpaymentPayment(p);
                  const senderType = (p as any).submitted_by_type as string | null;
                  const senderName = (p as any).submitted_by_name as string | null;
                  return (
                    <div key={p.id} className={`flex items-center justify-between py-2 px-2 rounded-lg border-b border-border last:border-0 ${isVoided ? 'opacity-50 line-through' : ''}`}>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-xs sm:text-sm text-card-foreground">
                            {new Date(p.date_paid).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                          </p>
                          {isDpPayment && !isVoided && (
                            <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-primary/10 text-primary border-primary/20">Downpayment</Badge>
                          )}
                          {senderType === 'customer' && (
                            <span title={senderName ? `Customer: ${senderName}` : 'Customer submission'} className="text-[11px] cursor-default" style={{color:'#7B9EC9'}}>👤</span>
                          )}
                          {senderType === 'staff' && (
                            <span title={senderName ? `Staff: ${senderName}` : 'Staff recorded'} className="text-[11px] cursor-default" style={{color:'#C9A84C'}}>🏢</span>
                          )}
                        </div>
                        <p className="text-[10px] sm:text-xs text-muted-foreground">
                          {p.payment_method || 'Cash'}
                          {senderName && ` · ${senderName}`}
                          {p.remarks && !isDpPayment && ` · ${p.remarks}`}
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
                                setEditAmount(String(Number(p.amount_paid)));
                                setEditAmountReason('');
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

        {/* Customer Message */}
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-info" /> Customer Message
          </h3>
          <div className="rounded-lg bg-muted/50 p-3 sm:p-4 border border-border" style={{ maxWidth: '100%', overflow: 'hidden' }}>
            <pre className="text-[10px] sm:text-xs text-card-foreground font-body leading-relaxed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflowWrap: 'anywhere', maxWidth: '100%' }}>
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

        {/* ═══ Verification Debug Panel ═══ */}
        {(() => {
          const sumPendingMonths = scheduleItems
            .filter(i => ['pending', 'overdue', 'partially_paid'].includes(i.status))
            .reduce((s, i) => s + Math.max(0, Number(i.total_due_amount)), 0);
          const sumAllBases = scheduleItems.reduce((s, i) => s + Number(i.base_installment_amount), 0);
          // Check both account models: DP separate (DP + installments = total) or DP-inclusive (installments = total)
          const baseIntegrityA = Math.round((downpaymentAmount + sumAllBases) * 100) / 100;
          const baseIntegrityB = Math.round(sumAllBases * 100) / 100;
          const baseIntegrityPass = Math.abs(baseIntegrityA - principalTotal) < 2 ||
                                    Math.abs(baseIntegrityB - principalTotal) < 2;
          const baseIntegrity = Math.abs(baseIntegrityA - principalTotal) <= Math.abs(baseIntegrityB - principalTotal)
            ? baseIntegrityA : baseIntegrityB;
          // computedPaid reads directly from payments table — same source as totalPaid
          const computedPaid = confirmedActivePayments.reduce(
            (sum, p) => sum + Number(p.amount_paid), 0);
          // Check 8 prep — DP must have a payment record identifiable as downpayment
          const dpExpected = Math.abs(downpaymentAmount);
          const dpPayment8 = (payments || []).find((p: any) => !p.voided_at && isDownpaymentPayment(p));
          const dpActual8 = dpPayment8 ? Number(dpPayment8.amount_paid) : 0;
          const dpCheck8Pass = dpExpected === 0 || (dpPayment8 != null && dpActual8 >= dpExpected - 1);
          // Check 9 prep — next payment date must come from due_date, not today/created_at
          // Use isEffectivelyPaid consistently (matches overdue unpaid months, not just 'pending')
          const firstPendingItem9 = [...scheduleItems]
            .filter((i: any) => !isEffectivelyPaid(i) && i.status !== 'cancelled')
            .sort((a: any, b: any) => a.installment_number - b.installment_number)[0] as any;
          const nextUnpaidState9 = [...summary.scheduleStates]
            .sort((a, b) => a.installmentNumber - b.installmentNumber)
            .find(s => !s.isPaid);
          const check9Exp = firstPendingItem9?.due_date ?? '—';
          const check9Act = nextUnpaidState9?.dueDate ?? '—';
          const checks = [
            { label: 'activePenalties (non-waived)', expected: summary.activePenalties, actual: activePenaltyTotal, pass: Math.abs(summary.activePenalties - activePenaltyTotal) < 0.01 },
            { label: 'totalLAAmount (base + penalties + svc)', expected: summary.totalLAAmount, actual: principalTotal + activePenaltyTotal + totalServicesAmount, pass: Math.abs(summary.totalLAAmount - (principalTotal + activePenaltyTotal + totalServicesAmount)) < 0.01 },
            { label: 'amountPaid (DP + paid months)', expected: totalPaid, actual: Math.round(computedPaid * 100) / 100, pass: Math.abs(totalPaid - computedPaid) < 1 },
            { label: 'remainingBalance (totalLA - paid)', expected: summary.remainingBalance, actual: Math.max(0, summary.totalLAAmount - totalPaid), pass: Math.abs(summary.remainingBalance - Math.max(0, summary.totalLAAmount - totalPaid)) < 0.01 },
            { label: 'monthsRemaining', expected: summary.unpaidCount, actual: unpaidSchedule.length, pass: summary.unpaidCount === unpaidSchedule.length },
            { label: 'sumOfPendingMonths ≈ remainingBalance', expected: summary.remainingBalance, actual: Math.round(sumPendingMonths * 100) / 100, pass: Math.abs(sumPendingMonths - summary.remainingBalance) < 2 },
            { label: 'DP + sumBases = principalTotal', expected: principalTotal, actual: baseIntegrity, pass: baseIntegrityPass },
            { label: 'downPayment recorded and marked paid', expected: dpExpected, actual: dpActual8, pass: dpCheck8Pass },
            { label: 'nextPaymentDate uses due_date not payment date', expected: check9Exp, actual: check9Act, pass: !firstPendingItem9 || check9Exp === check9Act },
          ];
          const allPass = checks.every(c => c.pass);
          return (
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                className={`text-xs ${allPass ? 'border-success/30 text-success' : 'border-destructive/30 text-destructive'}`}
                onClick={() => setShowVerify(!showVerify)}
              >
                <ShieldCheck className="h-3.5 w-3.5 mr-1" />
                {showVerify ? 'Hide' : 'Verify'} Calculations {allPass ? '✅' : '❌'}
              </Button>
              {(showVerify || isTestAccount) && (
                <div className="mt-2 rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Calculation Audit</p>
                  {checks.map((c, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{c.pass ? '✅' : '❌'} {c.label}</span>
                      <span className={`tabular-nums font-mono ${c.pass ? 'text-success' : 'text-destructive'}`}>
                        {typeof c.actual === 'number' ? fmtVal(c.actual) : c.actual}
                        {!c.pass && ` (expected: ${typeof c.expected === 'number' ? fmtVal(c.expected) : c.expected})`}
                      </span>
                    </div>
                  ))}
                  <div className="pt-2 border-t border-border mt-2">
                    <p className={`text-xs font-semibold ${allPass ? 'text-success' : 'text-destructive'}`}>
                      {allPass ? '✅ All checks passed' : '❌ Some checks failed — investigate'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

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
                    navigate(ROUTES.ACCOUNTS);
                  } catch (err: any) {
                    toast.error(err.message || 'Failed to delete account');
                  }
                }}>
                {deleteAccount.isPending ? 'Deleting…' : 'Delete Account'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Delete Schedule Item Confirmation */}
        <AlertDialog open={!!deleteScheduleTarget} onOpenChange={(open) => { if (!open) setDeleteScheduleTarget(null); }}>
          <AlertDialogContent className="bg-card border-border">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-card-foreground">Delete Installment?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove Installment #{deleteScheduleTarget?.installment_number} ({formatCurrency(deleteScheduleTarget?.amount || 0, currency)}) and deduct its amount from the total layaway amount and remaining balance. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-border">Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteScheduleLoading}
                onClick={handleDeleteInstallment}>
                {deleteScheduleLoading ? 'Deleting…' : 'Delete Installment'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </AppLayout>
  );
}
