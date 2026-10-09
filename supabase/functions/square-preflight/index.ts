// square-preflight — D-SQV05 (owner 2026-10-09): the READ-ONLY production
// connection check, run by an admin from Website → Settings → Card payments
// while card payments are still OFF (or in test). docs/SQUARE.md "SQV".
//
// POST { environment?: "production" | "sandbox" }   (default production)
//   1. token  — GET /v2/locations with that environment's token;
//   2. the configured location id is one of the token's locations, ACTIVE, JPY
//      and JP (M2), the configured Application ID is of that environment's
//      family, and the environment's webhook signature key is set (F-14);
//   3. events — one Events API search, last 28 days.
// Writes ONE row: square_sync_state 'preflight:<env>' (the report + who + when).
// Never charges, never changes the mode, never shows anything to customers.
// Admin only (user_roles), a person only — no service-role path.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { square, SquareError, squareErrorKind } from "../_shared/square.ts";
import { squareAppIdFamily } from "../_shared/card-rules.ts";
import { type PreflightReport, preflightPassed, preflightStateOf, tokenSecretInUse, webhookKeyNames } from "../_shared/square-preflight-rules.ts";

const EVENTS_WINDOW_DAYS = 28;

function errFacts(e: unknown): { status: number | null; code: string | null; kind: string | null } {
  if (e instanceof SquareError) return { status: e.status, code: e.code, kind: e.kind };
  return { status: null, code: e instanceof Error ? e.message.slice(0, 120) : "error", kind: squareErrorKind(0, "", "") };
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  if (!ctx.user) return jsonResponse({ error: "a staff member must do this" }, 403);
  const { supabase } = ctx;
  try {
    const { data: roles, error: rErr } = await supabase.from("user_roles").select("role").eq("user_id", ctx.user.id);
    if (rErr) throw rErr;
    if (!((roles ?? []) as Array<{ role: string }>).some((r) => r.role === "admin")) return jsonResponse({ error: "admin_only" }, 403);

    const body = await req.json().catch(() => ({}));
    const env: "production" | "sandbox" = body?.environment === "sandbox" ? "sandbox" : "production";

    const { data: settings, error: sErr } = await supabase.from("system_settings").select("key, value")
      .in("key", ["square_app_id", "square_location_id"]);
    if (sErr) throw sErr;
    const setting = (k: string) => {
      const v = ((settings ?? []) as Array<{ key: string; value: unknown }>).find((r) => r.key === k)?.value;
      return typeof v === "string" ? v : v == null ? "" : String(v);
    };
    const appIdFamily = squareAppIdFamily(setting("square_app_id"));
    const locationConfigured = setting("square_location_id").trim() || null;

    const secret = tokenSecretInUse(env, (n) => (Deno.env.get(n)?.trim().length ?? 0) >= 20);
    const report: Omit<PreflightReport, "passed"> = {
      environment: env,
      token: { state: "not_configured", status: null, code: null, secret },
      locations: [], location_configured: locationConfigured, location_match: null, app_id_family: appIdFamily,
      events: { state: "not_configured", status: null, code: null, first_page: null, window_days: EVENTS_WINDOW_DAYS },
      location: null,
      webhook_key: webhookKeyNames(env).some((n) => (Deno.env.get(n)?.trim().length ?? 0) >= 10),
    };
    if (secret) {
      try {
        const locs = await square.listLocations(env);
        report.token = { state: "ok", status: 200, code: null, secret };
        report.locations = locs.map((l) => String(l.id ?? "")).filter((x) => x !== "");
        report.location_match = locationConfigured ? report.locations.includes(locationConfigured) : false;
        // M2 (QC 2026-10-09): that location must be ACTIVE, in yen, in Japan.
        const mine = locs.find((l) => String(l.id ?? "") === locationConfigured);
        report.location = mine ? {
          status: typeof mine.status === "string" ? mine.status : null,
          currency: typeof mine.currency === "string" ? mine.currency : null,
          country: typeof mine.country === "string" ? mine.country : null,
          // DOC-7 (go-live counter-check 2026-10-09): Square must have activated the
          // location for card payments (LocationCapability CREDIT_CARD_PROCESSING).
          card_processing: Array.isArray(mine.capabilities)
            ? (mine.capabilities as unknown[]).includes("CREDIT_CARD_PROCESSING")
            : false,
        } : null;
      } catch (e) {
        const f = errFacts(e);
        report.token = { state: preflightStateOf(f), status: f.status, code: f.code, secret };
      }
      if (report.token.state === "ok") {
        try {
          const end = new Date();
          const begin = new Date(end.getTime() - EVENTS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
          const page = await square.searchEvents(env, { types: ["payment.updated", "refund.updated"], beginTime: begin.toISOString(), endTime: end.toISOString() });
          report.events = { state: "ok", status: 200, code: null, first_page: page.events.length, window_days: EVENTS_WINDOW_DAYS };
        } catch (e) {
          const f = errFacts(e);
          report.events = { state: preflightStateOf(f), status: f.status, code: f.code, first_page: null, window_days: EVENTS_WINDOW_DAYS };
        }
      }
    }
    const full: PreflightReport = { ...report, passed: preflightPassed(report) };
    const stored = { ...full, at: new Date().toISOString(), by: ctx.user.id };
    const { error: wErr } = await supabase.from("square_sync_state")
      .upsert({ key: `preflight:${env}`, value: stored, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (wErr) throw wErr;
    return jsonResponse({ ok: true, report: stored });
  } catch (err) {
    console.error("[square-preflight] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
