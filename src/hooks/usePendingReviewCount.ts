import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/contexts/PermissionsContext';

/**
 * Pending product reviews, for the Website → Reviews sidebar badge.
 * 30s poll, matching useServiceRequestCount and the other queue badges.
 *
 * Head/count query only — no row data. Enabled only for someone who can
 * actually moderate reviews (the same gate the Reviews tab and the sidebar
 * permFilter use); disabled for everyone else so the query never fires.
 */
export function usePendingReviewCount() {
  const { can } = usePermissions();
  const canModerate = can('moderate_reviews');

  const { data, isLoading } = useQuery({
    queryKey: ['product-reviews-pending-count'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled: canModerate,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('product_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      if (error) throw error;
      return (count as number | null) ?? 0;
    },
  });

  return { count: canModerate ? (data ?? 0) : 0, isLoading };
}
