// cart-reminder-sweep — abandoned-cart reminders, stages A/B (docs/CART-REMINDERS.md).
//
// pg_cron 'cart-reminder-sweep' at :31 every hour (Vault service key;
// migration 20261021100000_cart_reminders.sql). Callers: the cron (service
// role) and staff with system_health (manual run).
//
// ONE PROMOTIONAL reminder per cart cycle, only to a customer who opted in.
// Everything that decides WHO and WHEN is SQL:
//   cart_reminder_candidates  — the switch (off / owner_only / on), consent,
//                               the test gate, suppression, idle time, no
//                               order since, once per cycle, 7 days between
//                               reminders, stock, local 09:00–19:59
//   claim_cart_reminder       — re-checks consent and the cycle under lock and
//                               writes the ledger row; null = do not send
//   finish_cart_reminder      — records the outcome. Never retried.
//   purge_stale_customer_carts — 90-day retention for saved lines, once a day.
// This function only renders and sends (_shared/cart-reminder-emails.ts).
//
// Stage B is a different EMAIL, not a different send: the candidate's
// quote_mode / quote_currency / quote_term pick the money form; the figures
// are recomputed from Hub code at send time.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendClaimedCartReminder } from "../_shared/cart-reminder-emails.ts";
import { cartReminderFinishStatus, readCartReminderMode } from "../_shared/cart-reminder-rules.ts";
import type { FxRate } from "../_shared/website-down-payments.ts";
import { hubFxRate } from "../_shared/php-jpy-rate.ts";

type AnyRec = Record<string, unknown>;

const CANDIDATE_LIMIT = 50;
/** The hourly run that also purges 90-day-old cart lines: 18:00 UTC = 03:00 JST. */
const PURGE_UTC_HOUR = 18;

/** The Hub's peso rate (system_settings.php_jpy_rate), as the website function reads it — ONE PESO RATE, 2026-10-03. */
// deno-lint-ignore no-explicit-any
async function latestFx(supabase: any): Promise<FxRate | null> {
  return await hubFxRate(supabase);
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "system_health");
  if (denied) return denied;
  // requireAuth hands back the service client, which the sweep needs: the
  // consent rows and the ledger are service-role only (RLS: staff may read,
  // nothing else writes). A staff manual run passed the permission check above.
  const { supabase } = ctx;
  const now = new Date();
  const ranAt = now.toISOString();

  try {
    const { data: settings, error: setErr } = await supabase
      .from("system_settings").select("key, value").in("key", ["cart_reminders_mode"]);
    if (setErr) throw setErr;
    const byKey = new Map(((settings ?? []) as AnyRec[]).map((s) => [String(s.key), s.value]));
    const mode = readCartReminderMode(byKey.get("cart_reminders_mode"));
    // WEBSITE ORDERS PR 10 (2026-10-01): every checkout is reserved first and
    // confirmed by staff — the "we reserve and confirm" sentence is always on.
    const reserveFirst = true;

    let purged: number | null = null;
    if (now.getUTCHours() === PURGE_UTC_HOUR) {
      const { data: n, error: purgeErr } = await supabase.rpc("purge_stale_customer_carts");
      if (purgeErr) console.error("[cart-reminder-sweep] purge failed:", purgeErr.message ?? purgeErr);
      else purged = Number(n ?? 0);
    }

    if (mode === "off") {
      const summary = { ok: true, ran_at: ranAt, mode, candidates: 0, sent: 0, purged };
      console.log(JSON.stringify({ cart_reminder_sweep: summary }));
      return jsonResponse(summary);
    }

    const { data: candidates, error: candErr } = await supabase.rpc("cart_reminder_candidates", {
      p_limit: CANDIDATE_LIMIT,
    });
    if (candErr) throw candErr;

    const fx = (candidates ?? []).length > 0 ? await latestFx(supabase) : null;
    const results: AnyRec[] = [];
    for (const c of (candidates ?? []) as AnyRec[]) {
      const base = { customer_id: c.customer_id, cycle_id: c.cycle_id, lang: c.lang, quote_mode: c.quote_mode ?? null };
      const { data: claimId, error: claimErr } = await supabase.rpc("claim_cart_reminder", {
        p_customer_id: c.customer_id,
        p_cycle_id: c.cycle_id,
        p_email: c.email,
        p_lang: c.lang,
        p_items: c.items,
      });
      if (claimErr) {
        console.error("[cart-reminder-sweep] claim failed:", claimErr.message ?? claimErr);
        results.push({ ...base, outcome: "claim_error" });
        continue;
      }
      if (!claimId) {
        // Consent withdrawn, the cart moved on to a new cycle, or another run
        // took it — the SQL said no, so nothing is sent.
        results.push({ ...base, outcome: "not_claimed" });
        continue;
      }

      const res = await sendClaimedCartReminder(
        supabase,
        String(claimId),
        { quote_mode: c.quote_mode, quote_currency: c.quote_currency, quote_term: c.quote_term },
        { reserveFirst, fx },
      );
      const status = cartReminderFinishStatus(res);
      const detail = res.sent ? null : [res.reason, "detail" in res ? res.detail : null].filter(Boolean).join(": ");
      const { error: finishErr } = await supabase.rpc("finish_cart_reminder", {
        p_id: claimId,
        p_status: status,
        p_detail: detail,
      });
      if (finishErr) console.error("[cart-reminder-sweep] finish failed:", finishErr.message ?? finishErr);
      results.push({ ...base, outcome: status, detail });
    }

    const summary = {
      ok: true,
      ran_at: ranAt,
      mode,
      reserve_first: reserveFirst,
      fx_as_of: fx?.as_of ?? null,
      candidates: results.length,
      sent: results.filter((r) => r.outcome === "sent").length,
      purged,
      results,
    };
    console.log(JSON.stringify({ cart_reminder_sweep: summary }));
    return jsonResponse(summary);
  } catch (err) {
    console.error("[cart-reminder-sweep] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
