// supabase/functions/cancel-cash-order/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { corsHeaders } from "../_shared/cors.ts";
import type { RefundStatus } from "../_shared/email-templates/order-cancelled.tsx";
import { terminateRefusalMessage } from "../_shared/terminate-refusals.ts";
import { releasePaidyForCancel } from "../_shared/paidy-cancel-release.ts";
// PA14 (2026-10-08): the stages after the terminate RPC — bells, portal
// notifications, the cancellation email and the Shopify mirror — live in
// _shared/cancel-followups.ts, shared with the sweep that finishes an
// interrupted cancel. The intent row is written BEFORE the Paidy release.
import { advanceCancelIntent, emitCancellationFollowups, openCancelIntent, syncStoreCreditToShopify as syncToShopify } from "../_shared/cancel-followups.ts";

const REFUND_STATUSES = new Set(["refund_issued", "refund_pending", "store_credit_issued", "no_refund"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const { data: { user }, error: authError } =
      await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const allowed = await checkPermission(supabase, user.id, "cancel_cash_order");
    if (!allowed) return json({ error: "cancel_cash_order permission required" }, 403);

    const body = await req.json().catch(() => ({}));
    const cash_order_id = body.cash_order_id ?? null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const preview = body.preview === true;
    const refundStatus: RefundStatus | null =
      typeof body.refund_status === "string" && REFUND_STATUSES.has(body.refund_status) ? body.refund_status : null;
    const refundNote: string | null =
      typeof body.refund_note === "string" && body.refund_note.trim() ? body.refund_note.trim().slice(0, 300) : null;

    if (!cash_order_id) return json({ error: "cash_order_id is required" }, 400);
    if (!preview && reason.length < 3) {
      return json({ error: "A cancellation reason is required" }, 400);
    }

    // Web orders (source_channel = 'web') go through terminate_web_order_atomic:
    // points reversal, store credit per the refund decision, status, stock back
    // on sale, note + audit — one transaction, once. Hub cash orders keep
    // cancel_cash_order_atomic (no stock, store credit for money received).
    const { data: orderRow } = await supabase
      .from("cash_orders")
      .select("id, source_channel, web_reference, invoice_number, customer_id")
      .eq("id", cash_order_id)
      .maybeSingle();
    if (!orderRow) return json({ error: "cash_order_not_found" }, 404);
    const isWeb = orderRow.source_channel === "web";

    // Owner decision 2026-10-06: a staff cancel of a web order closes an open
    // Paidy authorisation first (read back from Paidy; captured money refuses
    // the cancel). Only when the order is actually locked by Paidy; a preview
    // writes nothing and only says that the authorisation would be closed.
    // Reassessment P08: a lock that cannot be read stops the cancel; a Paidy
    // window still open or a capture not yet recorded refuses it (preview and
    // real alike, so the preview never promises what the cancel will refuse);
    // the order's own eligibility is checked BEFORE anything is closed at Paidy.
    let paidyClosed = 0;
    let releaseDone = false;
    // PA14: the intent — written before anything is released at Paidy, so an
    // interrupted cancel is never invisible. A clean refusal abandons it.
    let intentId: string | null = null;
    if (isWeb && !preview) {
      intentId = await openCancelIntent(supabase, {
        cash_order_id, user_id: user.id, user_email: user.email ?? null, reason,
        refund_status: refundStatus, refund_note: refundNote,
      });
    }
    const refuse = async (payload: Record<string, unknown>, status: number, why: string) => {
      await advanceCancelIntent(supabase, intentId, "abandoned", why);
      return json(payload, status);
    };
    if (isWeb) {
      const { data: lock, error: lockErr } = await supabase.rpc("cash_order_payment_lock", { p_cash_order_id: cash_order_id });
      if (lockErr) {
        console.error("[cancel-cash-order] payment lock read failed:", lockErr);
        return await refuse({ ok: false, error: "Could not check this order's payment state, so it was not cancelled. Try again.", code: "payment_state_unknown" }, 503, "payment_state_unknown");
      }
      const lockReason = typeof lock === "string" ? lock : null;
      if (lockReason === "paidy_checkout_open") {
        return await refuse({ ok: false, error: "The customer has the Paidy payment window open right now. Wait until it finishes (or the hourly check settles it), then cancel.", code: lockReason }, 409, lockReason);
      }
      if (lockReason === "paidy_captured_unrecorded") {
        return await refuse({ ok: false, error: "Paidy has already taken money on this order that the Hub has not recorded yet. Record it first (Payment Submissions); a refund is then made in the Paidy dashboard.", code: lockReason }, 409, lockReason);
      }
      if (lockReason === "paidy_submission_pending" || lockReason === "paidy_authorized") {
        if (preview) {
          paidyClosed = -1;
        } else {
          const { data: pre, error: preErr } = await supabase.rpc("terminate_web_order_atomic", {
            p_order_id: cash_order_id, p_outcome: "cancelled", p_reason: reason || null,
            p_user_id: user.id, p_user_email: user.email ?? null,
            p_refund_status: refundStatus, p_refund_note: refundNote, p_source: "staff", p_preview: true,
          });
          if (preErr) return await refuse({ error: preErr.message ?? "cancel failed", code: String(preErr.message ?? "").split(":")[0] }, 400, String(preErr.message ?? "preview_failed"));
          if ((pre as any)?.ok === false) {
            const r = (pre as any).reason ?? "not_cancellable";
            return await refuse({ ...(pre as any), error: terminateRefusalMessage(r) ?? r, code: r }, 409, r);
          }
          const rel = await releasePaidyForCancel(supabase, cash_order_id, user.id);
          if (!rel.ok) {
            // Nothing released (or not confirmed released): the intent stays
            // `started` only when Paidy may have acted; a clean refusal abandons it.
            if (rel.code === "paidy_release_incomplete") await advanceCancelIntent(supabase, intentId, "started", rel.code);
            else await advanceCancelIntent(supabase, intentId, "abandoned", rel.code);
            return json({ ok: false, error: rel.message, code: rel.code }, rel.code === "paidy_already_captured" ? 409 : 502);
          }
          paidyClosed = rel.closed;
          releaseDone = true;
          await advanceCancelIntent(supabase, intentId, "paidy_released");
        }
      }
    }

    const { data, error } = isWeb
      ? await supabase.rpc("terminate_web_order_atomic", {
          p_order_id: cash_order_id,
          p_outcome: "cancelled",
          p_reason: reason || null,
          p_user_id: user.id,
          p_user_email: user.email ?? null,
          p_refund_status: refundStatus,
          p_refund_note: refundNote,
          p_source: "staff",
          p_preview: preview,
        })
      : await supabase.rpc("cancel_cash_order_atomic", {
          p_cash_order_id: cash_order_id,
          p_reason: reason,
          p_user_id: user.id,
          p_user_email: user.email ?? null,
          p_preview: preview,
        });

    if (error) {
      console.error("[cancel-cash-order] rpc error:", error);
      const msg = error.message ?? "cancel failed";
      const status = msg.includes("refund_decision_required") ? 400 : 400;
      // The terminate did not commit: a released Paidy authorisation (if any)
      // is already noted on the intent; the sweep finishes it (PA14).
      await advanceCancelIntent(supabase, intentId, releaseDone ? "paidy_released" : "abandoned", msg.split(":")[0]);
      // QC close-out (2026-10-09): a Hub cash order refused for card money
      // (card_payment_unresolved / card_already_refunded / card_disputed) gets
      // the same plain-English message as a web order.
      return json({ error: terminateRefusalMessage(msg.split(":")[0]) ?? msg, code: msg.split(":")[0] }, status);
    }
    if (isWeb && (data as any)?.ok === false) {
      // already_terminal / not_web_order — nothing was written. Unresolved
      // Paidy or card money (paidy_payment_unresolved / card_payment_unresolved)
      // gets a plain-English message for staff; the code stays on `code`.
      const reason = (data as any).reason ?? "not_cancellable";
      await advanceCancelIntent(supabase, intentId, reason === "already_terminal" ? "done" : "abandoned", reason);
      return json({ ...(data as any), error: terminateRefusalMessage(reason) ?? reason, code: reason }, 409);
    }
    if (!preview && (data as any)?.success === true) await advanceCancelIntent(supabase, intentId, "terminated");

    // Bells, portal notifications and the cancellation email (PA14: shared
    // with the sweep, each emission idempotent). The cancellation already
    // succeeded — nothing here may fail, block or change the result.
    {
      const c = (data ?? {}) as Record<string, any>;
      if (c.success === true && preview !== true) {
        try {
          await emitCancellationFollowups(supabase, { cash_order_id, isWeb, c, orderRow, reason, refundStatus, refundNote });
          await advanceCancelIntent(supabase, intentId, "notified");
        } catch (e) {
          console.warn("[cancel-cash-order] follow-ups failed (the sweep finishes them):", e);
          await advanceCancelIntent(supabase, intentId, "terminated", e instanceof Error ? e.message : String(e));
        }
      }
    }

    // Mirror the issued credit into Shopify — ONLY when store credit was actually
    // issued (data.store_credit not null). Non-blocking.
    let shopify_sync: unknown = null;
    const sc = (data as any)?.store_credit;
    if ((data as any)?.success === true && preview !== true && sc) {
      shopify_sync = await syncToShopify({
        customer_id: sc.customer_id,
        direction: "credit",
        amount: Number(sc.amount),
        currency: sc.currency,
        lot_id: sc.lot_id,
        expires_at: sc.expires_at,
        reason: `Store credit issued on cancellation of ${(data as any).web_reference ?? (data as any).invoice_number ?? "cash order"}`,
      });
    }

    if (!preview && (data as any)?.success === true) await advanceCancelIntent(supabase, intentId, "done");
    return json({ ...(data ?? {}), shopify_sync, ...(paidyClosed !== 0 ? { paidy_authorisation: paidyClosed < 0 ? "will_close" : "closed" } : {}) });
  } catch (e) {
    console.error("[cancel-cash-order] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
