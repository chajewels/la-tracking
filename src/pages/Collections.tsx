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
import { computeCollectionStats, daysFromNow, todayStr } from '@/lib/business-rules';

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
