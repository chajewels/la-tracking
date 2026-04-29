import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type LoyaltyAuditEntityType =
  | 'all'
  | 'loyalty_tier'
  | 'loyalty_settings'
  | 'loyalty_beta'
  | 'loyalty_redemption'
  | 'loyalty_member';

export interface LoyaltyAuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  performed_by_user_id: string | null;
  old_value_json: unknown;
  new_value_json: unknown;
  created_at: string;
}

export interface LoyaltyAuditFilters {
  entityType: LoyaltyAuditEntityType;
  action: string; // 'all' or specific action token
  performedBy: string; // 'all' or user_id
  rangeStartIso: string | null;
  rangeEndIso: string | null;
  page: number;
  pageSize: number;
}

export interface LoyaltyAuditResult {
  rows: LoyaltyAuditRow[];
  totalCount: number;
  totalPages: number;
}

const ALL_LOYALTY_ENTITY_TYPES: ReadonlyArray<string> = [
  'loyalty_tier',
  'loyalty_settings',
  'loyalty_beta',
  'loyalty_redemption',
  'loyalty_member',
];

export function useLoyaltyAuditLog(filters: LoyaltyAuditFilters) {
  return useQuery<LoyaltyAuditResult>({
    queryKey: ['loyalty-admin-audit-log', filters],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const start = filters.page * filters.pageSize;
      const end = start + filters.pageSize - 1;

      let q = supabase
        .from('audit_logs')
        .select(
          'id, entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json, created_at',
          { count: 'exact' },
        )
        .order('created_at', { ascending: false });

      if (filters.entityType === 'all') {
        q = q.in('entity_type', ALL_LOYALTY_ENTITY_TYPES as string[]);
      } else {
        q = q.eq('entity_type', filters.entityType);
      }
      if (filters.action !== 'all') {
        q = q.eq('action', filters.action);
      }
      if (filters.performedBy !== 'all') {
        q = q.eq('performed_by_user_id', filters.performedBy);
      }
      if (filters.rangeStartIso) {
        q = q.gte('created_at', filters.rangeStartIso);
      }
      if (filters.rangeEndIso) {
        q = q.lt('created_at', filters.rangeEndIso);
      }

      const { data, count, error } = await q.range(start, end);
      if (error) throw error;

      const totalCount = count ?? 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));
      return {
        rows: ((data || []) as unknown) as LoyaltyAuditRow[],
        totalCount,
        totalPages,
      };
    },
  });
}

/**
 * Distinct action tokens currently present in the loyalty audit
 * log, used to populate the action filter dropdown. Cheap query
 * (fetches up to 500 recent rows and reduces to a Set client-side).
 */
export function useLoyaltyAuditActions() {
  return useQuery<string[]>({
    queryKey: ['loyalty-admin-audit-actions'],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('action')
        .in('entity_type', ALL_LOYALTY_ENTITY_TYPES as string[])
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const unique = new Set<string>();
      for (const row of (data || []) as Array<{ action: string }>) {
        if (row.action) unique.add(row.action);
      }
      return Array.from(unique).sort();
    },
  });
}
