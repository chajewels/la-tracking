// The customer's email when a payment on a CASH ORDER is rejected
// (owner 2026-10-05, "OK fix reject email").
//
// Before this, review-payment-submission emailed a rejection only for layaway
// plans: its lookup read layaway_accounts by submission.account_id, which is
// null on a cash-order submission, so every cash / web-order Reject (22 by
// 2026-10-05) told the customer nothing — and Paidy never emails a
// cancellation itself. The Reject dialog promised "The customer will see your
// reason".
//
// One helper, every path that rejects a cash-order submission:
//   - a reviewer's Reject (kind 'staff', the reviewer's message is shown);
//   - Paidy / Square ending the authorisation (kind 'provider_ended': a Confirm
//     that finds it closed or expired, the Paidy webhook / hourly check, the
//     Square webhook / reconcile). No message — those notes are internal.
//
// Web order → the Cha Jewels storefront email (customer's language).
// Hub cash order → the Hub "payment-rejected" template, as layaway plans get.
// Fire-and-forget: NEVER throws — a failed email must not undo a rejection.
// Idempotent per submission (one logical send: `payment-rejected-<id>`).
import * as React from "npm:react@18.3.1";
import { emailLang, sendStorefrontEmail, snapshotCountry, storefrontOrderUrl } from "./storefront-email.ts";
import { sendTemplateEmail } from "./transactional-email-templates/send-email.ts";
import { customerReference } from "./order-reference.ts";
import { regionForCurrency } from "./transfer-methods.ts";
import {
  OrderPaymentNotAcceptedEmail, orderPaymentNotAcceptedSubject,
  type NotAcceptedKind, type NotAcceptedMethod,
} from "./email-templates/order-payment-not-accepted.tsx";

// deno-lint-ignore no-explicit-any
type Db = any;

/** transfer | paidy | card, from the submission's own method. */
export function notAcceptedMethod(paymentMethod: unknown): NotAcceptedMethod {
  const m = String(paymentMethod ?? "").toLowerCase();
  return m === "paidy" ? "paidy" : m === "square" || m === "card" ? "card" : "transfer";
}

export async function sendCashPaymentRejectedEmail(
  db: Db,
  args: { submissionId: string; kind: NotAcceptedKind; reason?: string | null },
): Promise<void> {
  try {
    const { data: sub, error: subErr } = await db
      .from("payment_submissions")
      .select("id, status, cash_order_id, payment_method, submitted_amount")
      .eq("id", args.submissionId)
      .maybeSingle();
    if (subErr || !sub?.cash_order_id || String(sub.status) !== "rejected") return;

    const { data: order, error: ordErr } = await db
      .from("cash_orders")
      .select("id, invoice_number, web_reference, source_channel, customer_lang, ship_to_snapshot, currency, status, remaining_balance, transfer_due_at, customers(full_name, email, is_test)")
      .eq("id", sub.cash_order_id)
      .maybeSingle();
    if (ordErr || !order) return;
    const customer = (order as Record<string, any>).customers ?? {};
    const email: string | null = customer.email ?? null;
    const currency = String(order.currency ?? "JPY") === "PHP" ? "PHP" : "JPY";
    const reason = args.kind === "staff" ? (String(args.reason ?? "").trim() || null) : null;
    const idempotencyKey = `payment-rejected-${sub.id}`;

    if (order.source_channel === "web") {
      const reference = String(order.web_reference ?? order.invoice_number);
      const open = String(order.status) === "pending";
      const remaining = open ? Number(order.remaining_balance ?? 0) : null;
      const lang = emailLang(order.customer_lang, snapshotCountry(order));
      await sendStorefrontEmail({
        to: { email, is_test: customer.is_test === true },
        subject: orderPaymentNotAcceptedSubject(reference, lang),
        label: "order-payment-not-accepted",
        reference,
        idempotencyKey,
        element: React.createElement(OrderPaymentNotAcceptedEmail, {
          lang,
          reference,
          method: notAcceptedMethod(sub.payment_method),
          kind: args.kind,
          amount: Number(sub.submitted_amount ?? 0),
          currency,
          reason,
          remaining: remaining !== null && remaining > 0 ? remaining : null,
          transferDueAt: order.transfer_due_at ?? null,
          region: regionForCurrency(currency),
          orderUrl: storefrontOrderUrl(String(order.id)),
        }),
      });
      return;
    }

    if (!email) return;
    await sendTemplateEmail("payment-rejected", email, {
      templateData: {
        customerName: customer.full_name || "Valued Customer",
        invoiceNumber: customerReference(order),
        amountPaid: Number(sub.submitted_amount ?? 0).toLocaleString("en-US"),
        currency,
        rejectionReason: reason ?? "",
        portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${order.invoice_number || ""}`,
      },
      idempotencyKey,
    });
  } catch (e) {
    console.warn("[payment-rejected-email] send failed (non-blocking):", e);
  }
}

/**
 * Addendum §9 #10 (owner directive 2026-10-06): a card HOLD the Hub voided by
 * itself with NO submission to reject — the amount did not match the order,
 * Paidy had taken the order meanwhile, or Square rated it high risk and the
 * order was not cancelled. She is told only what matters to her: the hold was
 * released and nothing was charged (order-payment-not-accepted, provider_ended,
 * card). The internal reason is never shown. Web orders only. Once per Square
 * payment. Never throws.
 */
export async function sendCardHoldReleasedEmail(
  db: Db,
  args: { orderId: string; amount: number | null; squarePaymentId: string },
): Promise<void> {
  try {
    const { data: order, error } = await db
      .from("cash_orders")
      .select("id, invoice_number, web_reference, source_channel, customer_lang, ship_to_snapshot, currency, status, remaining_balance, transfer_due_at, customers(email, is_test)")
      .eq("id", args.orderId)
      .maybeSingle();
    if (error || !order || order.source_channel !== "web") return;
    const customer = (order as Record<string, any>).customers ?? {};
    const currency = String(order.currency ?? "JPY") === "PHP" ? "PHP" : "JPY";
    const reference = String(order.web_reference ?? order.invoice_number);
    const open = String(order.status) === "pending";
    const remaining = open ? Number(order.remaining_balance ?? 0) : null;
    const lang = emailLang(order.customer_lang, snapshotCountry(order));
    await sendStorefrontEmail({
      to: { email: customer.email ?? null, is_test: customer.is_test === true },
      subject: orderPaymentNotAcceptedSubject(reference, lang),
      label: "order-payment-not-accepted",
      reference,
      idempotencyKey: `card-hold-released-${args.squarePaymentId}`,
      element: React.createElement(OrderPaymentNotAcceptedEmail, {
        lang,
        reference,
        method: "card",
        kind: "provider_ended",
        amount: Number(args.amount ?? 0),
        currency,
        reason: null,
        remaining: remaining !== null && remaining > 0 ? remaining : null,
        transferDueAt: order.transfer_due_at ?? null,
        region: regionForCurrency(currency),
        orderUrl: storefrontOrderUrl(String(order.id)),
      }),
    });
  } catch (e) {
    console.warn("[payment-rejected-email] hold-released send failed (non-blocking):", e);
  }
}
