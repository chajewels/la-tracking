import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type ActivityFilter = 'all' | 'active' | 'inactive';
export type MemberSortKey =
  | 'full_name'
  | 'tier'
  | 'remaining_points'
  | 'cumulative_spend_jpy'
  | 'last_purchase_at'
  | 'enrolled_at';
export type SortDir = 'asc' | 'desc';

export interface LoyaltyMemberListRow {
  member_id: string;
  customer_id: string;
  full_name: string;
  customer_code: string | null;
  email: string | null;
  tier_name: string;
  tier_multiplier: number;
  tier_color_hex: string | null;
  remaining_points: number;
  total_points_earned: number;
  cumulative_spend_jpy: number;
  enrolled_at: string;
  last_purchase_at: string | null;
  activity_status: 'active' | 'inactive';
}

interface RawRow {
  id: string;
  customer_id: string;
  cumulative_spend_jpy: number;
  remaining_points: number;
  total_points_earned: number;
  last_purchase_at: string | null;
  enrolled_at: string;
  current_tier: {
    name: string;
    points_multiplier: number;
    color_hex: string | null;
  } | null;
  customers: {
    full_name: string | null;
    customer_code: string | null;
    email: string | null;
  } | null;
}

const SIX_MONTHS_MS = 1000 * 60 * 60 * 24 * 30 * 6;

function deriveActivity(lastPurchaseAt: string | null): 'active' | 'inactive' {
  if (!lastPurchaseAt) return 'inactive';
  return Date.now() - new Date(lastPurchaseAt).getTime() <= SIX_MONTHS_MS
    ? 'active'
    : 'inactive';
}

function useAllMembersQuery() {
  return useQuery<LoyaltyMemberListRow[]>({
    queryKey: ['loyalty-admin-members'],
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_members')
        .select(
          'id, customer_id, cumulative_spend_jpy, remaining_points, total_points_earned, last_purchase_at, enrolled_at, current_tier:current_tier_id(name, points_multiplier, color_hex), customers:customer_id(full_name, customer_code, email)',
        );
      if (error) throw error;
      const rows = (data || []) as unknown as RawRow[];
      return rows.map<LoyaltyMemberListRow>((r) => ({
        member_id: r.id,
        customer_id: r.customer_id,
        full_name: r.customers?.full_name ?? '—',
        customer_code: r.customers?.customer_code ?? null,
        email: r.customers?.email ?? null,
        tier_name: r.current_tier?.name ?? 'Unknown',
        tier_multiplier: Number(r.current_tier?.points_multiplier ?? 1),
        tier_color_hex: r.current_tier?.color_hex ?? null,
        remaining_points: Number(r.remaining_points || 0),
        total_points_earned: Number(r.total_points_earned || 0),
        cumulative_spend_jpy: Number(r.cumulative_spend_jpy || 0),
        enrolled_at: r.enrolled_at,
        last_purchase_at: r.last_purchase_at,
        activity_status: deriveActivity(r.last_purchase_at),
      }));
    },
  });
}

export interface UseLoyaltyMembersInput {
  search: string;
  tierFilter: string; // 'all' or tier name
  activityFilter: ActivityFilter;
  sortKey: MemberSortKey;
  sortDir: SortDir;
  page: number;
  pageSize: number;
}

export interface UseLoyaltyMembersResult {
  rows: LoyaltyMemberListRow[];
  totalFiltered: number;
  totalPages: number;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Loads ALL loyalty members in one query and filters/sorts/paginates
 * in JS. Safe at the current member count (~464 per CLAUDE.md). If the
 * list grows past a few thousand, swap to a server-side RPC.
 */
export function useLoyaltyMembers(input: UseLoyaltyMembersInput): UseLoyaltyMembersResult {
  const { data, isLoading, isError } = useAllMembersQuery();

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = input.search.trim().toLowerCase();
    return data.filter((r) => {
      if (input.tierFilter !== 'all' && r.tier_name !== input.tierFilter) return false;
      if (input.activityFilter !== 'all' && r.activity_status !== input.activityFilter) return false;
      if (term) {
        const hay = `${r.full_name} ${r.customer_code ?? ''} ${r.email ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [data, input.search, input.tierFilter, input.activityFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = input.sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let av: string | number | null;
      let bv: string | number | null;
      switch (input.sortKey) {
        case 'full_name':
          av = a.full_name.toLowerCase();
          bv = b.full_name.toLowerCase();
          break;
        case 'tier':
          av = a.tier_name.toLowerCase();
          bv = b.tier_name.toLowerCase();
          break;
        case 'remaining_points':
          av = a.remaining_points;
          bv = b.remaining_points;
          break;
        case 'cumulative_spend_jpy':
          av = a.cumulative_spend_jpy;
          bv = b.cumulative_spend_jpy;
          break;
        case 'last_purchase_at':
          av = a.last_purchase_at ? new Date(a.last_purchase_at).getTime() : 0;
          bv = b.last_purchase_at ? new Date(b.last_purchase_at).getTime() : 0;
          break;
        case 'enrolled_at':
          av = new Date(a.enrolled_at).getTime();
          bv = new Date(b.enrolled_at).getTime();
          break;
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  }, [filtered, input.sortKey, input.sortDir]);

  const totalFiltered = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / input.pageSize));
  const safePage = Math.min(input.page, totalPages - 1);

  const rows = useMemo(
    () => sorted.slice(safePage * input.pageSize, (safePage + 1) * input.pageSize),
    [sorted, safePage, input.pageSize],
  );

  return { rows, totalFiltered, totalPages, isLoading, isError };
}
