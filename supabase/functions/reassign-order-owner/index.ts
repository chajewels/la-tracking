// reassign-order-owner — move a layaway plan or cash order to another customer,
// with the loyalty catch-up (CLAUDE.md "REASSIGN OWNER — NON-NEGOTIABLE").
//
// Body: { kind: 'layaway'|'cash', order_id, new_customer_id,
//         loyalty_jpy_amount?, reason, apply }
//   apply=false → preview from reassign_order_owner_atomic; nothing written.
//   apply=true  → the move (one transaction in SQL), then — only when the RPC
//                 says the new owner qualifies — the catch-up award through
//                 award-loyalty-points. If that award fails the move STANDS
//                 and staff get a 'reassign_catch_up_failed' bell (R9).
//
// Auth: a signed-in staff user only (no service-role path) + reassign_owner;
// edit_loyalty_amount as well when the loyalty amount is being changed.
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { checkPermission } from "../_shared/check-permission.ts";
import { classifyAwardResult, httpStatusFor, type OrderKind } from "../_shared/reassign-owner-rules.ts";

/** The parts of reassign_order_owner_atomic's jsonb this function reads. */
interface RpcResult {
  ok?: boolean;
  applied?: boolean;
  error?: string;
  invoice_number?: string;
  order_date?: string;
  catch_up?: { eligible?: boolean };
  current?: { customer_id?: string; full_name?: string };
  target?: { full_name?: string };
  [key: string]: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  try {
    const ctx = await requireAuth(req);
    if (ctx instanceof Response) return ctx;
    const denied = await requirePermission(ctx, "reassign_owner");
    if (denied) return denied;
    const { supabase } = ctx;
    const userId = ctx.user!.id;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return jsonResponse({ error: "invalid_body", message: "Request body must be JSON." }, 400);

    const kind = body.kind as OrderKind;
    const orderId = body.order_id as string;
    const newCustomerId = body.new_customer_id as string;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const apply = body.apply === true;
    const rawLoyalty = body.loyalty_jpy_amount;

    if (kind !== "layaway" && kind !== "cash") {
      return jsonResponse({ error: "invalid_kind", message: "kind must be layaway or cash." }, 400);
    }
    if (typeof orderId !== "string" || !UUID.test(orderId) || typeof newCustomerId !== "string" || !UUID.test(newCustomerId)) {
      return jsonResponse({ error: "invalid_id", message: "order_id and new_customer_id must be ids." }, 400);
    }
    if (!reason) {
      return jsonResponse({ error: "reason_required", message: "A written reason is required to reassign an order." }, 400);
    }
    let loyalty: number | null = null;
    if (rawLoyalty !== undefined && rawLoyalty !== null && rawLoyalty !== "") {
      const n = Number(rawLoyalty);
      if (!Number.isFinite(n)) {
        return jsonResponse({ error: "invalid_loyalty_amount", message: "The loyalty amount must be a number." }, 400);
      }
      loyalty = Math.round(n);
    }

    // R3 — setting or changing the loyalty amount needs edit_loyalty_amount.
    if (loyalty !== null) {
      const { data: stored } = await supabase
        .from(kind === "layaway" ? "layaway_accounts" : "cash_orders")
        .select("loyalty_jpy_amount")
        .eq("id", orderId)
        .maybeSingle();
      const current = stored?.loyalty_jpy_amount == null ? null : Number(stored.loyalty_jpy_amount);
      if (current !== loyalty && !(await checkPermission(supabase, userId, "edit_loyalty_amount"))) {
        return jsonResponse({
          error: "loyalty_permission_required",
          message: "Changing the loyalty amount needs the Edit Loyalty Amount permission.",
        }, 403);
      }
    }

    const { data, error } = await supabase.rpc("reassign_order_owner_atomic", {
      p_kind: kind,
      p_order_id: orderId,
      p_new_customer_id: newCustomerId,
      p_loyalty_jpy_amount: loyalty,
      p_reason: reason,
      p_user_id: userId,
      p_apply: apply,
    });
    if (error) {
      console.error("[reassign-order-owner] rpc failed:", error);
      return jsonResponse({ error: "rpc_failed", message: error.message }, 500);
    }
    const result = data as RpcResult;
    if (!result?.ok) {
      const code = String(result?.error ?? "unknown");
      return jsonResponse(result, httpStatusFor(code));
    }
    if (!apply || !result.applied) return jsonResponse(result);

    // ---- catch-up award (R6/R7/R9) — after the move has committed ----------
    let award: Record<string, unknown> | null = null;
    if (result.catch_up?.eligible === true) {
      let httpOk = false;
      let awardBody: { awarded?: boolean; skipped?: boolean; reason?: string; error?: string } | null = null;
      let failure: string | null = null;
      try {
        const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            ...(kind === "layaway" ? { account_id: orderId } : { cash_order_id: orderId }),
            catch_up: { order_date: result.order_date },
          }),
        });
        httpOk = res.ok;
        awardBody = await res.json().catch(() => null);
        if (!res.ok) failure = `HTTP ${res.status}${awardBody?.error ? `: ${awardBody.error}` : ""}`;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      const outcome = classifyAwardResult(httpOk, awardBody);
      if (outcome === "failed" && !failure) {
        failure = awardBody?.error ?? (awardBody?.skipped ? `skipped: ${awardBody.reason}` : "no award returned");
      }
      award = { outcome, ...(awardBody ?? {}), ...(failure ? { failure } : {}) };

      if (outcome === "failed") {
        const invoice = result.invoice_number;
        const oldName = result.current?.full_name ?? "the previous owner";
        const newName = result.target?.full_name ?? "the new owner";
        const { error: bellErr } = await supabase.from("staff_notifications").insert({
          type: "reassign_catch_up_failed",
          title: `Catch-up points not awarded — Inv #${invoice}`,
          body: `Inv #${invoice} was moved from ${oldName} to ${newName}, but the catch-up loyalty award failed: ${failure}. The move stands; award the points manually.`,
          account_id: kind === "layaway" ? orderId : null,
          customer_id: newCustomerId,
          invoice_number: invoice,
          metadata: {
            kind,
            cash_order_id: kind === "cash" ? orderId : null,
            old_customer_id: result.current?.customer_id ?? null,
            old_customer_name: oldName,
            new_customer_id: newCustomerId,
            new_customer_name: newName,
            order_date: result.order_date,
            error: failure,
          },
        });
        if (bellErr) console.error("[reassign-order-owner] staff bell insert failed:", bellErr);
      }
    }

    return jsonResponse({ ...result, award });
  } catch (err) {
    console.error("[reassign-order-owner] unexpected error:", err);
    return jsonResponse({ error: "internal_error", message: err instanceof Error ? err.message : String(err) }, 500);
  }
});
