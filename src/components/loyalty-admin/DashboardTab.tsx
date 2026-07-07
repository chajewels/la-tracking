import { Link } from 'react-router-dom';
import { useChartAnimation } from '@/hooks/useChartAnimation';
import AnimatedNumber from '@/components/shared/AnimatedNumber';
import { type ReactNode } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Sparkles, Users, Coins, ArrowRight, Crown, TrendingUp } from 'lucide-react';
import { useLoyaltyAdminStats } from '@/hooks/loyalty-admin/useLoyaltyAdminStats';

const TIER_FALLBACK_COLOR: Record<string, string> = {
  Glimmer: '#9CA3AF',
  Radiant: '#FBBF24',
  Elite: '#A855F7',
  'Crown VIP': '#EF4444',
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface StatCardProps {
  label: string;
  value: string | number | ReactNode;
  hint?: string;
  Icon?: typeof Users;
  tone?: 'default' | 'amber' | 'emerald' | 'primary';
}

function StatCard({ label, value, hint, Icon, tone = 'default' }: StatCardProps) {
  const toneCls =
    tone === 'amber'
      ? 'bg-amber-500/10 text-amber-600'
      : tone === 'emerald'
      ? 'bg-emerald-500/10 text-emerald-600'
      : tone === 'primary'
      ? 'bg-primary/10 text-primary'
      : 'bg-muted text-muted-foreground';

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && (
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${toneCls}`}>
            <Icon className="h-4 w-4" />
          </div>
        )}
      </div>
      <p className="text-2xl font-bold tabular-nums text-foreground">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function DashboardTab({
  onJumpToRedemptions,
  onJumpToMember,
}: {
  onJumpToRedemptions: () => void;
  onJumpToMember: (memberId: string) => void;
}) {
  const chartAnim = useChartAnimation();
  const { data, isLoading, isError } = useLoyaltyAdminStats();

  if (isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-sm text-destructive">Failed to load loyalty stats</p>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const tiersForChart = data.tierBreakdown.map((t) => ({
    name: t.tier_name,
    value: t.count,
    color: t.color_hex || TIER_FALLBACK_COLOR[t.tier_name] || '#94A3B8',
  }));

  return (
    <div className="space-y-5">
      {/* Top stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Members"
          value={<AnimatedNumber value={data.totalMembers} />}
          Icon={Users}
          tone="primary"
        />
        <StatCard
          label="Points Outstanding"
          value={<AnimatedNumber value={data.pointsOutstanding} />}
          hint="Total unredeemed across all members"
          Icon={Coins}
          tone="amber"
        />
        <StatCard
          label="Points Redeemed"
          value={<AnimatedNumber value={data.pointsRedeemed} />}
          hint="All-time redeemed total"
          Icon={Sparkles}
          tone="emerald"
        />
        <button
          type="button"
          onClick={onJumpToRedemptions}
          className="text-left transition-colors"
        >
          <StatCard
            label="Pending Redemptions"
            value={<AnimatedNumber value={data.pendingRedemptions} format={(n) => String(Math.round(n))} />}
            hint="Click to review →"
            Icon={ArrowRight}
            tone={data.pendingRedemptions > 0 ? 'amber' : 'default'}
          />
        </button>
      </div>

      {/* Cumulative spend banner */}
      <div className="rounded-xl border border-primary/30 bg-card p-5 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg gold-gradient">
          <TrendingUp className="h-6 w-6 text-primary-foreground" />
        </div>
        <div className="flex-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Total Cumulative Spend (loyalty-eligible)
          </p>
          <p className="text-2xl font-bold tabular-nums text-foreground mt-0.5">
            ¥<AnimatedNumber value={data.totalCumulativeSpendJpy} />
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Sum of all enrolled members' lifetime spend in JPY
          </p>
        </div>
      </div>

      {/* Tier breakdown + donut */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">Members by Tier</h3>
            <Crown className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            {data.tierBreakdown.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-4 text-center">
                No members enrolled yet
              </p>
            ) : (
              data.tierBreakdown.map((t) => {
                const color = t.color_hex || TIER_FALLBACK_COLOR[t.tier_name] || '#94A3B8';
                const pct = data.totalMembers
                  ? Math.round((t.count / data.totalMembers) * 100)
                  : 0;
                return (
                  <div key={t.tier_name}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ background: color }}
                        />
                        <span className="text-sm font-medium text-foreground">
                          {t.tier_name}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 tabular-nums">
                        <span className="text-sm font-semibold">{t.count}</span>
                        <span className="text-[11px] text-muted-foreground w-10 text-right">
                          {pct}%
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full transition-all"
                        style={{ width: `${pct}%`, background: color }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-foreground mb-3">Tier Distribution</h3>
          {tiersForChart.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-12 text-center">
              No data to chart
            </p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie {...chartAnim}
                    data={tiersForChart}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {tiersForChart.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `${value.toLocaleString()} members`,
                      name,
                    ]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Recent enrollments */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Recent Enrollments</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Last 7 days</p>
          </div>
          <Sparkles className="h-4 w-4 text-muted-foreground" />
        </div>
        {data.recentEnrollments.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-muted-foreground italic">
              No new enrollments in the last 7 days
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentEnrollments.map((r) => (
                <TableRow
                  key={r.member_id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => onJumpToMember(r.member_id)}
                >
                  <TableCell className="text-xs">{fmtDate(r.enrolled_at)}</TableCell>
                  <TableCell className="text-xs">
                    <div className="text-foreground font-medium">{r.full_name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">
                      {r.customer_code ?? '—'}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">{r.tier_name}</TableCell>
                  <TableCell className="text-right">
                    <Link
                      to={`/customers/${r.customer_id}?tab=loyalty`}
                      className="text-[11px] text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      Open →
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
