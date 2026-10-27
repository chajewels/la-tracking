/**
 * "Receipt ready" email for a website receipt (docs/RECEIPTS.md).
 *
 * Order receipts: the customer's language, emailLang(customer_lang, delivery
 * country) — the same rule as every other web-order email. Plan receipts:
 * English only, no language (owner rule; development/layaway-english.test.ts).
 * The email links to My Account ONLY — never the PDF, never an attachment.
 * Goes through sendStorefrontEmail (test gate, Reply-To, email_send_log).
 * Never throws.
 */
import * as React from "npm:react@18.3.1";
import { emailLang, sendStorefrontEmail, snapshotCountry, storefrontLayawayUrl, storefrontOrderUrl } from "./storefront-email.ts";
import { ReceiptReadyEmail, receiptReadySubject } from "./email-templates/receipt-ready.tsx";
import { LayawayReceiptReadyEmail, layawayReceiptReadySubject } from "./email-templates/layaway-receipt-ready.tsx";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js client
type Db = any;
type AnyRec = Record<string, unknown>;

export type ReceiptEmailOutcome =
  | { done: true; sent: boolean; reason?: string }
  | { done: false; reason: string; detail?: string };

/** Which outcomes take a receipt off the queue: sent, or a skip that will never change. */
export function receiptEmailDone(res: { sent: boolean; reason?: string }): boolean {
  if (res.sent) return true;
  return res.reason === "no_address" || res.reason === "test_customer" || res.reason === "recipient_suppressed";
}

export function receiptEmailKey(receiptId: string): string {
  return `receipt-ready-${receiptId}`;
}

export async function sendReceiptReadyEmail(db: Db, receiptId: string): Promise<ReceiptEmailOutcome> {
  try {
    const { data: rec, error } = await db
      .from("website_receipts")
      .select("id, receipt_number, status, cash_order_id, layaway_account_id, currency, total_paid, order_number")
      .eq("id", receiptId)
      .maybeSingle();
    if (error) return { done: false, reason: "lookup_error", detail: error.message };
    if (!rec) return { done: true, sent: false, reason: "not_found" };
    const r = rec as AnyRec;
    if (r.status !== "issued") return { done: true, sent: false, reason: "cancelled" };

    const isCash = r.cash_order_id != null;
    const table = isCash ? "cash_orders" : "layaway_accounts";
    const id = String(isCash ? r.cash_order_id : r.layaway_account_id);
    const cols = isCash
      ? "id, web_reference, invoice_number, source_channel, customer_lang, ship_to_snapshot, customers(email, is_test)"
      : "id, web_reference, invoice_number, source_channel, customers(email, is_test)";
    const { data: order, error: oErr } = await db.from(table).select(cols).eq("id", id).maybeSingle();
    if (oErr) return { done: false, reason: "lookup_error", detail: oErr.message };
    if (!order) return { done: true, sent: false, reason: "order_not_found" };
    const o = order as AnyRec;
    if (o.source_channel !== "web") return { done: true, sent: false, reason: "not_web" };

    const customer = (o.customers ?? {}) as AnyRec;
    const to = { email: (customer.email as string | null) ?? null, is_test: customer.is_test === true };
    const reference = String(o.web_reference ?? o.invoice_number ?? r.order_number ?? "");
    const currency = (String(r.currency ?? "JPY") === "PHP" ? "PHP" : "JPY") as "JPY" | "PHP";
    const total = Number(r.total_paid ?? 0);
    const receiptNumber = String(r.receipt_number);

    const res = isCash
      ? await (() => {
        const lang = emailLang(o.customer_lang, snapshotCountry(o));
        return sendStorefrontEmail({
          to,
          subject: receiptReadySubject(reference, lang),
          label: "receipt-ready",
          reference,
          idempotencyKey: receiptEmailKey(String(r.id)),
          element: React.createElement(ReceiptReadyEmail, {
            lang, reference, receiptNumber, currency, total, orderUrl: storefrontOrderUrl(id),
          }),
        });
      })()
      : await sendStorefrontEmail({
        to,
        subject: layawayReceiptReadySubject(reference),
        label: "layaway-receipt-ready",
        reference,
        idempotencyKey: receiptEmailKey(String(r.id)),
        element: React.createElement(LayawayReceiptReadyEmail, {
          reference, receiptNumber, currency, total, planUrl: storefrontLayawayUrl(id),
        }),
      });

    if (receiptEmailDone(res)) return { done: true, sent: res.sent, reason: res.sent ? undefined : res.reason };
    return { done: false, reason: res.sent ? "unknown" : res.reason, detail: "detail" in res ? res.detail : undefined };
  } catch (e) {
    console.warn("[receipt-email] send failed (non-blocking):", (e as Error)?.message ?? String(e));
    return { done: false, reason: "error", detail: (e as Error)?.message ?? String(e) };
  }
}
