import { useMemo } from 'react';
import { useChartAnimation } from '@/hooks/useChartAnimation';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/EmptyState';
import { chartColors, palette } from '@/theme/tokens';
import type { MonthlyAnalyticsRow } from '@/hooks/useDashboardExtras';

/**
 * Dashboard hero chart: "Collected — last 12 months".
 * Single series (cash actually received, bucketed by PAYMENT date — the
 * "Collected" metric per the CHART TERMINOLOGY standard). Deliberately NO
 * target overlay and NO schedule-expected overlay: no target data exists,
 * and "Paid vs Due" (schedule efficiency) lives on Finance.
 * Fed by get_monthly_analytics (existing RPC; cache shared with Finance).
 * Single series → no legend (the title names it); labels wear ink tokens.
 */

function fmtMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return d.toLocaleString('en-US', { month: 'short' });
}

function fmtYenCompact(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `¥${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `¥${Math.round(v / 1_000)}K`;
  return `¥${Math.round(v)}`;
}

const HeroTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="text-muted-foreground mb-0.5">{label}</p>
      <p className="font-semibold text-champagne tabular-nums">
        ¥{Math.round(payload[0].value).toLocaleString('en-US')}
      </p>
    </div>
  );
};

export default function CollectionsHeroChart({
  rows,
  loading,
  error = false,
  onRetry,
}: {
  rows: MonthlyAnalyticsRow[] | undefined;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const chartAnim = useChartAnimation();
  const data = useMemo(
    () =>
      [...(rows ?? [])]
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12)
        .map(r => ({ month: fmtMonth(r.month), collected: Number(r.collected_jpy ?? 0) })),
    [rows],
  );

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2 pb-3 hairline-b mb-3">
        <h3 className="text-sm font-semibold text-card-foreground">Collected — last 12 months</h3>
        <span className="label-caps">¥ · by payment date</span>
      </div>
      {error ? (
        <ErrorState compact message="Couldn't load the collections trend. Your other dashboard data is unaffected." onRetry={onRetry} />
      ) : loading ? (
        <Skeleton className="h-56 w-full rounded-lg" />
      ) : data.length === 0 ? (
        <div className="h-56 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">No collection data yet.</p>
        </div>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <defs>
                <linearGradient id="heroCollectedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartColors.primary} stopOpacity={0.30} />
                  <stop offset="100%" stopColor={chartColors.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={chartColors.grid} vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: palette.inkMuted, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={fmtYenCompact}
                tick={{ fill: palette.inkMuted, fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={52}
              />
              <Tooltip content={<HeroTooltip />} cursor={{ stroke: chartColors.grid, strokeWidth: 1 }} />
              <Area {...chartAnim}
                type="monotone"
                dataKey="collected"
                stroke={chartColors.primary}
                strokeWidth={2}
                fill="url(#heroCollectedFill)"
                dot={false}
                activeDot={{ r: 4, fill: chartColors.primary, stroke: palette.surface1, strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
