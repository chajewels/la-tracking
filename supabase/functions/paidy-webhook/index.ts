import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { processPaidyEvent } from "../_shared/paidy-events.ts";
import { isPaidyPaymentId } from "../_shared/paidy.ts";
import { isPaidyWebhookIp, paidyWebhookIpCheckOn } from "../_shared/paidy-rules.ts";

/**
 * Paidy webhook receiver (docs/PAIDY.md). PUBLIC endpoint (verify_jwt =
 * false): Paidy signs nothing, so NOTHING in the request body is trusted. The
 * body only names a payment id; the Hub reads that payment from Paidy with its
 * own secret key and syncs what PAIDY says (_shared/paidy-events.ts).
 *
 * Follow-up 2026-10-04 (R08/R09):
 *   1. The notification is stored in paidy_webhook_events BEFORE anything
 *      else; if that write fails the answer is 500 and Paidy retries.
 *   2. Processing then gets a hard deadline (Paidy wants its 200 within 10 s;
 *      every Paidy call has its own 6 s timeout). Past the deadline the answer
 *      is 200 anyway — the event is safe in the inbox and paidy-reconcile
 *      finishes it; a late finish here is harmless (every step is idempotent).
 *   3. A capture Paidy reports and the Hub has not recorded is RECORDED
 *      automatically (owner: staff capture in the Paidy dashboard).
 *   4. A Paidy credential/configuration failure is answered 5xx (Paidy
 *      retries); an id Paidy does not know becomes a durable case.
 *
 * H9 (2026-10-06): SOURCE IP. Paidy publishes the 5 IPs it sends from
 * (https://paidy.com/docs/en/webhook.html; list in PAIDY_WEBHOOK_IPS). A
 * request whose first x-forwarded-for entry is not one of them is answered
 * 200 { ignored: true } and NOTHING happens — no inbox row, no Paidy call, no
 * case, no bell — so a stranger posting random ids cannot spam the staff bell.
 * Edge secret PAIDY_WEBHOOK_IP_CHECK=off disables the check without a deploy.
 */
const PROCESS_DEADLINE_MS = 8000;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (paidyWebhookIpCheckOn(Deno.env.get("PAIDY_WEBHOOK_IP_CHECK")) && !isPaidyWebhookIp(req.headers.get("x-forwarded-for"))) {
    return jsonResponse({ ok: true, ignored: true });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return jsonResponse({ error: "bad_json" }, 400); }
  const id = body.payment_id ?? body.id;
  if (!isPaidyPaymentId(id)) return jsonResponse({ ok: true, ignored: "no_payment_id" });
  // Paidy's body: { payment_id, status: "authorize_success" | "close_success" |
  // "update_success" | "capture_success" | "refund_success", … }. Label only.
  const event = String(body.status ?? body.event ?? "").slice(0, 40);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: inbox, error: inboxErr } = await supabase
    .from("paidy_webhook_events").insert({ paidy_payment_id: id, event }).select("id").single();
  if (inboxErr || !inbox) {
    console.error("[paidy-webhook] inbox insert failed:", inboxErr);
    return jsonResponse({ error: "inbox_unavailable" }, 500);
  }

  const work = processPaidyEvent(supabase, String(inbox.id), id, event, "webhook");
  const timeout = new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), PROCESS_DEADLINE_MS));
  const result = await Promise.race([work, timeout]);
  if (result === "deadline") {
    work.catch((e) => console.error("[paidy-webhook] late processing failed (the sweep retries):", e));
    return jsonResponse({ ok: true, queued: true });
  }
  if (result.retry_callback_window) return jsonResponse({ retry: "callback_window" }, 503);
  if (result.retry_provider) return jsonResponse({ error: "paidy_unavailable" }, 502);
  // A failed write: the event stays in the inbox for the sweep AND Paidy is
  // asked to retry (5xx), whichever comes first finishes it.
  if (!result.done) return jsonResponse({ error: result.error ?? "sync_failed" }, 500);
  return jsonResponse({ ok: true, ...result.summary });
});
