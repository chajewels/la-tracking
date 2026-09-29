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
  /** Points redeemed this PHT month (confirmed redemptions only). */
  thisMonthPoints: number;
  lastMonthPoints: number;
  /** How many confirmed redemptions made up thisMonthPoints. */
  thisMonthCount: number;
  /** Points redeemed per month, oldest→newest, last 6 PHT months. */
  series: number[];
}

const phtMonth = (d: Date | string) =>
  Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit' }).format(new Date(d));

/**
 * Loyalty Redemptions KPI (owner rule 2026-09-29): the POINTS redeemed in the
 * current month — confirmed redemptions only (pending may still be cancelled;
 * cancelled never counted). Months are PHT.
 *
 * The earlier version filtered status NOT IN ("cancelled","voided"), but
 * loyalty_redemption_status is {pending, confirmed, cancelled}: 'voided' is not
 * a value of the enum, so PostgREST refused the whole query and the card read
 * "—" for every user.
 */
export function useRedemptionsKpi() {
  return useQuery({
    queryKey: ['dashboard-redemptions-kpi'],
    staleTime: 5 * 60_000,
    retry: false, // RLS denial should degrade to "—" quickly, not retry-loop
    queryFn: async (): Promise<RedemptionsKpi> => {
      // Six PHT months, current one last.
      const now = new Date();
      const [y, m] = phtMonth(now).split('-').map(Number);
      const months: string[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
      }
      // PHT midnight of the first month's first day.
      const since = new Date(`${months[0]}-01T00:00:00+08:00`).toISOString();
      const { data, error } = await supabase
        .from('loyalty_redemptions')
        .select('points_redeemed, created_at')
        .gte('created_at', since)
        .eq('status', 'confirmed');
      if (error) throw error;

      const points = new Map<string, number>();
      const counts = new Map<string, number>();
      for (const row of data ?? []) {
        const key = phtMonth(String(row.created_at));
        points.set(key, (points.get(key) ?? 0) + Number(row.points_redeemed ?? 0));
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const series = months.map((mo) => points.get(mo) ?? 0);
      return {
        thisMonthPoints: series[5] ?? 0,
        lastMonthPoints: series[4] ?? 0,
        thisMonthCount: counts.get(months[5]) ?? 0,
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
