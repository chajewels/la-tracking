import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Layers, CheckCircle2, Copy, Check, MessageCircle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { type AppRole } from '@/lib/role-permissions';
import {
  computeWaterfall, getRowStatus, isRowPaid, getRowRemaining, getRowAllocated,
  type ScheduleViewRow, type WaterfallResult,
} from '@/lib/business-rules';

interface ScheduleItem {
  id: string;
  installment_number: number;
  due_date: string;
  base_installment_amount: number;
  penalty_amount: number;
  total_due_amount: number;
  paid_amount: number;
  status: string;
}

interface AccountInfo {
  id: string;
  invoice_number: string;
  currency: string;
  remaining_balance: number;
  total_amount: number;
  total_paid: number;
  status: string;
  schedule?: ScheduleItem[];
  notes?: string | null;
}

interface MultiInvoicePaymentDialogProps {
  customerId: string;
  customerName: string;
  accounts: AccountInfo[];
  portalLink?: string | null;
}

interface AccountResult {
  account_id: string;
  invoice_number: string;
  amount_allocated: number;
  new_total_paid: number;
  new_remaining_balance: number;
  new_status: string;
  payment_allocations: Array<{
    allocation_type: 'penalty' | 'installment';
    allocated_amount: number;
  }>;
}

// Detect partial items using BOTH DB status AND computed check:
// DB status may be stale ('paid'/'pending') while item actually has partial payment,
// OR post-reconcile total_due was reduced so paid_amount >= total_due looks "paid"
function isPartialItem(s: ScheduleItem): boolean {
  return s.status === 'partially_paid' ||
    (s.status !== 'paid' && s.status !== 'cancelled' && s.paid_amount > 0 && s.paid_amount < s.base_installment_amount);
}

function getNextUnpaidItem(schedule?: ScheduleItem[]) {
  if (!schedule) return null;
  const sorted = [...schedule]
    .filter(s => s.status !== 'paid' && s.status !== 'cancelled')
    .sort((a, b) => a.installment_number - b.installment_number);
  // Priority: partially_paid → overdue → pending
  // Check both DB status and computed partial detection for robustness
  const result = (
    sorted.find(s => isPartialItem(s)) ??
    sorted.find(s => !isPartialItem(s) && s.status === 'overdue') ??
    sorted.find(s => !isPartialItem(s) && s.status === 'pending') ??
    null
  );
  return result;
}

// Remaining amount: if paid < total_due, not yet reconciled → total_due - paid; otherwise total_due IS remaining
function computeItemRemaining(item: ScheduleItem): number {
  if (isPartialItem(item)) {
    return item.paid_amount < item.total_due_amount
      ? Math.max(0, item.total_due_amount - item.paid_amount)
      : Math.max(0, item.total_due_amount);
  }
  return Math.max(0, item.total_due_amount);
}

