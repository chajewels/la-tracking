import { useQuery } from '@tanstack/react-query';
import { OPEN_SERVICE_REQUEST_STATUSES, serviceRequests } from '@/components/services/service-request-types';

/**
 * Open customer service requests, for the Services → Requests sidebar badge.
 * 30s poll, matching useExtensionRequestCount and the other queue badges.
 *
 * Test customers are excluded HERE as well as in the tab, so the badge never
 * counts a row the queue will not show. A plain head+count cannot see the
 * customer, so the count inner-joins `customers` and filters on `is_test`.
 * `customer_id` is NOT NULL (FK ON DELETE CASCADE), so the inner join drops
 * no real request — it counts exactly the rows ServiceRequestsTab keeps.
 * Before this, a test customer's open request lit the badge with nothing in
 * the queue to clear it (docs/FIXED-BUGS.md, 2026-10-17).
 */
export function useServiceRequestCount() {
  const { data, isLoading } = useQuery({
    queryKey: ['service-requests-open-count'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { count, error } = await serviceRequests()
        .select('id, customers!inner(is_test)', { count: 'exact', head: true })
        .in('status', OPEN_SERVICE_REQUEST_STATUSES)
        .eq('customers.is_test', false);
      if (error) throw error;
      return (count as number | null) ?? 0;
    },
  });

  return { count: data ?? 0, isLoading };
}
