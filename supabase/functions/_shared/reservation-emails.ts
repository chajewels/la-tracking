import * as React from "npm:react@18.3.1";
import {
  pickLang, sendStorefrontEmail, storefrontLayawayUrl, storefrontOrderUrl,
  type SendStorefrontEmailResult,
} from "./storefront-email.ts";
import { regionForCurrency, transferMethods } from "./transfer-methods.ts";
import type { OrderEmailItem, OrderEmailMethod } from "./email-templates/order-shared.tsx";
import type { LayawayScheduleRow } from "./email-templates/layaway-shared.tsx";
import { OrderReservedEmail, orderReservedSubject } from "./email-templates/order-reserved.tsx";
import { LayawayReservedEmail, layawayReservedSubject } from "./email-templates/layaway-reserved.tsx";
import { OrderConfirmationEmail, orderReadySubject } from "./email-templates/order-confirmation.tsx";
import { LayawayPlanCreatedEmail, layawayReadySubject } from "./email-templates/layaway-plan-created.tsx";
import { OrderCancelledEmail, orderCancelledSubject } from "./email-templates/order-cancelled.tsx";
import { LayawayDeclinedEmail, layawayDeclinedSubject } from "./email-templates/layaway-declined.tsx";
import { OrderReservationLapsedEmail, orderReservationLapsedSubject } from "./email-templates/order-reservation-lapsed.tsx";

/**
 * RESERVE-FIRST (A2): every customer email about a web reservation, built from
 * the database by order or plan id, so the website, confirm-web-order-ready,
 * decline-web-reservation and web-reservation-sweep cannot disagree about what
 * one says.
 *
 * All sends go through sendStorefrontEmail: Cha Jewels brand, Reply-To sales@,
 * the test gate, and one email_send_log row per attempt — sent, failed or
 * skipped (CLAUDE.md EMAIL DELIVERY MONITORING). Every function here RETURNS
 * the outcome and NEVER throws: an email must never fail the confirmation,
 * decline or cancel that triggered it.
 *
 * Language: order (cash) emails go out in the customer's storefront language,
 * Japanese first then English. LAYAWAY emails are English only (owner
 * decision 2026-09-23), whatever the storefront was in.
 */

// deno-lint-ignore no-explicit-any
type Db = any;
type AnyRec = Record<string, unknown>;

export type ReservationEmailResult = SendStorefrontEmailResult | { sent: false; reason: "not_found" | "error"; detail?: string };

const shopUrl = () => (Deno.env.get("WEBSITE_URL") ?? "").replace(/\/$/, "") || null;

/** The order row, its lines (with Japanese titles), and its customer. */
async function loadOrder(supabase: Db, orderId: string) {
  const { data: order } = await supabase
    .from("cash_orders")
    .select("id, web_reference, invoice_number, customer_lang, shipping_fee, total_amount, currency, transfer_due_at, customers(email, is_test)")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return null;
  const { data: lines } = await supabase
    .from("cash_order_items")
    .select("website_product_id, title, quantity, line_total_jpy")
    .eq("cash_order_id", orderId)
    .order("created_at");
  const ids = [...new Set(((lines ?? []) as AnyRec[]).map((l) => l.website_product_id).filter(Boolean))];
  const { data: prods } = ids.length
    ? await supabase.from("website_products").select("id, name, name_ja").in("id", ids)
    : { data: [] as AnyRec[] };
  const byId = new Map<string, AnyRec>(((prods ?? []) as AnyRec[]).map((p) => [String(p.id), p]));
  // Same rule as the website's withJapaneseTitles: the stored title is the
  // English name at order time, so the Japanese one is swapped in only when
  // the line still starts with that English name.
  const items: OrderEmailItem[] = ((lines ?? []) as AnyRec[]).map((l) => {
    const pr = l.website_product_id ? byId.get(String(l.website_product_id)) : undefined;
    const title = String(l.title ?? "");
    const name = pr?.name ? String(pr.name) : "";
    const title_ja = name && pr?.name_ja && title.startsWith(name) ? String(pr.name_ja) + title.slice(name.length) : null;
    return { title, title_ja, qty: Number(l.quantity ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) };
  });
  const customer = (order as AnyRec).customers as AnyRec | null;
  return {
    order: order as AnyRec,
    items,
    reference: String((order as AnyRec).web_reference ?? (order as AnyRec).invoice_number ?? ""),
    lang: pickLang((order as AnyRec).customer_lang),
    to: { email: (customer?.email as string | null) ?? null, is_test: customer?.is_test === true },
  };
}

