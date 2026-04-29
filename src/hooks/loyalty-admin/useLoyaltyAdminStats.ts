import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface TierBreakdown {
  tier_name: string;
  count: number;
  color_hex: string | null;
}

export interface RecentEnrollmentRow {
  member_id: string;
  customer_id: string;
  full_name: string;
  customer_code: string | null;
  enrolled_at: string;
  tier_name: string;
}

export interface LoyaltyAdminStats {
  totalMembers: number;
  pointsOutstanding: number;
  pointsRedeemed: number;
  totalCumulativeSpendJpy: number;
  pendingRedemptions: number;
  tierBreakdown: TierBreakdown[];
  recentEnrollments: RecentEnrollmentRow[];
}

interface MemberRowJoined {
  id: string;
  customer_id: string;
  enrolled_at: string;
  remaining_points: number;
  total_points_redeemed: number;
  cumulative_spend_jpy: number;
  current_tier_id: string;
  current_tier: { name: string; color_hex: string | null } | null;
}

interface RecentMemberRowJoined {
  id: string;
  customer_id: string;
  enrolled_at: string;
  current_tier: { name: string } | null;
  customers: { full_name: string | null; customer_code: string | null } | null;
}

export function useLoyaltyAdminStats(enabled: boolean = true) {
  return useQuery<LoyaltyAdminStats>({
    queryKey: ['loyalty-admin-stats'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const [membersRes, recentRes, pendingRes] = await Promise.all([
        supabase
          .from('loyalty_members')
          .select(
            'id, customer_id, enrolled_at, remaining_points, total_points_redeemed, cumulative_spend_jpy, current_tier_id, current_tier:current_tier_id(name, color_hex)',
          ),
        supabase
          .from('loyalty_members')
          .select(
            'id, customer_id, enrolled_at, current_tier:current_tier_id(name), customers:customer_id(full_name, customer_code)',
          )
          .gte('enrolled_at', sevenDaysAgo)
          .order('enrolled_at', { ascending: false })
          .limit(20),
        supabase
          .from('loyalty_redemptions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
      ]);

      if (membersRes.error) throw membersRes.error;
      if (recentRes.error) throw recentRes.error;
      if (pendingRes.error) throw pendingRes.error;

      const members = (membersRes.data || []) as unknown as MemberRowJoined[];

      let pointsOutstanding = 0;
      let pointsRedeemed = 0;
      let totalCumulativeSpendJpy = 0;
      const tierMap = new Map<string, TierBreakdown>();

      for (const m of members) {
        pointsOutstanding += Number(m.remaining_points || 0);
        pointsRedeemed += Number(m.total_points_redeemed || 0);
        totalCumulativeSpendJpy += Number(m.cumulative_spend_jpy || 0);

        const tierName = m.current_tier?.name ?? 'Unknown';
        const colorHex = m.current_tier?.color_hex ?? null;
        const existing = tierMap.get(tierName);
        if (existing) {
          existing.count += 1;
        } else {
          tierMap.set(tierName, { tier_name: tierName, count: 1, color_hex: colorHex });
        }
      }

      const recent = (recentRes.data || []) as unknown as RecentMemberRowJoined[];
      const recentEnrollments: RecentEnrollmentRow[] = recent.map((r) => ({
        member_id: r.id,
        customer_id: r.customer_id,
        full_name: r.customers?.full_name ?? '—',
        customer_code: r.customers?.customer_code ?? null,
        enrolled_at: r.enrolled_at,
        tier_name: r.current_tier?.name ?? 'Unknown',
      }));

      return {
        totalMembers: members.length,
        pointsOutstanding,
        pointsRedeemed,
        totalCumulativeSpendJpy,
        pendingRedemptions: pendingRes.count ?? 0,
        tierBreakdown: Array.from(tierMap.values()),
        recentEnrollments,
      };
    },
  });
}
