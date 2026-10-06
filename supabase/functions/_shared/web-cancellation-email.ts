// The Cha Jewels "order cancelled" email for a WEBSITE order — reason and
// refund decision, the same two lines she sees on /account/orders.
//
// Moved here from cancel-cash-order (payment lifecycle addendum §9 #10) so the
// automatic fraud cancel (_shared/square-sync.ts fraudCancel) sends the same
// email, with the NEUTRAL reason (_shared/customer-reasons.ts) — never "fraud".
//
// Fire-and-forget: NEVER throws. One logical send per order
// (`order-cancelled-<order id>`).
import * as React from "npm:react@18.3.1";
import { emailLang, sendStorefrontEmail, snapshotCountry, storefrontOrderUrl } from "./storefront-email.ts";
import { OrderCancelledEmail, orderCancelledSubject, type RefundStatus } from "./email-templates/order-cancelled.tsx";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export interface WebCancellationEmailArgs {
  /** The reason shown when no per-language reason is given (staff text). */
  reason: string;
  /** Shown instead of `reason`, per language (automatic cancels). */
  reasonByLang?: { ja: string; en: string } | null;
  refundStatus: RefundStatus | null;
  refundNote: string | null;
  /** Overrides `order-cancelled-<order>` (the automatic fraud cancel uses its own key, so a later real cancel after a revive is never swallowed). */
  idempotencyKey?: string;
}

export async function sendWebCancellationEmail(supabase: Db, orderId: string, args: WebCancellationEmailArgs): Promise<void> {
  try {
    const { data: order } = await supabase
      .from("cash_orders")
      .select("id, web_reference, invoice_number, source_channel, customer_lang, ship_to_snapshot, shipping_fee, total_amount, currency, customers(email, is_test)")
      .eq("id", orderId)
      .maybeSingle();
    if (!order || order.source_channel !== "web") return;
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
    const items = ((lines ?? []) as AnyRec[]).map((l) => {
      const pr = l.website_product_id ? byId.get(String(l.website_product_id)) : undefined;
      const title = String(l.title ?? "");
      const title_ja = pr?.name && pr?.name_ja && title.startsWith(pr.name) ? pr.name_ja + title.slice(pr.name.length) : null;
      return { title, title_ja, qty: Number(l.quantity ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) };
    });
    const reference = String(order.web_reference ?? order.invoice_number);
    const customer = (order as AnyRec).customers;
    const lang = emailLang(order.customer_lang, snapshotCountry(order));
    await sendStorefrontEmail({
      to: { email: customer?.email ?? null, is_test: customer?.is_test === true },
      subject: orderCancelledSubject(reference, lang),
      label: "order-cancelled",
      reference,
      idempotencyKey: args.idempotencyKey ?? `order-cancelled-${orderId}`,
      element: React.createElement(OrderCancelledEmail, {
        lang,
        reference,
        items,
        shippingJpy: Number(order.shipping_fee ?? 0),
        totalJpy: Number(order.total_amount ?? 0),
        currency: String(order.currency ?? "JPY") === "PHP" ? "PHP" : "JPY",
        reason: args.reason,
        reasonByLang: args.reasonByLang ?? null,
        refundStatus: args.refundStatus,
        refundNote: args.refundNote,
        orderUrl: storefrontOrderUrl(orderId),
      }),
    });
  } catch (mailErr) {
    console.warn("[web-cancellation-email] order-cancelled email failed (non-blocking):", mailErr);
  }
}
