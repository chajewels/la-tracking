import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import AppLayout from '@/components/layout/AppLayout';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useConversionRate,
  usePlanConfigurations,
  useFinancialAlerts,
  useActiveAccounts,
  useMonthlyPayments,
  useKPIs,
  useMonthlyInflowByPlan,
  useActiveByPlan,
  usePlanPerformance,
} from '@/hooks/useExecutiveDashboard';

const PLAN_COLORS: Record<number, string> = {
  3: '#888780',
  6: '#378ADD',
  8: '#1D9E75',
  10: '#EF9F27',
  12: '#D85A30',
};

const RISK_STYLES: Record<string, string> = {
  LOW: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  MODERATE: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  HIGH: 'bg-red-500/10 text-red-500 border-red-500/20',
  CRITICAL: 'bg-red-900/20 text-red-400 border-red-700/40',
};

const SEVERITY_STYLES: Record<string, { bg: string; dot: string }> = {
  critical: { bg: 'bg-red-500/10 border-red-500/30 text-red-400', dot: 'bg-red-500' },
  warning: { bg: 'bg-amber-500/10 border-amber-500/30 text-amber-400', dot: 'bg-amber-500' },
  info: { bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', dot: 'bg-emerald-500' },
};

function fmtJpy(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `¥${Math.round(v / 1_000).toLocaleString()}K`;
  return `¥${Math.round(v).toLocaleString()}`;
}

function fmtJpyFull(v: number): string {
  return '¥' + Math.round(v).toLocaleString();
}

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg">
      <p className="font-semibold text-zinc-200 mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.fill }} />
          <span className="text-zinc-400">{p.dataKey.replace('plan_', '')}M:</span>
          <span className="text-zinc-100 tabular-nums font-medium">{fmtJpyFull(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

export default function ExecutiveDashboard() {
  const { data: rate, isLoading: rateLoading } = useConversionRate();
  const { data: planConfigs } = usePlanConfigurations();
  const alerts = useFinancialAlerts();
  const { data: accounts, isLoading: accountsLoading } = useActiveAccounts(rate);
  const { data: payments, isLoading: paymentsLoading } = useMonthlyPayments(rate);

  const kpis = useKPIs(accounts, payments, rate);
  const inflowData = useMonthlyInflowByPlan(payments, rate);
  const donutData = useActiveByPlan(accounts);
  const planPerf = usePlanPerformance(accounts, payments, planConfigs, rate);

  const planKeys = useMemo(() => {
    if (!planConfigs) return [3, 6, 8, 10, 12];
    return planConfigs.map(c => c.plan_months);
  }, [planConfigs]);

  const isLoading = rateLoading || accountsLoading || paymentsLoading;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Executive Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Live data · Read only</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Live · refreshes every 30s
            </div>
            <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400 bg-amber-500/10">
              CEO / CFO access only
            </Badge>
          </div>
        </div>

        {/* Alert Bar */}
        {alerts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {alerts.map(a => {
              const s = SEVERITY_STYLES[a.severity] || SEVERITY_STYLES.info;
              return (
                <div key={a.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${s.bg}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />
                  {a.message}
                </div>
              );
            })}
          </div>
        )}

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            [...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : (
            <>
              <KPICard label="Portfolio Value" value={fmtJpy(kpis.portfolioValue)} />
              <KPICard label="Gross Profit (15%)" value={fmtJpy(kpis.grossProfit)} />
              <KPICard label="Monthly Inflow" value={fmtJpy(kpis.monthlyInflow)} />
              <KPICard label="Net Exposure Risk" value={fmtJpy(kpis.netExposure)} danger />
            </>
          )}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Stacked Bar */}
          <div className="lg:col-span-3 rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-1">Monthly Inflow by Plan — Last 6 Months</h3>
            <div className="flex flex-wrap gap-4 mb-4 mt-2">
              {planKeys.map(pm => (
                <div key={pm} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PLAN_COLORS[pm] || '#888' }} />
                  {pm}M
                </div>
              ))}
            </div>
            {isLoading ? (
              <Skeleton className="h-[280px] w-full rounded-lg" />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={inflowData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtJpy} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  {planKeys.map(pm => (
                    <Bar key={pm} dataKey={`plan_${pm}`} stackId="inflow" fill={PLAN_COLORS[pm] || '#888'} radius={pm === planKeys[planKeys.length - 1] ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Donut */}
          <div className="lg:col-span-2 rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">Active Accounts by Plan</h3>
            {isLoading ? (
              <Skeleton className="h-[200px] w-full rounded-lg" />
            ) : donutData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">No active accounts</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={donutData}
                      dataKey="count"
                      nameKey="plan"
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={2}
                    >
                      {donutData.map((d, i) => (
                        <Cell key={i} fill={PLAN_COLORS[d.plan] || '#888'} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number, name: string) => [`${value} accounts`, `${name}M`]}
                      contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 mt-3">
                  {donutData.map(d => (
                    <div key={d.plan} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PLAN_COLORS[d.plan] || '#888' }} />
                      {d.plan}M: {d.count} ({d.pct}%)
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Plan Performance Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-muted/30">
            <h3 className="text-sm font-semibold text-card-foreground">Plan Performance</h3>
          </div>
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-5 py-2.5 font-semibold text-muted-foreground uppercase">Plan</th>
                    <th className="text-right px-5 py-2.5 font-semibold text-muted-foreground uppercase">Accounts</th>
                    <th className="text-right px-5 py-2.5 font-semibold text-muted-foreground uppercase">Portfolio ¥</th>
                    <th className="text-right px-5 py-2.5 font-semibold text-muted-foreground uppercase">Avg Ticket</th>
                    <th className="text-right px-5 py-2.5 font-semibold text-muted-foreground uppercase">Monthly Inflow</th>
                    <th className="text-right px-5 py-2.5 font-semibold text-muted-foreground uppercase">Gross Profit</th>
                    <th className="text-center px-5 py-2.5 font-semibold text-muted-foreground uppercase">Risk Tier</th>
                  </tr>
                </thead>
                <tbody>
                  {(planPerf || []).map(row => (
                    <tr key={row.plan_months} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-5 py-3 font-medium text-foreground">{row.display_label}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-foreground">{row.count > 0 ? row.count : '—'}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-foreground">{row.count > 0 ? fmtJpyFull(row.portfolio) : '—'}</td>
                      <td className="px-5 py-3 text-right tabular-nums">
                        {row.count > 0 ? (
                          <span className="text-foreground">{fmtJpyFull(row.avgTicket)}</span>
                        ) : (
                          <span className="text-muted-foreground">Min {fmtJpyFull(row.min_amount_jpy)}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-foreground">{row.count > 0 ? fmtJpyFull(row.monthlyInflow) : '—'}</td>
                      <td className="px-5 py-3 text-right tabular-nums text-foreground">{row.count > 0 ? fmtJpyFull(row.grossProfit) : '—'}</td>
                      <td className="px-5 py-3 text-center">
                        <Badge variant="outline" className={`text-[9px] ${RISK_STYLES[row.risk_tier] || RISK_STYLES.MODERATE}`}>
                          {row.risk_tier}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-5 py-2.5 text-[10px] text-muted-foreground border-t border-border">
            8M, 10M, and 12M rows populate automatically when first accounts are enrolled. All figures in JPY.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}

function KPICard({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full bg-gradient-to-b from-[#D4AF37] via-[#F7E7A1] to-[#D4AF37]" />
      <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider pl-3">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold font-display tabular-nums pl-3 mt-1 ${danger ? 'text-destructive' : 'text-card-foreground'}`}>
        {value}
      </p>
    </div>
  );
}
