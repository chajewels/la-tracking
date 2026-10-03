import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { SquareError, square, verifySquareSignature, type SquarePayment } from "../_shared/square.ts";
import { cardHoldExpired, isSquarePaymentId } from "../_shared/card-rules.ts";

/**
 * Square webhook receiver (S2, 2026-10-04, docs/SQUARE.md). PUBLIC endpoint
 * (verify_jwt = false) — but every delivery is SIGNED: Square sends
 * base64(HMAC-SHA256(signature_key, notification_url + raw_body)) in
 * x-square-hmacsha256-signature. An unsigned or mis-signed body is 401 and
 * touches nothing. Even a signed body is NOT trusted for a payment's state:
 * the Hub re-reads the payment from Square with its own token and syncs what
 * SQUARE says (the Paidy rule). Every event id lands in square_webhook_events
 * once, so a redelivery is a no-op.
 *
 * What it changes: square_payments.status / refund_jpy / disputed_at /
 * last_webhook_at / last_payload. When Square reports a hold CANCELED or
 * FAILED that the Hub never captured, the live submission is rejected with
 * that note and the staff bell rings. Money is never moved from here —
 * capture and void happen only in review-payment-submission.
 *
 * NOTIFICATION_URL is the URL registered in Square Developer → Webhooks, a
 * constant: a proxy may rewrite req.url, and the signature covers the
 * registered one.
 */
const LOG = "[square-webhook]";
const NOTIFICATION_URL = "https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/square-webhook";

