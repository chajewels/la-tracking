import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { subMonths, startOfMonth, format, parseISO } from 'date-fns';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';

type Range = '6M' | '1Y' | 'All';

interface RpcRow {
  month: string; // "YYYY-MM-DD" first of month
  collected_jpy: number;
  forfeited_jpy: number;
  penalties_jpy: number;
}

interface ChartRow {
  label: string;
  collected: number;
  forfeited: number;
  penalties: number;
  newSales: number;
  isFuture: boolean;
}

function fmtJpy(v: number): string {
  if (v >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `¥${(v / 1_000).toFixed(0)}K`;
  return `¥${v.toFixed(0)}`;
}

function fmtFull(v: number): string {
  return '¥' + Math.round(v).toLocaleString();
}

function StatCard({
  label, value, subtitle, color, formatValue,
}: {
  label: string; value: number; subtitle?: string; color: string; formatValue?: (v: number) => string;
}) {
  return (
    <div className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-400 mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${color}`}>{(formatValue || fmtFull)(value)}</p>
      {subtitle && <p className="text-[10px] text-zinc-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

const LEGEND_COLORS: Record<string, string> = {
  collected: '#22c55e',
  forfeited: '#ef4444',
  penalties: '#f59e0b',
  newSales: '#a855f7',
};

const LEGEND_LABELS: Record<string, string> = {
  collected: 'Collected',
  forfeited: 'Forfeited',
  penalties: 'Penalties Paid',
  newSales: 'Monthly Sales',
};

const renderLegend = (props: any) => {
  const { payload } = props;
  return (
    <div className="flex items-center justify-center gap-5 pt-3" style={{ fontSize: 11 }}>
      {(payload || []).map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: LEGEND_COLORS[entry.dataKey] || entry.color }} />
          <span className="text-zinc-400">{LEGEND_LABELS[entry.dataKey] || entry.value}</span>
        </div>
      ))}
    </div>
  );
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg">
      <p className="font-semibold text-zinc-200 mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-2 w-2 rounded-full flex-shrink-0" style={{ background: LEGEND_COLORS[p.dataKey] || p.fill || p.stroke }} />
          <span className="text-zinc-400">{LEGEND_LABELS[p.dataKey] || p.name}:</span>
          <span className="text-zinc-100 tabular-nums font-medium">
            {p.dataKey === 'newSales' ? `${p.value} new accounts` : fmtFull(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

interface MonthlySalesRow {
  month: string;
  new_sales_count: number;
  total_sales_value: number;
}

// ── Sales chart tooltip ──
const SalesTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg">
      <p className="font-semibold text-zinc-200 mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-2 w-2 rounded-full flex-shrink-0" style={{ background: p.dataKey === 'salesValue' ? '#f59e0b' : '#a855f7' }} />
          <span className="text-zinc-400">{p.dataKey === 'salesValue' ? 'Sales Value' : 'New Accounts'}:</span>
          <span className="text-zinc-100 tabular-nums font-medium">
            {p.dataKey === 'salesValue' ? fmtFull(p.value) : `${p.value} accounts`}
          </span>
        </div>
      ))}
    </div>
  );
};

const renderSalesLegend = (props: any) => {
  const { payload } = props;
  return (
    <div className="flex items-center justify-center gap-5 pt-3" style={{ fontSize: 11 }}>
      {(payload || []).map((entry: any) => (
        <div key={entry.dataKey} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: entry.dataKey === 'salesValue' ? '#f59e0b' : '#a855f7' }} />
          <span className="text-zinc-400">{entry.dataKey === 'salesValue' ? 'Sales Value' : 'New Accounts'}</span>
        </div>
      ))}
    </div>
  );
};

export default function MonthlyAnalyticsChart({ monthlySalesData }: { monthlySalesData?: MonthlySalesRow[] } = {}) {
  const [range, setRange] = useState<Range>('1Y');
  const today = format(new Date(), 'yyyy-MM-dd');

  const salesByLabel = useMemo(() => {
    const map = new Map<string, number>();
    if (!monthlySalesData) return map;
    for (const row of monthlySalesData) {
      map.set(row.month, row.new_sales_count);
    }
    return map;
  }, [monthlySalesData]);

  const thisMonthSalesCount = useMemo(() => {
    if (!monthlySalesData?.length) return 0;
    const now = new Date();
    const thisMonthLabel = now.toLocaleString('en-US', { month: 'short' }) + ' ' + now.getFullYear();
    return monthlySalesData.find(d => d.month === thisMonthLabel)?.new_sales_count ?? 0;
  }, [monthlySalesData]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['monthly-analytics', today],
    staleTime: 0,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_monthly_analytics');
      if (error) throw error;
      return (data || []) as RpcRow[];
    },
  });

  const {
    chartData,
    collectedToDate,
    collectedTotal,
    totalForfeited,
    totalPenalties,
    currentMonthLabel,
    hasFutureMonths,
  } = useMemo(() => {
    if (!rows) return {
      chartData: [] as ChartRow[], collectedToDate: 0, collectedTotal: 0,
      totalForfeited: 0, totalPenalties: 0, currentMonthLabel: '', hasFutureMonths: false,
    };

    const now = new Date();
    const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const currentMonthLbl   = format(startOfMonth(now), 'MMM yy');

    const cutoff =
      range === '6M' ? startOfMonth(subMonths(now, 5)) :
      range === '1Y' ? startOfMonth(subMonths(now, 11)) :
      null;

    const filtered = rows.filter(r => !cutoff || parseISO(r.month) >= cutoff);

    const chartData: ChartRow[] = filtered.map(r => {
      const label = format(parseISO(r.month), 'MMM yy');
      const fullLabel = format(parseISO(r.month), 'MMM yyyy');
      return {
        label,
        collected:  Math.round(Number(r.collected_jpy)),
        forfeited:  Math.round(Number(r.forfeited_jpy)),
        penalties:  Math.round(Number(r.penalties_jpy)),
        newSales:   salesByLabel.get(fullLabel) || 0,
        isFuture:   r.month > currentMonthStart,
      };
    });

    const collectedToDate = filtered
      .filter(r => r.month <= currentMonthStart)
      .reduce((s, r) => s + Number(r.collected_jpy), 0);
    const collectedTotal  = filtered.reduce((s, r) => s + Number(r.collected_jpy), 0);
    const totalForfeited  = filtered.reduce((s, r) => s + Number(r.forfeited_jpy), 0);
    const totalPenalties  = filtered.reduce((s, r) => s + Number(r.penalties_jpy), 0);

    const hasFutureMonths = chartData.some(d => d.isFuture);

    return {
      chartData, collectedToDate, collectedTotal,
      totalForfeited, totalPenalties,
      currentMonthLabel: currentMonthLbl,
      hasFutureMonths,
    };
  }, [rows, range, salesByLabel]);

  const advanceAmount = collectedTotal - collectedToDate;

  // ── Sales chart data ──
  const [salesYear, setSalesYear] = useState<string>(String(new Date().getFullYear()));

  const { salesChartData, salesYears, salesTotalValue, salesTotalCount } = useMemo(() => {
    if (!monthlySalesData?.length) return { salesChartData: [], salesYears: [], salesTotalValue: 0, salesTotalCount: 0 };

    const years = [...new Set(monthlySalesData.map(d => {
      const parts = d.month.split(' ');
      return parts[parts.length - 1];
    }))].sort();

    const filtered = salesYear === 'All'
      ? monthlySalesData
      : monthlySalesData.filter(d => d.month.endsWith(salesYear));

    const chartRows = filtered.map(d => ({
      label: d.month,
      salesValue: Math.round(Number(d.total_sales_value)),
      salesCount: Number(d.new_sales_count),
    }));

    const totalValue = filtered.reduce((s, d) => s + Number(d.total_sales_value), 0);
    const totalCount = filtered.reduce((s, d) => s + d.new_sales_count, 0);

    return { salesChartData: chartRows, salesYears: years, salesTotalValue: totalValue, salesTotalCount: totalCount };
  }, [monthlySalesData, salesYear]);

  return (
    <>
      <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h3 className="text-sm font-semibold text-zinc-100">Monthly Performance</h3>
            <p className="text-xs text-zinc-500 mt-0.5">Collected · Forfeited · Penalties · Monthly Sales — All amounts in JPY</p>
          </div>
          <div className="flex gap-1">
            {(['6M', '1Y', 'All'] as Range[]).map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  range === r
                    ? 'bg-yellow-600 text-white'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Stat cards */}
        {isLoading ? (
          <div className="flex gap-3 mb-5">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="flex-1 h-16 rounded-xl" />)}
          </div>
        ) : (
          <div className="flex gap-3 mb-5">
            <StatCard
              label="Total Collected"
              value={collectedTotal}
              color="text-green-400"
              subtitle={hasFutureMonths && advanceAmount > 0
                ? `${fmtFull(collectedToDate)} to date · ${fmtFull(advanceAmount)} advance`
                : undefined}
            />
            <StatCard label="Total Forfeited" value={totalForfeited} color="text-red-400"   />
            <StatCard label="Penalties Paid"  value={totalPenalties} color="text-amber-400" />
            <StatCard label="Monthly Sales" value={thisMonthSalesCount} color="text-purple-400" subtitle="this month" formatValue={v => String(v)} />
          </div>
        )}

        {/* Chart */}
        {isLoading ? (
          <Skeleton className="h-[400px] w-full rounded-lg" />
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-[400px] text-zinc-500 text-sm">
            No data available
          </div>
        ) : (
          <>
            {hasFutureMonths && (
              <p className="text-[10px] text-zinc-500 mb-3 flex items-center gap-1.5">
                <span className="inline-block w-8 h-1.5 rounded" style={{ background: 'repeating-linear-gradient(90deg,#71717a 0,#71717a 4px,transparent 4px,transparent 6px)' }} />
                Faded bars = advance payments (future months)
              </p>
            )}
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={chartData} margin={{ top: 16, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#a1a1aa', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tickFormatter={fmtJpy}
                  tick={{ fill: '#a1a1aa', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  allowDecimals={false}
                  tick={{ fill: '#a1a1aa', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                  label={{ value: 'Sales', angle: 90, position: 'insideRight', fill: '#71717a', fontSize: 10, dx: 12 }}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Legend content={renderLegend} />
                {/* Today marker — vertical dashed line at current month */}
                <ReferenceLine
                  yAxisId="left"
                  x={currentMonthLabel}
                  stroke="#71717a"
                  strokeDasharray="4 3"
                  label={{ value: 'Today', position: 'top', fill: '#a1a1aa', fontSize: 10 }}
                />
                <Bar dataKey="collected" name="collected" yAxisId="left" radius={[3, 3, 0, 0]} maxBarSize={32}>
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill="#22c55e"
                      fillOpacity={entry.isFuture ? 0.35 : 1}
                      stroke={entry.isFuture ? '#22c55e' : 'none'}
                      strokeWidth={entry.isFuture ? 1 : 0}
                      strokeDasharray={entry.isFuture ? '3 2' : undefined}
                    />
                  ))}
                </Bar>
                <Bar dataKey="forfeited" name="forfeited" yAxisId="left" radius={[3, 3, 0, 0]} maxBarSize={32}>
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill="#ef4444"
                      fillOpacity={entry.isFuture ? 0.35 : 1}
                      stroke={entry.isFuture ? '#ef4444' : 'none'}
                      strokeWidth={entry.isFuture ? 1 : 0}
                      strokeDasharray={entry.isFuture ? '3 2' : undefined}
                    />
                  ))}
                </Bar>
                <Bar dataKey="penalties" name="penalties" yAxisId="left" radius={[3, 3, 0, 0]} maxBarSize={32}>
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill="#f59e0b"
                      fillOpacity={entry.isFuture ? 0.35 : 1}
                      stroke={entry.isFuture ? '#f59e0b' : 'none'}
                      strokeWidth={entry.isFuture ? 1 : 0}
                      strokeDasharray={entry.isFuture ? '3 2' : undefined}
                    />
                  ))}
                </Bar>
                <Bar dataKey="newSales" name="newSales" yAxisId="right" radius={[3, 3, 0, 0]} maxBarSize={24}>
                  {chartData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill="#a855f7"
                      fillOpacity={entry.isFuture ? 0.35 : 1}
                      stroke={entry.isFuture ? '#a855f7' : 'none'}
                      strokeWidth={entry.isFuture ? 1 : 0}
                      strokeDasharray={entry.isFuture ? '3 2' : undefined}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </>
        )}
      </div>

      {/* ── Monthly Layaway Sales chart ── */}
      {monthlySalesData && monthlySalesData.length > 0 && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-6">
          <div className="flex items-start justify-between mb-5">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">Monthly Layaway Sales</h3>
              <p className="text-xs text-zinc-500 mt-0.5">New accounts by first payment month</p>
            </div>
            <div className="flex gap-1">
              {[...salesYears, 'All'].map(y => (
                <button
                  key={y}
                  onClick={() => setSalesYear(y)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    salesYear === y
                      ? 'bg-yellow-600 text-white'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  {y}
                </button>
              ))}
            </div>
          </div>

          {salesChartData.length === 0 ? (
            <div className="flex items-center justify-center h-[280px] text-zinc-500 text-sm">
              No sales data for {salesYear}
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={salesChartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: '#a1a1aa', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="left"
                    tickFormatter={fmtJpy}
                    tick={{ fill: '#a1a1aa', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    allowDecimals={false}
                    tick={{ fill: '#a1a1aa', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                  />
                  <Tooltip content={<SalesTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                  <Legend content={renderSalesLegend} />
                  <Bar dataKey="salesValue" name="salesValue" yAxisId="left" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={36} />
                  <Bar dataKey="salesCount" name="salesCount" yAxisId="right" fill="#a855f7" radius={[3, 3, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-zinc-400 mt-3 text-center">
                Total: {fmtFull(salesTotalValue)} from {salesTotalCount} new account{salesTotalCount !== 1 ? 's' : ''}
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
