/**
 * Down payments and layaway quotes for the storefront (H-DP, 2026-09-25).
 *
 * Owner rules: every money figure a customer sees comes from the Hub; the
 * storefront never computes or converts. The 30% down payment is half-up to a
 * whole unit in yen and in pesos, by ONE formula, identical to checkout:
 *   price_php        = HU(price_jpy × rate)                      (jpyToPhpHalfUp)
 *   down_payment_jpy = layaway_quote(price_jpy, term, 'JPY').deposit
 *   down_payment_php = layaway_quote(price_php, term, 'PHP').deposit
 * The deposits are produced in SQL by public.website_down_payments, which calls
 * layaway_quote itself — the function create_web_layaway_atomic calls — so no
 * copy of the deposit rule lives here. Figures are for the piece alone (owner
 * decision D1); with ₱0 shipping they equal what a peso plan stores, to the peso.
 *
 * Kept free of Deno APIs so src/test/hub-down-payments.test.ts can import it.
 * Imported by the `website` edge function only.
 */
import { jpyToPhpHalfUp } from "./settlement.ts";

type Rec = Record<string, unknown>;

/** Latest JPY->PHP rate (fx_rates.jpy_php, PHP per 1 JPY). */
export interface FxRate { jpy_php: number; as_of: string }

/** The one supabase-js call this module makes. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

const wholeYen = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * A variant's peso price: exact half-up, the conversion a peso checkout stores
 * (create_web_order_atomic / create_web_layaway_atomic: round(jpy * rate)).
 * null with no rate, or when price_jpy is not a whole non-negative yen amount.
 */
export function variantPricePhp(priceJpy: unknown, fx: FxRate | null): number | null {
  const jpy = wholeYen(priceJpy);
  return fx && jpy !== null ? jpyToPhpHalfUp(jpy, fx.jpy_php) : null;
}

/**
 * Adds down_payment_jpy / down_payment_php / down_payment_pct to every variant
 * of every product, from ONE website_down_payments call for the whole request
 * (distinct prices; no per-product calls). A figure the Hub did not produce is
 * OMITTED — never null-filled, never computed here. If the call fails the
 * catalog still renders, just without the fields: a failed deposit lookup must
 * never take a collection page down.
 */
export async function attachDownPayments(
  supabase: RpcClient,
  products: Array<Rec | null>,
  fx: FxRate | null,
): Promise<void> {
  const variants: Rec[] = [];
  for (const p of products) {
    for (const v of ((p?.product_variants as Rec[] | undefined) ?? [])) variants.push(v);
  }
  const prices = [...new Set(variants.map((v) => wholeYen(v.price_jpy)).filter((n): n is number => n !== null))];
  if (prices.length === 0) return;

  let rows: Rec[];
  try {
    const { data, error } = await supabase.rpc("website_down_payments", {
      p_prices_jpy: prices,
      p_rate: fx ? fx.jpy_php : null,
    });
    if (error) throw error;
    rows = Array.isArray(data) ? (data as Rec[]) : [];
  } catch (e) {
    console.error("[website] website_down_payments failed; down-payment fields omitted", e);
    return;
  }

  const byPrice = new Map<number, Rec>();
  for (const r of rows) byPrice.set(Number(r.price_jpy), r);
  const num = (v: unknown): number | null =>
    v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  for (const v of variants) {
    const jpy = wholeYen(v.price_jpy);
    const r = jpy === null ? undefined : byPrice.get(jpy);
    if (!r) continue;
    const dpJpy = num(r.down_payment_jpy);
    const dpPhp = num(r.down_payment_php);
    const pct = num(r.down_payment_pct);
    if (dpJpy !== null) v.down_payment_jpy = dpJpy;
    if (dpPhp !== null) v.down_payment_php = dpPhp;
    if (pct !== null) v.down_payment_pct = pct;
  }
}

export type LayawayQuotePlan =
  | { status: number; error: string }
  | { args: { p_price: number; p_term_months: number; p_currency: string }; extra: Rec | null };

/**
 * POST /layaway/quote → the layaway_quote arguments, or a refusal.
 *
 * Two request shapes:
 *   - { price_jpy, term_months, currency } (H-DP): the price is YEN whatever
 *     the currency. "PHP" converts it here with the exact half-up and quotes in
 *     pesos (peso term minimums = min_amount_php); no usable rate → 503
 *     fx_unavailable. The answer gains price_jpy, fx_rate, fx_as_of.
 *   - { price, term_months, currency } (legacy): price is read in `currency`,
 *     exactly as before — the live storefront keeps working through the rollout.
 * price_jpy wins when both are sent.
 */
export async function planLayawayQuote(
  body: Rec | null | undefined,
  loadFx: () => Promise<FxRate | null>,
): Promise<LayawayQuotePlan> {
  const term = Number(body?.term_months);
  const currency = String(body?.currency ?? "JPY").toUpperCase();
  const p_term_months = Number.isFinite(term) ? Math.round(term) : 3;

  if (body?.price_jpy !== undefined && body?.price_jpy !== null) {
    const jpy = wholeYen(body.price_jpy);
    if (jpy === null) return { status: 400, error: "invalid_price" };
    if (currency === "JPY") {
      return { args: { p_price: jpy, p_term_months, p_currency: "JPY" }, extra: { price_jpy: jpy, fx_rate: null, fx_as_of: null } };
    }
    if (currency !== "PHP") return { status: 400, error: "invalid_currency" };
    const fx = await loadFx();
    if (!fx) return { status: 503, error: "fx_unavailable" };
    return {
      args: { p_price: jpyToPhpHalfUp(jpy, fx.jpy_php), p_term_months, p_currency: "PHP" },
      extra: { price_jpy: jpy, fx_rate: fx.jpy_php, fx_as_of: fx.as_of },
    };
  }

  // Legacy shape — unchanged.
  const price = Number(body?.price);
  if (!Number.isFinite(price) || price < 0) return { status: 400, error: "invalid_price" };
  if (!["JPY", "PHP"].includes(currency)) return { status: 400, error: "invalid_currency" };
  return { args: { p_price: Math.round(price), p_term_months, p_currency: currency }, extra: null };
}
