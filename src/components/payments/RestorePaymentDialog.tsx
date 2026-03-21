import { useEffect, useMemo, useState } from 'react';
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
  onRestore: (paymentId: string, selectedScheduleIds: string[]) => Promise<void>;
  isPending: boolean;
}

export default function RestorePaymentDialog({
  open,
  onOpenChange,
  paymentId,
  paymentAmount,
  paymentDate,
  currency,
  schedule,
  onRestore,
  isPending,
}: RestorePaymentDialogProps) {
  const unpaidItems = useMemo(
    () => (schedule || [])
      .filter((s) => s.status !== 'paid' && s.status !== 'cancelled')
      .sort((a, b) => a.installment_number - b.installment_number),
    [schedule],
  );

  const monthOptions = useMemo(() => {
    const options: {
      key: number;
      months: number;
      amount: number;
      label: string;
      scheduleIds: string[];
    }[] = [];

    let cumulative = 0;
    for (let i = 0; i < Math.min(5, unpaidItems.length); i++) {
      const item = unpaidItems[i];
      const due = Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
      cumulative += due;

      if (cumulative > 0) {
        const start = unpaidItems[0];
        const dateLabel = new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const rangeLabel = i === 0
          ? dateLabel
          : `${new Date(start.due_date).toLocaleDateString('en-US', { month: 'short' })} – ${new Date(item.due_date).toLocaleDateString('en-US', { month: 'short' })}`;

        options.push({
          key: i + 1,
          months: i + 1,
          amount: cumulative,
          label: rangeLabel,
          scheduleIds: unpaidItems.slice(0, i + 1).map((dueItem) => dueItem.id),
        });
      }
    }

    return options;
  }, [unpaidItems]);

  const [selectedKey, setSelectedKey] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;

    const exact = monthOptions.find((option) => Math.abs(option.amount - paymentAmount) < 0.01);
    const nearest = monthOptions.find((option) => option.amount >= paymentAmount) ?? monthOptions[monthOptions.length - 1] ?? null;
    setSelectedKey((exact ?? nearest)?.key ?? null);
  }, [open, paymentId, paymentAmount, monthOptions]);

  const selectedOption = monthOptions.find((option) => option.key === selectedKey) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-card-foreground">
            <RotateCcw className="h-5 w-5 text-primary" />
            Restore Payment
          </DialogTitle>
          <DialogDescription>
            Choose which monthly dues this voided payment should restore.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 rounded-lg border border-border bg-background p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Amount</span>
              <span className="text-xl font-bold text-success">{formatCurrency(paymentAmount, currency)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Date Paid</span>
              <span className="text-sm text-card-foreground">
                {new Date(paymentDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
            {selectedOption && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Selected due range</span>
                <Badge variant="secondary" className="text-xs">
                  {selectedOption.label}
                </Badge>
              </div>
            )}
          </div>

          {monthOptions.length > 0 ? (
            <div className="space-y-2">
              <span className="text-xs font-medium text-muted-foreground">Select monthly due coverage:</span>
              <div className="flex flex-wrap gap-1.5">
                {monthOptions.map((option) => {
                  const isSelected = option.key === selectedKey;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setSelectedKey(option.key)}
                      className={`flex min-w-[82px] flex-col items-center rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        isSelected
                          ? 'border-primary/30 bg-primary/15 text-primary'
                          : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted hover:text-card-foreground'
                      }`}
                    >
                      <span className="flex items-center gap-1">
                        {isSelected && <CheckCircle2 className="h-3 w-3" />}
                        {option.label}
                      </span>
                      <span className="text-[10px] opacity-75">{formatCurrency(option.amount, currency)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
              No unpaid monthly dues available for this restore.
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={async () => {
              await onRestore(paymentId, selectedOption?.scheduleIds || []);
              onOpenChange(false);
            }}
            disabled={isPending || monthOptions.length === 0 || !selectedOption}
            className="gold-gradient text-primary-foreground"
          >
            <RotateCcw className="mr-1 h-4 w-4" />
            {isPending ? 'Restoring…' : 'Confirm Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
