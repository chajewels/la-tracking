import { useState, useEffect, useRef, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Save, Upload, X, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import CurrencyInput from '@/components/forms/CurrencyInput';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import {
  PAYMENT_METHODS,
  methodCurrency,
  methodLabel,
  methodMismatch,
} from '@/lib/payment-method-registry';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePaymentDraft } from '@/hooks/use-payment-draft';
import { getPHTToday } from '@/lib/date-utils';

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
  initialPaymentMethod?: string;
  onPaymentRecorded?: (info: SessionPaymentInfo) => void;
}

export default function RecordPaymentDialog({ accountId, currency, remainingBalance, payFullBalance, schedule, invoiceNumber, downpaymentRemaining, initialPaymentMethod, onPaymentRecorded }: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [carryOver, setCarryOver] = useState(false);
  const [paymentDate, setPaymentDate] = useState(getPHTToday());
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod ?? 'cash');
  const [paymentType, setPaymentType] = useState<'installment' | 'downpayment'>('installment');
  const [submitting, setSubmitting] = useState(false);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const submittingRef = useRef(false); // duplicate-submission guard
  const { profile } = useAuth();
  const { loadDraft, saveDraft, clearDraft, restoredDraft, setRestoredDraft } = usePaymentDraft(accountId);
  const [targetMonth, setTargetMonth] = useState<string>('');

  const targetMonthWarnings = useMemo(() => {
    if (!targetMonth || !schedule) return [];
    const row = schedule.find(s => s.id === targetMonth);
    if (!row) return [];
    const warnings: { type: 'critical' | 'soft'; message: string }[] = [];
    if (row.status === 'paid') {
      warnings.push({ type: 'critical', message: `Month ${row.installment_number} is already fully paid` });
    }
    if (row.status === 'partially_paid' && Number(row.paid_amount) > 0) {
      warnings.push({ type: 'soft', message: `Partial payment exists: ${formatCurrency(Number(row.paid_amount), currency)} paid` });
    }
    return warnings;
  }, [targetMonth, schedule, currency]);

  const selectedScheduleRow = targetMonth ? schedule?.find(s => s.id === targetMonth) : null;

  // Auto-save draft whenever form fields change (only when dialog is open)
  useEffect(() => {
    if (open && !payFullBalance) {
      saveDraft({ amount, paymentDate, paymentMethod, notes });
    }
  }, [amount, paymentDate, paymentMethod, notes, open, payFullBalance, saveDraft]);

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

  const parsedAmount = payFullBalance ? remainingBalance : (parseFloat(amount) || 0);

  // Underpayment detection — compare entered amount against first installment's effective remaining.
  // Universal-submission policy (Bug #219): the carry-over intent is captured on the
  // submission and applied at confirm time; surface the option to every role.
  const firstUnpaid = unpaidItems[0];
  const firstUnpaidEffectiveDue = firstUnpaid
    ? (firstUnpaid.status === 'partially_paid' && Number(firstUnpaid.paid_amount) > Number(firstUnpaid.total_due_amount)
        ? Number(firstUnpaid.total_due_amount)  // new semantics: total_due IS remaining
        : Math.max(0, Number(firstUnpaid.total_due_amount) - Number(firstUnpaid.paid_amount)))
    : 0;
  const secondUnpaid = unpaidItems[1];
  const isUnderpayment =
    paymentType === 'installment' &&
    parsedAmount > 0 &&
    !!firstUnpaid &&
    parsedAmount < firstUnpaidEffectiveDue - 0.005;
  const underpaymentShortfall = isUnderpayment
    ? Math.round((firstUnpaidEffectiveDue - parsedAmount) * 100) / 100
    : 0;

  const monthOptions: { months: number; amount: number; label: string; dueDate: string }[] = [];
  if (!payFullBalance && unpaidItems.length > 0) {
    let cumulative = 0;
    for (let i = 0; i < Math.min(5, unpaidItems.length); i++) {
      const item = unpaidItems[i];
      const due = Math.max(0, Number(item.total_due_amount));
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

  const isValid = parsedAmount > 0 && parsedAmount <= remainingBalance + 0.005 && paymentDate && !!proofFile;

  // Upload proof to the payment-proofs bucket and RETURN its public URL.
  // Upload-first: the URL is passed to record-payment, which attaches it
  // server-side (and enforces proof presence). This helper no longer writes
  // to payment_submissions — the edge function is the sole writer.
  const uploadProof = async (opts: { isDP: boolean }): Promise<string | null> => {
    if (!proofFile) return null;
    try {
      const isDP = opts.isDP;
      const installmentNumber = isDP ? null : (firstUnpaid?.installment_number ?? null);
      const customerName = (profile?.full_name || 'Staff').replace(/[^a-zA-Z0-9]/g, '');
      const safeInvoice = (invoiceNumber || '').replace(/[^a-zA-Z0-9]/g, '');
      const ext = (proofFile.name.split('.').pop() || 'jpg').toLowerCase();
      const monthSegment = isDP ? 'DP' : (installmentNumber ? `Month${installmentNumber}` : 'MonthX');
      // Bug #178: append Date.now() suffix to guarantee uniqueness when
      // same customer + invoice + month/DP + date is uploaded multiple times.
      const fileName = `${customerName}_${safeInvoice}_${monthSegment}_${paymentDate}_${Date.now().toString(36)}.${ext}`;
      const storagePath = `${accountId}/${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from('payment-proofs')
        .upload(storagePath, proofFile, { cacheControl: '3600', upsert: false });
      if (uploadErr) throw uploadErr;

      const { data: urlData } = supabase.storage
        .from('payment-proofs')
        .getPublicUrl(storagePath);
      return urlData.publicUrl;
    } catch (err: unknown) {
      const msg = (err as Error)?.message || 'unknown error';
      console.warn('[RecordPaymentDialog] proof upload failed:', msg);
      toast.warning(`Proof upload failed: ${msg}`);
      return null;
    }
  };

  const handleSubmit = async () => {
    if (!isValid) return;
    if (submittingRef.current) return; // prevent double-click
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const isDP = paymentType === 'downpayment';
      const dpRef = isDP && invoiceNumber ? `DP-${invoiceNumber}` : undefined;
      const dpRemarks = isDP ? 'Downpayment' : (notes || undefined);

      // Upload-first: proof_url is sent to record-payment, which attaches it
      // and enforces its presence server-side. Abort if the upload fails.
      const proofUrl = await uploadProof({ isDP });
      if (!proofUrl) return;

      const { error } = await supabase.functions.invoke('record-payment', {
        body: {
          account_id: accountId,
          amount_paid: parsedAmount,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          reference_number: dpRef,
          remarks: dpRemarks,
          is_downpayment: isDP,
          carry_over: carryOver,
          submission_type: isDP ? 'downpayment' : 'installment',
          proof_url: proofUrl,
        },
      });
      if (error) throw error;
      toast.success('Payment submitted for confirmation. Admin/Finance will review.');
      if (paymentType !== 'downpayment') {
        const info = buildSessionPaymentInfo();
        onPaymentRecorded?.(info);
      }
      resetAndClose();
    } catch (err: unknown) {
      const e = err as { message?: string; context?: { status?: number } };
      if (e?.message?.includes('Too many submissions') || e?.context?.status === 429) {
        toast.error('Too many submissions. Please wait 24 hours before submitting again.');
        return;
      }
      toast.error(e.message || 'Failed to submit payment');
    } finally {
      setSubmitting(false);
      submittingRef.current = false;
    }
  };

  const buildSessionPaymentInfo = (): SessionPaymentInfo => {
    const isDP = paymentType === 'downpayment';
    if (isDP) {
      return { amount: parsedAmount, monthLabel: 'Down Payment', ordinal: '', method: paymentMethod };
    }
    // Universal-submission policy: payment hasn't been applied yet, so we
    // describe the intended target row (first unpaid) rather than a confirmed
    // allocation. The reviewer's confirm step performs the actual waterfall.
    const target = firstUnpaid;
    const monthLabel = target
      ? new Date(target.due_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
      : '';
    const ord = target ? formatOrdinal(target.installment_number) : '';
    return { amount: parsedAmount, monthLabel, ordinal: ord, method: paymentMethod };
  };

  const formatOrdinal = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const resetAndClose = () => {
    setAmount('');
    setCarryOver(false);
    setNotes('');
    setPaymentMethod('cash');
    setPaymentType('installment');
    setPaymentDate(getPHTToday());
    setProofFile(null);
    setTargetMonth('');
    clearDraft();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else handleOpen(); }}>
      <DialogTrigger asChild>
        {payFullBalance ? (
          <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10 font-medium">
            <CheckCircle2 className="h-4 w-4 mr-1" /> Pay in Full
          </Button>
        ) : (
          <Button className="gold-gradient text-primary-foreground font-medium">
            <Upload className="h-4 w-4 mr-1" /> Submit Payment
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground">
            Submit Payment for Confirmation
          </DialogTitle>
          <DialogDescription>
            {invoiceNumber && <span className="font-mono font-semibold">#{invoiceNumber} · </span>}Remaining balance: {formatCurrency(remainingBalance, currency)}
            <span className="block mt-1 text-warning">
              This payment will be submitted for admin/finance confirmation before it takes effect.
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="space-y-4">
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
          {/* Target Month Selector */}
          {!payFullBalance && paymentType === 'installment' && unpaidItems.length > 0 && (
            <div className="space-y-2">
              <Label className="text-card-foreground">Target Month (optional)</Label>
              <select
                value={targetMonth}
                onChange={e => setTargetMonth(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">Select month (optional)</option>
                {(schedule || [])
                  .filter(s => s.status !== 'cancelled')
                  .sort((a, b) => a.installment_number - b.installment_number)
                  .map(s => {
                    const remaining = Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount));
                    const dateLabel = new Date(s.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    return (
                      <option key={s.id} value={s.id}>
                        Month {s.installment_number} — {dateLabel} — {formatCurrency(remaining, currency)} remaining
                      </option>
                    );
                  })}
              </select>
              {targetMonthWarnings.map((w, i) => (
                <div key={i} className={`flex items-center gap-2 text-xs px-3 py-2 rounded-md ${
                  w.type === 'critical' ? 'bg-destructive/10 text-destructive border border-destructive/20' : 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                }`}>
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {w.message}
                </div>
              ))}
              {selectedScheduleRow && targetMonthWarnings.length === 0 && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Info className="h-3 w-3" />
                  Due for this month: {formatCurrency(Math.max(0, Number(selectedScheduleRow.total_due_amount) - Number(selectedScheduleRow.paid_amount)), currency)}
                </p>
              )}
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
              <CurrencyInput
                currency={currency as Currency}
                value={amount === '' ? '' : Number(amount)}
                onValueChange={(v) => setAmount(v === '' ? '' : String(v))}
                placeholder={`Max ${remainingBalance.toLocaleString()}`}
                error={parsedAmount > remainingBalance + 0.005 ? ' ' : undefined}
                className="bg-background"
              />
              {parsedAmount > remainingBalance + 0.005 && (
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
              {PAYMENT_METHODS.filter((m) => m.value !== 'bank_transfer').map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            {currency && methodMismatch(paymentMethod, currency) && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-200">
                ⚠️ {methodLabel(paymentMethod)} receives {methodCurrency(paymentMethod)} but this account is {currency}. Double-check the bank selection and make sure the amount is entered in {currency}.
              </div>
            )}
          </div>
          {paymentType === 'downpayment' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-sm">
              <span className="text-amber-400 font-medium">
                📋 This payment will be recorded as a 30% Downpayment
              </span>
            </div>
          )}
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
          <div className="space-y-2">
            <Label className="text-card-foreground">Proof of Payment *</Label>
            {proofFile ? (
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                <Upload className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="truncate flex-1 text-card-foreground">{proofFile.name}</span>
                <button
                  type="button"
                  onClick={() => setProofFile(null)}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label="Remove file">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <label className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-background/50 px-3 py-3 text-xs text-muted-foreground cursor-pointer hover:border-primary/50 hover:text-primary transition-colors">
                <Upload className="h-4 w-4" />
                <span>Attach screenshot or receipt (required)</span>
                <input
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/webp,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 10 * 1024 * 1024) { toast.error('File must be less than 10MB'); return; }
                    setProofFile(f);
                  }}
                />
              </label>
            )}
            <p className="text-[10px] text-muted-foreground">
              Required — images (JPG, PNG, WEBP) or PDF, max 10MB
            </p>
          </div>
          {/* Underpayment warning — surfaces partial-payment + carry-over option to every role.
              The carry intent rides on the submission and is applied at confirm time. */}
          {isUnderpayment ? (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 space-y-2.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-warning">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Underpayment detected
              </div>
              <div className="text-xs space-y-0.5 text-muted-foreground">
                <div className="flex justify-between"><span>Entered:</span><span className="tabular-nums">{formatCurrency(parsedAmount, currency)}</span></div>
                <div className="flex justify-between"><span>Due:</span><span className="tabular-nums">{formatCurrency(firstUnpaidEffectiveDue, currency)}</span></div>
                <div className="flex justify-between font-medium text-warning"><span>Shortfall:</span><span className="tabular-nums">{formatCurrency(underpaymentShortfall, currency)}</span></div>
              </div>
              <div className="flex gap-2 pt-0.5">
                <Button
                  type="button"
                  size="sm"
                  className="flex-1 bg-warning/15 text-warning border border-warning/30 hover:bg-warning/25"
                  disabled={submitting}
                  onClick={() => { setCarryOver(true); handleSubmit(); }}
                >
                  Submit Partial — carry {formatCurrency(underpaymentShortfall, currency)} to{' '}
                  {secondUnpaid
                    ? new Date(secondUnpaid.due_date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : 'next month'}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setAmount('')}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={resetAndClose}>Cancel</Button>
              <Button type="submit" disabled={!isValid || submitting} className="gold-gradient text-primary-foreground">
                {submitting ? 'Submitting…' : 'Submit for Confirmation'}
                <Clock className="h-4 w-4 ml-1" />
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
