// web-payment-reminder-sweep — stage D payment reminders (docs/WEB-PAYMENT-REMINDERS.md).
//
// pg_cron 'web-payment-reminder-sweep' at :13 every hour (Vault service key;
// migration 20261004100000_web_payment_reminders.sql). Callers: the cron
// (service role) and staff with system_health (manual run).
//
// ONE transactional reminder before a confirmed WEB order's / web layaway's
// transfer deadline: 6h before a 24h deadline, 24h before a 72h one; at most 2
// per order (a moved deadline earns one more). Everything that decides WHO and
// WHEN is SQL:
//   web_payment_reminder_candidates  — the switch (off / owner_only / on), the
//                                      eligibility rule, oldest deadline first
//   claim_web_payment_reminder       — re-checks all of it under the order's
//                                      row lock and writes the ledger row, so a
//                                      proof uploaded, a payment confirmed, a
//                                      moved deadline or the switch turned off
//                                      in between wins; null = do not send
//   finish_web_payment_reminder      — records the outcome. Never retried.
// This function only renders and sends (_shared/payment-reminder-emails.ts).
//
// It reads NO consent, newsletter, cart-reminder or suppression record: the
// reminder is about the customer's own order. The 48h staff "last day" bell is
// NOT here — it is pure SQL on its own cron job, so it runs whatever this
// switch says (web_reservation_expiring_bells).

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendClaimedPaymentReminder } from "../_shared/payment-reminder-emails.ts";
import { readPaymentReminderMode, reminderFinishStatus } from "../_shared/web-payment-reminder-rules.ts";

type AnyRec = Record<string, unknown>;

const CANDIDATE_LIMIT = 50;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "system_health");
  if (denied) return denied;
  const { supabase } = ctx;
  const ranAt = new Date().toISOString();

  try {
    const { data: modeRow, error: modeErr } = await supabase
      .from("system_settings").select("value").eq("key", "web_payment_reminders_mode").maybeSingle();
    if (modeErr) throw modeErr;
    const mode = readPaymentReminderMode((modeRow as AnyRec | null)?.value);
    if (mode === "off") {
      const summary = { ok: true, ran_at: ranAt, mode, candidates: 0, sent: 0 };
      console.log(JSON.stringify({ web_payment_reminder_sweep: summary }));
      return jsonResponse(summary);
    }

    const { data: candidates, error: candErr } = await supabase.rpc("web_payment_reminder_candidates", {
      p_limit: CANDIDATE_LIMIT,
    });
    if (candErr) throw candErr;

    const results: AnyRec[] = [];
    for (const c of (candidates ?? []) as AnyRec[]) {
      const base = { entity_type: c.entity_type, entity_id: c.entity_id, reference: c.reference, deadline: c.deadline };
      const { data: claimId, error: claimErr } = await supabase.rpc("claim_web_payment_reminder", {
        p_entity_type: c.entity_type,
        p_entity_id: c.entity_id,
        p_deadline: c.deadline,
      });
      if (claimErr) {
        console.error("[web-payment-reminder-sweep] claim failed:", claimErr.message ?? claimErr);
        results.push({ ...base, outcome: "claim_error" });
        continue;
      }
      if (!claimId) {
        // Paid, proof uploaded, deadline moved, switch changed, or another run
        // took it — the SQL said no, so nothing is sent.
        results.push({ ...base, outcome: "not_claimed" });
        continue;
      }

      const res = await sendClaimedPaymentReminder(supabase, String(claimId), c.is_test === true);
      const status = reminderFinishStatus(res);
      const detail = res.sent ? null : [res.reason, "detail" in res ? res.detail : null].filter(Boolean).join(": ");
      const { error: finishErr } = await supabase.rpc("finish_web_payment_reminder", {
        p_id: claimId,
        p_status: status,
        p_detail: detail,
      });
      if (finishErr) console.error("[web-payment-reminder-sweep] finish failed:", finishErr.message ?? finishErr);
      results.push({ ...base, outcome: status, detail });
    }

    const summary = {
      ok: true,
      ran_at: ranAt,
      mode,
      candidates: results.length,
      sent: results.filter((r) => r.outcome === "sent").length,
      results,
    };
    console.log(JSON.stringify({ web_payment_reminder_sweep: summary }));
    return jsonResponse(summary);
  } catch (err) {
    console.error("[web-payment-reminder-sweep] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
