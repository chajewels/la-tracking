import { memo, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';
import { cashOrderRef, isTestCashOrder } from '@/lib/order-reference';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import StatusPill from '@/components/shared/StatusPill';
import { CASH_ORDER_STATUS_TONE } from '@/components/shared/status-tone';
import IllustratedState, { LedgerIllustration } from '@/components/shared/LedgerIllustration';
import { useIsMobile } from '@/hooks/use-mobile';

// Same labels the old StatusBadge showed.
const statusLabel: Record<string, string> = { pending: 'Pending', completed: 'Completed', cancelled: 'Cancelled', expired: 'Expired' };
const orderDateLabel = (o: CashOrderRow) =>
  o.order_date || Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(o.created_at));

interface CashOrderRow {
  id: string;
  invoice_number: string;
  source_channel?: string | null;
  web_reference?: string | null;
  currency: Currency;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  status: string;
  order_date: string | null;
  item_description: string | null;
  created_at: string;
}

const PAGE_SIZE = 20;

function useCustomerCashOrders(customerId: string | undefined) {
  return useQuery({
    queryKey: ['cash-orders-by-customer', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cash_orders')
        .select('id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, item_description, created_at, source_channel, web_reference')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as CashOrderRow[]);
    },
  });
}

export default memo(function CustomerCashOrdersTab({ customerId }: { customerId: string }) {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canCreate = can('create_cash_order');

  const { data: orders, isLoading } = useCustomerCashOrders(customerId);
  const [page, setPage] = useState(0);

  const paged = useMemo(() => (orders || []).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [orders, page]);
  const totalPages = Math.ceil((orders?.length || 0) / PAGE_SIZE);

  const createHref = `/cash-orders/new?customer_id=${encodeURIComponent(customerId)}`;
  // Desktop: the Sales cash-order ledger treatment; phones keep the cards.
  const isMobile = useIsMobile();
  const money = (n: number, c: Currency) => <span className="tabular-nums">{formatCurrency(n, c)}</span>;
  const columns: DataTableColumn<CashOrderRow>[] = [
    {
      key: 'ref', header: 'Reference', cellClassName: 'whitespace-nowrap',
      cell: (o) => (
        <span className="inline-flex items-center gap-2">
          <Link to={`/cash-orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="font-deco text-base font-semibold text-champagne [font-variant-numeric:lining-nums_tabular-nums] hover:text-gold-300 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {o.source_channel === 'web' ? cashOrderRef(o) : `#${o.invoice_number}`}
          </Link>
          {isTestCashOrder(o) && (
            <span className="inline-flex h-4 items-center rounded-md border border-info/20 bg-info/10 px-1.5 text-[9px] font-bold text-info">TEST</span>
          )}
        </span>
      ),
    },
    {
      key: 'item', header: 'Item', cellClassName: 'max-w-[200px]',
      cell: (o) => o.item_description
        ? <span className="block truncate text-card-foreground" title={o.item_description}>{o.item_description}</span>
        : <span className="text-muted-foreground/50">—</span>,
    },
    { key: 'status', header: 'Status', cell: (o) => <StatusPill label={statusLabel[o.status] || o.status} tone={CASH_ORDER_STATUS_TONE[o.status] ?? 'muted'} /> },
    {
      key: 'progress', header: 'Paid',
      cell: (o) => {
        const total = Number(o.total_amount);
        const pct = total > 0 ? Math.round((Number(o.total_paid) / total) * 100) : 0;
        return (
          <span className="flex items-center gap-2" title={`${pct}% paid`}>
            <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full gold-gradient" style={{ width: `${Math.min(pct, 100)}%` }} />
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{pct}%</span>
          </span>
        );
      },
    },
    { key: 'date', header: 'Date', align: 'right', cell: (o) => <span className="text-muted-foreground tabular-nums">{orderDateLabel(o)}</span> },
    { key: 'total', header: 'Total', align: 'right', cell: (o) => money(Number(o.total_amount), o.currency) },
    { key: 'paid', header: 'Received', align: 'right', cell: (o) => <span className="text-success">{money(Number(o.total_paid), o.currency)}</span> },
    { key: 'balance', header: 'Balance', align: 'right', cell: (o) => <span className="font-semibold text-champagne">{money(Number(o.remaining_balance), o.currency)}</span> },
    {
      key: 'open', header: '', hideable: false, align: 'right', cellClassName: 'w-12',
      cell: (o) => (
        <Link to={`/cash-orders/${o.id}`} aria-label={`Open cash order ${cashOrderRef(o)}`} onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" tabIndex={-1}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap pb-3 hairline-b">
        <div>
          <h3 className="font-deco text-2xl font-semibold leading-tight text-champagne">Cash Orders</h3>
          <p className="text-xs text-muted-foreground">
            {isLoading ? 'Loading…' : `${orders?.length ?? 0} total`}
          </p>
        </div>
        {canCreate && (
          <Link to={createHref}>
            <Button className="gold-gradient text-primary-foreground font-medium shadow">
              <Plus className="h-4 w-4 mr-1.5" /> New Cash Order
            </Button>
          </Link>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
            <LedgerIllustration kind="scroll" className="h-8 w-10" />
            Loading cash orders…
          </div>
          {isMobile ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
            </div>
          ) : (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}
            </div>
          )}
        </div>
      ) : !orders || orders.length === 0 ? (
        <IllustratedState
          kind="scroll"
          className="rounded-xl border border-gold-500/15 bg-card py-10"
          text="No cash orders for this customer"
          action={canCreate ? (
            <Link to={createHref}>
              <Button className="gold-gradient text-primary-foreground font-medium">
                <Plus className="h-4 w-4 mr-1.5" /> New Cash Order
              </Button>
            </Link>
          ) : undefined}
        />
      ) : (
        <>
          {!isMobile ? (
            <DataTable
              variant="ledger"
              showToolbar={false}
              stickyHeader={false}
              columns={columns}
              rows={paged}
              rowKey={(o) => o.id}
              onRowClick={(o) => navigate(`/cash-orders/${o.id}`)}
              rowProps={(o) => ({
                tabIndex: 0,
                'aria-label': `Cash order ${cashOrderRef(o)}. Press Enter to open.`,
                onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  if ((e.target as HTMLElement).closest('button, a')) return;
                  e.preventDefault();
                  navigate(`/cash-orders/${o.id}`);
                },
              })}
            />
          ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {paged.map(order => {
              const currency = order.currency as Currency;
              const totalAmount = Number(order.total_amount);
              const totalPaid = Number(order.total_paid);
              const progress = totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0;
              const isTest = isTestCashOrder(order);

              return (
                <div
                  key={order.id}
                  className="rounded-xl border border-gold-500/15 bg-card p-4 sm:p-5 card-hover cursor-pointer group"
                  onClick={() => navigate(`/cash-orders/${order.id}`)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0">
                      <p className="font-deco text-lg font-semibold leading-tight text-champagne [font-variant-numeric:lining-nums_tabular-nums]">
                        {order.source_channel === 'web' ? cashOrderRef(order) : `#${order.invoice_number}`}
                      </p>
                      {order.item_description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[220px]" title={order.item_description}>
                          {order.item_description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusPill label={statusLabel[order.status] || order.status} tone={CASH_ORDER_STATUS_TONE[order.status] ?? 'muted'} />
                      {isTest && (
                        <span className="inline-flex items-center rounded-md border border-info/20 bg-info/10 px-1.5 py-0.5 text-[10px] font-bold text-info">
                          🧪 TEST
                        </span>
                      )}
                    </div>
                  </div>

                  {order.status === 'pending' && (
                    <div className="mb-3">
                      <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                        <span>{progress}% paid</span>
                        <span>Cash</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full gold-gradient rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(progress, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Paid</p>
                      <p className="text-xs font-semibold text-success tabular-nums">
                        {formatCurrency(totalPaid, currency)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Total</p>
                      <p className="text-xs font-bold text-card-foreground tabular-nums">
                        {formatCurrency(totalAmount, currency)}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-3 pt-3 hairline-t">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {orderDateLabel(order)} · {currency}
                    </span>
                    <Link to={`/cash-orders/${order.id}`} onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary">
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                Next <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
});
