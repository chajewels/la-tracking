// mark-refund-issued — staff record that the refund on a CANCELLED WEBSITE
// order has been sent, and the customer is told 「返金が完了しました」
// (payment lifecycle addendum §9 #8, owner directive 2026-10-06).
//
// POST { cash_order_id, method: bank_transfer|paidy|card|cash|other
//                               |bank_transfer_exception|store_credit_exception (SQF06, admin),
//        refunded_on: YYYY-MM-DD, note?, exception?: { square_refund_id?, square_support_ticket,
//        amount_jpy, transfer_date?, transfer_reference?, customer_request?, store_credit_lot_id? } }
// SQV03 / D-SQV03 (owner 2026-10-09): the exception is APPROVED FIRST, then paid:
//   POST { cash_order_id, action: "approve", payout: bank_transfer|store_credit,
//          square_refund_id?, square_support_ticket, amount_jpy, note? }  (admin)
//        → re-reads every Square refund of the order from Square, then
//          approve_card_refund_exception_atomic (refuses while a refund is open).
//   POST { cash_order_id, action: "cancel_approval", reason }            (admin)
//   then, after the transfer / lot: the usual record call with method
//   bank_transfer_exception | store_credit_exception records against the approval.
// Person only (no service-role path): the audit row names who did it.
// Permission cancel_cash_order — the same people who record the refund
// decision at cancel. The ONE writer is mark_web_order_refund_issued_atomic
// (locks the order, refuses anything but a cancelled web order still
// refund_pending, audits). The email is sendOrderUpdateEmail's job: web only,
// once per order, never throws — the recorded refund stands either way.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendOrderUpdateEmail } from "../_shared/order-update-email.ts";
import { customerRefundMethod, isExceptionMethod, refundIssuedRefusal } from "../_shared/refund-issued-rules.ts";
import { refundReceivedKey } from "../_shared/square-reconcile-rules.ts";
import { type RefundEmailState, refundEmailCoverage, refundEmailSentence, refundEmailState } from "../_shared/refund-email-state.ts";
import { resyncOrderRefunds } from "../_shared/square-refund-resync.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<string, number> = {
  not_found: 404, not_web_order: 409, not_cancelled: 409, not_refund_pending: 409,
  bad_method: 400, bad_date: 400, user_identity_required: 401,
  // B01 (2026-10-08): a card-paid order is refunded in Square — method 'card',
  // only once Square shows a COMPLETED refund (the SQL decides; amount = what
  // Square completed).
  method_mismatch: 409, no_completed_card_refund: 409,
  // PA03 (2026-10-08): a Paidy-paid order is refunded in the Paidy dashboard —
  // method 'paidy', only once the Hub has read the refund back from Paidy
  // (paidy_refunds); the amount is the verified total, never the gross.
  no_verified_paidy_refund: 409,
  // SQF06 (owner D-SQF06, 2026-10-09): the card-refund-outside-Square exception —
  // admin only, opened only by a FAILED/REJECTED Square refund or a capture over
  // 365 days old, evidence (refund id / ticket / transfer) required, amount
  // capped by the SQL at captured − completed refunds − credit issued.
  admin_only: 403, exception_not_triggered: 409, exception_evidence_required: 400, exception_over_cap: 409,
  exception_nothing_owed: 409, exception_lot_mismatch: 409,
  // SQV02/SQV03 (2026-10-09): approve first, then pay.
  exception_exists: 409, exception_refund_in_progress: 409, exception_not_approved: 409,
  exception_payout_mismatch: 409, exception_superseded: 409, bad_payout: 400, reason_required: 400,
  no_approval: 404, already_recorded: 409, square_unreachable: 503, refund_not_recorded: 503, hub_read_failed: 503,
};

/** SQF06: the signed-in user holds the admin role (user_roles), checked here before the SQL checks it again. */
async function isAdmin(supabase: { from: (t: string) => any }, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw error;
  return ((data ?? []) as Array<{ role: string }>).some((r) => r.role === "admin");
}

