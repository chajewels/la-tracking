import { useState, useEffect, useRef } from 'react';
import { Plus, ArrowRight, AlertTriangle, CheckCircle2, Clock, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { toast } from 'sonner';
import { useRecordPayment } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { type AppRole } from '@/lib/role-permissions';
import { usePaymentDraft } from '@/hooks/use-payment-draft';

interface Allocation {
  schedule_id: string;
  allocation_type: 'penalty' | 'installment';
  allocated_amount: number;
  penalty_fee_id?: string;
}

interface PreviewResult {
  preview: boolean;
  allocations: Allocation[];
  new_total_paid: number;
  new_remaining_balance: number;
  new_status: string;
  schedule_updates: Array<{ id: string; paid_amount: number; status: string }>;
  penalty_updates: Array<{ id: string; status: string; paid_amount: number }>;
}

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

export interface SessionPaymentInfo {
  amount: number;
  monthLabel: string;
  ordinal: string;
  method: string;
}

interface RecordPaymentDialogProps {
  accountId: string;
  currency: Currency;
  remainingBalance: number;
  payFullBalance?: boolean;
  schedule?: ScheduleItem[];
  invoiceNumber?: string;
  downpaymentRemaining?: number;
  onPaymentRecorded?: (info: SessionPaymentInfo) => void;
}

export default function RecordPaymentDialog({ accountId, currency, remainingBalance, payFullBalance, schedule, invoiceNumber, downpaymentRemaining, onPaymentRecorded }: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentType, setPaymentType] = useState<'installment' | 'downpayment'>('installment');
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const submittingRef = useRef(false); // duplicate-submission guard
  const recordPayment = useRecordPayment();
  const { roles } = useAuth();
  const r = roles as AppRole[];
  const isAdminOrFinance = r.includes('admin') || r.includes('finance');
  const { loadDraft, saveDraft, clearDraft, restoredDraft, setRestoredDraft } = usePaymentDraft(accountId);

  // Auto-save draft whenever form fields change (only when dialog is open)
  useEffect(() => {
    if (open && !payFullBalance && step === 'input') {
      saveDraft({ amount, paymentDate, paymentMethod, notes });
    }
  }, [amount, paymentDate, paymentMethod, notes, open, payFullBalance, step, saveDraft]);

  // Restore draft when dialog opens
  const handleOpen = () => {
    setOpen(true);
    if (!payFullBalance) {
      const draft = loadDraft();
      if (draft) {
        setAmount(draft.amount);
        setPaymentDate(draft.paymentDate);
        setPaymentMethod(draft.paymentMethod);
        setNotes(draft.notes);
        setRestoredDraft(true);
        toast.info('Draft restored', { duration: 2000 });
      }
    }
  };

  // Calculate multi-month quick-fill amounts from unpaid schedule items
  const unpaidItems = (schedule || [])
    .filter(s => s.status !== 'paid' && s.status !== 'cancelled')
    .sort((a, b) => a.installment_number - b.installment_number);

  const monthOptions: { months: number; amount: number; label: string; dueDate: string }[] = [];
  if (!payFullBalance && unpaidItems.length > 0) {
    let cumulative = 0;
    for (let i = 0; i < Math.min(5, unpaidItems.length); i++) {
      const item = unpaidItems[i];
      const due = Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
      cumulative += due;
      if (cumulative > 0) {
        const dateLabel = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const rangeLabel = i === 0
          ? dateLabel
          : `${new Date(unpaidItems[0].due_date).toLocaleDateString('en-US', { month: 'short' })} – ${new Date(item.due_date).toLocaleDateString('en-US', { month: 'short' })}`;
        monthOptions.push({ months: i + 1, amount: cumulative, label: rangeLabel, dueDate: item.due_date });
      }
    }
  }

  const parsedAmount = payFullBalance ? remainingBalance : (parseFloat(amount) || 0);
  const isValid = parsedAmount > 0 && parsedAmount <= remainingBalance && paymentDate;

  const handlePreview = async () => {
    if (!isValid) return;

    // Staff doesn't need preview — they just submit
    if (!isAdminOrFinance) {
      handleSubmitForConfirmation();
      return;
    }

    setLoadingPreview(true);
    try {
      const dpRef = paymentType === 'downpayment' && invoiceNumber ? `DP-${invoiceNumber}` : undefined;
      const dpRemarks = paymentType === 'downpayment' ? 'Downpayment' : (notes || undefined);
      const { data, error } = await supabase.functions.invoke('record-payment', {
        body: {
          account_id: accountId,
          amount_paid: parsedAmount,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          reference_number: dpRef,
          remarks: dpRemarks,
          preview_only: true,
        },
      });
      if (error) throw error;
      setPreview(data as PreviewResult);
      setStep('preview');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate preview');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleSubmitForConfirmation = async () => {
    if (submittingRef.current) return; // prevent double-click
    submittingRef.current = true;
    setLoadingPreview(true);
    try {
      const dpRef = paymentType === 'downpayment' && invoiceNumber ? `DP-${invoiceNumber}` : undefined;
      const dpRemarks = paymentType === 'downpayment' ? 'Downpayment' : (notes || undefined);
      const { data, error } = await supabase.functions.invoke('record-payment', {
        body: {
          account_id: accountId,
          amount_paid: parsedAmount,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          reference_number: dpRef,
          remarks: dpRemarks,
        },
      });
      if (error) throw error;
      if (data?.submitted_for_confirmation) {
        toast.success('Payment submitted for confirmation. Admin/Finance will review.');
      } else {
        toast.success(`Payment of ${formatCurrency(parsedAmount, currency)} recorded successfully`);
      }
      resetAndClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to submit payment');
    } finally {
      setLoadingPreview(false);
      submittingRef.current = false;
    }
  };

  const handleConfirm = async () => {
    if (submittingRef.current) return; // prevent double-click
    submittingRef.current = true;
    try {
      const dpRef = paymentType === 'downpayment' && invoiceNumber ? `DP-${invoiceNumber}` : undefined;
      const dpRemarks = paymentType === 'downpayment' ? 'Downpayment' : (notes || undefined);
      await recordPayment.mutateAsync({
        account_id: accountId,
        amount: parsedAmount,
        currency,
        date_paid: paymentDate,
        payment_method: paymentMethod,
        reference_number: dpRef,
        remarks: dpRemarks,
      });
      toast.success(`Payment of ${formatCurrency(parsedAmount, currency)} recorded successfully`);
      resetAndClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to record payment');
    } finally {
      submittingRef.current = false;
    }
  };

  const buildSessionPaymentInfo = (): SessionPaymentInfo => {
    const isDP = paymentType === 'downpayment';
    if (isDP) {
      return { amount: parsedAmount, monthLabel: 'Down Payment', ordinal: '', method: paymentMethod };
    }
    // Find which schedule item this payment was allocated to from preview
    const firstInstallmentAlloc = preview?.allocations.find(a => a.allocation_type === 'installment');
    const matchedSchedule = firstInstallmentAlloc && schedule
      ? schedule.find(s => s.id === firstInstallmentAlloc.schedule_id)
      : null;
    const monthLabel = matchedSchedule
      ? new Date(matchedSchedule.due_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      : '';
    const ord = matchedSchedule ? formatOrdinal(matchedSchedule.installment_number) : '';
    return { amount: parsedAmount, monthLabel, ordinal: ord, method: paymentMethod };
  };

  const formatOrdinal = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const resetAndClose = () => {
    setAmount('');
    setNotes('');
    setPaymentMethod('cash');
    setPaymentType('installment');
    setPaymentDate(new Date().toISOString().split('T')[0]);
    setStep('input');
    setPreview(null);
    clearDraft();
    setOpen(false);
  };

  const totalPenaltyAlloc = preview?.allocations
    .filter(a => a.allocation_type === 'penalty')
    .reduce((s, a) => s + a.allocated_amount, 0) ?? 0;

  // Consolidate installment allocations
  const rawInstallmentAllocs = preview?.allocations.filter(a => a.allocation_type === 'installment') ?? [];
  const installmentAllocsMap = new Map<string, number>();
  for (const a of rawInstallmentAllocs) {
    installmentAllocsMap.set(a.schedule_id, (installmentAllocsMap.get(a.schedule_id) || 0) + a.allocated_amount);
  }
  const installmentAllocs = Array.from(installmentAllocsMap.entries()).map(([schedule_id, allocated_amount]) => ({
    schedule_id,
    allocation_type: 'installment' as const,
    allocated_amount,
  }));
  const displayAllocs = installmentAllocs.length <= 1
    ? installmentAllocs
    : installmentAllocs.filter(a => a.allocated_amount > 0);
  const totalInstallmentAlloc = displayAllocs.reduce((s, a) => s + a.allocated_amount, 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else handleOpen(); }}>
      <DialogTrigger asChild>
        {payFullBalance ? (
          <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10 font-medium">
            <CheckCircle2 className="h-4 w-4 mr-1" /> Pay in Full
          </Button>
        ) : (
          <Button className="gold-gradient text-primary-foreground font-medium">
            <Plus className="h-4 w-4 mr-1" /> {isAdminOrFinance ? 'Record Payment' : 'Submit Payment'}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground">
            {isAdminOrFinance ? 'Record Payment' : 'Submit Payment for Confirmation'}
          </DialogTitle>
          <DialogDescription>
            Remaining balance: {formatCurrency(remainingBalance, currency)}
            {!isAdminOrFinance && (
              <span className="block mt-1 text-warning">
                This payment will be submitted for admin/finance confirmation before it takes effect.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' && (
          <form onSubmit={(e) => { e.preventDefault(); handlePreview(); }} className="space-y-4">
            {restoredDraft && !payFullBalance && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded-md px-2.5 py-1.5">
                <Save className="h-3.5 w-3.5" />
                Draft restored — your previous entries have been loaded.
              </div>
            )}
            {/* Payment Type Selector — only show when not pay-full and DP remaining exists */}
            {!payFullBalance && downpaymentRemaining != null && downpaymentRemaining > 0 && (
              <div className="space-y-2">
                <Label className="text-card-foreground">Payment Type</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPaymentType('installment')}
                    className={`flex-1 px-3 py-2 rounded-md text-xs font-medium border transition-colors ${
                      paymentType === 'installment'
                        ? 'bg-primary/15 border-primary/30 text-primary'
                        : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    Installment
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPaymentType('downpayment');
                      if (!amount) setAmount(String(downpaymentRemaining));
                    }}
                    className={`flex-1 px-3 py-2 rounded-md text-xs font-medium border transition-colors ${
                      paymentType === 'downpayment'
                        ? 'bg-primary/15 border-primary/30 text-primary'
                        : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    Downpayment
                    <span className="block text-[10px] opacity-75">
                      Remaining: {formatCurrency(downpaymentRemaining, currency)}
                    </span>
                  </button>
                </div>
              </div>
            )}
            {payFullBalance ? (
              <div className="space-y-2">
                <Label className="text-card-foreground">Amount ({currency})</Label>
                <div className="text-2xl font-bold text-card-foreground">
                  {formatCurrency(remainingBalance, currency)}
                </div>
                <p className="text-xs text-muted-foreground">Full remaining balance</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label className="text-card-foreground">Amount ({currency}) *</Label>
                <Input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={`Max ${remainingBalance.toLocaleString()}`}
                  className="bg-background border-border"
                  min={0.01}
                  max={remainingBalance}
                  step="any"
                />
                {parsedAmount > remainingBalance && (
                  <p className="text-xs text-destructive">Amount exceeds remaining balance</p>
                )}
                {monthOptions.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <span className="text-xs text-muted-foreground">Pay by month due:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {monthOptions.map(opt => (
                        <button
                          key={opt.months}
                          type="button"
                          onClick={() => setAmount(String(opt.amount))}
                          className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors border flex flex-col items-center min-w-[70px] ${
                            parsedAmount === opt.amount
                              ? 'bg-primary/15 border-primary/30 text-primary'
                              : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted hover:text-card-foreground'
                          }`}
                        >
                          <span>{opt.label}</span>
                          <span className="text-[10px] opacity-75">{formatCurrency(opt.amount, currency)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label className="text-card-foreground">Payment Date *</Label>
              <Input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-card-foreground">Payment Method</Label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
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
            <div className="space-y-2">
              <Label className="text-card-foreground">Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes..."
                className="bg-background border-border resize-none"
                rows={2}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={resetAndClose}>Cancel</Button>
              {isAdminOrFinance ? (
                <Button type="submit" disabled={!isValid || loadingPreview} className="gold-gradient text-primary-foreground">
                  {loadingPreview ? 'Loading…' : 'Preview Allocation'}
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              ) : (
                <Button type="submit" disabled={!isValid || loadingPreview} className="gold-gradient text-primary-foreground">
                  {loadingPreview ? 'Submitting…' : 'Submit for Confirmation'}
                  <Clock className="h-4 w-4 ml-1" />
                </Button>
              )}
            </DialogFooter>
          </form>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            {/* Allocation Breakdown */}
            <div className="rounded-lg border border-border bg-background p-4 space-y-3">
              <h4 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                {payFullBalance ? 'Full Balance Payment' : 'Payment Breakdown'}
              </h4>
              <div className="text-2xl font-bold text-card-foreground">
                {formatCurrency(parsedAmount, currency)}
              </div>

              {payFullBalance ? (
                <p className="text-sm text-muted-foreground">
                  This will settle all remaining installments{totalPenaltyAlloc > 0 ? ` and ${formatCurrency(totalPenaltyAlloc, currency)} in penalties` : ''} in one payment.
                </p>
              ) : (
                <div className="space-y-2 text-sm">
                  {totalPenaltyAlloc > 0 && (
                    <div className="flex items-center justify-between py-1.5 border-b border-border">
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                        Penalty Fees
                      </span>
                      <span className="font-medium text-destructive">
                        {formatCurrency(totalPenaltyAlloc, currency)}
                      </span>
                    </div>
                  )}

                  {displayAllocs.map((alloc, idx) => (
                    <div key={alloc.schedule_id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
                      <span className="text-muted-foreground">
                        Installment #{idx + 1}
                      </span>
                      <span className="font-medium text-card-foreground">
                        {formatCurrency(alloc.allocated_amount, currency)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Result Summary */}
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">New Total Paid</span>
                <span className="font-medium text-card-foreground">{formatCurrency(preview.new_total_paid, currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Remaining Balance</span>
                <span className="font-medium text-card-foreground">{formatCurrency(preview.new_remaining_balance, currency)}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Account Status</span>
                <Badge variant={preview.new_status === 'completed' ? 'default' : 'secondary'} className="capitalize">
                  {preview.new_status}
                </Badge>
              </div>
            </div>

            {/* Installment statuses */}
            {!payFullBalance && preview.schedule_updates.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {preview.schedule_updates.map((su) => (
                  <span key={su.id} className="inline-flex items-center mr-2">
                    <Badge variant="outline" className="text-xs capitalize">{su.status.replace('_', ' ')}</Badge>
                  </span>
                ))}
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('input')}>
                Edit Amount
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={recordPayment.isPending}
                className="gold-gradient text-primary-foreground"
              >
                {recordPayment.isPending ? 'Processing…' : 'Confirm Payment'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
