import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LoyaltyAccess {
  hasAccess: boolean;
  isLoading: boolean;
  isMember: boolean;
  isBeta: boolean;
  isFeatureEnabled: boolean;
}

const REFETCH_MS = 60_000;

export function useLoyaltyAccess(customerId: string | null | undefined): LoyaltyAccess {
  const { data, isLoading } = useQuery({
    queryKey: ['loyalty-access', customerId ?? null],
    enabled: !!customerId,
    refetchInterval: REFETCH_MS,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [flagRes, betaRes, memberRes] = await Promise.all([
        supabase
          .from('system_settings')
          .select('value')
          .eq('key', 'loyalty_enabled')
          .maybeSingle(),
        supabase
          .from('loyalty_beta_members')
          .select('id')
          .eq('customer_id', customerId!)
          .maybeSingle(),
        supabase
          .from('loyalty_members')
          .select('id')
          .eq('customer_id', customerId!)
          .maybeSingle(),
      ]);

      const rawFlag = flagRes.data?.value;
      let isFeatureEnabled = false;
      if (rawFlag != null) {
        try {
          const parsed = JSON.parse(String(rawFlag));
          isFeatureEnabled = parsed === true || parsed === 'true';
        } catch {
          isFeatureEnabled = String(rawFlag).toLowerCase() === 'true';
        }
      }

      return {
        isFeatureEnabled,
        isBeta: !!betaRes.data,
        isMember: !!memberRes.data,
      };
    },
  });

  if (!customerId) {
    return {
      hasAccess: false,
      isLoading: false,
      isMember: false,
      isBeta: false,
      isFeatureEnabled: false,
    };
  }

  const isFeatureEnabled = data?.isFeatureEnabled ?? false;
  const isBeta = data?.isBeta ?? false;
  const isMember = data?.isMember ?? false;

  return {
    hasAccess: isFeatureEnabled || isBeta,
    isLoading,
    isMember,
    isBeta,
    isFeatureEnabled,
  };
}
