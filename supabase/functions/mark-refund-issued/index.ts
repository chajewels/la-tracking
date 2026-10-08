// mark-refund-issued — staff record that the refund on a CANCELLED WEBSITE
// order has been sent, and the customer is told 「返金が完了しました」
// (payment lifecycle addendum §9 #8, owner directive 2026-10-06).
//
// POST { cash_order_id, method: bank_transfer|paidy|card|cash|other,
//        refunded_on: YYYY-MM-DD, note? }
// Person only (no service-role path): the audit row names who did it.
// Permission cancel_cash_order — the same people who record the refund
// decision at cancel. The ONE writer is mark_web_order_refund_issued_atomic
// (locks the order, refuses anything but a cancelled web order still
// refund_pending, audits). The email is sendOrderUpdateEmail's job: web only,
// once per order, never throws — the recorded refund stands either way.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendOrderUpdateEmail } from "../_shared/order-update-email.ts";
import { isRefundMethod, refundIssuedRefusal, type RefundMethodCode } from "../_shared/refund-issued-rules.ts";
import { refundReceivedKey } from "../_shared/square-reconcile-rules.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  not_found: 404, not_web_order: 409, not_cancelled: 409, not_refund_pending: 409,
  bad_method: 400, bad_date: 400, user_identity_required: 401,
  // B01 (2026-10-08): a card-paid order is refunded in Square — method 'card',
  // only once Square shows a COMPLETED refund (the SQL decides; amount = what
  // Square completed).
  method_mismatch: 409, no_completed_card_refund: 409,
};

/** True when the "refund issued" email for this order already went out (B01 retry). */
async function refundIssuedEmailSent(supabase: { from: (t: string) => any }, key: string): Promise<boolean> {
  const { count, error } = await supabase.from("email_send_log").select("id", { count: "exact", head: true })
    .eq("status", "sent").eq("metadata->>idempotency_key", key);
  if (error) throw error;
  return (count ?? 0) > 0;
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  if (!ctx.user) return jsonResponse({ error: "a staff member must do this" }, 403);
  const denied = await requirePermission(ctx, "cancel_cash_order");
  if (denied) return denied;
  const { supabase } = ctx;

  try {
    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.cash_order_id ?? "");
    if (!UUID_RE.test(orderId)) return jsonResponse({ error: "cash_order_id must be a uuid" }, 400);
    const method = typeof body?.method === "string" ? body.method.trim().toLowerCase() : "";
    const refundedOn = typeof body?.refunded_on === "string" ? body.refunded_on.trim() : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";

    const { data: order, error } = await supabase
      .from("cash_orders").select("id, source_channel, status, refund_status").eq("id", orderId).maybeSingle();
    if (error) throw error;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
    const refusal = refundIssuedRefusal(order, { method, refundedOn }, today);
    if (refusal) return jsonResponse({ error: refusal }, STATUS[refusal] ?? 409);

    const { data, error: rpcErr } = await supabase.rpc("mark_web_order_refund_issued_atomic", {
      p_order_id: orderId, p_user_id: ctx.user.id, p_method: method, p_refunded_on: refundedOn, p_note: note || null,
    });
    if (rpcErr) throw rpcErr;
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok !== true) {
      const code = String(r.error ?? "refused");
      return jsonResponse({ error: code }, STATUS[code] ?? 409);
    }

    const emailKey = `refund-issued-${orderId}`;
    const alreadyRecorded = r.already_recorded === true;

    // A refund made in the Square / Paidy dashboard already emailed her
    // 「返金を受け付けました」 with the provider's amount (§9 #9). Marking it
    // issued then records it on the order only — never a second email with a
    // possibly different amount.
    if (method === "card") {
      // R06 (2026-10-08): a COMPLETED Square refund row is a financial fact, not
      // a delivery receipt. "Already emailed" is said only when the send log
      // holds a sent row for that refund's own key; otherwise the truth is
      // "not confirmed" (the hourly check re-sends it, B02). Either way no
      // second message is sent from here (one-message policy).
      const { data: rfs, error: rErr } = await supabase.from("square_refunds").select("square_refund_id")
        .eq("cash_order_id", orderId).eq("status", "COMPLETED");
      if (rErr) throw rErr;
      const ids = ((rfs ?? []) as Array<{ square_refund_id: string }>).map((x) => String(x.square_refund_id));
      if (ids.length > 0) {
        let proven = false;
        for (const id of ids) {
          if (await refundIssuedEmailSent(supabase, refundReceivedKey(id))) { proven = true; break; }
        }
        return jsonResponse({
          ok: true, amount: r.amount, currency: r.currency, already_recorded: alreadyRecorded, email_sent: false,
          email_skipped: proven ? "provider_refund_already_emailed" : "provider_refund_email_not_confirmed",
        });
      }
    } else if (method === "paidy") {
      const { count, error: rErr } = await supabase.from("paidy_refunds").select("id", { count: "exact", head: true }).eq("cash_order_id", orderId);
      if (rErr) throw rErr;
      if ((count ?? 0) > 0) {
        return jsonResponse({ ok: true, amount: r.amount, currency: r.currency, already_recorded: alreadyRecorded, email_sent: false, email_skipped: "provider_refund_already_emailed" });
      }
    }

    // B01 retry (2026-10-08): the same request after it already succeeded —
    // nothing was written again; the email goes out only if it never did.
    if (alreadyRecorded && await refundIssuedEmailSent(supabase, emailKey)) {
      return jsonResponse({ ok: true, amount: r.amount, currency: r.currency, already_recorded: true, email_sent: false, email_skipped: "already_sent" });
    }

    const email = await sendOrderUpdateEmail(supabase, {
      entity: "cash_order", id: orderId, variant: "refund_issued",
      amount: Number(r.amount ?? 0), refundMethod: isRefundMethod(method) ? method as RefundMethodCode : null,
      refundDate: String(r.refunded_on ?? refundedOn), idempotencyKey: emailKey,
    });
    return jsonResponse({ ok: true, amount: r.amount, currency: r.currency, already_recorded: alreadyRecorded, email_sent: email.sent });
  } catch (err) {
    console.error("[mark-refund-issued] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
