/**
 * CHECKOUT PAYMENT CHOICE + POINTS (owner plan
 * claude/checkout-payment-choice-and-points-plan-2026-10-04, C1–C7, and the
 * owner's answers of 2026-10-05: "Whole deposit allowed", "Keep rule 9").
 *
 * The PURE rules. No Deno globals, no Supabase client, so vitest runs the same
 * file the `website` edge function does (src/test/checkout-choice.test.ts).
 * create_web_draft_atomic makes the same checks again in SQL — this file
 * decides what the storefront is OFFERED; the SQL is the backstop.
 *
 *   C1 the customer picks transfer, Paidy or card at checkout; it is locked
 *      for her afterwards (only staff change it, change-payment-method).
 *   C2 on a layaway Paidy and card are shown but greyed (reason "layaway").
 *   C6 card = Square, any country, yen only; a peso order greys card AND
 *      Paidy with reason "currency_not_yen".
 *   C3/C4 points for full payment and layaway, 1 pt = ¥1, never on shipping:
 *      at most the pieces subtotal; on a layaway at most the deposit (the
 *      whole deposit is allowed, owner 2026-10-05).
 *   C7 the figures the "Use points" panel shows all come from here.
 */
import { jpyToPhpHalfUp } from "./settlement.ts";

/** What the storefront calls the methods. "card" is stored as 'square'. */
export type CheckoutMethod = "transfer" | "paidy" | "card";
export type StoredMethod = "transfer" | "paidy" | "square";

export const CHECKOUT_METHODS: CheckoutMethod[] = ["transfer", "paidy", "card"];

/** card → square; anything unknown → null. */
export function storedMethod(m: unknown): StoredMethod | null {
  const v = String(m ?? "").trim().toLowerCase();
  if (v === "transfer" || v === "paidy") return v;
  if (v === "card" || v === "square") return "square";
  return null;
}

/** square → card; null/unknown → transfer (every order before 2026-10-05 was transfer). */
export function publicMethod(m: unknown): CheckoutMethod {
  const v = String(m ?? "").trim().toLowerCase();
  if (v === "paidy") return "paidy";
  if (v === "square" || v === "card") return "card";
  return "transfer";
}

export type ProviderMode = "off" | "test" | "on";

export interface MethodOptionsInput {
  mode: "full" | "layaway";
  currency: "JPY" | "PHP";
  /** Delivery country of the quote's address, upper-case ISO. */
  country: string | null | undefined;
  paidyMode: ProviderMode;
  squareMode: ProviderMode;
  customerIsTest: boolean;
  /** A transfer account exists for the currency (transferAvailable). */
  transferAvailable: boolean;
}

export interface MethodOption {
  available: boolean;
  /** Why it is greyed: layaway | currency_not_yen | address_not_jp | off | no_account. */
  reason: string | null;
}

/**
 * The three choices and why any is greyed. One reason each, the first that
 * fails, in the order the customer can do something about it.
 */
export function checkoutMethodOptions(i: MethodOptionsInput): Record<CheckoutMethod, MethodOption> {
  const providerOff = (m: ProviderMode) => m === "off" || (m === "test" && !i.customerIsTest);
  const paidyReason =
    i.mode === "layaway" ? "layaway"
    : i.currency !== "JPY" ? "currency_not_yen"
    : providerOff(i.paidyMode) ? "off"
    : String(i.country ?? "").toUpperCase() !== "JP" ? "address_not_jp"
    : null;
  const cardReason =
    i.mode === "layaway" ? "layaway"
    : i.currency !== "JPY" ? "currency_not_yen"
    : providerOff(i.squareMode) ? "off"
    : null;
  return {
    transfer: { available: i.transferAvailable, reason: i.transferAvailable ? null : "no_account" },
    paidy: { available: paidyReason === null, reason: paidyReason },
    card: { available: cardReason === null, reason: cardReason },
  };
}

/** The value of `points` in the order's currency: ¥ 1:1, ₱ converted once at the quote's rate, half-up (as the SQL). */
export function pointsValue(points: number, currency: "JPY" | "PHP", rate: number | null): number {
  if (!Number.isSafeInteger(points) || points <= 0) return 0;
  if (currency === "JPY") return points;
  if (rate === null || !(rate > 0)) throw new Error("fx_rate_missing");
  return jpyToPhpHalfUp(points, rate);
}

export interface PointsCapInput {
  /** Points she can spend now: remaining_points − points held by pending redemptions. */
  available: number;
  /** Pieces subtotal in yen — never shipping (C4). */
  subtotalJpy: number;
  /** In the order's currency: the pieces subtotal (full payment) or the deposit (layaway). */
  limitSettle: number;
  currency: "JPY" | "PHP";
  rate: number | null;
}

/** The most points this checkout can take. Never negative; peso orders never exceed the limit after rounding. */
export function maxUsablePoints(i: PointsCapInput): number {
  let hi = Math.floor(Math.min(i.available, i.subtotalJpy));
  if (!(hi > 0) || !(i.limitSettle > 0)) return 0;
  if (i.currency === "JPY") return Math.max(0, Math.min(hi, Math.floor(i.limitSettle)));
  // Largest P <= hi with pointsValue(P) <= limit. pointsValue is monotonic.
  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (pointsValue(mid, "PHP", i.rate) <= i.limitSettle) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export interface PointsStatusInput {
  loyaltyEnabled: boolean;
  enrolled: boolean;
  remainingPoints: number;
  heldPoints: number;
}

/** Why points cannot be used (C7 "not enrolled / 0 points shows why"), or null. */
export function pointsUnavailableReason(i: PointsStatusInput): string | null {
  if (!i.loyaltyEnabled) return "loyalty_off";
  if (!i.enrolled) return "not_enrolled";
  if (Math.max(0, Math.floor(i.remainingPoints - i.heldPoints)) <= 0) return "no_points";
  return null;
}

/** Why `points` cannot be applied to this checkout, or null. Mirrors create_web_draft_atomic. */
export function pointsChoiceProblem(points: unknown, max: number, reason: string | null): string | null {
  const n = Number(points ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) return "bad_points";
  if (n === 0) return null;
  if (reason) return reason === "not_enrolled" ? "points_not_enrolled" : reason === "no_points" ? "points_insufficient" : "points_unavailable";
  if (n > max) return "points_exceed_max";
  return null;
}
