/**
 * STAFF BELL EMAILS (V11b, owner 2026-10-08).
 *
 * Sends the Hub bells listed in system_settings.staff_bell_email_types as
 * emails to the configured recipients (Brenda + every admin — resolved in SQL
 * at bell time, frozen in staff_bell_emails). Called by the fan-out trigger
 * right after a bell is written (staff_bell_emails_wake, Vault key) and by the
 * hourly cron 'staff-bell-emails-sweep' (:16) as the fallback.
 *
 * - One email per (bell, recipient), idempotency key
 *   staff-bell-<bell id>-<recipient>: a retry re-uses the key, never twice.
 * - Outcomes go back through finish_staff_bell_email: sent / skipped
 *   (recipient suppressed) / retry (3 attempts, then failed).
 * - Every attempt is logged by sendTemplateEmail (email_send_log).
 * - Service-role callers only (cron / trigger) or a signed-in user with
 *   system_health. Never a customer email; English only.
 */
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import {
  type ClaimedBellEmail, staffBellEmailKey, staffBellFinishOutcome, staffBellHubUrl, staffBellWhen,
} from "../_shared/staff-bell-email-rules.ts";

const CLAIM_LIMIT = 20;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "system_health");
  if (denied) return denied;
  const { supabase } = ctx;
  const ranAt = new Date().toISOString();
  const summary = { ok: true, ran_at: ranAt, claimed: 0, sent: 0, skipped: 0, retried: 0, errors: [] as string[] };

  try {
    const { data, error } = await supabase.rpc("claim_staff_bell_emails", { p_limit: CLAIM_LIMIT });
    if (error) throw error;
    const rows = (data ?? []) as ClaimedBellEmail[];
    summary.claimed = rows.length;

    for (const b of rows) {
      let outcome: "sent" | "skipped" | "retry" = "retry";
      let detail: string | null = null;
      try {
        const r = await sendTemplateEmail("staff-bell", b.recipient, {
          idempotencyKey: staffBellEmailKey(b.bell_id, b.recipient),
          templateData: {
            title: b.title, body: b.body, bellType: b.bell_type, invoiceNumber: b.invoice_number,
            when: staffBellWhen(b.bell_created_at), hubUrl: staffBellHubUrl(b),
          },
        });
        outcome = staffBellFinishOutcome(r);
        if (!r.sent) detail = r.reason;
      } catch (e) {
        outcome = "retry";
        detail = e instanceof Error ? e.message : String(e);
        summary.errors.push(`${b.bell_type} ${b.recipient.replace(/^(.).*@/, "$1***@")}: ${detail}`);
      }
      if (outcome === "sent") summary.sent++; else if (outcome === "skipped") summary.skipped++; else summary.retried++;
      const fin = await supabase.rpc("finish_staff_bell_email", {
        p_bell_id: b.bell_id, p_recipient: b.recipient, p_outcome: outcome, p_error: detail,
      });
      if (fin.error) summary.errors.push(`finish ${b.bell_id}: ${fin.error.message}`);
    }
  } catch (e) {
    summary.ok = false;
    summary.errors.push(e instanceof Error ? e.message : String(e));
  }
  console.log(JSON.stringify({ staff_bell_emails: summary }));
  return jsonResponse(summary, summary.ok ? 200 : 500);
});
