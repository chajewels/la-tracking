// The customer email for a staff-cancelled layaway — one sender per channel.
//
// cancel-layaway calls this after cancel_layaway_atomic commits. A WEB plan gets
// the storefront email (email-templates/layaway-cancelled.tsx) through
// sendStorefrontEmail, which logs every outcome (sent, failed, suppressed,
// skipped) via recordEmailAttempt and never throws. A Hub plan gets the Hub
// template 'layaway-cancelled' through sendTemplateEmail — the same split the
// forfeit emails make (forfeitEmailKind in web-order-rules.ts).
//
// Layaway emails are ENGLISH ONLY (owner rule 2026-09-27): neither template has
// a language prop. The reason staff typed is never sent to the customer.

import * as React from "npm:react@18.3.1";
import { sendStorefrontEmail, storefrontLayawayUrl } from "./storefront-email.ts";
import { LayawayCancelledEmail, layawayCancelledSubject } from "./email-templates/layaway-cancelled.tsx";
import { sendTemplateEmail } from "./transactional-email-templates/send-email.ts";
import { customerReference } from "./order-reference.ts";
import { forfeitEmailKind } from "./web-order-rules.ts";
import { maskEmail } from "./redact.ts";

export async function sendLayawayCancelledEmail(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  accountId: string,
  opts: { pointsReversed: boolean; idempotencyKey: string },
): Promise<void> {
  const { data: acct, error } = await supabase
    .from("layaway_accounts")
    .select("id, invoice_number, web_reference, source_channel, currency, total_amount, total_paid, customers(full_name, email, is_test)")
    .eq("id", accountId)
    .single();
  if (error || !acct) {
    console.warn(`[layaway-cancel-email] account ${accountId} not readable — no email:`, error);
    return;
  }
  const currency = String(acct.currency ?? "JPY") as "JPY" | "PHP";

  if (forfeitEmailKind(acct.source_channel) === "storefront") {
    const reference = String(acct.web_reference ?? acct.invoice_number);
    await sendStorefrontEmail({
      to: { email: acct.customers?.email ?? null, is_test: acct.customers?.is_test === true },
      subject: layawayCancelledSubject(reference),
      label: "layaway-cancelled",
      reference,
      idempotencyKey: opts.idempotencyKey,
      element: React.createElement(LayawayCancelledEmail, {
        reference,
        currency,
        totalAmount: Number(acct.total_amount ?? 0),
        totalPaid: Number(acct.total_paid ?? 0),
        planUrl: storefrontLayawayUrl(accountId),
        pointsReversed: opts.pointsReversed,
      }),
    });
    return;
  }

  const email = acct.customers?.email;
  if (!email) {
    console.log(`[layaway-cancel-email] INV ${acct.invoice_number}: customer has no email — not sent`);
    return;
  }
  const sent = await sendTemplateEmail("layaway-cancelled", email, {
    templateData: {
      customerName: acct.customers?.full_name,
      invoiceNumber: customerReference(acct),
      currency,
      totalAmount: Number(acct.total_amount ?? 0).toLocaleString("en-US"),
      totalPaid: Number(acct.total_paid ?? 0).toLocaleString("en-US"),
      pointsReversed: opts.pointsReversed,
      portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${acct.invoice_number || ""}`,
    },
    idempotencyKey: opts.idempotencyKey,
  });
  if (!sent.sent) {
    console.log(`[layaway-cancel-email] "layaway-cancelled" suppressed for ${maskEmail(email)}`);
  }
}
