import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

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
    if (token !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return json({ error: "Unauthorized" }, 401);
      const { data: isAdmin } = await supabase.rpc("has_role", {
        _user_id: user.id,
        _role: "admin",
      });
      if (!isAdmin) return json({ error: "Admin access required" }, 403);
      resolvedCreatedByUserId = user.id;
    }

    // 2. Parse + validate body
    const body = await req.json().catch(() => ({}));
    const { revoke_transaction_id, created_by_user_id } = body as {
      revoke_transaction_id?: string;
      created_by_user_id?: string;
    };
    if (!revoke_transaction_id) {
      return json({ error: "revoke_transaction_id is required" }, 400);
    }
    const finalCreatedByUserId = created_by_user_id ?? resolvedCreatedByUserId;

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

      // 8a. Email — REUSE existing loyalty-tier-upgrade template
      try {
        if (recipientEmail) {
          if (await gate("loyalty_email_tier_upgrade")) {
            const baseUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`;
            await fetch(baseUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                templateName: "loyalty-tier-upgrade",
                recipientEmail,
                // Distinct prefix from award path's natural key — allows re-notification on oscillation
                idempotencyKey: `loyalty-tier-upgrade-restore-${memberId}-${postCurrentTierId}-${revoke_transaction_id}`,
                templateData: {
                  customerName,
                  oldTier: preTierName,
                  newTier: postTierName,
                  newMultiplier: Number(postTier?.points_multiplier ?? 1),
                  cumulativeSpendJpy,
                  remainingPoints,
                  portalUrl,
                },
              }),
            }).catch((e) =>
              console.warn(
                "[restore-loyalty-points] loyalty-tier-upgrade email failed:",
                e,
              )
            );
          } else {
            console.log(
              "[email-gate] loyalty-tier-upgrade skipped — toggle 'loyalty_email_tier_upgrade' is OFF",
            );
          }
        }
      } catch (emailErr) {
        console.warn(
          "[restore-loyalty-points] email block failed:",
          emailErr,
        );
      }

      // 8b. In-portal notification (fire-and-forget)
      try {
        const { error: notifErr } = await supabase
          .from("loyalty_notifications")
          .insert({
            title: "Loyalty tier restored",
            body: `Your loyalty tier has been restored to ${postTierName}.`,
            category: "tier",
            audience_type: "specific",
            audience_member_ids: [memberId],
            status: "sent",
            link_target: portalUrl,
          });
        if (notifErr) {
          console.warn(
            "[restore-loyalty-points] notification insert failed:",
            notifErr,
          );
        }
      } catch (notifErr) {
        console.warn(
          "[restore-loyalty-points] notification block failed:",
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
