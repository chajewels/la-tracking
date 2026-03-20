import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Currency } from '@/lib/types';
import { formatCurrency } from '@/lib/calculations';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';

const PENALTY_AMOUNTS = [500, 1000, 2000, 2500, 3000, 3500, 4000, 4500, 5000];

interface ScheduleItem {
  id: string;
  installment_number: number;
  due_date: string;
  base_installment_amount: number;
  status: string;
}

interface AddPenaltyDialogProps {
  accountId: string;
  currency: Currency;
  scheduleItems: ScheduleItem[];
}

export default function AddPenaltyDialog({ accountId, currency, scheduleItems }: AddPenaltyDialogProps) {
  const [open, setOpen] = useState(false);
  const [selectedSchedule, setSelectedSchedule] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState<Currency>(currency);
  const [selectedAmount, setSelectedAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const eligibleItems = scheduleItems.filter(s => s.status !== 'cancelled');

  const handleSubmit = async () => {
    if (!selectedSchedule || !selectedAmount) {
      toast.error('Please select an installment and penalty amount');
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('add-penalty', {
        body: {
          account_id: accountId,
          schedule_id: selectedSchedule,
          currency: selectedCurrency,
          penalty_amount: Number(selectedAmount),
          penalty_stage: 'week1',
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(`Penalty of ${formatCurrency(Number(selectedAmount), selectedCurrency)} added`);
      queryClient.invalidateQueries({ queryKey: ['schedule', accountId] });
      queryClient.invalidateQueries({ queryKey: ['penalties', accountId] });
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      setOpen(false);
      setSelectedSchedule('');
      setSelectedAmount('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to add penalty');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-destructive/30 text-destructive hover:bg-destructive/10">
          <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
          Add Penalty
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-card-foreground">Add Manual Penalty</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Schedule Item Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Installment</Label>
            <Select value={selectedSchedule} onValueChange={setSelectedSchedule}>
              <SelectTrigger className="bg-background border-border">
                <SelectValue placeholder="Select installment" />
              </SelectTrigger>
              <SelectContent>
                {eligibleItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    Month {item.installment_number} — {new Date(item.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{item.status === 'paid' ? ' (Paid)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Currency Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</Label>
            <Select value={selectedCurrency} onValueChange={(v) => setSelectedCurrency(v as Currency)}>
              <SelectTrigger className="bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PHP">₱ PHP</SelectItem>
                <SelectItem value="JPY">¥ JPY</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Amount Selection */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Penalty Amount</Label>
            <div className="grid grid-cols-3 gap-2">
              {PENALTY_AMOUNTS.map((amt) => (
                <Button
                  key={amt}
                  type="button"
                  variant={selectedAmount === String(amt) ? 'default' : 'outline'}
                  size="sm"
                  className={selectedAmount === String(amt)
                    ? 'gold-gradient text-primary-foreground font-semibold'
                    : 'border-border text-card-foreground hover:bg-muted'
                  }
                  onClick={() => setSelectedAmount(String(amt))}
                >
                  {formatCurrency(amt, selectedCurrency)}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={loading || !selectedSchedule || !selectedAmount}
            onClick={handleSubmit}
          >
            {loading ? 'Adding…' : 'Add Penalty'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
