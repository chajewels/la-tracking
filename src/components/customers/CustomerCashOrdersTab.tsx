import { memo, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';
import StatusBadge from './StatusBadge';

interface CashOrderRow {
  id: string;
  invoice_number: string;
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
      const { data, error } = await (supabase as any)
        .from('cash_orders')
        .select('id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, item_description, created_at')
        .eq('customer_id', customerId)
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

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg gold-gradient">
            <Banknote className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground font-display">Cash Orders</h3>
            <p className="text-xs text-muted-foreground">
              {isLoading ? 'Loading…' : `${orders?.length ?? 0} total`}
            </p>
          </div>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
        </div>
      ) : !orders || orders.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Banknote className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm text-muted-foreground mb-4">No cash orders for this customer</p>
          {canCreate && (
            <Link to={createHref}>
              <Button className="gold-gradient text-primary-foreground font-medium">
                <Plus className="h-4 w-4 mr-1.5" /> New Cash Order
              </Button>
            </Link>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {paged.map(order => {
              const currency = order.currency as Currency;
              const totalAmount = Number(order.total_amount);
              const totalPaid = Number(order.total_paid);
              const progress = totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0;
              const isTest = (order.invoice_number || '').startsWith('TEST-');

              return (
                <div
                  key={order.id}
                  className="rounded-xl border border-border bg-card p-4 sm:p-5 card-hover cursor-pointer group"
                  onClick={() => navigate(`/cash-orders/${order.id}`)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-card-foreground font-display">
                        #{order.invoice_number}
                      </p>
                      {order.item_description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[220px]">
                          {order.item_description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusBadge status={order.status} />
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

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                    <span className="text-[10px] text-muted-foreground">
                      {order.order_date || Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(order.created_at))} · {currency}
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
