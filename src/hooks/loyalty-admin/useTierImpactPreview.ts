import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { LoyaltyTierRow } from './useLoyaltyTiers';

export interface TierImpact {
  current_count: number;
  count_after: number;
  delta: number;
  promoted_in: number;
  demoted_out: number;
}

interface TierLite {
  id: string;
  min_spend_jpy: number;
}

interface MemberSpend {
  cumulative_spend_jpy: number;
}

function tierForSpend(spend: number, tiers: TierLite[]): string | null {
  // tiers expected sorted ASC by min_spend_jpy
  let chosen: string | null = null;
  for (const t of tiers) {
    if (spend >= t.min_spend_jpy) chosen = t.id;
    else break;
  }
  return chosen;
}

export interface UseTierImpactInput {
  tierId: string;
  newMinSpendJpy: number;
  enabled: boolean;
}

/**
 * Computes how many members move in/out of a tier when its
 * min_spend_jpy threshold changes. Used by TierEditDialog's
 * "Impact Preview" step.
 *
 * Loads all member spends client-side. Safe at current scale
 * (~464 members per CLAUDE.md). If membership grows past a few
 * thousand, replace with a server-side RPC.
 */
export function useTierImpactPreview(input: UseTierImpactInput) {
  return useQuery<TierImpact>({
    queryKey: [
      'loyalty-admin-tier-impact',
      input.tierId,
      input.newMinSpendJpy,
    ],
    enabled: input.enabled && !!input.tierId && Number.isFinite(input.newMinSpendJpy),
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async () => {
      const [tiersRes, membersRes] = await Promise.all([
        supabase
          .from('loyalty_tiers')
          .select('id, min_spend_jpy')
          .order('min_spend_jpy', { ascending: true }),
        supabase
          .from('loyalty_members')
          .select('cumulative_spend_jpy'),
      ]);
      if (tiersRes.error) throw tiersRes.error;
      if (membersRes.error) throw membersRes.error;

      const oldTiers = ((tiersRes.data || []) as unknown) as TierLite[];
      const newTiers: TierLite[] = oldTiers
        .map((t) =>
          t.id === input.tierId
            ? { ...t, min_spend_jpy: input.newMinSpendJpy }
            : t,
        )
        .sort((a, b) => a.min_spend_jpy - b.min_spend_jpy);

      const members = ((membersRes.data || []) as unknown) as MemberSpend[];

      let current_count = 0;
      let count_after = 0;
      let promoted_in = 0;
      let demoted_out = 0;

      for (const m of members) {
        const spend = Number(m.cumulative_spend_jpy || 0);
        const oldTierId = tierForSpend(spend, oldTiers);
        const newTierId = tierForSpend(spend, newTiers);

        const wasInTier = oldTierId === input.tierId;
        const isInTier = newTierId === input.tierId;
        if (wasInTier) current_count += 1;
        if (isInTier) count_after += 1;
        if (!wasInTier && isInTier) promoted_in += 1;
        if (wasInTier && !isInTier) demoted_out += 1;
      }

      return {
        current_count,
        count_after,
        delta: count_after - current_count,
        promoted_in,
        demoted_out,
      };
    },
  });
}

export type { LoyaltyTierRow };
