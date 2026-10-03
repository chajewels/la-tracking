import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { maskEmail } from "../_shared/redact.ts";

const json = jsonResponse;

type TriggerEvent =
  | "void_layaway"
  | "void_cash"
  | "manual_forfeit"
  | "auto_forfeit"
  | "final_forfeit"
  | "edit_amount"
  | "delete_account"
  | "cancel";

type RevokeReason =
  | "payment_voided"
  | "account_forfeited"
  | "payment_edited"
  | "account_deleted"
  | "order_cancelled";

const TRIGGER_TO_REASON: Record<TriggerEvent, RevokeReason> = {
  void_layaway: "payment_voided",
  void_cash: "payment_voided",
  manual_forfeit: "account_forfeited",
  auto_forfeit: "account_forfeited",
  final_forfeit: "account_forfeited",
  edit_amount: "payment_edited",
  delete_account: "account_deleted",
  cancel: "order_cancelled",
};

const REASON_BODY: Record<RevokeReason, string> = {
  payment_voided:
    "A previous payment was voided, resulting in a change to your lifetime spend.",
  account_forfeited:
    "Due to the forfeit of this layaway account, associated loyalty benefits have been adjusted.",
  payment_edited:
    "A payment amount was adjusted, affecting your cumulative progress.",
  account_deleted:
    "Loyalty status adjustment following account closure.",
  order_cancelled:
    "An order was cancelled, so the points and lifetime spend it earned have been reversed.",
};

