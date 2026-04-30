import { useState, useEffect, useMemo, memo } from 'react';
import { addMonths, endOfMonth, format, startOfMonth } from 'date-fns';
import { DollarSign, TrendingUp, BarChart3, Sparkles, CalendarClock, Trophy, Clock, AlertTriangle, ShieldAlert, Crown, UserCheck, Target, Users, Activity, Banknote, X, ShoppingBag } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import MonthlyAnalyticsChart from '@/components/MonthlyAnalyticsChart';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import RiskBadge from '@/components/dashboard/RiskBadge';
import CLVBadge from '@/components/dashboard/CLVBadge';
import CompletionBadge from '@/components/dashboard/CompletionBadge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { useAccounts, useCustomers, usePayments, useDashboardSummary } from '@/hooks/use-supabase-data';
import { toJpy } from '@/lib/currency-converter';
import { computeCollectionStats, todayStr } from '@/lib/business-rules';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';

import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Link } from 'react-router-dom';
import PaymentsHub from './PaymentsHub';
import PaymentVault from './PaymentVault';

const MemoPaymentsHub = memo(PaymentsHub);
const MemoPaymentVault = memo(PaymentVault);
import {
  assessRisk, predictCompletion, assessCLV, riskStyles,
} from '@/lib/business-rules';

