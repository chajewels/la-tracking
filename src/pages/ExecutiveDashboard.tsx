import { useState, type ReactNode } from 'react';
import { useChartAnimation } from '@/hooks/useChartAnimation';
import AnimatedNumber from '@/components/shared/AnimatedNumber';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import AppLayout from '@/components/layout/AppLayout';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useExecutiveDashboard,
  useMonthlyInflowByPlan,
  useActiveByPlan,
  useFinancialAlerts,
} from '@/hooks/useExecutiveDashboard';
import { useDashboardSummary } from '@/hooks/use-supabase-data';

const PLAN_COLORS: Record<number, string> = { 3: '#888780', 6: '#378ADD', 8: '#1D9E75', 10: '#EF9F27', 12: '#D85A30' };
const PLAN_KEYS = [3, 6, 8, 10, 12];

const SEVERITY_STYLES: Record<string, { bg: string; dot: string }> = {
  critical: { bg: 'bg-red-500/10 border-red-500/30 text-red-400', dot: 'bg-red-500' },
  warning: { bg: 'bg-amber-500/10 border-amber-500/30 text-amber-400', dot: 'bg-amber-500' },
  info: { bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', dot: 'bg-emerald-500' },
};

const RISK_BADGE: Record<string, string> = {
  LOW: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  MODERATE: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  HIGH: 'bg-red-500/10 text-red-500 border-red-500/20',
  CRITICAL: 'bg-red-900/20 text-red-400 border-red-700/40',
};

function fmtM(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `¥${Math.round(v / 1_000).toLocaleString()}K`;
  return `¥${Math.round(v).toLocaleString()}`;
}

function fmtFull(v: number): string {
  return '¥' + Math.round(v).toLocaleString();
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
          <span className="text-zinc-100 tabular-nums font-medium">{fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

export default function ExecutiveDashboard() {
  const chartAnim = useChartAnimation();
  const d = useExecutiveDashboard();
  const inflowData = useMonthlyInflowByPlan();
  const donutData = useActiveByPlan();
  const alerts = useFinancialAlerts();
  // Cash KPIs come from dashboard-summary (JPY only). Fetched with 'ALL' so the
  // values don't get currency-filtered at the edge-function boundary — cash
  // fields are already JPY-normalised server-side regardless of currency_mode.
  const { data: cashSummary } = useDashboardSummary('ALL');
  const [riskOpen, setRiskOpen] = useState(false);

  const coverageColor = d.coverageRatio?.status_label === 'HEALTHY' ? 'border-emerald-500' :
    d.coverageRatio?.status_label === 'WATCH' ? 'border-amber-500' : 'border-red-500';
  const coverageLabelColor = d.coverageRatio?.status_label === 'HEALTHY' ? 'text-emerald-500' :
    d.coverageRatio?.status_label === 'WATCH' ? 'text-amber-500' : 'text-red-500';

  const recovered = (d.netExposure?.dp_retained ?? 0) + (d.netExposure?.penalties_collected ?? 0) + (d.netExposure?.estimated_resale ?? 0);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Executive Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Live data · Read only</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-muted-foreground tabular-nums">Updated {fmtTime(d.lastUpdated)}</span>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              Live · 30s
            </div>
            <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400 bg-amber-500/10">CEO / CFO</Badge>
          </div>
        </div>

        {/* Alert Bar */}
        {alerts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {[...alerts].sort((a, b) => {
              const aHidden = a.message.startsWith('[Hidden Risk]') ? 0 : 1;
              const bHidden = b.message.startsWith('[Hidden Risk]') ? 0 : 1;
              if (aHidden !== bHidden) return aHidden - bHidden;
              const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
              const aSev = sevOrder[a.severity] ?? 3;
              const bSev = sevOrder[b.severity] ?? 3;
              if (aSev !== bSev) return aSev - bSev;
              return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            }).map(a => {
              const s = SEVERITY_STYLES[a.severity] || SEVERITY_STYLES.info;
              const isHidden = a.message.startsWith('[Hidden Risk]');
              const displayMsg = isHidden ? a.message.replace('[Hidden Risk] ', '') : a.message;
              return (
                <div key={a.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${s.bg}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />
                  {isHidden && <span className="font-bold text-red-900">Hidden Risk</span>}
                  {displayMsg}
                </div>
              );
            })}
          </div>
        )}

        {/* KPI Row 1 */}
        {d.loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KPI label="Portfolio Value" value={<AnimatedNumber value={d.portfolioValue} format={fmtM} />} sub="Active accounts only" />
            <KPI label="Active Gross Profit" value={<AnimatedNumber value={d.grossProfit?.active_gross_profit ?? 0} format={fmtM} />} sub="15% on active portfolio" />
            <KPI label="Lifetime Gross Profit" value={<AnimatedNumber value={d.grossProfit?.lifetime_gross_profit ?? 0} format={fmtM} />} sub="15% on all-time contracts" />
            <KPI label="Monthly Inflow" value={<AnimatedNumber value={d.monthlyInflow?.total_inflow ?? 0} format={fmtM} />}
              sub={`Installments ${fmtM(d.monthlyInflow?.installment_inflow ?? 0)} · Penalties ${fmtM(d.monthlyInflow?.penalty_inflow ?? 0)}`} />
            <div className="lg:col-span-2">
            <KPI label="Net Exposure Risk" value={<AnimatedNumber value={d.netExposure?.net_exposure ?? 0} format={fmtM} />} danger
              sub={`${fmtM(d.netExposure?.gross_exposure ?? 0)} gross · ${fmtM(recovered)} recovered`}
              extra={d.netExposure ? (
                <div className="pl-2">
                  {d.netExposure.exposure_change !== 0 && (
                    <p className={`text-[10px] font-medium tabular-nums ${d.netExposure.exposure_change > 0 ? 'text-destructive' : 'text-emerald-500'}`}>
                      {d.netExposure.exposure_change > 0 ? '▲' : '▼'} {fmtM(Math.abs(d.netExposure.exposure_change))} vs last month
                    </p>
                  )}
                  {d.netExposure.delta_pct !== 0 && (
                    <p className={`text-[10px] tabular-nums ${d.netExposure.delta_pct > 0 ? 'text-destructive' : 'text-emerald-500'}`}>
                      {d.netExposure.delta_pct > 0 ? '▲' : '▼'} {Math.abs(d.netExposure.delta_pct).toFixed(1)}% month-over-month
                    </p>
                  )}
                  <div className="mt-1.5 space-y-0.5 text-[10px] tabular-nums">
                    <div className="flex items-center justify-between"><span className="text-muted-foreground">Healthy</span><span className="flex items-center gap-2"><span className="text-emerald-500">{fmtM(d.netExposure.healthy_exposure)}</span>{d.netExposure.delta_healthy !== 0 && <><span className={d.netExposure.delta_healthy < 0 ? 'text-emerald-500' : 'text-destructive'}>{d.netExposure.delta_healthy < 0 ? '▼' : '▲'} {fmtM(Math.abs(d.netExposure.delta_healthy))}</span>{d.netExposure.delta_healthy < 0 && <span className="text-emerald-500/60 text-[9px]">converting to cash</span>}</>}</span></div>
                    <div className="flex items-center justify-between"><span className="text-muted-foreground">At-Risk</span><span className="flex items-center gap-2"><span className="text-amber-500">{fmtM(d.netExposure.at_risk_exposure)}</span>{d.netExposure.delta_at_risk !== 0 && <><span className={d.netExposure.delta_at_risk < 0 ? 'text-emerald-500' : 'text-destructive'}>{d.netExposure.delta_at_risk < 0 ? '▼' : '▲'} {fmtM(Math.abs(d.netExposure.delta_at_risk))}</span><span className={`text-[9px] ${d.netExposure.delta_at_risk > 0 ? 'text-amber-500/60' : 'text-emerald-500/60'}`}>{d.netExposure.delta_at_risk > 0 ? 'risk building' : 'improving'}</span></>}</span></div>
                    <div className="flex items-center justify-between"><span className="text-muted-foreground">Critical</span><span className="flex items-center gap-2"><span className="text-destructive">{fmtM(d.netExposure.critical_exposure)}</span>{d.netExposure.delta_critical !== 0 && <><span className={d.netExposure.delta_critical < 0 ? 'text-emerald-500' : 'text-destructive'}>{d.netExposure.delta_critical < 0 ? '▼' : '▲'} {fmtM(Math.abs(d.netExposure.delta_critical))}</span><span className={`text-[9px] ${d.netExposure.delta_critical > 0 ? 'text-destructive/60' : 'text-emerald-500/60'}`}>{d.netExposure.delta_critical > 0 ? 'immediate attention required' : 'improving'}</span></>}</span></div>
                  </div>
                </div>
              ) : undefined} />
            </div>
            <div className={`relative overflow-hidden rounded-xl border bg-card p-4 sm:p-5 border-l-[3px] lg:col-span-2 ${coverageColor}`}>
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider pl-2">Cash Flow Coverage</p>
              <p className="text-xl sm:text-2xl font-bold font-display tabular-nums pl-2 mt-1"><AnimatedNumber value={d.coverageRatio?.coverage_ratio ?? 0} format={(n) => n.toFixed(2)} />×</p>
              <p className={`text-[10px] pl-2 font-semibold uppercase tracking-wider ${coverageLabelColor}`}>{d.coverageRatio?.status_label ?? '—'}</p>
              <div className="mt-2 pl-2 space-y-0.5 text-[10px] tabular-nums">
                <div className="flex justify-between text-muted-foreground"><span>Cash In</span><span>{fmtM(d.coverageRatio?.cash_in ?? 0)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Inventory Cost</span><span>{fmtM(d.coverageRatio?.inventory_cost ?? 0)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Funding Gap</span><span className={(d.coverageRatio?.funding_gap ?? 0) >= 0 ? 'text-emerald-500' : 'text-destructive'}>{fmtM(d.coverageRatio?.funding_gap ?? 0)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Days Covered</span><span>{(d.coverageRatio?.days_covered ?? 0).toFixed(1)} days</span></div>
                <div className="border-t border-border/50 mt-1.5 pt-1.5">
                  <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">30-Day Forecast</p>
                  <div className="flex justify-between text-muted-foreground"><span>Projected Inflow</span><span>{fmtM(d.coverageRatio?.projected_inflow_30d ?? 0)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Projected Coverage</span><span className={`font-medium ${(d.coverageRatio?.projected_coverage_30d ?? 0) >= 1.2 ? 'text-emerald-500' : (d.coverageRatio?.projected_coverage_30d ?? 0) >= 1.0 ? 'text-amber-500' : 'text-destructive'}`}>{(d.coverageRatio?.projected_coverage_30d ?? 0).toFixed(2)}×</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Projected Gap</span><span className={(d.coverageRatio?.projected_funding_gap ?? 0) >= 0 ? 'text-emerald-500' : 'text-destructive'}>{fmtM(d.coverageRatio?.projected_funding_gap ?? 0)}</span></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* KPI Row 2 */}
        {!d.loading && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* Cash Sales — always JPY, from dashboard-summary */}
            <KPI
              label="Cash Sales (This Month · JPY)"
              value={<AnimatedNumber value={cashSummary?.total_sales_booked_this_month?.cash_jpy ?? 0} format={fmtFull} />}
              sub={`${fmtFull(cashSummary?.cash_revenue_total_jpy ?? 0)} all-time · ${cashSummary?.cash_orders_active ?? 0} pending`}
            />
            {/* At-Risk */}
            <div className="rounded-xl border border-border bg-card p-5 cursor-pointer hover:border-primary/30 transition-colors" onClick={() => setRiskOpen(!riskOpen)}>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">At-Risk Accounts</p>
              <p className="text-2xl font-bold font-display tabular-nums mt-1"><AnimatedNumber value={d.atRisk?.total_at_risk ?? 0} format={(n) => String(Math.round(n))} /> <span className="text-sm font-normal text-muted-foreground">accounts</span></p>
              <p className="text-xs text-muted-foreground">{(d.atRisk?.at_risk_pct ?? 0).toFixed(1)}% of active accounts</p>
              {(d.atRisk?.critical_count ?? 0) > 0 && <p className="text-xs text-destructive font-medium mt-0.5">{d.atRisk!.critical_count} critical</p>}
              <p className="text-[9px] text-muted-foreground mt-1">{riskOpen ? 'Click to collapse ▲' : 'Click to expand ▼'}</p>
            </div>
            {/* Penalty Revenue */}
            <KPI label="Penalty Revenue (This Month)" value={<AnimatedNumber value={d.penaltyRevenue?.current_month_jpy ?? 0} format={fmtFull} />}
              sub={`${fmtFull(d.penaltyRevenue?.cumulative_jpy ?? 0)} cumulative all-time`}
              extra={d.penaltyRevenue?.penalty_pct_of_inflow != null ? (
                <p className={`text-[10px] pl-2 tabular-nums ${(d.penaltyRevenue.penalty_pct_of_inflow > 5) ? 'text-destructive' : (d.penaltyRevenue.penalty_pct_of_inflow > 2) ? 'text-amber-500' : 'text-muted-foreground'}`}>
                  {d.penaltyRevenue.penalty_pct_of_inflow.toFixed(2)}% of monthly inflow
                </p>
              ) : undefined} />
            {/* Penalty-Driven Accounts */}
            <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4 sm:p-5 border-l-[3px] border-l-primary">
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider pl-2">Penalty-Driven Accounts</p>
              <p className="text-xl sm:text-2xl font-bold font-display tabular-nums pl-2 mt-1"><AnimatedNumber value={d.penaltyDriven?.penalty_driven_count ?? 0} format={(n) => String(Math.round(n))} /> <span className="text-sm font-normal text-muted-foreground">accounts</span></p>
              <p className="text-[10px] text-muted-foreground pl-2 mt-0.5">{(d.penaltyDriven?.pct_of_active ?? 0).toFixed(1)}% of active</p>
              <p className="text-[10px] text-muted-foreground pl-2">{(d.penaltyDriven?.penalty_revenue_contribution ?? 0).toFixed(1)}% of penalty revenue</p>
              <p className="text-[9px] text-muted-foreground/60 pl-2 mt-1.5">Accounts with ≥4 penalties and ≤14 days overdue</p>
            </div>
          </div>
        )}

        {/* At-Risk Drill-down */}
        {riskOpen && d.atRiskDetail.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-2.5 bg-muted/30 border-b border-border">
              <h3 className="text-xs font-semibold text-card-foreground">At-Risk Account Detail</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-2 font-semibold text-muted-foreground">Invoice</th>
                    <th className="text-left px-4 py-2 font-semibold text-muted-foreground">Plan</th>
                    <th className="text-right px-4 py-2 font-semibold text-muted-foreground">Overdue Days</th>
                    <th className="text-right px-4 py-2 font-semibold text-muted-foreground">Penalties</th>
                    <th className="text-right px-4 py-2 font-semibold text-muted-foreground">Outstanding ¥</th>
                    <th className="text-center px-4 py-2 font-semibold text-muted-foreground">Risk Level</th>
                    <th className="text-center px-4 py-2 font-semibold text-muted-foreground">Risk Type</th>
                    <th className="text-right px-4 py-2 font-semibold text-muted-foreground">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {d.atRiskDetail.map((r: any, i: number) => {
                    const score = Number(r.risk_score ?? 0);
                    const scoreColor = score >= 67 ? 'text-destructive' : score >= 34 ? 'text-amber-500' : 'text-muted-foreground';
                    const typeBadge = r.risk_type === 'CREDIT' ? 'bg-blue-500/15 text-blue-500 border-blue-500/30'
                      : r.risk_type === 'COMBINED' ? 'bg-red-500/15 text-red-500 border-red-500/30'
                      : 'bg-amber-500/15 text-amber-500 border-amber-500/30';
                    return (
                    <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-4 py-2 font-mono text-foreground">#{r.invoice_number}</td>
                      <td className="px-4 py-2 text-muted-foreground">{r.plan_months}M</td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">{r.overdue_days ?? 0}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">{r.penalty_count ?? 0}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-foreground">{fmtFull(r.outstanding_jpy ?? 0)}</td>
                      <td className="px-4 py-2 text-center">
                        <Badge variant="outline" className={`text-[9px] ${r.risk_level === 'CRITICAL' ? 'bg-red-900/30 text-white border-red-700' : 'bg-amber-500/15 text-amber-600 border-amber-500/30'}`}>
                          {r.risk_level}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <Badge variant="outline" className={`text-[9px] ${typeBadge}`}>{r.risk_type ?? '—'}</Badge>
                      </td>
                      <td className={`px-4 py-2 text-right tabular-nums font-medium ${scoreColor}`}>{score}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3 rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-1">Monthly Inflow by Plan — Last 6 Months</h3>
            <div className="flex flex-wrap gap-4 mb-4 mt-2">
              {PLAN_KEYS.map(pm => (
                <div key={pm} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: PLAN_COLORS[pm] }} />
                  {pm}M
                </div>
              ))}
            </div>
            {inflowData.length === 0 ? (
              <div className="flex items-center justify-center h-[280px] text-muted-foreground text-sm">Loading...</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={inflowData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={fmtM} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  {PLAN_KEYS.map((pm, i) => (
                    <Bar {...chartAnim} key={pm} dataKey={`plan_${pm}`} stackId="inflow" fill={PLAN_COLORS[pm]}
                      radius={i === PLAN_KEYS.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="lg:col-span-2 rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">Active Accounts by Plan</h3>
            {donutData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-12">No data</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie {...chartAnim} data={donutData} dataKey="count" nameKey="plan" cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {donutData.map((entry, i) => <Cell key={i} fill={PLAN_COLORS[entry.plan] || '#888'} />)}
                    </Pie>
                    <Tooltip formatter={(v: number, name: string) => [`${v} accounts`, `${name}M`]}
                      contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }} />
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

        {/* Cash vs Layaway — This Month stacked bar (JPY).
            TODO: add cash_revenue_by_month_6m RPC for historical chart in future phase. */}
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-card-foreground mb-1">This Month: Cash vs Layaway (JPY)</h3>
          <p className="text-[11px] text-muted-foreground mb-4">
            Current-month revenue mix. Historical trend coming in a later phase.
          </p>
          {(() => {
            const split = cashSummary?.cash_vs_layaway_split?.this_month;
            const cash = split?.cash_revenue_jpy ?? 0;
            const lay = split?.layaway_revenue_jpy ?? 0;
            const pct = split?.cash_percentage ?? 0;
            if (!split || (cash === 0 && lay === 0)) {
              return <p className="text-sm text-muted-foreground text-center py-12">No revenue yet this month.</p>;
            }
            const data = [{ label: 'This Month', cash, layaway: lay }];
            return (
              <>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <XAxis type="number" tickFormatter={fmtM} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="label" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                    <Tooltip
                      formatter={(v: number, name: string) => [fmtFull(v), name === 'cash' ? 'Cash' : 'Layaway']}
                      contentStyle={{ background: 'hsl(0,0%,16%)', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: '#fff' }}
                      cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    />
                    <Bar {...chartAnim} dataKey="cash" stackId="rev" fill="#C9A84C" radius={[3, 0, 0, 3]} />
                    <Bar {...chartAnim} dataKey="layaway" stackId="rev" fill="#378ADD" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: '#C9A84C' }} />
                    Cash: <span className="text-card-foreground font-medium tabular-nums">{fmtFull(cash)}</span>
                    <span className="text-muted-foreground/70">({pct.toFixed(1)}%)</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: '#378ADD' }} />
                    Layaway: <span className="text-card-foreground font-medium tabular-nums">{fmtFull(lay)}</span>
                    <span className="text-muted-foreground/70">({(100 - pct).toFixed(1)}%)</span>
                  </div>
                </div>
              </>
            );
          })()}
        </div>

        {/* Plan Performance Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-muted/30">
            <h3 className="text-sm font-semibold text-card-foreground">Plan Performance</h3>
          </div>
          {d.planPerformance.length === 0 ? (
            <div className="p-4 space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {['Plan', 'Accounts', 'Portfolio ¥', 'Avg Ticket', 'Monthly Inflow', 'Gross Profit', 'Contribution %', 'Target Max', 'Excess', 'Penalty Rate', 'At-Risk Rate', 'Quality', 'Risk-Adj. Profit', 'Default Rate', 'Risk Tier'].map(h => (
                      <th key={h} className={`px-5 py-2.5 font-semibold text-muted-foreground uppercase ${h === 'Plan' || h === 'Risk Tier' ? 'text-left' : 'text-right'} ${h === 'Risk Tier' ? 'text-center' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.planPerformance.map((row: any) => {
                    const hasAccounts = (row.account_count ?? 0) > 0;
                    const muted = 'text-muted-foreground';
                    return (
                      <tr key={row.plan_months} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="px-5 py-3 font-medium text-foreground">{row.display_label}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? row.account_count : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? fmtFull(row.portfolio_jpy ?? 0) : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {hasAccounts ? <span className="text-foreground">{fmtFull(row.avg_ticket_jpy ?? 0)}</span> : <span className={muted}>Min {fmtFull(row.min_amount_jpy ?? 0)}</span>}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? (Number(row.monthly_inflow ?? 0) > 0 ? fmtFull(row.monthly_inflow) : '—') : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? (Number(row.gross_profit ?? 0) > 0 ? fmtFull(row.gross_profit) : '—') : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? `${(row.contribution_pct ?? 0).toFixed(1)}%` : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{(row.target_mix_pct ?? 0).toFixed(1)}%</td>
                        <td className="px-5 py-3 text-right tabular-nums">{hasAccounts ? (
                          row.excess_pct != null && row.excess_pct !== 0 ? (
                            <span className={row.excess_pct > 0 ? 'text-destructive' : 'text-emerald-500'}>{row.excess_pct > 0 ? '▲' : '▼'} {Math.abs(row.excess_pct).toFixed(1)}%</span>
                          ) : <span className="text-muted-foreground">—</span>
                        ) : <span className={muted}>—</span>}</td>
                        <td className={`px-5 py-3 text-right tabular-nums ${hasAccounts ? ((row.plan_penalty_rate ?? 0) >= 10 ? 'text-destructive' : (row.plan_penalty_rate ?? 0) > 0 ? 'text-amber-500' : 'text-muted-foreground') : ''}`}>{hasAccounts ? `${(row.plan_penalty_rate ?? 0).toFixed(1)}%` : <span className={muted}>—</span>}</td>
                        <td className={`px-5 py-3 text-right tabular-nums ${hasAccounts ? ((row.plan_at_risk_rate ?? 0) >= 10 ? 'text-destructive' : (row.plan_at_risk_rate ?? 0) > 0 ? 'text-amber-500' : 'text-muted-foreground') : ''}`}>{hasAccounts ? `${(row.plan_at_risk_rate ?? 0).toFixed(1)}%` : <span className={muted}>—</span>}</td>
                        <td className={`px-5 py-3 text-right tabular-nums font-medium ${hasAccounts ? ((row.plan_quality_score ?? 0) >= 90 ? 'text-emerald-500' : (row.plan_quality_score ?? 0) >= 75 ? 'text-amber-500' : 'text-destructive') : ''}`}>{hasAccounts ? (row.plan_quality_score ?? 0).toFixed(1) : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? fmtFull(row.risk_adjusted_profit ?? 0) : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-right tabular-nums text-foreground">{hasAccounts ? `${(row.default_rate ?? 0).toFixed(1)}%` : <span className={muted}>—</span>}</td>
                        <td className="px-5 py-3 text-center">
                          <Badge variant="outline" className={`text-[9px] ${RISK_BADGE[row.risk_tier] || RISK_BADGE.MODERATE}`}>{row.risk_tier}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="px-5 py-2.5 text-[10px] text-muted-foreground border-t border-border">
            8M, 10M and 12M rows populate automatically when first accounts are enrolled. All figures in JPY.
          </p>
        </div>

        {/* Cohort Timeline */}
        {d.cohortTimeline.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-muted/30">
              <h3 className="text-sm font-semibold text-card-foreground">Cohort Performance Timeline</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    {['Cohort Month', 'Age', 'Plan', 'Accounts', 'Avg Ticket', 'Contract ¥', 'Expected', 'Collected', 'Collection Rate', 'Quality-Adj.', 'Reliability', 'Expected %', 'Variance', 'Δ Rate', 'Penalty Rate', 'At-Risk Rate', 'Impact', 'Direction', 'Delinquent'].map(h => (
                      <th key={h} className={`px-4 py-2.5 font-semibold text-muted-foreground uppercase ${['Cohort Month', 'Plan'].includes(h) ? 'text-left' : 'text-right'} ${['Collection Rate', 'Variance', 'Δ Rate'].includes(h) ? 'text-center' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...d.cohortTimeline].sort((a: any, b: any) => (b.impact_score ?? 0) - (a.impact_score ?? 0)).map((row: any, i: number) => {
                    const rate = row.collection_rate ?? 0;
                    const barColor = rate >= 90 ? 'bg-emerald-500' : rate >= 70 ? 'bg-amber-500' : 'bg-red-500';
                    const cellBg = rate >= 90 ? 'bg-emerald-500/5' : rate >= 70 ? 'bg-amber-500/5' : 'bg-red-500/5';
                    const textColor = rate >= 90 ? 'text-emerald-500' : rate >= 70 ? 'text-amber-500' : 'text-red-500';
                    return (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="px-4 py-2.5 text-foreground">{row.cohort_month}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{row.cohort_age_days ?? 0} days</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{row.plan_months}M</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{row.account_count}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{fmtFull(row.average_ticket ?? 0)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{fmtFull(row.total_value_jpy ?? 0)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{fmtFull(row.expected_collected ?? 0)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{fmtFull(row.actual_collected ?? 0)}</td>
                        <td className={`px-4 py-2.5 ${cellBg}`}>
                          <div className="flex items-center gap-2 justify-center">
                            <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(100, rate)}%` }} />
                            </div>
                            <span className={`tabular-nums font-medium ${textColor}`}>{rate.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${(() => { const diff = (row.collection_rate ?? 0) - (row.quality_adjusted_collection ?? 0); return diff > 15 ? 'text-destructive' : diff > 5 ? 'text-amber-500' : 'text-muted-foreground'; })()}`}>{(row.quality_adjusted_collection ?? 0).toFixed(1)}%</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${(row.reliability_score ?? 0) >= 85 ? 'text-emerald-500' : (row.reliability_score ?? 0) >= 70 ? 'text-amber-500' : 'text-destructive'}`}>{(row.reliability_score ?? 0).toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{(row.expected_progress_pct ?? 0).toFixed(1)}%</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          {row.variance_pct != null && row.variance_pct !== 0 ? (
                            <span className={row.variance_pct > 0 ? 'text-emerald-500' : 'text-destructive'}>
                              {row.variance_pct > 0 ? '▲' : '▼'} {Math.abs(row.variance_pct).toFixed(1)}%
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          {row.collection_rate_delta != null && row.collection_rate_delta !== 0 ? (
                            <span className={row.collection_rate_delta > 0 ? 'text-emerald-500' : 'text-destructive'}>
                              {row.collection_rate_delta > 0 ? '▲' : '▼'} {Math.abs(row.collection_rate_delta).toFixed(1)}%
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${(row.penalty_rate ?? 0) >= 10 ? 'text-destructive' : (row.penalty_rate ?? 0) > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>{(row.penalty_rate ?? 0).toFixed(1)}%{row.penalty_rate_trend > 0 ? <span className="text-destructive ml-1">↑</span> : row.penalty_rate_trend < 0 ? <span className="text-emerald-500 ml-1">↓</span> : null}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums ${(row.at_risk_rate ?? 0) >= 10 ? 'text-destructive' : (row.at_risk_rate ?? 0) > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>{(row.at_risk_rate ?? 0).toFixed(1)}%{row.at_risk_rate_trend > 0 ? <span className="text-destructive ml-1">↑</span> : row.at_risk_rate_trend < 0 ? <span className="text-emerald-500 ml-1">↓</span> : null}</td>
                        <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${(row.impact_score ?? 0) > 500 ? 'text-destructive' : (row.impact_score ?? 0) > 100 ? 'text-amber-500' : 'text-muted-foreground'}`}>{row.impact_score ?? 0}</td>
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          {row.directional_impact != null && row.directional_impact !== 0 ? (
                            <span className={row.directional_impact > 0 ? 'text-emerald-500' : 'text-destructive'}>
                              {row.directional_impact > 0 ? '▲' : '▼'} {Math.abs(row.directional_impact)}
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{row.delinquent_count ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CFO Insights & Recommendations */}
        {!d.loading && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-5 py-3 border-b border-border bg-muted/30">
              <h3 className="text-sm font-semibold text-card-foreground">CFO Insights & Recommendations</h3>
            </div>
            {d.cfoInsights.length === 0 ? (
              <p className="px-5 py-8 text-sm text-muted-foreground text-center">No active insights — portfolio within normal parameters.</p>
            ) : (
              <div className="p-4 space-y-3">
                {(() => {
                  const driver = d.cfoInsights[0]?.primary_driver;
                  const driverColor = driver === 'Liquidity' ? 'bg-red-500/15 text-red-500 border-red-500/30'
                    : driver === 'Growth' ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                    : 'bg-amber-500/15 text-amber-500 border-amber-500/30';
                  return driver ? (
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Primary Driver:</span>
                      <Badge variant="outline" className={`text-[9px] ${driverColor}`}>{driver}</Badge>
                    </div>
                  ) : null;
                })()}
                {d.cfoInsights.slice(0, 6).map((ins, i) => {
                  const catColor = ins.category === 'Liquidity Risk' || ins.category === 'Underperformance' ? 'border-l-red-500'
                    : ins.category === 'Strong Cohort' ? 'border-l-emerald-500'
                    : 'border-l-amber-500';
                  const badgeColor = ins.category === 'Liquidity Risk' || ins.category === 'Underperformance' ? 'bg-red-500/15 text-red-500 border-red-500/30'
                    : ins.category === 'Strong Cohort' ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
                    : 'bg-amber-500/15 text-amber-500 border-amber-500/30';
                  return (
                    <div key={i} className={`rounded-lg border border-border p-4 border-l-[3px] ${catColor}`}>
                      <div className="flex items-start gap-3">
                        <Badge variant="outline" className={`text-[9px] shrink-0 ${badgeColor}`}>{ins.category}</Badge>
                        <div className="min-w-0 space-y-1.5">
                          <p className="text-xs text-foreground">{ins.observation}</p>
                          <p className="text-[11px] text-muted-foreground"><span className="font-medium">Implication:</span> {ins.implication}</p>
                          <p className="text-[11px] text-foreground/80"><span className="font-medium">Action:</span> {ins.action}</p>
                          {ins.category === 'Concentration Risk' && ins.req_accounts_8m != null && ins.req_accounts_10m != null && (
                            <p className="text-[10px] text-muted-foreground">≈ {ins.req_accounts_8m} accounts (8M) or {ins.req_accounts_10m} accounts (10M) needed to rebalance</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function KPI({ label, value, sub, danger, extra }: { label: string; value: ReactNode; sub?: string; danger?: boolean; extra?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4 sm:p-5 border-l-[3px] border-l-primary">
      <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider pl-2">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold font-display tabular-nums pl-2 mt-1 ${danger ? 'text-destructive' : 'text-card-foreground'}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground pl-2 mt-0.5">{sub}</p>}
      {extra}
    </div>
  );
}
