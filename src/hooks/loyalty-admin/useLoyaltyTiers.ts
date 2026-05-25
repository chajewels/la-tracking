import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LoyaltyTierRow {
  id: string;
  name: string;
  min_spend_jpy: number;
  points_multiplier: number;
  color_hex: string | null;
  display_order: number;
  free_shipping_min_items: number | null;
  mystery_gift: boolean;
  benefits: string[];
  created_at: string;
}

export interface LoyaltyTierUpdate {
  min_spend_jpy?: number;
  points_multiplier?: number;
  color_hex?: string | null;
  free_shipping_min_items?: number | null;
  mystery_gift?: boolean;
  benefits?: string[];
}

export function useLoyaltyTiers(enabled: boolean = true) {
  return useQuery<LoyaltyTierRow[]>({
    queryKey: ['loyalty-admin-tiers'],
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('loyalty_tiers')
        .select(
          'id, name, min_spend_jpy, points_multiplier, color_hex, display_order, free_shipping_min_items, mystery_gift, created_at, benefits',
        )
        .order('display_order', { ascending: true });
      if (error) throw error;
      return ((data || []) as unknown) as LoyaltyTierRow[];
    },
  });
}

export interface UpdateTierInput {
  tierId: string;
  oldValues: LoyaltyTierRow;
  updates: LoyaltyTierUpdate;
}

export function useUpdateLoyaltyTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateTierInput) => {
      const { tierId, oldValues, updates } = input;

      const { error: updateErr } = await supabase
        .from('loyalty_tiers')
        .update(updates)
        .eq('id', tierId);
      if (updateErr) throw updateErr;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const oldDiff: Record<string, unknown> = {};
        const newDiff: Record<string, unknown> = {};
        for (const k of Object.keys(updates) as Array<keyof LoyaltyTierUpdate>) {
          oldDiff[k] = (oldValues as any)[k];
          newDiff[k] = (updates as any)[k];
        }
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_tier',
          entity_id: tierId,
          action: 'tier_updated',
          performed_by_user_id: user.id,
          old_value_json: { tier_name: oldValues.name, ...oldDiff },
          new_value_json: { tier_name: oldValues.name, ...newDiff },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-tiers'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-stats'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-members'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}
