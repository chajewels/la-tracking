// revive-web-cash-order — staff bring an EXPIRED web cash order back to life.
//
// Owner decision 2026-09-23. The Hub's "Revive Order" button used to do this
// with three client-side column writes: status back to pending, expired_at
// cleared, a staff-typed expires_at. On a WEB order that left three things
// wrong — expiry had put the pieces back on sale and nothing took them back,
// payment_status stayed 'cancelled' (so the storefront never showed the
// customer how to pay), and transfer_due_at, the deadline the customer is
// shown, did not move.
//
// ONE ACTION, ONE TRANSACTION: revive_web_cash_order_atomic re-takes the stock
// (refusing out_of_stock by name), resets payment_status to pending_transfer,
// sets transfer_due_at = expires_at from the existing deadline rule
// (web_deposit_deadline_hours — 24h first order, 72h returning), and writes an
// audit row. Either the order is live and the pieces are held, or nothing
// changed.
//
// Hub (non-web) cash orders keep the old revive path in CashOrderDetail; they
// hold no website stock and have no payment_status.
//
// Same gate as set-account-deadlines and reactivate-web-layaway: a valid staff
// JWT plus `edit_account`. Reviving decides whether a customer keeps a piece.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { reviveRefusalStatus } from "../_shared/web-order-rules.ts";

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "edit_account");
  if (denied) return denied;
  const { supabase, user } = ctx;

  try {
    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.cash_order_id ?? "");
    if (!orderId) return jsonResponse({ error: "cash_order_id is required" }, 400);

    // A reason is required for the same reason every deadline change needs
    // one: an audit row with a null reason records that it happened and
    // nothing about why. Refused before the RPC, which refuses it too.
    const reason = String(body?.reason ?? "").trim();
    if (!reason) {
      return jsonResponse(
        { error: "reason_required", message: "A reason is required to revive an order." },
        400,
      );
    }

    const { data, error } = await supabase.rpc("revive_web_cash_order_atomic", {
      p_order_id: orderId,
      p_reason: reason,
      p_user_id: user?.id ?? null,
      p_user_email: user?.email ?? null,
      p_source: "staff",
    });
    if (error) throw error;

    const result = (data ?? {}) as Record<string, unknown>;
    if (result.error) return jsonResponse(result, reviveRefusalStatus(String(result.error)));
    return jsonResponse(result);
  } catch (err) {
    console.error("[revive-web-cash-order] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
