import { useState, useMemo } from 'react';
import { addMonths, endOfMonth, format, startOfMonth } from 'date-fns';
import { Activity, TrendingUp, Banknote, CalendarClock } from 'lucide-react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { formatCurrency } from '@/lib/calculations';
import { toJpy, getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { Currency } from '@/lib/types';
import { useAccounts, usePayments, useDashboardSummary } from '@/hooks/use-supabase-data';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { computeCollectionStats, todayStr } from '@/lib/business-rules';


export default function Collections() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);
  const { session, loading: authLoading } = useAuth();

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
      // Shape: { month: '2026-04-01', currency: 'PHP'|'JPY', installments: N, remaining: N }
      return (data || []) as { month: string; currency: string; installments: number; remaining: number }[];
    },
  });

  // Keyed on today so month slots recalculate on rollover
  const today = format(new Date(), 'yyyy-MM-dd');

  // Aggregate RPC rows by month — PHP converted to JPY, sum with JPY rows.
  // Generates up to 7 candidate months (current + 6 forward), then filters
  // to only months that have actual pending installments from the RPC.
  const forecastCards = useMemo(() => {
    if (!forecastSchedule) return null;

    // Build lookup: monthKey → { jpy, count }
    const agg: Record<string, { jpy: number; count: number }> = {};
    forecastSchedule.forEach(row => {
      const monthKey = row.month.substring(0, 7);
      if (!agg[monthKey]) agg[monthKey] = { jpy: 0, count: 0 };
      agg[monthKey].jpy += toJpy(Number(row.remaining), row.currency as Currency);
      agg[monthKey].count += Number(row.installments);
    });

    const now = new Date();
    // Candidate slots: current month + next 6 (7 total)
    return Array.from({ length: 7 }, (_, i) => {
      const d = startOfMonth(addMonths(now, i));
      const key = format(d, 'yyyy-MM');
      const label = format(endOfMonth(d), 'MMM d');
      const daysAway = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
      return { key, label, daysAway, ...agg[key] ?? { jpy: 0, count: 0 } };
    })
    // Only keep months with actual pending installments
    .filter(m => m.count > 0)
    .map(m => ({ ...m, jpy: Math.round(m.jpy) }));
  }, [forecastSchedule, today]);

  // Build account map for payment feed
  const accountMap = useMemo(() => {
    if (!accounts) return new Map();
    return new Map(accounts.map(a => [a.id, a]));
  }, [accounts]);

  // Filter payments
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

  // Compute stats using centralized logic
  const stats = useMemo(() => {
    const normalized = filtered.map(p => ({
      date_paid: p.date_paid,
      amount: isAllMode ? toJpy(Number(p.amount_paid), p.currency as Currency) : Number(p.amount_paid),
    }));
    return computeCollectionStats(normalized);
  }, [filtered, isAllMode]);

  // Fetch profiles for CSR name lookup
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
            <span className="text-xs text-muted-foreground">Next 6 months</span>
          </div>

          {forecastLoading || !forecastCards ? (
            <div className="flex gap-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="flex-1 h-24 rounded-lg" />)}
            </div>
          ) : (
            <div className="flex gap-3">
              {forecastCards.map((card, i) => (
                <div key={card.key} className="flex-1 rounded-lg border border-border bg-muted/30 p-3">
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
    </AppLayout>
  );
}
