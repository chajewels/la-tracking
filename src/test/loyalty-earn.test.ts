import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loyaltyEnabledFrom,
  previewEarn,
  previewEarnAsNewMember,
  type EarnMember,
  type EarnTier,
} from "../../supabase/functions/_shared/loyalty-earn.ts";

// Points preview on the website product page (2026-10-03). The preview mirrors
// award-loyalty-points; these tests pin the mirror to the award's arithmetic.

const TIERS: EarnTier[] = [
  { id: "g", name: "Glimmer", min_spend_jpy: 0, points_multiplier: 1 },
  { id: "r", name: "Radiant", min_spend_jpy: 300000, points_multiplier: 2 },
  { id: "e", name: "Elite", min_spend_jpy: 1000000, points_multiplier: 2 },
  { id: "c", name: "Crown VIP", min_spend_jpy: 3000000, points_multiplier: 3 },
];

const member = (over: Partial<EarnMember> = {}): EarnMember => ({
  current_tier_id: "g",
  cumulative_spend_jpy: 0,
  is_downgraded: false,
  downgrade_spend_baseline: null,
  requalify_target_jpy: null,
  ...over,
});

describe("previewEarn — mirrors award-loyalty-points", () => {
  it("below ¥10,000 earns nothing", () => {
    expect(previewEarn(9999, member(), TIERS, null)).toBeNull();
  });

  it("floor(price / 10,000) × 100 × tier multiplier", () => {
    const r = previewEarn(159800, member({ current_tier_id: "r", cumulative_spend_jpy: 400000 }), TIERS, null)!;
    expect(r).toMatchObject({ points: 3000, base_points: 3000, multiplier: 2, tier: "Radiant", upgraded_to: null });
  });

  it("a purchase that lifts her tier earns at the higher multiplier (ratchet-up)", () => {
    const r = previewEarn(250000, member({ current_tier_id: "g", cumulative_spend_jpy: 100000 }), TIERS, null)!;
    expect(r).toMatchObject({ points: 5000, multiplier: 2, tier: "Radiant", upgraded_to: "Radiant" });
  });

  it("a downgraded member who has not re-qualified stays on her current multiplier", () => {
    const m = member({
      current_tier_id: "r", cumulative_spend_jpy: 1200000, is_downgraded: true,
      downgrade_spend_baseline: 1200000, requalify_target_jpy: 500000,
    });
    const r = previewEarn(100000, m, TIERS, null)!;
    expect(r).toMatchObject({ points: 2000, multiplier: 2, tier: "Radiant", upgraded_to: null });
    const r2 = previewEarn(3000000, m, TIERS, null)!; // re-qualifies and reaches Crown
    expect(r2.upgraded_to).toBe("Crown VIP");
  });

  it("an active promo adds round(points × (m − 1)) + flat bonus", () => {
    const r = previewEarn(100000, member({ current_tier_id: "r", cumulative_spend_jpy: 400000 }), TIERS, {
      bonus_multiplier: 1.5, bonus_points: 200,
    })!;
    expect(r).toMatchObject({ base_points: 2000, promo_points: 1200, points: 3200 });
  });

  it("a non-member sees the entry-tier figure with no promo", () => {
    expect(previewEarnAsNewMember(120000, TIERS)).toMatchObject({ points: 1200, tier: "Glimmer", multiplier: 1 });
    expect(previewEarnAsNewMember(5000, TIERS)).toBeNull();
  });

  it("loyalty_enabled is fail-closed", () => {
    expect(loyaltyEnabledFrom(true)).toBe(true);
    expect(loyaltyEnabledFrom("true")).toBe(true);
    expect(loyaltyEnabledFrom('"true"')).toBe(true);
    expect(loyaltyEnabledFrom(false)).toBe(false);
    expect(loyaltyEnabledFrom(null)).toBe(false);
    expect(loyaltyEnabledFrom("yes")).toBe(false);
  });
});

describe("award-loyalty-points still uses the rule this preview mirrors", () => {
  // If one of these fails, the award rule changed: update _shared/loyalty-earn.ts
  // in the same PR, then these strings.
  const award = readFileSync("supabase/functions/award-loyalty-points/index.ts", "utf8");
  it.each([
    "loyaltyJpy < 10000",
    "Math.floor(loyaltyJpy / 10000)",
    "baseUnits * 100 * effectiveMultiplier",
    "Math.round(points * (promoMultiplier - 1))",
    "deltaFromMultiplier + flatBonus",
    'tiersAllowed.includes(currentTier.name)',
    "newMin > oldMin",
  ])("award source contains %s", (needle) => {
    expect(award).toContain(needle);
  });
});
