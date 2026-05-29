import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useWaiverRequestCount() {
  const { data, isLoading } = useQuery({
    queryKey: ['waiver-request-pending-count'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { count, error } = await supabase
        .from('penalty_waiver_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      if (error) throw error;
      return count ?? 0;
    },
  });

  return { count: data ?? 0, isLoading };
}
