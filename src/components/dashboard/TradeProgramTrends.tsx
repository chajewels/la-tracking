import { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

interface TradeMonthlyTrend {
  month: string;
  trade_count: number;
  trade_value_jpy: number;
}

function fmtJpyShort(v: number): string {
  if (v >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `¥${(v / 1_000).toFixed(0)}K`;
  return `¥${v.toFixed(0)}`;
}

function fmtJpyFull(v: number): string {
  return '¥' + Math.round(v).toLocaleString();
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(ym: string): string {
  // Accepts "YYYY-MM" (or "YYYY-MM-DD") and returns "MMM YY"
  const match = /^(\d{4})-(\d{2})/.exec(ym);
  if (!match) return ym;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (!month || month < 1 || month > 12) return ym;
  return `${MONTH_NAMES[month - 1]} ${String(year).slice(2)}`;
}

interface TooltipPayload {
  name?: string;
  value?: number;
  dataKey?: string;
  color?: string;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg">
      <div className="font-semibold text-zinc-100 mb-1.5">{label}</div>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center justify-between gap-4 tabular-nums">
          <span className="flex items-center gap-1.5" style={{ color: entry.color }}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: entry.color }} />
            {entry.name}
          </span>
          <span className="text-zinc-100 font-medium">
            {entry.dataKey === 'trade_value_jpy' ? fmtJpyFull(entry.value ?? 0) : (entry.value ?? 0).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function TradeProgramTrends({ data }: { data: TradeMonthlyTrend[] }) {
  const chartData = useMemo(
    () => data.map(d => ({
      ...d,
      label: monthLabel(d.month),
    })),
    [data],
  );

  const hasActivity = chartData.some(d => (d.trade_count ?? 0) > 0 || (d.trade_value_jpy ?? 0) > 0);

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Trade Program Trends</h3>
          <p className="text-[11px] text-zinc-400 mt-0.5">Last 12 months — new trade transactions</p>
        </div>
      </div>

      {!hasActivity ? (
        <div className="flex items-center justify-center h-48 text-xs text-zinc-500">
          No trade activity in the last 12 months
        </div>
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="tradeProgramGradient1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a855f7" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="tradeProgramGradient2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" />
              <XAxis
                dataKey="label"
                stroke="#a1a1aa"
                tick={{ fontSize: 11 }}
              />
              <YAxis
                yAxisId="left"
                stroke="#a1a1aa"
                tick={{ fontSize: 11 }}
                allowDecimals={false}
                label={{ value: 'Trades', angle: -90, position: 'insideLeft', style: { fill: '#a1a1aa', fontSize: 11 } }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#a1a1aa"
                tick={{ fontSize: 11 }}
                tickFormatter={fmtJpyShort}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11, paddingBottom: 8 }} verticalAlign="top" />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="trade_count"
                stroke="#a855f7"
                strokeWidth={2}
                name="Count"
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                fill="url(#tradeProgramGradient1)"
              />
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="trade_value_jpy"
                stroke="#22c55e"
                strokeWidth={2}
                name="Value (¥)"
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                fill="url(#tradeProgramGradient2)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
