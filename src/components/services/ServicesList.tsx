import { Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

  const handleDelete = async (serviceId: string) => {
    const { error } = await supabase.from('account_services' as any).delete().eq('id', serviceId);
    if (error) {
      toast.error(error.message || 'Failed to delete service');
      return;
    }
    toast.success('Service removed');
    queryClient.invalidateQueries({ queryKey: ['account-services', accountId] });
    queryClient.invalidateQueries({ queryKey: ['customer-detail'] });
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
      {services.map(svc => (
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
              className="h-6 w-6 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => handleDelete(svc.id)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
