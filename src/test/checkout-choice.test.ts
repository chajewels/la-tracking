import { describe, expect, it } from "vitest";
import {
  checkoutMethodOptions, maxUsablePoints, pointsChoiceProblem, pointsUnavailableReason, pointsValue,
  publicMethod, storedMethod,
} from "../../supabase/functions/_shared/checkout-choice.ts";

// Checkout payment choice + points (owner C1–C7, 2026-10-05). The same file
// the `website` edge function imports; create_web_draft_atomic re-checks in SQL.

const base = {
  mode: "full" as const, currency: "JPY" as const, country: "JP", paidyMode: "on" as const, squareMode: "on" as const,
  customerIsTest: false, transferAvailable: true,
};

describe("storedMethod / publicMethod", () => {
  it("maps card to square and back; unknown is refused", () => {
    expect(storedMethod("card")).toBe("square");
    expect(storedMethod("Paidy")).toBe("paidy");
    expect(storedMethod("transfer")).toBe("transfer");
    expect(storedMethod("cash")).toBeNull();
    expect(publicMethod("square")).toBe("card");
    expect(publicMethod(null)).toBe("transfer");
  });
});

describe("checkoutMethodOptions — what is offered, what is greyed and why", () => {
  it("full yen order to Japan: all three", () => {
    const o = checkoutMethodOptions(base);
    expect(o.transfer).toEqual({ available: true, reason: null });
    expect(o.paidy).toEqual({ available: true, reason: null });
    expect(o.card).toEqual({ available: true, reason: null });
  });
  it("C2: layaway greys Paidy and card", () => {
    const o = checkoutMethodOptions({ ...base, mode: "layaway" });
    expect(o.paidy.reason).toBe("layaway");
    expect(o.card.reason).toBe("layaway");
    expect(o.transfer.available).toBe(true);
  });
  it("C6: a peso order greys card and Paidy (yen only)", () => {
    const o = checkoutMethodOptions({ ...base, currency: "PHP", country: "PH" });
    expect(o.card.reason).toBe("currency_not_yen");
    expect(o.paidy.reason).toBe("currency_not_yen");
  });
  it("card ships anywhere; Paidy needs a Japanese address", () => {
    const o = checkoutMethodOptions({ ...base, country: "PH" });
    expect(o.card.available).toBe(true);
    expect(o.paidy.reason).toBe("address_not_jp");
  });
  it("a switch that is off, or test mode for a real customer, is off", () => {
    expect(checkoutMethodOptions({ ...base, paidyMode: "off" }).paidy.reason).toBe("off");
    expect(checkoutMethodOptions({ ...base, squareMode: "test" }).card.reason).toBe("off");
    expect(checkoutMethodOptions({ ...base, squareMode: "test", customerIsTest: true }).card.available).toBe(true);
  });
  it("no transfer account for the currency greys transfer", () => {
    expect(checkoutMethodOptions({ ...base, transferAvailable: false }).transfer).toEqual({ available: false, reason: "no_account" });
  });
});

describe("pointsValue — 1 pt = ¥1, pesos once at the quote rate, half-up", () => {
  it("yen is one to one", () => expect(pointsValue(1250, "JPY", null)).toBe(1250));
  it("pesos round half-up like Postgres", () => expect(pointsValue(100000, "PHP", 0.308345)).toBe(30835));
  it("zero or bad input is zero", () => {
    expect(pointsValue(0, "JPY", null)).toBe(0);
    expect(pointsValue(-5, "JPY", null)).toBe(0);
  });
});

describe("maxUsablePoints — never shipping, never past the deposit", () => {
  it("full yen: the smaller of balance and pieces subtotal", () => {
    expect(maxUsablePoints({ available: 13200, subtotalJpy: 19184, limitSettle: 19184, currency: "JPY", rate: null })).toBe(13200);
    expect(maxUsablePoints({ available: 30000, subtotalJpy: 19184, limitSettle: 19184, currency: "JPY", rate: null })).toBe(19184);
  });
  it("layaway yen: at most the deposit (the whole deposit is allowed)", () => {
    expect(maxUsablePoints({ available: 13200, subtotalJpy: 27980, limitSettle: 8394, currency: "JPY", rate: null })).toBe(8394);
  });
  it("pesos: the largest points whose peso value fits the limit", () => {
    const max = maxUsablePoints({ available: 50000, subtotalJpy: 27980, limitSettle: 3525, currency: "PHP", rate: 0.42 });
    expect(pointsValue(max, "PHP", 0.42)).toBeLessThanOrEqual(3525);
    expect(pointsValue(max + 1, "PHP", 0.42)).toBeGreaterThan(3525);
  });
  it("nothing to spend is zero", () => {
    expect(maxUsablePoints({ available: 0, subtotalJpy: 1000, limitSettle: 1000, currency: "JPY", rate: null })).toBe(0);
  });
});

describe("pointsUnavailableReason / pointsChoiceProblem", () => {
  it("says why points cannot be used", () => {
    expect(pointsUnavailableReason({ loyaltyEnabled: false, enrolled: true, remainingPoints: 10, heldPoints: 0 })).toBe("loyalty_off");
    expect(pointsUnavailableReason({ loyaltyEnabled: true, enrolled: false, remainingPoints: 0, heldPoints: 0 })).toBe("not_enrolled");
    expect(pointsUnavailableReason({ loyaltyEnabled: true, enrolled: true, remainingPoints: 500, heldPoints: 500 })).toBe("no_points");
    expect(pointsUnavailableReason({ loyaltyEnabled: true, enrolled: true, remainingPoints: 500, heldPoints: 0 })).toBeNull();
  });
  it("refuses a bad or too-large choice; zero is always fine", () => {
    expect(pointsChoiceProblem(0, 0, "not_enrolled")).toBeNull();
    expect(pointsChoiceProblem(1.5, 100, null)).toBe("bad_points");
    expect(pointsChoiceProblem(101, 100, null)).toBe("points_exceed_max");
    expect(pointsChoiceProblem(10, 0, "not_enrolled")).toBe("points_not_enrolled");
    expect(pointsChoiceProblem(100, 100, null)).toBeNull();
  });
});
