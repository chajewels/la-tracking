/**
 * Owner 2026-10-04: staff capture in Paidy's merchant dashboard and the Hub
 * records it by itself. This calls the ONE recording path —
 * review-payment-submission, action "confirmed", actor "paidy_auto" — with the
 * service role, so the automatic recording gets exactly what a staff Confirm
 * gets (Paidy read back first, exact yen, finalize RPC, receipt, emails,
 * loyalty, payment tracking). review-payment-submission accepts the service
 * role ONLY for this actor and ONLY on a Paidy submission whose payment Paidy
 * reports captured.
 */
import type { RecordResult } from "./paidy-sync.ts";

export const PAIDY_AUTO_ACTOR = "paidy_auto";
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * review-payment-submission runs with verify_jwt = false, so a Bearer token
 * alone proves nothing there (anyone can write an unsigned JWT that SAYS
 * role service_role). The recorder therefore signs each call: HMAC-SHA256 over
 * "<submission_id>.<timestamp>" keyed with the service-role key, which only
 * edge functions hold. A forged request cannot produce it; a captured one is
 * useless after 5 minutes and only for that submission.
 */
async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function paidyAutoSignature(submissionId: string, ts: string, key: string): Promise<string> {
  return await hmacHex(key, `${submissionId}.${ts}`);
}

/** Constant-time check of the recorder's signature; false on anything missing, stale or wrong. */
export async function verifyPaidyAutoSignature(submissionId: unknown, ts: string | null, sig: string | null, key: string | undefined, now = Date.now()): Promise<boolean> {
  if (!key || typeof submissionId !== "string" || !ts || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_WINDOW_MS) return false;
  const want = await paidyAutoSignature(submissionId, ts, key);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export async function paidyAutoRecord(submissionId: string, timeoutMs = 20_000): Promise<RecordResult> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, status: 500, error: "not_configured" };
  try {
    const ts = String(Date.now());
    const res = await fetch(`${url}/functions/v1/review-payment-submission`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Authorization": `Bearer ${key}`, "Content-Type": "application/json",
        "x-paidy-auto-ts": ts, "x-paidy-auto-sig": await paidyAutoSignature(submissionId, ts, key),
      },
      body: JSON.stringify({ submission_id: submissionId, action: "confirmed", actor: PAIDY_AUTO_ACTOR }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    // already_recorded counts as success: the payment is in the books once.
    const ok = res.ok && (body.success === true || body.already_recorded === true);
    // 409 = another recording owns it right now, or the recorder refused and
    // opened its own case (refund / amount): not a new failure to report.
    const handled = !ok && res.status === 409;
    return {
      ok, handled, status: res.status,
      error: ok ? undefined : String(body.error ?? body.code ?? `http_${res.status}`),
      message: ok ? undefined : (typeof body.message === "string" ? body.message : undefined),
    };
  } catch (e) {
    // A timeout is not a failure of the recording (it may still finish); the
    // next sync reads the submission and sees whether it was recorded.
    return { ok: false, status: 504, error: "record_call_failed", message: e instanceof Error ? e.message : String(e) };
  }
}
