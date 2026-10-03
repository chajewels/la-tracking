import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { PaidyError, isPaidyPaymentId, paidy, type PaidyPayment } from "../_shared/paidy.ts";

/**
 * Paidy webhook receiver (2026-10-03, docs/PAIDY.md). PUBLIC endpoint
 * (verify_jwt = false): Paidy signs nothing, so NOTHING in the request body is
 * trusted. The body only names a payment id; the Hub then reads that payment
 * from Paidy with its own secret key and syncs what PAIDY says. An id the Hub
 * does not know is ignored with 200 (Paidy retries non-2xx).
 *
 * What it changes: paidy_payments.status / last_webhook_at / last_payload.
 * When Paidy reports a payment CLOSED that the Hub never captured (the
 * customer cancelled in MyPaidy, or Paidy's operations closed it), the live
 * submission is rejected with that note and the staff bell rings. Money is
 * never moved from here — capture and close happen only in
 * review-payment-submission.
 */
const LOG = "[paidy-webhook]";

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return jsonResponse({ error: "bad_json" }, 400); }
  const id = body.payment_id ?? body.id;
  if (!isPaidyPaymentId(id)) return jsonResponse({ ok: true, ignored: "no_payment_id" });
  // Paidy's real body (console tester, 2026-10-03): { payment_id, status:
  // "authorize_success" | "close_success" | "update_success" |
  // "capture_success" | "refund_success", capture_id?, order_ref, ... } — the
  // event name is in `status`; older notes used `event`. Label only, never trusted.
  const event = String(body.status ?? body.event ?? "");

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await supabase
    .from("paidy_payments").select("id, cash_order_id, status, paidy_payment_id").eq("paidy_payment_id", id).maybeSingle();
  if (!row) return jsonResponse({ ok: true, ignored: "unknown_payment" });

  let payment: PaidyPayment;
  try {
    payment = await paidy.get(id);
  } catch (e) {
    console.error(`${LOG} paidy.get failed for ${id}:`, e);
    // 5xx makes Paidy retry later; a 4xx from Paidy is final for this id.
    return jsonResponse({ error: "paidy_unavailable" }, e instanceof PaidyError && e.status < 500 ? 200 : 502);
  }

  const now = new Date().toISOString();
  const captured = (payment.captures ?? []).length > 0;
  const next =
    payment.status === "REJECTED" ? "rejected"
    : payment.status === "CLOSED" && captured ? "captured"
    : payment.status === "CLOSED" ? "closed"
    : "authorized";

  // Our own transitions win: a capture the Hub recorded is never downgraded,
  // and expired stays expired.
  const settled = row.status === "captured" || row.status === "expired";
  const update: Record<string, unknown> = { last_webhook_at: now, last_payload: payment, updated_at: now };
  if (!settled && next !== row.status) {
    update.status = next;
    if (next === "captured") { update.captured_at = now; update.capture_id = payment.captures?.[0]?.id ?? null; }
    if (next === "closed" || next === "rejected") { update.closed_at = now; update.closed_reason = `webhook: ${event || payment.status}`; }
  }
  await supabase.from("paidy_payments").update(update).eq("id", row.id);

  // Closed or rejected on Paidy's side while a reviewer still had it in the
  // queue: nothing can be captured any more, so the submission is rejected.
  if (!settled && (next === "closed" || next === "rejected") && row.status === "authorized") {
    const { data: subs } = await supabase
      .from("payment_submissions").select("id").eq("paidy_payment_id", row.id).in("status", ["submitted", "under_review"]);
    for (const sub of (subs ?? []) as { id: string }[]) {
      await supabase.from("payment_submissions").update({
        status: "rejected", updated_at: now,
        reviewer_notes: `Closed by Paidy (${event || payment.status}) before Confirm — the customer must pay again.`,
      }).eq("id", sub.id);
      await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission", entity_id: sub.id, action: "submission_rejected",
        new_value_json: { reason: "paidy_closed_externally", paidy_payment_id: id, event: event || null },
      });
    }
    try {
      await supabase.from("staff_notifications").insert({
        type: "paidy_closed_externally",
        title: "Paidy authorisation closed before Confirm",
        body: `Paidy reports ${id} as ${payment.status}; the pending submission was rejected. The customer must pay again.`,
        metadata: { cash_order_id: row.cash_order_id, paidy_payment_id: id, event: event || null },
      });
    } catch (e) { console.warn(`${LOG} bell failed (non-blocking):`, e); }
  }

  return jsonResponse({ ok: true, status: next });
});
