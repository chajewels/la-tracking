import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Currency } from '@/lib/types';

/**
 * One customer's cash orders. Shared by the customer page's Cash Orders tab and
 * its header badge (same query key → one request, one cache entry).
 */
export interface CashOrderRow {
  id: string;
  invoice_number: string;
  source_channel?: string | null;
  web_reference?: string | null;
  currency: Currency;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  status: string;
  order_date: string | null;
  item_description: string | null;
  created_at: string;
}

export function useCustomerCashOrders(customerId: string | undefined) {
  return useQuery({
    queryKey: ['cash-orders-by-customer', customerId],
    enabled: !!customerId,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cash_orders')
        .select('id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, order_date, item_description, created_at, source_channel, web_reference')
        .eq('customer_id', customerId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown as CashOrderRow[]);
    },
  });
}
