/**
 * Peso settlement arithmetic for a WEB order (peso full payment, 2026-09-25).
 *
 * TWIN FILE of src/lib/web-settlement.ts (the Hub's copy). src/test/peso-cash.test.ts
 * runs both over the same inputs and fails if they disagree — change one,
 * change the other.
 *
 * Yen is the price of record. A peso order is converted ONCE, at the jpy_php
 * rate captured on the checkout quote (PHP per 1 JPY, numeric(12,6)), and
 * rounded HALF-UP to a whole peso. create_web_order_atomic does the same in
 * SQL — round(total_jpy * fx_rate), where integer * numeric is exact and
 * round(numeric) rounds ties away from zero — and the SQL figure is what the
 * order stores. This must agree with it to the peso, so it is integer maths:
 * `Math.round(jpy * rate)` runs on binary floats and can land ₱1 low on an
 * exact .5: ¥100,000 × 0.308345 is exactly ₱30,834.5, which Postgres stores as
 * ₱30,835, but in floats it is 30834.499999999996 and Math.round gives 30,834.
 *
 * PHP = JPY × rate (CLAUDE.md CURRENCY CONVERSION STANDARD).
 */

/** The rate as an exact count of millionths. The rate is numeric(12,6), so this is lossless. */
function rateMicros(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("bad_fx_rate");
  return BigInt(Math.round(rate * 1_000_000));
}

/**
 * A whole-yen amount in whole pesos, half-up — exactly Postgres
 * round(jpy::integer * rate::numeric(12,6)) for jpy >= 0.
 */
export function jpyToPhpHalfUp(jpy: number, rate: number): number {
  if (!Number.isSafeInteger(jpy) || jpy < 0) throw new Error("bad_jpy_amount");
  const micros = BigInt(jpy) * rateMicros(rate);
  // floor((micros + 0.5e6) / 1e6): BigInt division truncates, and every
  // operand here is non-negative, so truncation is floor.
  return Number((micros + 500_000n) / 1_000_000n);
}

export interface PesoSettlement {
  total: number;
  shipping: number | null;
  subtotal: number;
}

/**
 * A full-payment order in pesos: total and shipping are each converted, and the
 * items are the remainder — so the parts always sum to the total. The same
 * split create_web_order_atomic writes (total_amount, shipping_fee).
 */
export function settleFullPaymentInPhp(totalJpy: number, shippingJpy: number | null, rate: number): PesoSettlement {
  const total = jpyToPhpHalfUp(totalJpy, rate);
  const shipping = shippingJpy === null ? null : jpyToPhpHalfUp(shippingJpy, rate);
  return { total, shipping, subtotal: total - (shipping ?? 0) };
}
