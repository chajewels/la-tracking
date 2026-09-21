import { useQuery } from '@tanstack/react-query';
import { OPEN_SERVICE_REQUEST_STATUSES, serviceRequests } from '@/components/services/service-request-types';

/**
 * Open customer service requests, for the Services → Requests sidebar badge.
 * 30s poll, matching useExtensionRequestCount and the other queue badges.
 *
 * A head+count query cannot filter on an embedded column, so test customers
 * are NOT excluded here — the badge counts rows, the tab does the exclusion.
 * Test customers raise requests only from a seeded portal session, which is
 * rare enough that an occasional off-by-one badge beats a second round trip
 * on every 30s tick.
 */
export function useServiceRequestCount() {
  const { data, isLoading } = useQuery({
    queryKey: ['service-requests-open-count'],
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { count, error } = await serviceRequests()
        .select('id', { count: 'exact', head: true })
        .in('status', OPEN_SERVICE_REQUEST_STATUSES);
      if (error) throw error;
      return (count as number | null) ?? 0;
    },
  });

  return { count: data ?? 0, isLoading };
}
