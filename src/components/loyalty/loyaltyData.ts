import { useSyncExternalStore } from 'react';

export type TierName = 'Glimmer' | 'Radiant' | 'Elite' | 'Crown VIP';

export interface TierStatic {
  icon: string;
  tagline: string;
  benefits: string[];
  accent: string;
  textGradient: string;
}

export const TIER_STATIC: Record<TierName, TierStatic> = {
  Glimmer: {
    icon: '✦',
    tagline: 'Begin your golden journey',
    benefits: ['1× points base earn rate'],
    accent: '#9A8F7E',
    textGradient: 'linear-gradient(135deg,#B5A992 0%,#D9CFB8 50%,#B5A992 100%)',
  },
  Radiant: {
    icon: '◆',
    tagline: 'Shine brighter with every purchase',
    benefits: [
      '1.5× points',
      'Free intl. shipping on 4+ items',
      'Priority support',
    ],
    accent: '#C9A84C',
    textGradient: 'linear-gradient(135deg,#C9A84C 0%,#E8C96D 50%,#C9A84C 100%)',
  },
  Elite: {
    icon: '★',
    tagline: 'Experience true gold exclusivity',
    benefits: [
      '2× points',
      'Free intl. shipping on 4+ items',
      'Priority support',
      'Early collection access',
    ],
    accent: '#E8C96D',
    textGradient: 'linear-gradient(135deg,#E8C96D 0%,#F4D78F 50%,#E8C96D 100%)',
  },
  'Crown VIP': {
    icon: '👑',
    tagline: 'The pinnacle of golden luxury',
    benefits: [
      '3× points',
      'Free intl. shipping on 3+ items',
      'Mystery gifts',
      'VIP concierge',
      'Annual VIP event',
      'Limited edition access',
    ],
    accent: '#F4D78F',
    textGradient: 'linear-gradient(135deg,#F4D78F 0%,#FFFFFF 50%,#F4D78F 100%)',
  },
};

export type ActivityStatus = 'Active' | 'Inactive';

export interface LoyaltyMemberData {
  customer_name: string;
  member_id: string;
  current_tier: TierName;
  is_downgraded: boolean;
  available_points: number;
  lifetime_points_earned: number;
  redeemed_points: number;
  lifetime_spend_yen: number;
  current_multiplier: number;
  amount_needed_for_next_tier: number;
  activity_status: ActivityStatus;
  email: string | null;
  join_date: string;
  last_purchase_date: string | null;
}

export interface LoyaltyTierData extends TierStatic {
  name: TierName;
  spendRequired: number;
  multiplier: number;
}

export interface LoyaltyTransactionData {
  id: string;
  date: string;
  type: 'earned' | 'redeemed';
  points: number;
  description: string;
  source: string;
  invoice_number?: string | null;
  spend_amount_jpy?: number | null;
  tier_multiplier?: number | null;
}

interface LoyaltySnapshot {
  member: LoyaltyMemberData | null;
  tiers: LoyaltyTierData[];
  transactions: LoyaltyTransactionData[];
}

let snapshot: LoyaltySnapshot = {
  member: null,
  tiers: [],
  transactions: [],
};

const listeners = new Set<() => void>();

export function setLoyaltyData(
  member: LoyaltyMemberData | null,
  tiers: LoyaltyTierData[],
  transactions: LoyaltyTransactionData[],
): void {
  if (
    snapshot.member === member &&
    snapshot.tiers === tiers &&
    snapshot.transactions === transactions
  ) {
    return;
  }
  snapshot = { member, tiers, transactions };
  listeners.forEach((fn) => fn());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): LoyaltySnapshot {
  return snapshot;
}

export function useLoyaltyData(): LoyaltySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
