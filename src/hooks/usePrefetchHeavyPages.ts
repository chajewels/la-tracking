import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { executiveDashboardQueryOptions } from '@/hooks/useExecutiveDashboard';
import { dashboardSummaryQueryOptions } from '@/hooks/use-supabase-data';
import {
  forecastScheduleQueryOptions,
  dailyLayawayQueryOptions,
  dailyLayawayLastMonthQueryOptions,
  dailyCashOrdersQueryOptions,
  dailyCashOrdersLastMonthQueryOptions,
  collectionAnalyticsQueryOptions,
  staffPerformanceQueryOptions,
  topOutstandingCustomersQueryOptions,
} from '@/hooks/financeQueryOptions';

/**
 * Warms the Executive Dashboard and Finance query caches at app idle so
 * the FIRST visit paints from cache like a revisit (revisit speed was
 * fixed by the 120s staleTime policies; this covers the cold first
 * glance). Fire-and-forget: prefetchQuery never throws — a failed
 * prefetch just means the page loads as it does today.
 *
 * Gating reuses the sidebar's own nav-visibility rules (AppSidebar.tsx)
 * verbatim — no new permission logic:
 *   - Executive Dashboard nav: `adminOnly` items show only when
 *     isExecAllowed = user?.email === 'sales@chajewelsjp.com'.
 *   - Finance nav: the parent carries no adminOnly/permPath and its
 *     Overview child has no permFilter, so it is visible to every
 *     authenticated internal user.
 *
 * Prefetched Finance params = the page's mount-time values:
 * currencyFilter useState initial 'ALL'; forecast key's date computed by
 * the shared option builder with the same format(new Date(),'yyyy-MM-dd').
 * forecast-drilldown is NOT prefetched — it is mount-disabled
 * (enabled: !!selectedCard, initially null), so it has no initial key.
 * AppLayout mounts per page, so a module flag keeps this once per session.
 */
let hasPrefetched = false;

export function usePrefetchHeavyPages() {
  const queryClient = useQueryClient();
  const { session, user } = useAuth();

  useEffect(() => {
    if (hasPrefetched || !session) return;
    hasPrefetched = true;

    const run = () => {
      const isExecAllowed = user?.email === 'sales@chajewelsjp.com';
      if (isExecAllowed) {
        queryClient.prefetchQuery(executiveDashboardQueryOptions);
      }
      // Finance (visible to all authenticated users — see gate note above)
      queryClient.prefetchQuery(dashboardSummaryQueryOptions('ALL'));
      queryClient.prefetchQuery(forecastScheduleQueryOptions());
      queryClient.prefetchQuery(dailyLayawayQueryOptions('ALL'));
      queryClient.prefetchQuery(dailyLayawayLastMonthQueryOptions('ALL'));
      queryClient.prefetchQuery(dailyCashOrdersQueryOptions());
      queryClient.prefetchQuery(dailyCashOrdersLastMonthQueryOptions());
      queryClient.prefetchQuery(collectionAnalyticsQueryOptions('ALL'));
      queryClient.prefetchQuery(staffPerformanceQueryOptions());
      queryClient.prefetchQuery(topOutstandingCustomersQueryOptions());
    };

    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(run);
    } else {
      setTimeout(run, 2500);
    }
  }, [session, user, queryClient]);
}
