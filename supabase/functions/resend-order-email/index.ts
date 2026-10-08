// resend-order-email — PA08 (owner decision 2026-10-09): the AUDITED MANUAL
// resend of a refund email on a website cash order. Admin only, person only
// (no service-role path: the audit row names who pressed it).
//
// POST { cash_order_id, action: "list" }
//   → { ok, emails: ResendableEmail[] } — the order's refund emails, the newest
//     send-log status of each (sent / failed / suppressed / skipped / null =
//     never attempted) and how many manual resends were used.
// POST { cash_order_id, action: "resend", key, reason }
//   → { ok, sent, reason?, resend_key, attempt } — ONE more attempt under
//     <key>-resend-<n>; the audit row is written BEFORE the send (the claim),
//     so the cap of 3 holds whatever happens after.
//
// Never automatic, never a loop: the owner rule "no automatic replay" stands.
// Scope and guards: _shared/order-email-resend.ts.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { sendOrderUpdateEmail } from "../_shared/order-update-email.ts";
import { paidyRefundReceivedKey } from "../_shared/paidy-rules.ts";
import { customerRefundMethod } from "../_shared/refund-issued-rules.ts";
import {
  latestByOriginalKey, MAX_MANUAL_RESENDS, resendKey, resendRefusal, type ResendableEmail,
} from "../_shared/order-email-resend.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, number> = {
  reason_required: 400, not_resendable: 404, recipient_suppressed: 409, resend_cap_reached: 409,
};

// deno-lint-ignore no-explicit-any
type Db = any;
type AnyRec = Record<string, unknown>;

async function isAdmin(supabase: Db, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw error;
  return ((data ?? []) as Array<{ role: string }>).some((r) => r.role === "admin");
}

