// confirm-web-order-ready — staff confirm a web reservation ready for dispatch.
//
// RESERVE-FIRST (A2, 2026-09-24; contract docs/RESERVE-FIRST.md). With
// system_settings.web_reservation_mode on, a web checkout holds the piece but
// shows the customer no payment details and starts no deadline. This is the
// button that ends that: confirm_web_order_ready_atomic starts the deadline
// (24 hours for a first order, 72 for a returning customer —
// web_deposit_deadline_hours decides, never this file), a layaway's schedule
// is re-dated to today, and then the customer gets the "ready — pay now" email
// with the bank details and the new deadline.
//
// Permission: confirm_web_order_ready (admin / staff / csr). Checked here AND
// inside the RPC through has_permission with the signed-in user's id, so user
// overrides apply at both layers. There is no service-role path: a
// confirmation is always a person.
//
// Body: { entity_type: 'cash_order' | 'layaway', entity_id, note?, preview? }
//   preview: true  → writes nothing; returns the deadline the customer WILL
//                    get, so the confirm dialog can state it.
//
// The email is sent after the commit and never fails the confirmation; its
// outcome is returned (and, like every storefront send, logged to
// email_send_log).

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendLayawayReadyEmail, sendOrderReadyEmail } from "../_shared/reservation-emails.ts";
import { isAwaitingConfirmation, reservationRefusalStatus } from "../_shared/web-reservation-rules.ts";

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
    const note = String(body.note ?? "").trim() || null;

    if (body.preview === true) {
      const table = entityType === "cash_order" ? "cash_orders" : "layaway_accounts";
      const { data: row, error: rowErr } = await supabase
        .from(table)
        .select("id, customer_id, status, source_channel, ready_confirmed_at, created_at")
        .eq("id", entityId)
        .maybeSingle();
      if (rowErr) throw rowErr;
      if (!row) return jsonResponse({ error: "not_found" }, 404);
      // The same rule the RPC applies, with THIS order left out of the
      // customer's history — so the number shown is the number written.
      const { data: hours, error: hErr } = await supabase.rpc("web_deposit_deadline_hours", {
        p_customer_id: (row as AnyRec).customer_id,
        p_exclude_order: entityId,
      });
      if (hErr) throw hErr;
      const h = Number(hours);
      return jsonResponse({
        preview: true,
        awaiting_confirmation: isAwaitingConfirmation(row as AnyRec, entityType),
        deadline_hours: Number.isFinite(h) ? h : null,
        transfer_due_at: Number.isFinite(h) ? new Date(Date.now() + h * 3_600_000).toISOString() : null,
      });
    }

    const { data, error } = await supabase.rpc("confirm_web_order_ready_atomic", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_user_id: user.id,
      p_note: note,
    });
    if (error) throw error;
    const result = (data ?? {}) as AnyRec;
    if (result.error) {
      return jsonResponse(result, reservationRefusalStatus(String(result.error)));
    }

    const email = entityType === "cash_order"
      ? await sendOrderReadyEmail(supabase, entityId)
      : await sendLayawayReadyEmail(supabase, entityId, (result.schedule ?? null) as never);

    console.log(JSON.stringify({
      confirm_web_order_ready: entityType,
      id: entityId,
      reference: result.web_reference ?? result.invoice_number ?? null,
      deadline_hours: result.deadline_hours ?? null,
      by: user.id,
      email: email.sent ? "sent" : (email as { reason?: string }).reason ?? "not_sent",
    }));

    return jsonResponse({ ...result, email });
  } catch (err) {
    console.error("[confirm-web-order-ready] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
