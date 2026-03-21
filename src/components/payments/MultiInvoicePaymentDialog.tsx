import { useState, useMemo } from 'react';
import { Layers, ArrowRight, CheckCircle2, AlertTriangle, Copy, Check, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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

interface AccountInfo {
  id: string;
  invoice_number: string;
  currency: string;
  remaining_balance: number;
  total_amount: number;
  total_paid: number;
  status: string;
}

interface MultiInvoicePaymentDialogProps {
  customerId: string;
  customerName: string;
  accounts: AccountInfo[];
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

interface PreviewResult {
  preview: boolean;
  batch_id: string;
  total_amount: number;
  account_results: AccountResult[];
}

export default function MultiInvoicePaymentDialog({
  customerId,
  customerName,
  accounts,
}: MultiInvoicePaymentDialogProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'select' | 'allocate' | 'preview' | 'message'>('select');
  const [consolidatedMessage, setConsolidatedMessage] = useState('');
  const [msgCopied, setMsgCopied] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [remarks, setRemarks] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const payableAccounts = accounts.filter(
    (a) => (a.status === 'active' || a.status === 'overdue') && a.remaining_balance > 0
  );

  const selectedAccounts = payableAccounts.filter((a) => selectedIds.has(a.id));

  const totalAllocated = useMemo(
    () => selectedAccounts.reduce((s, a) => s + (parseFloat(amounts[a.id] || '0') || 0), 0),
    [selectedAccounts, amounts]
  );

  const allocationErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const a of selectedAccounts) {
      const val = parseFloat(amounts[a.id] || '0') || 0;
      if (val <= 0) errs[a.id] = 'Enter an amount';
      else if (val > a.remaining_balance) errs[a.id] = 'Exceeds balance';
    }
    return errs;
  }, [selectedAccounts, amounts]);

  const canPreview =
    selectedAccounts.length >= 2 &&
    Object.keys(allocationErrors).length === 0 &&
    totalAllocated > 0;

  const toggleAccount = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePreview = async () => {
    if (!canPreview) return;
    setLoading(true);
    try {
      const allocations = selectedAccounts.map((a) => ({
        account_id: a.id,
        amount: parseFloat(amounts[a.id] || '0'),
      }));
      const { data, error } = await supabase.functions.invoke('record-multi-payment', {
        body: {
          customer_id: customerId,
          total_amount_paid: totalAllocated,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          remarks: remarks || undefined,
          preview_only: true,
          allocations,
        },
      });
      if (error) throw error;
      setPreview(data as PreviewResult);
      setStep('preview');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate preview');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const allocations = selectedAccounts.map((a) => ({
        account_id: a.id,
        amount: parseFloat(amounts[a.id] || '0'),
      }));
      const { data, error } = await supabase.functions.invoke('record-multi-payment', {
        body: {
          customer_id: customerId,
          total_amount_paid: totalAllocated,
          date_paid: paymentDate,
          payment_method: paymentMethod,
          remarks: remarks || undefined,
          preview_only: false,
          allocations,
        },
      });
      if (error) throw error;
      toast.success(
        `Split payment of ${totalAllocated.toLocaleString()} recorded across ${selectedAccounts.length} invoices`
      );
      // Invalidate all relevant queries
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['schedule'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-summary'] });
      queryClient.invalidateQueries({ queryKey: ['payments-with-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['customer-detail', customerId] });

      // Generate consolidated message
      const results: AccountResult[] = data?.results || [];
      const primaryCurrency = (selectedAccounts[0]?.currency || 'PHP') as Currency;
      let msg = `Dear ${customerName},\n\n`;
      msg += `Thank you for your payment. ${formatCurrency(totalAllocated, primaryCurrency)} has been received.\n\n`;
      
      for (const acct of selectedAccounts) {
        const amt = parseFloat(amounts[acct.id] || '0') || 0;
        const result = results.find(r => r.account_id === acct.id);
        const isCompleted = result?.new_status === 'completed';
        const acctCurrency = (acct.currency || 'PHP') as Currency;
        msg += `Inv # ${acct.invoice_number} - ${formatCurrency(amt, acctCurrency)}`;
        if (isCompleted) msg += ` (PAID OFF)`;
        msg += `\n`;
      }
      
      msg += `\n━━━━━━━━━━━━━━━━━━\n`;
      msg += `\nThank you for your continued trust in Cha Jewels. We appreciate your business! 💛`;
      
      setConsolidatedMessage(msg);
      setStep('message');
    } catch (err: any) {
      toast.error(err.message || 'Failed to record multi-invoice payment');
    } finally {
      setSubmitting(false);
    }
  };

  const resetAndClose = () => {
    setSelectedIds(new Set());
    setAmounts({});
    setRemarks('');
    setPaymentMethod('cash');
    setPaymentDate(new Date().toISOString().split('T')[0]);
    setStep('select');
    setPreview(null);
    setOpen(false);
  };

  if (payableAccounts.length < 2) return null;

  // Determine shared currency (only show if all same, else show per-account)
  const currencies = [...new Set(payableAccounts.map((a) => a.currency))];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-primary/30 text-primary hover:bg-primary/10 font-medium">
          <Layers className="h-4 w-4 mr-1.5" /> Split Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground">
            Multi-Invoice Payment
          </DialogTitle>
          <DialogDescription>
            Split one payment across multiple invoices for {customerName}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Select Invoices */}
        {step === 'select' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Select 2 or more invoices to split a payment across.
            </p>
            <div className="space-y-2">
              {payableAccounts.map((a) => {
                const cur = a.currency as Currency;
                const checked = selectedIds.has(a.id);
                return (
                  <label
                    key={a.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      checked
                        ? 'border-primary/40 bg-primary/5'
                        : 'border-border bg-background hover:bg-muted/50'
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleAccount(a.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-card-foreground">
                          INV #{a.invoice_number}
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
                        <Badge variant="outline" className="text-[10px]">
                          {a.currency}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Balance: {formatCurrency(a.remaining_balance, cur)}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                disabled={selectedIds.size < 2}
                onClick={() => setStep('allocate')}
                className="gold-gradient text-primary-foreground"
              >
                Next: Allocate Amounts
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 2: Allocate Amounts */}
        {step === 'allocate' && (
          <div className="space-y-4">
            <div className="space-y-3">
              {selectedAccounts.map((a) => {
                const cur = a.currency as Currency;
                const err = allocationErrors[a.id];
                return (
                  <div key={a.id} className="rounded-lg border border-border bg-background p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-card-foreground">
                        INV #{a.invoice_number}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        Max: {formatCurrency(a.remaining_balance, cur)}
                      </span>
                    </div>
                    <Input
                      type="number"
                      value={amounts[a.id] || ''}
                      onChange={(e) =>
                        setAmounts((prev) => ({ ...prev, [a.id]: e.target.value }))
                      }
                      placeholder="0"
                      className="bg-card border-border tabular-nums"
                      min={1}
                      max={a.remaining_balance}
                    />
                    {err && <p className="text-xs text-destructive">{err}</p>}
                  </div>
                );
              })}
            </div>

            {/* Total */}
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 flex items-center justify-between">
              <span className="text-sm font-medium text-card-foreground">Total Payment</span>
              <span className="text-lg font-bold text-card-foreground tabular-nums">
                {totalAllocated.toLocaleString()}
              </span>
            </div>

            {/* Payment details */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-card-foreground text-xs">Date *</Label>
                <Input
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="bg-background border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-card-foreground text-xs">Method</Label>
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
            </div>
            <div className="space-y-1.5">
              <Label className="text-card-foreground text-xs">Remarks</Label>
              <Textarea
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Optional notes..."
                className="bg-background border-border resize-none"
                rows={2}
              />
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep('select')}>
                Back
              </Button>
              <Button
                disabled={!canPreview || loading}
                onClick={handlePreview}
                className="gold-gradient text-primary-foreground"
              >
                {loading ? 'Loading…' : 'Preview Allocation'}
                <ArrowRight className="h-4 w-4 ml-1" />
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 'preview' && preview && (
          <div className="space-y-4">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-center">
              <p className="text-xs text-muted-foreground">Total Split Payment</p>
              <p className="text-2xl font-bold text-card-foreground tabular-nums">
                {preview.total_amount.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                across {preview.account_results.length} invoices
              </p>
            </div>

            {preview.account_results.map((r) => {
              const acct = payableAccounts.find((a) => a.id === r.account_id);
              const cur = (acct?.currency || 'PHP') as Currency;
              const penaltyAlloc = r.payment_allocations
                .filter((a) => a.allocation_type === 'penalty')
                .reduce((s, a) => s + a.allocated_amount, 0);
              const installAlloc = r.payment_allocations
                .filter((a) => a.allocation_type === 'installment')
                .reduce((s, a) => s + a.allocated_amount, 0);
              return (
                <div
                  key={r.account_id}
                  className="rounded-lg border border-border bg-background p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-card-foreground">
                      INV #{r.invoice_number}
                    </span>
                    <span className="text-sm font-bold text-card-foreground tabular-nums">
                      {formatCurrency(r.amount_allocated, cur)}
                    </span>
                  </div>
                  <div className="space-y-1 text-xs">
                    {penaltyAlloc > 0 && (
                      <div className="flex justify-between text-destructive">
                        <span className="flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" /> Penalties
                        </span>
                        <span>{formatCurrency(penaltyAlloc, cur)}</span>
                      </div>
                    )}
                    {installAlloc > 0 && (
                      <div className="flex justify-between text-muted-foreground">
                        <span>Installments</span>
                        <span>{formatCurrency(installAlloc, cur)}</span>
                      </div>
                    )}
                    <div className="flex justify-between pt-1 border-t border-border">
                      <span className="text-muted-foreground">New Balance</span>
                      <span className="font-medium text-card-foreground">
                        {formatCurrency(r.new_remaining_balance, cur)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <Badge
                        variant={r.new_status === 'completed' ? 'default' : 'secondary'}
                        className="capitalize text-[10px]"
                      >
                        {r.new_status}
                      </Badge>
                    </div>
                  </div>
                </div>
              );
            })}

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep('allocate')}>
                Edit Amounts
              </Button>
              <Button
                onClick={handleConfirm}
                disabled={submitting}
                className="gold-gradient text-primary-foreground"
              >
                {submitting ? 'Processing…' : 'Confirm Payment'}
                <CheckCircle2 className="h-4 w-4 ml-1" />
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
