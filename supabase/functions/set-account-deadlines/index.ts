// set-account-deadlines — staff move a deposit deadline.
//
// Owner decision 2026-09-13: the deadline is a FIELD, not a computed rule. It is
// offered at creation and staff can change it while the order is live. An
// extension is simply a new deadline on a running order; an expired or cancelled
// one is never revived — if the customer comes back the order is created fresh,
// so there is no stock re-hold path to get wrong.
//
// One control, both tables: `layaway` moves transfer_due_at on
// layaway_accounts, `cash_order` moves transfer_due_at AND expires_at on
// cash_orders, because the expiry cron reads expires_at and moving only one
// would show the customer a new deadline while the cron still cancelled on the
// old one.
//
// There is only the ONE deadline here. settlement_due_at was removed on
// 2026-09-15 (owner decision): it was built to a 2026-09-14 answer, nothing
// read it, and no row ever carried a value. The deposit deadline is the control
// that matters.
//
// Everything is done inside set_account_deadlines: the live-status check, the
// write and the audit row with the old and new values and the reason.

import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";

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
    const entityType = String(body?.entity_type ?? "");
    const entityId = String(body?.entity_id ?? "");
    if (!["layaway", "cash_order"].includes(entityType)) {
      return jsonResponse({ error: "entity_type must be 'layaway' or 'cash_order'" }, 400);
    }
    if (!entityId) return jsonResponse({ error: "entity_id is required" }, 400);

    // A deadline is a point in time, so an empty string is a mistake rather than
    // "no deadline" — say so instead of silently clearing it.
    const transferDueAt = body?.transfer_due_at ?? null;
    if (transferDueAt !== null && Number.isNaN(Date.parse(String(transferDueAt)))) {
      return jsonResponse({ error: "transfer_due_at is not a valid timestamp" }, 400);
    }

    // A REASON IS REQUIRED (owner decision 2026-09-15). Moving this deadline
    // decides when a customer's piece is released, and an audit row with a null
    // reason records that it happened and nothing about why. Every other
    // terminal action in the Hub asks for one; this one used to accept the
    // absence silently, because `.trim() || null` turned "" into a legitimate
    // NULL. Refuse before the RPC rather than write an unexplained audit row.
    const reason = String(body?.reason ?? "").trim();
    if (!reason) {
      return jsonResponse(
        { error: "reason_required", message: "A reason is required to change a deadline." },
        400,
      );
    }

    const { data, error } = await supabase.rpc("set_account_deadlines", {
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_transfer_due_at: transferDueAt,
      p_reason: reason,
      p_user_id: user?.id ?? null,
    });
    if (error) throw error;

    const result = (data ?? {}) as Record<string, unknown>;
    if (result.error) {
      const status = result.error === "not_found" ? 404 : result.error === "not_live" ? 409 : 400;
      return jsonResponse(result, status);
    }
    return jsonResponse(result);
  } catch (err) {
    console.error("[set-account-deadlines] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
