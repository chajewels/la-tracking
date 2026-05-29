import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useNewCashOrdersTodayCount() {
  const { data, isLoading } = useQuery({
    queryKey: ['new-cash-orders-today-count'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const startOfTodayISO = startOfToday.toISOString();
      const { count, error } = await supabase
        .from('cash_orders')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', startOfTodayISO);
      if (error) throw error;
      return count ?? 0;
    },
  });

  return { count: data ?? 0, isLoading };
}