async function loadPlan(supabase: Db, accountId: string) {
  const { data: plan } = await supabase
    .from("layaway_accounts")
    .select("id, web_reference, invoice_number, currency, total_amount, downpayment_amount, payment_plan_months, transfer_due_at, customers(email, is_test)")
    .eq("id", accountId)
    .maybeSingle();
  if (!plan) return null;
  const customer = (plan as AnyRec).customers as AnyRec | null;
  return {
    plan: plan as AnyRec,
    reference: String((plan as AnyRec).web_reference ?? (plan as AnyRec).invoice_number ?? ""),
    currency: (String((plan as AnyRec).currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP",
    to: { email: (customer?.email as string | null) ?? null, is_test: customer?.is_test === true },
  };
}

async function guarded(label: string, fn: () => Promise<ReservationEmailResult>): Promise<ReservationEmailResult> {
  try {
    return await fn();
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    console.error(`[reservation-emails] ${label} failed (non-blocking):`, detail);
    return { sent: false, reason: "error", detail };
  }
}

/** Checkout, reserve mode: "we have your order" — no bank details, no deadline. */
export function sendOrderReservedEmail(supabase: Db, orderId: string): Promise<ReservationEmailResult> {
  return guarded("order-reserved", async () => {
    const o = await loadOrder(supabase, orderId);
    if (!o) return { sent: false, reason: "not_found" };
    return await sendStorefrontEmail({
      to: o.to,
      subject: orderReservedSubject(o.reference),
      label: "order-reserved",
      reference: o.reference,
      idempotencyKey: `order-reserved-${orderId}`,
      element: React.createElement(OrderReservedEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        orderUrl: storefrontOrderUrl(orderId),
      }),
    });
  });
}

/** Checkout, reserve mode: the layaway request is in. English only. */
export function sendLayawayReservedEmail(supabase: Db, accountId: string): Promise<ReservationEmailResult> {
  return guarded("layaway-reserved", async () => {
    const p = await loadPlan(supabase, accountId);
    if (!p) return { sent: false, reason: "not_found" };
    return await sendStorefrontEmail({
      to: p.to,
      subject: layawayReservedSubject(p.reference),
      label: "layaway-reserved",
      reference: p.reference,
      idempotencyKey: `layaway-reserved-${accountId}`,
      element: React.createElement(LayawayReservedEmail, {
        reference: p.reference,
        currency: p.currency,
        totalAmount: Number(p.plan.total_amount ?? 0),
        deposit: Number(p.plan.downpayment_amount ?? 0),
        termMonths: Number(p.plan.payment_plan_months ?? 0),
        planUrl: storefrontLayawayUrl(accountId),
      }),
    });
  });
}

/**
 * Staff confirmed a cash reservation: today's order-confirmation content —
 * items, every transfer method, the deadline that has just started — headed
 * "your piece is confirmed". The deadline is read back from the row the
 * confirmation just wrote, never recomputed.
 */
export function sendOrderReadyEmail(supabase: Db, orderId: string): Promise<ReservationEmailResult> {
  return guarded("order-ready", async () => {
    const o = await loadOrder(supabase, orderId);
    if (!o) return { sent: false, reason: "not_found" };
    const currency = String(o.order.currency ?? "JPY");
    const methods = await transferMethods(supabase, currency);
    return await sendStorefrontEmail({
      to: o.to,
      subject: orderReadySubject(o.reference),
      label: "order-ready",
      reference: o.reference,
      idempotencyKey: `order-ready-${orderId}`,
      element: React.createElement(OrderConfirmationEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        methods: methods as unknown as OrderEmailMethod[],
        transferDueAt: String(o.order.transfer_due_at ?? ""),
        region: regionForCurrency(currency),
        orderUrl: storefrontOrderUrl(orderId),
        variant: "ready",
      }),
    });
  });
}

/**
 * Staff confirmed a layaway reservation: today's layaway-plan-created content —
 * deposit, where to send it, the new deadline, and the schedule as the
 * confirmation re-dated it. English only.
 */
