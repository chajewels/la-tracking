// adjust-loyalty-points — admin/finance manual loyalty points adjustment.
//
// Scalar counters on loyalty_members are the authoritative balance
// (same model as process-loyalty-redemption / award-loyalty-points;
// lots remain shadow-only until the Phase 6.1 loyalty_lots cutover).
//
// Positive adjustments shadow-write an 'admin_adjust' lot via the
// existing insert_lot_and_extend RPC (mirrors award-loyalty-points,
// non-fatal). Negative adjustments do NOT consume lots — the canonical
// spend path (process-loyalty-redemption) doesn't either; full
// lot-consumption is deferred to Phase 6.1 where that infra is built.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { emitNotification } from "../_shared/emit-notification.ts";
import { checkPermission } from "../_shared/check-permission.ts";

// In-portal notification taxonomy tag for adjustments. The DB
// loyalty_notifications.category CHECK does not include this value, so
// the notification itself uses the canonical 'points' category; this
// constant records the logical type in the audit trail + sheet sync.
const NOTIFICATION_TYPE = "loyalty_adjusted";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface RequestBody {
  member_id?: string;
  points_delta?: number;
  reason?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json({ error: "Invalid auth token" }, 401);
    }
    const user = userData.user;

    // admin OR finance
    // Permission gate (Bug #203 Batch D: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "loyalty_adjust_points");
    if (!allowed) {
      return json({ error: "loyalty_adjust_points permission required" }, 403);
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const memberId = body.member_id;
    const pointsDelta = body.points_delta;
    const reason = (body.reason ?? "").trim();

    if (!memberId || typeof memberId !== "string") {
      return json({ error: "member_id is required" }, 400);
    }
    if (
      typeof pointsDelta !== "number" ||
      !Number.isFinite(pointsDelta) ||
      !Number.isInteger(pointsDelta) ||
      pointsDelta === 0
    ) {
      return json({ error: "points_delta must be a non-zero integer" }, 400);
    }
    if (reason.length < 10) {
      return json(
        { error: "reason is required (minimum 10 characters)" },
        400,
      );
    }

    // Step 1: member + tier
    const { data: member, error: memberErr } = await supabase
      .from("loyalty_members")
      .select(
        "id, customer_id, remaining_points, total_points_earned, total_points_redeemed, current_tier_id, current_tier:current_tier_id(name)",
      )
      .eq("id", memberId)
      .maybeSingle();

    if (memberErr) {
      console.error("[adjust-loyalty-points] member fetch failed:", memberErr);
      return json({ error: "Failed to load loyalty member" }, 500);
    }
    if (!member) {
      return json({ error: "Loyalty member not found" }, 404);
    }

    const tierName =
      ((member as any).current_tier?.name as string | undefined) ?? null;
    const beforeBalance = Number(member.remaining_points ?? 0);

    if (pointsDelta < 0 && Math.abs(pointsDelta) > beforeBalance) {
      return json(
        {
          error:
            `Cannot deduct ${Math.abs(pointsDelta)} points — current balance is only ${beforeBalance}`,
          current_balance: beforeBalance,
        },
        400,
      );
    }

    const afterBalance = beforeBalance + pointsDelta;

    // Step 2: ledger row
    const { data: txRow, error: txErr } = await supabase
      .from("loyalty_transactions")
      .insert({
        member_id: memberId,
        transaction_type: "adjusted",
        points_amount: pointsDelta,
        rate_snapshot: null,
        tier_at_time: tierName,
        notes: reason,
        created_by_user_id: user.id,
      })
      .select("id")
      .single();

    if (txErr || !txRow) {
      console.error("[adjust-loyalty-points] tx insert failed:", txErr);
      return json({ error: "Failed to record adjustment transaction" }, 500);
    }
    const txId: string = txRow.id;

    // Step 3a: positive → shadow-write an admin_adjust lot (12-month
    // expiry per Q2). Mirrors award-loyalty-points; non-fatal.
    if (pointsDelta > 0) {
      try {
        const earnedAt = new Date().toISOString();
        const expiresAt = new Date();
        expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 12);
        const { error: lotErr } = await supabase.rpc("insert_lot_and_extend", {
          p_member_id: memberId,
          p_source_type: "admin_adjust",
          p_source_reference: txId,
          p_amount: pointsDelta,
          p_earned_at: earnedAt,
          p_expires_at: expiresAt.toISOString(),
          p_notes: reason,
        });
        if (lotErr) {
          console.warn(
            "[adjust-loyalty-points] admin_adjust lot shadow write failed (non-fatal):",
            lotErr,
          );
        }
      } catch (e) {
        console.warn("[adjust-loyalty-points] lot shadow write threw (non-fatal):", e);
      }
    }
    // Step 3b: negative adjustments — scalar-authoritative, no lot
    // consumption (parity with process-loyalty-redemption; Phase 6.1).

    // Step 4: scalar counters (rollback the tx row if this fails)
    const memberUpdate = pointsDelta > 0
      ? {
        total_points_earned: Number(member.total_points_earned ?? 0) + pointsDelta,
        remaining_points: afterBalance,
        updated_at: new Date().toISOString(),
      }
      : {
        total_points_redeemed:
          Number(member.total_points_redeemed ?? 0) + Math.abs(pointsDelta),
        remaining_points: afterBalance,
        updated_at: new Date().toISOString(),
      };

    const { error: updErr } = await supabase
      .from("loyalty_members")
      .update(memberUpdate)
      .eq("id", memberId);

    if (updErr) {
      console.error(
        "[adjust-loyalty-points] member counter update failed — rolling back tx:",
        updErr,
      );
      await supabase.from("loyalty_transactions").delete().eq("id", txId);
      return json({ error: "Failed to update loyalty balance" }, 500);
    }

    // Step 5: audit log (real audit_logs schema)
    await supabase.from("audit_logs").insert({
      entity_type: "loyalty_member",
      entity_id: memberId,
      action: "loyalty_adjust",
      performed_by_user_id: user.id,
      new_value_json: {
        notification_type: NOTIFICATION_TYPE,
        transaction_id: txId,
        points_delta: pointsDelta,
        reason,
        before_balance: beforeBalance,
        after_balance: afterBalance,
      },
    });

    // Step 6: in-portal notification (both master + recipient rows via
    // the shared helper — Bug #100 lesson). Category 'points' is the
    // canonical valid category for a points-balance event.
    const abs = Math.abs(pointsDelta).toLocaleString("en-US");
    const body6 = pointsDelta > 0
      ? `Your loyalty points balance has been increased by ${abs} points. Reason: ${reason}. New balance: ${afterBalance.toLocaleString("en-US")} points.`
      : `Your loyalty points balance has been decreased by ${abs} points. Reason: ${reason}. New balance: ${afterBalance.toLocaleString("en-US")} points.`;
    await emitNotification(supabase, memberId, {
      category: "points",
      title: "Points balance adjusted",
      body: body6,
      link_target: "tab:points",
    });

    // Step 7: fire-and-forget sheet sync — 'adjusted' (Transactions tab)
    try {
      const { data: customer } = await supabase
        .from("customers")
        .select("id, customer_code, full_name, email")
        .eq("id", member.customer_id)
        .maybeSingle();
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            event_type: "adjusted",
            customer: {
              customer_id: member.customer_id,
              full_name: customer?.full_name ?? null,
              email: customer?.email ?? null,
            },
            payload: {
              member_id: customer?.customer_code ?? null,
              transaction_id: txId,
              points_amount: pointsDelta,
              spend_amount_jpy: null,
              tier_at_time: tierName,
              invoice_number: null,
              notes: reason,
              created_by: user.email ?? "admin",
            },
          }),
        },
      ).catch((e) =>
        console.warn("[adjust-loyalty-points] sheet sync failed (non-blocking):", e)
      );
    } catch (sheetErr) {
      console.warn(
        "[adjust-loyalty-points] sheet sync block failed (non-blocking):",
        sheetErr,
      );
    }

    return json({
      success: true,
      transaction_id: txId,
      new_remaining_points: afterBalance,
      tier_changed: false,
    });
  } catch (err) {
    console.error("[adjust-loyalty-points] unexpected error:", err);
    return json({ error: (err as Error).message || "internal_error" }, 500);
  }
});
