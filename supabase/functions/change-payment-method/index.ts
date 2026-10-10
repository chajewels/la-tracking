// change-payment-method — staff change how a WEBSITE order is paid (owner C1,
// 2026-10-05; plan claude/checkout-payment-choice-and-points-plan-2026-10-04).
//
// The customer chooses transfer, Paidy or card at checkout and it is LOCKED for
// her. Only staff change it — e.g. Paidy declined → bank transfer or card —
// here: permission confirm_payment, a written reason, audited
// (audit_logs 'payment_method_changed'). ONE writer:
// change_web_payment_method_atomic, which refuses while any payment is in
// progress (cash_order_payment_lock: a Paidy window or payment, a card hold, a
// submission waiting), on a layaway (transfer only) and Paidy/card on a peso
// order (yen only).
//
// Body: { entity_type: 'draft' | 'cash_order', entity_id, method:
// 'transfer' | 'paidy' | 'card' | 'cod', reason }.
//
// Cash on delivery (owner plan 2026-10-10): switching to or from 'cod' adds or
// removes the 代引手数料 and re-brackets it; the SQL moves total_amount and
// remaining_balance by the fee delta in the same transaction (answer: cod_fee,
// old_cod_fee, fee_delta). A COD order has no payment deadline; switching a
// confirmed order AWAY from COD answers deadline_missing: true when it has none,
// so staff set one (Move deadline) — this function never writes a deadline.
// On a confirmed order the customer is emailed the order again, showing only
// the new method (never throws: the change stands whether or not mail goes).
//
// No service-role path: a change is always a person.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { storedMethod } from "../_shared/checkout-choice.ts";
import { sendOrderReadyEmail } from "../_shared/reservation-emails.ts";

type AnyRec = Record<string, unknown>;

const ERROR_STATUS: Record<string, number> = {
  user_identity_required: 401,
  permission_denied: 403,
  reason_required: 400,
  bad_method: 400,
  bad_entity_type: 400,
  not_found: 404,
  not_open: 409,
  not_web_order: 409,
  not_payable: 409,
  payment_in_progress: 409,
  unchanged: 409,
  method_full_payment_only: 409,
  method_requires_yen: 409,
  method_unavailable: 409, // QC 2026-10-06: Paidy off or not shipping to Japan; card off; COD off
  over_cod_limit: 409,
  cod_nothing_to_collect: 409,
};

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "confirm_payment");
  if (denied) return denied;
  const { supabase, user } = ctx;
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const body = (await req.json().catch(() => ({}))) as AnyRec;
    const entityType = String(body.entity_type ?? "");
    const entityId = String(body.entity_id ?? "").trim();
    const method = storedMethod(body.method);
    const reason = String(body.reason ?? "").trim();
    if (entityType !== "draft" && entityType !== "cash_order") return jsonResponse({ error: "bad_entity_type" }, 400);
    if (!/^[0-9a-f-]{36}$/i.test(entityId)) return jsonResponse({ error: "not_found" }, 404);
    if (!method) return jsonResponse({ error: "bad_method" }, 400);
    if (!reason) return jsonResponse({ error: "reason_required" }, 400);

    const { data, error } = await supabase.rpc("change_web_payment_method_atomic", {
      p_entity_type: entityType, p_entity_id: entityId, p_method: method, p_reason: reason, p_user_id: user.id,
    });
    if (error) throw error;
    const r = (data ?? {}) as AnyRec;
    if (r.error) return jsonResponse(r, ERROR_STATUS[String(r.error)] ?? 400);

    // A confirmed order: tell the customer how to pay now (only the new method).
    const email = entityType === "cash_order"
      ? await sendOrderReadyEmail(supabase, entityId, { methodChanged: true })
      : null;

    // Away from COD on a confirmed order with no deadline: staff must set one.
    let deadlineMissing = false;
    if (entityType === "cash_order" && r.payment_method !== "cod") {
      const { data: after } = await supabase.from("cash_orders").select("transfer_due_at").eq("id", entityId).maybeSingle();
      deadlineMissing = !(after as AnyRec | null)?.transfer_due_at;
    }

    console.log(JSON.stringify({ change_payment_method: entityType, id: entityId, from: r.old_method, to: r.payment_method, fee_delta: r.fee_delta ?? 0, by: user.id }));
    return jsonResponse({ ...r, email, deadline_missing: deadlineMissing });
  } catch (err) {
    console.error("[change-payment-method] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
