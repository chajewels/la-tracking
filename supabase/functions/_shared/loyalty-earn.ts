// Loyalty points PREVIEW — what a purchase of this price would earn (2026-10-03,
// owner request: show signed-in members the points a piece earns at their level).
//
// This is a READ-ONLY mirror of the arithmetic in award-loyalty-points (steps
// 3, 5, 5b, 6, 7). award-loyalty-points is the ONLY award path and is NOT
// changed by this file; when its rule changes, change this mirror in the same
// PR. src/test/loyalty-earn.test.ts pins the two against each other on fixed
// examples (it reads the award function's source for the constants it relies on).
//
// Rule (award-loyalty-points):
//   - below ¥10,000 → no points
//   - base units = floor(product yen / 10,000); points = units × 100 × multiplier
//   - multiplier = the member's current tier, or the tier this purchase lifts
//     her to (ratchet-up), unless she is downgraded and has not yet re-qualified
//   - an active promo (eligible on her CURRENT tier, under its per-customer cap)
//     adds round(points × (promo_multiplier − 1)) + flat bonus points
// Pure: no I/O, no Date — the caller passes everything in.

export const MIN_ELIGIBLE_JPY = 10000;
export const POINTS_PER_UNIT = 100;

export interface EarnTier {
  id: string;
  name: string;
  min_spend_jpy: number;
  points_multiplier: number;
}

export interface EarnMember {
  current_tier_id: string;
  cumulative_spend_jpy: number;
  is_downgraded: boolean;
  downgrade_spend_baseline: number | null;
  /** requalify_spend_jpy of the member's earned tier; null = no gate. */
  requalify_target_jpy: number | null;
}

export interface EarnPromo {
  bonus_multiplier: number | null;
  bonus_points: number | null;
}

export interface EarnPreview {
  /** Total points this purchase would add: base (tier) points + promo bonus. */
  points: number;
  /** Points from the tier multiplier alone. */
  base_points: number;
  /** Promo bonus (0 when no promo applies). */
  promo_points: number;
  /** Multiplier used — the post-upgrade one when this purchase lifts her tier. */
  multiplier: number;
  /** Tier name the points are earned at. */
  tier: string;
  /** Set only when this purchase would lift her to a higher tier. */
  upgraded_to: string | null;
}

/** Points earned for `priceJpy` by this member. null = not eligible (below ¥10,000 / bad input). */
export function previewEarn(
  priceJpy: number,
  member: EarnMember,
  tiers: EarnTier[],
  promo: EarnPromo | null,
): EarnPreview | null {
  if (!Number.isFinite(priceJpy) || priceJpy < MIN_ELIGIBLE_JPY) return null;
  const current = tiers.find((t) => t.id === member.current_tier_id);
  if (!current) return null;
  const multiplier = Number(current.points_multiplier ?? 1);

  // 5b ratchet-up: the highest tier whose minimum the new lifetime spend reaches.
  const newCumulative = Number(member.cumulative_spend_jpy ?? 0) + priceJpy;
  const reached = tiers
    .filter((t) => Number(t.min_spend_jpy) <= newCumulative)
    .sort((a, b) => Number(b.min_spend_jpy) - Number(a.min_spend_jpy))[0] ?? null;
  const oldMin = Number(current.min_spend_jpy ?? 0);
  const newMin = Number(reached?.min_spend_jpy ?? oldMin);

  let requalified = true;
  if (member.is_downgraded && member.downgrade_spend_baseline != null && member.requalify_target_jpy != null) {
    requalified = newCumulative - Number(member.downgrade_spend_baseline) >= Number(member.requalify_target_jpy);
  }
  const upgraded = requalified && !!reached && newMin > oldMin;
  const effective = upgraded ? Number(reached!.points_multiplier ?? 1) : multiplier;

  const basePoints = Math.floor(priceJpy / MIN_ELIGIBLE_JPY) * POINTS_PER_UNIT * effective;
  const promoMultiplier = promo ? Number(promo.bonus_multiplier ?? 1) : 1;
  const promoPoints = promo
    ? Math.round(basePoints * (promoMultiplier - 1)) + Number(promo.bonus_points ?? 0)
    : 0;

  return {
    points: basePoints + promoPoints,
    base_points: basePoints,
    promo_points: promoPoints,
    multiplier: effective,
    tier: upgraded ? reached!.name : current.name,
    upgraded_to: upgraded ? reached!.name : null,
  };
}

/** Points a NON-member would earn at the entry tier (lowest minimum), no promo. */
export function previewEarnAsNewMember(priceJpy: number, tiers: EarnTier[]): EarnPreview | null {
  if (!Number.isFinite(priceJpy) || priceJpy < MIN_ELIGIBLE_JPY || tiers.length === 0) return null;
  const entry = [...tiers].sort((a, b) => Number(a.min_spend_jpy) - Number(b.min_spend_jpy))[0];
  const m = Number(entry.points_multiplier ?? 1);
  const base = Math.floor(priceJpy / MIN_ELIGIBLE_JPY) * POINTS_PER_UNIT * m;
  return { points: base, base_points: base, promo_points: 0, multiplier: m, tier: entry.name, upgraded_to: null };
}

/**
 * system_settings.loyalty_enabled, fail-closed exactly like award-loyalty-points
 * step 1b: anything other than a strict true is disabled.
 */
export function loyaltyEnabledFrom(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === "boolean") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed === true || parsed === "true";
  } catch {
    return String(raw).toLowerCase() === "true";
  }
}
