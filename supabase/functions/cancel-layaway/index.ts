import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import { sendLayawayCancelledEmail } from "../_shared/layaway-cancel-email.ts";

/**
 * cancel-layaway — staff Cancel for a layaway plan (owner, 2026-10-21; plan
 * claude/cancel-layaway-plan-2026-10-21.md).
 *
 * WHO: the Forfeit permission (forfeit_account) — owner decision, no new key.
 * WHAT: everything that changes the books happens in ONE transaction,
 * cancel_layaway_atomic (migration 20261227100000): reason required; refuses a
 * closed account and any payment submission still waiting (incl. split); earned
 * points revoked (revoke_loyalty_points, trigger 'cancel' — redeemed points are
 * NOT returned); status 'cancelled'; unpaid schedule rows cancelled; web stock
 * back once; the sales_log row out of commission; note; audit. A layaway NEVER
 * auto-issues store credit (STORE CREDIT rules).
 * PREVIEW ({ preview: true }) writes nothing and returns what the cancel would
 * do (money received, points that will be reversed, redeemed points not
 * returned, waiting submissions, refusal).
 * AFTER the commit, non-blocking (the cancel already stands): staff bell
 * 'account_cancelled' (+ 'loyalty_revoked' when points were reversed), the
 * customer portal "Points revoked" notice, and the customer email — web plans
 * the storefront email, Hub plans the Hub template (layaway-cancel-email.ts).
 */

const REFUSALS: Record<string, { status: number; message: string }> = {
  cancellation_reason_required: { status: 400, message: "A reason is required to cancel a layaway." },
  user_identity_required: { status: 400, message: "Your sign-in could not be identified. Sign in again and retry." },
  layaway_not_found: { status: 404, message: "Account not found." },
  layaway_not_cancellable: { status: 409, message: "This layaway is already closed and cannot be cancelled." },
  payment_submission_pending: { status: 409, message: "A payment submission on this layaway is still waiting. Confirm or reject it first, then cancel." },
};

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "forfeit_account");
  if (denied) return denied;
  const { supabase } = ctx;
  const user = ctx.user!;

  try {
    const body = await req.json().catch(() => ({}));
    const account_id = typeof body?.account_id === "string" ? body.account_id : "";
    const preview = body?.preview === true;
    const reason = typeof body?.reason === "string" ? body.reason : "";
    if (!account_id) return jsonResponse({ error: "account_id is required" }, 400);

    const { data, error } = await supabase.rpc("cancel_layaway_atomic", {
      p_account_id: account_id,
      p_reason: preview ? null : reason,
      p_user_id: user.id,
      p_user_email: user.email ?? null,
      p_preview: preview,
      p_source: "staff",
    });
    if (error) {
      const msg = String(error.message ?? "");
      const code = msg.split(":")[0].trim();
      const known = REFUSALS[code];
      if (known) return jsonResponse({ ok: false, error: known.message, code }, known.status);
      console.error("[cancel-layaway] cancel_layaway_atomic failed:", msg);
      return jsonResponse({ ok: false, error: "Failed to cancel the layaway: " + msg }, 500);
    }
    const result = (data ?? {}) as Record<string, any>;
    if (preview) return jsonResponse(result);

    const invoice = String(result.invoice_number ?? "");
    const ref = String(result.web_reference ?? invoice);
    const pointsReversed = result.earned_points_revoked_tx != null;

    let customerId: string | null = null;
    let customerName: string | null = null;
    try {
      const { data: acct } = await supabase
        .from("layaway_accounts")
        .select("customer_id, customers(full_name)")
        .eq("id", account_id)
        .single();
      customerId = (acct?.customer_id as string) ?? null;
      customerName = (acct as any)?.customers?.full_name ?? null;
    } catch (readErr) {
      console.warn("[cancel-layaway] post-commit account read failed (non-blocking):", readErr);
    }

    try {
      await supabase.from("staff_notifications").insert({
        type: "account_cancelled",
        title: "Layaway cancelled",
        body: `${customerName ? customerName + " — " : ""}Inv #${invoice} cancelled by ${user.email ?? "staff"}`,
        account_id,
        customer_id: customerId,
        invoice_number: invoice,
        metadata: {
          kind: "cancelled",
          money_received: result.money_received ?? 0,
          redeemed_points_not_returned: result.redeemed_points_not_returned ?? 0,
          earned_points_revoked_tx: result.earned_points_revoked_tx ?? null,
        },
      });
      if (pointsReversed) {
        await supabase.from("staff_notifications").insert({
          type: "loyalty_revoked",
          title: "Loyalty points revoked",
          body: `${customerName ? customerName + " — " : ""}Loyalty points earned on Inv #${invoice} were revoked (layaway cancelled)`,
          account_id,
          customer_id: customerId,
          invoice_number: invoice,
          metadata: { earned_points_revoked_tx: result.earned_points_revoked_tx, invoice_number: invoice },
        });
      }
    } catch (bellErr) {
      console.warn("[cancel-layaway] staff bell insert failed (non-blocking):", bellErr);
    }

    if (pointsReversed && customerId) {
      try {
        const { data: m } = await supabase.from("loyalty_members").select("id").eq("customer_id", customerId).maybeSingle();
        if (m?.id) {
          await emitNotification(supabase, m.id as string, {
            category: "points",
            title: "Points revoked",
            body: `The loyalty points earned on ${ref} have been revoked because the plan was cancelled.`,
            link_target: "tab:points",
          });
        }
      } catch (portalErr) {
        console.warn("[cancel-layaway] portal notification failed (non-blocking):", portalErr);
      }
    }

    try {
      await sendLayawayCancelledEmail(supabase, account_id, {
        pointsReversed,
        idempotencyKey: `layaway-cancelled-${account_id}-${result.cancelled_at ?? Date.now()}`,
      });
    } catch (emailErr) {
      console.warn("[cancel-layaway] email send failed (non-blocking):", emailErr);
    }

    return jsonResponse({ ok: true, ...result });
  } catch (err) {
    console.error("cancel-layaway error:", err);
    return jsonResponse({ ok: false, error: (err as Error).message }, 500);
  }
});
