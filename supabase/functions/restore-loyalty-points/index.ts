import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import { isServiceRole, parseJwtClaims } from "../_shared/jwt-claims.ts";
import { checkPermission } from "../_shared/check-permission.ts";
import { postAppEmail } from "../_shared/send-app-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type TriggerEvent =
  | "account_reactivated"
  | "payment_restored"
  | "manual_restore";

type RestoreReason =
  | "account_reactivated"
  | "payment_restored"
  | "manual_restore";

const TRIGGER_TO_REASON: Record<TriggerEvent, RestoreReason> = {
  account_reactivated: "account_reactivated",
  payment_restored: "payment_restored",
  manual_restore: "manual_restore",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gate = createLoyaltyEmailGate(supabase);

    // 1. Auth — service-role (inter-function calls) OR admin Bearer JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");
    let resolvedCreatedByUserId: string | null = null;
    if (!isServiceRole(token)) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return json({ error: "Unauthorized" }, 401);
      // Permission gate (Bug #203 Batch D: matrix-driven access — user JWT path only, service_role unchanged)
      const allowed = await checkPermission(supabase, user.id, "loyalty_revoke_points");
      if (!allowed) return json({ error: "loyalty_revoke_points permission required" }, 403);
      resolvedCreatedByUserId = user.id;
    }

    // 2. Parse + validate body
    const body = await req.json().catch(() => ({}));
    const { revoke_transaction_id, created_by_user_id, trigger_event } = body as {
      revoke_transaction_id?: string;
      created_by_user_id?: string;
      trigger_event?: TriggerEvent;
    };
    if (!revoke_transaction_id) {
      return json({ error: "revoke_transaction_id is required" }, 400);
    }
    const finalCreatedByUserId = created_by_user_id ?? resolvedCreatedByUserId;
    const resolvedTriggerEvent: TriggerEvent = trigger_event ?? "account_reactivated";
    const restoreReason: RestoreReason = TRIGGER_TO_REASON[resolvedTriggerEvent];

    // 3. Lookup revoke transaction → member_id (verify type='revoked')
    const { data: revokeTxn, error: lookupErr } = await supabase
      .from("loyalty_transactions")
      .select("id, member_id, transaction_type")
      .eq("id", revoke_transaction_id)
      .single();
    if (lookupErr || !revokeTxn) {
      return json({ error: "revoke transaction not found" }, 404);
    }
    if (revokeTxn.transaction_type !== "revoked") {
      return json(
        {
          error:
            "transaction is not a revoke transaction (transaction_type != 'revoked')",
        },
        400,
      );
    }
    const memberId = revokeTxn.member_id;

    // 4. Snapshot pre-restore
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
    const preTierMin = Number(preTier?.min_spend_jpy ?? 0);

    // 5. Call restore_loyalty_points RPC (idempotent — returns existing tx if already restored)
    const { data: rpcResult, error: rpcErr } = await supabase.rpc(
      "restore_loyalty_points",
      {
        p_revoke_transaction_id: revoke_transaction_id,
        p_created_by_user_id: finalCreatedByUserId,
      },
    );
    if (rpcErr) {
      console.error("[restore-loyalty-points] RPC failed:", rpcErr);
      return json(
        { error: "restore_loyalty_points RPC failed", detail: rpcErr.message },
        500,
      );
    }
    const restoreTransactionId = rpcResult as string;

    // 6. Snapshot post-restore
    const { data: postMember } = await supabase
      .from("loyalty_members")
      .select(
        "id, customer_id, current_tier_id, remaining_points, cumulative_spend_jpy, current_tier:current_tier_id(id, name, min_spend_jpy, points_multiplier)",
      )
      .eq("id", memberId)
      .single();
    const postTier = (postMember as any)?.current_tier;
    const postTierName: string = postTier?.name ?? preTierName;
    const postTierMin = Number(postTier?.min_spend_jpy ?? preTierMin);
    const postCurrentTierId =
      (postMember as any)?.current_tier_id ?? preMember.current_tier_id;
    const remainingPoints = Number(
      (postMember as any)?.remaining_points ?? 0,
    );
    const cumulativeSpendJpy = Number(
      (postMember as any)?.cumulative_spend_jpy ?? 0,
    );

    // 7. Detect tier upgrade (different tier id AND new tier min > old tier min)
    const tierUpgraded =
      preMember.current_tier_id !== postCurrentTierId &&
      postTierMin > preTierMin;

    // 8. If tier upgraded → email + in-portal notification
    if (tierUpgraded) {
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

      // 8a. Email — loyalty-tier-restored template (Bug #103)
      try {
        if (recipientEmail) {
          if (await gate("loyalty_email_tier_restored")) {
            const baseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`;
            const _emRes = await postAppEmail({
                templateName: "loyalty-tier-restored",
                recipientEmail,
                idempotencyKey: `loyalty-tier-restored-${memberId}-${postCurrentTierId}-${revoke_transaction_id}`,
                templateData: {
                  customerName,
                  oldTier: preTierName,
                  newTier: postTierName,
                  reason: restoreReason,
                  newMultiplier: Number(postTier?.points_multiplier ?? 1),
                  remainingPoints,
                  portalUrl,
                },
              }).catch((e) => {
              console.warn(
                "[restore-loyalty-points] loyalty-tier-restored email failed:",
                e,
              );
              return null;
            });
            if (_emRes && !_emRes.ok) {
              const _t = await _emRes.text().catch(() => "<no body>");
              console.error(`[restore-loyalty-points] app email (tier_restored) send failed (${_emRes.status}): ${_t}`);
            }
          } else {
            console.log(
              "[email-gate] loyalty-tier-restored skipped — toggle 'loyalty_email_tier_restored' is OFF",
            );
          }
        }
      } catch (emailErr) {
        console.warn(
          "[restore-loyalty-points] email block failed:",
          emailErr,
        );
      }

      // 8b. In-portal notification via emitNotification helper.
      // Bug #103 — switched from direct loyalty_notifications insert to
      // emitNotification helper. Direct insert was missing the recipient
      // row in loyalty_notification_recipients, causing INNER JOIN on
      // customer portal to filter the notification out. Same Bug #100-
      // style gap previously surfaced in revoke-loyalty-points.
      try {
        void emitNotification(supabase, memberId, {
          title: "Loyalty tier restored",
          body: `Your loyalty tier has been restored to ${postTierName}.`,
          category: "tier",
          link_target: portalUrl,
        });
      } catch (notifErr) {
        console.warn(
          "[restore-loyalty-points] emitNotification failed:",
          notifErr,
        );
      }
    }

    // 9. Return
    return json({
      ok: true,
      transaction_id: restoreTransactionId,
      pre_tier: preTierName,
      post_tier: postTierName,
      tier_upgraded: tierUpgraded,
      remaining_points: remainingPoints,
      cumulative_spend_jpy: cumulativeSpendJpy,
    });
  } catch (err: any) {
    console.error("[restore-loyalty-points] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