Deno.serve(async (req) => {
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  try {
    // 1. Auth — service-role (inter-function calls) OR a user holding
    //    loyalty_revoke_points (Bug #203 Batch D; matrix-driven). Shared
    //    helpers per CLAUDE.md "SHARED-HELPER CONVENTION" (moved from the
    //    inline copy 2026-09-29, Lovable scan finding L1).
    const ctx = await requireAuth(req, { allowServiceRole: true });
    if (ctx instanceof Response) return ctx;
    const denied = await requirePermission(ctx, "loyalty_revoke_points");
    if (denied) return denied;
    const supabase = ctx.supabase;
    const createdByUserId: string | null = ctx.user?.id ?? null;
    const gate = createLoyaltyEmailGate(supabase);

    // 2. Parse + validate body
    const body = await req.json().catch(() => ({}));
    const {
      member_id: bodyMemberId,
      customer_id,
      source_reference,
      spend_jpy,
      account_id,
      cash_order_id,
      payment_id,
      invoice_number,
      notes,
      trigger_event,
    } = body as {
      member_id?: string;
      customer_id?: string;
      source_reference?: string;
      spend_jpy?: number;
      account_id?: string;
      cash_order_id?: string;
      payment_id?: string;
      invoice_number?: string;
      notes?: string;
      trigger_event?: TriggerEvent;
    };

    if (!source_reference || typeof source_reference !== "string") {
      return json({ error: "source_reference is required" }, 400);
    }
    // spend_jpy is still required by the contract but NO LONGER decides the
    // reversal: revoke_loyalty_points derives the spend basis from the ledger
    // (Bug #271). Callers pass total_paid in JPY, which is money received —
    // not the order's loyalty basis — so honouring it reversed the wrong number.
    if (typeof spend_jpy !== "number" || !Number.isFinite(spend_jpy)) {
      return json({ error: "spend_jpy is required and must be a finite number" }, 400);
    }
    if (!trigger_event || !(trigger_event in TRIGGER_TO_REASON)) {
      return json(
        {
          error:
            "trigger_event is required and must be one of: void_layaway, void_cash, manual_forfeit, auto_forfeit, final_forfeit, edit_amount, delete_account, cancel",
        },
        400,
      );
    }
    if (!bodyMemberId && !customer_id) {
      return json({ error: "member_id or customer_id is required" }, 400);
    }

    // 3. Resolve member_id if not provided
    let memberId = bodyMemberId;
    if (!memberId) {
      const { data: memberLookup } = await supabase
        .from("loyalty_members")
        .select("id")
        .eq("customer_id", customer_id!)
        .maybeSingle();
      if (!memberLookup) {
        // Not a loyalty member: the order earned nothing, so there is nothing
        // to reverse. That is the correct outcome, not a failure — answer 200
        // so the forfeit/void callers stop logging it as an error (Lovable
        // scan 2026-09-29, invoice 18871).
        return json({ ok: true, no_op: true, reason: "not_a_member" });
      }
      memberId = memberLookup.id;
    }
    if (!memberId) {
      return json({ error: "member_id is required" }, 400);
    }

    // 4. Snapshot pre-revoke
    const { data: preMember, error: preErr } = await supabase
      .from("loyalty_members")
      .select(
        "id, customer_id, current_tier_id, remaining_points, cumulative_spend_jpy, current_tier:current_tier_id(id, name, min_spend_jpy, points_multiplier)",
      )
      .eq("id", memberId)
      .single();
    if (preErr || !preMember) {
      return json({ error: "loyalty_member not found" }, 404);
    }
    const preTier = (preMember as any).current_tier;
    const preTierName: string = preTier?.name ?? "Glimmer";

    // 5. Call revoke_loyalty_points RPC
    const { data: rpcResult, error: rpcErr } = await supabase.rpc(
      "revoke_loyalty_points",
      {
        p_member_id: memberId,
        p_source_reference: source_reference,
        p_spend_jpy: spend_jpy,
        p_account_id: account_id ?? null,
        p_cash_order_id: cash_order_id ?? null,
        p_payment_id: payment_id ?? null,
        p_invoice_number: invoice_number ?? null,
        p_notes: notes ?? null,
        p_created_by_user_id: createdByUserId,
        p_trigger_event: trigger_event,
      },
    );
    if (rpcErr) {
      console.error("[revoke-loyalty-points] RPC failed:", rpcErr);
      return json(
        { error: "revoke_loyalty_points RPC failed", detail: rpcErr.message },
        500,
      );
    }

    // 6. RPC returned NULL → no active lots matched → no-op
    if (rpcResult === null) {
      return json({ ok: true, no_op: true });
    }
    const transactionId = rpcResult as string;

    // 7. Snapshot post-revoke
    const { data: postMember } = await supabase
      .from("loyalty_members")
      .select(
        "id, customer_id, current_tier_id, remaining_points, cumulative_spend_jpy, current_tier:current_tier_id(id, name, min_spend_jpy, points_multiplier)",
      )
      .eq("id", memberId)
      .single();
    const postTier = (postMember as any)?.current_tier;
    const postTierName: string = postTier?.name ?? preTierName;
    const postCurrentTierId =
      (postMember as any)?.current_tier_id ?? preMember.current_tier_id;
    const remainingPoints = Number(
      (postMember as any)?.remaining_points ?? 0,
    );
    const cumulativeSpendJpy = Number(
      (postMember as any)?.cumulative_spend_jpy ?? 0,
    );

    // 8. Detect tier downgrade
    const tierDowngraded = preMember.current_tier_id !== postCurrentTierId;

    // 9. If tier downgraded → email + in-portal notification
    if (tierDowngraded) {
      const reason: RevokeReason = TRIGGER_TO_REASON[trigger_event];

      // Customer fetch (for email + notification name)
      const { data: customer } = await supabase
        .from("customers")
        .select("full_name, email")
        .eq("id", preMember.customer_id)
        .single();
      const customerName = customer?.full_name || "Valued Customer";
      const recipientEmail = customer?.email;
      const portalUrl = await buildPortalLinkForCustomerId(
        supabase,
        preMember.customer_id,
        "loyalty",
      );

      // 9a. Email — fire-and-forget
      try {
        if (recipientEmail) {
          if (await gate("loyalty_email_tier_revoked")) {
            const baseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`;
            const result = await sendTemplateEmail(
              "loyalty-tier-revoked",
              recipientEmail,
              {
                templateData: {
                  customerName,
                  oldTier: preTierName,
                  newTier: postTierName,
                  reason,
                  remainingPoints,
                  portalUrl,
                },
                idempotencyKey: `loyalty-tier-revoked-${memberId}-${transactionId}`,
              },
            );
            if (!result.sent) {
              console.log(`[revoke-loyalty-points] "loyalty-tier-revoked" suppressed for ${maskEmail(recipientEmail)}`);
            }
          } else {
            console.log(
              "[email-gate] loyalty-tier-revoked skipped — toggle 'loyalty_email_tier_revoked' is OFF",
            );
          }
        }
      } catch (emailErr) {
        console.warn(
          "[revoke-loyalty-points] email block failed:",
          emailErr,
        );
      }

      // 9b. In-portal notification — uses shared emitNotification helper.
      // Writes both loyalty_notifications master row AND
      // loyalty_notification_recipients row. Required for customer portal
      // INNER JOIN visibility — direct master-only inserts get orphaned.
      // Email handled separately by step 9a above; send_email=false here.
      void emitNotification(supabase, memberId, {
        category: "tier",
        title: "Your loyalty tier has been adjusted",
        body: REASON_BODY[reason],
        link_target: portalUrl,
        send_email: false,
      });
    }

    // 9c. Sync to Google Sheet (revoked) — mirrors award-loyalty-points; fire-and-forget, non-blocking.
    try {
      const { data: txRow } = await supabase
        .from("loyalty_transactions")
        .select("points_amount, spend_amount_jpy, invoice_number, notes")
        .eq("id", transactionId)
        .single();
      const { data: cust } = await supabase
        .from("customers")
        .select("customer_code, full_name, email")
        .eq("id", (preMember as any).customer_id)
        .single();
      const revSyncRes = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            event_type: "revoked",
            customer: {
              customer_id: (preMember as any).customer_id,
              full_name: (cust as any)?.full_name ?? null,
              email: (cust as any)?.email ?? null,
            },
            payload: {
              member_id: (cust as any)?.customer_code ?? null,
              transaction_id: transactionId,
              points_amount: (txRow as any)?.points_amount ?? null,
              spend_amount_jpy: (txRow as any)?.spend_amount_jpy ?? spend_jpy ?? null,
              tier_at_time: postTierName,
              invoice_number: (txRow as any)?.invoice_number ?? invoice_number ?? null,
              account_id: account_id ?? null,
              notes: (txRow as any)?.notes ?? notes ?? "",
              created_by: "system",
            },
          }),
        },
      );
      if (revSyncRes.ok) {
        await supabase.from("loyalty_transactions")
          .update({ synced_to_sheet_at: new Date().toISOString() })
          .eq("id", transactionId);
      } else {
        const _t = await revSyncRes.text().catch(() => "");
        console.error(`[revoke-loyalty-points] sync-loyalty-to-sheet (revoked) failed (${revSyncRes.status}): ${_t} — marker left NULL so loyalty-sheet-reconcile will retry`);
      }
    } catch (sheetErr) {
      console.warn("[revoke-loyalty-points] sheet sync (revoked) block failed (non-blocking):", sheetErr);
    }

    // 10. Return
    return json({
      ok: true,
      transaction_id: transactionId,
      no_op: false,
      pre_tier: preTierName,
      post_tier: postTierName,
      tier_downgraded: tierDowngraded,
      remaining_points: remainingPoints,
      cumulative_spend_jpy: cumulativeSpendJpy,
    });
  } catch (err: any) {
    console.error("[revoke-loyalty-points] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
