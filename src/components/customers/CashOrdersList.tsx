import { memo, useState, useMemo, useCallback, useRef, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, ChevronRight, ChevronLeft, Banknote } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import StatusBadge from './StatusBadge';

const EmbeddedWrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

type CashOrderStatus = 'all' | 'pending' | 'completed' | 'cancelled';

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
  customers: { id: string; full_name: string; messenger_link: string | null } | null;
}

const statusOptions: CashOrderStatus[] = ['all', 'pending', 'completed', 'cancelled'];
const PAGE_SIZE = 50;

function useCashOrders() {
  return useQuery({
    queryKey: ['cash-orders'],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cash_orders' as any)
        .select('id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, item_description, created_at, customers(id, full_name, messenger_link)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as CashOrderRow[];
    },
  });
}

const CashOrdersList = memo(function CashOrdersList({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const { roles } = useAuth();
  const { can } = usePermissions();
  const isAdmin = roles.includes('admin' as never);

  const searchRef = useRef('');
  const [filterTick, setFilterTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const handleSearch = useCallback((v: string) => {
    searchRef.current = v;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setFilterTick(t => t + 1), 300);
  }, []);

  const [filterStatus, setFilterStatus] = useState<CashOrderStatus>('all');
  const [filterCurrency, setFilterCurrency] = useState<Currency | 'all'>('all');
  const [hideTest, setHideTest] = useState(true);
  const [page, setPage] = useState(0);

  const { data: orders, isLoading } = useCashOrders();

  const filtered = useMemo(() => (orders || []).filter(o => {
    const search = searchRef.current.toLowerCase();
    const matchesSearch = !search ||
      (o.invoice_number || '').toLowerCase().includes(search) ||
      (o.customers?.full_name || '').toLowerCase().includes(search);
    const matchesStatus = filterStatus === 'all' || o.status === filterStatus;
    const matchesCurrency = filterCurrency === 'all' || o.currency === filterCurrency;
    const isTest = (o.invoice_number || '').startsWith('TEST-');
    const matchesTest = !hideTest || !isTest;
    return matchesSearch && matchesStatus && matchesCurrency && matchesTest;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [orders, filterTick, filterStatus, filterCurrency, hideTest]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  const Wrapper = embedded ? EmbeddedWrapper : AppLayout;

  const canCreate = can('create_account') || isAdmin;

  return (
    <Wrapper>
      <div className={embedded ? 'space-y-6' : 'animate-fade-in space-y-6'}>
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
              <Banknote className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">Cash Orders</h1>
              <p className="text-sm text-muted-foreground">{filtered.length} total orders</p>
            </div>
          </div>
          {canCreate && (
            <Link to="/cash-orders/new">
              <Button className="gold-gradient text-primary-foreground font-medium shadow-lg">
                <Plus className="h-4 w-4 mr-1.5" /> New Cash Order
              </Button>
            </Link>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              defaultValue=""
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search invoice # or customer…"
              className="pl-9 bg-card border-border"
            />
          </div>
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card overflow-x-auto">
            {statusOptions.map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors whitespace-nowrap ${
                  filterStatus === s
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {s === 'all' ? 'All' : s}
              </button>
            ))}
          </div>
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card">
            {(['all', 'PHP', 'JPY'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilterCurrency(c)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  filterCurrency === c
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {c === 'all' ? 'All' : c}
              </button>
            ))}
          </div>
          {isAdmin && (
            <button
              onClick={() => setHideTest(!hideTest)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                hideTest
                  ? 'border-border text-muted-foreground hover:text-foreground'
                  : 'border-info/30 bg-info/10 text-info'
              }`}
            >
              🧪 {hideTest ? 'Show Test' : 'Hide Test'}
            </button>
          )}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <Banknote className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">No cash orders found</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {paged.map((order) => {
                const currency = order.currency as Currency;
                const totalAmount = Number(order.total_amount);
                const totalPaid = Number(order.total_paid);
                const remaining = Number(order.remaining_balance);
                const progress = totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0;
                const isTest = (order.invoice_number || '').startsWith('TEST-');

                return (
                  <div
                    key={order.id}
                    className="rounded-xl border border-border bg-card p-4 sm:p-5 card-hover cursor-pointer group"
                    onClick={() => navigate(`/cash-orders/${order.id}`)}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="text-sm font-bold text-card-foreground font-display">
                          #{order.invoice_number}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[180px]">
                          {order.customers?.full_name || 'Unknown'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
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

                    <div className="grid grid-cols-3 gap-2 text-center">
                      <div>
                        <p className="text-[10px] text-muted-foreground">Total</p>
                        <p className="text-xs font-semibold text-card-foreground tabular-nums">
                          {formatCurrency(totalAmount, currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Paid</p>
                        <p className="text-xs font-semibold text-success tabular-nums">
                          {formatCurrency(totalPaid, currency)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">Balance</p>
                        <p className="text-xs font-bold text-card-foreground tabular-nums">
                          {formatCurrency(remaining, currency)}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                      <span className="text-[10px] text-muted-foreground">
                        {order.order_date || new Date(order.created_at).toISOString().split('T')[0]} · {currency}
                      </span>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Link to={`/cash-orders/${order.id}`}>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary">
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
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
    </Wrapper>
  );
});

export default CashOrdersList;
