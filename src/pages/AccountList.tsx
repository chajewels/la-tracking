import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search, Eye, MessageCircle, FileText, ChevronRight, ChevronLeft } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { useAccounts } from '@/hooks/use-supabase-data';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Skeleton } from '@/components/ui/skeleton';

const statusStyles: Record<string, string> = {
  active: 'bg-success/10 text-success border-success/20',
  completed: 'bg-primary/10 text-primary border-primary/20',
  overdue: 'bg-destructive/10 text-destructive border-destructive/20',
  cancelled: 'bg-muted text-muted-foreground border-border',
  forfeited: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  extension_active: 'bg-info/10 text-info border-info/20',
  final_forfeited: 'bg-destructive/10 text-destructive border-destructive/20',
  final_settlement: 'bg-warning/10 text-warning border-warning/20',
  reactivated: 'bg-info/10 text-info border-info/20',
};

const statusLabel: Record<string, string> = {
  active: 'Active',
  completed: 'Completed',
  overdue: 'Overdue',
  cancelled: 'Cancelled',
  forfeited: 'Forfeited',
  extension_active: 'Extension',
  final_forfeited: 'Perm. Forfeited',
  final_settlement: 'Settlement',
  reactivated: 'Reactivated',
};

const statusOptions = ['all', 'active', 'overdue', 'completed', 'forfeited', 'cancelled'] as const;

export default function AccountList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const [filterCurrency, setFilterCurrency] = useState<Currency | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') || 'all');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 30;
  const navigate = useNavigate();
  const { data: accounts, isLoading } = useAccounts();

  useEffect(() => {
    const s = searchParams.get('status');
    if (s && statusOptions.includes(s as any)) setFilterStatus(s);
  }, [searchParams]);

  // Reset page on filter change
  useEffect(() => { setPage(0); }, [debouncedSearch, filterCurrency, filterStatus]);

  const filtered = useMemo(() => (accounts || []).filter(a => {
    const matchesSearch = !debouncedSearch || a.invoice_number.includes(debouncedSearch) ||
      (a.customers?.full_name || '').toLowerCase().includes(debouncedSearch.toLowerCase());
    const matchesCurrency = filterCurrency === 'all' || a.currency === filterCurrency;
    const matchesStatus = filterStatus === 'all' || a.status === filterStatus;
    return matchesSearch && matchesCurrency && matchesStatus;
  }), [accounts, debouncedSearch, filterCurrency, filterStatus]);

  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl gold-gradient">
              <FileText className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">Layaway Accounts</h1>
              <p className="text-sm text-muted-foreground">{(accounts || []).length} total accounts</p>
            </div>
          </div>
          <Link to="/accounts/new">
            <Button className="gold-gradient text-primary-foreground font-medium shadow-lg">
              <Plus className="h-4 w-4 mr-1.5" /> New Account
            </Button>
          </Link>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search invoice or customer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-card border-border"
            />
          </div>
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card overflow-x-auto">
            {statusOptions.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setFilterStatus(s);
                  if (s === 'all') searchParams.delete('status');
                  else searchParams.set('status', s);
                  setSearchParams(searchParams, { replace: true });
                }}
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
        </div>

        {/* Loading */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-sm text-muted-foreground">No accounts found</p>
          </div>
        ) : (
          <>
            {/* Card Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {paged.map((account) => {
                const currency = account.currency as Currency;
                const totalAmount = Number(account.total_amount);
                const totalPaid = Number(account.total_paid);
                const remaining = Number(account.remaining_balance);
                const progress = totalAmount > 0 ? Math.round((totalPaid / totalAmount) * 100) : 0;

                return (
                  <div
                    key={account.id}
                    className="rounded-xl border border-border bg-card p-4 sm:p-5 card-hover cursor-pointer group"
                    onClick={() => navigate(`/accounts/${account.id}`)}
                  >
                    {/* Top row: invoice + status */}
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <p className="text-sm font-bold text-card-foreground font-display">
                          #{account.invoice_number}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[180px]">
                          {account.customers?.full_name || 'Unknown'}
                        </p>
                      </div>
                      <Badge variant="outline" className={`text-[10px] shrink-0 ${statusStyles[account.status] || ''}`}>
                        {statusLabel[account.status] || account.status}
                      </Badge>
                    </div>

                    {/* Progress bar */}
                    <div className="mb-3">
                      <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                        <span>{progress}% paid</span>
                        <span>{account.payment_plan_months}mo plan</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full gold-gradient rounded-full transition-all duration-500"
                          style={{ width: `${Math.min(progress, 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Amounts */}
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

                    {/* Footer actions */}
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                      <span className="text-[10px] text-muted-foreground">{currency}</span>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {account.customers?.messenger_link && (
                          <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-info">
                              <MessageCircle className="h-3.5 w-3.5" />
                            </Button>
                          </a>
                        )}
                        <Link to={`/accounts/${account.id}`}>
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
          </>
        )}
      </div>
    </AppLayout>
  );
}
