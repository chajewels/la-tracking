import { useState } from 'react';
import { Trash2, Wrench, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

const SERVICE_LABELS: Record<string, string> = {
  resize: 'Resize',
  certificate: 'Certificate',
  polish: 'Polish',
  change_color: 'Change Color',
  engraving: 'Engraving',
  repair: 'Repair',
  other: 'Other',
};

export interface AccountService {
  id: string;
  account_id: string;
  service_type: string;
  description: string | null;
  amount: number;
  currency: string;
  created_at: string;
}

interface ServicesListProps {
  services: AccountService[];
  currency: Currency;
  accountId: string;
  compact?: boolean;
}

export default function ServicesList({ services, currency, accountId, compact }: ServicesListProps) {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['account-services', accountId] });
    queryClient.invalidateQueries({ queryKey: ['customer-detail'] });
  };

  const handleDelete = async (serviceId: string) => {
    const { error } = await supabase.from('account_services' as any).delete().eq('id', serviceId);
    if (error) {
      toast.error(error.message || 'Failed to delete service');
      return;
    }
    toast.success('Service removed');
    invalidate();
  };

  const handleEditSave = async (serviceId: string) => {
    const amt = parseFloat(editAmount);
    if (isNaN(amt) || amt < 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('account_services' as any)
        .update({
          amount: amt,
          description: editDescription.trim() || null,
        } as any)
        .eq('id', serviceId);
      if (error) throw error;
      toast.success('Service updated');
      setEditingId(null);
      invalidate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  if (services.length === 0) return null;

  const totalServices = services.reduce((s, svc) => s + Number(svc.amount), 0);

  return (
    <div className="space-y-1.5">
      {!compact && (
        <h3 className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Wrench className="h-3.5 w-3.5 text-primary" /> Additional Services
          <span className="ml-auto text-xs font-bold text-card-foreground tabular-nums">
            Total: {formatCurrency(totalServices, currency)}
          </span>
        </h3>
      )}
      {services.map(svc => {
        const isEditing = editingId === svc.id;

        if (isEditing) {
          return (
            <div key={svc.id} className="p-2.5 rounded-lg border border-primary/30 bg-muted/30 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Wrench className="h-3 w-3" />
                </div>
                <span className="text-xs font-medium text-card-foreground">
                  {SERVICE_LABELS[svc.service_type] || svc.service_type}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase">Amount ({currency})</label>
                  <Input
                    type="number"
                    value={editAmount}
                    onChange={e => setEditAmount(e.target.value)}
                    className="h-7 text-xs bg-background tabular-nums"
                    min={0}
                    autoFocus
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleEditSave(svc.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase">Description</label>
                  <Input
                    value={editDescription}
                    onChange={e => setEditDescription(e.target.value)}
                    className="h-7 text-xs bg-background"
                    placeholder="Optional"
                  />
                </div>
              </div>
              <div className="flex gap-1 justify-end">
                <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" onClick={() => setEditingId(null)}>
                  <X className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-success" disabled={saving} onClick={() => handleEditSave(svc.id)}>
                  <Check className="h-3 w-3" />
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div key={svc.id} className="group flex items-center justify-between p-2 sm:p-2.5 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Wrench className="h-3 w-3" />
              </div>
              <div>
                <p className="text-xs sm:text-sm font-medium text-card-foreground">
                  {SERVICE_LABELS[svc.service_type] || svc.service_type}
                </p>
                {svc.description && (
                  <p className="text-[10px] sm:text-xs text-muted-foreground">{svc.description}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <p className="text-xs sm:text-sm font-semibold tabular-nums text-card-foreground">
                {formatCurrency(Number(svc.amount), currency)}
              </p>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => {
                  setEditingId(svc.id);
                  setEditAmount(String(svc.amount));
                  setEditDescription(svc.description || '');
                }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => handleDelete(svc.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
