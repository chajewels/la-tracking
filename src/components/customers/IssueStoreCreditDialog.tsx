import { useState } from 'react';
import { Wallet } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

interface IssueStoreCreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName?: string;
  onIssued?: () => void;
}

export default function IssueStoreCreditDialog({
  open,
  onOpenChange,
  customerId,
  customerName,
  onIssued,
}: IssueStoreCreditDialogProps) {
  const [currency, setCurrency] = useState<Currency>('JPY');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const amountNum = Number(amount);
  const reasonTrim = reason.trim();
  const valid =
    Number.isFinite(amountNum) &&
    amountNum > 0 &&
    reasonTrim.length >= 3;

  const reset = () => {
    setCurrency('JPY');
    setAmount('');
    setReason('');
    setConfirming(false);
    setSubmitting(false);
  };

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'issue-store-credit',
        { body: { customer_id: customerId, currency, amount: amountNum, notes: reasonTrim } },
      );
      if (error) {
        let msg = error.message || 'Failed to issue store credit';
        try {
          if ('context' in error && (error as any).context?.body) {
            const b = await new Response((error as any).context.body).json();
            if (b?.error) msg = b.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`Store credit issued — ${formatCurrency(amountNum, currency)}`);
      onIssued?.();
      close();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to issue store credit');
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-card-foreground">
            <Wallet className="h-5 w-5 text-primary" />
            Issue Store Credit
          </DialogTitle>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-sm text-card-foreground">{customerName ?? 'Customer'}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Manual issuance (goodwill / defect). Expires 1 year from today.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Currency</Label>
              <RadioGroup
                value={currency}
                onValueChange={(v) => setCurrency(v as Currency)}
                className="flex gap-4"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="JPY" id="sc-jpy" />
                  <Label htmlFor="sc-jpy" className="text-sm font-normal">¥ JPY</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="PHP" id="sc-php" />
                  <Label htmlFor="sc-php" className="text-sm font-normal">₱ PHP</Label>
                </div>
              </RadioGroup>
              <p className="text-[11px] text-muted-foreground">
                Store credit is never converted between currencies.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sc-amount" className="text-xs">Amount ({currency})</Label>
              <Input
                id="sc-amount"
                type="number"
                min={1}
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 5000"
                className="bg-background border-border tabular-nums"
              />
              {amount !== '' && !(amountNum > 0) && (
                <p className="text-xs text-destructive">Amount must be greater than 0.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sc-reason" className="text-xs">Reason (required)</Label>
              <Textarea
                id="sc-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why is this credit being issued? (stored as the lot note / audit trail)"
                className="bg-background border-border resize-none text-sm"
              />
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                disabled={!valid}
                onClick={() => setConfirming(true)}
                className="gold-gradient text-primary-foreground"
              >
                Continue
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-card-foreground">
              You are about to issue{' '}
              <span className="font-semibold">{formatCurrency(amountNum, currency)}</span>{' '}
              of store credit to {customerName ?? 'this customer'}.
            </p>
            <p className="text-xs text-muted-foreground">Reason: {reasonTrim}</p>
            <p className="text-xs text-amber-600">This credit expires 1 year from today.</p>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
              <Button
                disabled={submitting}
                onClick={submit}
                className="gold-gradient text-primary-foreground"
              >
                {submitting ? 'Submitting…' : 'Confirm'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
