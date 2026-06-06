import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLoyaltyEmailGate } from "../_shared/loyalty-email-gate.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import {
  buildRedemptionApprovedNotification,
  buildRedemptionCancelledNotification,
} from "../_shared/loyalty-notification-templates.ts";

// Phase 4.2 — for in-portal redemption notifications. Catalog rewards
// resolve to loyalty_rewards.name; the 3 legacy enum types use a
// human-readable label.
const REDEMPTION_TYPE_LABELS: Record<string, string> = {
  new_order_discount: "New order discount",
  shipping_fee: "Shipping fee",
  service_fee: "Service fee",
  catalog_reward: "Reward",
};

async function resolveRewardName(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  redemption: { reward_id?: string | null; redemption_type?: string | null },
): Promise<string> {
  if (redemption.reward_id) {
    const { data: reward } = await supabase
      .from("loyalty_rewards")
      .select("name")
      .eq("id", redemption.reward_id)
      .maybeSingle();
    if (reward?.name) return reward.name as string;
  }
  return REDEMPTION_TYPE_LABELS[redemption.redemption_type ?? ""] ?? "Your reward";
}

// Type-aware "Reward approved" bell body. new_order_discount keeps the
// shared builder's exact output; shipping_fee / service_fee /
// catalog_reward use an inline body that surfaces the customer's notes
// (points-only types carry no order, so notes are the review context).
// Local-only (no _shared change) to confine the deploy surface.
function buildApprovedNotif(
  redemption: { redemption_type?: string | null; notes?: string | null },
  rewardName: string,
  points: number,
): { title: string; body: string } {
  if (redemption.redemption_type === "new_order_discount") {
    return buildRedemptionApprovedNotification({ rewardName, points });
  }
  const label =
    REDEMPTION_TYPE_LABELS[redemption.redemption_type ?? ""] ?? "reward";
  const noteText = String(redemption.notes ?? "").slice(0, 500);
  return {
    title: "Reward approved 🎁",
    body:
      `Your ${label} redemption (${points.toLocaleString("en-US")} points) was approved. ` +
      `Note: "${noteText}". We'll be in touch about next steps.`,
  };
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gate = createLoyaltyEmailGate(supabase);

    const authHeader = req.headers.get("Authorization");
    const body = await req.json().catch(() => ({}));
    const action = body.action as string | undefined;

    if (!action || !["create", "approve", "cancel", "void"].includes(action)) {
      return json(
        { error: "action must be 'create', 'approve', 'cancel', or 'void'" },
        400,
      );
    }

    // Auth — try internal-role auth first (admin/finance/staff via
    // Supabase Auth + roles table). For 'create', if no internal role,
    // fall through to resolvePortalAuth so customer self-service
    // redemptions work via Bearer JWT (Phase B session-auth) or
    // portal_token (legacy token-auth). approve/cancel/void require
    // a real internal user JWT — their respective branch role checks
    // would reject customer auth anyway, so we 401 early here.
    let user: { id: string } | null = null;
    let roles: string[] = [];
    let customerId: string | null = null;

    if (authHeader) {
      const { data: { user: authUser } } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", ""),
      );
      if (authUser) {
        user = authUser;
        roles = await getUserRoles(supabase, authUser.id);
      }
    }
    const isAdmin = roles.includes("admin");
    const isFinance = roles.includes("finance");
    const isStaff = roles.includes("staff");
    const isInternal = isAdmin || isFinance || isStaff;

    if (!isInternal && action === "create") {
      // Customer self-service path
      try {
        const auth = await resolvePortalAuth(supabase, {
          authHeader,
          portal_token: body.portal_token,
          session_id: body.session_id,
        });
        customerId = auth.customer_id;
      } catch {
        return json({ error: "Unauthorized" }, 401);
      }
    } else if (!user) {
      // approve/cancel/void or unauthenticated 'create' caller
      return json({ error: "Unauthorized" }, 401);
    }

    // ── CREATE ──────────────────────────────────────────────────────
    // Customer self-service (resolvePortalAuth → customerId set) OR
    // internal user (admin/finance/staff). When customerId is set,
    // member_id ownership is verified below before any DB writes.
    if (action === "create") {
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
      if (redemption_type === 'new_order_discount' && !rawInvoiceNumber) {
        return json(
          { error: "invoice_number is required for new_order_discount" },
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

      // Customer self-service ownership check — member_id must belong
      // to the authenticated customer. Internal users bypass this
      // (admin/staff act on behalf of any member).
      if (customerId) {
        const { data: memberCheck } = await supabase
          .from("loyalty_members")
          .select("id, customer_id")
          .eq("id", member_id)
          .maybeSingle();
        if (!memberCheck || memberCheck.customer_id !== customerId) {
          return json(
            { error: "Member does not belong to authenticated customer" },
            403,
          );
        }
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

      // Type-aware order validation (design correction 2026-05-19):
      //  - new_order_discount: requires exactly one brand-new FK + matching invoice
      //  - shipping_fee / service_fee: STRICT points-only — no FK, no invoice,
      //    notes required (owner rule 2026-05-19)
      //  - catalog_reward: skips order-link checks (reward validated above)
      if (redemption_type === 'new_order_discount') {
        if (!account_id && !cash_order_id) {
          return json(
            { error: "account_id or cash_order_id is required for new_order_discount" },
            400,
          );
        }
        if (account_id && cash_order_id) {
          return json(
            { error: "Specify either account_id or cash_order_id, not both" },
            400,
          );
        }
        if (!trimmedInvoice) {
          return json(
            { error: "invoice_number is required for new_order_discount" },
            400,
          );
        }
        if (account_id) {
          const { data: acct } = await supabase
            .from("layaway_accounts")
            .select("id, currency, total_paid, invoice_number")
            .eq("id", account_id)
            .maybeSingle();
          if (!acct) return json({ error: "Account not found" }, 404);
          if (Number(acct.total_paid ?? 0) > 0) {
            return json(
              { error: "new_order_discount only allowed on brand-new orders (no payments yet)" },
              400,
            );
          }
          if (acct.invoice_number !== trimmedInvoice) {
            return json({ error: "Invoice number does not match account" }, 400);
          }
          orderCurrency = acct.currency;
        } else {
          const { data: cash } = await supabase
            .from("cash_orders")
            .select("id, currency, status, total_paid, invoice_number")
            .eq("id", cash_order_id)
            .maybeSingle();
          if (!cash) return json({ error: "Cash order not found" }, 404);
          if (cash.status !== 'pending' || Number(cash.total_paid ?? 0) > 0) {
            return json(
              { error: "new_order_discount only allowed on brand-new cash orders (status='pending', no payments yet)" },
              400,
            );
          }
          if (cash.invoice_number !== trimmedInvoice) {
            return json({ error: "Invoice number does not match cash order" }, 400);
          }
          orderCurrency = cash.currency;
        }
      } else if (redemption_type === 'shipping_fee' || redemption_type === 'service_fee') {
        // STRICT RULE (owner 2026-05-19): shipping/service redemptions are
        // points-only. They MUST NOT reference any account or cash order.
        if (account_id || cash_order_id) {
          return json(
            {
              error: `${redemption_type} redemptions cannot be linked to an account or cash order — they are points-only operations`,
            },
            400,
          );
        }
        if (trimmedInvoice) {
          return json(
            {
              error: `${redemption_type} redemptions cannot include invoice_number — they are points-only operations`,
            },
            400,
          );
        }
        if (!notes || !String(notes).trim()) {
          return json(
            {
              error: `notes is required for ${redemption_type} redemptions (used for tracking and customer notification)`,
            },
            400,
          );
        }
        if (String(notes).length > 500) {
          return json(
            { error: `notes exceeds 500 characters` },
            400,
          );
        }
      }
      // catalog_reward: no order-link validation (reward validated earlier).

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

      // invoice_number: user-submitted for new_order_discount (always
      // present + validated above); NULL for shipping_fee / service_fee /
      // catalog_reward (column is nullable as of 2026-05-19 — points-only
      // types carry no invoice). No REDEEM-{id} placeholder anymore.
      const insertInvoice = trimmedInvoice ?? null;

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
          created_by_user_id: user?.id ?? null,
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
        invoice_number: insertInvoice,
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

      // Single-call atomic approve: writes loyalty_transactions, updates
      // loyalty_redemptions + loyalty_members, decrements catalog stock,
      // reduces target loyalty_jpy_amount, inserts the synthetic payment
      // (layaway or cash) + updates account totals/status, and writes
      // audit_logs in one transaction. Stock depletion now aborts with
      // reward_out_of_stock (409, zero writes) instead of the legacy
      // "approved but cancel manually" path. The redemption_not_pending /
      // insufficient_points re-checks here are authoritative under lock —
      // the friendly upstream checks above only give fast errors.
      const { data: approveResult, error: approveErr } = await supabase.rpc(
        "approve_redemption_atomic",
        { p_redemption_id: redemption.id, p_user_id: user.id, p_user_email: user.email ?? "Admin" }
      );
      if (approveErr) {
        const msg = approveErr.message ?? String(approveErr);
        if (msg.includes("redemption_not_pending")) return json({ error: "Redemption is no longer pending" }, 400);
        if (msg.includes("insufficient_points")) return json({ error: "Insufficient points (balance changed since create)" }, 400);
        if (msg.includes("reward_out_of_stock")) return json({ error: "Reward out of stock — approval aborted, nothing was debited" }, 409);
        if (msg.includes("not_found")) return json({ error: "Redemption or member not found" }, 404);
        console.error("[process-loyalty-redemption] approve_redemption_atomic failed:", approveErr);
        return json({ error: "Approve failed — no changes were applied", detail: msg }, 500);
      }

      // approveResult shape (returned by the RPC):
      //   { transaction_id, payment_id, new_remaining_points, tier_name,
      //     account_status, payment_amount, currency }

      // Email + sheet sync — fire-and-forget
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("id, customer_code, full_name, email")
          .eq("id", member.customer_id)
          .single();
        const recipientEmail = customer?.email;
        const customerName = customer?.full_name || "Valued Customer";

        if (recipientEmail) {
          if (await gate("loyalty_email_redeem")) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, member.customer_id, 'loyalty');
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
                    notes: redemption.notes ?? null,
                    remainingPoints: (approveResult as any)?.new_remaining_points ?? 0,
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
                  member_id: customer.customer_code ?? null,
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

      // Phase 4.2 — in-portal notification (fire-and-forget, never throws).
      // Sent on the normal approval path. The stock-race-loss path above
      // also emits before its 409 return because points were already
      // debited there.
      const approvedRewardName = await resolveRewardName(supabase, redemption);
      await emitNotification(supabase, redemption.member_id, {
        category: "redemption",
        ...buildApprovedNotif(
          redemption,
          approvedRewardName,
          Number(redemption.points_redeemed),
        ),
        link_target: "tab:points",
      });

      return json({
        approved: true,
        transaction_id: (approveResult as any)?.transaction_id ?? null,
        remaining_points: (approveResult as any)?.new_remaining_points ?? 0,
        payment_id: (approveResult as any)?.payment_id ?? null,
        account_status: (approveResult as any)?.account_status ?? null,
        payment_amount: (approveResult as any)?.payment_amount ?? null,
        currency: (approveResult as any)?.currency ?? null,
      });
    }

    // ── CANCEL ──────────────────────────────────────────────────────
    if (action === "cancel") {
      if (!isAdmin) {
        return json({ error: "Admin role required to cancel" }, 403);
      }
      // Cancel branch handles status='pending' only.
      // For status='confirmed' (already-approved redemptions
      // that need reversal), use the 'void' action below — it
      // refunds points + re-increments stock atomically.

      const { redemption_id, cancellation_reason } = body;
      if (!redemption_id) return json({ error: "redemption_id is required" }, 400);
      if (!cancellation_reason || !String(cancellation_reason).trim()) {
        return json({ error: "cancellation_reason is required" }, 400);
      }

      const { data: redemption } = await supabase
        .from("loyalty_redemptions")
        .select("id, status, member_id, reward_id, redemption_type, points_redeemed")
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

      // Phase 4.2 — in-portal notification with the admin reason.
      const cancelledRewardName = await resolveRewardName(supabase, redemption);
      await emitNotification(supabase, redemption.member_id, {
        category: "redemption",
        ...buildRedemptionCancelledNotification({
          rewardName: cancelledRewardName,
          reason: String(cancellation_reason),
        }),
        link_target: "tab:points",
      });

      return json({
        cancelled: true,
        redemption_id,
        cancelled_at: cancelledAt,
      });
    }

    // ── VOID (Phase 3.2.1) ──────────────────────────────────────────
    // Reverses an already-approved (status='confirmed') redemption:
    // refunds points, re-increments catalog stock if applicable,
    // audit-logs, emits Phase 4.2 cancellation notification. Race-safe
    // via WHERE-clause status guard on the loyalty_redemptions UPDATE
    // — concurrent void attempts cleanly fail with 409 after rolling
    // back the refund-tx insert.
    if (action === "void") {
      if (!isAdmin) {
        return json({ error: "Admin role required to void" }, 403);
      }

      const { redemption_id } = body;
      if (!redemption_id) {
        return json({ error: "redemption_id is required" }, 400);
      }

      const trimmedReason = String(body.void_reason ?? "").trim();
      if (!trimmedReason) {
        return json({ error: "void_reason is required" }, 400);
      }
      if (trimmedReason.length > 500) {
        return json({ error: "void_reason exceeds 500 chars" }, 400);
      }

      // Step 1: Fetch redemption (need transaction_id, account_id,
      // cash_order_id for refund-tx parity with the original debit).
      const { data: redemption, error: fetchErr } = await supabase
        .from("loyalty_redemptions")
        .select(
          "id, status, member_id, reward_id, redemption_type, points_redeemed, transaction_id, account_id, cash_order_id, invoice_number",
        )
        .eq("id", redemption_id)
        .maybeSingle();
      if (fetchErr) {
        console.error("[process-loyalty-redemption] void fetch failed:", fetchErr);
        return json({ error: "Failed to fetch redemption" }, 500);
      }
      if (!redemption) {
        return json({ error: "Redemption not found" }, 404);
      }
      if (redemption.status !== "confirmed") {
        return json(
          {
            error: `Cannot void redemption in status '${redemption.status}' — only confirmed redemptions can be voided`,
          },
          400,
        );
      }

      const pointsToRefund = Number(redemption.points_redeemed);
      if (!Number.isFinite(pointsToRefund) || pointsToRefund <= 0) {
        return json({ error: "Invalid points_redeemed on redemption" }, 500);
      }

      // Step 2: Fetch member for current balance + tier.
      const { data: member, error: memberErr } = await supabase
        .from("loyalty_members")
        .select(
          "id, customer_id, remaining_points, total_points_redeemed, current_tier_id",
        )
        .eq("id", redemption.member_id)
        .single();
      if (memberErr || !member) {
        console.error("[process-loyalty-redemption] void member fetch failed:", memberErr);
        return json({ error: "Member not found" }, 404);
      }

      const { data: tier } = await supabase
        .from("loyalty_tiers")
        .select("name")
        .eq("id", member.current_tier_id)
        .single();
      const tierName = tier?.name ?? null;

      const beforeBalance = Number(member.remaining_points ?? 0);
      const beforeRedeemedTotal = Number(member.total_points_redeemed ?? 0);

      // Step 3: INSERT refund tx row with type='refunded' (enum value
      // added by C1 SQL). invoice_number deliberately null — the
      // refund is decoupled from the original invoice context. Notes
      // carry the original transaction_id for forensic linkage.
      const idShort = String(redemption.id).slice(0, 8);
      const refundNotes = redemption.transaction_id
        ? `Refund of voided redemption #${idShort} — original tx: ${redemption.transaction_id}`
        : `Refund of voided redemption #${idShort}`;
      const { data: refundTxRow, error: refundTxErr } = await supabase
        .from("loyalty_transactions")
        .insert({
          member_id: member.id,
          transaction_type: "refunded",
          points_amount: pointsToRefund,
          account_id: redemption.account_id,
          cash_order_id: redemption.cash_order_id,
          invoice_number: null,
          tier_at_time: tierName,
          notes: refundNotes,
        })
        .select("id")
        .single();
      if (refundTxErr || !refundTxRow) {
        console.error(
          "[process-loyalty-redemption] void refund tx insert failed:",
          refundTxErr,
        );
        return json({ error: "Failed to record refund transaction" }, 500);
      }

      // Step 4: UPDATE redemption with race-safe lock — only flip
      // 'confirmed' → 'cancelled'. Concurrent void attempts produce
      // 0 affected rows on the loser; we roll back the refund tx
      // and return 409.
      const cancelledAt = new Date().toISOString();
      const { data: updatedRows, error: updRedErr } = await supabase
        .from("loyalty_redemptions")
        .update({
          status: "cancelled",
          cancelled_by_user_id: user.id,
          cancelled_at: cancelledAt,
          cancellation_reason: trimmedReason,
        })
        .eq("id", redemption_id)
        .eq("status", "confirmed")
        .select("id");
      if (updRedErr) {
        console.error(
          "[process-loyalty-redemption] void redemption update failed:",
          updRedErr,
        );
        await supabase.from("loyalty_transactions").delete().eq("id", refundTxRow.id);
        return json({ error: "Failed to update redemption" }, 500);
      }
      if (!updatedRows || updatedRows.length === 0) {
        console.warn(
          "[process-loyalty-redemption] void race detected — redemption no longer 'confirmed':",
          { redemption_id },
        );
        await supabase.from("loyalty_transactions").delete().eq("id", refundTxRow.id);
        return json(
          {
            error: "Redemption was voided concurrently — refresh and retry",
            race: true,
          },
          409,
        );
      }

      // Step 5: UPDATE member balance — credit back points, decrement
      // total_points_redeemed (clamp at 0 for defensive sanity; can't
      // underflow under normal flow but guards against historical drift).
      const newRemaining = beforeBalance + pointsToRefund;
      const newRedeemedTotal = Math.max(0, beforeRedeemedTotal - pointsToRefund);
      const { error: updMemberErr } = await supabase
        .from("loyalty_members")
        .update({
          remaining_points: newRemaining,
          total_points_redeemed: newRedeemedTotal,
        })
        .eq("id", member.id);
      if (updMemberErr) {
        console.warn(
          "[process-loyalty-redemption] void member balance update failed (manual reconcile):",
          updMemberErr,
        );
      }

      // Phase B — reverse synthetic payment for non-catalog redemptions.
      // Order-side reversal fires ONLY for new_order_discount with a real FK.
      // shipping_fee/service_fee are points-only (owner rule 2026-05-19) and
      // catalog_reward never had a synthetic payment — nothing to reverse on
      // the order side. Member refund + loyalty_transactions reversal +
      // redemption status flip (earlier in this handler) still fire for all.
      if (
        redemption.redemption_type === 'new_order_discount' &&
        (redemption.account_id || redemption.cash_order_id)
      ) {
        try {
          const refRef = `LOYALTY-${redemption.id}`;
          const truncatedVoidReason = trimmedReason.slice(0, 250);
          const voidNotes = `Loyalty redemption voided: ${truncatedVoidReason}`;
          // Net-spend reversal (owner 2026-05-26): voiding a new_order_discount restores the
          // order's gross loyalty eligibility. Self-fetches value_applied_jpy (the void Step-1
          // select omits it). Runs once (void status guard WHERE status='confirmed'). Non-blocking.
          {
            const { data: redJpyRow } = await supabase
              .from("loyalty_redemptions").select("value_applied_jpy").eq("id", redemption.id).maybeSingle();
            const restoreJpy = Number(redJpyRow?.value_applied_jpy ?? 0);
            if (restoreJpy > 0) {
              const ljTable = redemption.account_id ? "layaway_accounts" : "cash_orders";
              const ljId = redemption.account_id ?? redemption.cash_order_id;
              const { data: ljOrd } = await supabase
                .from(ljTable).select("loyalty_jpy_amount").eq("id", ljId).maybeSingle();
              const ljNext = Number(ljOrd?.loyalty_jpy_amount ?? 0) + restoreJpy;
              const { error: ljErr } = await supabase
                .from(ljTable).update({ loyalty_jpy_amount: ljNext }).eq("id", ljId);
              if (ljErr) console.warn(
                "[process-loyalty-redemption] loyalty_jpy_amount net-restore failed (manual reconcile):",
                { redemption_id: redemption.id, ljTable, ljId, err: ljErr });
            }
          }

          if (redemption.account_id) {
            const { data: existingPay } = await supabase
              .from("payments")
              .select("id, voided_at, amount_paid")
              .eq("reference_number", refRef)
              .maybeSingle();
            if (existingPay && !existingPay.voided_at) {
              const { error: voidPayErr } = await supabase
                .from("payments")
                .update({
                  voided_at: new Date().toISOString(),
                  voided_by_user_id: user.id,
                  void_reason: voidNotes,
                })
                .eq("id", existingPay.id);
              if (voidPayErr) {
                console.warn(
                  "[process-loyalty-redemption] synthetic layaway payment void UPDATE failed:",
                  { redemption_id: redemption.id, payment_id: existingPay.id, err: voidPayErr },
                );
              } else {
                // Phase B Patch 3 — inline reversal of Patch 2's APPROVE allocation chain.
                // Mirror image: read allocations → revert schedule rows → delete allocations →
                // revert account totals. Same hard-fail-on-error pattern as Patch 2.
                // Note: existingPay carries the payment row that was just voided in the
                // preceding UPDATE; reuse its id + amount_paid here.

                // 1. Fetch all allocations linked to the voided payment
                const { data: allocations, error: allocsFetchErr } = await supabase
                  .from("payment_allocations")
                  .select("id, schedule_id, allocated_amount, allocation_type")
                  .eq("payment_id", existingPay.id);

                if (allocsFetchErr) {
                  console.error(
                    "[process-loyalty-redemption] failed to fetch allocations for void cleanup:",
                    { redemption_id: redemption.id, payment_id: existingPay.id, err: allocsFetchErr },
                  );
                  return json(
                    {
                      error: "Failed to fetch payment_allocations for void cleanup",
                      detail: allocsFetchErr.message,
                      redemption_id: redemption.id,
                      payment_id: existingPay.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                // 2. For each allocation, revert the schedule row, then DELETE the allocation
                for (const alloc of (allocations || [])) {
                  // Read current schedule row state
                  const { data: row, error: rowReadErr } = await supabase
                    .from("layaway_schedule")
                    .select("id, total_due_amount, paid_amount, status, due_date")
                    .eq("id", alloc.schedule_id)
                    .single();

                  if (rowReadErr || !row) {
                    console.error(
                      "[process-loyalty-redemption] failed to read schedule row for void cleanup:",
                      { redemption_id: redemption.id, schedule_id: alloc.schedule_id, err: rowReadErr },
                    );
                    return json(
                      {
                        error: "Failed to read schedule row for void reversal",
                        detail: rowReadErr?.message ?? "no row",
                        redemption_id: redemption.id,
                        schedule_id: alloc.schedule_id,
                        manual_action_required: true,
                      },
                      500,
                    );
                  }

                  const newPaid = Math.max(0, Number(row.paid_amount) - Number(alloc.allocated_amount));
                  const due = Number(row.total_due_amount);

                  // Status reversal rule (mirror of Patch 2's status rule):
                  //   if newPaid >= due (shouldn't normally happen on void since we're decrementing) → keep 'paid'
                  //   else if newPaid === 0 AND due_date < today → 'overdue'
                  //   else if newPaid === 0 → 'pending'
                  //   else if row was 'paid' → revert to 'overdue' if past due_date, else 'partially_paid'
                  //   else keep existing status (overdue/partially_paid stays)
                  const todayStr = new Date().toISOString().slice(0, 10);
                  const isOverdueDate = row.due_date < todayStr;
                  let newStatus: string;
                  if (newPaid >= due) {
                    newStatus = "paid"; // edge case — shouldn't occur on void of a legitimate allocation
                  } else if (newPaid === 0) {
                    newStatus = isOverdueDate ? "overdue" : "pending";
                  } else if (row.status === "paid") {
                    newStatus = isOverdueDate ? "overdue" : "partially_paid";
                  } else {
                    newStatus = row.status; // overdue / partially_paid stay
                  }

                  const { error: schedUpdErr } = await supabase
                    .from("layaway_schedule")
                    .update({ paid_amount: newPaid, status: newStatus })
                    .eq("id", row.id);

                  if (schedUpdErr) {
                    console.error(
                      "[process-loyalty-redemption] schedule UPDATE failed during void cleanup:",
                      { redemption_id: redemption.id, schedule_id: row.id, err: schedUpdErr },
                    );
                    return json(
                      {
                        error: "Schedule UPDATE failed during void reversal",
                        detail: schedUpdErr.message,
                        redemption_id: redemption.id,
                        schedule_id: row.id,
                        manual_action_required: true,
                      },
                      500,
                    );
                  }

                  // DELETE the allocation row (FK is RESTRICT on schedule_id, but we're deleting
                  // the allocation itself, not the schedule — no FK conflict)
                  const { error: allocDelErr } = await supabase
                    .from("payment_allocations")
                    .delete()
                    .eq("id", alloc.id);

                  if (allocDelErr) {
                    console.error(
                      "[process-loyalty-redemption] payment_allocations DELETE failed during void cleanup:",
                      { redemption_id: redemption.id, allocation_id: alloc.id, err: allocDelErr },
                    );
                    return json(
                      {
                        error: "payment_allocations DELETE failed during void reversal",
                        detail: allocDelErr.message,
                        redemption_id: redemption.id,
                        allocation_id: alloc.id,
                        manual_action_required: true,
                      },
                      500,
                    );
                  }
                }

                // 3. Revert account totals (decrement total_paid, increment remaining_balance)
                const refundAmount = Number(existingPay.amount_paid ?? 0);
                const { data: acctNow, error: acctReadErr } = await supabase
                  .from("layaway_accounts")
                  .select("total_paid, remaining_balance, status")
                  .eq("id", redemption.account_id)
                  .single();

                if (acctReadErr || !acctNow) {
                  console.error(
                    "[process-loyalty-redemption] failed to read account during void cleanup:",
                    { redemption_id: redemption.id, err: acctReadErr },
                  );
                  return json(
                    {
                      error: "Failed to read account for totals reversal",
                      detail: acctReadErr?.message ?? "no row",
                      redemption_id: redemption.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                const newTotalPaid = Math.max(0, Number(acctNow.total_paid) - refundAmount);
                const newRemaining = Number(acctNow.remaining_balance) + refundAmount;

                // Account status reversal: if was 'completed' and remaining > 0 now → revert
                // to 'active' or 'overdue' depending on any remaining overdue rows.
                let newAccountStatus = acctNow.status;
                if (acctNow.status === "completed" && newRemaining > 0.01) {
                  const { data: anyOverdue } = await supabase
                    .from("layaway_schedule")
                    .select("id")
                    .eq("account_id", redemption.account_id)
                    .eq("status", "overdue")
                    .limit(1);
                  newAccountStatus = (anyOverdue && anyOverdue.length > 0) ? "overdue" : "active";
                }

                const { error: acctUpdErr } = await supabase
                  .from("layaway_accounts")
                  .update({
                    total_paid: newTotalPaid,
                    remaining_balance: newRemaining,
                    status: newAccountStatus,
                  })
                  .eq("id", redemption.account_id);

                if (acctUpdErr) {
                  console.error(
                    "[process-loyalty-redemption] account totals UPDATE failed during void cleanup:",
                    { redemption_id: redemption.id, err: acctUpdErr },
                  );
                  return json(
                    {
                      error: "Account totals UPDATE failed during void reversal",
                      detail: acctUpdErr.message,
                      redemption_id: redemption.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                // Reversal chain complete — synthetic payment voided, allocations deleted,
                // schedule rows reverted, account totals decremented.
              }
            } else if (!existingPay) {
              console.warn(
                "[process-loyalty-redemption] synthetic layaway payment not found for void (legacy redemption?):",
                { redemption_id: redemption.id, ref: refRef },
              );
            }
          } else if (redemption.cash_order_id) {
            const { data: existingPay } = await supabase
              .from("cash_payments")
              .select("id, voided_at")
              .eq("reference_number", refRef)
              .maybeSingle();
            if (existingPay && !existingPay.voided_at) {
              const { error: voidPayErr } = await supabase
                .from("cash_payments")
                .update({
                  voided_at: new Date().toISOString(),
                  voided_by_user_id: user.id,
                  void_reason: voidNotes,
                })
                .eq("id", existingPay.id);
              if (voidPayErr) {
                console.warn(
                  "[process-loyalty-redemption] synthetic cash payment void UPDATE failed:",
                  { redemption_id: redemption.id, payment_id: existingPay.id, err: voidPayErr },
                );
              } else {
                const { data: sumRows } = await supabase
                  .from("cash_payments")
                  .select("amount_paid")
                  .eq("cash_order_id", redemption.cash_order_id)
                  .is("voided_at", null);
                const newTotalPaid = (sumRows ?? []).reduce(
                  (acc: number, r: any) => acc + Number(r.amount_paid ?? 0), 0,
                );
                const { data: orderRow } = await supabase
                  .from("cash_orders")
                  .select("total_amount, status")
                  .eq("id", redemption.cash_order_id)
                  .maybeSingle();
                const cashTotalAmount = Number(orderRow?.total_amount ?? 0);
                const newRemaining = cashTotalAmount - newTotalPaid;
                const cashUpdate: Record<string, any> = {
                  total_paid: newTotalPaid,
                  remaining_balance: newRemaining,
                  updated_at: new Date().toISOString(),
                };
                if (orderRow?.status === 'completed' && newRemaining > 0) {
                  cashUpdate.status = 'pending';
                  cashUpdate.completed_at = null;
                }
                const { error: cashUpdErr } = await supabase
                  .from("cash_orders")
                  .update(cashUpdate)
                  .eq("id", redemption.cash_order_id);
                if (cashUpdErr) {
                  console.warn(
                    "[process-loyalty-redemption] cash_orders totals update failed after void:",
                    { redemption_id: redemption.id, err: cashUpdErr },
                  );
                }
              }
            } else if (!existingPay) {
              console.warn(
                "[process-loyalty-redemption] synthetic cash payment not found for void (legacy redemption?):",
                { redemption_id: redemption.id, ref: refRef },
              );
            }
          }
        } catch (revErr) {
          console.warn(
            "[process-loyalty-redemption] discount reversal block failed (manual reconcile needed):",
            { redemption_id: redemption.id, err: revErr },
          );
        }
      }

      // Step 6: Stock re-increment for catalog rewards. Skip silently
      // when stock is unlimited (NULL); warn-and-continue when reward
      // row was deleted between approval and void.
      let stockReIncremented = false;
      if (redemption.reward_id) {
        const { data: rewardRow, error: rewardFetchErr } = await supabase
          .from("loyalty_rewards")
          .select("current_stock")
          .eq("id", redemption.reward_id)
          .maybeSingle();
        if (rewardFetchErr) {
          console.warn(
            "[process-loyalty-redemption] void reward fetch failed (skipping stock re-increment):",
            rewardFetchErr,
          );
        } else if (!rewardRow) {
          console.warn(
            "[process-loyalty-redemption] void stock re-increment skipped — reward row missing",
            { reward_id: redemption.reward_id },
          );
        } else if (rewardRow.current_stock == null) {
          // Unlimited stock; no-op. Not a warning.
        } else {
          const { error: incErr } = await supabase
            .from("loyalty_rewards")
            .update({ current_stock: Number(rewardRow.current_stock) + 1 })
            .eq("id", redemption.reward_id);
          if (incErr) {
            console.warn(
              "[process-loyalty-redemption] void stock re-increment failed (manual reconcile):",
              incErr,
            );
          } else {
            stockReIncremented = true;
          }
        }
      }

      // Step 7: Audit log
      await supabase.from("audit_logs").insert({
        entity_type: "loyalty_redemption",
        entity_id: redemption.id,
        action: "redemption_voided",
        performed_by_user_id: user.id,
        old_value_json: {
          status: "confirmed",
          member_remaining_points: beforeBalance,
        },
        new_value_json: {
          status: "cancelled",
          cancellation_reason: trimmedReason,
          member_remaining_points: newRemaining,
          refund_transaction_id: refundTxRow.id,
          stock_re_incremented: stockReIncremented,
        },
      });

      // Step 8: Email — fire-and-forget transactional email parallel
      // to the approve branch. Never throws; failures are logged.
      // Skipped silently if the customer has no email on file or the
      // gate 'loyalty_email_redemption_voided' is OFF.
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("id, full_name, email")
          .eq("id", member.customer_id)
          .single();
        const recipientEmail = customer?.email;
        const customerName = customer?.full_name || "Valued Customer";

        if (recipientEmail) {
          if (await gate("loyalty_email_redemption_voided")) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, member.customer_id, 'loyalty');
            await fetch(
              `${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                },
                body: JSON.stringify({
                  templateName: "loyalty-redemption-voided",
                  recipientEmail,
                  idempotencyKey: `loyalty-redemption-voided-${redemption.id}`,
                  templateData: {
                    customerName,
                    pointsRefunded: pointsToRefund,
                    voidReason: trimmedReason,
                    redemptionType: redemption.redemption_type,
                    invoiceNumber: redemption.invoice_number,
                    newRemainingPoints: newRemaining,
                    voidedAt: cancelledAt,
                    portalUrl,
                  },
                }),
              },
            ).catch((e) =>
              console.warn("[process-loyalty-redemption] void email failed:", e)
            );
          } else {
            console.log(
              "[email-gate] loyalty-redemption-voided skipped — toggle 'loyalty_email_redemption_voided' is OFF",
            );
          }
        }
      } catch (sideErr) {
        console.warn("[process-loyalty-redemption] void email side-effects block failed:", sideErr);
      }

      // Step 9: Phase 4.2 cancellation notification (reuse the same
      // template + emit pattern as the cancel branch).
      const voidedRewardName = await resolveRewardName(supabase, redemption);
      await emitNotification(supabase, redemption.member_id, {
        category: "redemption",
        ...buildRedemptionCancelledNotification({
          rewardName: voidedRewardName,
          reason: trimmedReason,
        }),
        link_target: "tab:points",
      });

      // Step 10: Google Sheet sync — emit "revoked" (canonical taxonomy).
      // Fire-and-forget, isolated; never blocks the void success return.
      try {
        const { data: revokeCustomer } = await supabase
          .from("customers")
          .select("id, customer_code, full_name, email")
          .eq("id", member.customer_id)
          .single();
        if (revokeCustomer) {
          await fetch(
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
                  customer_id: revokeCustomer.id,
                  full_name: revokeCustomer.full_name,
                  email: revokeCustomer.email,
                },
                payload: {
                  member_id: revokeCustomer.customer_code ?? null,
                  transaction_id: refundTxRow.id,
                  points_amount: pointsToRefund,
                  invoice_number: redemption.invoice_number,
                  notes: `Voided redemption refund${
                    trimmedReason ? ` — ${trimmedReason}` : ""
                  }`,
                  created_by: user.email ?? "system",
                },
              }),
            },
          ).catch((e) =>
            console.warn("[process-loyalty-redemption] sheet sync (revoked) failed:", e)
          );
        }
      } catch (sheetErr) {
        console.warn(
          "[process-loyalty-redemption] sheet sync (revoked) block failed:",
          sheetErr,
        );
      }

      // Non-blocking account_notes trail. Only writes when the redemption
      // is linked to a layaway account or cash order. A failure here must
      // NEVER fail or roll back the void.
      if (redemption.account_id || redemption.cash_order_id) {
        try {
          await supabase.from("account_notes").insert({
            account_id: redemption.account_id ?? null,
            cash_order_id: redemption.cash_order_id ?? null,
            note_text: `Loyalty: redemption voided — ${redemption.points_redeemed} pts refunded (${redemption.redemption_type})`,
            created_by_user_id: user.id,
            created_by_name: "System (Loyalty)",
          });
        } catch (noteErr) {
          console.warn("[process-loyalty-redemption] void account note failed (non-blocking):", noteErr);
        }
      }

      return json({
        voided: true,
        redemption_id: redemption.id,
        points_refunded: pointsToRefund,
        stock_re_incremented: stockReIncremented,
      });
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (err: any) {
    console.error("[process-loyalty-redemption] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
