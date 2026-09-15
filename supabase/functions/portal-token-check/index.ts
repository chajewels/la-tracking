// portal-token-check — daily "are customers about to lose their portal links?"
//
// Same shape as email-health-check (2026-09-13), deliberately: one report RPC,
// a verdict stored in system_settings for the Hub to read, and ONE cooled-down
// staff notification. Nothing here is a new pattern.
//
// WHY IT EXISTS. On 2026-09-15, 447 of 632 active portal tokens were within 30
// days of expiry — 195 on a single Sunday — and the Hub had no notification, no
// indicator and no cron watching expires_at. Staff would have learned about it
// from customer complaints.
//
// WHAT THE ALERT CARRIES, and what it does not. Counts and the PEAK DAY, never
// the customer list: the bell shows 20 notifications, so one alert naming
// hundreds of customers would bury every other thing staff need to see. The
// list lives behind the indicator (portal_tokens_expiring_list).
//
// Callers: pg_cron 'portal-token-check' (Vault service key, 00:55 UTC) and
// staff with the system_health permission ("Run check now"). Read-only apart
// from the settings row and the notification.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

const SETTING_KEY = "portal_token_status";
const ALERT_TYPE = "portal_tokens_expiring";
const ALERT_COOLDOWN_HOURS = 20;
const WINDOW_DAYS = 60;

/** Bands in rising severity. 'ok' and 'watch' never alert on their own. */
const BAND_RANK: Record<string, number> = { ok: 0, watch: 1, soon: 2, urgent: 3, expired: 4 };

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "system_health");
  if (denied) return denied;
  const { supabase } = ctx;

  try {
    const { data: report, error } = await supabase.rpc("portal_token_expiry_report", { p_days: WINDOW_DAYS });
    if (error) throw error;
    const r = (report ?? {}) as Record<string, unknown>;
    const status = String(r.status ?? "unknown");
    const bands = (r.bands ?? {}) as Record<string, number>;

    // What the previous run concluded, so a daily cron does not re-alert every
    // morning about a wall that is still two months away.
    const { data: prevRow } = await supabase
      .from("system_settings").select("value").eq("key", SETTING_KEY).maybeSingle();
    const prev = (prevRow?.value ?? {}) as Record<string, unknown>;
    const prevBand = String(prev.status ?? "unknown");

    const summary = {
      ...r,
      checked_at: new Date().toISOString(),
      checked_by: ctx.isService ? "cron" : (ctx.user?.email ?? ctx.user?.id ?? "staff"),
    };

    const { error: setErr } = await supabase.from("system_settings").upsert({
      key: SETTING_KEY,
      value: summary,
      description: "Daily portal-token expiry verdict written by portal-token-check (ok | watch | soon | urgent | expired).",
    }, { onConflict: "key" });
    if (setErr) console.warn("[portal-token-check] settings upsert failed:", setErr.message ?? setErr);

    // ALERT ON BAND CHANGE, not on every run. 60/30/14 are the steps, and a
    // token regenerated on warning resets clear of all of them, so a band that
    // has not moved is not news. The cooldown is the backstop for a band that
    // sits at 'urgent' for days.
    let alerted = false;
    const rank = BAND_RANK[status] ?? 0;
    const prevRank = BAND_RANK[prevBand] ?? -1;
    const worsened = rank > prevRank;
    const shouldConsider = rank >= BAND_RANK.soon || (rank >= BAND_RANK.watch && worsened);

    if (shouldConsider) {
      const since = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3600 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("staff_notifications").select("id")
        .eq("type", ALERT_TYPE).gte("created_at", since).limit(1);
      const cooledDown = !recent || recent.length === 0;

      if (worsened || cooledDown) {
        const peakDay = r.peak_day ? String(r.peak_day) : null;
        const peakCount = Number(r.peak_day_count ?? 0);
        const peakLive = Number(r.peak_day_with_live_plan ?? 0);
        const inWindow = Number(r.expiring_in_window ?? 0);
        const inWindowLive = Number(r.expiring_in_window_with_live_plan ?? 0);

        const title = status === "expired"
          ? "Portal links have expired"
          : status === "urgent"
          ? "Portal links expire within 14 days"
          : status === "soon"
          ? "Portal links expire within 30 days"
          : "Portal links expire within 60 days";

        // The peak day leads, because that is the sentence staff can act on:
        // "195 lapse on Sunday" schedules work, "447 within 30 days" does not.
        const peakSentence = peakDay && peakCount > 0
          ? `Worst single day: ${peakCount} on ${peakDay}${peakLive > 0 ? ` (${peakLive} mid-plan)` : ""}. `
          : "";
        const body = `${peakSentence}${inWindow} link${inWindow === 1 ? "" : "s"} lapse within ${WINDOW_DAYS} days, `
          + `${inWindowLive} of them held by customers with a layaway plan still running. `
          + `Bands: ${bands.d14 ?? 0} under 14 days, ${bands.d30 ?? 0} under 30, ${bands.d60 ?? 0} under 60`
          + `${(bands.expired ?? 0) > 0 ? `, ${bands.expired} already expired` : ""}. `
          + "Open CSR Monitoring → Portal links for the list.";

        const { error: nErr } = await supabase.from("staff_notifications").insert({
          type: ALERT_TYPE, title, body, metadata: summary,
        });
        if (nErr) console.warn("[portal-token-check] notification insert failed:", nErr.message ?? nErr);
        else alerted = true;
      }
    }

    console.log(JSON.stringify({
      portal_token_check: status, prev_band: prevBand,
      expiring: r.expiring_in_window, peak: r.peak_day_count,
      seen_ever: r.tokens_with_any_last_seen, alerted,
    }));
    return jsonResponse({ ok: true, ...summary, alerted, previous_status: prevBand });
  } catch (err) {
    console.error("[portal-token-check] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
