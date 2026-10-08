import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { claimPaidyEvent, processPaidyEvent } from "../_shared/paidy-events.ts";
import { isPaidyPaymentId } from "../_shared/paidy.ts";
import { isPaidyWebhookIp, paidyWebhookIpCheckOn, paidyWebhookSourceIp } from "../_shared/paidy-rules.ts";

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
 * H9 (2026-10-06): SOFT SOURCE CHECK (controller ruling R14). Every delivery
 * is processed exactly as before — a dropped real webhook would be
 * unrecoverable for an authorisation the Hub does not know (P12). The source
 * (cf-connecting-ip, else the LAST x-forwarded-for entry) is compared with
 * Paidy's 5 published IPs (https://paidy.com/docs/en/webhook.html;
 * PAIDY_WEBHOOK_IPS) and decides ONE thing: whether an id Paidy does not know
 * may open a provider_unreadable case + staff bell. Unrecognised → no case, no
 * bell, a warning with the IP only. Edge secret PAIDY_WEBHOOK_IP_CHECK=off
 * treats every source as recognised.
 */
const PROCESS_DEADLINE_MS = 8000;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const sourceIp = paidyWebhookSourceIp(req.headers);
  const recognisedSource = !paidyWebhookIpCheckOn(Deno.env.get("PAIDY_WEBHOOK_IP_CHECK")) || isPaidyWebhookIp(sourceIp);
  if (!recognisedSource) console.warn("[paidy-webhook] unrecognised source", sourceIp);

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

  // PA09: the row is CLAIMED before any work (5-minute lease) so the sweep
  // never processes the same notification at the same time as a late finish
  // here. A lost claim is impossible for a row just inserted, but it is the
  // same gate every worker passes.
  if (!(await claimPaidyEvent(supabase, String(inbox.id), "webhook"))) return jsonResponse({ ok: true, queued: true, claimed_elsewhere: true });
  const work = processPaidyEvent(supabase, String(inbox.id), id, event, "webhook", 0, { recognisedSource });
  const timeout = new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), PROCESS_DEADLINE_MS));
  const result = await Promise.race([work, timeout]);
  if (result === "deadline") {
    work.catch((e) => console.error("[paidy-webhook] late processing failed (the sweep retries):", e));
    return jsonResponse({ ok: true, queued: true });
  }
  if (result.retry_callback_window) return jsonResponse({ retry: "callback_window" }, 503);
  if (result.retry_provider) return jsonResponse({ error: "paidy_unavailable" }, 502);
  // A failed write: the event stays in the inbox for the sweep AND Paidy is
  // asked to retry (5xx), whichever comes first finishes it. PA09: a failed
  // bookkeeping write on a finished event is answered 500 too — Paidy's
  // retry re-runs the idempotent processing and re-attempts the write.
  if (!result.done) return jsonResponse({ error: result.error ?? "sync_failed" }, 500);
  if ((result.writes_failed ?? 0) > 0) return jsonResponse({ error: "inbox_write_failed", ...result.summary }, 500);
  return jsonResponse({ ok: true, ...result.summary });
});
