import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type RedemptionStatusFilter = 'all' | 'pending' | 'confirmed' | 'cancelled';
export type RedemptionRangeFilter = 'last_7' | 'last_30' | 'all';

export interface RedemptionQueueRow {
  id: string;
  redemption_type: string;
  points_redeemed: number;
  value_applied_jpy: number;
  value_applied_php: number | null;
  invoice_number: string;
  status: string;
  created_at: string;
  loyalty_member: {
    customers: { full_name: string; customer_code: string } | null;
  } | null;
}

export interface RedemptionStats {
  pending: number;
  approvedThisMonth: number;
  cancelledThisMonth: number;
  totalApproved: number;
}

function startOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function dateRangeFloor(range: RedemptionRangeFilter): string | null {
  if (range === 'all') return null;
  const days = range === 'last_7' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function useRedemptionStats(enabled: boolean = true) {
  return useQuery<RedemptionStats>({
    queryKey: ['loyalty-admin-redemption-stats'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const monthStart = startOfMonthISO();
      const [pendingRes, approvedMonthRes, cancelledMonthRes, totalApprovedRes] =
        await Promise.all([
          supabase
            .from('loyalty_redemptions')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'pending'),
          supabase
            .from('loyalty_redemptions')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'confirmed')
            .gte('processed_at', monthStart),
          supabase
            .from('loyalty_redemptions')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'cancelled')
            .gte('cancelled_at', monthStart),
          supabase
            .from('loyalty_redemptions')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'confirmed'),
        ]);
      return {
        pending: pendingRes.count ?? 0,
        approvedThisMonth: approvedMonthRes.count ?? 0,
        cancelledThisMonth: cancelledMonthRes.count ?? 0,
        totalApproved: totalApprovedRes.count ?? 0,
      };
    },
  });
}

export function useRedemptionQueue(filters: {
  status: RedemptionStatusFilter;
  range: RedemptionRangeFilter;
}) {
  return useQuery<RedemptionQueueRow[]>({
    queryKey: ['loyalty-admin-redemption-queue', filters.status, filters.range],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      let q = supabase
        .from('loyalty_redemptions')
        .select(
          'id, redemption_type, points_redeemed, value_applied_jpy, value_applied_php, invoice_number, status, created_at, loyalty_member:member_id(customers:customer_id(full_name, customer_code))',
        )
        .order('created_at', { ascending: false });
      if (filters.status !== 'all') q = q.eq('status', filters.status);
      const since = dateRangeFloor(filters.range);
      if (since) q = q.gte('created_at', since);
      const { data, error } = await q;
      if (error) throw error;
      return ((data || []) as unknown) as RedemptionQueueRow[];
    },
  });
}
