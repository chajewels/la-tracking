// Customer emails for PAYMENT EVENTS the customer would otherwise never hear
// about (payment lifecycle, email addendum 2026-10-06, items 1, 6, 7, 10).
//
//   sendPaymentFiledEmail        SHE paid by Paidy or card on the website and
//                                the Hub filed it as a submission (website
//                                callback, Paidy webhook / hourly check, Square
//                                recovery). 「お支払いを受け付けました」.
//                                Key payment-filed-<submission id>: whichever
//                                path files first sends; the rest dedupe.
//   sendCashPaymentRecordEmail   staff voided / restored a recorded payment on
//                                a WEB cash order (void-cash-payment,
//                                restore-cash-payment). Hub orders unchanged.
//   sendCardHoldReleasedEmail    the Hub voided a card hold that never became
//                                a submission (amount mismatch, Paidy already
//                                holding the order, a fraud-rule void whose
//                                cancel did not go through): the existing
//                                order-payment-not-accepted email, kind
//                                provider_ended — neutral, never "fraud".
//   sendProviderCancelledEmail   the fraud rule cancelled a web order
//                                (square_fraud_cancel): the existing
//                                order-cancelled email with the NEUTRAL reason
//                                「お支払いを確認できなかったため」. Same key as a
//                                staff cancel — an order is cancelled once.
//
// Everything shown is read back from the Hub's own records (submission,
// square_payments, cash_orders) — never from a browser or an unsigned
// webhook. Every send goes through sendStorefrontEmail (test gate, Reply-To,
// one email_send_log row per attempt). NONE of these ever throws: an email
// must not fail the filing, void, restore or cancel that triggered it.
import * as React from "npm:react@18.3.1";
import {
  emailLang, sendStorefrontEmail, snapshotCountry, storefrontOrderUrl,
  type SendStorefrontEmailArgs, type SendStorefrontEmailResult,
} from "./storefront-email.ts";
import { regionForCurrency } from "./transfer-methods.ts";
import { OrderUpdateEmail, orderUpdateSubject } from "./email-templates/order-update.tsx";
import { OrderPaymentNotAcceptedEmail, orderPaymentNotAcceptedSubject } from "./email-templates/order-payment-not-accepted.tsx";
import { OrderCancelledEmail, orderCancelledSubject } from "./email-templates/order-cancelled.tsx";
import type { OrderEmailItem } from "./email-templates/order-shared.tsx";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js client, typed by the caller
type Db = any;
type AnyRec = Record<string, unknown>;

/** The sender, injectable so tests can see exactly what would go out. */
export type Send = (args: SendStorefrontEmailArgs) => Promise<SendStorefrontEmailResult>;
export interface EmailDeps { send?: Send }

/** The neutral reason for a provider-side cancel (addendum 10): never names fraud. */
export const NEUTRAL_CANCEL_REASON = {
  ja: "お支払いを確認できなかったため",
  en: "we could not confirm the payment",
} as const;

const ORDER_COLUMNS =
  "id, web_reference, invoice_number, source_channel, customer_lang, ship_to_snapshot, currency, status, remaining_balance, transfer_due_at, shipping_fee, total_amount, customers(email, is_test)";

function warn(label: string, e: unknown) {
  console.warn(`[payment-event-emails] ${label} failed (non-blocking):`, (e as Error)?.message ?? String(e));
}

