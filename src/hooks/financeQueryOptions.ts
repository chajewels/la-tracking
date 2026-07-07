import { format } from 'date-fns';
import { keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';

/**
 * Finance page query options, extracted verbatim from src/pages/Finance.tsx
 * (2026-07-07) so usePrefetchHeavyPages can warm the SAME cache keys the
 * page mounts with. Finance.tsx spreads these into its useQuery calls —
 * `enabled` gates stay at the call sites. Parameterized options are
 * functions of exactly the values their queryKeys carry.
 */

export const forecastScheduleQueryOptions = () => ({
  queryKey: ['collections-forecast-6m', format(new Date(), 'yyyy-MM-dd')] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_forecast_6m');
    if (error) throw error;
    return (data || []) as { month: string; currency: string; installments: number; remaining: number }[];
  },
});

export const forecastDrilldownQueryOptions = (monthKey: string | null | undefined) => ({
  queryKey: ['forecast-drilldown', monthKey] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    if (!monthKey) return [];
    const { data, error } = await supabase.rpc('get_forecast_drilldown', {
      p_month: monthKey,
    });
    if (error) throw error;
    return data || [];
  },
});

export const dailyLayawayQueryOptions = (currencyFilter: CurrencyFilter) => ({
  queryKey: ['daily-new-layaway', currencyFilter] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_daily_new_layaway_sales', { currency_mode: currencyFilter });
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as Array<{ day: string; new_sales_count: number; total_sales_value: number }>;
  },
});

export const dailyLayawayLastMonthQueryOptions = (currencyFilter: CurrencyFilter) => ({
  queryKey: ['daily-new-layaway-last-month', currencyFilter] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_daily_new_layaway_sales_last_month', { currency_mode: currencyFilter });
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as Array<{ day: string; new_sales_count: number; total_sales_value: number }>;
  },
});

export const collectionAnalyticsQueryOptions = (currencyFilter: CurrencyFilter) => ({
  queryKey: ['collection-analytics', currencyFilter] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_collection_analytics', {
      currency_mode: currencyFilter,
      months_back: 12,
    });
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as Array<{
      month: string;
      collected: number;
      collected_due: number;
      expected: number;
      collection_rate: number;
      forfeited: number;
      penalties_collected: number;
    }>;
  },
});

export const staffPerformanceQueryOptions = () => ({
  queryKey: ['staff-performance'] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_staff_performance', { months_back: 1 });
    if (error) throw error;
    return (Array.isArray(data) ? data : []) as Array<{
      staff_email: string;
      payments_confirmed: number;
      avg_confirmation_hours: number | null;
    }>;
  },
});

export const topOutstandingCustomersQueryOptions = () => ({
  queryKey: ['top-outstanding-customers'] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async () => {
    const { data, error } = await supabase.rpc('get_top_outstanding_customers');
    if (error) throw error;
    return ((data?.[0] as { get_top_outstanding_customers?: unknown })?.get_top_outstanding_customers ?? data ?? []) as Array<{
      full_name: string;
      account_count: number;
      total_paid_jpy: number;
      early_payment_rate: number;
      penalty_count: number;
      score: number;
    }>;
  },
});
