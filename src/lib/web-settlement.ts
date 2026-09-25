/**
 * Peso settlement arithmetic for a WEB order (peso full payment, 2026-09-25).
 *
 * TWIN FILE of supabase/functions/_shared/settlement.ts (the edge functions'
 * copy). src/test/peso-cash.test.ts runs both over the same inputs and fails
 * if they disagree — change one, change the other.
 *
 * A web peso order was converted once, at the rate captured on its checkout
 * quote and stored on the order as cash_orders.fx_rate_used, rounded half-up
 * to a whole peso (create_web_order_atomic). Integer maths, so a Hub figure
 * derived from the stored rate matches the stored order to the peso.
 *
 * PHP = JPY × rate (CLAUDE.md CURRENCY CONVERSION STANDARD).
 */

function rateMicros(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('bad_fx_rate');
  return BigInt(Math.round(rate * 1_000_000));
}

/** Whole yen → whole pesos, half-up: exactly Postgres round(jpy * rate::numeric(12,6)) for jpy >= 0. */
export function jpyToPhpHalfUp(jpy: number, rate: number): number {
  if (!Number.isSafeInteger(jpy) || jpy < 0) throw new Error('bad_jpy_amount');
  const micros = BigInt(jpy) * rateMicros(rate);
  return Number((micros + 500_000n) / 1_000_000n);
}

export interface PesoSettlement {
  total: number;
  shipping: number | null;
  subtotal: number;
}

/** Total and shipping converted separately; the items are the remainder. */
export function settleFullPaymentInPhp(totalJpy: number, shippingJpy: number | null, rate: number): PesoSettlement {
  const total = jpyToPhpHalfUp(totalJpy, rate);
  const shipping = shippingJpy === null ? null : jpyToPhpHalfUp(shippingJpy, rate);
  return { total, shipping, subtotal: total - (shipping ?? 0) };
}

/**
 * Manage Invoice's items subtotal in the order's own currency.
 *
 * - Yen order: the yen figure, unchanged.
 * - Peso order carrying fx_rate_used (a web peso order): the rate the customer
 *   was actually charged, half-up — never the per-browser staff rate.
 * - Peso order without it (Hub-arranged): today's behaviour, the staff rate
 *   passed in by the caller (getConversionRate()).
 */
export function itemsSubtotalInOrderCurrency(
  itemsJpy: number,
  order: { currency?: string | null; fx_rate_used?: number | string | null } | null | undefined,
  staffRate: () => number,
): number {
  if (order?.currency !== 'PHP') return itemsJpy;
  const stored = order.fx_rate_used == null ? NaN : Number(order.fx_rate_used);
  if (Number.isFinite(stored) && stored > 0 && Number.isSafeInteger(itemsJpy) && itemsJpy >= 0) {
    return jpyToPhpHalfUp(itemsJpy, stored);
  }
  return Math.round(itemsJpy * staffRate());
}
