import { useState, useMemo } from 'react';
import { UserRoundCog, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCustomers } from '@/hooks/use-supabase-data';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';

interface Props {
  accountId: string;
  currentCustomerId: string;
  currentCustomerName: string;
  invoiceNumber: string;
}

export default function ReassignOwnerDialog({ accountId, currentCustomerId, currentCustomerName, invoiceNumber }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { data: customers } = useCustomers();
  const queryClient = useQueryClient();

  const filtered = useMemo(() => {
    if (!customers) return [];
    return customers
      .filter(c => c.id !== currentCustomerId)
      .filter(c =>
        c.full_name.toLowerCase().includes(search.toLowerCase()) ||
        (c.customer_code || '').toLowerCase().includes(search.toLowerCase()) ||
        (c.facebook_name || '').toLowerCase().includes(search.toLowerCase())
      )
      .sort((a, b) => a.full_name.localeCompare(b.full_name))
      .slice(0, 20);
  }, [customers, search, currentCustomerId]);

  const selectedCustomer = customers?.find(c => c.id === selected);

  const handleReassign = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('layaway_accounts')
        .update({ customer_id: selected })
        .eq('id', accountId);
      if (error) throw error;
      toast.success(`Inv# ${invoiceNumber} reassigned to ${selectedCustomer?.full_name}`);
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      setOpen(false);
      setSelected(null);
      setSearch('');
    } catch (err: any) {
      toast.error(err.message || 'Failed to reassign');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSelected(null); setSearch(''); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="border-primary/30 text-primary hover:bg-primary/10">
          <UserRoundCog className="h-4 w-4 mr-1.5" /> Reassign Owner
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">Reassign Account Owner</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p className="text-muted-foreground">
              Inv# <span className="font-medium text-foreground">{invoiceNumber}</span> currently belongs to{' '}
              <span className="font-medium text-foreground">{currentCustomerName}</span>
            </p>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search customer by name or code…"
              className="pl-9"
            />
          </div>

          <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">No customers found</p>
            ) : filtered.map(c => (
              <button
                key={c.id}
                type="button"
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 ${selected === c.id ? 'bg-primary/10 border-l-2 border-l-primary' : ''}`}
                onClick={() => setSelected(c.id)}
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                  {c.full_name.charAt(0)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-card-foreground truncate">{c.full_name}</p>
                  <p className="text-xs text-muted-foreground">{c.customer_code}{c.facebook_name ? ` · @${c.facebook_name}` : ''}</p>
                </div>
              </button>
            ))}
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={handleReassign}
              disabled={!selected || saving}
              className="gold-gradient text-primary-foreground font-medium"
            >
              {saving ? 'Reassigning…' : `Reassign to ${selectedCustomer?.full_name || '…'}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
