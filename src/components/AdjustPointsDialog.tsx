import { useState } from 'react';
import { Calculator } from 'lucide-react';
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

interface AdjustPointsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer: { id: string; customer_code: string | null; full_name: string | null };
  member: { id: string; remaining_points: number; tier_name: string };
  onSuccess: () => void;
}

type Direction = 'add' | 'deduct';

export default function AdjustPointsDialog({
  open,
  onOpenChange,
  customer,
  member,
  onSuccess,
}: AdjustPointsDialogProps) {
  const [direction, setDirection] = useState<Direction>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const amountNum = Math.trunc(Number(amount));
  const reasonTrim = reason.trim();
  const overdraw =
    direction === 'deduct' && amountNum > member.remaining_points;
  const valid =
    Number.isInteger(amountNum) &&
    amountNum > 0 &&
    reasonTrim.length >= 10 &&
    !overdraw;

  const reset = () => {
    setDirection('add');
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
      const pointsDelta = direction === 'add' ? amountNum : -amountNum;
      const { data, error } = await supabase.functions.invoke(
        'adjust-loyalty-points',
        { body: { member_id: member.id, points_delta: pointsDelta, reason: reasonTrim } },
      );
      if (error) {
        let msg = error.message || 'Failed to adjust points';
        try {
          if ('context' in error && (error as any).context?.body) {
            const b = await new Response((error as any).context.body).json();
            if (b?.error) msg = b.error;
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      const newBal = (data as any)?.new_remaining_points;
      toast.success(
        `Points adjusted — new balance: ${Number(newBal ?? 0).toLocaleString()}`,
      );
      onSuccess();
      close();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to adjust points');
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-card-foreground">
            <Calculator className="h-5 w-5 text-primary" />
            Adjust Loyalty Points
          </DialogTitle>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-background p-3 space-y-1">
              <p className="text-sm text-card-foreground">
                {customer.customer_code ?? '—'} — {customer.full_name ?? 'Customer'}
              </p>
              <p className="text-xs text-muted-foreground">
                Current balance:{' '}
                <span className="font-semibold text-card-foreground">
                  {member.remaining_points.toLocaleString()} points
                </span>{' '}
                ({member.tier_name})
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Adjustment type</Label>
              <RadioGroup
                value={direction}
                onValueChange={(v) => setDirection(v as Direction)}
                className="flex gap-4"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="add" id="adj-add" />
                  <Label htmlFor="adj-add" className="text-sm font-normal">Add Points</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="deduct" id="adj-deduct" />
                  <Label htmlFor="adj-deduct" className="text-sm font-normal">Deduct Points</Label>
                </div>
              </RadioGroup>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adj-amount" className="text-xs">Points</Label>
              <Input
                id="adj-amount"
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 500"
                className="bg-background border-border"
              />
              {overdraw && (
                <p className="text-xs text-destructive">
                  Cannot deduct more than the current balance
                  ({member.remaining_points.toLocaleString()}).
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="adj-reason" className="text-xs">
                Reason (required, min 10 characters)
              </Label>
              <Textarea
                id="adj-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Explain why this adjustment is being made (audit-logged)"
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
              You are about to{' '}
              <span className="font-semibold">
                {direction === 'add' ? 'ADD' : 'DEDUCT'} {amountNum.toLocaleString()} points
              </span>{' '}
              {direction === 'add' ? 'to' : 'from'}{' '}
              {customer.full_name ?? 'this customer'}.
            </p>
            <p className="text-xs text-muted-foreground">Reason: {reasonTrim}</p>
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