export function sendLayawayReadyEmail(
  supabase: Db,
  accountId: string,
  schedule?: LayawayScheduleRow[] | null,
): Promise<ReservationEmailResult> {
  return guarded("layaway-ready", async () => {
    const p = await loadPlan(supabase, accountId);
    if (!p) return { sent: false, reason: "not_found" };
    let rows = schedule ?? null;
    if (!rows || rows.length === 0) {
      const { data } = await supabase
        .from("layaway_schedule")
        .select("installment_number, due_date, base_installment_amount")
        .eq("account_id", accountId)
        .neq("status", "cancelled")
        .order("installment_number");
      rows = ((data ?? []) as AnyRec[]).map((r) => ({
        installment_number: Number(r.installment_number),
        due_date: String(r.due_date),
        amount: Number(r.base_installment_amount ?? 0),
      }));
    }
    const methods = await transferMethods(supabase, p.currency);
    return await sendStorefrontEmail({
      to: p.to,
      subject: layawayReadySubject(p.reference),
      label: "layaway-ready",
      reference: p.reference,
      idempotencyKey: `layaway-ready-${accountId}`,
      element: React.createElement(LayawayPlanCreatedEmail, {
        lang: "en",
        reference: p.reference,
        currency: p.currency,
        totalAmount: Number(p.plan.total_amount ?? 0),
        deposit: Number(p.plan.downpayment_amount ?? 0),
        termMonths: Number(p.plan.payment_plan_months ?? 0),
        schedule: rows,
        methods: methods as unknown as OrderEmailMethod[],
        transferDueAt: String(p.plan.transfer_due_at ?? ""),
        region: regionForCurrency(p.currency),
        planUrl: storefrontLayawayUrl(accountId),
        variant: "ready",
      }),
    });
  });
}

/**
 * "Can't supply" on a cash reservation: the existing order-cancelled email,
 * with the staff reason. Nothing was paid, so there is no refund line. Same
 * idempotency key cancel-cash-order uses — an order is cancelled once.
 */
export function sendOrderCantSupplyEmail(supabase: Db, orderId: string, reason: string): Promise<ReservationEmailResult> {
  return guarded("order-cancelled", async () => {
    const o = await loadOrder(supabase, orderId);
    if (!o) return { sent: false, reason: "not_found" };
    return await sendStorefrontEmail({
      to: o.to,
      subject: orderCancelledSubject(o.reference),
      label: "order-cancelled",
      reference: o.reference,
      idempotencyKey: `order-cancelled-${orderId}`,
      element: React.createElement(OrderCancelledEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        reason,
        refundStatus: null,
        refundNote: null,
        orderUrl: storefrontOrderUrl(orderId),
      }),
    });
  });
}

/** A layaway reservation ended unconfirmed: staff declined it, or 72 hours passed. English only. */
export function sendLayawayDeclinedEmail(
  supabase: Db,
  accountId: string,
  kind: "declined" | "lapsed",
  reason?: string | null,
): Promise<ReservationEmailResult> {
  const label = kind === "lapsed" ? "layaway-reservation-lapsed" : "layaway-declined";
  return guarded(label, async () => {
    const p = await loadPlan(supabase, accountId);
    if (!p) return { sent: false, reason: "not_found" };
    return await sendStorefrontEmail({
      to: p.to,
      subject: layawayDeclinedSubject(p.reference, kind),
      label,
      reference: p.reference,
      idempotencyKey: `${label}-${accountId}`,
      element: React.createElement(LayawayDeclinedEmail, {
        reference: p.reference,
        kind,
        reason: reason ?? null,
        shopUrl: shopUrl(),
      }),
    });
  });
}

/** A cash reservation nobody confirmed within 72 hours was cancelled. */
export function sendOrderReservationLapsedEmail(supabase: Db, orderId: string): Promise<ReservationEmailResult> {
  return guarded("order-reservation-lapsed", async () => {
    const o = await loadOrder(supabase, orderId);
    if (!o) return { sent: false, reason: "not_found" };
    return await sendStorefrontEmail({
      to: o.to,
      subject: orderReservationLapsedSubject(o.reference),
      label: "order-reservation-lapsed",
      reference: o.reference,
      idempotencyKey: `order-reservation-lapsed-${orderId}`,
      element: React.createElement(OrderReservationLapsedEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        shopUrl: shopUrl(),
      }),
    });
  });
}
