import { useState, useMemo } from 'react';
import { Activity, TrendingUp, Banknote, CalendarClock, AlertTriangle } from 'lucide-react';
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
      // Next 6 full calendar months (starts 1st of next month)
      const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const end   = new Date(now.getFullYear(), now.getMonth() + 7, 0); // day 0 = last of 6th month
      const startStr = start.toISOString().split('T')[0];
      const endStr   = end.toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('id, account_id, due_date, total_due_amount, paid_amount, status, layaway_accounts!inner(status, currency, invoice_number)')
        .in('layaway_accounts.status', [...ACTIVE_STATUSES])
        .gte('due_date', startStr)
        .lte('due_date', endStr)
        .in('status', ['pending', 'partially_paid', 'overdue']);
      if (error) throw error;
      // Exclude TEST-% accounts client-side
      return (data || []).filter(
        item => !((item as any).layaway_accounts?.invoice_number?.startsWith('TEST-'))
      );
    },
  });

  // Total receivables per currency for cross-check
  const { data: receivablesByCurrency } = useQuery({
    queryKey: ['receivables-by-currency'],
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_accounts')
        .select('currency, remaining_balance, invoice_number')
        .in('status', [...ACTIVE_STATUSES]);
      if (error) throw error;
      let php = 0, jpy = 0;
      (data || []).forEach(a => {
        if (a.invoice_number?.startsWith('TEST-')) return;
        if (a.currency === 'PHP') php += Number(a.remaining_balance);
        else if (a.currency === 'JPY') jpy += Number(a.remaining_balance);
      });
      return { php, jpy };
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

  // Aggregate forecast by month × currency
  const forecastRows = useMemo(() => {
    if (!forecastSchedule) return [];

    const agg: Record<string, { php: number; phpCount: number; jpy: number; jpyCount: number }> = {};
    forecastMonths.forEach(m => { agg[m.key] = { php: 0, phpCount: 0, jpy: 0, jpyCount: 0 }; });

    forecastSchedule.forEach(item => {
      const monthKey = item.due_date.substring(0, 7);
      if (!agg[monthKey]) return;
      const remaining = Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
      if (remaining <= 0) return;
      const cur = (item as any).layaway_accounts?.currency;
      if (cur === 'PHP') { agg[monthKey].php += remaining; agg[monthKey].phpCount++; }
      else if (cur === 'JPY') { agg[monthKey].jpy += remaining; agg[monthKey].jpyCount++; }
    });

    type ForecastRow = { monthKey: string; label: string; daysAway: number; amount: number; count: number; currency: 'PHP' | 'JPY' };
    const rows: ForecastRow[] = [];
    forecastMonths.forEach(m => {
      const d = agg[m.key];
      if (isAllMode || currencyFilter === 'PHP') {
        if (d.php > 0) rows.push({ monthKey: m.key, label: m.label, daysAway: m.daysAway, amount: d.php, count: d.phpCount, currency: 'PHP' });
      }
      if (isAllMode || currencyFilter === 'JPY') {
        if (d.jpy > 0) rows.push({ monthKey: m.key, label: m.label, daysAway: m.daysAway, amount: d.jpy, count: d.jpyCount, currency: 'JPY' });
      }
    });
    return rows;
  }, [forecastSchedule, forecastMonths, currencyFilter, isAllMode]);

  // 6-month totals per currency
  const forecastTotals = useMemo(() => {
    let php = 0, jpy = 0;
    forecastRows.forEach(r => { if (r.currency === 'PHP') php += r.amount; else jpy += r.amount; });
    return { php, jpy };
  }, [forecastRows]);

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
              Upcoming Receivables Forecast
            </h3>
            <span className="text-xs text-muted-foreground">Next 6 months · based on payment schedules</span>
          </div>

          {forecastLoading ? (
            <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : forecastRows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No scheduled receivables in the next 6 months</p>
          ) : (
            <>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Month</th>
                    <th className="text-right pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Scheduled</th>
                    <th className="text-right pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Accounts</th>
                    <th className="text-right pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Currency</th>
                  </tr>
                </thead>
                <tbody>
                  {forecastRows.map(row => (
                    <tr key={`${row.monthKey}-${row.currency}`} className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="py-2.5">
                        <span className="font-medium text-sm text-foreground">{row.label}</span>
                        {row.daysAway <= 35 && (
                          <span className="ml-2 text-[10px] text-muted-foreground">Due in {row.daysAway}d</span>
                        )}
                      </td>
                      <td className="py-2.5 text-right font-semibold tabular-nums text-sm text-foreground">
                        {formatCurrency(Math.round(row.amount), row.currency)}
                      </td>
                      <td className="py-2.5 text-right text-sm text-muted-foreground tabular-nums">{row.count}</td>
                      <td className="py-2.5 text-right">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded tracking-wide ${
                          row.currency === 'PHP'
                            ? 'bg-blue-500/10 text-blue-400'
                            : 'bg-orange-500/10 text-orange-400'
                        }`}>
                          {row.currency}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Cross-check vs total receivables */}
              {receivablesByCurrency && (
                <div className="mt-4 pt-4 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {(isAllMode || currencyFilter === 'PHP') && receivablesByCurrency.php > 0 && (
                    <div className="text-sm">
                      <p className="text-xs text-muted-foreground mb-0.5">6-Month PHP Forecast</p>
                      <p className="font-bold text-foreground">{formatCurrency(Math.round(forecastTotals.php), 'PHP')}</p>
                      <p className="text-xs text-muted-foreground">
                        vs {formatCurrency(Math.round(receivablesByCurrency.php), 'PHP')} total receivables
                        {' '}({Math.round(forecastTotals.php / receivablesByCurrency.php * 100)}%)
                      </p>
                      {receivablesByCurrency.php > 0 && forecastTotals.php / receivablesByCurrency.php < 0.8 && (
                        <p className="text-xs text-warning flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="h-3 w-3" />
                          {Math.round((1 - forecastTotals.php / receivablesByCurrency.php) * 100)}% of PHP balance falls outside 6-month window
                        </p>
                      )}
                    </div>
                  )}
                  {(isAllMode || currencyFilter === 'JPY') && receivablesByCurrency.jpy > 0 && (
                    <div className="text-sm">
                      <p className="text-xs text-muted-foreground mb-0.5">6-Month JPY Forecast</p>
                      <p className="font-bold text-foreground">{formatCurrency(Math.round(forecastTotals.jpy), 'JPY')}</p>
                      <p className="text-xs text-muted-foreground">
                        vs {formatCurrency(Math.round(receivablesByCurrency.jpy), 'JPY')} total receivables
                        {' '}({Math.round(forecastTotals.jpy / receivablesByCurrency.jpy * 100)}%)
                      </p>
                      {receivablesByCurrency.jpy > 0 && forecastTotals.jpy / receivablesByCurrency.jpy < 0.8 && (
                        <p className="text-xs text-warning flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="h-3 w-3" />
                          {Math.round((1 - forecastTotals.jpy / receivablesByCurrency.jpy) * 100)}% of JPY balance falls outside 6-month window
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
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

export default function Collections() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);
  const { session, loading: authLoading } = useAuth();

  const { data: summary } = useDashboardSummary(currencyFilter, Boolean(session) && !authLoading);
  const { data: allPayments, isLoading: payLoading } = usePayments();
  const { data: accounts } = useAccounts();

  // Fetch upcoming receivables (schedule milestones)
  const { data: upcomingSchedule } = useQuery({
    queryKey: ['collections-upcoming-schedule', currencyFilter],
    queryFn: async () => {
      const today = todayStr();
      const in90 = daysFromNow(90);
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(status, currency, invoice_number, customer_id, customers(full_name))')
        .in('layaway_accounts.status', ['active', 'overdue'])
        .gte('due_date', today)
        .lte('due_date', in90)
        .in('status', ['pending', 'partially_paid'])
        .order('due_date', { ascending: true });
      if (error) throw error;
      return data;
    },
  });

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

  // Receivables milestones
  const milestones = useMemo(() => {
    if (!upcomingSchedule) return [];
    const grouped: Record<string, { label: string; amount: number; count: number }> = {};

    upcomingSchedule.forEach(item => {
      const dueDate = new Date(item.due_date);
      const monthKey = dueDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
      const remaining = Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
      if (remaining <= 0) return;
      const acctCurrency = (item as any).layaway_accounts?.currency as Currency;
      if (!isAllMode && acctCurrency !== currencyFilter) return;

      let amount = remaining;
      if (isAllMode && acctCurrency === 'PHP') amount = toJpy(amount, 'PHP');

      if (!grouped[monthKey]) grouped[monthKey] = { label: monthKey, amount: 0, count: 0 };
      grouped[monthKey].amount += amount;
      grouped[monthKey].count++;
    });

    return Object.values(grouped);
  }, [upcomingSchedule, currencyFilter, isAllMode]);

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

        {/* Receivables Milestones */}
        {milestones.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-3 flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              Upcoming Receivables
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {milestones.map(m => (
                <div key={m.label} className="rounded-lg border border-border bg-muted/30 p-3 text-center">
                  <p className="text-xs text-muted-foreground">{m.label}</p>
                  <p className="text-sm font-bold text-card-foreground tabular-nums mt-1">
                    {formatCurrency(Math.round(m.amount), displayCurrency)}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{m.count} installments</p>
                </div>
              ))}
            </div>
          </div>
        )}

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
