import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { getPHTToday } from '@/lib/date-utils';

/**
 * Phase 3 dashboard data — READ-ONLY consumers of existing server surface:
 *   - get_monthly_analytics RPC (same key Finance uses, so the cache is shared)
 *   - loyalty_redemptions table (plain PostgREST read, same pattern as
 *     useLoyaltyRedemptionsAdmin; if RLS denies the caller the KPI degrades)
 *   - schedule_with_actuals + cash_orders reads for the Needs Attention panel
 * No new RPCs, edge functions, or migrations.
 */

export interface MonthlyAnalyticsRow {
  month: string; // 'YYYY-MM-DD' first of month
  collected_jpy: number;
  [key: string]: unknown;
}

export function useMonthlyCollected() {
  const today = getPHTToday();
  return useQuery({
    queryKey: ['monthly-analytics', today],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_monthly_analytics');
      if (error) throw error;
      return (data ?? []) as MonthlyAnalyticsRow[];
    },
  });
}

export interface RedemptionsKpi {
  thisMonthCount: number;
  lastMonthCount: number;
  /** Monthly counts, oldest→newest, last 6 months. */
  series: number[];
}

export function useRedemptionsKpi() {
  return useQuery({
    queryKey: ['dashboard-redemptions-kpi'],
    staleTime: 5 * 60_000,
    retry: false, // RLS denial should degrade to "—" quickly, not retry-loop
    queryFn: async (): Promise<RedemptionsKpi> => {
      const since = new Date();
      since.setMonth(since.getMonth() - 5);
      since.setDate(1);
      const { data, error } = await supabase
        .from('loyalty_redemptions')
        .select('id, created_at, status')
        .gte('created_at', since.toISOString())
        .not('status', 'in', '("cancelled","voided")');
      if (error) throw error;

      const byMonth = new Map<string, number>();
      for (const row of data ?? []) {
        const key = String(row.created_at).slice(0, 7);
        byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
      }
      const months: string[] = [];
      const cursor = new Date(since);
      for (let i = 0; i < 6; i++) {
        months.push(cursor.toISOString().slice(0, 7));
        cursor.setMonth(cursor.getMonth() + 1);
      }
      const series = months.map(m => byMonth.get(m) ?? 0);
      return {
        thisMonthCount: series[5] ?? 0,
        lastMonthCount: series[4] ?? 0,
        series,
      };
    },
  });
}

export interface AttentionScheduleRow {
  id: string;
  due_date: string;
  actual_remaining: number | null;
  currency: string;
  layaway_accounts: {
    id: string;
    invoice_number: string;
    status: string;
    customers: { full_name: string | null; messenger_link: string | null } | null;
  } | null;
}

export interface AttentionCashRow {
  id: string;
  invoice_number: string;
  currency: string;
  remaining_balance: number;
  expires_at: string | null;
  customers: { full_name: string | null } | null;
}

export function useNeedsAttention() {
  const schedule = useQuery({
    queryKey: ['needs-attention-schedule'],
    staleTime: 60_000,
    queryFn: async () => {
      const threeDaysFromNow = Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' })
        .format(new Date(Date.now() + 3 * 86400000));
      const { data, error } = await supabase
        .from('schedule_with_actuals')
        .select('id, due_date, actual_remaining, currency, layaway_accounts!inner(id, invoice_number, status, customers(full_name, messenger_link))')
        .in('computed_status', ['pending', 'overdue', 'partially_paid'])
        .in('layaway_accounts.status', ['active', 'overdue'])
        .filter('layaway_accounts.is_test', 'eq', false)
        .lte('due_date', threeDaysFromNow)
        .order('due_date', { ascending: true })
        .limit(6);
      if (error) throw error;
      return (data ?? []) as unknown as AttentionScheduleRow[];
    },
  });

  const cash = useQuery({
    queryKey: ['needs-attention-cash'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cash_orders')
        .select('id, invoice_number, currency, remaining_balance, expires_at, customers(full_name)')
        .eq('status', 'pending')
        .eq('is_test', false)
        .not('expires_at', 'is', null)
        .order('expires_at', { ascending: true })
        .limit(5);
      if (error) throw error;
      return (data ?? []) as unknown as AttentionCashRow[];
    },
  });

  return { schedule, cash };
}
