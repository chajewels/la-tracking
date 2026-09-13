import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * One durable record per email attempt, from every sender.
 *
 * The 2026-09-04 → 2026-09-13 outage (every runtime send refused with 400
 * missing_unsubscribe) ran unnoticed for nine days because the direct send
 * helper wrote nothing to email_send_log and the storefront helper logged only
 * to the function log, which retains minutes. Both helpers now call
 * recordEmailAttempt() on every outcome, so email_delivery_report() and the
 * daily email-health-check can see attempts, and the FIRST refusal in a day
 * raises a staff notification immediately.
 *
 * Never throws: logging must not change the outcome of the send.
 */

export type EmailAttemptStatus = "sent" | "failed" | "suppressed";

export interface EmailAttempt {
  channel: "hub" | "storefront";
  /** Template name (Hub) or label (storefront), e.g. "payment-confirmed". */
  template: string;
  recipient: string;
  status: EmailAttemptStatus;
  idempotencyKey?: string | null;
  error?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface EmailErrorInfo {
  type: string | null;
  requestId: string | null;
  message: string;
}

/** Pull type / request_id out of a Lovable EmailAPIError (or any error). */
export function describeEmailError(err: unknown): EmailErrorInfo {
  const message = (err as Error)?.message ?? String(err ?? "");
  const code = (err as { code?: unknown })?.code;
  let type: string | null = typeof code === "string" ? code : null;
  let requestId: string | null = null;
  const m = message.match(/"request_id"\s*:\s*"([^"]+)"/);
  if (m) requestId = m[1];
  if (!type) {
    const t = message.match(/"type"\s*:\s*"([^"]+)"/);
    if (t) type = t[1];
  }
  const body = (err as { body?: unknown })?.body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (!type && typeof b.type === "string") type = b.type;
    if (!requestId && typeof b.request_id === "string") requestId = b.request_id;
  }
  return { type, requestId, message: message.slice(0, 1000) };
}

// deno-lint-ignore no-explicit-any
function serviceClient(): any | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

const ALERT_TYPE = "email_send_refused";
const ALERT_COOLDOWN_HOURS = 24;

/**
 * Staff bell the first time a send is refused in a 24-hour window. Later
 * refusals in the same window are logged but not re-alerted; the daily
 * email-health-check repeats the alert while the outage lasts.
 */
// deno-lint-ignore no-explicit-any
async function alertFirstRefusal(supabase: any, a: EmailAttempt, info: EmailErrorInfo) {
  try {
    const since = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("staff_notifications")
      .select("id")
      .eq("type", ALERT_TYPE)
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return;
    const domain = a.recipient.includes("@") ? a.recipient.split("@")[1] : "?";
    await supabase.from("staff_notifications").insert({
      type: ALERT_TYPE,
      title: "Customer emails are being refused",
      body: `${a.template} (${a.channel}) to ***@${domain} was refused${info.type ? ` — ${info.type}` : ""}${info.requestId ? ` (request_id ${info.requestId})` : ""}. Check Settings → General → Email delivery. Every refusal is logged in email_send_log.`,
      metadata: { channel: a.channel, template: a.template, error_type: info.type, request_id: info.requestId, message: info.message.slice(0, 500) },
    });
  } catch (e) {
    console.warn("[email-log] first-refusal alert failed (non-blocking):", e);
  }
}

export async function recordEmailAttempt(a: EmailAttempt): Promise<void> {
  try {
    const supabase = serviceClient();
    if (!supabase) return;
    const info = a.status === "failed" ? describeEmailError(a.error) : null;
    const { error } = await supabase.from("email_send_log").insert({
      template_name: a.template,
      recipient_email: a.recipient,
      status: a.status,
      error_message: info ? `Email API error: ${info.message}` : null,
      request_id: info?.requestId ?? null,
      channel: a.channel,
      // The partial unique index on idempotency_key covers pending/sent rows;
      // a legitimate duplicate (SDK dedupe) must not fail the insert, so the
      // key is stored only on non-sent rows.
      idempotency_key: a.status === "sent" ? null : (a.idempotencyKey ?? null),
      metadata: { ...(a.metadata ?? {}), idempotency_key: a.idempotencyKey ?? null },
    });
    if (error) console.warn("[email-log] insert failed (non-blocking):", error.message ?? error);
    if (a.status === "failed" && info) await alertFirstRefusal(supabase, a, info);
  } catch (e) {
    console.warn("[email-log] record failed (non-blocking):", e);
  }
}
