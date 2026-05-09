import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Diamond, Sparkles, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

import MemberCard from '@/components/loyalty/MemberCard';
import PointsSnapshot from '@/components/loyalty/PointsSnapshot';
import VipProgressSection from '@/components/loyalty/VipProgressSection';
import RecentActivity from '@/components/loyalty/RecentActivity';
import { RedemptionApprovalModal } from '@/components/loyalty/RedemptionApprovalModal';
import {
  setLoyaltyData,
  TIER_STATIC,
  type TierName,
  type LoyaltyMemberData,
  type LoyaltyTierData,
  type LoyaltyTransactionData,
} from '@/components/loyalty/loyaltyData';

type LoyaltyTransactionType = 'earned' | 'bonus' | 'redeemed' | 'expired' | 'adjusted';

interface LoyaltyTxRow {
  id: string;
  transaction_type: LoyaltyTransactionType;
  points_amount: number;
  spend_amount_jpy: number | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes: string | null;
  created_at: string;
}

interface TierRow {
  name: string;
  min_spend_jpy: number;
  points_multiplier: number;
  color_hex: string | null;
}

interface TierLite {
  name: string;
  points_multiplier: number;
  color_hex: string | null;
}

interface LoyaltyMemberRow {
  id: string;
  customer_id: string;
  cumulative_spend_jpy: number;
  earned_tier_id: string;
  current_tier_id: string;
  is_downgraded: boolean;
  last_purchase_at: string | null;
  prev_purchase_at: string | null;
  pre_expiry_warned_at: string | null;
  total_points_earned: number;
  total_points_redeemed: number;
  total_points_expired: number;
  remaining_points: number;
  enrolled_at: string;
  earned_tier: TierLite | null;
  current_tier: TierLite | null;
}

interface RedemptionRow {
  id: string;
  redemption_type: string;
  points_redeemed: number;
  value_applied_jpy: number;
  value_applied_php: number | null;
  invoice_number: string;
  status: 'pending' | 'confirmed' | 'cancelled' | string;
  created_at: string;
  processed_at: string | null;
}

interface CustomerLite {
  id: string;
  full_name: string;
  customer_code: string;
  email: string | null;
}

interface LoyaltyData {
  customer: CustomerLite | null;
  member: LoyaltyMemberRow | null;
  transactions: LoyaltyTxRow[];
  redemptions: RedemptionRow[];
  tiers: TierRow[];
  isBeta: boolean;
}

type ActivityFilter = 'all' | LoyaltyTransactionType;

const FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'earned', label: 'Earned' },
  { value: 'redeemed', label: 'Redeemed' },
  { value: 'bonus', label: 'Bonus' },
  { value: 'expired', label: 'Expired' },
  { value: 'adjusted', label: 'Adjusted' },
];

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtRedemptionType(t: string) {
  switch (t) {
    case 'new_order_discount': return 'New Order Discount';
    case 'shipping_fee': return 'Shipping Fee';
    case 'service_fee': return 'Service Fee';
    default: return t;
  }
}

function useCustomerLoyalty(customerId: string | undefined) {
  return useQuery<LoyaltyData>({
    queryKey: ['customer-loyalty', customerId],
    enabled: !!customerId,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [memberRes, tiersRes, customerRes, betaRes] = await Promise.all([
        supabase
          .from('loyalty_members')
          .select(
            'id, customer_id, cumulative_spend_jpy, earned_tier_id, current_tier_id, is_downgraded, last_purchase_at, prev_purchase_at, pre_expiry_warned_at, total_points_earned, total_points_redeemed, total_points_expired, remaining_points, enrolled_at, earned_tier:earned_tier_id(name, points_multiplier, color_hex), current_tier:current_tier_id(name, points_multiplier, color_hex)',
          )
          .eq('customer_id', customerId!)
          .maybeSingle(),
        supabase
          .from('loyalty_tiers')
          .select('id, name, min_spend_jpy, points_multiplier, color_hex')
          .order('min_spend_jpy', { ascending: true }),
        supabase
          .from('customers')
          .select('id, full_name, customer_code, email')
          .eq('id', customerId!)
          .maybeSingle(),
        supabase
          .from('loyalty_beta_members')
          .select('id')
          .eq('customer_id', customerId!)
          .maybeSingle(),
      ]);

      const member = (memberRes.data as unknown) as LoyaltyMemberRow | null;
      let transactions: LoyaltyTxRow[] = [];
      let redemptions: RedemptionRow[] = [];
      if (member) {
        const [txnsRes, redRes] = await Promise.all([
          supabase
            .from('loyalty_transactions')
            .select(
              'id, transaction_type, points_amount, spend_amount_jpy, invoice_number, tier_at_time, notes, created_at',
            )
            .eq('member_id', member.id)
            .order('created_at', { ascending: false }),
          supabase
            .from('loyalty_redemptions')
            .select(
              'id, redemption_type, points_redeemed, value_applied_jpy, value_applied_php, invoice_number, status, created_at, processed_at',
            )
            .eq('member_id', member.id)
            .order('created_at', { ascending: false }),
        ]);
        transactions = (txnsRes.data || []) as unknown as LoyaltyTxRow[];
        redemptions = (redRes.data || []) as unknown as RedemptionRow[];
      }

      return {
        customer: (customerRes.data as unknown) as CustomerLite | null,
        member,
        transactions,
        redemptions,
        tiers: ((tiersRes.data || []) as unknown) as TierRow[],
        isBeta: !!betaRes.data,
      };
    },
  });
}

