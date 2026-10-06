import * as React from "npm:react@18.3.1";
import {
  emailLang, sendStorefrontEmail, snapshotCountry, storefrontLayawayUrl, storefrontOrderUrl,
  type SendStorefrontEmailResult,
} from "./storefront-email.ts";
import { publicMethod } from "./checkout-choice.ts";
import { regionForCurrency, transferMethods } from "./transfer-methods.ts";
import type { OrderEmailMethod } from "./email-templates/order-shared.tsx";
import { OrderPaymentDueEmail, orderPaymentDueSubject } from "./email-templates/order-payment-due.tsx";
import { LayawayDepositDueEmail, layawayDepositDueSubject } from "./email-templates/layaway-deposit-due.tsx";
import { paymentReminderIdempotencyKey, paymentReminderLabel } from "./web-payment-reminder-rules.ts";

/**
 * Stage D: render and send ONE claimed payment reminder (docs/WEB-PAYMENT-
 * REMINDERS.md). Built from the web_payment_reminders row the claim wrote under
 * the order's row lock — the amount, currency, deadline and address the SQL
 * checked are exactly what the email says. An ORDER reminder's method and
 * language are read from the order row itself (payment lifecycle H3).
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
    const common = {
      to: { email: String(r.email ?? ""), is_test: isTest },
      label: paymentReminderLabel(entity),
      reference,
      idempotencyKey: paymentReminderIdempotencyKey(entityId, deadline),
    };

    if (entity === "layaway") {
      // Layaway is transfer only and English only (no lang prop).
      const methods = (await transferMethods(supabase, currency)) as unknown as OrderEmailMethod[];
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

    // Payment lifecycle H3 (controller ruling R1): the claim SQL is unchanged,
    // so the order's own row says HOW she pays and in which language. A Paidy
    // or card order gets the reminder without bank details (methods []); the
    // language follows the customer, and when it is missing the delivery
    // country (emailLang) — the claim's recorded lang defaulted to Japanese.
    const { data: order, error: orderErr } = await supabase
      .from("cash_orders")
      .select("payment_method, customer_lang, ship_to_snapshot")
      .eq("id", entityId)
      .maybeSingle();
    if (orderErr) throw orderErr;
    const o = (order ?? {}) as AnyRec;
    const method = publicMethod(o.payment_method);
    const lang = emailLang(o.customer_lang, snapshotCountry(o));
    const methods = method === "transfer"
      ? (await transferMethods(supabase, currency)) as unknown as OrderEmailMethod[]
      : [];
    return await sendStorefrontEmail({
      ...common,
      subject: orderPaymentDueSubject(reference, lang),
      element: React.createElement(OrderPaymentDueEmail, {
        lang,
        reference,
        currency,
        amount: Number(r.amount ?? 0),
        method,
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
