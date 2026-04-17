import { useState, useMemo } from 'react';
import { DollarSign, TrendingUp, BarChart3, Sparkles, CalendarClock, Trophy, Clock, AlertTriangle } from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import MonthlyAnalyticsChart from '@/components/MonthlyAnalyticsChart';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { useAccounts, useDashboardSummary } from '@/hooks/use-supabase-data';
import { useAutoRefresh } from '@/hooks/use-auto-refresh';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Link } from 'react-router-dom';

export default function Finance() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const [tab, setTab] = useState<'overview' | 'analytics'>('overview');
  const { session, loading: authLoading } = useAuth();
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );
  const { data: accounts } = useAccounts();
  useAutoRefresh([
    ['accounts'],
    ['dashboard-summary'],
  ]);

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

  // ── Analytics tab queries ──
  const { data: collectionAnalytics, isLoading: analyticsLoading } = useQuery({
    queryKey: ['collection-analytics', currencyFilter],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_collection_analytics', {
        currency_mode: currencyFilter,
        months_back: 6,
      });
      if (error) throw error;
      return (data || []) as Array<{
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
      return (data || []) as Array<{
        staff_email: string;
        payments_confirmed: number;
        avg_confirmation_hours: number | null;
      }>;
    },
    enabled: tab === 'analytics' && !!session,
  });

  const topOutstanding = useMemo(() => {
    if (!accounts) return [];
    return accounts
      .filter(a => a.status === 'active' || a.status === 'overdue')
      .sort((a, b) => Number(b.remaining_balance) - Number(a.remaining_balance))
      .slice(0, 10);
  }, [accounts]);

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

        <Tabs value={tab} onValueChange={v => setTab(v as 'overview' | 'analytics')} className="w-full">
          <TabsList className="grid grid-cols-2 w-full max-w-xs">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>

          {/* ═══════ Overview Tab ═══════ */}
          <TabsContent value="overview" className="mt-5 space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              {summaryLoading ? (
                [...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
              ) : (
                <>
                  <StatCard title="Total Receivables" value={formatCurrency(summary?.total_receivables ?? 0, displayCurrency)} icon={DollarSign} variant="gold" />
                  <StatCard title="Expected Next Month" value={formatCurrency(summary?.next_month_adjusted ?? 0, displayCurrency)} subtitle={`of ${formatCurrency(summary?.next_month_expected ?? 0, displayCurrency)} due`} icon={Sparkles} variant="gold" />
                  <StatCard title="Predicted (30d)" value={formatCurrency(summary?.predicted_30d ?? 0, displayCurrency)} subtitle={`of ${formatCurrency(summary?.predicted_30d_raw ?? 0, displayCurrency)} due`} icon={TrendingUp} variant="success" />
                  <StatCard title="Predicted (90d)" value={formatCurrency(summary?.predicted_90d ?? 0, displayCurrency)} subtitle={`of ${formatCurrency(summary?.predicted_90d_raw ?? 0, displayCurrency)} due`} icon={TrendingUp} />
                  <StatCard title="Collections This Month" value={formatCurrency(summary?.collections_this_month ?? 0, displayCurrency)} icon={BarChart3} variant="success" />
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

            <MonthlyAnalyticsChart />

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
          <TabsContent value="analytics" className="mt-5 space-y-6">

            {/* Section 1 — Collection Performance */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-card-foreground">Collection Performance (Last 6 Months)</h3>
              {analyticsLoading ? (
                <div className="grid grid-cols-3 gap-4">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <StatCard title="Best Month" value={bestMonth ? `${bestMonth.collection_rate}%` : '—'} subtitle={bestMonth?.month} icon={Trophy} variant="gold" />
                    <StatCard title="Average Rate" value={`${avgRate}%`} icon={TrendingUp} variant="success" />
                    <StatCard title="Penalties Collected" value={formatCurrency(totalPenalties, displayCurrency)} icon={DollarSign} />
                  </div>
                  {collectionAnalytics && collectionAnalytics.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div className="rounded-xl border border-border bg-card p-5">
                        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Collected vs Expected</h4>
                        <ResponsiveContainer width="100%" height={240}>
                          <BarChart data={collectionAnalytics} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} />
                            <Tooltip contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }} />
                            <Legend wrapperStyle={{ fontSize: 10 }} />
                            <Bar dataKey="collected" name="Collected" fill="#16a34a" radius={[4, 4, 0, 0]} />
                            <Bar dataKey="expected" name="Expected" fill="#2563eb" radius={[4, 4, 0, 0]} opacity={0.5} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
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
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Section 2 — Forfeiture Trend */}
            {collectionAnalytics && collectionAnalytics.some(m => m.forfeited > 0) && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-card-foreground mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive" /> Forfeitures per Month
                </h3>
                <ResponsiveContainer width="100%" height={200}>
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

            {/* Section 4 — Top 10 Outstanding */}
            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-card-foreground mb-3">Top 10 Outstanding Accounts</h3>
              {topOutstanding.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No outstanding accounts.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] text-muted-foreground uppercase border-b border-border">
                        <th className="py-2 pr-3">Invoice #</th>
                        <th className="py-2 pr-3">Customer</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 text-right">Remaining Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topOutstanding.map(a => (
                        <tr key={a.id} className="border-b border-border/50">
                          <td className="py-2 pr-3">
                            <Link to={`/accounts/${a.id}`} className="text-primary hover:underline font-mono">#{a.invoice_number}</Link>
                          </td>
                          <td className="py-2 pr-3 text-foreground">{a.customers?.full_name || '—'}</td>
                          <td className="py-2 pr-3">
                            <Badge variant="outline" className={a.status === 'overdue' ? 'bg-destructive/10 text-destructive border-destructive/30 text-[10px]' : 'bg-green-500/10 text-green-600 border-green-500/30 text-[10px]'}>
                              {a.status}
                            </Badge>
                          </td>
                          <td className="py-2 text-right font-semibold tabular-nums">{formatCurrency(Number(a.remaining_balance), a.currency as Currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
