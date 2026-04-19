import { useState, type ReactNode } from 'react';
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
  const d = useExecutiveDashboard();
  const inflowData = useMonthlyInflowByPlan();
  const donutData = useActiveByPlan();
  const alerts = useFinancialAlerts();
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

        {/* KPI Row 1 */}
        {d.loading ? (
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            <KPI label="Portfolio Value" value={fmtM(d.portfolioValue)} sub="Active accounts only" />
            <KPI label="Active Gross Profit" value={fmtM(d.grossProfit?.active_gross_profit ?? 0)} sub="15% on active portfolio" />
            <KPI label="Lifetime Gross Profit" value={fmtM(d.grossProfit?.lifetime_gross_profit ?? 0)} sub="15% on all-time contracts" />
            <KPI label="Monthly Inflow" value={fmtM(d.monthlyInflow?.total_inflow ?? 0)}
              sub={`Installments ${fmtM(d.monthlyInflow?.installment_inflow ?? 0)} · Penalties ${fmtM(d.monthlyInflow?.penalty_inflow ?? 0)}`} />
            <KPI label="Net Exposure Risk" value={fmtM(d.netExposure?.net_exposure ?? 0)} danger
              sub={`${fmtM(d.netExposure?.gross_exposure ?? 0)} gross · ${fmtM(recovered)} recovered`}
              extra={d.netExposure?.exposure_change ? (
                <p className={`text-[10px] pl-2 font-medium tabular-nums ${d.netExposure.exposure_change > 0 ? 'text-destructive' : 'text-emerald-500'}`}>
                  {d.netExposure.exposure_change > 0 ? '▲' : '▼'} {fmtM(Math.abs(d.netExposure.exposure_change))} vs last month
                </p>
              ) : undefined} />
            <div className={`relative overflow-hidden rounded-xl border bg-card p-4 sm:p-5 border-l-[3px] ${coverageColor}`}>
              <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider pl-2">Cash Flow Coverage</p>
              <p className="text-xl sm:text-2xl font-bold font-display tabular-nums pl-2 mt-1">{(d.coverageRatio?.coverage_ratio ?? 0).toFixed(2)}×</p>
              <p className={`text-[10px] pl-2 font-semibold uppercase tracking-wider ${coverageLabelColor}`}>{d.coverageRatio?.status_label ?? '—'}</p>
              <div className="mt-2 pl-2 space-y-0.5 text-[10px] tabular-nums">
                <div className="flex justify-between text-muted-foreground"><span>Cash In</span><span>{fmtM(d.coverageRatio?.cash_in ?? 0)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Inventory Cost</span><span>{fmtM(d.coverageRatio?.inventory_cost ?? 0)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Funding Gap</span><span className={(d.coverageRatio?.funding_gap ?? 0) >= 0 ? 'text-emerald-500' : 'text-destructive'}>{fmtM(d.coverageRatio?.funding_gap ?? 0)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Days Covered</span><span>{(d.coverageRatio?.days_covered ?? 0).toFixed(1)} days</span></div>
              </div>
            </div>
          </div>
        )}

        {/* KPI Row 2 */}
        {!d.loading && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* At-Risk */}
            <div className="rounded-xl border border-border bg-card p-5 cursor-pointer hover:border-primary/30 transition-colors" onClick={() => setRiskOpen(!riskOpen)}>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">At-Risk Accounts</p>
              <p className="text-2xl font-bold font-display tabular-nums mt-1">{d.atRisk?.total_at_risk ?? 0} <span className="text-sm font-normal text-muted-foreground">accounts</span></p>
              <p className="text-xs text-muted-foreground">{(d.atRisk?.at_risk_pct ?? 0).toFixed(1)}% of active accounts</p>
              {(d.atRisk?.critical_count ?? 0) > 0 && <p className="text-xs text-destructive font-medium mt-0.5">{d.atRisk!.critical_count} critical</p>}
              <p className="text-[9px] text-muted-foreground mt-1">{riskOpen ? 'Click to collapse ▲' : 'Click to expand ▼'}</p>
            </div>
            {/* Penalty Revenue */}
            <KPI label="Penalty Revenue (This Month)" value={fmtFull(d.penaltyRevenue?.current_month_jpy ?? 0)}
              sub={`${fmtFull(d.penaltyRevenue?.cumulative_jpy ?? 0)} cumulative all-time`}
              extra={d.penaltyRevenue?.penalty_pct_of_inflow != null ? (
                <p className={`text-[10px] pl-2 tabular-nums ${(d.penaltyRevenue.penalty_pct_of_inflow > 5) ? 'text-destructive' : (d.penaltyRevenue.penalty_pct_of_inflow > 2) ? 'text-amber-500' : 'text-muted-foreground'}`}>
                  {d.penaltyRevenue.penalty_pct_of_inflow.toFixed(2)}% of monthly inflow
                </p>
              ) : undefined} />
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
                  </tr>
                </thead>
                <tbody>
                  {d.atRiskDetail.map((r: any, i: number) => (
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
                    </tr>
                  ))}
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
                    <Bar key={pm} dataKey={`plan_${pm}`} stackId="inflow" fill={PLAN_COLORS[pm]}
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
                    <Pie data={donutData} dataKey="count" nameKey="plan" cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={2}>
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
                    {['Plan', 'Accounts', 'Portfolio ¥', 'Avg Ticket', 'Monthly Inflow', 'Gross Profit', 'Contribution %', 'Risk-Adj. Profit', 'Default Rate', 'Risk Tier'].map(h => (
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
                    {['Cohort Month', 'Plan', 'Accounts', 'Contract ¥', 'Expected', 'Collected', 'Collection Rate', 'Δ Rate', 'Delinquent'].map(h => (
                      <th key={h} className={`px-4 py-2.5 font-semibold text-muted-foreground uppercase ${['Cohort Month', 'Plan'].includes(h) ? 'text-left' : 'text-right'} ${h === 'Collection Rate' ? 'text-center' : ''}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.cohortTimeline.map((row: any, i: number) => {
                    const rate = row.collection_rate ?? 0;
                    const barColor = rate >= 90 ? 'bg-emerald-500' : rate >= 70 ? 'bg-amber-500' : 'bg-red-500';
                    const cellBg = rate >= 90 ? 'bg-emerald-500/5' : rate >= 70 ? 'bg-amber-500/5' : 'bg-red-500/5';
                    const textColor = rate >= 90 ? 'text-emerald-500' : rate >= 70 ? 'text-amber-500' : 'text-red-500';
                    return (
                      <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                        <td className="px-4 py-2.5 text-foreground">{row.cohort_month}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{row.plan_months}M</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-foreground">{row.account_count}</td>
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
                        <td className="px-4 py-2.5 text-center tabular-nums">
                          {row.collection_rate_delta != null && row.collection_rate_delta !== 0 ? (
                            <span className={row.collection_rate_delta > 0 ? 'text-emerald-500' : 'text-destructive'}>
                              {row.collection_rate_delta > 0 ? '▲' : '▼'} {Math.abs(row.collection_rate_delta).toFixed(1)}%
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
      </div>
    </AppLayout>
  );
}

function KPI({ label, value, sub, danger, extra }: { label: string; value: string; sub?: string; danger?: boolean; extra?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4 sm:p-5 border-l-[3px] border-l-[#D4AF37]">
      <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wider pl-2">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold font-display tabular-nums pl-2 mt-1 ${danger ? 'text-destructive' : 'text-card-foreground'}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground pl-2 mt-0.5">{sub}</p>}
      {extra}
    </div>
  );
}
