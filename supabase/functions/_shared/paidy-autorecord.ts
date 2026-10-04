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

export async function paidyAutoRecord(submissionId: string, timeoutMs = 20_000): Promise<RecordResult> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return { ok: false, status: 500, error: "not_configured" };
  try {
    const res = await fetch(`${url}/functions/v1/review-payment-submission`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ submission_id: submissionId, action: "confirmed", actor: PAIDY_AUTO_ACTOR }),
    });
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    // already_recorded counts as success: the payment is in the books once.
    const ok = res.ok && (body.success === true || body.already_recorded === true);
    return {
      ok, status: res.status,
      error: ok ? undefined : String(body.error ?? body.code ?? `http_${res.status}`),
      message: ok ? undefined : (typeof body.message === "string" ? body.message : undefined),
    };
  } catch (e) {
    // A timeout is not a failure of the recording (it may still finish); the
    // next sync reads the submission and sees whether it was recorded.
    return { ok: false, status: 504, error: "record_call_failed", message: e instanceof Error ? e.message : String(e) };
  }
}
