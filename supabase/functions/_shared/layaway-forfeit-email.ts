// The customer email for a forfeited WEB layaway — one sender for every path.
//
// manual-forfeit (staff) and auto-forfeit-settlement (cron) both call this, so
// a web customer gets the same storefront email whichever path closed the plan
// (owner rule 2026-09-23). sendStorefrontEmail logs every outcome — sent,
// failed, suppressed, skipped — through recordEmailAttempt, and never throws.
//
// Hub (non-web) plans are not sent here: they keep the Hub's account-forfeited
// template. Callers decide with forfeitEmailKind() from web-order-rules.ts.

import * as React from "npm:react@18.3.1";
import { pickLang, sendStorefrontEmail, storefrontLayawayUrl, type SendStorefrontEmailResult } from "./storefront-email.ts";
import { LayawayForfeitedEmail, layawayForfeitedSubject } from "./email-templates/layaway-forfeited.tsx";

export async function sendLayawayForfeitedEmail(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  accountId: string,
  opts: { final: boolean; idempotencyKey: string },
): Promise<SendStorefrontEmailResult | null> {
  const { data: acct, error } = await supabase
    .from("layaway_accounts")
    .select("id, invoice_number, web_reference, currency, total_amount, total_paid, customer_lang, customers(email, is_test)")
    .eq("id", accountId)
    .single();
  if (error || !acct) {
    console.warn(`[layaway-forfeit-email] account ${accountId} not readable — no email:`, error);
    return null;
  }
  const reference = String(acct.web_reference ?? acct.invoice_number);
  return await sendStorefrontEmail({
    to: { email: acct.customers?.email ?? null, is_test: acct.customers?.is_test === true },
    subject: layawayForfeitedSubject(reference),
    label: "layaway-forfeited",
    reference,
    idempotencyKey: opts.idempotencyKey,
    element: React.createElement(LayawayForfeitedEmail, {
      lang: pickLang(acct.customer_lang),
      reference,
      currency: String(acct.currency ?? "JPY") as "JPY" | "PHP",
      totalAmount: Number(acct.total_amount ?? 0),
      totalPaid: Number(acct.total_paid ?? 0),
      planUrl: storefrontLayawayUrl(accountId),
      final: opts.final,
    }),
  });
}