/** True when the "refund issued" email for this order already went out (B01 retry). */
async function refundIssuedEmailSent(supabase: { from: (t: string) => any }, key: string): Promise<boolean> {
  const { count, error } = await supabase.from("email_send_log").select("id", { count: "exact", head: true })
    .eq("status", "sent").eq("metadata->>idempotency_key", key);
  if (error) throw error;
  return (count ?? 0) > 0;
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  if (!ctx.user) return jsonResponse({ error: "a staff member must do this" }, 403);
  const denied = await requirePermission(ctx, "cancel_cash_order");
  if (denied) return denied;
  const { supabase } = ctx;

  try {
    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.cash_order_id ?? "");
    if (!UUID_RE.test(orderId)) return jsonResponse({ error: "cash_order_id must be a uuid" }, 400);

    const action = typeof body?.action === "string" ? body.action : "record";
    if (action === "approve" || action === "cancel_approval") {
      if (!(await isAdmin(supabase, ctx.user.id))) return jsonResponse({ error: "admin_only" }, 403);
      if (action === "cancel_approval") {
        const { data, error: rpcErr } = await supabase.rpc("cancel_card_refund_exception_atomic", {
          p_order_id: orderId, p_user_id: ctx.user.id, p_reason: typeof body?.reason === "string" ? body.reason : null,
        });
        if (rpcErr) throw rpcErr;
        const r = (data ?? {}) as Record<string, unknown>;
        if (r.ok !== true) { const code = String(r.error ?? "refused"); return jsonResponse({ error: code }, STATUS[code] ?? 409); }
        return jsonResponse({ ok: true, exception: r.exception });
      }
      // Square's facts first (fail closed): a refund the Hub has not seen yet,
      // or one that moved since, decides the approval — not a stale row.
      const resync = await resyncOrderRefunds(supabase, orderId);
      if (!resync.ok) return jsonResponse({ error: resync.error, detail: resync.detail }, STATUS[resync.error] ?? 503);
      const amount = Number(body?.amount_jpy);
      const { data, error: rpcErr } = await supabase.rpc("approve_card_refund_exception_atomic", {
        p_order_id: orderId, p_user_id: ctx.user.id,
        p_payout: typeof body?.payout === "string" ? body.payout : null,
        p_square_refund_id: typeof body?.square_refund_id === "string" && body.square_refund_id.trim() !== "" ? body.square_refund_id.trim() : null,
        p_ticket: typeof body?.square_support_ticket === "string" ? body.square_support_ticket : null,
        p_amount_jpy: Number.isSafeInteger(amount) ? amount : null,
        p_note: typeof body?.note === "string" ? body.note.trim().slice(0, 500) : null,
      });
      if (rpcErr) throw rpcErr;
      const r = (data ?? {}) as Record<string, unknown>;
      if (r.ok !== true) {
        const code = String(r.error ?? "refused");
        return jsonResponse({ error: code, cap_jpy: r.cap_jpy ?? null, refunds: r.refunds ?? null, missing: r.missing ?? null, detail: r.detail ?? null }, STATUS[code] ?? 409);
      }
      return jsonResponse({ ok: true, exception: r.exception, cap_jpy: r.cap_jpy, resynced_refunds: resync.refunds });
    }
    const method = typeof body?.method === "string" ? body.method.trim().toLowerCase() : "";
    const refundedOn = typeof body?.refunded_on === "string" ? body.refunded_on.trim() : "";
    const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : "";
    // SQF06: the exception evidence travels as one object; the SQL validates each field.
    const exception = isExceptionMethod(method) && body?.exception && typeof body.exception === "object" && !Array.isArray(body.exception)
      ? body.exception as Record<string, unknown> : null;
    if (isExceptionMethod(method) && !(await isAdmin(supabase, ctx.user.id))) return jsonResponse({ error: "admin_only" }, 403);

    const { data: order, error } = await supabase
      .from("cash_orders").select("id, source_channel, status, refund_status").eq("id", orderId).maybeSingle();
    if (error) throw error;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
    const refusal = refundIssuedRefusal(order, { method, refundedOn }, today);
    if (refusal) return jsonResponse({ error: refusal }, STATUS[refusal] ?? 409);

    const { data, error: rpcErr } = await supabase.rpc("mark_web_order_refund_issued_atomic", {
      p_order_id: orderId, p_user_id: ctx.user.id, p_method: method, p_refunded_on: refundedOn, p_note: note || null,
      p_exception: exception,
    });
    if (rpcErr) throw rpcErr;
    const r = (data ?? {}) as Record<string, unknown>;
    if (r.ok !== true) {
      const code = String(r.error ?? "refused");
      return jsonResponse({ error: code, missing: r.missing ?? null, detail: r.detail ?? null, cap_jpy: r.cap_jpy ?? null }, STATUS[code] ?? 409);
    }

    const emailKey = `refund-issued-${orderId}`;
    const alreadyRecorded = r.already_recorded === true;

    // A refund made in the Square / Paidy dashboard already emailed her
    // 「返金を受け付けました」 with the provider's amount (§9 #9). Marking it
    // issued then records it on the order only — never a second email with a
    // possibly different amount.
    if (method === "card") {
      // R06 (2026-10-08): a COMPLETED Square refund row is a financial fact, not
      // a delivery receipt. "Already emailed" is said only when the send log
      // holds a sent row for that refund's own key; otherwise the truth is
      // "not confirmed" (the hourly check re-sends it, B02). Either way no
      // second message is sent from here (one-message policy).
      const { data: rfs, error: rErr } = await supabase.from("square_refunds")
        .select("square_refund_id, refund_email_replay, email_given_up_at")
        .eq("cash_order_id", orderId).eq("status", "COMPLETED");
      if (rErr) throw rErr;
      const rows = (rfs ?? []) as Array<{ square_refund_id: string; refund_email_replay: boolean | null; email_given_up_at: string | null }>;
      if (rows.length > 0) {
        // SQF05 (2026-10-09): EVERY completed refund must be proven — one sent
        // email never vouches for a second refund on the same order.
        // SQV06 (2026-10-09): and the answer says, per refund, whether a retry is
        // really scheduled (retrying), stopped (given_up) or never was
        // (not_replayed) — "the hourly check will retry" only when it will.
        const states: RefundEmailState[] = [];
        for (const row of rows) {
          const sent = await refundIssuedEmailSent(supabase, refundReceivedKey(String(row.square_refund_id)));
          states.push(refundEmailState({ sent, replay: row.refund_email_replay, givenUpAt: row.email_given_up_at }));
        }
        const coverage = refundEmailCoverage(states);
        return jsonResponse({
          ok: true, amount: r.amount, currency: r.currency, already_recorded: alreadyRecorded, email_sent: false,
          email_skipped: coverage.sent === coverage.total ? "provider_refund_already_emailed" : "provider_refund_email_not_confirmed",
          refund_emails: coverage, refund_email_sentence: refundEmailSentence(coverage),
        });
      }
    } else if (method === "paidy") {
      const { count, error: rErr } = await supabase.from("paidy_refunds").select("id", { count: "exact", head: true }).eq("cash_order_id", orderId);
      if (rErr) throw rErr;
      if ((count ?? 0) > 0) {
        return jsonResponse({ ok: true, amount: r.amount, currency: r.currency, already_recorded: alreadyRecorded, email_sent: false, email_skipped: "provider_refund_already_emailed" });
      }
    }

    // B01 retry (2026-10-08): the same request after it already succeeded —
    // nothing was written again; the email goes out only if it never did.
    if (alreadyRecorded && await refundIssuedEmailSent(supabase, emailKey)) {
      return jsonResponse({ ok: true, amount: r.amount, currency: r.currency, already_recorded: true, email_sent: false, email_skipped: "already_sent" });
    }

    const email = await sendOrderUpdateEmail(supabase, {
      entity: "cash_order", id: orderId, variant: "refund_issued",
      amount: Number(r.amount ?? 0), refundMethod: customerRefundMethod(method),
      refundDate: String(r.refunded_on ?? refundedOn), idempotencyKey: emailKey,
    });
    return jsonResponse({ ok: true, amount: r.amount, currency: r.currency, already_recorded: alreadyRecorded, email_sent: email.sent });
  } catch (err) {
    console.error("[mark-refund-issued] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
