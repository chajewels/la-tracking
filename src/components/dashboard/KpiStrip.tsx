import { useMemo } from 'react';
import { FileText, Banknote, AlertTriangle, Gift } from 'lucide-react';
import StatCard from '@/components/dashboard/StatCard';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { ROUTES } from '@/constants/routes';
import type { MonthlyAnalyticsRow, RedemptionsKpi } from '@/hooks/useDashboardExtras';

/**
 * Phase 3 KPI strip. Presentational — all data arrives via props so the
 * fixture harness can render any state. Figures come from existing sources
 * only (dashboard-summary edge function, get_monthly_analytics RPC,
 * loyalty_redemptions read):
 *   - Total Active Layaways: summary figure; sparkline is NEW ACCOUNTS per
 *     month ("new/mo") — an active-count HISTORY does not exist server-side.
 *   - Collections This Month: summary figure + get_monthly_analytics trend.
 *   - Overdue: figure-only by design (no overdue history exists; deriving
 *     one client-side would recompute business state).
 *   - Loyalty Redemptions: row counts; degrades to "—" if RLS denies.
 */

interface KpiStripProps {
  summaryLoading: boolean;
  activeLayaways: number | undefined;
  collectionsThisMonth: number | undefined;
  overdueCount: number | undefined;
  overdueAmount: number | undefined;
  displayCurrency: Currency;
  accounts: Array<{ order_date?: string | null; is_test?: boolean }> | undefined;
  collectedRows: MonthlyAnalyticsRow[] | undefined;
  redemptions: RedemptionsKpi | undefined;
  redemptionsUnavailable: boolean;
}

function lastSixMonthKeys(): string[] {
  const keys: string[] = [];
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 5);
  for (let i = 0; i < 6; i++) {
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }
  return keys;
}

export default function KpiStrip({
  summaryLoading,
  activeLayaways,
  collectionsThisMonth,
  overdueCount,
  overdueAmount,
  displayCurrency,
  accounts,
  collectedRows,
  redemptions,
  redemptionsUnavailable,
}: KpiStripProps) {
  // New accounts per month, by ORDER date (created_at is an import
  // timestamp, never an order date — see LOYALTY INACTIVITY notes).
  const newAccounts = useMemo(() => {
    const keys = lastSixMonthKeys();
    const byMonth = new Map<string, number>(keys.map(k => [k, 0]));
    for (const a of accounts ?? []) {
      if (a.is_test !== false) continue;
      const key = (a.order_date ?? '').slice(0, 7);
      if (byMonth.has(key)) byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
    }
    const series = keys.map(k => byMonth.get(k) ?? 0);
    return { series, thisMonth: series[5] ?? 0, lastMonth: series[4] ?? 0 };
  }, [accounts]);

  const collected = useMemo(() => {
    const rows = [...(collectedRows ?? [])].sort((a, b) => a.month.localeCompare(b.month));
    const series = rows.slice(-6).map(r => Number(r.collected_jpy ?? 0));
    const current = series[series.length - 1] ?? 0;
    const prior = series[series.length - 2] ?? 0;
    const deltaPct = prior > 0 ? Math.round(((current - prior) / prior) * 100) : null;
    return { series, deltaPct };
  }, [collectedRows]);

  if (summaryLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)}
      </div>
    );
  }

  const newDelta = newAccounts.thisMonth - newAccounts.lastMonth;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      <StatCard
        title="Total Active Layaways"
        value={(activeLayaways ?? 0).toLocaleString('en-US')}
        countUpValue={activeLayaways ?? 0}
        subtitle="new/mo"
        icon={FileText}
        variant="gold"
        staggerIndex={0}
        href={`${ROUTES.ACCOUNTS}?status=active`}
        sparkline={{ points: newAccounts.series, label: 'New accounts per month, last 6 months' }}
        trend={
          newAccounts.lastMonth > 0 || newAccounts.thisMonth > 0
            ? { value: `${Math.abs(newDelta)} new vs last mo`, positive: newDelta >= 0 }
            : undefined
        }
      />
      <StatCard
        title="Collections This Month"
        value={formatCurrency(collectionsThisMonth ?? 0, displayCurrency)}
        countUpValue={collectionsThisMonth ?? 0}
        formatValue={(n) => formatCurrency(Math.round(n), displayCurrency)}
        subtitle="Cash received"
        icon={Banknote}
        variant="gold"
        staggerIndex={1}
        sparkline={
          collected.series.length >= 2
            ? { points: collected.series, label: 'Collected per month, last 6 months' }
            : undefined
        }
        trend={
          collected.deltaPct !== null
            ? { value: `${Math.abs(collected.deltaPct)}% vs last mo`, positive: collected.deltaPct >= 0 }
            : undefined
        }
      />
      <StatCard
        title="Overdue"
        value={(overdueCount ?? 0).toLocaleString('en-US')}
        countUpValue={overdueCount ?? 0}
        subtitle={`${formatCurrency(overdueAmount ?? 0, displayCurrency)} outstanding`}
        icon={AlertTriangle}
        variant="danger"
        staggerIndex={2}
        href={`${ROUTES.MONITORING}?filter=overdue`}
      />
      <StatCard
        title="Loyalty Redemptions"
        value={redemptionsUnavailable ? '—' : (redemptions?.thisMonthCount ?? 0).toLocaleString('en-US')}
        countUpValue={redemptionsUnavailable ? undefined : redemptions?.thisMonthCount ?? 0}
        subtitle="This month"
        icon={Gift}
        staggerIndex={3}
        sparkline={
          !redemptionsUnavailable && redemptions && redemptions.series.length >= 2
            ? { points: redemptions.series, label: 'Redemptions per month, last 6 months' }
            : undefined
        }
        trend={
          !redemptionsUnavailable && redemptions && redemptions.lastMonthCount > 0
            ? {
                value: `${Math.abs(redemptions.thisMonthCount - redemptions.lastMonthCount)} vs last mo`,
                positive: redemptions.thisMonthCount >= redemptions.lastMonthCount,
              }
            : undefined
        }
      />
    </div>
  );
}
