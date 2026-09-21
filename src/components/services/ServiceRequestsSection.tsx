import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { MessageSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import LinkedJobCell from './LinkedJobCell';
import {
  SERVICE_REQUEST_SELECT,
  kindLabel,
  requestStatusBadgeClass,
  serviceRequests,
  statusLabel,
  type ServiceRequestRow,
} from './service-request-types';

interface Props {
  /** Exactly one of these — the account or the order this section sits on. */
  layawayAccountId?: string | null;
  cashOrderId?: string | null;
}

/**
 * Read-only customer service requests for a single account or order, shown
 * beside ServiceJobsSection on AccountDetail and CashOrderDetail.
 *
 * Read-only on purpose: the queue's drawer is the one place a request is
 * edited, so there is a single audited path for a status change. A request
 * is what the customer ASKED for; the service jobs above are what the
 * workshop actually did. Both belong on the page and neither replaces the
 * other.
 */
export default function ServiceRequestsSection({ layawayAccountId, cashOrderId }: Props) {
  const targetColumn = layawayAccountId ? 'layaway_account_id' : 'cash_order_id';
  const targetId = layawayAccountId ?? cashOrderId ?? null;

  const { data: requests = [], isLoading, isError } = useQuery<ServiceRequestRow[]>({
    queryKey: ['service-requests-by-target', targetColumn, targetId],
    enabled: !!targetId,
    queryFn: async () => {
      const { data, error } = await serviceRequests()
        .select(SERVICE_REQUEST_SELECT)
        .eq(targetColumn, targetId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ServiceRequestRow[];
    },
  });

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-card-foreground">
        <MessageSquare className="h-4 w-4 text-primary" /> Service Requests
      </h3>
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : isError ? (
        <div className="text-xs text-muted-foreground">Couldn't load service requests.</div>
      ) : requests.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No service requests from the customer for this {layawayAccountId ? 'account' : 'order'}.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Age</th>
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="py-2 pr-3 font-medium">Kind</th>
                <th className="py-2 pr-3 font-medium">Ring Size</th>
                <th className="py-2 pr-3 font-medium">Details</th>
                <th className="py-2 pr-3 font-medium">Job</th>
                <th className="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                  </td>
                  <td className="py-2 pr-3 text-card-foreground">{r.item_title ?? '—'}</td>
                  <td className="py-2 pr-3">{kindLabel(r.kind)}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.ring_size ?? '—'}</td>
                  <td className="py-2 pr-3 max-w-[280px] truncate" title={r.details ?? ''}>
                    {r.details ?? '—'}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <LinkedJobCell request={r} />
                  </td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline" className={requestStatusBadgeClass(r.status)}>
                      {statusLabel(r.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