const REDEMPTION_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  confirmed: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

export default memo(function CustomerLoyaltyTab({ customerId }: { customerId: string }) {
  const { roles } = useAuth();
  const rolesArr = roles as any[];
  const isAdmin = rolesArr.includes('admin');
  const isFinance = rolesArr.includes('finance');

  const { data, isLoading } = useCustomerLoyalty(customerId);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const filteredTransactions = useMemo(() => {
    if (!data?.transactions) return [];
    if (filter === 'all') return data.transactions;
    return data.transactions.filter((tx) => tx.transaction_type === filter);
  }, [data?.transactions, filter]);

  const tiersData = useMemo<LoyaltyTierData[]>(() => {
    if (!data?.tiers) return [];
    return data.tiers.map((t) => ({
      name: t.name as TierName,
      spendRequired: t.min_spend_jpy,
      multiplier: t.points_multiplier,
      ...TIER_STATIC[t.name as TierName],
    }));
  }, [data?.tiers]);

  const memberData = useMemo<LoyaltyMemberData | null>(() => {
    const m = data?.member;
    if (!m) return null;
    const tierName = (m.current_tier?.name ?? 'Glimmer') as TierName;
    const idx = tiersData.findIndex((t) => t.name === tierName);
    const next = idx >= 0 ? tiersData[idx + 1] : undefined;
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const isActive = m.last_purchase_at
      ? new Date(m.last_purchase_at) > sixMonthsAgo
      : false;
    return {
      id: m.id,
      customer_id: m.customer_id,
      customer_name: data?.customer?.full_name || 'Valued Customer',
      member_id: data?.customer?.customer_code ?? '—',
      current_tier: tierName,
      is_downgraded: m.is_downgraded,
      available_points: m.remaining_points,
      lifetime_points_earned: m.total_points_earned,
      redeemed_points: m.total_points_redeemed,
      lifetime_spend_yen: m.cumulative_spend_jpy,
      current_multiplier: m.current_tier?.points_multiplier ?? 1,
      amount_needed_for_next_tier: next
        ? Math.max(0, next.spendRequired - m.cumulative_spend_jpy)
        : 0,
      activity_status: isActive ? 'Active' : 'Inactive',
      email: data?.customer?.email ?? null,
      join_date: m.enrolled_at
        ? new Date(m.enrolled_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          })
        : '—',
      last_purchase_date: m.last_purchase_at
        ? new Date(m.last_purchase_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          })
        : null,
    };
  }, [data?.member, data?.customer, tiersData]);

  const transactionsData = useMemo<LoyaltyTransactionData[]>(
    () =>
      filteredTransactions.map((tx) => ({
        id: tx.id,
        date: new Date(tx.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        type: (tx.points_amount ?? 0) > 0 ? ('earned' as const) : ('redeemed' as const),
        points: tx.points_amount ?? 0,
        description: tx.invoice_number
          ? `Invoice #${tx.invoice_number}`
          : tx.notes ?? tx.transaction_type,
        source: tx.transaction_type,
        invoice_number: tx.invoice_number ?? null,
        spend_amount_jpy: tx.spend_amount_jpy ?? null,
        tier_multiplier: null,
      })),
    [filteredTransactions],
  );

  setLoyaltyData(memberData, tiersData, transactionsData);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    );
  }

  const { member, transactions, redemptions, isBeta } = data;

  // ── Not enrolled ──────────────────────────────────────────────
  if (!member) {
    return (
      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-card p-6 text-center">
          <Diamond className="h-9 w-9 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium text-foreground">Not enrolled</p>
          <p className="text-xs text-muted-foreground mt-1">
            This customer hasn't joined the loyalty program yet.
            {isBeta ? ' They are on the beta whitelist.' : ''}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="text-sm font-semibold text-foreground">Loyalty Portal</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage beta access and program-wide controls in one place.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              to="/loyalty/admin?tab=beta"
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
            >
              Manage Beta Status
              <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Enrolled ──────────────────────────────────────────────────
  const tierName = member.current_tier?.name ?? 'Glimmer';
  const earnedTierName = member.earned_tier?.name ?? tierName;

  return (
    <div className="space-y-6">
      {/* 1. Status header */}
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg gold-gradient">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-foreground font-display">Loyalty Status</h3>
              <p className="text-xs text-muted-foreground">
                ✓ Enrolled since {fmtDate(member.enrolled_at)}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
              isBeta
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
                : 'border-border bg-muted text-muted-foreground'
            }`}
          >
            {isBeta ? 'BETA' : 'NOT IN BETA'}
          </span>
        </div>
      </div>

      {/* 2. Membership Card */}
      <div className="flex justify-center">
        <MemberCard />
      </div>

      {/* 3. Points Summary + admin extras */}
      <div className="space-y-3">
        <PointsSnapshot />
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-semibold">
            Admin Details
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <Stat label="Total expired" value={member.total_points_expired.toLocaleString()} />
            <Stat label="Last purchase" value={fmtDate(member.last_purchase_at)} />
            <Stat label="Previous purchase" value={fmtDate(member.prev_purchase_at)} />
            <Stat label="Pre-expiry warned" value={fmtDate(member.pre_expiry_warned_at)} />
          </div>
        </div>
      </div>

      {/* 4. Tier Progress */}
      <div className="space-y-2">
        <VipProgressSection />
        {member.is_downgraded && earnedTierName !== tierName && (
          <p className="text-center text-xs text-muted-foreground italic">
            Earned tier: {earnedTierName} (reduced due to inactivity)
          </p>
        )}
      </div>

      {/* 5. Activity Timeline */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm font-semibold text-foreground">Activity Timeline</p>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => {
              const active = filter === f.value;
              return (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        {filteredTransactions.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
            {transactions.length === 0
              ? 'No loyalty activity yet'
              : 'No events match this filter'}
          </div>
        ) : (
          <RecentActivity />
        )}
      </div>

      {/* 6. Redemptions */}
      <div className="space-y-3">
        <p className="text-sm font-semibold text-foreground">Redemptions</p>
        {redemptions.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
            No redemption requests
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Points</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  {(isAdmin || isFinance) && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {redemptions.map((r) => {
                  const isPending = r.status === 'pending';
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{fmtDate(r.created_at)}</TableCell>
                      <TableCell className="text-xs">{fmtRedemptionType(r.redemption_type)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {Number(r.points_redeemed).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ¥{Number(r.value_applied_jpy).toLocaleString()}
                        {r.value_applied_php != null && (
                          <span className="text-muted-foreground">
                            {' '}/ ₱{Number(r.value_applied_php).toLocaleString()}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">#{r.invoice_number}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                            REDEMPTION_STATUS_STYLES[r.status] ?? REDEMPTION_STATUS_STYLES.cancelled
                          }`}
                        >
                          {r.status}
                        </span>
                      </TableCell>
                      {(isAdmin || isFinance) && (
                        <TableCell className="text-right">
                          {isPending ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => setReviewingId(r.id)}
                            >
                              Review
                            </Button>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* 7. Loyalty Portal links (all viewers) */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Loyalty Portal</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Open the global Loyalty Portal to manage members and beta access.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.customer?.customer_code && (
            <Link
              to={`/loyalty/admin?tab=members&search=${encodeURIComponent(data.customer.customer_code)}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
            >
              View in Members
              <ExternalLink className="h-3 w-3" />
            </Link>
          )}
          <Link
            to="/loyalty/admin?tab=beta"
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
          >
            Manage Beta Status
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* 8. Admin Actions */}
      {isAdmin && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Admin Actions</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Restricted to admin role.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button size="sm" variant="outline" disabled>
                      Adjust Points
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Coming soon — adjust-loyalty-points edge function lands in a follow-up step
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      )}

      <RedemptionApprovalModal
        isOpen={reviewingId !== null}
        onClose={() => setReviewingId(null)}
        redemptionId={reviewingId}
        invalidateKeys={[['customer-loyalty', customerId]]}
      />
    </div>
  );
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs font-semibold text-foreground tabular-nums">{value}</p>
    </div>
  );
}