type Rec = Record<string, unknown>;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const raw = await req.text();
  const ok = await verifySquareSignature(NOTIFICATION_URL, raw, req.headers.get("x-square-hmacsha256-signature"));
  if (!ok) return jsonResponse({ error: "bad_signature" }, 401);

  let body: Rec = {};
  try { body = JSON.parse(raw); } catch { return jsonResponse({ error: "bad_json" }, 400); }
  const eventId = typeof body.event_id === "string" ? body.event_id : "";
  const type = String(body.type ?? "");
  const data = (body.data ?? {}) as Rec;
  const object = (data.object ?? {}) as Rec;
  if (!eventId) return jsonResponse({ ok: true, ignored: "no_event_id" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Idempotency: one row per Square event id. A duplicate delivery is a no-op.
  const paymentIdHint = paymentIdOf(type, object);
  const { error: evErr } = await supabase.from("square_webhook_events")
    .insert({ event_id: eventId, event_type: type, payment_id: paymentIdHint, payload: body });
  if (evErr) {
    if (String(evErr.code) === "23505") return jsonResponse({ ok: true, ignored: "duplicate" });
    throw evErr;
  }
  const outcome = async (o: string, error?: string) => {
    await supabase.from("square_webhook_events").update({ outcome: o, error: error ?? null }).eq("event_id", eventId);
  };

  if (!paymentIdHint || !isSquarePaymentId(paymentIdHint)) { await outcome("ignored_no_payment"); return jsonResponse({ ok: true, ignored: "no_payment_id" }); }
  const { data: row } = await supabase
    .from("square_payments").select("id, cash_order_id, status, square_payment_id, test, authorized_at, refund_jpy, disputed_at")
    .eq("square_payment_id", paymentIdHint).maybeSingle();
  if (!row) { await outcome("ignored_unknown"); return jsonResponse({ ok: true, ignored: "unknown_payment" }); }

  // Re-read from Square: the only state the Hub trusts.
  let payment: SquarePayment;
  try {
    payment = await square.get(row.test === true, row.square_payment_id);
  } catch (e) {
    console.error(`${LOG} square.get failed for ${row.square_payment_id}:`, e);
    await outcome("read_failed", e instanceof Error ? e.message : String(e));
    // 5xx makes Square retry later; a 4xx from Square is final for this id.
    return jsonResponse({ error: "square_unavailable" }, e instanceof SquareError && e.status < 500 ? 200 : 502);
  }

  const now = new Date().toISOString();
  const next =
    payment.status === "COMPLETED" ? "captured"
    : payment.status === "FAILED" ? "failed"
    : payment.status === "CANCELED" ? (cardHoldExpired(String(row.authorized_at)) ? "expired" : "voided")
    : "authorized";

  // Our own transitions win: a capture the Hub recorded is never downgraded;
  // voided / expired / failed stay as they are.
  const settled = row.status === "captured" || row.status === "expired" || row.status === "voided" || row.status === "failed";
  const update: Rec = { last_webhook_at: now, last_payload: payment, updated_at: now };
  if (!settled && next !== row.status) {
    update.status = next;
    if (next === "captured") { update.captured_at = now; update.receipt_url = payment.receipt_url ?? null; }
    if (next === "voided" || next === "expired" || next === "failed") { update.voided_at = now; update.voided_reason = `webhook: ${type} → ${payment.status}`; }
  }
  if (payment.refunded_money && Number(payment.refunded_money.amount) !== Number(row.refund_jpy ?? 0)) {
    update.refund_jpy = Math.round(Number(payment.refunded_money.amount));
  }
  const disputeId = type.startsWith("dispute.") ? String((object.dispute as Rec | undefined)?.id ?? object.id ?? "") : "";
  if (disputeId && !row.disputed_at) { update.disputed_at = now; update.dispute_id = disputeId; }
  await supabase.from("square_payments").update(update).eq("id", row.id);

  // Cancelled or failed on Square's side while a reviewer still had it in the
  // queue: nothing can be captured any more, so the submission is rejected.
  if (!settled && (next === "voided" || next === "expired" || next === "failed") && row.status === "authorized") {
    const { data: subs } = await supabase
      .from("payment_submissions").select("id").eq("square_payment_id", row.id).in("status", ["submitted", "under_review"]);
    for (const sub of (subs ?? []) as { id: string }[]) {
      await supabase.from("payment_submissions").update({
        status: "rejected", updated_at: now,
        reviewer_notes: `Card hold ${next} on Square's side (${type}) before Confirm — the customer must pay again.`,
      }).eq("id", sub.id);
      await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission", entity_id: sub.id, action: "submission_rejected",
        new_value_json: { reason: "card_closed_externally", square_payment_id: row.square_payment_id, event: type, square_status: payment.status },
      });
    }
    try {
      await supabase.from("staff_notifications").insert({
        type: "card_closed_externally",
        title: "Card hold closed before Confirm",
        body: `Square reports ${row.square_payment_id} as ${payment.status}; the pending submission was rejected. The customer must pay again.`,
        metadata: { cash_order_id: row.cash_order_id, square_payment_id: row.square_payment_id, event: type },
      });
    } catch (e) { console.warn(`${LOG} bell failed (non-blocking):`, e); }
  }

  // D10: a chargeback opens a dispute — the evidence pack is on square_payments.
  if (disputeId && !row.disputed_at) {
    try {
      await supabase.from("staff_notifications").insert({
        type: "card_dispute_opened",
        title: "Card dispute (chargeback) opened",
        body: `Square dispute ${disputeId} on payment ${row.square_payment_id}. Answer it in the Square Dashboard with the Card Purchase Agreement, the terms tick, the delivery signature and the receipt.`,
        metadata: { cash_order_id: row.cash_order_id, square_payment_id: row.square_payment_id, dispute_id: disputeId, event: type },
      });
    } catch (e) { console.warn(`${LOG} dispute bell failed (non-blocking):`, e); }
  }
  if (type.startsWith("refund.") && update.refund_jpy != null) {
    try {
      await supabase.from("staff_notifications").insert({
        type: "card_refunded",
        title: "Card payment refunded in the Square Dashboard",
        body: `¥${Number(update.refund_jpy).toLocaleString("en-US")} refunded on ${row.square_payment_id}. Record the refund decision on the order (refund_status).`,
        metadata: { cash_order_id: row.cash_order_id, square_payment_id: row.square_payment_id, refund_jpy: update.refund_jpy, event: type },
      });
    } catch (e) { console.warn(`${LOG} refund bell failed (non-blocking):`, e); }
  }

  await outcome("synced");
  return jsonResponse({ ok: true, status: next });
});

/** The Square payment id an event is about: payment.* carry object.payment, refund.* object.refund.payment_id, dispute.* object.dispute.disputed_payment.payment_id. */
function paymentIdOf(type: string, object: Rec): string | null {
  const payment = object.payment as Rec | undefined;
  if (payment && typeof payment.id === "string") return payment.id;
  const refund = object.refund as Rec | undefined;
  if (refund && typeof refund.payment_id === "string") return refund.payment_id;
  const dispute = object.dispute as Rec | undefined;
  const disputed = dispute?.disputed_payment as Rec | undefined;
  if (disputed && typeof disputed.payment_id === "string") return disputed.payment_id;
  if (type.startsWith("payment.") && typeof object.id === "string") return object.id;
  return null;
}
