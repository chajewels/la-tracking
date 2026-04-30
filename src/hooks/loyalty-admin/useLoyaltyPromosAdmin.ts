import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LoyaltyPromoRow {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  start_date: string;
  end_date: string;
  bonus_points: number;
  applicable_tiers: string[] | null;
  max_per_customer: number | null;
  applies_per_purchase: boolean;
  display_priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
}

export interface PromoStats {
  uses: number;
  unique_customers: number;
  total_bonus_points: number;
}

export interface LoyaltyPromoWithStats extends LoyaltyPromoRow {
  stats: PromoStats;
}

interface BonusTxRow {
  promo_id: string | null;
  member_id: string;
  points_amount: number;
}

const EMPTY_STATS: PromoStats = {
  uses: 0,
  unique_customers: 0,
  total_bonus_points: 0,
};

export function useLoyaltyPromos(enabled: boolean = true) {
  return useQuery<LoyaltyPromoWithStats[]>({
    queryKey: ['loyalty-admin-promos'],
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const [promosRes, txsRes] = await Promise.all([
        supabase
          .from('loyalty_promos')
          .select(
            'id, name, description, image_url, start_date, end_date, bonus_points, applicable_tiers, max_per_customer, applies_per_purchase, display_priority, is_active, created_at, updated_at, created_by_user_id',
          )
          .order('display_priority', { ascending: false })
          .order('start_date', { ascending: false }),
        supabase
          .from('loyalty_transactions')
          .select('promo_id, member_id, points_amount')
          .eq('transaction_type', 'bonus')
          .not('promo_id', 'is', null),
      ]);
      if (promosRes.error) throw promosRes.error;
      if (txsRes.error) throw txsRes.error;

      const promos = ((promosRes.data || []) as unknown) as LoyaltyPromoRow[];
      const txs = ((txsRes.data || []) as unknown) as BonusTxRow[];

      const statsByPromo = new Map<string, { uses: number; members: Set<string>; pts: number }>();
      for (const tx of txs) {
        if (!tx.promo_id) continue;
        let entry = statsByPromo.get(tx.promo_id);
        if (!entry) {
          entry = { uses: 0, members: new Set(), pts: 0 };
          statsByPromo.set(tx.promo_id, entry);
        }
        entry.uses += 1;
        entry.members.add(tx.member_id);
        entry.pts += Number(tx.points_amount || 0);
      }

      return promos.map<LoyaltyPromoWithStats>((p) => {
        const s = statsByPromo.get(p.id);
        return {
          ...p,
          stats: s
            ? {
                uses: s.uses,
                unique_customers: s.members.size,
                total_bonus_points: s.pts,
              }
            : EMPTY_STATS,
        };
      });
    },
  });
}

export interface CreatePromoInput {
  name: string;
  description?: string | null;
  image_url?: string | null;
  start_date: string;
  end_date: string;
  bonus_points: number;
  applicable_tiers?: string[] | null;
  max_per_customer?: number | null;
  applies_per_purchase?: boolean;
  display_priority?: number;
  is_active?: boolean;
}

export function useCreateLoyaltyPromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePromoInput) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await (supabase as any)
        .from('loyalty_promos')
        .insert({
          name: input.name,
          description: input.description ?? null,
          image_url: input.image_url ?? null,
          start_date: input.start_date,
          end_date: input.end_date,
          bonus_points: input.bonus_points,
          applicable_tiers: input.applicable_tiers ?? null,
          max_per_customer: input.max_per_customer ?? null,
          applies_per_purchase: input.applies_per_purchase ?? false,
          display_priority: input.display_priority ?? 0,
          is_active: input.is_active ?? true,
          created_by_user_id: user?.id ?? null,
        })
        .select('id')
        .single();
      if (error) throw error;

      if (user && data) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_promo',
          entity_id: (data as any).id,
          action: 'promo_created',
          performed_by_user_id: user.id,
          new_value_json: { ...input, id: (data as any).id },
        });
      }
      return data as { id: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-promos'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export interface UpdatePromoInput {
  promoId: string;
  oldValues: LoyaltyPromoRow;
  updates: Partial<CreatePromoInput>;
}

export function useUpdateLoyaltyPromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdatePromoInput) => {
      const { error } = await supabase
        .from('loyalty_promos')
        .update(input.updates)
        .eq('id', input.promoId);
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
          entity_type: 'loyalty_promo',
          entity_id: input.promoId,
          action: 'promo_updated',
          performed_by_user_id: user.id,
          old_value_json: { promo_name: input.oldValues.name, ...oldDiff },
          new_value_json: { promo_name: input.oldValues.name, ...newDiff },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-promos'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}

export function useDeleteLoyaltyPromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (oldValues: LoyaltyPromoRow) => {
      const { error } = await supabase
        .from('loyalty_promos')
        .delete()
        .eq('id', oldValues.id);
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('audit_logs').insert({
          entity_type: 'loyalty_promo',
          entity_id: oldValues.id,
          action: 'promo_deleted',
          performed_by_user_id: user.id,
          old_value_json: oldValues as any,
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['loyalty-admin-promos'] });
      qc.invalidateQueries({ queryKey: ['loyalty-admin-audit-log'] });
    },
  });
}
