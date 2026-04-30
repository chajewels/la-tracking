import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type RewardCategory =
  | 'Redeem with Points'
  | 'Tier Exclusive'
  | 'Shipping Rewards'
  | 'Member-Only Offers'
  | 'VIP Vault';

export type TierVisibility = 'Glimmer' | 'Radiant' | 'Elite' | 'Crown VIP' | 'All';

export interface LoyaltyRewardRow {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  category: RewardCategory;
  tier_visibility: TierVisibility;
  points_cost: number;
  stock_limit: number | null;
  current_stock: number | null;
  is_limited: boolean;
  is_vip_only: boolean;
  is_vault: boolean;
  is_active: boolean;
  display_priority: number;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

const REWARD_COLUMNS =
  'id, name, description, image_url, category, tier_visibility, points_cost, stock_limit, current_stock, is_limited, is_vip_only, is_vault, is_active, display_priority, created_by_user_id, created_at, updated_at';

/** Admin view: includes inactive rows. */
export function useLoyaltyRewards(enabled: boolean = true) {
  return useQuery<LoyaltyRewardRow[]>({
    queryKey: ['loyalty-admin-rewards'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_rewards')
        .select(REWARD_COLUMNS)
        .order('display_priority', { ascending: false })
        .order('name', { ascending: true });
      if (error) throw error;
      return ((data || []) as unknown) as LoyaltyRewardRow[];
    },
  });
}

/** Customer-facing: only is_active = true. */
export function useLoyaltyRewardsCatalog(enabled: boolean = true) {
  return useQuery<LoyaltyRewardRow[]>({
    queryKey: ['loyalty-rewards-catalog'],
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_rewards')
        .select(REWARD_COLUMNS)
        .eq('is_active', true)
        .order('display_priority', { ascending: false })
        .order('name', { ascending: true });
      if (error) throw error;
      return ((data || []) as unknown) as LoyaltyRewardRow[];
    },
  });
}

export interface CreateRewardInput {
  name: string;
  description?: string | null;
  image_url?: string | null;
  category: RewardCategory;
  tier_visibility?: TierVisibility;
  points_cost?: number;
  stock_limit?: number | null;
  current_stock?: number | null;
  is_limited?: boolean;
  is_vip_only?: boolean;
  is_vault?: boolean;
  is_active?: boolean;
  display_priority?: number;
}

export function useCreateLoyaltyReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateRewardInput) => {
      const { data: { user } } = await supabase.auth.getUser();
      const payload = {
        name: input.name,
        description: input.description ?? null,
        image_url: input.image_url ?? null,
        category: input.category,
        tier_visibility: input.tier_visibility ?? 'All',
        points_cost: input.points_cost ?? 0,
        stock_limit: input.stock_limit ?? null,
        current_stock: input.current_stock ?? input.stock_limit ?? null,
        is_limited: input.is_limited ?? false,
        is_vip_only: input.is_vip_only ?? false,
        is_vault: input.is_vault ?? false,
        is_active: input.is_active ?? true,
        display_priority: input.display_priority ?? 0,
        created_by_user_id: user?.id ?? null,
      };

      const { data, error } = await (supabase as any)
        .from('loyalty_rewards')
        .insert(payload)
        .select('id')
        .single();
      if (error) throw error;

      if (user && data) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_reward',
          entity_id: (data as any).id,
          action: 'reward_created',
          performed_by_user_id: user.id,
          new_value_json: { ...payload, id: (data as any).id },
        });
      }
      return data as { id: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-rewards'] });
      qc.invalidateQueries({ queryKey: ['loyalty-rewards-catalog'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export interface UpdateRewardInput {
  rewardId: string;
  oldValues: LoyaltyRewardRow;
  updates: Partial<CreateRewardInput>;
}

export function useUpdateLoyaltyReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateRewardInput) => {
      const { error } = await supabase
        .from('loyalty_rewards')
        .update(input.updates)
        .eq('id', input.rewardId);
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
          entity_type: 'loyalty_reward',
          entity_id: input.rewardId,
          action: 'reward_updated',
          performed_by_user_id: user.id,
          old_value_json: { reward_name: input.oldValues.name, ...oldDiff },
          new_value_json: { reward_name: input.oldValues.name, ...newDiff },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-rewards'] });
      qc.invalidateQueries({ queryKey: ['loyalty-rewards-catalog'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export function useDeleteLoyaltyReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (oldValues: LoyaltyRewardRow) => {
      const { error } = await supabase
        .from('loyalty_rewards')
        .delete()
        .eq('id', oldValues.id);
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_reward',
          entity_id: oldValues.id,
          action: 'reward_deleted',
          performed_by_user_id: user.id,
          old_value_json: oldValues as any,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-rewards'] });
      qc.invalidateQueries({ queryKey: ['loyalty-rewards-catalog'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}
