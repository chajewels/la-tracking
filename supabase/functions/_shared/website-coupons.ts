// Website coupon codes (owner 2026-10-15). The coupon MATHS is one SQL function,
// public.website_coupon_quote(); this file only prepares its inputs and relays
// its answer in the order's currency. Used by the `website` edge function;
// tested in src/test/website-coupons.test.ts.

import { jpyToPhpHalfUp } from "./settlement.ts";

type AnyRec = Record<string, unknown>;

/** The refusals website_coupon_quote (and create_web_draft_atomic) can give. */
export const COUPON_ERRORS = [
  "coupon_not_found", "coupon_inactive", "coupon_not_started", "coupon_expired", "coupon_exhausted",
  "coupon_customer_limit", "coupon_min_subtotal", "coupon_layaway_not_allowed", "coupon_full_price_only",
  "coupon_changed", "coupon_total_zero",
] as const;

/** Upper-cased, trimmed code; null when nothing was entered. */
export function normalizeCouponCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const code = String(raw).trim().toUpperCase();
  return code === "" ? null : code;
}

/**
 * The pieces whose price is NOT a sale price: the basis of a full_price_only
 * coupon. A quote line is full price when its unit price equals the variant's
 * price_jpy (create_web_draft_atomic makes the same comparison in SQL).
 */
export function fullPriceSubtotalJpy(items: AnyRec[], priceById: Map<string, number>): number {
  let sum = 0;
  for (const it of items) {
    const full = priceById.get(String(it.variant_id ?? ""));
    if (full !== undefined && Number(it.unit_price_jpy) === full) sum += Number(it.line_total_jpy ?? 0);
  }
  return sum;
}

/** Coupon yen in the order's currency: yen as is, pesos half-up at the quote's rate (as SQL round()). */
export function couponSettle(jpy: number, currency: "JPY" | "PHP", rate: number | null): number {
  if (!(jpy > 0)) return 0;
  if (currency === "JPY") return jpy;
  if (rate === null || !(rate > 0)) throw new Error("fx_rate_missing");
  return jpyToPhpHalfUp(jpy, rate);
}

export type CouponState =
  | { ok: true; coupon_id: string; code: string; kind: string; value: number; discount_jpy: number }
  | { ok: false; code: string; error: string; payload: AnyRec }
  | null;

/** website_coupon_quote's jsonb answer → CouponState. */
export function couponStateFrom(code: string, answer: unknown): CouponState {
  const a = (answer ?? {}) as AnyRec;
  if (a.ok === true) {
    return {
      ok: true, coupon_id: String(a.coupon_id), code: String(a.code ?? code), kind: String(a.kind),
      value: Number(a.value), discount_jpy: Math.max(0, Math.floor(Number(a.discount_jpy ?? 0))),
    };
  }
  return { ok: false, code: String(a.code ?? code), error: String(a.error ?? "coupon_not_found"), payload: a };
}

/** The `coupon` block the storefront renders (null = no coupon entered). */
export function couponBlock(state: CouponState, currency: "JPY" | "PHP", rate: number | null): AnyRec | null {
  if (!state) return null;
  if (!state.ok) return { code: state.code, error: state.error };
  return {
    code: state.code, kind: state.kind, value: state.value,
    discount_jpy: state.discount_jpy, discount: couponSettle(state.discount_jpy, currency, rate), error: null,
  };
}

/** The coupon yen that actually applies (0 when none, or when it was refused). */
export function appliedCouponJpy(state: CouponState): number {
  return state && state.ok ? state.discount_jpy : 0;
}
