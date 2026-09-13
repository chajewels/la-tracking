// email-health-check — daily "are customer emails actually going out?" check.
//
// Compares the emails the Hub SHOULD have sent in the last 24 hours (payments
// confirmed, reminders generated, penalties, waivers, loyalty events, web
// orders…) with the attempts accepted / refused in email_send_log, stores the
// verdict in system_settings.email_health_status (the Hub reads it for the
// sidebar pill and the dashboard banner), and raises a staff notification
// whenever the verdict is not 'ok'. Complements the per-send first-refusal
// alert in _shared/email-log.ts.
//
// Callers: pg_cron 'email-health-check' (Vault service key, 00:50 UTC) and
// staff with the system_health permission ("Run check now" in Settings).
// Read-only apart from the settings row and the notification.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

const SETTING_KEY = "email_health_status";
const ALERT_TYPE = "email_delivery_outage";
const ALERT_COOLDOWN_HOURS = 20;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "system_health");
  if (denied) return denied;
  const { supabase } = ctx;

  try {
    const { data: report, error } = await supabase.rpc("email_delivery_report", { p_hours: 24 });
    if (error) throw error;
    const r = (report ?? {}) as Record<string, unknown>;
    const status = String(r.status ?? "unknown");
    const checkedAt = new Date().toISOString();

    const summary = {
      status,
      checked_at: checkedAt,
      window_hours: 24,
      expected_total: Number(r.expected_total ?? 0),
      expected: r.expected ?? {},
      sent: Number(r.sent ?? 0),
      failed: Number(r.failed ?? 0),
      suppressed: Number(r.suppressed ?? 0),
      storefront: r.storefront ?? { sent: 0, failed: 0 },
      last_sent_at: r.last_sent_at ?? null,
      refusal_streak_started_at: r.refusal_streak_started_at ?? null,
      newest_error: r.newest_error ?? null,
      newest_request_id: r.newest_request_id ?? null,
      checked_by: ctx.isService ? "cron" : (ctx.user?.email ?? ctx.user?.id ?? "staff"),
    };

    const { error: setErr } = await supabase
      .from("system_settings")
      .upsert({ key: SETTING_KEY, value: summary, description: "Daily email delivery verdict written by email-health-check (ok | degraded | refused | silent)." }, { onConflict: "key" });
    if (setErr) console.warn("[email-health-check] settings upsert failed:", setErr.message ?? setErr);

    let alerted = false;
    if (status !== "ok") {
      const since = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3600 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("staff_notifications")
        .select("id")
        .eq("type", ALERT_TYPE)
        .gte("created_at", since)
        .limit(1);
      if (!recent || recent.length === 0) {
        const streak = summary.refusal_streak_started_at
          ? ` Refused since ${String(summary.refusal_streak_started_at).slice(0, 16).replace("T", " ")} UTC.`
          : "";
        const title = status === "refused"
          ? "Customer emails are being refused"
          : status === "silent"
          ? "No customer email attempts were logged"
          : "Some customer emails were refused";
        const body = `Last 24h: ${summary.expected_total} emails expected, ${summary.sent} accepted, ${summary.failed} refused, ${summary.suppressed} suppressed.${streak}${summary.newest_request_id ? ` Newest request_id ${summary.newest_request_id}.` : ""} Open Settings → General → Email delivery.`;
        const { error: nErr } = await supabase.from("staff_notifications").insert({
          type: ALERT_TYPE,
          title,
          body,
          metadata: summary,
        });
        if (nErr) console.warn("[email-health-check] notification insert failed:", nErr.message ?? nErr);
        else alerted = true;
      }
    }

    console.log(JSON.stringify({ email_health_check: status, expected: summary.expected_total, sent: summary.sent, failed: summary.failed, alerted }));
    return jsonResponse({ ok: true, ...summary, alerted });
  } catch (err) {
    console.error("[email-health-check] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
