import { useState, useMemo } from 'react';
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

const ACTIVE_STATUSES = ['active', 'overdue', 'final_settlement', 'extension_active'] as const;

export default function Collections() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);
  const { session, loading: authLoading } = useAuth();

  const { data: summary } = useDashboardSummary(currencyFilter, Boolean(session) && !authLoading);
  const { data: allPayments, isLoading: payLoading } = usePayments();
  const { data: accounts } = useAccounts();

  // ── 6-month receivables forecast ──
  const { data: forecastSchedule, isLoading: forecastLoading } = useQuery({
    queryKey: ['collections-forecast-6m'],
    staleTime: 0,
    queryFn: async () => {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() + 7, 0);
      const startStr = start.toISOString().split('T')[0];
      const endStr   = end.toISOString().split('T')[0];

      // Step 1: get valid account IDs + currency (PostgREST can't filter on joined columns)
      const { data: activeAccounts, error: acctErr } = await supabase
        .from('layaway_accounts')
        .select('id, currency')
        .in('status', [...ACTIVE_STATUSES])
        .not('invoice_number', 'like', 'TEST-%');
      if (acctErr) { console.error('[forecast] Step 1 error:', acctErr); throw acctErr; }

      const validIds = (activeAccounts || []).map(a => a.id);
      const currencyById = new Map((activeAccounts || []).map(a => [a.id, a.currency]));
      console.log('[forecast] Step 1 validAccounts:', activeAccounts?.length, 'validIds:', validIds.length);

      if (validIds.length === 0) { console.warn('[forecast] No active accounts found'); return []; }
      if (validIds.length > 100) console.warn('[forecast] validIds.length =', validIds.length, '— may exceed PostgREST IN limit');

      // Step 2: fetch schedule rows for those accounts in the 6-month window
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('id, account_id, due_date, total_due_amount, paid_amount, status')
        .in('account_id', validIds)
        .gte('due_date', startStr)
        .lte('due_date', endStr)
        .in('status', ['pending', 'partially_paid', 'overdue']);
      if (error) { console.error('[forecast] Step 2 error:', error); throw error; }
      console.log('[forecast] Step 2 rows:', data?.length, 'first:', data?.[0]);

      // Attach currency from the accounts map
      return (data || []).map(item => ({ ...item, currency: currencyById.get(item.account_id) ?? 'JPY' }));
    },
  });

  // Build ordered month slots for the forecast window
  const forecastMonths = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() + 1 + i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      const daysAway = Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
      return { key, label, daysAway };
    });
  }, []);

  // Log forecastLoading on every render to catch stuck states
  console.log('[forecast] render — forecastLoading:', forecastLoading, 'forecastSchedule:', forecastSchedule?.length ?? 'undefined');

  // One card per month — all amounts in JPY (PHP converted via live rate)
  const forecastCards = useMemo(() => {
    console.log('[forecast] memo — forecastSchedule length:', forecastSchedule?.length ?? 'undefined');
    if (!forecastSchedule) return null;

    const agg: Record<string, { jpy: number; count: number }> = {};
    forecastMonths.forEach(m => { agg[m.key] = { jpy: 0, count: 0 }; });

    forecastSchedule.forEach(item => {
      const monthKey = item.due_date.substring(0, 7);
      if (!agg[monthKey]) return;
      const remaining = Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
      if (remaining <= 0) return;
      const cur = (item as any).currency as Currency;
      agg[monthKey].jpy += toJpy(remaining, cur);
      agg[monthKey].count++;
    });

    return forecastMonths.map(m => ({
      ...m,
      jpy: Math.round(agg[m.key].jpy),
      count: agg[m.key].count,
    }));
  }, [forecastSchedule, forecastMonths]);

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
            <div className="flex gap-3 overflow-x-auto pb-1">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="flex-none w-36 h-24 rounded-lg" />)}
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {forecastCards.map((card, i) => (
                <div key={card.key} className="flex-none w-36 rounded-lg border border-border bg-muted/30 p-3">
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
