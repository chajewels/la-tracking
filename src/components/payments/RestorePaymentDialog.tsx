import { useState } from 'react';
import { RotateCcw, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';

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

interface RestorePaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paymentId: string;
  paymentAmount: number;
  paymentDate: string;
  currency: Currency;
  schedule?: ScheduleItem[];
  onRestore: (paymentId: string) => Promise<void>;
  isPending: boolean;
}

export default function RestorePaymentDialog({
  open, onOpenChange, paymentId, paymentAmount, paymentDate, currency, schedule, onRestore, isPending,
}: RestorePaymentDialogProps) {
  // Calculate which months this payment would cover
  const unpaidItems = (schedule || [])
    .filter(s => s.status !== 'paid' && s.status !== 'cancelled')
    .sort((a, b) => a.installment_number - b.installment_number);

  const monthOptions: { months: number; amount: number; label: string; covered: boolean }[] = [];
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
      monthOptions.push({
        months: i + 1,
        amount: cumulative,
        label: rangeLabel,
        covered: paymentAmount >= cumulative,
      });
    }
  }

  // Determine which months the payment covers
  const coveredMonths = monthOptions.filter(o => o.covered).length;
  const coverageLabel = coveredMonths > 0
    ? `Covers ${coveredMonths} month${coveredMonths > 1 ? 's' : ''}`
    : 'Partial payment';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-primary" />
            Restore Payment
          </DialogTitle>
          <DialogDescription>
            Re-apply this voided payment to the account schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Payment info */}
          <div className="rounded-lg border border-border bg-background p-4 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Amount</span>
              <span className="text-xl font-bold text-success">{formatCurrency(paymentAmount, currency)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Date Paid</span>
              <span className="text-sm text-card-foreground">
                {new Date(paymentDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
            {coveredMonths > 0 && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Coverage</span>
                <Badge variant="secondary" className="text-xs">{coverageLabel}</Badge>
              </div>
            )}
          </div>

          {/* Month breakdown */}
          {monthOptions.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs text-muted-foreground font-medium">Payment will be applied to:</span>
              <div className="flex flex-wrap gap-1.5">
                {monthOptions.map(opt => (
                  <div
                    key={opt.months}
                    className={`px-2.5 py-1.5 rounded-md text-xs font-medium border flex flex-col items-center min-w-[70px] ${
                      opt.covered
                        ? 'bg-primary/15 border-primary/30 text-primary'
                        : 'bg-muted/30 border-border text-muted-foreground'
                    }`}
                  >
                    <span className="flex items-center gap-1">
                      {opt.covered && <CheckCircle2 className="h-3 w-3" />}
                      {opt.label}
                    </span>
                    <span className="text-[10px] opacity-75">{formatCurrency(opt.amount, currency)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={async () => {
              await onRestore(paymentId);
              onOpenChange(false);
            }}
            disabled={isPending}
            className="gold-gradient text-primary-foreground"
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            {isPending ? 'Restoring…' : 'Confirm Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
