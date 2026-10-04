import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { PaidyError, isPaidyPaymentId, paidy, type PaidyPayment } from "../_shared/paidy.ts";
import { adoptOrphanAuthorization } from "../_shared/paidy-filing.ts";
import { PAIDY_RECORD_FIELDS, paidyBellOnce, syncPaidyPayment } from "../_shared/paidy-sync.ts";
import { paidyProviderOutcome } from "../_shared/paidy-rules.ts";

/**
 * Paidy webhook receiver (2026-10-03, docs/PAIDY.md). PUBLIC endpoint
 * (verify_jwt = false): Paidy signs nothing, so NOTHING in the request body is
 * trusted. The body only names a payment id; the Hub then reads that payment
 * from Paidy with its own secret key and syncs what PAIDY says
 * (_shared/paidy-sync.ts).
 *
 * Integrity (2026-10-04, P05/P11/P12, docs/PAIDY.md "Integrity"):
 *   - every read and write is checked; a failure answers 5xx so Paidy retries
 *     (its retries back off for about 5 hours; a 200 stops them)
 *   - an id the Hub does not know is NOT ignored: Paidy says to rely on the
 *     webhook when the Checkout callback is lost, so an authorisation whose
 *     order_ref names an open order is FILED for staff to Confirm (owner Q3),
 *     released when the order can no longer take it, belled either way
 *   - a capture the Hub has not recorded rings paidy_captured_unrecorded
 *   - refunds are recorded in paidy_refunds and belled, never applied
 *
 * What it changes: paidy_payments.status / last_webhook_at / last_payload.
 * When Paidy reports a payment CLOSED that the Hub never captured (the
 * customer cancelled in MyPaidy, or Paidy's operations closed it), the live
 * submission is rejected with that note and the staff bell rings. Money is
 * never moved from here — capture and close happen only in
 * review-payment-submission.
 */
const LOG = "[paidy-webhook]";
/** How long the website callback gets before the webhook files an authorisation itself. */
const ORPHAN_GRACE_MS = 3 * 60 * 1000;

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
  try {
    const { data: row, error: rowErr } = await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("paidy_payment_id", id).maybeSingle();
    if (rowErr) throw rowErr;

    let payment: PaidyPayment;
    try {
      payment = await paidy.get(id);
    } catch (e) {
      console.error(`${LOG} paidy.get failed for ${id}:`, e);
      // 5xx makes Paidy retry later; a 4xx from Paidy is final for this id.
      return jsonResponse({ error: "paidy_unavailable" }, e instanceof PaidyError && e.status < 500 ? 200 : 502);
    }

    if (!row) {
      // The Checkout callback never reached the Hub (closed tab, lost
      // network): file it from Paidy's own read-back.
      const outcome = paidyProviderOutcome(payment);
      // Paidy notifies at once, usually BEFORE the customer's browser reports
      // back. Give the website callback its window: answer 503 so Paidy
      // retries later; by then a normal payment is already on file.
      const ageMs = Date.now() - (Date.parse(String(payment.created_at ?? "")) || 0);
      if (outcome === "authorized" && ageMs < ORPHAN_GRACE_MS) {
        return jsonResponse({ retry: "callback_window" }, 503);
      }
      if (outcome === "authorized") {
        const result = await adoptOrphanAuthorization(supabase, payment, "paidy_webhook");
        return jsonResponse({ ok: true, orphan: result });
      }
      if (outcome === "captured") {
        await paidyBellOnce(supabase, "paidy_captured_unrecorded", "Paidy took a payment the Hub has no record of",
          `${id} · ¥${Math.round(Number(payment.amount)).toLocaleString("en-US")} · order_ref "${String(payment.order?.order_ref ?? "")}" — captured on Paidy with no Hub record; check the Paidy dashboard`,
          { paidy_payment_id: id, order_ref: payment.order?.order_ref ?? null, source: "webhook" });
        return jsonResponse({ ok: true, orphan: "captured_unrecorded" });
      }
      return jsonResponse({ ok: true, ignored: `unknown_payment_${outcome}` });
    }

    const result = await syncPaidyPayment(supabase, row, payment, "webhook", event);
    return jsonResponse({ ok: true, status: result.status_after, outcome: result.outcome, flagged: result.flagged });
  } catch (e) {
    console.error(`${LOG} sync failed for ${id}:`, e);
    return jsonResponse({ error: "sync_failed" }, 500);
  }
});
