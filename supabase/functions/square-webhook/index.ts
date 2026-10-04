import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { verifySquareSignature } from "../_shared/square.ts";
import { eventObjectId, processSquareEvent, rpc } from "../_shared/square-sync.ts";

/**
 * Square webhook receiver — a DURABLE INBOX (integrity 2026-10-04, SQ01–SQ03;
 * docs/SQUARE.md, docs/SQUARE-INTEGRITY.md). PUBLIC endpoint (verify_jwt =
 * false) — but every delivery is SIGNED: Square sends
 * base64(HMAC-SHA256(signature_key, notification_url + raw_body)) in
 * x-square-hmacsha256-signature (sandbox and production keys are both tried).
 * An unsigned or mis-signed body is 401 and touches nothing.
 *
 * Flow:
 *   1. store the verified event (square_webhook_events, idempotent on event_id)
 *      and ANSWER 200 at once (QC09 — Square's 10-second window); a receipt
 *      that cannot be stored answers 500 so Square redelivers;
 *   2. in the background: claim it (claim_square_event — a lease, so two
 *      deliveries never process it at once);
 *   3. process it through _shared/square-sync.ts: the Hub RE-READS the payment
 *      / refund / dispute from Square with its own token and applies what
 *      SQUARE says, every write an atomic, checked RPC;
 *   4. finish it (done | ignored | quarantined | failed with a retry time).
 * Square no longer redelivers an event it got 200 for, so a failed or
 * quarantined event is retried by square-reconcile at its next hourly run
 * (minute :53) and then on its backoff; 12 failures → dead + bell. A
 * duplicate delivery is stored once and processed once.
 * Money is never moved from here — capture and void happen only in
 * review-payment-submission (and a fraud/mismatch void in square-sync).
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
  if (!eventId) return jsonResponse({ ok: true, ignored: "no_event_id" });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1. Durable receipt — the only work done before answering. A receipt that
  //    cannot be stored answers 500, so Square redelivers.
  try {
    const { kind, id } = eventObjectId(body);
    const { error: insErr } = await supabase.from("square_webhook_events").upsert(
      { event_id: eventId, event_type: type, payment_id: kind === "payment" ? id : null, object_id: id, payload: body },
      { onConflict: "event_id", ignoreDuplicates: true },
    );
    if (insErr) throw new Error(`square_webhook_events insert: ${insErr.message}`);
  } catch (e) {
    console.error(LOG, eventId, type, "receipt failed", e);
    return jsonResponse({ ok: false, error: "receipt_failed" }, 500);
  }

  // 2–4. Claim, process, finish — AFTER the answer (QC09, 2026-10-05): Square
  //    expects an answer within 10 s, and processing reads Square back (up to
  //    3 tries × 15 s). The stored row is the guarantee: an event whose
  //    background run fails, times out or is cut stays 'received' / 'failed'
  //    and square-reconcile picks it up at its next hourly run.
  const work = processStored(supabase, eventId, type, body);
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(work);
    return jsonResponse({ ok: true, status: "received" });
  }
  // No background runtime (local tests): process inline, same as before.
  const r = await work;
  return jsonResponse({ ok: true, status: r });
});

/** Claims, processes and finishes one stored event. Never throws. */
async function processStored(supabase: ReturnType<typeof createClient>, eventId: string, type: string, body: Rec): Promise<string> {
  try {
    const claim = await rpc(supabase, "claim_square_event", { p_event_id: eventId, p_lease_seconds: 120 });
    if (!claim.claimed) return String(claim.status ?? "not_claimed"); // finished already, or another worker holds it
    const result = await processSquareEvent(supabase, body);
    const fin = await rpc(supabase, "finish_square_event", {
      p_event_id: eventId, p_status: result.status, p_outcome: result.outcome, p_error: result.error ?? null, p_retry_seconds: 300,
    });
    if (fin.error) throw new Error(`finish_square_event: ${fin.error}`);
    if (result.status === "failed" || result.status === "quarantined") {
      console.warn(LOG, eventId, type, result.status, result.error ?? result.outcome);
    }
    return result.status;
  } catch (e) {
    // The row stays claimable (lease expires); square-reconcile retries it.
    console.error(LOG, eventId, type, "background processing failed", e);
    return "failed";
  }
}
