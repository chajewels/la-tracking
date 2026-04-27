import { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Loader2, Info, Upload, X } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Currency } from '@/lib/types';
import { formatCurrency } from '@/lib/calculations';
import { CHA_PAYMENT_METHODS } from '@/lib/payment-methods';
import { supabase } from '@/integrations/supabase/client';

type PaymentMethod = string;

interface CashOrderArg {
  id: string;
  invoice_number: string;
  customer_id: string;
  currency: Currency;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  customer: { full_name: string } | null;
}

interface RecordCashPaymentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  cashOrder: CashOrderArg;
  onSuccess: () => void;
}

const MAX_PROOF_BYTES = 5 * 1024 * 1024; // 5 MB
const ACCEPTED_MIME = 'image/png,image/jpeg,image/jpg,image/webp,application/pdf';

function todayISODate() {
  return new Date().toISOString().split('T')[0];
}

function safeForFilename(value: string | null | undefined) {
  return (value || '').replace(/[^a-zA-Z0-9]/g, '');
}

export default function RecordCashPaymentDialog({
  isOpen, onClose, cashOrder, onSuccess,
}: RecordCashPaymentDialogProps) {
  const remaining = Number(cashOrder.remaining_balance);
  const currency = cashOrder.currency;
  const customerName = cashOrder.customer?.full_name || '';

  // Form state
  const [amountInput, setAmountInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayISODate());
  const [senderName, setSenderName] = useState(customerName);
  const [proofFile, setProofFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset when the dialog re-opens for a new order
  useEffect(() => {
    if (isOpen) {
      setAmountInput('');
      setPaymentMethod('');
      setReferenceNumber('');
      setPaymentDate(todayISODate());
      setSenderName(customerName);
      setProofFile(null);
      setNotes('');
      setBannerDismissed(false);
      setSubmitting(false);
    }
  }, [isOpen, customerName]);

  const amount = Number(amountInput) || 0;
  const isAmountPositive = amount > 0;
  const exceedsRemaining = amount > remaining + 0.005;
  const isAmountValid = isAmountPositive && !exceedsRemaining;

  const today = todayISODate();
  const dateIsFuture = paymentDate > today;
  const isDateValid = !!paymentDate && !dateIsFuture;

  const proofError = useMemo(() => {
    if (!proofFile) return null;
    if (proofFile.size > MAX_PROOF_BYTES) return 'File exceeds 5MB';
    return null;
  }, [proofFile]);

  const isFormValid =
    isAmountValid &&
    !!paymentMethod.trim() &&
    isDateValid &&
    !!senderName.trim() &&
    !proofError;

  const setPayFull = () => setAmountInput(String(Math.round(remaining * 100) / 100));

  const uploadProof = useCallback(async (): Promise<string | null> => {
    if (!proofFile) return null;
    const ext = (proofFile.name.split('.').pop() || 'jpg').toLowerCase();
    const fileName = `${safeForFilename(customerName)}_${safeForFilename(cashOrder.invoice_number)}_Cash_${paymentDate}.${ext}`;
    const storagePath = `${cashOrder.id}/${fileName}`;
    const { error: uploadErr } = await supabase.storage
      .from('payment-proofs')
      .upload(storagePath, proofFile, { cacheControl: '3600', upsert: true });
    if (uploadErr) throw uploadErr;
    const { data: urlData } = supabase.storage
      .from('payment-proofs')
      .getPublicUrl(storagePath);
    return urlData.publicUrl;
  }, [proofFile, customerName, cashOrder.invoice_number, cashOrder.id, paymentDate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) {
      toast.error('Please complete all required fields');
      return;
    }
    setSubmitting(true);
    try {
      let proofUrl: string | null = null;
      if (proofFile) {
        try {
          proofUrl = await uploadProof();
        } catch (uploadErr: unknown) {
          toast.error(`Proof upload failed: ${(uploadErr as Error).message || 'unknown error'}`);
          setSubmitting(false);
          return;
        }
      }

      const body: Record<string, unknown> = {
        cash_order_id: cashOrder.id,
        submitted_amount: amount,
        payment_method: paymentMethod,
        payment_date: paymentDate,
        sender_name: senderName.trim(),
      };
      if (referenceNumber.trim()) body.reference_number = referenceNumber.trim();
      if (proofUrl) body.proof_url = proofUrl;
      if (notes.trim()) body.notes = notes.trim();

      const { error } = await supabase.functions.invoke('submit-cash-payment', { body });

      if (error) {
        let msg = error.message || 'Failed to submit payment';
        try {
          if ('context' in error && (error as any).context?.body) {
            const parsed = await new Response((error as any).context.body).json();
            if (parsed?.error) msg = parsed.error;
          }
        } catch { /* ignore parse */ }
        throw new Error(msg);
      }

      toast.success('Payment submitted for review');
      onSuccess();
      onClose();
    } catch (err: unknown) {
      toast.error((err as Error).message || 'Failed to submit payment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground">
            Record Cash Payment
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-xs">
            #{cashOrder.invoice_number} · {customerName || 'Unknown customer'}
          </DialogDescription>
        </DialogHeader>

        {!bannerDismissed && (
          <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-xs text-info">
            <Info className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              Payments require admin confirmation before they appear as recorded.
              Status will show as "Submitted" until confirmed in the Submissions tab.
            </div>
            <button
              type="button"
              onClick={() => setBannerDismissed(true)}
              className="text-info/60 hover:text-info"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Amount */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-card-foreground">Amount to Pay *</Label>
              <button
                type="button"
                onClick={setPayFull}
                disabled={remaining <= 0}
                className="text-[11px] font-medium text-primary hover:underline disabled:opacity-40 disabled:no-underline"
              >
                Pay Full Remaining
              </button>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground pointer-events-none">
                {currency === 'JPY' ? '¥' : '₱'}
              </span>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="0"
                className="bg-background border-border pl-8 tabular-nums"
              />
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">
                Remaining: <span className="tabular-nums">{formatCurrency(remaining, currency)}</span>
              </span>
              {exceedsRemaining && (
                <span className="text-destructive">Exceeds remaining balance</span>
              )}
              {amountInput !== '' && !isAmountPositive && (
                <span className="text-destructive">Amount must be greater than zero</span>
              )}
            </div>
          </div>

          {/* Payment Method */}
          <div className="space-y-1.5">
            <Label className="text-card-foreground">Payment Method *</Label>
            {!paymentMethod ? (
              <div className="grid gap-2 max-h-48 overflow-y-auto">
                {CHA_PAYMENT_METHODS.map(method => (
                  <button
                    key={method.id}
                    type="button"
                    onClick={() => setPaymentMethod(method.name)}
                    className="text-left p-3 rounded-lg border border-border bg-background hover:border-primary/50 transition-colors"
                  >
                    <p className="font-medium text-card-foreground text-sm">{method.name}</p>
                    {method.bankName && <p className="text-xs text-muted-foreground">{method.bankName}</p>}
                    {method.accountNumber && <p className="text-xs text-muted-foreground">Account: {method.accountNumber}</p>}
                    {method.accountName && <p className="text-xs text-muted-foreground">{method.accountName}</p>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-between p-3 rounded-lg border border-primary/50 bg-primary/5">
                <div>
                  <p className="font-medium text-card-foreground text-sm">{paymentMethod}</p>
                  {CHA_PAYMENT_METHODS.find(m => m.name === paymentMethod)?.accountNumber && (
                    <p className="text-xs text-muted-foreground">
                      {CHA_PAYMENT_METHODS.find(m => m.name === paymentMethod)?.accountNumber}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setPaymentMethod('')}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Change
                </button>
              </div>
            )}
          </div>

          {/* Reference + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-card-foreground">Reference Number</Label>
              <Input
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Transaction ref # (if applicable)"
                className="bg-background border-border"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-card-foreground">Payment Date *</Label>
              <Input
                type="date"
                value={paymentDate}
                max={today}
                onChange={(e) => setPaymentDate(e.target.value)}
                className="bg-background border-border"
              />
              {dateIsFuture && (
                <p className="text-[11px] text-destructive">Date cannot be in the future</p>
              )}
            </div>
          </div>

          {/* Sender Name */}
          <div className="space-y-1.5">
            <Label className="text-card-foreground">Sender Name *</Label>
            <Input
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Who sent this payment?"
              className="bg-background border-border"
            />
            <p className="text-[11px] text-muted-foreground">
              Pre-filled with customer name — change if a different person paid.
            </p>
          </div>

          {/* Proof upload */}
          <div className="space-y-1.5">
            <Label className="text-card-foreground">Proof of Payment (optional)</Label>
            <div className="flex items-center gap-2">
              <label
                htmlFor="cash-proof-file"
                className="flex-1 cursor-pointer rounded-md border border-dashed border-border bg-background px-3 py-2 text-xs text-muted-foreground hover:border-primary/50 hover:bg-primary/5 transition-colors"
              >
                <span className="inline-flex items-center gap-2">
                  <Upload className="h-3.5 w-3.5" />
                  {proofFile ? proofFile.name : 'Choose image or PDF (max 5MB)'}
                </span>
              </label>
              {proofFile && (
                <button
                  type="button"
                  onClick={() => setProofFile(null)}
                  className="text-[11px] text-muted-foreground hover:text-destructive"
                >
                  Remove
                </button>
              )}
              <input
                id="cash-proof-file"
                type="file"
                accept={ACCEPTED_MIME}
                onChange={(e) => setProofFile(e.target.files?.[0] || null)}
                className="hidden"
              />
            </div>
            {proofError && <p className="text-[11px] text-destructive">{proofError}</p>}
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-card-foreground">Notes (optional)</Label>
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the reviewer should know…"
            />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || !isFormValid}
              className="gold-gradient text-primary-foreground font-medium"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  Submitting…
                </>
              ) : 'Submit Payment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