/** The order's refund emails with their delivery state. Throws on a read error. */
async function resendableEmails(supabase: Db, orderId: string): Promise<ResendableEmail[]> {
  const items: ResendableEmail[] = [];

  // 「返金が完了しました」 — only once staff recorded the refund as issued.
  const { data: marks, error: mErr } = await supabase.from("audit_logs")
    .select("new_value_json, created_at").eq("entity_type", "cash_order").eq("entity_id", orderId)
    .eq("action", "refund_marked_issued").order("created_at", { ascending: false }).limit(1);
  if (mErr) throw mErr;
  const mark = ((marks ?? []) as AnyRec[])[0];
  if (mark) {
    const v = (mark.new_value_json ?? {}) as AnyRec;
    items.push({
      kind: "refund_issued", key: `refund-issued-${orderId}`, amount: Number(v.amount ?? 0),
      refund_method: typeof v.method === "string" ? v.method : null,
      refunded_on: typeof v.refunded_on === "string" ? v.refunded_on : null,
      last_status: null, last_at: null, resends_used: 0,
    });
  }

  // 「返金を受け付けました」 — one per verified Paidy refund.
  const { data: prs, error: pErr } = await supabase.from("paidy_refunds")
    .select("refund_id, amount_jpy").eq("cash_order_id", orderId).order("created_at");
  if (pErr) throw pErr;
  for (const r of (prs ?? []) as AnyRec[]) {
    items.push({
      kind: "refund_received_paidy", key: paidyRefundReceivedKey(String(r.refund_id)), amount: Number(r.amount_jpy ?? 0),
      last_status: null, last_at: null, resends_used: 0,
    });
  }
  if (items.length === 0) return items;

  const keys = items.flatMap((i) => [i.key, ...Array.from({ length: MAX_MANUAL_RESENDS }, (_, n) => resendKey(i.key, n + 1))]);
  const { data: logs, error: lErr } = await supabase.from("email_send_log")
    .select("status, created_at, metadata").in("metadata->>idempotency_key", keys)
    .order("created_at", { ascending: false }).limit(200);
  if (lErr) throw lErr;
  const latest = latestByOriginalKey(((logs ?? []) as AnyRec[]).map((l) => ({
    key: String(((l.metadata ?? {}) as AnyRec).idempotency_key ?? ""), status: String(l.status ?? ""), created_at: String(l.created_at ?? ""),
  })));

  const { data: used, error: uErr } = await supabase.from("audit_logs")
    .select("new_value_json").eq("entity_type", "cash_order").eq("entity_id", orderId).eq("action", "order_email_resent");
  if (uErr) throw uErr;
  const usedBy = new Map<string, number>();
  for (const u of (used ?? []) as AnyRec[]) {
    const k = String(((u.new_value_json ?? {}) as AnyRec).original_key ?? "");
    usedBy.set(k, (usedBy.get(k) ?? 0) + 1);
  }

  return items.map((i) => {
    const l = latest.get(i.key);
    return { ...i, last_status: l?.status ?? null, last_at: l?.created_at ?? null, resends_used: usedBy.get(i.key) ?? 0 };
  });
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const ctx = await requireAuth(req);
    if (ctx instanceof Response) return ctx;
    if (!ctx.user) return jsonResponse({ error: "Unauthorized" }, 401);
    const supabase = ctx.supabase;
    if (!(await isAdmin(supabase, ctx.user.id))) return jsonResponse({ error: "admin_only" }, 403);

    const body = await req.json().catch(() => ({})) as AnyRec;
    const orderId = String(body.cash_order_id ?? "");
    if (!UUID_RE.test(orderId)) return jsonResponse({ error: "bad_order" }, 400);
    const { data: order, error: oErr } = await supabase.from("cash_orders")
      .select("id, source_channel, web_reference, invoice_number").eq("id", orderId).maybeSingle();
    if (oErr) throw oErr;
    if (!order) return jsonResponse({ error: "not_found" }, 404);
    if ((order as AnyRec).source_channel !== "web") return jsonResponse({ error: "not_web_order" }, 409);

    const emails = await resendableEmails(supabase, orderId);
    if (body.action === "list") return jsonResponse({ ok: true, emails });
    if (body.action !== "resend") return jsonResponse({ error: "bad_action" }, 400);

    const item = emails.find((e) => e.key === String(body.key ?? "")) ?? null;
    const refusal = resendRefusal({ reason: body.reason, item });
    if (refusal || !item) return jsonResponse({ error: refusal ?? "not_resendable" }, STATUS[refusal ?? "not_resendable"] ?? 409);

    const attempt = item.resends_used + 1;
    const newKey = resendKey(item.key, attempt);
    const reason = String(body.reason).trim().slice(0, 500);
    // The claim: written BEFORE the send, so the cap counts every attempt.
    const { error: aErr } = await supabase.from("audit_logs").insert({
      entity_type: "cash_order", entity_id: orderId, action: "order_email_resent", performed_by_user_id: ctx.user.id,
      old_value_json: { last_status: item.last_status, last_at: item.last_at },
      new_value_json: {
        original_key: item.key, resend_key: newKey, attempt, kind: item.kind, reason,
        web_reference: (order as AnyRec).web_reference ?? null, invoice_number: (order as AnyRec).invoice_number ?? null,
      },
    });
    if (aErr) throw aErr;

    const out = await sendOrderUpdateEmail(supabase, item.kind === "refund_issued"
      ? {
        entity: "cash_order", id: orderId, variant: "refund_issued", amount: item.amount,
        refundMethod: customerRefundMethod(String(item.refund_method ?? "")), refundDate: item.refunded_on ?? null,
        idempotencyKey: newKey,
      }
      : { entity: "cash_order", id: orderId, variant: "refund_received", amount: item.amount, refundMethod: "paidy", idempotencyKey: newKey });
    return jsonResponse({ ok: true, sent: out.sent, reason: out.reason ?? null, resend_key: newKey, attempt });
  } catch (err) {
    console.error("[resend-order-email] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
