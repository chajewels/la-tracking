/**
 * Shipping fees (Website → Settings): the rules, words and shapes the card
 * uses, kept out of ShippingFeesCard.tsx so the component file exports only
 * components and the rules can be unit-tested.
 *
 * The rate card is public.shipping_rates, read by the website function's
 * shippingFor(): shipping is charged on the pieces subtotal, and the active
 * row with the HIGHEST min_subtotal_jpy the subtotal clears applies. No
 * active row for the country = the checkout asks for a manual quote.
 * Written only through set_shipping_rate / deactivate_shipping_rate
 * (migration 20261008100000_shipping_fees_couriers.sql).
 */

export const SHIPPING_RATES_KEY = ["shipping-rates"] as const;

export interface ShippingRate {
  id: string;
  country: string;
  min_subtotal_jpy: number;
  fee_jpy: number;
  is_active: boolean;
  updated_at: string | null;
}

/**
 * What the card reads. `available: false` = the migration is not applied yet
 * (the RPC does not exist), which the card shows as "Waiting for the database
 * update" rather than an error — the frontend ships before the owner runs SQL.
 */
export type ShippingRatesState =
  | { available: true; can_change: boolean; rates: ShippingRate[] }
  | { available: false };

export const SHIPPING_NOTE =
  "Shipping is charged on the pieces subtotal. The highest threshold the subtotal reaches applies.";

/** PostgREST's "function not in the schema cache" (PGRST202), or Postgres' undefined_function. */
export function isMissingFunction(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  return /could not find the function/i.test(err.message ?? "");
}

export function formatYen(n: number): string {
  return `¥${Math.round(n).toLocaleString("en-US")}`;
}

/** "From ¥8,000 → fee ¥0" */
export function rateLabel(r: Pick<ShippingRate, "min_subtotal_jpy" | "fee_jpy">): string {
  return `From ${formatYen(r.min_subtotal_jpy)} → fee ${formatYen(r.fee_jpy)}`;
}

/** Rates grouped by country (A–Z), each group by threshold ascending. */
export function groupByCountry(rates: ShippingRate[]): Array<{ country: string; rates: ShippingRate[] }> {
  const map = new Map<string, ShippingRate[]>();
  for (const r of rates) {
    const list = map.get(r.country) ?? [];
    list.push(r);
    map.set(r.country, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([country, list]) => ({
      country,
      rates: [...list].sort((a, b) => a.min_subtotal_jpy - b.min_subtotal_jpy),
    }));
}

/**
 * The fee shippingFor() would charge: the active row with the highest
 * threshold the subtotal clears; null = no fee, manual quote.
 */
export function feeFor(rates: ShippingRate[], country: string, subtotalJpy: number): number | null {
  const code = country.trim().toUpperCase();
  let best: ShippingRate | null = null;
  for (const r of rates) {
    if (r.country !== code || !r.is_active || r.min_subtotal_jpy > subtotalJpy) continue;
    if (!best || r.min_subtotal_jpy > best.min_subtotal_jpy) best = r;
  }
  return best ? best.fee_jpy : null;
}

/**
 * Plain words for what deactivating `target` does to the subtotals it covers
 * today (from its threshold up to the next active one).
 */
export function deactivateEffect(rates: ShippingRate[], target: ShippingRate): string {
  const others = rates.filter((r) => r.id !== target.id);
  const nextUp = others
    .filter((r) => r.country === target.country && r.is_active && r.min_subtotal_jpy > target.min_subtotal_jpy)
    .sort((a, b) => a.min_subtotal_jpy - b.min_subtotal_jpy)[0];
  const range = nextUp
    ? `${target.country} subtotals from ${formatYen(target.min_subtotal_jpy)} to ${formatYen(nextUp.min_subtotal_jpy - 1)}`
    : `${target.country} subtotals from ${formatYen(target.min_subtotal_jpy)} up`;
  const after = feeFor(others, target.country, target.min_subtotal_jpy);
  if (after === null) {
    return `${range} will have no shipping fee on the card: the checkout asks for a manual quote.`;
  }
  return `${range} will be charged ${formatYen(after)} (the next lower active threshold).`;
}

/** Validates the add/change form. Returns an error message or null. */
export function validateRateInput(country: string, threshold: string, fee: string): string | null {
  if (!/^[A-Za-z]{2}$/.test(country.trim())) return "Country is a two-letter code, such as JP or PH.";
  if (!/^\d+$/.test(threshold.trim())) return "The threshold is a whole number of yen, 0 or more.";
  if (!/^\d+$/.test(fee.trim())) return "The fee is a whole number of yen, 0 or more.";
  if (Number(threshold) > 100_000_000) return "That threshold is too large.";
  if (Number(fee) > 1_000_000) return "That fee is too large.";
  return null;
}

/** Words for a refusal from set_shipping_rate / deactivate_shipping_rate. */
export function shippingRateRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change shipping fees.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    case "invalid_country": return "Country is a two-letter code, such as JP or PH.";
    case "invalid_threshold": return "The threshold is a whole number of yen, 0 or more.";
    case "invalid_fee": return "The fee is a whole number of yen, 0 or more.";
    case "not_found": return "That rate no longer exists. The card now shows the current list.";
    default: return code || "Could not change the shipping fee.";
  }
}
