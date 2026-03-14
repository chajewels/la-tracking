import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { Currency, Payment } from '@/lib/types';
import { toast } from 'sonner';

interface RecordPaymentDialogProps {
  accountId: string;
  currency: Currency;
  remainingBalance: number;
  onPaymentRecorded: (payment: Payment) => void;
}

export default function RecordPaymentDialog({ accountId, currency, remainingBalance, onPaymentRecorded }: RecordPaymentDialogProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');

  const parsedAmount = parseInt(amount) || 0;
  const isValid = parsedAmount > 0 && parsedAmount <= remainingBalance && paymentDate;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    const payment: Payment = {
      id: `p-${Date.now()}`,
      account_id: accountId,
      amount: parsedAmount,
      currency,
      payment_date: paymentDate,
      recorded_by: 'CSR Alice',
      notes: notes || undefined,
    };

    onPaymentRecorded(payment);
    toast.success(`Payment of ${formatCurrency(parsedAmount, currency)} recorded successfully`);
    setAmount('');
    setNotes('');
    setPaymentDate(new Date().toISOString().split('T')[0]);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gold-gradient text-primary-foreground font-medium">
          <Plus className="h-4 w-4 mr-1" /> Record Payment
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-display text-card-foreground">Record Payment</DialogTitle>
          <DialogDescription>
            Remaining balance: {formatCurrency(remainingBalance, currency)}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
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
            />
            {parsedAmount > remainingBalance && (
              <p className="text-xs text-destructive">Amount exceeds remaining balance</p>
            )}
          </div>
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
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!isValid} className="gold-gradient text-primary-foreground">
              Confirm Payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
