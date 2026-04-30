import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type BannerType = 'featured' | 'promo';

export interface LoyaltyBannerRow {
  id: string;
  banner_type: BannerType;
  title: string;
  subtitle: string | null;
  description: string | null;
  image_url: string | null;
  emoji: string | null;
  link_target: string | null;
  applicable_tiers: string[] | null;
  is_active: boolean;
  display_priority: number;
  start_at: string | null;
  end_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

const BANNER_COLUMNS =
  'id, banner_type, title, subtitle, description, image_url, emoji, link_target, applicable_tiers, is_active, display_priority, start_at, end_at, created_by_user_id, created_at, updated_at';

/** Admin view: includes inactive + out-of-window banners. */
export function useLoyaltyBanners(enabled: boolean = true) {
  return useQuery<LoyaltyBannerRow[]>({
    queryKey: ['loyalty-admin-banners'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_banners')
        .select(BANNER_COLUMNS)
        .order('banner_type', { ascending: true })
        .order('display_priority', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown) as LoyaltyBannerRow[];
    },
  });
}

function isWithinSchedule(b: LoyaltyBannerRow, nowMs: number): boolean {
  if (b.start_at && new Date(b.start_at).getTime() > nowMs) return false;
  if (b.end_at && new Date(b.end_at).getTime() < nowMs) return false;
  return true;
}

/**
 * Customer-facing: only is_active banners of the given type, filtered
 * by start_at/end_at schedule. Schedule filter runs in JS because the
 * is-null-or-≤-now expression is awkward in PostgREST.
 */
export function useLoyaltyBannersByType(
  type: BannerType,
  enabled: boolean = true,
) {
  const query = useQuery<LoyaltyBannerRow[]>({
    queryKey: ['loyalty-banners-by-type', type],
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_banners')
        .select(BANNER_COLUMNS)
        .eq('banner_type', type)
        .eq('is_active', true)
        .order('display_priority', { ascending: false });
      if (error) throw error;
      return ((data || []) as unknown) as LoyaltyBannerRow[];
    },
  });

  const filtered = useMemo(() => {
    if (!query.data) return [];
    const now = Date.now();
    return query.data.filter((b) => isWithinSchedule(b, now));
  }, [query.data]);

  return { ...query, data: filtered };
}

export interface CreateBannerInput {
  banner_type: BannerType;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  image_url?: string | null;
  emoji?: string | null;
  link_target?: string | null;
  applicable_tiers?: string[] | null;
  is_active?: boolean;
  display_priority?: number;
  start_at?: string | null;
  end_at?: string | null;
}

export function useCreateLoyaltyBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBannerInput) => {
      const { data: { user } } = await supabase.auth.getUser();
      const payload = {
        banner_type: input.banner_type,
        title: input.title,
        subtitle: input.subtitle ?? null,
        description: input.description ?? null,
        image_url: input.image_url ?? null,
        emoji: input.emoji ?? null,
        link_target: input.link_target ?? null,
        applicable_tiers: input.applicable_tiers ?? null,
        is_active: input.is_active ?? true,
        display_priority: input.display_priority ?? 0,
        start_at: input.start_at ?? null,
        end_at: input.end_at ?? null,
        created_by_user_id: user?.id ?? null,
      };

      const { data, error } = await (supabase as any)
        .from('loyalty_banners')
        .insert(payload)
        .select('id')
        .single();
      if (error) throw error;

      if (user && data) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_banner',
          entity_id: (data as any).id,
          action: 'banner_created',
          performed_by_user_id: user.id,
          new_value_json: { ...payload, id: (data as any).id },
        });
      }
      return data as { id: string };
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-banners'] });
      qc.invalidateQueries({ queryKey: ['loyalty-banners-by-type', vars.banner_type] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export interface UpdateBannerInput {
  bannerId: string;
  oldValues: LoyaltyBannerRow;
  updates: Partial<CreateBannerInput>;
}

export function useUpdateLoyaltyBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateBannerInput) => {
      const { error } = await supabase
        .from('loyalty_banners')
        .update(input.updates)
        .eq('id', input.bannerId);
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const oldDiff: Record<string, unknown> = {};
        const newDiff: Record<string, unknown> = {};
        for (const k of Object.keys(input.updates)) {
          oldDiff[k] = (input.oldValues as any)[k];
          newDiff[k] = (input.updates as any)[k];
        }
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_banner',
          entity_id: input.bannerId,
          action: 'banner_updated',
          performed_by_user_id: user.id,
          old_value_json: { banner_title: input.oldValues.title, ...oldDiff },
          new_value_json: { banner_title: input.oldValues.title, ...newDiff },
        });
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-banners'] });
      qc.invalidateQueries({ queryKey: ['loyalty-banners-by-type', vars.oldValues.banner_type] });
      // If banner_type was changed, invalidate the new type too
      if (vars.updates.banner_type && vars.updates.banner_type !== vars.oldValues.banner_type) {
        qc.invalidateQueries({ queryKey: ['loyalty-banners-by-type', vars.updates.banner_type] });
      }
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export function useDeleteLoyaltyBanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (oldValues: LoyaltyBannerRow) => {
      const { error } = await supabase
        .from('loyalty_banners')
        .delete()
        .eq('id', oldValues.id);
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_banner',
          entity_id: oldValues.id,
          action: 'banner_deleted',
          performed_by_user_id: user.id,
          old_value_json: oldValues as any,
        });
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-banners'] });
      qc.invalidateQueries({ queryKey: ['loyalty-banners-by-type', vars.banner_type] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}
