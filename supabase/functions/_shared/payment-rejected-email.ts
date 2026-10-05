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
import { pickLang, sendStorefrontEmail, storefrontOrderUrl } from "./storefront-email.ts";
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
      .select("id, invoice_number, web_reference, source_channel, customer_lang, currency, status, remaining_balance, transfer_due_at, customers(full_name, email, is_test)")
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
      await sendStorefrontEmail({
        to: { email, is_test: customer.is_test === true },
        subject: orderPaymentNotAcceptedSubject(reference),
        label: "order-payment-not-accepted",
        reference,
        idempotencyKey,
        element: React.createElement(OrderPaymentNotAcceptedEmail, {
          lang: pickLang(order.customer_lang),
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
