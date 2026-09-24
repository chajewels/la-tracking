// decline-web-reservation — "Can't supply" on a web reservation.
//
// RESERVE-FIRST (A2, 2026-09-24; contract docs/RESERVE-FIRST.md). Staff looked
// at a reserved piece and cannot send it. The reservation is cancelled, the
// stock goes back, and the customer is told why:
//
//   cash_order  terminate_web_order_atomic('cancelled', source 'staff') —
//               unchanged, it already returns the stock — then the existing
//               order-cancelled email carrying the reason.
//   layaway     decline_web_layaway_reservation_atomic — then layaway-declined
//               (English only) carrying the reason.
//
// Permission: confirm_web_order_ready (admin / staff / csr) — the same key as
// Confirm, because it is the same decision. terminate_web_order_atomic does not
// check permissions itself (A1 contract), so the gate here is the only one on
// the cash path; the layaway RPC checks it again through has_permission.
//
// THIS IS NOT A GENERAL CANCEL. It refuses anything that is not an unconfirmed,
// live, unpaid WEB reservation. A confirmed order is cancelled from its own
// Cancel control (cancel-cash-order, cancel_cash_order permission, refund
// decision) — letting "Can't supply" reach one would be a second, weaker door.
//
// Body: { entity_type: 'cash_order' | 'layaway', entity_id, reason }
// A reason is REQUIRED: it is the customer's only explanation.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendLayawayDeclinedEmail, sendOrderCantSupplyEmail } from "../_shared/reservation-emails.ts";
import {
  RESERVATION_LIVE_STATUS, isUnconfirmedReservation, reservationRefusalStatus,
} from "../_shared/web-reservation-rules.ts";

type AnyRec = Record<string, unknown>;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "confirm_web_order_ready");
  if (denied) return denied;
  const { supabase, user } = ctx;
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  try {
    const body = (await req.json().catch(() => ({}))) as AnyRec;
    const entityType = String(body.entity_type ?? "");
    const entityId = String(body.entity_id ?? "").trim();
    if (entityType !== "cash_order" && entityType !== "layaway") {
      return jsonResponse({ error: "bad_entity_type", message: "entity_type must be 'cash_order' or 'layaway'" }, 400);
    }
    if (!entityId) return jsonResponse({ error: "entity_id_required" }, 400);
    const reason = String(body.reason ?? "").trim().slice(0, 500);
    if (reason.length < 3) {
      return jsonResponse({ error: "reason_required", message: "A reason is required — the customer is told why." }, 400);
    }

    const table = entityType === "cash_order" ? "cash_orders" : "layaway_accounts";
    const { data: row, error: rowErr } = await supabase
      .from(table)
      .select("id, status, source_channel, ready_confirmed_at, total_paid")
      .eq("id", entityId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return jsonResponse({ error: "not_found" }, 404);
    const r = row as AnyRec;
    if (r.source_channel !== "web") {
      return jsonResponse({ error: entityType === "cash_order" ? "not_web_order" : "not_web_layaway" }, 409);
    }
    if (!isUnconfirmedReservation(r)) {
      return jsonResponse({ error: "already_confirmed", ready_confirmed_at: r.ready_confirmed_at }, 409);
    }
    if (String(r.status) !== RESERVATION_LIVE_STATUS[entityType]) {
      return jsonResponse({ error: "not_live", status: r.status }, 409);
    }
    if (Number(r.total_paid ?? 0) > 0) {
      return jsonResponse({ error: "already_paid", total_paid: r.total_paid }, 409);
    }

    if (entityType === "cash_order") {
      const { data, error } = await supabase.rpc("terminate_web_order_atomic", {
        p_order_id: entityId,
        p_outcome: "cancelled",
        p_reason: reason,
        p_user_id: user.id,
        p_user_email: user.email ?? null,
        p_refund_status: null,
        p_refund_note: null,
        p_source: "staff",
        p_preview: false,
      });
      if (error) {
        // refund_decision_required means money arrived between the check above
        // and the RPC — nothing was written; staff must use Cancel instead.
        const msg = error.message ?? "decline failed";
        return jsonResponse({ error: msg.split(":")[0], message: msg }, 409);
      }
      const result = (data ?? {}) as AnyRec;
      if (result.ok === false) {
        const code = String(result.reason ?? "not_cancellable");
        return jsonResponse({ ...result, error: code }, reservationRefusalStatus(code));
      }
      const email = await sendOrderCantSupplyEmail(supabase, entityId, reason);
      return jsonResponse({ ...result, email });
    }

    const { data, error } = await supabase.rpc("decline_web_layaway_reservation_atomic", {
      p_account_id: entityId,
      p_reason: reason,
      p_user_id: user.id,
      p_source: "staff",
    });
    if (error) throw error;
    const result = (data ?? {}) as AnyRec;
    if (result.error) {
      return jsonResponse(result, reservationRefusalStatus(String(result.error)));
    }
    const email = await sendLayawayDeclinedEmail(supabase, entityId, "declined", reason);
    return jsonResponse({ ...result, email });
  } catch (err) {
    console.error("[decline-web-reservation] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
