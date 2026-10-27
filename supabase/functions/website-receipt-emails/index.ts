// website-receipt-emails — the "receipt ready" email for website receipts
// (docs/RECEIPTS.md).
//
// pg_cron 'website-receipt-emails' every 10 minutes (Vault service key;
// migration 20270216100000_website_receipts.sql). Callers: the cron (service
// role) and staff with system_health (manual run).
//
// Receipts are issued by SQL (deferred triggers → web_receipt_sync), where no
// email can be sent; this sweep sends the email afterwards:
//   website_receipt_email_candidates  issued, not yet emailed, < 5 attempts,
//                                     issued in the last 7 days, oldest first
//   finish_website_receipt_email      sent (or a skip that will never change:
//                                     no address, test customer, suppressed)
//                                     → email_sent_at; else attempts + 1
// A receipt cancelled before its email goes is never emailed. Sending goes
// through sendStorefrontEmail, whose idempotency key (receipt-ready-<id>)
// dedupes a retry of the same receipt.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendReceiptReadyEmail } from "../_shared/receipt-email.ts";

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
    const { data: candidates, error: candErr } = await supabase.rpc("website_receipt_email_candidates", {
      p_limit: CANDIDATE_LIMIT,
    });
    if (candErr) throw candErr;

    const results: AnyRec[] = [];
    for (const c of (candidates ?? []) as AnyRec[]) {
      const base = { receipt_id: c.id, receipt_number: c.receipt_number, kind: c.kind };
      const out = await sendReceiptReadyEmail(supabase, String(c.id));
      const detail = out.done ? (out.sent ? null : out.reason ?? null) : [out.reason, out.detail].filter(Boolean).join(": ");
      const { error: finishErr } = await supabase.rpc("finish_website_receipt_email", {
        p_id: c.id,
        p_sent: out.done,
        p_error: out.done ? null : detail,
      });
      if (finishErr) console.error("[website-receipt-emails] finish failed:", finishErr.message ?? finishErr);
      results.push({ ...base, outcome: out.done ? (out.sent ? "sent" : `skipped_${out.reason}`) : "failed", detail });
    }

    const summary = {
      ok: true,
      ran_at: ranAt,
      candidates: results.length,
      sent: results.filter((r) => r.outcome === "sent").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      results,
    };
    console.log(JSON.stringify({ website_receipt_emails: summary }));
    return jsonResponse(summary);
  } catch (err) {
    console.error("[website-receipt-emails] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
