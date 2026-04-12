import { useState } from 'react';
import { Plus, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Currency } from '@/lib/types';

const SERVICE_TYPES = [
  { value: 'resize', label: 'Resize' },
  { value: 'certificate', label: 'Certificate' },
  { value: 'polish', label: 'Polish' },
  { value: 'change_color', label: 'Change Color' },
  { value: 'engraving', label: 'Engraving' },
  { value: 'repair', label: 'Repair' },
  { value: 'other', label: 'Other' },
];

interface AddServiceDialogProps {
  accountId: string;
  currency: Currency;
}

export default function AddServiceDialog({ accountId, currency }: AddServiceDialogProps) {
  const [open, setOpen] = useState(false);
  const [serviceType, setServiceType] = useState('resize');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();

  const handleSubmit = async () => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 0) {
      toast.error('Enter a valid amount');
      return;
    }

    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('account_services' as any).insert({
        account_id: accountId,
        service_type: serviceType,
        description: description.trim() || null,
        amount: amountNum,
        currency,
        created_by_user_id: user?.id,
      } as any);

      if (error) throw error;

      // Update total_amount and remaining_balance per CLAUDE.md:
      // total_amount includes services; remaining = total_amount + penalties - payments
      const { data: account } = await supabase
        .from('layaway_accounts')
        .select('total_amount, total_paid, downpayment_amount')
        .eq('id', accountId)
        .single();

      if (account) {
        const newTotalAmount = Number(account.total_amount) + amountNum;

        const { data: penalties } = await supabase
          .from('penalty_fees')
          .select('penalty_amount')
          .eq('account_id', accountId)
          .neq('status', 'waived');

        const activePenalties = (penalties || [])
          .reduce((sum: number, p: any) => sum + Number(p.penalty_amount), 0);

        const newRemainingBalance = Math.max(0,
          Math.round((newTotalAmount + activePenalties - Number(account.total_paid)) * 100) / 100
        );

        await supabase
          .from('layaway_accounts')
          .update({
            total_amount: newTotalAmount,
            remaining_balance: newRemainingBalance,
          })
          .eq('id', accountId);
      }

      toast.success('Service added successfully');
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['schedule', accountId] });
      queryClient.invalidateQueries({ queryKey: ['account-services', accountId] });
      queryClient.invalidateQueries({ queryKey: ['customer-detail'] });
      setOpen(false);
      setServiceType('resize');
      setDescription('');
      setAmount('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to add service');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
          <Wrench className="h-3.5 w-3.5 mr-1" /> Add Service
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-card-foreground">Add Service</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Service Type</label>
            <Select value={serviceType} onValueChange={setServiceType}>
              <SelectTrigger className="mt-1 bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_TYPES.map(st => (
                  <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Description (optional)</label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="e.g. Resize ring from size 6 to size 8"
              rows={2}
              className="mt-1 bg-background border-border text-sm resize-none"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Amount ({currency})</label>
            <Input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              className="mt-1 bg-background border-border tabular-nums"
              min={0}
              step={currency === 'JPY' ? 1 : 0.01}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={loading} className="gold-gradient text-primary-foreground">
            {loading ? 'Adding…' : 'Add Service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
