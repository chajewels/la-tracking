import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appliedCouponJpy, couponBlock, couponSettle, couponStateFrom, fullPriceSubtotalJpy, normalizeCouponCode,
} from "../../supabase/functions/_shared/website-coupons.ts";
import {
  couponPayload, couponStatus, emptyCouponForm, normalizeCode, usesLabel, validateCouponForm,
} from "@/components/website/coupons";

// Coupon codes (owner 2026-10-15). The maths is website_coupon_quote (SQL);
// these are the edge-function relays and the Hub card's form rules.

describe("edge relays", () => {
  it("normalises the code; empty is no coupon", () => {
    expect(normalizeCouponCode("  save10 ")).toBe("SAVE10");
    expect(normalizeCouponCode("")).toBeNull();
    expect(normalizeCouponCode(null)).toBeNull();
  });

  it("the full-price basis counts only lines at the variant's full price", () => {
    const items = [
      { variant_id: "a", unit_price_jpy: 10000, line_total_jpy: 20000 },
      { variant_id: "b", unit_price_jpy: 8000, line_total_jpy: 8000 },
    ];
    expect(fullPriceSubtotalJpy(items, new Map([["a", 10000], ["b", 9000]]))).toBe(20000);
  });

  it("pesos convert half-up at the quote's rate, as SQL round()", () => {
    expect(couponSettle(1000, "JPY", null)).toBe(1000);
    expect(couponSettle(1001, "PHP", 0.385)).toBe(385); // 385.385
    expect(couponSettle(0, "PHP", 0.385)).toBe(0);
  });

  it("an accepted code gives the block; a refused one shows its reason and applies nothing", () => {
    const ok = couponStateFrom("SAVE10", { ok: true, coupon_id: "x", code: "SAVE10", kind: "percent", value: 10, discount_jpy: 1234 });
    expect(appliedCouponJpy(ok)).toBe(1234);
    expect(couponBlock(ok, "JPY", null)).toMatchObject({ code: "SAVE10", discount_jpy: 1234, discount: 1234, error: null });
    const no = couponStateFrom("NOPE", { error: "coupon_not_found", code: "NOPE" });
    expect(appliedCouponJpy(no)).toBe(0);
    expect(couponBlock(no, "JPY", null)).toEqual({ code: "NOPE", error: "coupon_not_found" });
    expect(couponBlock(null, "JPY", null)).toBeNull();
  });
});

describe("Hub coupon form", () => {
  const valid = { ...emptyCouponForm(), code: "welcome10", value: "10" };

  it("normalises the code and accepts a valid percent coupon", () => {
    expect(normalizeCode(" welcome10 ")).toBe("WELCOME10");
    expect(validateCouponForm(valid)).toBeNull();
    expect(couponPayload(valid)).toMatchObject({ code: "WELCOME10", kind: "percent", value: 10, per_customer_limit: 1, max_uses: null });
  });

  it("refuses a bad code, percent over 100 and zero values", () => {
    expect(validateCouponForm({ ...valid, code: "AB" })).toMatch(/3–20/);
    expect(validateCouponForm({ ...valid, code: "HAS SPACE" })).toMatch(/3–20/);
    expect(validateCouponForm({ ...valid, value: "101" })).toMatch(/1 to 100/);
    expect(validateCouponForm({ ...valid, value: "0" })).toMatch(/1 to 100/);
    expect(validateCouponForm({ ...valid, kind: "amount", value: "101" })).toBeNull();
    expect(validateCouponForm({ ...valid, per_customer_limit: "0" })).toMatch(/per customer/i);
  });

  it("the end must be after the start", () => {
    expect(validateCouponForm({ ...valid, starts_at: "2026-11-02T00:00", ends_at: "2026-11-01T00:00" })).toMatch(/after the start/);
  });

  it("status and uses labels", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    expect(couponStatus({ is_active: false, starts_at: null, ends_at: null }, now)).toBe("Inactive");
    expect(couponStatus({ is_active: true, starts_at: "2026-11-01T00:00:00Z", ends_at: null }, now)).toBe("Scheduled");
    expect(couponStatus({ is_active: true, starts_at: null, ends_at: "2026-10-01T00:00:00Z" }, now)).toBe("Ended");
    expect(usesLabel({ used_count: 3, held_count: 1, max_uses: 50 })).toBe("3 used · 1 held / 50");
  });
});

// The customer's reads carry the coupon so the storefront can explain a
// reduced figure (2026-10-15). Asserted on code with comment lines stripped.
describe("website reads carry the coupon", () => {
  const code = readFileSync("supabase/functions/website/index.ts", "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const fields = (name: string) => {
    const m = code.match(new RegExp(`const ${name} =([\\s\\S]*?);\\n`));
    return (m?.[1] ?? "").replace(/["+\s]/g, "").split(",");
  };

  it("drafts: code and both amounts, selected and passed through (null / 0 when none)", () => {
    expect(fields("DRAFT_FIELDS")).toEqual(expect.arrayContaining(["coupon_code", "coupon_discount", "coupon_discount_jpy"]));
    expect(code).toContain("coupon_code: d.coupon_code ?? null,");
    expect(code).toContain("coupon_discount: Number(d.coupon_discount ?? 0),");
    expect(code).toContain("coupon_discount_jpy: Number(d.coupon_discount_jpy ?? 0),");
  });

  it("orders and plans: the code only (the value is inside the order's discount / the plan's price)", () => {
    expect(fields("ORDER_FIELDS")).toContain("coupon_code");
    expect(fields("LAYAWAY_FIELDS")).toContain("coupon_code");
    expect(fields("ORDER_FIELDS")).not.toContain("coupon_discount");
    expect(fields("LAYAWAY_FIELDS")).not.toContain("coupon_discount");
  });
});
