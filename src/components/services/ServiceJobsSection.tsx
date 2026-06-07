import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import type { ServiceJobRow } from './ServiceJobDialog';
import { serviceStatusBadgeClass, serviceTypeBadgeClass } from './service-badge-styles';

interface Props {
  invoiceNumber: string | null | undefined;
}

/**
 * Read-only service jobs list scoped to a single invoice number.
 * Rendered inside AccountDetail and CashOrderDetail as a section.
 */
export default function ServiceJobsSection({ invoiceNumber }: Props) {
  const { data: jobs = [], isLoading } = useQuery<ServiceJobRow[]>({
    queryKey: ['service-jobs-by-invoice', invoiceNumber],
    enabled: !!invoiceNumber,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('service_jobs')
        .select('*')
        .eq('invoice_number', invoiceNumber!)
        .order('date_received', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data as unknown as ServiceJobRow[]) ?? [];
    },
  });

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" /> Services
      </h3>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="text-xs text-muted-foreground">No service jobs recorded for this account.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Date Received</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 font-medium text-right">Fee</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Est. Completion</th>
                <th className="py-2 pr-3 font-medium">Completed</th>
                <th className="py-2 pr-3 font-medium">Updated By</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3 tabular-nums">{j.date_received}</td>
                  <td className="py-2 pr-3 text-card-foreground">{j.service_description ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline" className={serviceTypeBadgeClass(j.service_type)}>
                      {j.service_type}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {j.service_fee != null ? formatCurrency(Number(j.service_fee), 'JPY') : '—'}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline" className={serviceStatusBadgeClass(j.service_status)}>
                      {j.service_status}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{j.estimated_completion ?? '—'}</td>
                  <td className="py-2 pr-3 tabular-nums">{j.date_completed ?? '—'}</td>
                  <td className="py-2 pr-3">{j.updated_by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
