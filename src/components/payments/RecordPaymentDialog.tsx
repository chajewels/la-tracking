import { useState } from 'react';
import { Plus, ArrowRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
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

interface RecordPaymentDialogProps {
  accountId: string;
  currency: Currency;
  remainingBalance: number;
  payFullBalance?: boolean;
}

export default function RecordPaymentDialog({ accountId, currency, remainingBalance, payFullBalance }: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const recordPayment = useRecordPayment();

  const parsedAmount = payFullBalance ? remainingBalance : (parseFloat(amount) || 0);
  const isValid = parsedAmount > 0 && parsedAmount <= remainingBalance && paymentDate;

  const handlePreview = async () => {
    if (!isValid) return;
    setLoadingPreview(true);
    try {
      const { data, error } = await supabase.functions.invoke('record-payment', {
        body: {
          account_id: accountId,
          amount_paid: parsedAmount,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          remarks: notes || undefined,
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

  const handleConfirm = async () => {
    try {
      await recordPayment.mutateAsync({
        account_id: accountId,
        amount: parsedAmount,
        currency,
        date_paid: paymentDate,
        payment_method: paymentMethod,
        remarks: notes || undefined,
      });
      toast.success(`Payment of ${formatCurrency(parsedAmount, currency)} recorded successfully`);
      resetAndClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to record payment');
    }
  };

  const resetAndClose = () => {
    setAmount('');
    setNotes('');
    setPaymentMethod('cash');
    setPaymentDate(new Date().toISOString().split('T')[0]);
    setStep('input');
    setPreview(null);
    setOpen(false);
  };

  const totalPenaltyAlloc = preview?.allocations
    .filter(a => a.allocation_type === 'penalty')
    .reduce((s, a) => s + a.allocated_amount, 0) ?? 0;

  const installmentAllocs = preview?.allocations.filter(a => a.allocation_type === 'installment') ?? [];
  const totalInstallmentAlloc = installmentAllocs.reduce((s, a) => s + a.allocated_amount, 0);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        {payFullBalance ? (
          <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10 font-medium">
            <CheckCircle2 className="h-4 w-4 mr-1" /> Pay in Full
          </Button>
        ) : (
          <Button className="gold-gradient text-primary-foreground font-medium">
            <Plus className="h-4 w-4 mr-1" /> Record Payment
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground">Record Payment</DialogTitle>
          <DialogDescription>
            Remaining balance: {formatCurrency(remainingBalance, currency)}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' && (
          <form onSubmit={(e) => { e.preventDefault(); handlePreview(); }} className="space-y-4">
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
                  min={1}
                  max={remainingBalance}
                  step="any"
                />
                {parsedAmount > remainingBalance && (
                  <p className="text-xs text-destructive">Amount exceeds remaining balance</p>
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
              <Button type="submit" disabled={!isValid || loadingPreview} className="gold-gradient text-primary-foreground">
                {loadingPreview ? 'Loading…' : 'Preview Allocation'}
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
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

                  {installmentAllocs.map((alloc, idx) => (
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

            {/* Installment statuses - only for partial payments */}
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
