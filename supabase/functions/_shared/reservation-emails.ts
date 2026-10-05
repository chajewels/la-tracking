import * as React from "npm:react@18.3.1";
import { paidyModeFrom, paidyNotOfferedReason } from "./paidy-rules.ts";
import { publicMethod } from "./checkout-choice.ts";
import {
  emailLang, sendStorefrontEmail, snapshotCountry, storefrontLayawayUrl, storefrontOrderUrl, storefrontShopUrl,
  STOREFRONT_PUBLIC_URL, type SendStorefrontEmailResult,
} from "./storefront-email.ts";
import { regionForCurrency, transferMethods } from "./transfer-methods.ts";
import type { OrderEmailItem, OrderEmailMethod } from "./email-templates/order-shared.tsx";
import type { LayawayScheduleRow } from "./email-templates/layaway-shared.tsx";
import { OrderReservedEmail, orderReservedSubject } from "./email-templates/order-reserved.tsx";
import { LayawayReservedEmail, layawayReservedSubject } from "./email-templates/layaway-reserved.tsx";
import { OrderConfirmationEmail, orderMethodChangedSubject, orderReadySubject } from "./email-templates/order-confirmation.tsx";
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


/** The order row, its lines (with Japanese titles), and its customer. */
async function loadOrder(supabase: Db, orderId: string) {
  const { data: order } = await supabase
    .from("cash_orders")
    .select("id, web_reference, invoice_number, customer_lang, shipping_fee, total_amount, currency, transfer_due_at, planned_shipping_method_id, status, payment_status, payment_method, remaining_balance, source_channel, ready_confirmed_at, ship_to_snapshot, customers(email, is_test)")
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
    // shipping_fee and total_amount are in this currency (pesos on a peso order).
    currency: (String((order as AnyRec).currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP",
    lang: emailLang((order as AnyRec).customer_lang, snapshotCountry(order as AnyRec)),
    to: { email: (customer?.email as string | null) ?? null, is_test: customer?.is_test === true },
  };
}

async function loadPlan(supabase: Db, accountId: string) {
  const { data: plan } = await supabase
    .from("layaway_accounts")
    .select("id, web_reference, invoice_number, currency, total_amount, downpayment_amount, payment_plan_months, transfer_due_at, planned_shipping_method_id, customers(email, is_test)")
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

/**
 * Website orders PR 6: the courier staff chose on the review screen, by name.
 * null when none was chosen (every order made before PR 4) — no line then.
 */
async function courierName(supabase: Db, methodId: unknown): Promise<string | null> {
  if (!methodId) return null;
  const { data } = await supabase
    .from("shipping_methods").select("provider_name, title").eq("id", String(methodId)).maybeSingle();
  const row = (data ?? null) as AnyRec | null;
  return row ? String(row.provider_name ?? row.title ?? "") || null : null;
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
      subject: orderReservedSubject(o.reference, o.lang),
      label: "order-reserved",
      reference: o.reference,
      idempotencyKey: `order-reserved-${orderId}`,
      element: React.createElement(OrderReservedEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        currency: o.currency,
        orderUrl: storefrontOrderUrl(orderId),
        method: o.order.source_channel === "web" ? publicMethod(o.order.payment_method) : "transfer",
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
 *
 * REVIVAL (OPEN-BUGS "No customer email on revival", fixed 2026-10-02): when
 * staff revive an expired web order (revive-web-cash-order) the customer's
 * last email said the order was cancelled, so the same content is sent again
 * with the NEW deadline — `revived: true`. The idempotency key then carries
 * the new deadline: the confirmation's own key (`order-ready-<id>`) was spent
 * at confirm time and would silently drop the revival email.
 */
export type ReadyEmailOpts = {
  revived?: boolean;
  /**
   * Staff changed how the order is paid (change-payment-method, owner C1
   * 2026-10-05): the same content again, showing ONLY the new method, under a
   * key of its own (the confirm key was spent).
   */
  methodChanged?: boolean;
};

export function sendOrderReadyEmail(supabase: Db, orderId: string, opts: ReadyEmailOpts = {}): Promise<ReservationEmailResult> {
  const label = opts.methodChanged ? "order-method-changed" : opts.revived ? "order-revived" : "order-ready";
  return guarded(label, async () => {
    const o = await loadOrder(supabase, orderId);
    if (!o) return { sent: false, reason: "not_found" };
    const currency = String(o.order.currency ?? "JPY");
    // C1 (2026-10-05): a website order's email shows ONLY the method the
    // customer chose; bank details only for transfer.
    const chosen = o.order.source_channel === "web" ? publicMethod(o.order.payment_method) : "transfer";
    const methods = chosen === "transfer" ? await transferMethods(supabase, currency) : [];
    const { data: ptsPaid } = await supabase.rpc("cash_order_points_paid", { p_cash_order_id: orderId });
    // Payment lifecycle H3: a method change names the OLD method too, read
    // from the newest payment_method_changed audit row (staff or customer
    // switch). Unreadable → the heading still says it changed, no old → new line.
    const changedFrom = opts.methodChanged ? await previousMethod(supabase, orderId) : null;
    return await sendStorefrontEmail({
      to: o.to,
      subject: opts.methodChanged ? orderMethodChangedSubject(o.reference, o.lang) : orderReadySubject(o.reference, o.lang),
      label,
      reference: o.reference,
      idempotencyKey: opts.methodChanged
        ? `order-method-changed-${orderId}-${String(o.order.payment_method ?? "transfer")}-${Date.now()}`
        : opts.revived
        ? `order-revived-${orderId}-${String(o.order.transfer_due_at ?? "")}`
        : `order-ready-${orderId}`,
      element: React.createElement(OrderConfirmationEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        currency: o.currency,
        methods: methods as unknown as OrderEmailMethod[],
        transferDueAt: String(o.order.transfer_due_at ?? ""),
        region: regionForCurrency(currency),
        orderUrl: storefrontOrderUrl(orderId),
        variant: "ready",
        courier: await courierName(supabase, o.order.planned_shipping_method_id),
        paidy: chosen === "transfer" ? await paidyOfferedForEmail(supabase, o.order, o.to.is_test) : false,
        chosenMethod: chosen,
        pointsApplied: Number(ptsPaid ?? 0),
        ...(changedFrom ? { methodChanged: { from: changedFrom } } : {}),
      }),
    });
  });
}

/**
 * The method an order was paid with BEFORE its latest change: the newest
 * audit_logs 'payment_method_changed' row for it (written by both
 * change_web_payment_method_atomic and the customer switch), old_value_json
 * ->> 'payment_method', mapped to the public name. null when there is none.
 */
async function previousMethod(supabase: Db, orderId: string): Promise<"transfer" | "paidy" | "card" | null> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("old_value_json, created_at")
    .eq("entity_id", orderId)
    .eq("action", "payment_method_changed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const old = ((data as AnyRec).old_value_json as AnyRec | null)?.payment_method;
  return old ? publicMethod(old) : null;
}

/**
 * Paidy ato-barai (2026-10-03): the same rule the order page applies
 * (_shared/paidy-rules.ts), read at send time. A "ready" email names Paidy
 * only when the page the customer opens will actually offer it.
 */
async function paidyOfferedForEmail(supabase: Db, order: AnyRec, customerIsTest: boolean): Promise<boolean> {
  try {
    const [{ data: modeRow }, { data: keyRow }] = await Promise.all([
      supabase.from("system_settings").select("value").eq("key", "paidy_mode").maybeSingle(),
      supabase.from("system_settings").select("value").eq("key", "paidy_public_key").maybeSingle(),
    ]);
    const snap = (order.ship_to_snapshot ?? null) as AnyRec | null;
    return paidyNotOfferedReason({
      mode: paidyModeFrom((modeRow as AnyRec | null)?.value),
      publicKey: (keyRow as AnyRec | null)?.value,
      customerIsTest,
      order: order as never,
      address: snap ? { line1: snap.line1 as string, city: snap.city as string, region: snap.region as string, postal_code: snap.postal_code as string, country: snap.country as string } : null,
      pendingSubmissions: 0,
      paymentMethod: (order.payment_method ?? null) as string | null,
    }) === null;
  } catch (e) {
    console.warn("[reservation-emails] paidy offer check failed (line omitted):", e);
    return false;
  }
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
  opts: ReadyEmailOpts = {},
): Promise<ReservationEmailResult> {
  // Revival (reactivate-web-layaway): same content, the new deadline, a key
  // of its own — see sendOrderReadyEmail.
  const label = opts.revived ? "layaway-revived" : "layaway-ready";
  return guarded(label, async () => {
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
    // Points used at checkout paid part or all of the deposit (2026-10-05).
    const { data: ptsPaid } = await supabase.rpc("layaway_points_paid", { p_account_id: accountId });
    // Website orders PR 6: what the plan is for. Product lines carry a
    // variant; the service lines staff added on the review screen do not.
    const { data: lineRows } = await supabase
      .from("layaway_account_items").select("title, variant_id").eq("account_id", accountId).order("created_at");
    const lines = (lineRows ?? []) as AnyRec[];
    const pieces = lines.filter((l) => l.variant_id).map((l) => String(l.title ?? "")).filter(Boolean);
    const services = lines.filter((l) => !l.variant_id).map((l) => String(l.title ?? "")).filter(Boolean);
    return await sendStorefrontEmail({
      to: p.to,
      subject: layawayReadySubject(p.reference),
      label,
      reference: p.reference,
      idempotencyKey: opts.revived
        ? `layaway-revived-${accountId}-${String(p.plan.transfer_due_at ?? "")}`
        : `layaway-ready-${accountId}`,
      element: React.createElement(LayawayPlanCreatedEmail, {
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
        pieces,
        services,
        courier: await courierName(supabase, p.plan.planned_shipping_method_id),
        pointsApplied: Number(ptsPaid ?? 0),
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
      subject: orderCancelledSubject(o.reference, o.lang),
      label: "order-cancelled",
      reference: o.reference,
      idempotencyKey: `order-cancelled-${orderId}`,
      element: React.createElement(OrderCancelledEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        currency: o.currency,
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
        shopUrl: storefrontShopUrl(),
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
      subject: orderReservationLapsedSubject(o.reference, o.lang),
      label: "order-reservation-lapsed",
      reference: o.reference,
      idempotencyKey: `order-reservation-lapsed-${orderId}`,
      element: React.createElement(OrderReservationLapsedEmail, {
        lang: o.lang,
        reference: o.reference,
        items: o.items,
        shippingJpy: Number(o.order.shipping_fee ?? 0),
        totalJpy: Number(o.order.total_amount ?? 0),
        currency: o.currency,
        shopUrl: storefrontShopUrl(),
      }),
    });
  });
}

// ─────────────────────────────────────────── website orders PR 6: DRAFTS
//
// A draft (web_order_drafts) is a checkout staff have not confirmed yet. It is
// not an order, so these build the email from the draft and its lines. The
// same templates as the old reserve-first flow, with the provisional note.
// Keys are per DRAFT id, so a draft's "reserved" and "declined" mails can never
// collide with an order's.

/** The storefront page for a draft (storefront PR 7: /checkout/complete/d/:id). */
export function storefrontDraftUrl(draftId: string): string {
  return `${STOREFRONT_PUBLIC_URL}/checkout/complete/d/${encodeURIComponent(draftId)}`;
}

async function loadDraft(supabase: Db, draftId: string) {
  const { data: draft } = await supabase
    .from("web_order_drafts")
    .select("id, web_reference, mode, term_months, settlement_currency, shipping, total, deposit, customer_lang, ship_to_snapshot, points_value, payment_method, customers(email, is_test)")
    .eq("id", draftId)
    .maybeSingle();
  if (!draft) return null;
  const { data: lines } = await supabase
    .from("web_order_draft_lines")
    .select("website_product_id, title, qty, line_total_jpy")
    .eq("draft_id", draftId)
    .order("created_at");
  const ids = [...new Set(((lines ?? []) as AnyRec[]).map((l) => l.website_product_id).filter(Boolean))];
  const { data: prods } = ids.length
    ? await supabase.from("website_products").select("id, name, name_ja").in("id", ids)
    : { data: [] as AnyRec[] };
  const byId = new Map<string, AnyRec>(((prods ?? []) as AnyRec[]).map((p) => [String(p.id), p]));
  const items: OrderEmailItem[] = ((lines ?? []) as AnyRec[]).map((l) => {
    const pr = l.website_product_id ? byId.get(String(l.website_product_id)) : undefined;
    const title = String(l.title ?? "");
    const name = pr?.name ? String(pr.name) : "";
    const title_ja = name && pr?.name_ja && title.startsWith(name) ? String(pr.name_ja) + title.slice(name.length) : null;
    return { title, title_ja, qty: Number(l.qty ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) };
  });
  const d = draft as AnyRec;
  const customer = d.customers as AnyRec | null;
  return {
    draft: d,
    items,
    reference: String(d.web_reference ?? ""),
    // Draft money is in the settlement currency (converted once at checkout).
    currency: (String(d.settlement_currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP",
    lang: emailLang(d.customer_lang, snapshotCountry(d)),
    to: { email: (customer?.email as string | null) ?? null, is_test: customer?.is_test === true },
  };
}

/** Checkout in draft mode: "we have your order / layaway request". Nothing to pay yet. */
export function sendDraftReservedEmail(supabase: Db, draftId: string): Promise<ReservationEmailResult> {
  return guarded("draft-reserved", async () => {
    const d = await loadDraft(supabase, draftId);
    if (!d) return { sent: false, reason: "not_found" };
    if (d.draft.mode === "layaway") {
      return await sendStorefrontEmail({
        to: d.to,
        subject: layawayReservedSubject(d.reference),
        label: "layaway-reserved",
        reference: d.reference,
        idempotencyKey: `draft-reserved-${draftId}`,
        element: React.createElement(LayawayReservedEmail, {
          reference: d.reference,
          currency: d.currency,
          totalAmount: Number(d.draft.total ?? 0),
          deposit: Number(d.draft.deposit ?? 0),
          termMonths: Number(d.draft.term_months ?? 0),
          planUrl: storefrontDraftUrl(draftId),
          provisional: true,
        }),
      });
    }
    return await sendStorefrontEmail({
      to: d.to,
      subject: orderReservedSubject(d.reference, d.lang),
      label: "order-reserved",
      reference: d.reference,
      idempotencyKey: `draft-reserved-${draftId}`,
      element: React.createElement(OrderReservedEmail, {
        lang: d.lang,
        reference: d.reference,
        items: d.items,
        shippingJpy: d.draft.shipping === null || d.draft.shipping === undefined ? null : Number(d.draft.shipping),
        totalJpy: Number(d.draft.total ?? 0),
        currency: d.currency,
        orderUrl: storefrontDraftUrl(draftId),
        provisional: true,
        pointsApplied: Number(d.draft.points_value ?? 0),
        method: publicMethod(d.draft.payment_method),
      }),
    });
  });
}

/**
 * A draft ended unconfirmed: staff pressed "Can't supply" (declined, with the
 * reason) or 72 hours passed (lapsed). Nothing was ever paid.
 */
export function sendDraftClosedEmail(
  supabase: Db,
  draftId: string,
  kind: "declined" | "lapsed",
  reason?: string | null,
): Promise<ReservationEmailResult> {
  return guarded(`draft-${kind}`, async () => {
    const d = await loadDraft(supabase, draftId);
    if (!d) return { sent: false, reason: "not_found" };
    const shippingJpy = d.draft.shipping === null || d.draft.shipping === undefined ? null : Number(d.draft.shipping);
    if (d.draft.mode === "layaway") {
      const label = kind === "lapsed" ? "layaway-reservation-lapsed" : "layaway-declined";
      return await sendStorefrontEmail({
        to: d.to,
        subject: layawayDeclinedSubject(d.reference, kind),
        label,
        reference: d.reference,
        idempotencyKey: `draft-${kind}-${draftId}`,
        element: React.createElement(LayawayDeclinedEmail, {
          reference: d.reference,
          kind,
          reason: reason ?? null,
          shopUrl: storefrontShopUrl(),
        }),
      });
    }
    if (kind === "lapsed") {
      return await sendStorefrontEmail({
        to: d.to,
        subject: orderReservationLapsedSubject(d.reference, d.lang),
        label: "order-reservation-lapsed",
        reference: d.reference,
        idempotencyKey: `draft-lapsed-${draftId}`,
        element: React.createElement(OrderReservationLapsedEmail, {
          lang: d.lang,
          reference: d.reference,
          items: d.items,
          shippingJpy,
          totalJpy: Number(d.draft.total ?? 0),
          currency: d.currency,
          shopUrl: storefrontShopUrl(),
        }),
      });
    }
    return await sendStorefrontEmail({
      to: d.to,
      subject: orderCancelledSubject(d.reference, d.lang),
      label: "order-cancelled",
      reference: d.reference,
      idempotencyKey: `draft-declined-${draftId}`,
      element: React.createElement(OrderCancelledEmail, {
        lang: d.lang,
        reference: d.reference,
        items: d.items,
        shippingJpy,
        totalJpy: Number(d.draft.total ?? 0),
        currency: d.currency,
        reason: reason ?? "",
        refundStatus: null,
        refundNote: null,
        orderUrl: null,
      }),
    });
  });
}
