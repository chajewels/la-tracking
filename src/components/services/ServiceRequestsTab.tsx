import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import ServiceRequestDrawer from './ServiceRequestDrawer';
import LinkedJobCell from './LinkedJobCell';
import {
  SERVICE_REQUEST_STATUSES,
  serviceRequests,
  SERVICE_REQUEST_SELECT,
  kindLabel,
  requestStatusBadgeClass,
  statusLabel,
  type ServiceRequestRow,
} from './service-request-types';

type StatusChip = 'All' | typeof SERVICE_REQUEST_STATUSES[number];

interface Props {
  searchValue?: string;
}

/**
 * The customer service-request queue.
 *
 * Requests arrive from the storefront (POST /me/service-requests) and land
 * here for triage. Read-only in this tab — status changes go through the
 * drawer so every one of them is audited.
 *
 * Test-customer exclusion is by `customers.is_test`, not by the invoice
 * regex the financial surfaces use: a request can exist with no order and no
 * plan at all (a customer asking about a piece they have not bought yet), so
 * there is no invoice number to test. `is_test` is the DB-enforced flag
 * described in CLAUDE.md TEST ACCOUNT EXCLUSION and is the only signal that
 * works for every request.
 *
 * `?open=<id>` deep-links a single request — the staff notification bell sends
 * that when a `service_request_created` notification is clicked. The param is
 * consumed once the row it names has loaded, so closing the drawer and coming
 * back to the tab does not reopen it.
 */
export default function ServiceRequestsTab({ searchValue }: Props = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [statusChip, setStatusChip] = useState<StatusChip>('All');
  const [openRequest, setOpenRequest] = useState<ServiceRequestRow | null>(null);
  const consumedOpenParam = useRef(false);

  const { data: requests = [], isLoading, isError } = useQuery<ServiceRequestRow[]>({
    queryKey: ['service-requests'],
    queryFn: async () => {
      const { data, error } = await serviceRequests()
        .select(SERVICE_REQUEST_SELECT)
        .order('created_at', { ascending: false });
      if (error) throw error;
      // Drop test customers. A null customer embed is kept — an orphaned
      // request is a real one worth seeing, not a test artefact.
      return ((data ?? []) as ServiceRequestRow[]).filter((r) => r.customers?.is_test !== true);
    },
  });

  // Deep link: open the named request once the queue has loaded it. An id
  // that matches nothing (wrong row, test customer, already deleted) is left
  // alone rather than surfacing an error — the queue itself is the fallback.
  const openParam = searchParams.get('open');
  useEffect(() => {
    if (!openParam || consumedOpenParam.current || requests.length === 0) return;
    const match = requests.find((r) => r.id === openParam);
    if (!match) return;
    consumedOpenParam.current = true;
    setOpenRequest(match);
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [openParam, requests, searchParams, setSearchParams]);

  const filtered = useMemo(() => {
    const q = (searchValue ?? '').trim().toLowerCase();
    return requests.filter((r) => {
      if (statusChip !== 'All' && r.status !== statusChip) return false;
      if (q) {
        const haystack = [
          r.customers?.full_name,
          r.item_title,
          r.kind,
          r.details,
          r.cash_orders?.invoice_number,
          r.layaway_accounts?.invoice_number,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [requests, statusChip, searchValue]);

  // Per-status counts for the chips, computed before the status filter so
  // each chip shows its own total rather than the filtered view's.
  const countByStatus = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of requests) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }, [requests]);

  return (
    <div className="space-y-4">
      {/* All + one chip per status */}
      <div className="flex flex-wrap items-center gap-2">
        <Chip active={statusChip === 'All'} onClick={() => setStatusChip('All')}>
          All{requests.length > 0 ? ` (${requests.length})` : ''}
        </Chip>
        {SERVICE_REQUEST_STATUSES.map((s) => (
          <Chip key={s} active={statusChip === s} onClick={() => setStatusChip(s)}>
            {statusLabel(s)}{countByStatus[s] ? ` (${countByStatus[s]})` : ''}
          </Chip>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Couldn't load service requests.
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No service requests match the current filters.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground text-xs">
                <th className="py-3 px-3 font-medium">Age</th>
                <th className="py-3 px-3 font-medium">Customer</th>
                <th className="py-3 px-3 font-medium">Item</th>
                <th className="py-3 px-3 font-medium">Kind</th>
                <th className="py-3 px-3 font-medium">Ring Size</th>
                <th className="py-3 px-3 font-medium">Reference</th>
                <th className="py-3 px-3 font-medium">Job</th>
                <th className="py-3 px-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open request: ${r.item_title ?? 'service request'}`}
                  onClick={() => setOpenRequest(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpenRequest(r);
                    }
                  }}
                  className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <td className="py-2 px-3 whitespace-nowrap text-muted-foreground">
                    {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                  </td>
                  <td className="py-2 px-3">
                    {r.customer_id ? (
                      <Link
                        to={`/customers/${r.customer_id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-primary hover:underline"
                      >
                        {r.customers?.full_name ?? 'Unknown customer'}
                      </Link>
                    ) : (
                      r.customers?.full_name ?? '—'
                    )}
                  </td>
                  <td className="py-2 px-3 max-w-[260px] truncate" title={r.item_title ?? ''}>
                    {r.item_title ?? '—'}
                  </td>
                  <td className="py-2 px-3">{kindLabel(r.kind)}</td>
                  <td className="py-2 px-3 tabular-nums">{r.ring_size ?? '—'}</td>
                  <td className="py-2 px-3 tabular-nums whitespace-nowrap">
                    <RequestReference request={r} />
                  </td>
                  <td className="py-2 px-3 whitespace-nowrap">
                    <LinkedJobCell request={r} />
                  </td>
                  <td className="py-2 px-3">
                    <Badge variant="outline" className={requestStatusBadgeClass(r.status)}>
                      {statusLabel(r.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ServiceRequestDrawer request={openRequest} onClose={() => setOpenRequest(null)} />
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      onClick={onClick}
      className={active ? 'bg-primary text-primary-foreground hover:bg-primary/90' : ''}
    >
      {children}
    </Button>
  );
}

/**
 * The order or plan the request is about, linked by its invoice number.
 * A request may carry neither — the customer can ask about a piece with no
 * order behind it — and that renders as a dash, not a broken link.
 */
function RequestReference({ request }: { request: ServiceRequestRow }) {
  if (request.layaway_account_id && request.layaway_accounts) {
    return (
      <Link
        to={`/accounts/${request.layaway_account_id}`}
        onClick={(e) => e.stopPropagation()}
        className="text-primary hover:underline"
      >
        {request.layaway_accounts.invoice_number ?? 'Plan'}
      </Link>
    );
  }
  if (request.cash_order_id && request.cash_orders) {
    return (
      <Link
        to={`/cash-orders/${request.cash_order_id}`}
        onClick={(e) => e.stopPropagation()}
        className="text-primary hover:underline"
      >
        {request.cash_orders.invoice_number ?? 'Order'}
      </Link>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}
