import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";

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
  "catalog_reward",
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
    const gate = createLoyaltyEmailGate(supabase);

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
        redemption_type: rawRedemptionType,
        points_redeemed,
        invoice_number: rawInvoiceNumber,
        account_id,
        cash_order_id,
        notes,
        reward_id,
      } = body;

      // When reward_id is provided, redemption_type defaults to
      // 'catalog_reward' and invoice_number is optional (a placeholder
      // will be generated). Otherwise both are required.
      const redemption_type =
        rawRedemptionType ?? (reward_id ? "catalog_reward" : null);

      if (!member_id || !redemption_type || points_redeemed == null) {
        return json(
          { error: "member_id, redemption_type, and points_redeemed are required" },
          400,
        );
      }
      if (!reward_id && !rawInvoiceNumber) {
        return json(
          { error: "invoice_number is required when reward_id is not provided" },
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

      // Validate reward (catalog redemption path)
      if (reward_id) {
        const { data: reward, error: rewardErr } = await supabase
          .from("loyalty_rewards")
          .select("id, points_cost, current_stock, is_active")
          .eq("id", reward_id)
          .maybeSingle();
        if (rewardErr || !reward) {
          return json({ error: "Reward not found" }, 404);
        }
        if (!reward.is_active) {
          return json({ error: "Reward is not active" }, 400);
        }
        if (reward.current_stock != null && Number(reward.current_stock) <= 0) {
          return json({ error: "Reward out of stock" }, 409);
        }
        if (Number(reward.points_cost) !== pts) {
          return json(
            {
              error: `Points mismatch — expected ${reward.points_cost}, got ${pts}`,
            },
            400,
          );
        }
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

      // Invoice must be a new order — only enforced when an
      // invoice_number is being claimed against a real layaway/cash
      // order. Catalog redemptions without an invoice skip this block;
      // a placeholder invoice_number is assigned post-INSERT below.
      let orderCurrency: string | null = null;
      const trimmedInvoice =
        typeof rawInvoiceNumber === "string" ? rawInvoiceNumber.trim() : null;

      if (trimmedInvoice) {
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
          if (acct.invoice_number !== trimmedInvoice) {
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
          if (cash.invoice_number !== trimmedInvoice) {
            return json({ error: "Invoice number does not match cash order" }, 400);
          }
          orderCurrency = cash.currency;
        } else {
          const { data: existingLa } = await supabase
            .from("layaway_accounts")
            .select("id")
            .eq("invoice_number", trimmedInvoice)
            .maybeSingle();
          if (existingLa) {
            return json({ error: "Invoice already exists on an in-progress layaway" }, 400);
          }
          const { data: existingCash } = await supabase
            .from("cash_orders")
            .select("id")
            .eq("invoice_number", trimmedInvoice)
            .maybeSingle();
          if (existingCash) {
            return json({ error: "Invoice already exists on an in-progress cash order" }, 400);
          }
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

      // Catalog redemptions without a real invoice get a placeholder.
      // We use a temp value during INSERT (column is NOT NULL), then
      // UPDATE with REDEEM-{id} once the row has its UUID assigned so
      // every redemption row carries a unique, traceable invoice
      // string keyed to its own id.
      const insertInvoice = trimmedInvoice ?? "REDEEM-PENDING";

      const { data: redemption, error: insertErr } = await supabase
        .from("loyalty_redemptions")
        .insert({
          member_id,
          redemption_type,
          points_redeemed: pts,
          value_applied_jpy: valueJpy,
          value_applied_php: valuePhp,
          rate_snapshot: rate,
          invoice_number: insertInvoice,
          account_id: account_id ?? null,
          cash_order_id: cash_order_id ?? null,
          reward_id: reward_id ?? null,
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

      // Replace placeholder invoice_number with REDEEM-{redemption.id}
      // so the value is unique and forensically traceable.
      let finalInvoice = insertInvoice;
      if (!trimmedInvoice) {
        finalInvoice = `REDEEM-${redemption.id}`;
        const { error: invUpdErr } = await supabase
          .from("loyalty_redemptions")
          .update({ invoice_number: finalInvoice })
          .eq("id", redemption.id);
        if (invUpdErr) {
          console.warn(
            "[process-loyalty-redemption] invoice_number patch failed (manual fix needed):",
            invUpdErr,
          );
        }
      }

      return json({
        created: true,
        redemption_id: redemption.id,
        invoice_number: finalInvoice,
        status: "pending",
        value_applied_jpy: valueJpy,
      });
    }

    // ── APPROVE ─────────────────────────────────────────────────────
    if (action === "approve") {
      if (!(isAdmin || isFinance)) {
        return json({ error: "Admin or finance role required" }, 403);
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

      await supabase.from("audit_logs").insert({
        entity_type: "loyalty_redemption",
        entity_id: redemption.id,
        action: "redemption_approved",
        performed_by_user_id: user.id,
        old_value_json: { status: "pending" },
        new_value_json: {
          status: "confirmed",
          transaction_id: txRow.id,
          points_redeemed: Number(redemption.points_redeemed),
          redemption_type: redemption.redemption_type,
          invoice_number: redemption.invoice_number,
        },
      });

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

      // Stock decrement for catalog rewards. Atomic via WHERE clause
      // so concurrent approvals can't drive current_stock negative.
      // Unlimited rewards (current_stock IS NULL) skip silently.
      if (redemption.reward_id) {
        const { data: rewardBefore } = await supabase
          .from("loyalty_rewards")
          .select("current_stock")
          .eq("id", redemption.reward_id)
          .maybeSingle();

        const prevStock = rewardBefore?.current_stock ?? null;
        if (prevStock != null) {
          const { data: decremented, error: stockErr } = await supabase
            .from("loyalty_rewards")
            .update({ current_stock: Number(prevStock) - 1 })
            .eq("id", redemption.reward_id)
            .gt("current_stock", 0)
            .select("id, current_stock");

          if (stockErr) {
            console.warn(
              "[process-loyalty-redemption] stock decrement failed (manual reconcile):",
              stockErr,
            );
          } else if (!decremented || decremented.length === 0) {
            // Race: stock raced to 0 between create-time validation
            // and approval. The approval already wrote the
            // loyalty_transactions row + member balance update; admin
            // must manually cancel/refund and reconcile stock.
            console.error(
              "[process-loyalty-redemption] stock raced to 0 — redemption approved but stock could not be decremented:",
              { redemption_id: redemption.id, reward_id: redemption.reward_id },
            );
            return json(
              {
                error:
                  "Reward stock raced to 0 — redemption was approved and points debited; cancel and refund customer manually",
                approved: true,
                transaction_id: txRow.id,
                remaining_points: newRemaining,
                stock_race: true,
              },
              409,
            );
          } else {
            const newStock = Number(decremented[0].current_stock);
            await supabase.from("audit_logs").insert({
              entity_type: "loyalty_reward",
              entity_id: redemption.reward_id,
              action: "stock_decremented",
              performed_by_user_id: user.id,
              old_value_json: { current_stock: prevStock },
              new_value_json: {
                current_stock: newStock,
                redemption_id: redemption.id,
              },
            });
          }
        }
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
          if (await gate("loyalty_email_redeem")) {
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
          } else {
            console.log(
              "[email-gate] loyalty-redeem skipped — toggle 'loyalty_email_redeem' is OFF",
            );
          }
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
      // TODO Phase 3.2.1: cancel only operates on status='pending', so
      // stock has not been decremented yet — no re-increment needed
      // here. A future "void" action that reverses an already-approved
      // catalog redemption MUST re-increment loyalty_rewards.current_stock
      // and write a stock_incremented audit entry. That void action
      // does not exist today.

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

      await supabase.from("audit_logs").insert({
        entity_type: "loyalty_redemption",
        entity_id: redemption_id,
        action: "redemption_cancelled",
        performed_by_user_id: user.id,
        old_value_json: { status: "pending" },
        new_value_json: {
          status: "cancelled",
          cancellation_reason,
          cancelled_at: cancelledAt,
        },
      });

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
