import * as React from "npm:react@18.3.1";
import {
  sendStorefrontEmail, storefrontLayawayUrl, storefrontOrderUrl, type SendStorefrontEmailResult,
} from "./storefront-email.ts";
import { regionForCurrency, transferMethods } from "./transfer-methods.ts";
import type { OrderEmailMethod } from "./email-templates/order-shared.tsx";
import { OrderPaymentDueEmail, orderPaymentDueSubject } from "./email-templates/order-payment-due.tsx";
import { LayawayDepositDueEmail, layawayDepositDueSubject } from "./email-templates/layaway-deposit-due.tsx";
import { paymentReminderIdempotencyKey, paymentReminderLabel } from "./web-payment-reminder-rules.ts";

/**
 * Stage D: render and send ONE claimed payment reminder (docs/WEB-PAYMENT-
 * REMINDERS.md). Built from the web_payment_reminders row the claim wrote under
 * the order's row lock — the amount, currency, language, deadline and address
 * the SQL checked are exactly what the email says.
 *
 * Sends through sendStorefrontEmail, the order-email pipeline: Cha Jewels brand,
 * Reply-To sales@, purpose 'transactional', the test gate, an idempotency key,
 * and one email_send_log row for every outcome. Never throws.
 */

// deno-lint-ignore no-explicit-any
type Db = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyRec = Record<string, unknown>;

export type PaymentReminderEmailResult =
  | SendStorefrontEmailResult
  | { sent: false; reason: "not_found" | "error"; detail?: string };

export async function sendClaimedPaymentReminder(
  supabase: Db,
  claimId: string,
  isTest: boolean,
): Promise<PaymentReminderEmailResult> {
  try {
    const { data: row, error } = await supabase
      .from("web_payment_reminders")
      .select("entity_type, entity_id, deadline, reference, email, lang, currency, amount")
      .eq("id", claimId)
      .maybeSingle();
    if (error) throw error;
    if (!row) return { sent: false, reason: "not_found" };
    const r = row as AnyRec;
    const entity = String(r.entity_type) === "layaway" ? "layaway" : "cash_order";
    const entityId = String(r.entity_id);
    const reference = String(r.reference ?? "");
    const currency = String(r.currency) === "PHP" ? "PHP" : "JPY";
    const deadline = String(r.deadline);
    const methods = (await transferMethods(supabase, currency)) as unknown as OrderEmailMethod[];
    const common = {
      to: { email: String(r.email ?? ""), is_test: isTest },
      label: paymentReminderLabel(entity),
      reference,
      idempotencyKey: paymentReminderIdempotencyKey(entityId, deadline),
    };

    if (entity === "layaway") {
      return await sendStorefrontEmail({
        ...common,
        subject: layawayDepositDueSubject(reference),
        element: React.createElement(LayawayDepositDueEmail, {
          reference,
          currency,
          deposit: Number(r.amount ?? 0),
          methods,
          transferDueAt: deadline,
          region: regionForCurrency(currency),
          planUrl: storefrontLayawayUrl(entityId),
        }),
      });
    }

    return await sendStorefrontEmail({
      ...common,
      subject: orderPaymentDueSubject(reference),
      element: React.createElement(OrderPaymentDueEmail, {
        lang: String(r.lang) === "en" ? "en" : "ja",
        reference,
        currency,
        amount: Number(r.amount ?? 0),
        methods,
        transferDueAt: deadline,
        region: regionForCurrency(currency),
        orderUrl: storefrontOrderUrl(entityId),
      }),
    });
  } catch (err) {
    const detail = (err as Error)?.message ?? String(err);
    console.error("[payment-reminder-emails] send failed (non-blocking):", detail);
    return { sent: false, reason: "error", detail };
  }
}