async function loadOrder(db: Db, orderId: string): Promise<AnyRec | null> {
  const { data, error } = await db.from("cash_orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle();
  if (error || !data) return null;
  return data as AnyRec;
}

function orderBits(order: AnyRec) {
  const customer = (order.customers ?? {}) as AnyRec;
  const currency = (String(order.currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP";
  return {
    reference: String(order.web_reference ?? order.invoice_number ?? ""),
    currency,
    region: regionForCurrency(currency),
    lang: emailLang(order.customer_lang, snapshotCountry(order)),
    to: { email: (customer.email as string | null) ?? null, is_test: customer.is_test === true },
    orderUrl: storefrontOrderUrl(String(order.id)),
  };
}

/** The public name of a submission's method: 'square' is a card. Anything else is not a self-filed payment. */
export function filedMethod(paymentMethod: unknown): "paidy" | "card" | null {
  const m = String(paymentMethod ?? "").toLowerCase();
  if (m === "paidy") return "paidy";
  if (m === "square" || m === "card") return "card";
  return null;
}

/**
 * Addendum 1: 「お支払いを受け付けました」 for a Paidy / card submission the
 * customer filed on the website. The amount is the submission's (the Hub's
 * figure); brand, last 4, held state and hold end come from the stored
 * square_payments row. "Held, not charged yet" is said ONLY while that row is
 * 'authorized' — the state the Hub itself recorded.
 */
export async function sendPaymentFiledEmail(db: Db, submissionId: string, deps: EmailDeps = {}): Promise<void> {
  try {
    const send = deps.send ?? sendStorefrontEmail;
    const { data: sub, error } = await db
      .from("payment_submissions")
      .select("id, status, cash_order_id, payment_method, submitted_amount, square_payment_id, paidy_payment_id")
      .eq("id", submissionId)
      .maybeSingle();
    if (error || !sub?.cash_order_id) return;
    const method = filedMethod(sub.payment_method);
    if (!method) return;
    if (!["submitted", "under_review"].includes(String(sub.status))) return;

    const order = await loadOrder(db, String(sub.cash_order_id));
    if (!order) return;
    const o = orderBits(order);

    let cardBrand: string | null = null;
    let cardLast4: string | null = null;
    let held = false;
    let holdUntil: string | null = null;
    if (method === "card" && sub.square_payment_id) {
      const { data: sq } = await db
        .from("square_payments")
        .select("status, card_brand, card_last4, capture_by")
        .eq("id", String(sub.square_payment_id))
        .maybeSingle();
      if (sq) {
        cardBrand = (sq.card_brand as string | null) ?? null;
        cardLast4 = (sq.card_last4 as string | null) ?? null;
        held = String(sq.status) === "authorized";
        holdUntil = held ? ((sq.capture_by as string | null) ?? null) : null;
      }
    }

    await send({
      to: o.to,
      subject: orderUpdateSubject("payment_filed", o.reference, o.lang),
      label: "order-payment-filed",
      reference: o.reference,
      idempotencyKey: `payment-filed-${sub.id}`,
      element: React.createElement(OrderUpdateEmail, {
        lang: o.lang, variant: "payment_filed", reference: o.reference, currency: o.currency,
        amount: Number(sub.submitted_amount ?? 0), region: o.region, orderUrl: o.orderUrl,
        method, cardBrand, cardLast4, held, holdUntil,
      }),
    });
  } catch (e) {
    warn("payment-filed", e);
  }
}

/**
 * Addendum 6: a recorded payment on a WEB cash order was voided or restored.
 * Amount and the Hub's new remaining balance (read back after the change).
 * The staff void reason is NOT shown: the Void dialog asks staff for an
 * internal note ("Why is this payment being voided?") and never says the
 * customer will see it.
 *
 * `cycleKey` makes each void / restore its own email: the void passes the
 * voided_at it wrote, the restore the voided_at it undid.
 */
export async function sendCashPaymentRecordEmail(
  db: Db,
  args: { cashPaymentId: string; kind: "voided" | "restored"; cycleKey: string },
  deps: EmailDeps = {},
): Promise<void> {
  try {
    const send = deps.send ?? sendStorefrontEmail;
    const { data: pay, error } = await db
      .from("cash_payments")
      .select("id, cash_order_id, amount_paid, reference_number")
      .eq("id", args.cashPaymentId)
      .maybeSingle();
    if (error || !pay?.cash_order_id) return;
    // A points line (LOYALTY-…) is not a payment she made; never emailed as one.
    if (String(pay.reference_number ?? "").startsWith("LOYALTY-")) return;
    const order = await loadOrder(db, String(pay.cash_order_id));
    if (!order || order.source_channel !== "web") return;
    const o = orderBits(order);
    const variant = args.kind === "voided" ? "payment_voided" : "payment_restored";
    await send({
      to: o.to,
      subject: orderUpdateSubject(variant, o.reference, o.lang),
      label: `order-${variant.replace("_", "-")}`,
      reference: o.reference,
      idempotencyKey: `${variant.replace("_", "-")}-${pay.id}-${args.cycleKey}`,
      element: React.createElement(OrderUpdateEmail, {
        lang: o.lang, variant, reference: o.reference, currency: o.currency,
        amount: Number(pay.amount_paid ?? 0), region: o.region, orderUrl: o.orderUrl,
        balance: Number(order.remaining_balance ?? 0),
      }),
    });
  } catch (e) {
    warn(`payment-${args.kind}`, e);
  }
}

/**
 * Addendum 10: the Hub voided a card hold that has NO submission (it was never
 * filed: amount mismatch, Paidy already holding the order, or a fraud-rule
 * void whose cancel stood down). Sent only once the stored row says 'voided'
 * — so "nothing was charged" is the Hub's own record. A hold that HAS a
 * submission is left to sendCashPaymentRejectedEmail (one email per event).
 * Key: card-hold-released-<square_payments.id>.
 */
export async function sendCardHoldReleasedEmail(db: Db, squarePaymentId: string, deps: EmailDeps = {}): Promise<void> {
  try {
    const send = deps.send ?? sendStorefrontEmail;
    const { data: sq, error } = await db
      .from("square_payments")
      .select("id, cash_order_id, status, amount_jpy")
      .eq("square_payment_id", squarePaymentId)
      .maybeSingle();
    if (error || !sq?.cash_order_id || String(sq.status) !== "voided") return;
    const { data: subs, error: subErr } = await db
      .from("payment_submissions").select("id").eq("square_payment_id", String(sq.id)).limit(1);
    if (subErr || (subs ?? []).length > 0) return;
    const order = await loadOrder(db, String(sq.cash_order_id));
    if (!order) return;
    const o = orderBits(order);
    const open = String(order.status) === "pending";
    const remaining = open ? Number(order.remaining_balance ?? 0) : 0;
    await send({
      to: o.to,
      subject: orderPaymentNotAcceptedSubject(o.reference, o.lang),
      label: "order-payment-not-accepted",
      reference: o.reference,
      idempotencyKey: `card-hold-released-${sq.id}`,
      element: React.createElement(OrderPaymentNotAcceptedEmail, {
        lang: o.lang, reference: o.reference, method: "card", kind: "provider_ended",
        amount: Number(sq.amount_jpy ?? 0), currency: o.currency, reason: null,
        remaining: remaining > 0 ? remaining : null,
        transferDueAt: (order.transfer_due_at as string | null) ?? null,
        region: o.region, orderUrl: o.orderUrl,
      }),
    });
  } catch (e) {
    warn("card-hold-released", e);
  }
}

/**
 * Addendum 10: square_fraud_cancel cancelled a WEB order. The existing
 * order-cancelled email, reason 「お支払いを確認できなかったため」 /
 * "we could not confirm the payment" — the internal reason ("suspected
 * fraud") is never shown. No refund line: square_fraud_cancel refuses when
 * any money was received. Key order-cancelled-<order id> (cancel-cash-order's
 * key): one cancellation email per order, whoever cancels.
 */
export async function sendProviderCancelledEmail(db: Db, orderId: string, deps: EmailDeps = {}): Promise<void> {
  try {
    const send = deps.send ?? sendStorefrontEmail;
    const order = await loadOrder(db, orderId);
    if (!order || order.source_channel !== "web" || String(order.status) !== "cancelled") return;
    const o = orderBits(order);
    const items = await orderItems(db, orderId);
    await send({
      to: o.to,
      subject: orderCancelledSubject(o.reference, o.lang),
      label: "order-cancelled",
      reference: o.reference,
      idempotencyKey: `order-cancelled-${orderId}`,
      element: React.createElement(OrderCancelledEmail, {
        lang: o.lang, reference: o.reference, items,
        shippingJpy: Number(order.shipping_fee ?? 0), totalJpy: Number(order.total_amount ?? 0),
        currency: o.currency,
        reason: NEUTRAL_CANCEL_REASON[o.lang],
        reasonByLang: { ...NEUTRAL_CANCEL_REASON },
        refundStatus: null, refundNote: null, orderUrl: o.orderUrl,
      }),
    });
  } catch (e) {
    warn("provider-cancelled", e);
  }
}

/** The order's lines with Japanese titles (same rule as cancel-cash-order and the ready email). */
async function orderItems(db: Db, orderId: string): Promise<OrderEmailItem[]> {
  const { data: lines } = await db
    .from("cash_order_items")
    .select("website_product_id, title, quantity, line_total_jpy")
    .eq("cash_order_id", orderId)
    .order("created_at");
  const ids = [...new Set(((lines ?? []) as AnyRec[]).map((l) => l.website_product_id).filter(Boolean))];
  const { data: prods } = ids.length
    ? await db.from("website_products").select("id, name, name_ja").in("id", ids)
    : { data: [] as AnyRec[] };
  const byId = new Map<string, AnyRec>(((prods ?? []) as AnyRec[]).map((p) => [String(p.id), p]));
  return ((lines ?? []) as AnyRec[]).map((l) => {
    const pr = l.website_product_id ? byId.get(String(l.website_product_id)) : undefined;
    const title = String(l.title ?? "");
    const name = pr?.name ? String(pr.name) : "";
    const title_ja = name && pr?.name_ja && title.startsWith(name) ? String(pr.name_ja) + title.slice(name.length) : null;
    return { title, title_ja, qty: Number(l.quantity ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) };
  });
}

/**
 * Addendum 7: how many points the order's checkout points were — the sum of
 * points_redeemed on the redemptions behind its live LOYALTY-<id> lines. 0
 * when none, or when anything cannot be read (the line then shows without a
 * count; the value beside it is cash_order_points_paid, unchanged).
 */
export async function checkoutPointsCount(db: Db, orderId: string): Promise<number> {
  try {
    const { data: lines, error } = await db
      .from("cash_payments")
      .select("reference_number")
      .eq("cash_order_id", orderId)
      .is("voided_at", null)
      .like("reference_number", "LOYALTY-%");
    if (error) return 0;
    const ids = ((lines ?? []) as AnyRec[])
      .map((l) => String(l.reference_number ?? "").slice("LOYALTY-".length))
      .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return 0;
    const { data: reds, error: rErr } = await db.from("loyalty_redemptions").select("points_redeemed").in("id", ids);
    if (rErr) return 0;
    const n = ((reds ?? []) as AnyRec[]).reduce((s, r) => s + Number(r.points_redeemed ?? 0), 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}
