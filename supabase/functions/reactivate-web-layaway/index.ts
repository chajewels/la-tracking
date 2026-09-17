// reactivate-web-layaway — staff bring an EXPIRED web layaway back to life.
//
// Owner decision 2026-09-15. Until now the rule was "an expired or cancelled
// order is never revived — if the customer comes back the order is created
// fresh, so there is no stock re-hold path to get wrong" (see
// set-account-deadlines, whose header still says exactly that and still refuses
// anything not live). This is the deliberate exception, and the stock re-hold is
// built rather than avoided.
//
// ONE ACTION. A new deposit deadline, a required reason, the stock taken back
// off the shelf, the schedule restored, and an audit row carrying the old status
// and the new — all inside reactivate_web_layaway_atomic, in one transaction.
// Either the plan is live and the pieces are held, or nothing changed.
//
// THE REFUSALS ARE THE FEATURE. Expiry put the piece back on sale, so between
// then and now somebody may have bought it. `out_of_stock` names the line that
// is gone instead of holding a piece the shelf says is available. `not_expired`
// keeps this away from live plans (use set-account-deadlines) and from plans a
// human cancelled on purpose. `already_paid` / `payment_exists` are the same two
// tests, in the same order and under the same names, that expiry and
// set_account_deadlines make — a plan with money on it is a normal layaway and
// follows the normal path.
//
// Same gate as set-account-deadlines: a valid staff JWT plus `edit_account`.
// Reactivating decides whether a customer keeps their piece, which is the same
// weight of decision as moving the deadline in the first place.

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
    const accountId = String(body?.account_id ?? "");
    if (!accountId) return jsonResponse({ error: "account_id is required" }, 400);

    // A DEADLINE IS THE POINT OF THE ACTION, so it is refused before the RPC
    // rather than defaulted. Reactivating without one would put the plan back
    // live with the deadline it already missed.
    const transferDueAt = body?.transfer_due_at ?? null;
    if (transferDueAt === null) {
      return jsonResponse(
        {
          error: "deadline_required",
          message: "Reactivating needs a new deposit deadline. Send the new date.",
        },
        400,
      );
    }
    if (Number.isNaN(Date.parse(String(transferDueAt)))) {
      return jsonResponse({ error: "transfer_due_at is not a valid timestamp" }, 400);
    }

    // A REASON IS REQUIRED, for the reason set-account-deadlines gives: an audit
    // row with a null reason records that it happened and nothing about why.
    // This action is heavier than that one — it takes a piece back off sale.
    const reason = String(body?.reason ?? "").trim();
    if (!reason) {
      return jsonResponse(
        { error: "reason_required", message: "A reason is required to reactivate a plan." },
        400,
      );
    }

    const { data, error } = await supabase.rpc("reactivate_web_layaway_atomic", {
      p_account_id: accountId,
      p_transfer_due_at: transferDueAt,
      p_reason: reason,
      p_user_id: user?.id ?? null,
      p_source: "staff",
    });
    if (error) throw error;

    const result = (data ?? {}) as Record<string, unknown>;
    if (result.error) {
      // 404 the plan we cannot find; 409 the two states that are a conflict with
      // the world rather than a bad request — the piece is gone, or the plan is
      // not in a state this action applies to. Everything else is a 400.
      const status = result.error === "not_web_layaway"
        ? 404
        : ["out_of_stock", "not_expired", "already_paid", "payment_exists"].includes(
            String(result.error),
          )
        ? 409
        : 400;
      return jsonResponse(result, status);
    }
    return jsonResponse(result);
  } catch (err) {
    console.error("[reactivate-web-layaway] failed:", err);
    return jsonResponse({ error: (err as Error)?.message ?? "internal_error" }, 500);
  }
});
