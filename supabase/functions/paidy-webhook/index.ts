import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { claimPaidyEvent, processPaidyEvent } from "../_shared/paidy-events.ts";
import { isPaidyPaymentId } from "../_shared/paidy.ts";
import { PAIDY_WEBHOOK_UNRECOGNISED_PER_MINUTE, paidyWebhookIpCheckOn, paidyWebhookSource } from "../_shared/paidy-rules.ts";

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
 *
 * M5 (Paidy QC 2026-10-09): a source is recognised only when EVERY address
 * the request carries (cf-connecting-ip and the last x-forwarded-for hop) is
 * one of Paidy's, so forging one header is not enough; both are stored on the
 * inbox row (source_ip) as evidence. Unrecognised deliveries are capped at
 * PAIDY_WEBHOOK_UNRECOGNISED_PER_MINUTE a minute: above it the answer is 429
 * with nothing stored and no Paidy call (Paidy retries a real one 15 times
 * over ~5 hours). L9: a late finish runs under EdgeRuntime.waitUntil.
 */
const PROCESS_DEADLINE_MS = 8000;
/** PA14: however slow the inbox insert was, processing still gets this much before the 200 goes out. */
const MIN_PROCESS_BUDGET_MS = 1500;

Deno.serve(async (req) => {
  // PA14 (2026-10-08): Paidy's 10 s clock starts when the request arrives, so
  // the processing budget is measured from RECEIPT — the inbox insert and the
  // claim come out of it, never on top of it.
  const receivedAt = Date.now();
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const source = paidyWebhookSource(req.headers);
  const recognisedSource = !paidyWebhookIpCheckOn(Deno.env.get("PAIDY_WEBHOOK_IP_CHECK")) || source.recognised;
  if (!recognisedSource) console.warn("[paidy-webhook] unrecognised source", source.ips);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return jsonResponse({ error: "bad_json" }, 400); }
  const id = body.payment_id ?? body.id;
  if (!isPaidyPaymentId(id)) return jsonResponse({ ok: true, ignored: "no_payment_id" });
  // Paidy's body: { payment_id, status: "authorize_success" | "close_success" |
  // "update_success" | "capture_success" | "refund_success", … }. Label only.
  const event = String(body.status ?? body.event ?? "").slice(0, 40);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!recognisedSource) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { count, error: capErr } = await supabase.from("paidy_webhook_events")
      .select("id", { count: "exact", head: true }).eq("source_recognised", false).gte("received_at", since);
    if (!capErr && (count ?? 0) >= PAIDY_WEBHOOK_UNRECOGNISED_PER_MINUTE) {
      console.warn("[paidy-webhook] unrecognised deliveries over the per-minute cap — 429", source.ips);
      return jsonResponse({ error: "rate_limited" }, 429);
    }
  }
  const { data: inbox, error: inboxErr } = await supabase
    .from("paidy_webhook_events").insert({ paidy_payment_id: id, event, source_ip: source.ips, source_recognised: recognisedSource })
    .select("id").single();
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
  const budgetMs = Math.max(MIN_PROCESS_BUDGET_MS, PROCESS_DEADLINE_MS - (Date.now() - receivedAt));
  const timeout = new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), budgetMs));
  const result = await Promise.race([work, timeout]);
  if (result === "deadline") {
    const late = work.catch((e) => console.error("[paidy-webhook] late processing failed (the sweep retries):", e));
    // L9: keep the isolate alive for the late finish where the runtime allows.
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (rt && typeof rt.waitUntil === "function") rt.waitUntil(late);
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
