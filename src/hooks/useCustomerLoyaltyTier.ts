import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CustomerLoyaltyTier {
  current_tier_name: string;
  current_tier_multiplier: number;
}

export function useCustomerLoyaltyTier(customerId: string | undefined | null) {
  return useQuery<CustomerLoyaltyTier | null>({
    queryKey: ['customer-loyalty-tier', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_members')
        .select('current_tier:current_tier_id(name, points_multiplier)')
        .eq('customer_id', customerId!)
        .maybeSingle();
      if (error) throw error;
      const tier = (data as any)?.current_tier;
      if (!tier) return null;
      return {
        current_tier_name: tier.name as string,
        current_tier_multiplier: Number(tier.points_multiplier),
      };
    },
  });
}