function getNextDueInfo(schedule?: ScheduleItem[]) {
  const item = getNextUnpaidItem(schedule);
  if (!item) return null;
  const due = computeItemRemaining(item);
  return {
    date: item.due_date,
    amount: due,
    dateLabel: new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}

function getLabelFromNotes(notes?: string | null, invoiceNumber?: string): string {
  if (notes && notes.startsWith('LA ')) return notes;
  return `INV #${invoiceNumber}`;
}

// Conditionally show reference number for these methods
const METHODS_WITH_REF = ['gcash', 'bdo', 'bpi', 'metrobank', 'rakuten', 'sumitomo', 'jp_bank', 'paypay', 'credit_card'];

export default function MultiInvoicePaymentDialog({
  customerId,
  customerName,
  accounts,
  portalLink,
}: MultiInvoicePaymentDialogProps) {
  const queryClient = useQueryClient();
  const { roles } = useAuth();
  const r = roles as AppRole[];
  const isAdminOrFinance = r.includes('admin') || r.includes('finance');
  const submittingRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'input' | 'message'>('input');
  const [carryOverMap, setCarryOverMap] = useState<Record<string, boolean>>({});
  const [consolidatedMessage, setConsolidatedMessage] = useState('');
  const [msgCopied, setMsgCopied] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Waterfall state
  const [scheduleViewRows, setScheduleViewRows] = useState<Record<string, ScheduleViewRow[]>>({});
  const [waterfallResults, setWaterfallResults] = useState<Record<string, WaterfallResult>>({});
  const waterfallTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const payableAccounts = useMemo(() =>
    accounts.filter(a => (a.status === 'active' || a.status === 'overdue') && a.remaining_balance > 0),
    [accounts]
  );

  // Fetch schedule_with_actuals for all payable accounts when dialog opens
  useEffect(() => {
    if (!open || payableAccounts.length === 0) return;
    let cancelled = false;
    (async () => {
      const rowsMap: Record<string, ScheduleViewRow[]> = {};
      for (const a of payableAccounts) {
        const { data } = await supabase
          .from('schedule_with_actuals')
          .select('*')
          .eq('account_id', a.id)
          .order('due_date', { ascending: true });
        if (cancelled) return;
        if (data) {
          rowsMap[a.id] = data.map((r: any) => ({
            id: r.id,
            account_id: r.account_id,
            installment_number: r.installment_number,
            due_date: r.due_date,
            base_installment_amount: r.base_installment_amount,
            penalty_amount: r.penalty_amount,
            carried_amount: r.carried_amount,
            currency: r.currency,
            db_status: r.db_status,
            allocated: r.allocated,
            actual_remaining: r.actual_remaining,
            computed_status: r.computed_status,
          }));
        }
      }
      if (!cancelled) setScheduleViewRows(rowsMap);
    })();
    return () => { cancelled = true; };
  }, [open, payableAccounts]);

  // Initialize: pre-check all, pre-fill amounts
  useEffect(() => {
    if (open && payableAccounts.length > 0) {
      const ids = new Set(payableAccounts.map(a => a.id));
      setSelectedIds(ids);
      const amts: Record<string, string> = {};
      for (const a of payableAccounts) {
        const nextDue = getNextDueInfo(a.schedule);
        amts[a.id] = nextDue ? String(nextDue.amount) : String(a.remaining_balance);
      }
      setAmounts(amts);
    }
  }, [open, payableAccounts]);

  // Debounced waterfall computation per account
  const runWaterfall = useCallback((accountId: string, amount: number) => {
    if (waterfallTimers.current[accountId]) clearTimeout(waterfallTimers.current[accountId]);
    waterfallTimers.current[accountId] = setTimeout(() => {
      const rows = scheduleViewRows[accountId];
      if (!rows || rows.length === 0 || isNaN(amount) || amount <= 0) {
        setWaterfallResults(prev => {
          const next = { ...prev };
          delete next[accountId];
          return next;
        });
        return;
      }
      const result = computeWaterfall(amount, rows);
      setWaterfallResults(prev => ({ ...prev, [accountId]: result }));
    }, 300);
  }, [scheduleViewRows]);

  // Trigger waterfall when amounts or scheduleViewRows change
  useEffect(() => {
    for (const a of payableAccounts) {
      if (selectedIds.has(a.id)) {
        const val = parseFloat(amounts[a.id] || '0') || 0;
        runWaterfall(a.id, val);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amounts, selectedIds, scheduleViewRows]);

  const selectedAccounts = useMemo(() =>
    payableAccounts.filter(a => selectedIds.has(a.id)),
    [payableAccounts, selectedIds]
  );

  const totalAllocated = useMemo(
    () => selectedAccounts.reduce((s, a) => s + (parseFloat(amounts[a.id] || '0') || 0), 0),
    [selectedAccounts, amounts]
  );

  const allocationErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const a of selectedAccounts) {
      const val = parseFloat(amounts[a.id] || '0') || 0;
      if (val <= 0) errs[a.id] = 'Enter an amount';
      else if (val > a.remaining_balance + 1) errs[a.id] = 'Exceeds balance';
      // Waterfall error
      const wf = waterfallResults[a.id];
      if (wf && !wf.valid && val > 0) errs[a.id] = wf.error || 'Invalid allocation';
    }
    return errs;
  }, [selectedAccounts, amounts, waterfallResults]);

  const canSubmit =
    selectedAccounts.length >= 1 &&
    Object.keys(allocationErrors).length === 0 &&
    totalAllocated > 0;

  const showRefField = METHODS_WITH_REF.includes(paymentMethod);

  const toggleAccount = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const allocations = selectedAccounts.map(a => ({
        account_id: a.id,
        amount: parseFloat(amounts[a.id] || '0'),
        carry_over: carryOverMap[a.id] || false,
      }));
      const { data, error } = await supabase.functions.invoke('record-multi-payment', {
        body: {
          customer_id: customerId,
          total_amount_paid: totalAllocated,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          remarks: referenceNumber ? `Ref: ${referenceNumber}` : undefined,
          preview_only: false,
          allocations,
        },
      });
      if (error) throw error;
      if (data?.submitted_for_confirmation) {
        toast.success('Payments submitted for confirmation. Admin/Finance will review.');
        resetAndClose();
        return;
      }
      toast.success(
        `Split payment of ${totalAllocated.toLocaleString()} recorded across ${selectedAccounts.length} account${selectedAccounts.length !== 1 ? 's' : ''}`
      );
      // Invalidate queries
      for (const key of ['accounts', 'payments', 'schedule', 'dashboard-summary', 'payments-with-accounts']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });

      // Build confirmation message
      const msg = buildConfirmationMessage(data?.account_results || []);
      setConsolidatedMessage(msg);
      setStep('message');
    } catch (err: any) {
      toast.error(err.message || 'Failed to record split payment');
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const buildConfirmationMessage = (results: AccountResult[]) => {
    const primaryCurrency = (selectedAccounts[0]?.currency || 'PHP') as Currency;
    const N = selectedAccounts.length;
    let msg = `Thank you for your payment. A total of ${formatCurrency(totalAllocated, primaryCurrency)} has been received across ${N} account${N !== 1 ? 's' : ''}:\n\n`;

    // Line per paid account
    const fullyPaidIds: string[] = [];
    for (const acct of selectedAccounts) {
      const amt = parseFloat(amounts[acct.id] || '0') || 0;
      const cur = (acct.currency || 'PHP') as Currency;
      const label = getLabelFromNotes(acct.notes, acct.invoice_number);
      const result = results.find(r => r.account_id === acct.id);
      const isNowFullyPaid = result ? result.new_remaining_balance <= 0 : false;
      if (isNowFullyPaid) fullyPaidIds.push(acct.id);
      msg += `  Inv #${acct.invoice_number} — ${label}: ${formatCurrency(amt, cur)}`;
      if (isNowFullyPaid) msg += ` (Fully Paid ✅)`;
      msg += `\n`;
    }

    // Portal link
    if (portalLink) {
      msg += `\nView your accounts here:\n🔗 ${portalLink}\n`;
    }

    // Next payments
    const nextPayments: string[] = [];
    for (const acct of selectedAccounts) {
      if (fullyPaidIds.includes(acct.id)) continue;
      // After payment, find the next unpaid item
      // We need to look at schedule - the next due may have shifted
      const nextDue = getNextDueInfo(acct.schedule);
      if (nextDue) {
        const cur = (acct.currency || 'PHP') as Currency;
        const label = getLabelFromNotes(acct.notes, acct.invoice_number);
        const dateStr = new Date(nextDue.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        nextPayments.push(`  ${label} — ${dateStr}: ${formatCurrency(nextDue.amount, cur)}`);
      }
    }

    if (fullyPaidIds.length === selectedAccounts.length) {
      msg += `\n🎉 All your layaway accounts are now fully paid! Thank you!\n`;
    } else if (nextPayments.length > 0) {
      msg += `\nNext payments:\n`;
      msg += nextPayments.join('\n') + '\n';
    }

    msg += `\nThank you for your continued trust in Cha Jewels! 🧡`;
    return msg;
  };

  const resetAndClose = () => {
    setSelectedIds(new Set());
    setAmounts({});
    setCarryOverMap({});
    setReferenceNumber('');
    setPaymentMethod('cash');
    setPaymentDate(new Date().toISOString().split('T')[0]);
    setStep('input');
    setConsolidatedMessage('');
    setMsgCopied(false);
    setWaterfallResults({});
    setScheduleViewRows({});
    setOpen(false);
  };

  if (payableAccounts.length < 1) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10 font-medium">
          <Layers className="h-4 w-4 mr-1.5" /> Split Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-lg max-h-[85vh] overflow-y-auto">
        {step === 'input' && (
          <>
            <DialogHeader>
              <DialogTitle className="font-display text-card-foreground">
                Split Payment — {customerName}
              </DialogTitle>
              <DialogDescription>
                Record one payment split across multiple accounts
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <p className="text-xs text-muted-foreground font-medium">Select accounts to include:</p>
              <div className="space-y-2">
                {payableAccounts.map(a => {
                  const cur = a.currency as Currency;
                  const checked = selectedIds.has(a.id);
                  const nextDue = getNextDueInfo(a.schedule);
                  const label = getLabelFromNotes(a.notes, a.invoice_number);
                  // Underpayment detection for this account
                  const enteredAmt = parseFloat(amounts[a.id] || '0') || 0;
                  const firstUnpaidItem = getNextUnpaidItem(a.schedule);
                  const firstItemEffDue = firstUnpaidItem
                    ? (firstUnpaidItem.status === 'partially_paid' && Number(firstUnpaidItem.paid_amount) > Number(firstUnpaidItem.total_due_amount)
                        ? Number(firstUnpaidItem.total_due_amount)
                        : Math.max(0, Number(firstUnpaidItem.total_due_amount) - Number(firstUnpaidItem.paid_amount)))
                    : 0;
                  const acctIsUnderpayment = checked && isAdminOrFinance && enteredAmt > 0 && firstUnpaidItem && enteredAmt < firstItemEffDue - 0.005;
                  const acctShortfall = acctIsUnderpayment ? Math.round((firstItemEffDue - enteredAmt) * 100) / 100 : 0;
                  const acctSecondItem = a.schedule
                    ? [...a.schedule].filter(s => s.status !== 'paid' && s.status !== 'cancelled').sort((x, y) => x.installment_number - y.installment_number)[1]
                    : null;
                  return (
                    <div
                      key={a.id}
                      className={`rounded-lg border p-3 transition-colors ${
                        checked
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border bg-background'
                      }`}
                    >
                      <label className="flex items-start gap-3 cursor-pointer">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleAccount(a.id)}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-card-foreground">
                              Inv #{a.invoice_number} — {label}
                            </span>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                a.status === 'overdue'
                                  ? 'bg-destructive/10 text-destructive border-destructive/20'
                                  : 'bg-primary/10 text-primary border-primary/20'
                              }`}
                            >
                              {a.status}
                            </Badge>
                          </div>
                          {nextDue && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              Next due: {nextDue.dateLabel} — {formatCurrency(nextDue.amount, cur)}
                            </p>
                          )}
                        </div>
                      </label>
                      <div className="mt-2 pl-7">
                        <Label className="text-xs text-muted-foreground">Amount to apply:</Label>
                        <Input
                          type="number"
                          value={checked ? (amounts[a.id] || '') : ''}
                          onChange={e => setAmounts(prev => ({ ...prev, [a.id]: e.target.value }))}
                          disabled={!checked}
                          placeholder="0"
                          className="bg-background border-border tabular-nums mt-1 h-8"
                          min={0.01}
                          max={a.remaining_balance}
                          step="any"
                        />
                        {checked && allocationErrors[a.id] && (
                          <p className="text-xs text-destructive mt-0.5">{allocationErrors[a.id]}</p>
                        )}
                        {/* Waterfall allocation breakdown */}
                        {checked && waterfallResults[a.id]?.valid && waterfallResults[a.id].allocations.length > 0 && (
                          <div className="mt-2 rounded-md border border-border bg-muted/30 p-2">
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Allocation breakdown</p>
                            {waterfallResults[a.id].allocations.map((alloc) => {
                              const row = scheduleViewRows[a.id]?.find(r => r.id === alloc.scheduleId);
                              if (!row) return null;
                              const rowTotal = Number(row.base_installment_amount) + Number(row.penalty_amount || 0) + Number(row.carried_amount || 0);
                              const allocatedBefore = Number(row.allocated) || 0;
                              const newAllocated = allocatedBefore + alloc.amount;
                              const isPaidAfter = newAllocated >= rowTotal - 0.01;
                              const isPartialAfter = !isPaidAfter && newAllocated > 0;
                              const dateLabel = new Date(row.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                              return (
                                <div key={alloc.scheduleId} className="flex items-center gap-2 text-[11px] py-0.5">
                                  <span className="text-muted-foreground">Month {row.installment_number}</span>
                                  <span className="text-muted-foreground">{dateLabel}</span>
                                  <span className="font-medium text-card-foreground tabular-nums">{formatCurrency(alloc.amount, cur)}</span>
                                  <span className="text-muted-foreground">→</span>
                                  {isPaidAfter ? (
                                    <span className="text-green-600 dark:text-green-400 font-medium">PAID ✅</span>
                                  ) : (
                                    <span className="text-yellow-600 dark:text-yellow-400 font-medium">PARTIAL 🟡</span>
                                  )}
                                </div>
                              );
                            })}
                            {(() => {
                              const wf = waterfallResults[a.id];
                              const lastAlloc = wf.allocations[wf.allocations.length - 1];
                              const lastRow = scheduleViewRows[a.id]?.find(r => r.id === lastAlloc?.scheduleId);
                              if (!lastRow) return null;
                              const rowTotal = Number(lastRow.base_installment_amount) + Number(lastRow.penalty_amount || 0) + Number(lastRow.carried_amount || 0);
                              const newAllocated = (Number(lastRow.allocated) || 0) + lastAlloc.amount;
                              const remainAfter = Math.max(0, rowTotal - newAllocated);
                              if (remainAfter > 0.01) {
                                return (
                                  <p className="text-[10px] text-muted-foreground mt-1">
                                    Remaining after: {formatCurrency(remainAfter, cur)}
                                  </p>
                                );
                              }
                              return null;
                            })()}
                          </div>
                        )}
                        {acctIsUnderpayment && !carryOverMap[a.id] && (
                          <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 p-2 space-y-1.5">
                            <p className="text-[11px] font-semibold text-warning flex items-center gap-1">
                              ⚠ Underpayment — shortfall {formatCurrency(acctShortfall, cur)}
                            </p>
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                className="flex-1 rounded px-2 py-1 text-[11px] font-medium border border-warning/30 bg-warning/10 text-warning hover:bg-warning/20"
                                onClick={() => setCarryOverMap(prev => ({ ...prev, [a.id]: true }))}
                              >
                                Carry to {acctSecondItem
                                  ? new Date(acctSecondItem.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                                  : 'next'}
                              </button>
                              <button
                                type="button"
                                className="rounded px-2 py-1 text-[11px] font-medium border border-border text-muted-foreground hover:bg-muted"
                                onClick={() => setAmounts(prev => ({ ...prev, [a.id]: '' }))}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                        {carryOverMap[a.id] && (
                          <p className="text-[11px] text-warning mt-1.5 flex items-center gap-1">
                            ⚡ Shortfall will carry to next month
                            <button
                              type="button"
                              className="ml-1 text-muted-foreground underline hover:no-underline"
                              onClick={() => setCarryOverMap(prev => ({ ...prev, [a.id]: false }))}
                            >undo</button>
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Payment Details */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-card-foreground text-xs">Payment Method</Label>
                  <select
                    value={paymentMethod}
                    onChange={e => setPaymentMethod(e.target.value)}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                  >
                    <option value="cash">Cash Payment</option>
                    <option value="bdo">BDO</option>
                    <option value="bpi">BPI</option>
                    <option value="metrobank">METROBANK</option>
                    <option value="gcash">GCash</option>
                    <option value="cash_pickup">Cash Pick Up</option>
                    <option value="rakuten">Rakuten</option>
                    <option value="sumitomo">Sumitomo</option>
                    <option value="genkin_kaketome">Genkin Kaketome</option>
                    <option value="credit_card">Credit Card</option>
                    <option value="paypay">PayPay</option>
                    <option value="jp_bank">JP Bank</option>
                    <option value="cod">COD</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-card-foreground text-xs">Payment Date</Label>
                  <Input
                    type="date"
                    value={paymentDate}
                    onChange={e => setPaymentDate(e.target.value)}
                    className="bg-background border-border"
                  />
                </div>
              </div>

              {showRefField && (
                <div className="space-y-1.5">
                  <Label className="text-card-foreground text-xs">Reference No.</Label>
                  <Input
                    value={referenceNumber}
                    onChange={e => setReferenceNumber(e.target.value)}
                    placeholder="Transaction reference number"
                    className="bg-background border-border"
                  />
                </div>
              )}

              {/* Total */}
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center justify-between">
                <span className="text-sm font-medium text-card-foreground">Total Payment</span>
                <span className="text-lg font-bold text-card-foreground tabular-nums">
                  {formatCurrency(totalAllocated, (selectedAccounts[0]?.currency || 'PHP') as Currency)}
                </span>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button
                  onClick={handleConfirm}
                  disabled={!canSubmit || submitting}
                  className="gold-gradient text-primary-foreground"
                >
                  {submitting ? 'Processing…' : 'Confirm Payment →'}
                </Button>
              </DialogFooter>
            </div>
          </>
        )}

        {/* Confirmation Message */}
        {step === 'message' && (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-card-foreground">
                <CheckCircle2 className="h-5 w-5 text-success" />
                Payment Confirmed
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">Customer message:</p>
            <div className="rounded-lg border border-border bg-muted/30 p-4 max-h-[350px] overflow-y-auto">
              <pre className="text-sm text-card-foreground whitespace-pre-wrap break-all font-sans leading-relaxed" style={{ overflowWrap: 'anywhere' }}>
                {consolidatedMessage}
              </pre>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={resetAndClose}>
                Done
              </Button>
              {customerName && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const messengerLink = accounts[0] && (accounts[0] as any).messengerLink;
                    if (messengerLink) window.open(messengerLink, '_blank');
                    else toast.info('No Messenger link set for this customer');
                  }}
                  className="gap-1.5"
                >
                  <MessageCircle className="h-4 w-4" /> Send via Messenger
                </Button>
              )}
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(consolidatedMessage);
                  setMsgCopied(true);
                  toast.success('Message copied to clipboard');
                  setTimeout(() => setMsgCopied(false), 2000);
                }}
                className="gap-1.5"
              >
                {msgCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {msgCopied ? 'Copied!' : 'Copy Message'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
