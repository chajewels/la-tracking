import { useState, useMemo } from 'react';
import { addMonths, endOfMonth, format, startOfMonth } from 'date-fns';
import { Activity, TrendingUp, Banknote, CalendarClock, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { toJpy, getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { Currency } from '@/lib/types';
import { useAccounts, usePayments, useDashboardSummary } from '@/hooks/use-supabase-data';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { computeCollectionStats, todayStr } from '@/lib/business-rules';

interface SelectedCard { key: string; label: string; count: number }

export default function Collections() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);
  const { session, loading: authLoading } = useAuth();

  const [selectedCard, setSelectedCard] = useState<SelectedCard | null>(null);
  const [drillSearch, setDrillSearch] = useState('');

  const { data: summary } = useDashboardSummary(currencyFilter, Boolean(session) && !authLoading);
  const { data: allPayments, isLoading: payLoading } = usePayments();
  const { data: accounts } = useAccounts();

  // ── 6-month receivables forecast (server-side RPC avoids .in() URL limit) ──
  const { data: forecastSchedule, isLoading: forecastLoading } = useQuery({
    queryKey: ['collections-forecast-6m', format(new Date(), 'yyyy-MM-dd')],
    staleTime: 0,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_forecast_6m');
      if (error) throw error;
      return (data || []) as { month: string; currency: string; installments: number; remaining: number }[];
    },
  });

  // ── Drilldown: pending accounts for selected forecast month ──
  const { data: drilldownRaw, isLoading: drilldownLoading } = useQuery({
    queryKey: ['forecast-drilldown', selectedCard?.key],
    enabled: !!selectedCard,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      if (!selectedCard) return [];
      const monthStart = selectedCard.key + '-01';
      const d = new Date(monthStart + 'T00:00:00');
      const monthEnd = format(endOfMonth(d), 'yyyy-MM-dd');
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('id, due_date, status, total_due_amount, paid_amount, layaway_accounts!inner(id, invoice_number, currency, status, customers(full_name))')
        .gte('due_date', monthStart)
        .lte('due_date', monthEnd)
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .order('due_date', { ascending: true });
      if (error) throw error;
      return (data || []).filter((row: any) => {
        const a = row.layaway_accounts;
        return a &&
          ['active', 'overdue', 'final_settlement', 'extension_active'].includes(a.status) &&
          !String(a.invoice_number).startsWith('TEST-');
      });
    },
  });

  const drilldownRows = useMemo(() => {
    if (!drilldownRaw) return [];
    const q = drillSearch.toLowerCase().trim();
    if (!q) return drilldownRaw;
    return drilldownRaw.filter((row: any) => {
      const inv = String(row.layaway_accounts?.invoice_number ?? '').toLowerCase();
      const name = String(row.layaway_accounts?.customers?.full_name ?? '').toLowerCase();
      return inv.includes(q) || name.includes(q);
    });
  }, [drilldownRaw, drillSearch]);

  // Keyed on today so month slots recalculate on rollover
  const today = format(new Date(), 'yyyy-MM-dd');

  const forecastCards = useMemo(() => {
    if (!forecastSchedule) return null;

    const agg: Record<string, { jpy: number; count: number }> = {};
    forecastSchedule.forEach(row => {
      const monthKey = row.month.substring(0, 7);
      if (!agg[monthKey]) agg[monthKey] = { jpy: 0, count: 0 };
      agg[monthKey].jpy += toJpy(Number(row.remaining), row.currency as Currency);
      agg[monthKey].count += Number(row.installments);
    });

    const now = new Date();
    const todayDay = now.getDate();
    const prevMonthKey = format(startOfMonth(addMonths(now, -1)), 'yyyy-MM');
    const hasPrevMonth = !!(agg[prevMonthKey]?.count > 0);

    const startMonth = hasPrevMonth ? startOfMonth(addMonths(now, -1)) : startOfMonth(now);
    const length = hasPrevMonth ? 7 : 6;

    return Array.from({ length }, (_, i) => {
      const monthStart = addMonths(startMonth, i);
      const key = format(monthStart, 'yyyy-MM');
      const lastDay = endOfMonth(monthStart);
      const cardDate = new Date(monthStart.getFullYear(), monthStart.getMonth(), todayDay);
      const labelDate = cardDate > lastDay ? lastDay : cardDate;
      const label = format(labelDate, 'MMM d');
      const daysAway = Math.ceil((labelDate.getTime() - now.getTime()) / 86_400_000);
      return { key, label, daysAway, ...(agg[key] ?? { jpy: 0, count: 0 }) };
    })
    .map(m => ({ ...m, jpy: Math.round(m.jpy) }));
  }, [forecastSchedule, today]);

  // Build account map for payment feed
  const accountMap = useMemo(() => {
    if (!accounts) return new Map();
    return new Map(accounts.map(a => [a.id, a]));
  }, [accounts]);

  const filtered = useMemo(() => {
    if (!allPayments) return [];
    return allPayments
      .filter(p => !p.voided_at)
      .filter(p => isAllMode || p.currency === currencyFilter)
      .sort((a, b) => {
        const dateDiff = new Date(b.date_paid).getTime() - new Date(a.date_paid).getTime();
        if (dateDiff !== 0) return dateDiff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }, [allPayments, currencyFilter, isAllMode]);

  const stats = useMemo(() => {
    const normalized = filtered.map(p => ({
      date_paid: p.date_paid,
      amount: isAllMode ? toJpy(Number(p.amount_paid), p.currency as Currency) : Number(p.amount_paid),
    }));
    return computeCollectionStats(normalized);
  }, [filtered, isAllMode]);

  const { data: profiles } = useQuery({
    queryKey: ['profiles-lookup'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('user_id, full_name');
      if (error) throw error;
      return new Map((data || []).map(p => [p.user_id, p.full_name]));
    },
  });

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Live Collections</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Real-time payment tracking · Live data</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard title="Today" value={formatCurrency(stats.todayTotal, displayCurrency)} icon={TrendingUp} variant="gold" />
          <StatCard title="Yesterday" value={formatCurrency(stats.yesterdayTotal, displayCurrency)} icon={TrendingUp} />
          <StatCard title="This Week" value={formatCurrency(stats.weekTotal, displayCurrency)} icon={TrendingUp} />
          <StatCard title="This Month" value={formatCurrency(stats.monthTotal, displayCurrency)} icon={TrendingUp} variant="success" />
          <StatCard title="This Year" value={formatCurrency(stats.yearTotal, displayCurrency)} icon={Banknote} />
        </div>

        {/* 6-Month Receivables Forecast */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              Upcoming Receivables
            </h3>
            <span className="text-xs text-muted-foreground">Click a card to see accounts</span>
          </div>

          {forecastLoading || !forecastCards ? (
            <div className="flex gap-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="flex-1 h-24 rounded-lg" />)}
            </div>
          ) : (
            <div className="flex gap-3">
              {forecastCards.map((card, i) => (
                <div
                  key={card.key}
                  className="flex-1 rounded-lg border border-border bg-muted/30 p-3 cursor-pointer hover:border-primary/50 hover:bg-muted/50 transition-colors"
                  onClick={() => { setSelectedCard({ key: card.key, label: card.label, count: card.count }); setDrillSearch(''); }}
                >
                  <div className="text-xs font-semibold text-muted-foreground mb-2">{card.label}</div>
                  <div className="text-base font-bold text-foreground tabular-nums leading-tight">
                    {formatCurrency(card.jpy, 'JPY')}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1.5">{card.count} accts</div>
                  {i === 0 && (
                    <div className="text-[10px] font-medium text-primary mt-1">Due in {card.daysAway}d</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Payment Feed */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-card-foreground">Payment Feed</h3>
            <span className="text-xs text-muted-foreground">{filtered.length} payments</span>
          </div>
          {payLoading ? (
            <div className="p-5 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-sm text-muted-foreground">No payments found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Date</th>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
                    <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Amount</th>
                    {isAllMode && (
                      <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">JPY Equiv.</th>
                    )}
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Method</th>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Recorded By</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 100).map(p => {
                    const account = accountMap.get(p.account_id);
                    const jpyEquiv = toJpy(Number(p.amount_paid), p.currency as Currency);
                    const csrName = p.entered_by_user_id ? (profiles?.get(p.entered_by_user_id) || '—') : '—';
                    return (
                      <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 text-sm text-muted-foreground">
                          {new Date(p.date_paid).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-5 py-3 text-sm font-medium text-card-foreground">
                          {account ? (
                            <Link to={`/accounts/${account.id}`} className="hover:text-primary transition-colors">
                              {account.customers?.full_name || '—'}
                            </Link>
                          ) : '—'}
                        </td>
                        <td className="px-5 py-3 text-sm text-muted-foreground">
                          {account ? (
                            <Link to={`/accounts/${account.id}`} className="hover:text-primary transition-colors">
                              #{account.invoice_number}
                            </Link>
                          ) : '—'}
                        </td>
                        <td className="px-5 py-3 text-sm font-semibold text-success text-right tabular-nums">
                          +{formatCurrency(Number(p.amount_paid), p.currency as Currency)}
                        </td>
                        {isAllMode && (
                          <td className="px-5 py-3 text-sm text-right tabular-nums text-muted-foreground">
                            {p.currency === 'PHP' ? (
                              <span>¥ {jpyEquiv.toLocaleString()}</span>
                            ) : (
                              <span className="text-card-foreground font-medium">¥ {Number(p.amount_paid).toLocaleString()}</span>
                            )}
                          </td>
                        )}
                        <td className="px-5 py-3 text-sm text-muted-foreground capitalize">{p.payment_method || '—'}</td>
                        <td className="px-5 py-3 text-sm text-muted-foreground">{csrName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Forecast drilldown slide-over */}
      {selectedCard && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div className="flex-1 bg-black/60" onClick={() => setSelectedCard(null)} />
          {/* Panel */}
          <div className="w-full max-w-2xl bg-zinc-900 border-l border-zinc-700 flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700 flex-shrink-0">
              <div>
                <h2 className="text-base font-semibold text-zinc-100">
                  {selectedCard.label} — {drilldownRaw?.length ?? 0} accounts
                </h2>
                <p className="text-xs text-zinc-400 mt-0.5">Pending installments due this month</p>
              </div>
              <button
                onClick={() => setSelectedCard(null)}
                className="text-zinc-400 hover:text-zinc-100 transition-colors p-1 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Search */}
            <div className="px-5 py-3 border-b border-zinc-700 flex-shrink-0">
              <input
                value={drillSearch}
                onChange={e => setDrillSearch(e.target.value)}
                placeholder="Search invoice # or customer name…"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-primary/60"
              />
            </div>
            {/* Table */}
            <div className="flex-1 overflow-y-auto">
              {drilldownLoading ? (
                <div className="p-5 space-y-2">
                  {[...Array(10)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-zinc-800" />)}
                </div>
              ) : drilldownRows.length === 0 ? (
                <div className="p-12 text-center text-zinc-500 text-sm">No accounts found</div>
              ) : (
                <table className="w-full">
                  <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-700">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Invoice</th>
                      <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Customer</th>
                      <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Due</th>
                      <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Amount</th>
                      <th className="text-right px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">¥ Equiv</th>
                      <th className="text-left px-4 py-2.5 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drilldownRows.map((row: any) => {
                      const acct = row.layaway_accounts;
                      const amountDue = Math.max(0, Number(row.total_due_amount) - Number(row.paid_amount));
                      const jpyEq = Math.round(toJpy(amountDue, acct.currency as Currency));
                      const isOverdue = row.status === 'overdue' || (row.due_date < today && row.status !== 'paid');
                      const isPartial = row.status === 'partially_paid';
                      return (
                        <tr key={row.id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                          <td className="px-4 py-2.5">
                            <Link
                              to={`/accounts/${acct.id}`}
                              onClick={() => setSelectedCard(null)}
                              className="text-xs font-mono text-primary hover:underline"
                            >
                              #{acct.invoice_number}
                            </Link>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-zinc-300 max-w-[140px] truncate">
                            {acct.customers?.full_name || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-zinc-400">
                            {new Date(row.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-4 py-2.5 text-xs font-semibold tabular-nums text-right text-zinc-100">
                            {formatCurrency(amountDue, acct.currency as Currency)}
                          </td>
                          <td className="px-4 py-2.5 text-xs tabular-nums text-right text-zinc-400">
                            ¥{jpyEq.toLocaleString()}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge
                              variant="outline"
                              className={`text-[9px] h-4 px-1.5 bg-zinc-900 ${
                                isOverdue
                                  ? 'text-destructive border-destructive/40'
                                  : isPartial
                                  ? 'text-warning border-warning/40'
                                  : 'text-zinc-400 border-zinc-600'
                              }`}
                            >
                              {isOverdue ? 'Overdue' : isPartial ? 'Partial' : 'Pending'}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {/* Footer count */}
            {!drilldownLoading && drillSearch && (
              <div className="px-5 py-2 border-t border-zinc-700 text-xs text-zinc-500 flex-shrink-0">
                Showing {drilldownRows.length} of {drilldownRaw?.length ?? 0} accounts
              </div>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}
