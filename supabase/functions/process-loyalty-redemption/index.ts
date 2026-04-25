import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const VALID_TYPES = new Set([
  "new_order_discount",
  "shipping_fee",
  "service_fee",
]);

async function getUserRoles(supabase: any, userId: string): Promise<string[]> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  return (data ?? []).map((r: any) => r.role);
}

async function buildLoyaltyPortalUrl(supabase: any, customerId: string): Promise<string> {
  const { data: tokenRow } = await supabase
    .from("customer_portal_tokens")
    .select("token, expires_at")
    .eq("customer_id", customerId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (tokenRow?.token) {
    const expired = tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date();
    if (!expired) {
      return `https://portal.chajewelsjp.com/loyalty?token=${encodeURIComponent(tokenRow.token)}`;
    }
  }
  return "https://portal.chajewelsjp.com/portal";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const roles = await getUserRoles(supabase, user.id);
    const isAdmin = roles.includes("admin");
    const isFinance = roles.includes("finance");
    const isStaff = roles.includes("staff");

    const body = await req.json().catch(() => ({}));
    const action = body.action as string | undefined;

    if (!action || !["create", "approve", "cancel"].includes(action)) {
      return json({ error: "action must be 'create', 'approve', or 'cancel'" }, 400);
    }

    // ── CREATE ──────────────────────────────────────────────────────
    if (action === "create") {
      if (!(isAdmin || isFinance || isStaff)) {
        return json({ error: "Admin, finance, or staff role required" }, 403);
      }

      const {
        member_id,
        redemption_type,
        points_redeemed,
        invoice_number,
        account_id,
        cash_order_id,
        notes,
      } = body;

      if (!member_id || !redemption_type || points_redeemed == null || !invoice_number) {
        return json(
          { error: "member_id, redemption_type, points_redeemed, and invoice_number are required" },
          400,
        );
      }
      if (!VALID_TYPES.has(redemption_type)) {
        return json({ error: "Invalid redemption_type" }, 400);
      }
      const pts = Number(points_redeemed);
      if (!Number.isFinite(pts) || pts <= 0) {
        return json({ error: "points_redeemed must be > 0" }, 400);
      }

      const { data: member } = await supabase
        .from("loyalty_members")
        .select("id, customer_id, remaining_points")
        .eq("id", member_id)
        .maybeSingle();
      if (!member) return json({ error: "Member not found" }, 404);

      if (pts > Number(member.remaining_points ?? 0)) {
        return json({ error: "Insufficient points" }, 400);
      }

      // Invoice must be a new order
      let orderCurrency: string | null = null;

      if (account_id) {
        const { data: acct } = await supabase
          .from("layaway_accounts")
          .select("id, currency, total_paid, invoice_number")
          .eq("id", account_id)
          .maybeSingle();
        if (!acct) return json({ error: "Account not found" }, 404);
        if (Number(acct.total_paid ?? 0) > 0) {
          return json({ error: "Redemption only allowed on brand-new orders" }, 400);
        }
        if (acct.invoice_number !== invoice_number) {
          return json({ error: "Invoice number does not match account" }, 400);
        }
        orderCurrency = acct.currency;
      } else if (cash_order_id) {
        const { data: cash } = await supabase
          .from("cash_orders")
          .select("id, currency, created_at, invoice_number")
          .eq("id", cash_order_id)
          .maybeSingle();
        if (!cash) return json({ error: "Cash order not found" }, 404);
        const ageMs = Date.now() - new Date(cash.created_at).getTime();
        if (ageMs > 5 * 60 * 1000) {
          return json({ error: "Redemption only allowed on brand-new cash orders" }, 400);
        }
        if (cash.invoice_number !== invoice_number) {
          return json({ error: "Invoice number does not match cash order" }, 400);
        }
        orderCurrency = cash.currency;
      } else {
        const { data: existingLa } = await supabase
          .from("layaway_accounts")
          .select("id")
          .eq("invoice_number", invoice_number)
          .maybeSingle();
        if (existingLa) {
          return json({ error: "Invoice already exists on an in-progress layaway" }, 400);
        }
        const { data: existingCash } = await supabase
          .from("cash_orders")
          .select("id")
          .eq("invoice_number", invoice_number)
          .maybeSingle();
        if (existingCash) {
          return json({ error: "Invoice already exists on an in-progress cash order" }, 400);
        }
      }

      // Current rate
      const { data: rateSetting } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "php_jpy_rate")
        .maybeSingle();
      const rate = rateSetting ? Number(JSON.parse(String(rateSetting.value))) : 0;
      if (!rate) return json({ error: "php_jpy_rate not configured" }, 500);

      const valueJpy = pts;
      const valuePhp = orderCurrency === "PHP"
        ? Math.round(pts * rate * 100) / 100
        : null;

      const { data: redemption, error: insertErr } = await supabase
        .from("loyalty_redemptions")
        .insert({
          member_id,
          redemption_type,
          points_redeemed: pts,
          value_applied_jpy: valueJpy,
          value_applied_php: valuePhp,
          rate_snapshot: rate,
          invoice_number,
          account_id: account_id ?? null,
          cash_order_id: cash_order_id ?? null,
          status: "pending",
          notes: notes ?? null,
          created_by_user_id: user.id,
        })
        .select("id")
        .single();
      if (insertErr || !redemption) {
        console.error("[process-loyalty-redemption] create insert failed:", insertErr);
        return json({ error: "Failed to create redemption" }, 500);
      }

      return json({
        created: true,
        redemption_id: redemption.id,
        status: "pending",
        value_applied_jpy: valueJpy,
      });
    }

    // ── APPROVE ─────────────────────────────────────────────────────
    if (action === "approve") {
      if (!(isAdmin || isFinance || isStaff)) {
        return json({ error: "Admin, finance, or staff role required" }, 403);
      }

      const { redemption_id } = body;
      if (!redemption_id) return json({ error: "redemption_id is required" }, 400);

      const { data: redemption } = await supabase
        .from("loyalty_redemptions")
        .select("*")
        .eq("id", redemption_id)
        .maybeSingle();
      if (!redemption) return json({ error: "Redemption not found" }, 404);
      if (redemption.status !== "pending") {
        return json({ error: `Cannot approve redemption in status '${redemption.status}'` }, 400);
      }

      const { data: member } = await supabase
        .from("loyalty_members")
        .select(
          "id, customer_id, remaining_points, total_points_redeemed, current_tier_id",
        )
        .eq("id", redemption.member_id)
        .single();
      if (!member) return json({ error: "Member not found" }, 404);

      if (Number(redemption.points_redeemed) > Number(member.remaining_points ?? 0)) {
        return json({ error: "Insufficient points (balance changed since create)" }, 400);
      }

      const { data: tier } = await supabase
        .from("loyalty_tiers")
        .select("name")
        .eq("id", member.current_tier_id)
        .single();
      const tierName = tier?.name ?? null;

      const { data: txRow, error: txErr } = await supabase
        .from("loyalty_transactions")
        .insert({
          member_id: member.id,
          transaction_type: "redeemed",
          points_amount: -Number(redemption.points_redeemed),
          account_id: redemption.account_id,
          cash_order_id: redemption.cash_order_id,
          invoice_number: redemption.invoice_number,
          tier_at_time: tierName,
          notes: `Redemption: ${redemption.redemption_type}`,
        })
        .select("id")
        .single();
      if (txErr || !txRow) {
        console.error("[process-loyalty-redemption] redeemed tx insert failed:", txErr);
        return json({ error: "Failed to record redemption transaction" }, 500);
      }

      const { error: updRedErr } = await supabase
        .from("loyalty_redemptions")
        .update({
          status: "confirmed",
          transaction_id: txRow.id,
          processed_by_user_id: user.id,
          processed_at: new Date().toISOString(),
        })
        .eq("id", redemption.id);
      if (updRedErr) {
        console.warn(
          "[process-loyalty-redemption] redemption update failed (tx already inserted):",
          updRedErr,
        );
      }

      const newRemaining = Number(member.remaining_points ?? 0) -
        Number(redemption.points_redeemed);
      const newRedeemedTotal = Number(member.total_points_redeemed ?? 0) +
        Number(redemption.points_redeemed);

      const { error: updMemberErr } = await supabase
        .from("loyalty_members")
        .update({
          remaining_points: newRemaining,
          total_points_redeemed: newRedeemedTotal,
        })
        .eq("id", member.id);
      if (updMemberErr) {
        console.warn(
          "[process-loyalty-redemption] member balance update failed (manual reconcile):",
          updMemberErr,
        );
      }

      // Email + sheet sync — fire-and-forget
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("id, full_name, email")
          .eq("id", member.customer_id)
          .single();
        const recipientEmail = customer?.email;
        const customerName = customer?.full_name || "Valued Customer";

        if (recipientEmail) {
          const portalUrl = await buildLoyaltyPortalUrl(supabase, member.customer_id);
          await fetch(
            `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                templateName: "loyalty-redeem",
                recipientEmail,
                idempotencyKey: `loyalty-redeem-${redemption.id}`,
                templateData: {
                  customerName,
                  pointsRedeemed: Number(redemption.points_redeemed),
                  valueAppliedJpy: Number(redemption.value_applied_jpy),
                  valueAppliedPhp: redemption.value_applied_php != null
                    ? Number(redemption.value_applied_php)
                    : null,
                  redemptionType: redemption.redemption_type,
                  invoiceNumber: redemption.invoice_number,
                  remainingPoints: newRemaining,
                  portalUrl,
                },
              }),
            },
          ).catch((e) =>
            console.warn("[process-loyalty-redemption] redeem email failed:", e)
          );
        }

        if (customer) {
          await fetch(
            `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-loyalty-to-sheet`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                event_type: "redeemed",
                customer: {
                  customer_id: customer.id,
                  full_name: customer.full_name,
                  email: customer.email,
                },
                payload: {
                  points_amount: -Number(redemption.points_redeemed),
                  spend_amount_jpy: -Number(redemption.value_applied_jpy),
                  invoice_number: redemption.invoice_number,
                  redemption_type: redemption.redemption_type,
                },
              }),
            },
          ).catch((e) =>
            console.warn("[process-loyalty-redemption] sheet sync failed:", e)
          );
        }
      } catch (sideErr) {
        console.warn("[process-loyalty-redemption] side-effects block failed:", sideErr);
      }

      return json({
        approved: true,
        transaction_id: txRow.id,
        remaining_points: newRemaining,
      });
    }

    // ── CANCEL ──────────────────────────────────────────────────────
    if (action === "cancel") {
      if (!isAdmin) {
        return json({ error: "Admin role required to cancel" }, 403);
      }

      const { redemption_id, cancellation_reason } = body;
      if (!redemption_id) return json({ error: "redemption_id is required" }, 400);
      if (!cancellation_reason || !String(cancellation_reason).trim()) {
        return json({ error: "cancellation_reason is required" }, 400);
      }

      const { data: redemption } = await supabase
        .from("loyalty_redemptions")
        .select("id, status")
        .eq("id", redemption_id)
        .maybeSingle();
      if (!redemption) return json({ error: "Redemption not found" }, 404);
      if (redemption.status !== "pending") {
        return json(
          { error: `Cannot cancel redemption in status '${redemption.status}' — confirmed redemptions must be voided` },
          400,
        );
      }

      const cancelledAt = new Date().toISOString();
      const { error: updErr } = await supabase
        .from("loyalty_redemptions")
        .update({
          status: "cancelled",
          cancelled_by_user_id: user.id,
          cancelled_at: cancelledAt,
          cancellation_reason,
        })
        .eq("id", redemption_id);
      if (updErr) {
        console.error("[process-loyalty-redemption] cancel update failed:", updErr);
        return json({ error: "Failed to cancel redemption" }, 500);
      }

      return json({
        cancelled: true,
        redemption_id,
        cancelled_at: cancelledAt,
      });
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (err: any) {
    console.error("[process-loyalty-redemption] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
