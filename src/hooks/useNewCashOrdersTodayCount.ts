import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { phtStartOfTodayISO, SHOWN_IN_SALES_LISTS_OR } from '@/lib/new-today';

export function useNewCashOrdersTodayCount() {
  const { data, isLoading } = useQuery({
    queryKey: ['new-cash-orders-today-count'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // PHT day, and only rows the Sales list shows (the card's button lands there).
      const startOfTodayISO = phtStartOfTodayISO();
      const { count, error } = await supabase
        .from('cash_orders')
        .select('id', { count: 'exact', head: true })
        .eq('is_test', false)
        .gte('created_at', startOfTodayISO)
        .or(SHOWN_IN_SALES_LISTS_OR);
      if (error) throw error;
      return count ?? 0;
    },
  });

  return { count: data ?? 0, isLoading };
}
