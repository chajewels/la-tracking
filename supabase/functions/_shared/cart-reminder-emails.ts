import * as React from "npm:react@18.3.1";
import { sendStorefrontEmail, STOREFRONT_PUBLIC_URL, type SendStorefrontEmailResult } from "./storefront-email.ts";
import { attachDownPayments, planLayawayQuote, variantPricePhp, type FxRate } from "./website-down-payments.ts";
import { CartReminderEmail, cartReminderSubject, type CartReminderItem } from "./email-templates/cart-reminder.tsx";
import {
  CART_REMINDER_LABEL, cartReminderIdempotencyKey, planFiguresFromQuote, quoteTerm, reminderForm,
  type CandidateQuote, type PlanFigures, type QuoteCurrency, type ReminderForm,
} from "./cart-reminder-rules.ts";

/**
 * Cart reminders (stages A/B): render and send ONE claimed reminder
 * (docs/CART-REMINDERS.md). The claim row (cart_reminder_sends) holds the
 * address, language and the available lines the SQL saw under the consent
 * lock; the stage-B quote choice comes with the candidate.
 *
 * EVERY MONEY FIGURE IS THE HUB'S, computed here at send time from Hub code —
 * never copied from the stored quote (prices, stock and the rate may have
 * moved) and never converted or percentaged in this file:
 *   price_php       variantPricePhp (the catalogue's exact half-up)
 *   reserve line    attachDownPayments → website_down_payments → layaway_quote
 *   stage-B plan    planLayawayQuote → layaway_quote, the /layaway/quote path
 * A figure the Hub cannot produce is omitted; a refused plan falls back to
 * the stage-A English form (never an invented plan).
 *
 * Sends through sendStorefrontEmail: Cha Jewels brand, Reply-To sales@, the
 * test gate, idempotency key cart-reminder-<cycle_id>, one email_send_log row
 * for every outcome. Never throws.
 */

// deno-lint-ignore no-explicit-any
type Db = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, unknown>;

export type CartReminderEmailResult =
  | SendStorefrontEmailResult
  | { sent: false; reason: "not_found" | "no_items" | "error"; detail?: string };

export interface CartReminderSendContext {
  /** system_settings.web_reservation_mode — adds the "we reserve and confirm" sentence. */
  reserveFirst: boolean;
  /** The day's JPY→PHP rate, read once per sweep; null = yen only. */
  fx: FxRate | null;
}

/** The storefront page the button opens: restores the saved cart, then /cart. */
export const cartRestoreUrl = () => `${STOREFRONT_PUBLIC_URL}/cart/restore`;

/** The in-body opt-out link; the storefront page calls GET /cart-reminders/unsubscribe. */
export const cartUnsubscribeUrl = (token: string) =>
  `${STOREFRONT_PUBLIC_URL}/cart-reminders/unsubscribe?token=${encodeURIComponent(token)}`;

/** The claim row's items, as cart_reminder_candidates built them. */
function readItems(raw: unknown): CartReminderItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CartReminderItem[] = [];
  for (const r of raw as AnyRec[]) {
    const price = Number(r.price_jpy);
    const qty = Number(r.qty);
    if (!Number.isSafeInteger(price) || price < 0 || !Number.isInteger(qty) || qty < 1) continue;
    out.push({
      name: String(r.name ?? ""),
      name_ja: r.name_ja ? String(r.name_ja) : null,
      size: r.size ? String(r.size) : null,
      stone: r.stone ? String(r.stone) : null,
      qty,
      image_url: r.image_url ? String(r.image_url) : null,
      price_jpy: price,
    });
  }
  return out;
}

/**
 * Stage B layaway: the Hub's plan for the sum of the available pieces, or null
 * when it refuses (below_plan_minimum after a piece sold, fx_unavailable, a
 * term not launched, term_downgraded) — the caller then uses the stage-A form.
 */