export default function Finance() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const [tab, setTab] = useState<'overview' | 'analytics' | 'collections' | 'docs' | 'vault'>('overview');
  const { session, loading: authLoading } = useAuth();
  const { can } = usePermissions();
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const showAnalytics = can('view_analytics');
  const showCollections = can('view_collections');
  const showDocs = can('view_submissions');
  const showVault = can('admin_settings');
  const visibleTabCount = 1 + (showAnalytics ? 1 : 0) + (showCollections ? 1 : 0) + (showDocs ? 1 : 0) + (showVault ? 1 : 0);

  useEffect(() => {
    if (tab === 'analytics' && !showAnalytics) setTab('overview');
    if (tab === 'collections' && !showCollections) setTab('overview');
    if (tab === 'docs' && !showDocs) setTab('overview');
    if (tab === 'vault' && !showVault) setTab('overview');
  }, [tab, showAnalytics, showCollections, showDocs, showVault]);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );
  const { data: accounts } = useAccounts();
  const { data: customers } = useCustomers();
  const { data: allPayments } = usePayments();
  useAutoRefresh([
    ['accounts'],
    ['customers'],
    ['dashboard-summary'],
    ['collections-forecast-6m'],
  ]);

  // ── Collections tab state ──
  const [selectedCard, setSelectedCard] = useState<{ key: string; label: string; count: number } | null>(null);
  const [drillSearch, setDrillSearch] = useState('');

  const { data: forecastSchedule, isLoading: forecastLoading } = useQuery({
    queryKey: ['collections-forecast-6m', format(new Date(), 'yyyy-MM-dd')],
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_forecast_6m');
      if (error) throw error;
      return (data || []) as { month: string; currency: string; installments: number; remaining: number }[];
    },
    enabled: !!session,
  });

  const { data: drilldownRaw, isLoading: drilldownLoading } = useQuery({
    queryKey: ['forecast-drilldown', selectedCard?.key],
    enabled: !!selectedCard,
    queryFn: async () => {
      if (!selectedCard) return [];
      const { data, error } = await (supabase as any).rpc('get_forecast_drilldown', {
        p_month: selectedCard.key,
      });
      if (error) throw error;
      return data || [];
    },
  });

  const drilldownRows = useMemo(() => {
    if (!drilldownRaw) return [];
    const q = drillSearch.toLowerCase().trim();
    if (!q) return drilldownRaw;
    return drilldownRaw.filter((row: any) => {
      const inv = String(row.invoice_number ?? '').toLowerCase();
      const name = String(row.customer_name ?? '').toLowerCase();
      return inv.includes(q) || name.includes(q);
    });
  }, [drilldownRaw, drillSearch]);

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
    }).map(m => ({ ...m, jpy: Math.round(m.jpy) }));
  }, [forecastSchedule]);

  const accountMap = useMemo(() => {
    if (!accounts) return new Map();
    return new Map(accounts.map(a => [a.id, a]));
  }, [accounts]);

  const collFiltered = useMemo(() => {
    if (!allPayments) return [];
    return allPayments
      .filter(p => !p.voided_at)
      .filter(p => isAllMode || p.currency === currencyFilter)
      .sort((a, b) => new Date(b.date_paid).getTime() - new Date(a.date_paid).getTime() || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [allPayments, currencyFilter, isAllMode]);

  const collStats = useMemo(() => {
    const normalized = collFiltered.map(p => ({
      date_paid: p.date_paid,
      amount: isAllMode ? toJpy(Number(p.amount_paid), p.currency as Currency) : Number(p.amount_paid),
    }));
    return computeCollectionStats(normalized);
  }, [collFiltered, isAllMode]);

  const { data: collProfiles } = useQuery({
    queryKey: ['profiles-lookup'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('user_id, full_name');
      if (error) throw error;
      return new Map((data || []).map((p: any) => [p.user_id, p.full_name]));
    },
  });

  const collToday = format(new Date(), 'yyyy-MM-dd');

  const forecastData = summary?.forecast_6_months || [];
  const maxForecast = Math.max(...forecastData.map(d => d.expected), 1);

  const recentCompleted = useMemo(() => {
    if (!accounts) return [];
    const now = new Date();
    return accounts
      .filter(a => a.status === 'completed')
      .filter(a => {
        const updated = new Date(a.updated_at);
        return updated.getMonth() === now.getMonth() && updated.getFullYear() === now.getFullYear();
      })
      .slice(0, 5);
  }, [accounts]);

  const { data: monthlySalesData } = useQuery({
    queryKey: ['monthly-sales', currencyFilter],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .rpc('get_monthly_sales', {
          currency_mode: currencyFilter,
          months_back: 12,
        });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as Array<{
        month: string;
        new_sales_count: number;
        total_sales_value: number;
      }>;
    },
    enabled: tab === 'overview' && !!session,
  });

  const thisMonthSales = useMemo(() => {
    if (!monthlySalesData?.length) return { count: 0, total: 0, change: 0, lastMonthCount: 0 };
    const now = new Date();
    const thisMonthLabel = now.toLocaleString('en-US', { month: 'short' }) + ' ' + now.getFullYear();
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1);
    const lastMonthLabel = lastMonthDate.toLocaleString('en-US', { month: 'short' }) + ' ' + lastMonthDate.getFullYear();
    const thisMonth = monthlySalesData.find(d => d.month === thisMonthLabel);
    const lastMonth = monthlySalesData.find(d => d.month === lastMonthLabel);
    const total = thisMonth?.total_sales_value ?? 0;
    const lastTotal = lastMonth?.total_sales_value ?? 0;
    const change = lastTotal > 0
      ? Math.round(((total - lastTotal) / lastTotal) * 100)
      : 0;
    return {
      count: thisMonth?.new_sales_count ?? 0,
      total,
      change,
      lastMonthCount: lastMonth?.new_sales_count ?? 0,
    };
  }, [monthlySalesData]);

  // ── Analytics tab queries ──
  const { data: collectionAnalytics, isLoading: analyticsLoading } = useQuery({
    queryKey: ['collection-analytics', currencyFilter],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_collection_analytics', {
        currency_mode: currencyFilter,
        months_back: 6,
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as Array<{
        month: string;
        collected: number;
        expected: number;
        collection_rate: number;
        forfeited: number;
        penalties_collected: number;
      }>;
    },
    enabled: tab === 'analytics' && !!session,
  });

  const { data: staffPerformance, isLoading: staffLoading } = useQuery({
    queryKey: ['staff-performance'],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_staff_performance', { months_back: 1 });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as Array<{
        staff_email: string;
        payments_confirmed: number;
        avg_confirmation_hours: number | null;
      }>;
    },
    enabled: tab === 'analytics' && !!session,
  });

  const { data: topOutstandingCustomers, isLoading: topCustomersLoading } = useQuery({
    queryKey: ['top-outstanding-customers'],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_top_outstanding_customers');
      if (error) throw error;
      return (data?.[0]?.get_top_outstanding_customers ?? data ?? []) as Array<{
        full_name: string;
        account_count: number;
        total_paid_jpy: number;
        early_payment_rate: number;
        penalty_count: number;
        score: number;
      }>;
    },
    enabled: tab === 'analytics' && !!session,
  });

  // Derived analytics stats
  const bestMonth = useMemo(() => {
    if (!collectionAnalytics?.length) return null;
    return collectionAnalytics.reduce((best, m) => m.collection_rate > best.collection_rate ? m : best);
  }, [collectionAnalytics]);
  const avgRate = useMemo(() => {
    if (!collectionAnalytics?.length) return 0;
    return Math.round(collectionAnalytics.reduce((s, m) => s + m.collection_rate, 0) / collectionAnalytics.length);
  }, [collectionAnalytics]);
  const totalPenalties = useMemo(() => {
    if (!collectionAnalytics?.length) return 0;
    return collectionAnalytics.reduce((s, m) => s + m.penalties_collected, 0);
  }, [collectionAnalytics]);
  const totalForfeitedCollected = useMemo(() => {
    if (!accounts?.length) return 0;
    return accounts
      .filter((a: any) => a.status === 'forfeited' || a.status === 'final_forfeited')
      .reduce((sum: number, a: any) => {
        const collected = Number(a.total_paid ?? 0);
        return sum + (isAllMode ? toJpy(collected, a.currency as Currency) : collected);
      }, 0);
  }, [accounts, isAllMode]);

  // ── Intelligence section data (from former Analytics.tsx) ──
  const currency = currencyFilter === 'ALL' ? undefined : currencyFilter;

  const { data: allSchedules } = useQuery({
    queryKey: ['all-schedules-analytics'],
    queryFn: async () => {
      const allItems: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('layaway_schedule')
          .select('*')
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allItems.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      return allItems;
    },
    enabled: tab === 'analytics' && !!session,
  });

  const { data: profilesWithRoles } = useQuery({
    queryKey: ['csr-profiles'],
    queryFn: async () => {
      const { data: profiles, error: pErr } = await supabase.from('profiles').select('*');
      if (pErr) throw pErr;
      const { data: roles, error: rErr } = await supabase.from('user_roles').select('*');
      if (rErr) throw rErr;
      return (profiles || []).map((p: any) => ({
        ...p,
        role: (roles || []).find((r: any) => r.user_id === p.user_id)?.role || 'staff',
      }));
    },
    enabled: tab === 'analytics' && !!session,
  });

  const activeAccounts = useMemo(() =>
    (accounts || []).filter(a => (['active', 'overdue', 'final_settlement', 'extension_active'].includes(a.status)) && (!currency || a.currency === currency)),
    [accounts, currency]
  );

  const risks = useMemo(() =>
    activeAccounts.map(a => {
      const acctSchedules = (allSchedules || []).filter((s: any) => s.account_id === a.id);
      return {
        accountId: a.id,
        customerName: a.customers?.full_name || 'Unknown',
        invoiceNumber: a.invoice_number,
        currency: a.currency as Currency,
        ...assessRisk(acctSchedules),
      };
    }).sort((x, y) => y.score - x.score),
    [activeAccounts, allSchedules]
  );

  const clvs = useMemo(() =>
    (customers || []).map((c: any) => {
      const custAccounts = (accounts || []).filter(a => a.customer_id === c.id);
      return { customerId: c.id, customerName: c.full_name, ...assessCLV(custAccounts) };
    }).sort((x: any, y: any) => y.score - x.score),
    [customers, accounts]
  );

  const completions = useMemo(() =>
    activeAccounts.map(a => {
      const acctSchedules = (allSchedules || []).filter((s: any) => s.account_id === a.id);
      const risk = assessRisk(acctSchedules);
      const pred = predictCompletion(Number(a.total_paid), Number(a.total_amount), risk.score);
      return { accountId: a.id, customerName: a.customers?.full_name || 'Unknown', invoiceNumber: a.invoice_number, ...pred };
    }).sort((x, y) => x.score - y.score),
    [activeAccounts, allSchedules]
  );

  const { data: submissionsReviewed } = useQuery({
    queryKey: ['submissions-reviewed-counts'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('reviewer_user_id')
        .eq('status', 'confirmed')
        .not('reviewer_user_id', 'is', null);
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const row of (data || [])) {
        const uid = (row as any).reviewer_user_id as string;
        counts.set(uid, (counts.get(uid) || 0) + 1);
      }
      return counts;
    },
    enabled: tab === 'analytics' && !!session,
  });

  const { data: allSubmissions } = useQuery({
    queryKey: ['submissions-by-account'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payment_submissions')
        .select('account_id');
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const row of (data || [])) {
        const aid = (row as any).account_id as string;
        if (aid) counts.set(aid, (counts.get(aid) || 0) + 1);
      }
      return counts;
    },
    enabled: tab === 'analytics' && !!session,
  });

  const csrPerformance = useMemo(() => {
    const staff = profilesWithRoles || [];
    const payments = (allPayments || []).filter((p: any) => !p.voided_at);
    const accts = accounts || [];
    return staff.map((s: any) => {
      const userPayments = payments.filter((p: any) => p.entered_by_user_id === s.user_id);
      const totalCollected = userPayments.reduce((sum: number, p: any) => sum + Number(p.amount_paid), 0);
      const accountIds = new Set(userPayments.map((p: any) => p.account_id));
      const createdAccounts = accts.filter(a => a.created_by_user_id === s.user_id);
      const overdueAccountIds = new Set(
        (allSchedules || [])
          .filter((sc: any) => sc.due_date < todayStr() && ['pending', 'partially_paid'].includes(sc.status))
          .map((sc: any) => sc.account_id)
      );
      const recoveries = userPayments.filter((p: any) => overdueAccountIds.has(p.account_id)).length;
      const reviewedCount = submissionsReviewed?.get(s.user_id) || 0;
      const handledAccountIds = new Set([...accountIds, ...createdAccounts.map(a => a.id)]);
      let submissionsHandled = 0;
      if (allSubmissions) {
        for (const aid of handledAccountIds) {
          submissionsHandled += allSubmissions.get(aid) || 0;
        }
      }
      return { userId: s.user_id, name: s.full_name, role: s.role, totalCollected, paymentCount: userPayments.length, accountsHandled: accountIds.size, accountsCreated: createdAccounts.length, recoveries, reviewedCount, submissionsHandled };
    }).sort((x: any, y: any) => y.totalCollected - x.totalCollected);
  }, [profilesWithRoles, allPayments, accounts, allSchedules, submissionsReviewed, allSubmissions]);

  const highRisk = risks.filter(r => r.riskLevel === 'high').length;
  const avgCompletion = completions.length > 0
    ? Math.round(completions.reduce((s, c) => s + c.score, 0) / completions.length) : 0;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <DollarSign className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Finance Dashboard</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Receivables and cashflow intelligence · Live data</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        <Tabs value={tab} onValueChange={v => setTab(v as 'overview' | 'analytics' | 'collections' | 'docs' | 'vault')} className="w-full">
          <TabsList className={`grid w-full max-w-xl`} style={{ gridTemplateColumns: `repeat(${visibleTabCount}, minmax(0, 1fr))` }}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {showAnalytics && <TabsTrigger value="analytics">Analytics</TabsTrigger>}
            {showCollections && <TabsTrigger value="collections">Collections</TabsTrigger>}
            {showDocs && <TabsTrigger value="docs">Documentation</TabsTrigger>}
            {showVault && <TabsTrigger value="vault">Vault</TabsTrigger>}
          </TabsList>

          {/* ═══════ Overview Tab ═══════ */}
          <TabsContent value="overview" className="mt-5 space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
              {summaryLoading ? (
                [...Array(6)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
              ) : (
                <>
                  <StatCard title="Total Receivables" value={formatCurrency(summary?.total_receivables ?? 0, displayCurrency)} icon={DollarSign} variant="gold" />
                  <StatCard title="Expected Next Month" value={formatCurrency(summary?.next_month_adjusted ?? 0, displayCurrency)} subtitle={`of ${formatCurrency(summary?.next_month_expected ?? 0, displayCurrency)} due`} icon={Sparkles} variant="gold" />
                  <StatCard title="Predicted (30d)" value={formatCurrency(summary?.predicted_30d ?? 0, displayCurrency)} subtitle={`of ${formatCurrency(summary?.predicted_30d_raw ?? 0, displayCurrency)} due`} icon={TrendingUp} variant="success" />
                  <StatCard title="Predicted (90d)" value={formatCurrency(summary?.predicted_90d ?? 0, displayCurrency)} subtitle={`of ${formatCurrency(summary?.predicted_90d_raw ?? 0, displayCurrency)} due`} icon={TrendingUp} />
                  <StatCard title="Collections This Month" value={formatCurrency(summary?.collections_this_month ?? 0, displayCurrency)} icon={BarChart3} variant="success" />
                  <StatCard
                    title="Cash Revenue Today (JPY)"
                    value={`¥ ${Math.round(summary?.cash_revenue_today_jpy ?? 0).toLocaleString()}`}
                    icon={Banknote}
                    variant="success"
                  />
                  <StatCard
                    title="Total Overdue"
                    value={(summary?.overdue_accounts ?? 0).toString()}
                    subtitle={formatCurrency(summary?.overdue_amount ?? 0, displayCurrency)}
                    icon={AlertTriangle}
                    variant="danger"
                  />
                  <StatCard
                    title="New Layaway Sales"
                    value={formatCurrency(thisMonthSales.total, displayCurrency)}
                    subtitle={`${thisMonthSales.count} new accounts · vs ${thisMonthSales.lastMonthCount} last month`}
                    icon={ShoppingBag}
                    variant="gold"
                    trend={thisMonthSales.change !== 0 ? { value: `${Math.abs(thisMonthSales.change)}% vs last month`, positive: thisMonthSales.change > 0 } : undefined}
                  />
                </>
              )}
            </div>

            {/* Cash Orders row — always JPY regardless of displayCurrency */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {summaryLoading ? (
                [...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
              ) : (
                <>
                  <StatCard
                    title="Total Cash Sales (JPY)"
                    value={formatCurrency(summary?.cash_revenue_total_jpy ?? 0, 'JPY')}
                    subtitle={`${formatCurrency(summary?.cash_revenue_month_jpy ?? 0, 'JPY')} this month`}
                    icon={Banknote}
                    variant="gold"
                  />
                  <StatCard
                    title="Cash Conversion Rate"
                    value={`${(summary?.cash_conversion_rate?.this_month ?? 0).toFixed(1)}%`}
                    subtitle={`${(summary?.cash_conversion_rate?.all_time ?? 0).toFixed(1)}% all-time`}
                    icon={Activity}
                  />
                  <CashVsLayawaySplitCard
                    cashJpy={summary?.cash_vs_layaway_split?.this_month?.cash_revenue_jpy ?? 0}
                    layawayJpy={summary?.cash_vs_layaway_split?.this_month?.layaway_revenue_jpy ?? 0}
                    cashPct={summary?.cash_vs_layaway_split?.this_month?.cash_percentage ?? 0}
                  />
                </>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <AgingBuckets currency={displayCurrency} />
              {/* 6-Month Forecast */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-primary" /> 6-Month Cashflow Forecast
                </h3>
                {summaryLoading || forecastData.length === 0 ? (
                  <div className="flex items-center justify-center h-40"><Skeleton className="h-full w-full rounded-lg" /></div>
                ) : (
                  <div className="space-y-3">
                    {forecastData.map(d => (
                      <div key={d.month} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">{d.month}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-muted-foreground tabular-nums">Adj: {formatCurrency(d.adjusted, displayCurrency)}</span>
                            <span className="font-medium text-card-foreground tabular-nums">{formatCurrency(d.expected, displayCurrency)}</span>
                          </div>
                        </div>
                        <div className="relative h-2.5 rounded-full bg-muted overflow-hidden">
                          <div className="absolute h-full bg-primary/20 rounded-full transition-all" style={{ width: `${(d.expected / maxForecast) * 100}%` }} />
                          <div className="absolute h-full gold-gradient rounded-full transition-all" style={{ width: `${(d.adjusted / maxForecast) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border">
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><div className="h-2 w-2 rounded-full gold-gradient" /> Risk-Adjusted (85%)</div>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><div className="h-2 w-2 rounded-full bg-primary/20" /> Expected (due)</div>
                </div>
              </div>
            </div>

            <MonthlyAnalyticsChart monthlySalesData={monthlySalesData} />

            {recentCompleted.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-card-foreground mb-3">Completed This Month</h3>
                <div className="space-y-2">
                  {recentCompleted.map(a => (
                    <Link key={a.id} to={`/accounts/${a.id}`} className="flex items-center justify-between p-2.5 rounded-lg border border-border hover:border-primary/30 transition-colors">
                      <div>
                        <p className="text-xs font-medium text-card-foreground">INV #{a.invoice_number}</p>
                        <p className="text-[10px] text-muted-foreground">{a.customers?.full_name}</p>
                      </div>
                      <p className="text-xs font-semibold text-success tabular-nums">{formatCurrency(Number(a.total_amount), a.currency as Currency)}</p>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ═══════ Analytics Tab ═══════ */}
          <TabsContent value="analytics" className="mt-5 space-y-6" tabIndex={-1}>
          {showAnalytics ? (<>

            {/* Section 1 — Collection Performance */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-card-foreground">Collection Performance (Last 6 Months)</h3>
              {analyticsLoading ? (
                <div className="grid grid-cols-3 gap-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                    <StatCard title="Best Month" value={bestMonth ? `${bestMonth.collection_rate}%` : '—'} subtitle={bestMonth?.month} icon={Trophy} variant="gold" />
                    <StatCard title="Average Rate" value={`${avgRate}%`} icon={TrendingUp} variant="success" />
                    <StatCard title="Penalties Collected" value={formatCurrency(totalPenalties, displayCurrency)} icon={DollarSign} />
                    <StatCard title="Forfeited Collected" value={formatCurrency(totalForfeitedCollected, displayCurrency)} icon={ShieldAlert} />
                  </div>
                  {collectionAnalytics && collectionAnalytics.length > 0 && (
                    <div className="rounded-xl border border-border bg-card p-5">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Collected vs Expected</h4>
                      <ResponsiveContainer width="100%" height={280}>
                        <AreaChart data={collectionAnalytics} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="collectedGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#D4AF37" stopOpacity={0.5} />
                              <stop offset="95%" stopColor="#D4AF37" stopOpacity={0.05} />
                            </linearGradient>
                            <linearGradient id="expectedGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                          <Tooltip contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }} />
                          <Legend wrapperStyle={{ fontSize: 10 }} />
                          <Area type="monotone" dataKey="collected" name="Collected" stroke="#D4AF37" strokeWidth={2} fill="url(#collectedGradient)" />
                          <Area type="monotone" dataKey="expected" name="Expected" stroke="#f59e0b" strokeWidth={2} fill="url(#expectedGradient)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Section 2 — Collection Rate % + Forfeiture Trend (side by side) */}
            {collectionAnalytics && collectionAnalytics.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="rounded-xl border border-border bg-card p-5">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Collection Rate %</h4>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={collectionAnalytics} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                      <Tooltip contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }} />
                      <Line type="monotone" dataKey="collection_rate" name="Rate %" stroke="#D4AF37" strokeWidth={2} dot={{ r: 4, fill: '#D4AF37' }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {collectionAnalytics.some(m => m.forfeited > 0) && (
                  <div className="rounded-xl border border-border bg-card p-5">
                    <h3 className="text-sm font-semibold text-card-foreground mb-3 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-destructive" /> Forfeitures per Month
                    </h3>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={collectionAnalytics} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                        <Tooltip contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }} />
                        <Bar dataKey="forfeited" name="Forfeitures" fill="#dc2626" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}

            {/* Section 3 — Staff Performance */}
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-card-foreground mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" /> Staff Performance (This Month)
              </h3>
              {staffLoading ? (
                <Skeleton className="h-32 w-full rounded-lg" />
              ) : !staffPerformance || staffPerformance.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No staff activity this month.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border">
                        <th className="py-2 pr-3">Staff</th>
                        <th className="py-2 pr-3 text-right">Payments Confirmed</th>
                        <th className="py-2 text-right">Avg Confirmation Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staffPerformance
                        .sort((a, b) => b.payments_confirmed - a.payments_confirmed)
                        .map((s, i) => (
                          <tr key={i} className="border-b border-border/50">
                            <td className="py-2 pr-3 font-medium text-foreground">{s.staff_email.split('@')[0]}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{s.payments_confirmed}</td>
                            <td className="py-2 text-right tabular-nums text-muted-foreground">
                              {s.avg_confirmation_hours != null ? `${s.avg_confirmation_hours.toFixed(1)} hrs` : '—'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Section 4 — Top 10 Outstanding Customers */}
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-card-foreground">Top 10 Outstanding Customers</h3>
              <p className="text-xs text-muted-foreground mt-0.5 mb-3">Penalty-free · Multi-account · Early payers</p>
              {topCustomersLoading ? (
                <Skeleton className="h-32 w-full rounded-lg" />
              ) : !topOutstandingCustomers || topOutstandingCustomers.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No outstanding customers.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border">
                        <th className="py-2 pr-3">#</th>
                        <th className="py-2 pr-3">Customer</th>
                        <th className="py-2 pr-3 text-right">Accounts</th>
                        <th className="py-2 pr-3 text-right">Total Paid</th>
                        <th className="py-2 pr-3 text-right">Early Payment %</th>
                        <th className="py-2 pr-3 text-right">Penalties</th>
                        <th className="py-2 text-right">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topOutstandingCustomers.slice(0, 10).map((c, i) => (
                        <tr key={i} className="border-b border-border/50">
                          <td className="py-2 pr-3 font-semibold text-foreground">{i + 1}</td>
                          <td className="py-2 pr-3 text-foreground">{c.full_name}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{c.account_count}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">¥{Math.round(Number(c.total_paid_jpy)).toLocaleString()}</td>
                          <td className="py-2 pr-3 text-right tabular-nums">{Number(c.early_payment_rate).toFixed(1)}%</td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {Number(c.penalty_count) === 0 ? (
                              <span className="text-green-600 font-medium">None</span>
                            ) : (
                              <span className="text-destructive font-bold">{c.penalty_count}</span>
                            )}
                          </td>
                          <td className="py-2 text-right font-semibold tabular-nums">{Number(c.score).toFixed(1)} ⭐</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ═══════ SECTION B — Intelligence ═══════ */}
            <h3 className="text-lg font-semibold text-card-foreground pt-4 border-t border-border">Intelligence & Predictions</h3>

            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatCard title="Predicted (30d)" value={formatCurrency(summary?.predicted_30d ?? 0, displayCurrency)} icon={TrendingUp} variant="gold" />
              <StatCard title="Predicted (90d)" value={formatCurrency(summary?.predicted_90d ?? 0, displayCurrency)} icon={TrendingUp} />
              <StatCard title="Avg Completion" value={`${avgCompletion}%`} icon={Target} variant="success" />
              <StatCard title="High Risk" value={highRisk.toString()} subtitle="accounts" icon={ShieldAlert} variant="danger" />
              <StatCard title="Active Accounts" value={activeAccounts.length.toString()} icon={Users} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Late Payment Risk Matrix */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 text-primary" /> Late Payment Risk Matrix
                </h3>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {risks.slice(0, 15).map(risk => (
                    <Link key={risk.accountId} to={`/accounts/${risk.accountId}`}>
                      <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm font-medium text-card-foreground">{risk.customerName}</p>
                            <RiskBadge level={risk.riskLevel} />
                          </div>
                          <p className="text-xs text-muted-foreground">INV #{risk.invoiceNumber} · {risk.maxOverdueDays > 0 ? `${risk.maxOverdueDays} days overdue` : 'Current'} · Score: {risk.score}/100</p>
                        </div>
                        <div className="text-right">
                          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${riskStyles[risk.riskLevel].bg} ${riskStyles[risk.riskLevel].text}`}>
                            {risk.recommendation}
                          </div>
                        </div>
                      </div>
                    </Link>
                  ))}
                  {risks.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No active accounts</p>}
                </div>
              </div>

              {/* Completion Predictions */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" /> Layaway Completion Prediction
                </h3>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {completions.slice(0, 15).map(p => (
                    <Link key={p.accountId} to={`/accounts/${p.accountId}`}>
                      <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                        <div>
                          <p className="text-sm font-medium text-card-foreground">{p.customerName}</p>
                          <p className="text-xs text-muted-foreground">INV #{p.invoiceNumber}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="w-20">
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className="h-full gold-gradient rounded-full" style={{ width: `${p.progressPercent}%` }} />
                            </div>
                            <p className="text-[10px] text-muted-foreground text-right mt-0.5">{p.progressPercent}%</p>
                          </div>
                          <CompletionBadge probability={p.probability} />
                        </div>
                      </div>
                    </Link>
                  ))}
                  {completions.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No active accounts</p>}
                </div>
              </div>

              {/* CLV Overview */}
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
                  <Crown className="h-4 w-4 text-primary" /> Customer Lifetime Value
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto">
                  {clvs.slice(0, 20).map((clv: any) => (
                    <Link key={clv.customerId} to={`/customers/${clv.customerId}`}>
                      <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                            {clv.customerName.charAt(0)}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-card-foreground">{clv.customerName}</p>
                            <p className="text-xs text-muted-foreground">{clv.completedContracts} completed · {clv.reliabilityScore}% reliability</p>
                          </div>
                        </div>
                        <CLVBadge tier={clv.tier} />
                      </div>
                    </Link>
                  ))}
                  {clvs.length === 0 && <p className="text-sm text-muted-foreground text-center py-4 col-span-2">No customers</p>}
                </div>
              </div>

              {/* CSR Performance */}
              <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
                <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
                  <UserCheck className="h-4 w-4 text-primary" /> CSR Performance
                </h3>
                {csrPerformance.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No team members yet</p>
                ) : (
                  <div className="space-y-4">
                    {csrPerformance.map((csr: any, i: number) => (
                      <div key={csr.userId} className="p-4 rounded-lg border border-border">
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${i === 0 ? 'gold-gradient text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                              #{i + 1}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-card-foreground">{csr.name}</p>
                              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{csr.role}</p>
                            </div>
                          </div>
                          {i === 0 && <Badge className="gold-gradient text-primary-foreground text-[10px] border-0">Top Collector</Badge>}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
                          {[
                            { label: 'Total Collected', value: formatCurrency(Math.round(csr.totalCollected), displayCurrency) },
                            { label: 'Payments', value: csr.paymentCount },
                            { label: 'Submissions Reviewed', value: csr.reviewedCount },
                            { label: 'Accounts Handled', value: csr.accountsHandled },
                            { label: 'Accounts Created', value: csr.accountsCreated },
                            { label: 'Recoveries', value: csr.recoveries },
                            { label: 'Submissions', value: csr.submissionsHandled },
                          ].map(m => (
                            <div key={m.label} className="p-2 rounded-lg bg-muted/30">
                              <p className="text-[10px] text-muted-foreground">{m.label}</p>
                              <p className="text-sm font-bold text-card-foreground">{m.value}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>) : (
            <div className="text-center text-muted-foreground py-12">You don't have permission to view this section.</div>
          )}
          </TabsContent>

          {/* ═══════ Collections Tab ═══════ */}
          <TabsContent value="collections" className="mt-5 space-y-6" tabIndex={-1}>
          {showCollections ? (<>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatCard title="Today" value={formatCurrency(collStats.todayTotal, displayCurrency)} icon={TrendingUp} variant="gold" />
              <StatCard title="Yesterday" value={formatCurrency(collStats.yesterdayTotal, displayCurrency)} icon={TrendingUp} />
              <StatCard title="This Week" value={formatCurrency(collStats.weekTotal, displayCurrency)} icon={TrendingUp} />
              <StatCard title="This Month" value={formatCurrency(collStats.monthTotal, displayCurrency)} icon={TrendingUp} variant="success" />
              <StatCard title="This Year" value={formatCurrency(collStats.yearTotal, displayCurrency)} icon={Banknote} />
            </div>

            {/* Upcoming Receivables */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-primary" /> Upcoming Receivables
                </h3>
                <span className="text-xs text-muted-foreground">Click a card to see accounts</span>
              </div>
              {forecastLoading || !forecastCards ? (
                <div className="flex gap-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="flex-1 h-24 rounded-lg" />)}</div>
              ) : (
                <div className="flex gap-3">
                  {forecastCards.map((card, i) => (
                    <div key={card.key} className="flex-1 rounded-lg border border-border bg-muted/30 p-3 cursor-pointer hover:border-primary/50 hover:bg-muted/50 transition-colors"
                      onClick={() => { setSelectedCard({ key: card.key, label: card.label, count: card.count }); setDrillSearch(''); }}>
                      <div className="text-xs font-semibold text-muted-foreground mb-2">{card.label}</div>
                      <div className="text-base font-bold text-foreground tabular-nums leading-tight">{formatCurrency(card.jpy, 'JPY')}</div>
                      <div className="text-xs text-muted-foreground mt-1.5">{card.count} accts</div>
                      {i === 0 && <div className="text-[10px] font-medium text-primary mt-1">Due in {card.daysAway}d</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Payment Feed */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-card-foreground">Payment Feed</h3>
                <span className="text-xs text-muted-foreground">{collFiltered.length} payments</span>
              </div>
              {!allPayments ? (
                <div className="p-5 space-y-3">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : collFiltered.length === 0 ? (
                <div className="p-12 text-center"><p className="text-sm text-muted-foreground">No payments found</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Date</th>
                        <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                        <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Invoice</th>
                        <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Amount</th>
                        {isAllMode && <th className="text-right px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">JPY Equiv.</th>}
                        <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Method</th>
                        <th className="text-left px-5 py-2.5 text-xs font-semibold text-muted-foreground uppercase">Recorded By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {collFiltered.slice(0, 100).map(p => {
                        const account = accountMap.get(p.account_id);
                        const jpyEquiv = toJpy(Number(p.amount_paid), p.currency as Currency);
                        const csrName = p.entered_by_user_id ? (collProfiles?.get(p.entered_by_user_id) || '—') : '—';
                        return (
                          <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                            <td className="px-5 py-3 text-sm text-muted-foreground">{new Date(p.date_paid).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                            <td className="px-5 py-3 text-sm font-medium text-card-foreground">{account ? <Link to={`/accounts/${account.id}`} className="hover:text-primary">{account.customers?.full_name || '—'}</Link> : '—'}</td>
                            <td className="px-5 py-3 text-sm text-muted-foreground">{account ? <Link to={`/accounts/${account.id}`} className="hover:text-primary">#{account.invoice_number}</Link> : '—'}</td>
                            <td className="px-5 py-3 text-sm font-semibold text-success text-right tabular-nums">+{formatCurrency(Number(p.amount_paid), p.currency as Currency)}</td>
                            {isAllMode && <td className="px-5 py-3 text-sm text-right tabular-nums text-muted-foreground">{p.currency === 'PHP' ? `¥ ${jpyEquiv.toLocaleString()}` : <span className="text-card-foreground font-medium">¥ {Number(p.amount_paid).toLocaleString()}</span>}</td>}
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
          </>) : (
            <div className="text-center text-muted-foreground py-12">You don't have permission to view this section.</div>
          )}
          </TabsContent>

          {/* ═══════ Documentation Tab ═══════ */}
          <TabsContent value="docs" className="mt-5" tabIndex={-1}>
            {showDocs ? (
              <MemoPaymentsHub embedded />
            ) : (
              <div className="text-center text-muted-foreground py-12">You don't have permission to view this section.</div>
            )}
          </TabsContent>

          {/* ═══════ Vault Tab ═══════ */}
          <TabsContent value="vault" className="mt-5" tabIndex={-1}>
            {showVault ? (
              <MemoPaymentVault embedded />
            ) : (
              <div className="text-center text-muted-foreground py-12">You don't have permission to view this section.</div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Forecast drilldown slide-over */}
      {selectedCard && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/60" onClick={() => setSelectedCard(null)} />
          <div className="w-full max-w-2xl bg-zinc-900 border-l border-zinc-700 flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700 flex-shrink-0">
              <div>
                <h2 className="text-base font-semibold text-zinc-100">{selectedCard.label} — {drilldownRaw?.length ?? 0} accounts</h2>
                <p className="text-xs text-zinc-400 mt-0.5">Pending installments due this month</p>
              </div>
              <button onClick={() => setSelectedCard(null)} className="text-zinc-400 hover:text-zinc-100 transition-colors p-1 rounded"><X className="h-5 w-5" /></button>
            </div>
            <div className="px-5 py-3 border-b border-zinc-700 flex-shrink-0">
              <input value={drillSearch} onChange={e => setDrillSearch(e.target.value)} placeholder="Search invoice # or customer name…" className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-primary/60" />
            </div>
            <div className="flex-1 overflow-y-auto">
              {drilldownLoading ? (
                <div className="p-5 space-y-2">{[...Array(10)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-zinc-800" />)}</div>
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
                      const amountDue = Number(row.actual_remaining);
                      const jpyEq = Math.round(toJpy(amountDue, row.currency as Currency));
                      const isOverdue = row.computed_status === 'overdue' || (row.due_date < collToday && row.computed_status !== 'paid');
                      const isPartial = row.computed_status === 'partially_paid';
                      return (
                        <tr key={row.schedule_id} className="border-b border-zinc-800 hover:bg-zinc-800/50 transition-colors">
                          <td className="px-4 py-2.5"><Link to={`/accounts/${row.account_id}`} onClick={() => setSelectedCard(null)} className="text-xs font-mono text-primary hover:underline">#{row.invoice_number}</Link></td>
                          <td className="px-4 py-2.5 text-xs text-zinc-300 max-w-[140px] truncate">{row.customer_name || '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-zinc-400">{new Date(row.due_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                          <td className="px-4 py-2.5 text-xs font-semibold tabular-nums text-right text-zinc-100">{formatCurrency(amountDue, row.currency as Currency)}</td>
                          <td className="px-4 py-2.5 text-xs tabular-nums text-right text-zinc-400">¥{jpyEq.toLocaleString()}</td>
                          <td className="px-4 py-2.5">
                            <Badge variant="outline" className={`text-[9px] h-4 px-1.5 bg-zinc-900 ${isOverdue ? 'text-destructive border-destructive/40' : isPartial ? 'text-warning border-warning/40' : 'text-zinc-400 border-zinc-600'}`}>
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
            {!drilldownLoading && drillSearch && (
              <div className="px-5 py-2 border-t border-zinc-700 text-xs text-zinc-500 flex-shrink-0">Showing {drilldownRows.length} of {drilldownRaw?.length ?? 0} accounts</div>
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}

// ────────────────────────────────────────────────────────────────────────
// CashVsLayawaySplitCard — this-month revenue split, compact horizontal bar
// Always reports JPY (values come from dashboard-summary.cash_vs_layaway_split
// which is already currency-normalised server-side).
// TODO: add cash_revenue_by_month_6m RPC for historical chart in future phase.
// ────────────────────────────────────────────────────────────────────────
function CashVsLayawaySplitCard({
  cashJpy, layawayJpy, cashPct,
}: { cashJpy: number; layawayJpy: number; cashPct: number }) {
  const layawayPct = Math.max(0, Math.round((100 - cashPct) * 10) / 10);
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4 sm:p-5 border-l-[3px] border-l-primary/60">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Cash vs Layaway (This Month · JPY)
          </p>
          <p className="text-xl sm:text-2xl font-bold font-display tabular-nums mt-1">
            {cashPct.toFixed(1)}% <span className="text-sm font-normal text-muted-foreground">cash</span>
          </p>
        </div>
      </div>
      {/* Horizontal split bar */}
      <div className="mt-3">
        <div className="h-2 rounded-full bg-muted overflow-hidden flex">
          <div
            className="h-full gold-gradient transition-all duration-500"
            style={{ width: `${Math.min(Math.max(cashPct, 0), 100)}%` }}
            title={`Cash ${cashPct.toFixed(1)}%`}
          />
          <div
            className="h-full bg-success/70 transition-all duration-500"
            style={{ width: `${Math.min(Math.max(layawayPct, 0), 100)}%` }}
            title={`Layaway ${layawayPct.toFixed(1)}%`}
          />
        </div>
      </div>
      {/* Legend */}
      <div className="mt-2 flex items-center justify-between text-[10px] tabular-nums">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary" />
          <span className="text-muted-foreground">Cash</span>
          <span className="text-card-foreground font-medium">¥ {Math.round(cashJpy).toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-success/70" />
          <span className="text-muted-foreground">Layaway</span>
          <span className="text-card-foreground font-medium">¥ {Math.round(layawayJpy).toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
