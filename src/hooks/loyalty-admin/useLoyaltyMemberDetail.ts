import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface MemberDetailRow {
  id: string;
  customer_id: string;
  full_name: string;
  customer_code: string | null;
  email: string | null;
  tier_name: string;
  tier_multiplier: number;
  tier_color_hex: string | null;
  remaining_points: number;
  total_points_earned: number;
  total_points_redeemed: number;
  total_points_expired: number;
  cumulative_spend_jpy: number;
  enrolled_at: string;
  last_purchase_at: string | null;
  is_downgraded: boolean;
  is_beta: boolean;
}

export interface MemberTransactionRow {
  id: string;
  transaction_type: string;
  points_amount: number;
  spend_amount_jpy: number | null;
  invoice_number: string | null;
  tier_at_time: string | null;
  notes: string | null;
  created_at: string;
}

export interface MemberDetailData {
  member: MemberDetailRow;
  transactions: MemberTransactionRow[];
}

interface RawMember {
  id: string;
  customer_id: string;
  cumulative_spend_jpy: number;
  remaining_points: number;
  total_points_earned: number;
  total_points_redeemed: number;
  total_points_expired: number;
  enrolled_at: string;
  last_purchase_at: string | null;
  is_downgraded: boolean;
  current_tier: { name: string; points_multiplier: number; color_hex: string | null } | null;
  customers: { full_name: string | null; customer_code: string | null; email: string | null } | null;
}

export function useLoyaltyMemberDetail(memberId: string | null | undefined) {
  return useQuery<MemberDetailData | null>({
    queryKey: ['loyalty-admin-member-detail', memberId],
    enabled: !!memberId,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [memberRes, txRes] = await Promise.all([
        supabase
          .from('loyalty_members')
          .select(
            'id, customer_id, cumulative_spend_jpy, remaining_points, total_points_earned, total_points_redeemed, total_points_expired, enrolled_at, last_purchase_at, is_downgraded, current_tier:current_tier_id(name, points_multiplier, color_hex), customers:customer_id(full_name, customer_code, email)',
          )
          .eq('id', memberId!)
          .maybeSingle(),
        supabase
          .from('loyalty_transactions')
          .select(
            'id, transaction_type, points_amount, spend_amount_jpy, invoice_number, tier_at_time, notes, created_at',
          )
          .eq('member_id', memberId!)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (memberRes.error) throw memberRes.error;
      if (txRes.error) throw txRes.error;
      if (!memberRes.data) return null;

      const raw = memberRes.data as unknown as RawMember;

      const { data: betaRow } = await supabase
        .from('loyalty_beta_members')
        .select('id')
        .eq('customer_id', raw.customer_id)
        .maybeSingle();

      const member: MemberDetailRow = {
        id: raw.id,
        customer_id: raw.customer_id,
        full_name: raw.customers?.full_name ?? '—',
        customer_code: raw.customers?.customer_code ?? null,
        email: raw.customers?.email ?? null,
        tier_name: raw.current_tier?.name ?? 'Unknown',
        tier_multiplier: Number(raw.current_tier?.points_multiplier ?? 1),
        tier_color_hex: raw.current_tier?.color_hex ?? null,
        remaining_points: Number(raw.remaining_points || 0),
        total_points_earned: Number(raw.total_points_earned || 0),
        total_points_redeemed: Number(raw.total_points_redeemed || 0),
        total_points_expired: Number(raw.total_points_expired || 0),
        cumulative_spend_jpy: Number(raw.cumulative_spend_jpy || 0),
        enrolled_at: raw.enrolled_at,
        last_purchase_at: raw.last_purchase_at,
        is_downgraded: !!raw.is_downgraded,
        is_beta: !!betaRow,
      };

      const transactions = ((txRes.data || []) as unknown) as MemberTransactionRow[];

      return { member, transactions };
    },
  });
}
