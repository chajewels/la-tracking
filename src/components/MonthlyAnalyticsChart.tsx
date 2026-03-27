import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { subMonths, startOfMonth, format, parseISO } from 'date-fns';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';

type Range = '6M' | '1Y' | 'All';

interface RpcRow {
  month: string;
  collected_jpy: number;
  forfeited_jpy: number;
  penalties_jpy: number;
}

interface ChartRow {
  label: string;
  collected: number;
  forfeited: number;
  penalties: number;
}

function fmtJpy(v: number): string {
  if (v >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `¥${(v / 1_000).toFixed(0)}K`;
  return `¥${v.toFixed(0)}`;
}

function fmtFull(v: number): string {
  return '¥' + Math.round(v).toLocaleString();
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
      <p className="text-xs text-zinc-400 mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${color}`}>{fmtFull(value)}</p>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg">
      <p className="font-semibold text-zinc-200 mb-2">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-2 w-2 rounded-full flex-shrink-0" style={{ background: p.fill }} />
          <span className="text-zinc-400">{p.name}:</span>
          <span className="text-zinc-100 tabular-nums font-medium">{fmtFull(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

export default function MonthlyAnalyticsChart() {
  const [range, setRange] = useState<Range>('1Y');

  const { data: rows, isLoading } = useQuery({
    queryKey: ['monthly-analytics'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_monthly_analytics');
      if (error) throw error;
      return (data || []) as RpcRow[];
    },
  });

  const { chartData, totalCollected, totalForfeited, totalPenalties } = useMemo(() => {
    if (!rows) return { chartData: [], totalCollected: 0, totalForfeited: 0, totalPenalties: 0 };

    const cutoff =
      range === '6M' ? startOfMonth(subMonths(new Date(), 5)) :
      range === '1Y' ? startOfMonth(subMonths(new Date(), 11)) :
      null;

    const filtered = rows.filter(r => !cutoff || parseISO(r.month) >= cutoff);

    const chartData: ChartRow[] = filtered.map(r => ({
      label: format(parseISO(r.month), 'MMM yy'),
      collected: Math.round(Number(r.collected_jpy)),
      forfeited: Math.round(Number(r.forfeited_jpy)),
      penalties: Math.round(Number(r.penalties_jpy)),
    }));

    const totalCollected = filtered.reduce((s, r) => s + Number(r.collected_jpy), 0);
    const totalForfeited = filtered.reduce((s, r) => s + Number(r.forfeited_jpy), 0);
    const totalPenalties = filtered.reduce((s, r) => s + Number(r.penalties_jpy), 0);

    return { chartData, totalCollected, totalForfeited, totalPenalties };
  }, [rows, range]);

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Monthly Performance</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Collected · Forfeited · Penalties — All in JPY</p>
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
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="flex-1 h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="flex gap-3 mb-5">
          <StatCard label="Total Collected"  value={totalCollected}  color="text-green-400" />
          <StatCard label="Total Forfeited"  value={totalForfeited}  color="text-red-400"   />
          <StatCard label="Total Penalties"  value={totalPenalties}  color="text-amber-400" />
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
        <ResponsiveContainer width="100%" height={400}>
          <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={fmtJpy}
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            <Legend
              wrapperStyle={{ fontSize: 11, color: '#a1a1aa', paddingTop: 12 }}
              formatter={(value) =>
                value === 'collected' ? 'Collected' :
                value === 'forfeited' ? 'Forfeited' : 'Penalties Paid'
              }
            />
            <Bar dataKey="collected" name="collected" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={32} />
            <Bar dataKey="forfeited" name="forfeited" fill="#ef4444" radius={[3, 3, 0, 0]} maxBarSize={32} />
            <Bar dataKey="penalties" name="penalties" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
