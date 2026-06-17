import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { subMonths, startOfMonth, parseISO, isValid, format } from 'date-fns';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';

type Range = '6M' | '1Y' | 'All';
interface RpcRow { month: string; cash_jpy: number; order_count: number; }

function fmtJpy(v: number): string {
  if (v >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `¥${(v / 1_000).toFixed(0)}K`;
  return `¥${v.toFixed(0)}`;
}
function fmtFull(v: number): string { return '¥' + Math.round(v).toLocaleString(); }

const CashTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg">
      <p className="font-semibold text-zinc-200 mb-2">{label}</p>
      <div className="flex items-center gap-2 py-0.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: '#22c55e' }} />
        <span className="text-zinc-400">Cash Sales:</span>
        <span className="text-zinc-100 tabular-nums font-medium">{fmtFull(payload[0].value)}</span>
      </div>
    </div>
  );
};

export default function MonthlyCashOrdersChart() {
  const [range, setRange] = useState<Range>('1Y');
  const today = format(new Date(), 'yyyy-MM-dd');

  const { data: rows, isLoading } = useQuery({
    queryKey: ['cash-orders-monthly', today],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cash_orders_monthly');
      if (error) throw error;
      return (data || []) as RpcRow[];
    },
  });

  const { chartData, total } = useMemo(() => {
    if (!rows) return { chartData: [] as any[], total: 0 };
    const now = new Date();
    const cutoff =
      range === '6M' ? startOfMonth(subMonths(now, 5)) :
      range === '1Y' ? startOfMonth(subMonths(now, 11)) :
      null;
    const isSane = (m: string) => {
      const d = parseISO(m);
      return isValid(d) && d.getFullYear() >= 2020 && d.getFullYear() <= now.getFullYear() + 1;
    };
    const filtered = rows.filter(r => isSane(r.month) && (!cutoff || parseISO(r.month) >= cutoff));
    const chartData = filtered.map(r => ({
      label: format(parseISO(r.month), 'MMM yy'),
      cash: Math.round(Number(r.cash_jpy)),
      count: Number(r.order_count),
    }));
    const total = filtered.reduce((s, r) => s + Number(r.cash_jpy), 0);
    return { chartData, total };
  }, [rows, range]);

  return (
    <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-6">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Monthly Cash Orders</h3>
          <p className="text-xs text-zinc-500 mt-0.5">Cash-order value by month — JPY (PHP converted)</p>
        </div>
        <div className="flex gap-1">
          {(['6M', '1Y', 'All'] as Range[]).map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                range === r ? 'bg-yellow-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>
              {r}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <Skeleton className="h-[300px] w-full rounded-lg" />
      ) : chartData.length === 0 ? (
        <div className="flex items-center justify-center h-[300px] text-zinc-500 text-sm">No cash orders</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="cashOrdersGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtJpy} tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip content={<CashTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.1)' }} />
              <Area type="monotone" dataKey="cash" stroke="#22c55e" strokeWidth={2} fill="url(#cashOrdersGradient)" dot={{ r: 3, fill: '#22c55e' }} />
            </AreaChart>
          </ResponsiveContainer>
          <p className="text-xs text-zinc-400 mt-3 text-center">
            Total: {fmtFull(total)} across {chartData.length} month{chartData.length !== 1 ? 's' : ''}
          </p>
        </>
      )}
    </div>
  );
}
