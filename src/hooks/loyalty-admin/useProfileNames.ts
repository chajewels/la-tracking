import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Bulk-resolves a set of user IDs into a { id → full_name } map.
 * Used by the Audit Log tab to display performer names without
 * issuing one query per row.
 *
 * Reads from public.profiles. Returns '—' for IDs not found and
 * for null inputs. Caches per sorted-id-list key.
 */
export function useProfileNames(userIds: ReadonlyArray<string | null | undefined>) {
  const unique = Array.from(
    new Set(userIds.filter((id): id is string => !!id)),
  ).sort();
  const cacheKey = unique.join(',');

  return useQuery<Record<string, string>>({
    queryKey: ['loyalty-admin-profile-names', cacheKey],
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, full_name')
        .in('user_id', unique);
      if (error) throw error;
      const out: Record<string, string> = {};
      for (const row of (data || []) as Array<{
        user_id: string;
        full_name: string | null;
      }>) {
        out[row.user_id] = row.full_name || '—';
      }
      return out;
    },
  });
}
