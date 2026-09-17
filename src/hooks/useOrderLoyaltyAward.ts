import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Whether an order has already earned loyalty points (an 'earned'
 * loyalty_transactions row). Points are awarded once per order — at DP
 * confirmation (layaway) or completion (cash) — so once this is true,
 * changing loyalty_jpy_amount no longer changes the points
 * (trg_guard_loyalty_jpy_amount refuses it).
 */
export interface OrderLoyaltyAward {
  awarded: boolean;
  points: number;
  spend: number;
  at: string | null;
}

export function useOrderLoyaltyAward(
  kind: 'layaway' | 'cash',
  orderId: string | undefined | null,
  enabled = true,
) {
  return useQuery<OrderLoyaltyAward>({
    queryKey: ['order-loyalty-award', kind, orderId],
    enabled: !!orderId && enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const column = kind === 'layaway' ? 'account_id' : 'cash_order_id';
      const { data, error } = await supabase
        .from('loyalty_transactions')
        .select('points_amount, spend_amount_jpy, created_at')
        .eq(column, orderId!)
        .eq('transaction_type', 'earned')
        .order('created_at', { ascending: true });
      if (error) throw error;
      const rows = data ?? [];
      return {
        awarded: rows.length > 0,
        points: rows.reduce((s, r) => s + Number(r.points_amount || 0), 0),
        spend: rows.reduce((s, r) => s + Number(r.spend_amount_jpy || 0), 0),
        at: rows[0]?.created_at ?? null,
      };
    },
  });
}