async function layawayPlan(
  supabase: Db,
  items: CartReminderItem[],
  term: number,
  currency: QuoteCurrency,
  fx: FxRate | null,
): Promise<PlanFigures | null> {
  const sum = items.reduce((n, i) => n + i.price_jpy * i.qty, 0);
  if (sum <= 0) return null;
  const plan = await planLayawayQuote({ price_jpy: sum, term_months: term, currency }, () => Promise.resolve(fx));
  if ("error" in plan) return null;
  const { data, error } = await supabase.rpc("layaway_quote", plan.args);
  if (error) {
    console.error("[cart-reminder-emails] layaway_quote failed; stage-A form used:", error.message ?? error);
    return null;
  }
  return planFiguresFromQuote((data ?? null) as AnyRec | null, currency);
}

export async function sendClaimedCartReminder(
  supabase: Db,
  claimId: string,
  quote: CandidateQuote | null,
  ctx: CartReminderSendContext,
): Promise<CartReminderEmailResult> {
  try {
    const { data: row, error } = await supabase
      .from("cart_reminder_sends")
      .select("customer_id, cycle_id, email, lang, items")
      .eq("id", claimId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return { sent: false, reason: "not_found" };
    const r = row as AnyRec;
    const lang = String(r.lang) === "en" ? "en" : "ja";
    const items = readItems(r.items);
    if (items.length === 0) return { sent: false, reason: "no_items" };

    // The customer row: the code is the logged reference, is_test feeds the
    // test gate (the SQL already applied it; sendStorefrontEmail applies it
    // again) and the consent row carries the opt-out token.
    const [{ data: customer, error: custErr }, { data: consent, error: consErr }] = await Promise.all([
      supabase.from("customers").select("customer_code, is_test").eq("id", r.customer_id).maybeSingle(),
      supabase.from("customer_email_consents").select("unsubscribe_token")
        .eq("customer_id", r.customer_id).eq("kind", "cart_reminder").maybeSingle(),
    ]);
    if (custErr) throw custErr;
    if (consErr) throw consErr;
    const token = String((consent as AnyRec | null)?.unsubscribe_token ?? "");
    if (!token) return { sent: false, reason: "error", detail: "no_consent_row" };

    // Money, from the Hub, for THIS send.
    let form: ReminderForm = reminderForm(lang, quote);
    for (const i of items) i.price_php = variantPricePhp(i.price_jpy, ctx.fx);
    let plan: PlanFigures | null = null;
    if (form === "layaway") {
      const currency: QuoteCurrency = quote?.quote_currency === "PHP" ? "PHP" : "JPY";
      plan = await layawayPlan(supabase, items, quoteTerm(quote), currency, ctx.fx);
      if (!plan) form = "stage_a";
    }
    if (form === "stage_a" && lang === "en") {
      // attachDownPayments walks product.product_variants; the items carry
      // price_jpy, which is all it reads, and it adds down_payment_* in place.
      await attachDownPayments(supabase, [{ product_variants: items as unknown as AnyRec[] }], ctx.fx);
    }

    return await sendStorefrontEmail({
      to: { email: String(r.email ?? ""), is_test: (customer as AnyRec | null)?.is_test === true },
      label: CART_REMINDER_LABEL,
      reference: String((customer as AnyRec | null)?.customer_code ?? r.customer_id ?? ""),
      idempotencyKey: cartReminderIdempotencyKey(String(r.cycle_id)),
      subject: cartReminderSubject(lang),
      element: React.createElement(CartReminderEmail, {
        lang,
        form,
        items,
        plan,
        reserveFirst: ctx.reserveFirst,
        reachedCheckout: quote?.quote_mode === "full" || quote?.quote_mode === "layaway",
        cartUrl: cartRestoreUrl(),
        unsubscribeUrl: cartUnsubscribeUrl(token),
      }),
    });
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    console.error("[cart-reminder-emails] send failed (non-blocking):", detail);
    return { sent: false, reason: "error", detail };
  }
}
