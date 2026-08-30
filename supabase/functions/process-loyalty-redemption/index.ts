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
    let user: { id: string; email?: string } | null = null;
    let roles: string[] = [];
    let customerId: string | null = null;

    if (authHeader) {
      const { data: { user: authUser } } = await supabase.auth.getUser(
        authHeader.replace("Bearer ", ""),
      );
      if (authUser) {
        user = authUser as { id: string; email?: string };
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

      // ── DUPLICATE GUARD (new_order_discount only) ──────────────────────
      // Block a repeat request with the SAME member + SAME invoice + SAME
      // points while a prior request is still active (pending or confirmed).
      // A cancelled prior does NOT block — customer may re-request.
      if (redemption_type === 'new_order_discount' && insertInvoice) {
        const { data: dupe } = await supabase
          .from("loyalty_redemptions")
          .select("id")
          .eq("member_id", member_id)
          .eq("invoice_number", insertInvoice)
          .eq("points_redeemed", pts)
          .in("status", ["pending", "confirmed"])
          .maybeSingle();
        if (dupe) {
          return json(
            { error: "duplicate_redemption",
              message: "This redemption request has already been submitted." },
            409,
          );
        }
      }

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

      // Staff bell — non-blocking. Mirrors review-payment-submission's
      // staff_notifications pattern. account_id is the layaway link (NULL
      // for cash-order-linked or points-only); cash_order_id rides in
      // metadata per the existing "Cash order created" convention.
      try {
        const { data: requestCust } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", member.customer_id)
          .maybeSingle();
        const requestName = requestCust?.full_name || "Customer";
        const invSuffix = insertInvoice ? ` · Inv #${insertInvoice}` : "";
        await supabase.from("staff_notifications").insert({
          type: "redemption_requested",
          title: "Redemption requested",
          body: `${requestName} requested ${pts} pts (${redemption_type})${invSuffix}`,
          account_id: account_id ?? null,
          customer_id: member.customer_id,
          invoice_number: insertInvoice,
          metadata: {
            redemption_id: redemption.id,
            points_redeemed: pts,
            redemption_type,
            ...(cash_order_id ? { cash_order_id } : {}),
          },
        });
      } catch (nErr) {
        console.warn("[process-loyalty-redemption] staff_notifications insert (create) failed (non-blocking):", nErr);
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
      if (!isInternal || !user) {
        return json({ error: "Internal role required" }, 403);
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

      // Hoisted customer fetch — used by the email/sheet-sync side-effects
      // block AND the staff_notifications insert below. Single lookup
      // instead of duplicating.
      const { data: approveCustomer } = await supabase
        .from("customers")
        .select("id, customer_code, full_name, email")
        .eq("id", member.customer_id)
        .maybeSingle();

      // Email + sheet sync — fire-and-forget
      try {
        const customer = approveCustomer;
        const recipientEmail = customer?.email;
        const customerName = customer?.full_name || "Valued Customer";

        if (recipientEmail) {
          if (await gate("loyalty_email_redeem")) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, member.customer_id, 'loyalty');
            const _emRes1 = await fetch(
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
            ).catch((e) => {
              console.warn("[process-loyalty-redemption] redeem email failed:", e);
              return null;
            });
            if (_emRes1 && !_emRes1.ok) {
              const _t = await _emRes1.text().catch(() => "<no body>");
              console.error(`[process-loyalty-redemption] send-transactional-email (redeem) failed (${_emRes1.status}): ${_t}`);
            }
          } else {
            console.log(
              "[email-gate] loyalty-redeem skipped — toggle 'loyalty_email_redeem' is OFF",
            );
          }
        }

        if (customer) {
          const _syncRes1 = await fetch(
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
          ).catch((e) => {
            console.warn("[process-loyalty-redemption] sheet sync failed:", e);
            return null;
          });
          if (_syncRes1 && !_syncRes1.ok) {
            const _t = await _syncRes1.text().catch(() => "<no body>");
            console.error(`[process-loyalty-redemption] sync-loyalty-to-sheet (redeemed) failed (${_syncRes1.status}): ${_t}`);
          }
        }
      } catch (sideErr) {
        console.warn("[process-loyalty-redemption] side-effects block failed:", sideErr);
      }

      // Staff bell — non-blocking. Reuses hoisted approveCustomer.
      try {
        const approvedName = approveCustomer?.full_name || "Customer";
        const invSuffixApp = redemption.invoice_number ? ` · Inv #${redemption.invoice_number}` : "";
        await supabase.from("staff_notifications").insert({
          type: "redemption_approved",
          title: "Redemption approved",
          body: `${Number(redemption.points_redeemed)} pts (${redemption.redemption_type}) for ${approvedName} — approved by ${user.email ?? "Admin"}${invSuffixApp}`,
          account_id: redemption.account_id ?? null,
          customer_id: member.customer_id,
          invoice_number: redemption.invoice_number,
          metadata: {
            redemption_id: redemption.id,
            points_redeemed: Number(redemption.points_redeemed),
            redemption_type: redemption.redemption_type,
            ...(redemption.cash_order_id ? { cash_order_id: redemption.cash_order_id } : {}),
          },
        });
      } catch (nErr) {
        console.warn("[process-loyalty-redemption] staff_notifications insert (approve) failed (non-blocking):", nErr);
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
      if ((!isAdmin && !isStaff) || !user) {
        return json({ error: "Admin or staff role required to cancel" }, 403);
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
        .select("id, status, member_id, reward_id, redemption_type, points_redeemed, account_id, cash_order_id, invoice_number")
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

      // Staff bell — non-blocking. Look up customer_id via the member.
      try {
        const { data: cancelMember } = await supabase
          .from("loyalty_members")
          .select("customer_id")
          .eq("id", redemption.member_id)
          .maybeSingle();
        const cancelCustomerId = cancelMember?.customer_id ?? null;
        let cancelName = "Customer";
        if (cancelCustomerId) {
          const { data: cust } = await supabase
            .from("customers")
            .select("full_name")
            .eq("id", cancelCustomerId)
            .maybeSingle();
          cancelName = cust?.full_name || "Customer";
        }
        await supabase.from("staff_notifications").insert({
          type: "redemption_cancelled",
          title: "Redemption cancelled",
          body: `${Number(redemption.points_redeemed)} pts (${redemption.redemption_type}) for ${cancelName} — cancelled by ${user.email ?? "Admin"}: ${cancellation_reason}`,
          account_id: redemption.account_id ?? null,
          customer_id: cancelCustomerId,
          invoice_number: redemption.invoice_number ?? null,
          metadata: {
            redemption_id,
            points_redeemed: Number(redemption.points_redeemed),
            redemption_type: redemption.redemption_type,
            ...(redemption.cash_order_id ? { cash_order_id: redemption.cash_order_id } : {}),
          },
        });
      } catch (nErr) {
        console.warn("[process-loyalty-redemption] staff_notifications insert (cancel) failed (non-blocking):", nErr);
      }

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
      // 1. Auth gate — void is destructive (cancels a confirmed redemption +
      // refunds points + reverses order-side discount). Admin-only by design.
      if (!isAdmin || !user) {
        return json({ error: "Admin role required to void" }, 403);
      }

      // 2. Input validation
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

      // 3. Fetch context for side effects (staff bell, email, sheet sync).
      // The RPC re-fetches and locks the redemption row internally; this
      // pre-read is purely for the post-RPC non-atomic side effects.
      const { data: redemption, error: ctxFetchErr } = await supabase
        .from("loyalty_redemptions")
        .select(
          "id, member_id, reward_id, redemption_type, points_redeemed, account_id, cash_order_id, invoice_number",
        )
        .eq("id", redemption_id)
        .maybeSingle();
      if (ctxFetchErr) {
        console.error("[process-loyalty-redemption] void context fetch failed:", ctxFetchErr);
        return json({ error: "Failed to fetch redemption context" }, 500);
      }
      if (!redemption) {
        return json({ error: "Redemption not found" }, 404);
      }

      const { data: member } = await supabase
        .from("loyalty_members")
        .select("id, customer_id")
        .eq("id", redemption.member_id)
        .maybeSingle();

      // 4. Atomic void via RPC — handles refund tx insert, redemption status
      // flip with race guard, member balance restore, order-side reversal
      // (loyalty_jpy restore + synthetic payment void + allocation revert +
      // schedule row revert + account totals revert), stock re-increment,
      // audit_logs insert, and account_notes insert — all in a single
      // transaction. Any failure rolls back every write.
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        "void_redemption_atomic",
        {
          p_redemption_id: redemption_id,
          p_user_id: user.id,
          p_user_email: user.email ?? "",
          p_void_reason: trimmedReason,
        },
      );

      if (rpcErr) {
        const msg = rpcErr.message ?? "";
        console.error("[process-loyalty-redemption] void_redemption_atomic failed:", rpcErr);

        if (msg.includes("redemption_not_found")) {
          return json({ error: "Redemption not found" }, 404);
        }
        if (msg.includes("redemption_not_confirmed")) {
          const status = msg.split(":").slice(1).join(":").trim();
          return json({
            error: `Cannot void redemption in status '${status}' — only confirmed redemptions can be voided`,
          }, 400);
        }
        if (msg.includes("redemption_void_race")) {
          return json({
            error: "Redemption was voided concurrently — refresh and retry",
            race: true,
          }, 409);
        }
        if (msg.includes("member_not_found")) {
          return json({ error: "Member not found" }, 404);
        }
        if (msg.includes("schedule_row_not_found")) {
          return json({
            error: "Schedule row missing during reversal",
            detail: msg,
            manual_action_required: true,
          }, 500);
        }
        return json({
          error: "Void failed",
          detail: msg,
          manual_action_required: true,
        }, 500);
      }

      // 5. Extract RPC return values for the response + side effects.
      const pointsToRefund = Number(rpcResult?.points_refunded ?? redemption.points_redeemed);
      const newRemaining = Number(rpcResult?.new_remaining_points ?? 0);
      const stockReIncremented = Boolean(rpcResult?.stock_re_incremented);
      const refundTxId = rpcResult?.refund_transaction_id ?? null;
      const cancelledAt = new Date().toISOString();

      // 6. Side effects — all isolated, non-blocking. Failures NEVER affect
      // the void response (the atomic core already committed).

      // 6a. Staff bell
      try {
        const { data: voidCust } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", member?.customer_id)
          .maybeSingle();
        const voidName = voidCust?.full_name || "Customer";
        await supabase.from("staff_notifications").insert({
          type: "redemption_voided",
          title: "Redemption voided",
          body: `${pointsToRefund} pts (${redemption.redemption_type}) for ${voidName} — voided by ${user.email ?? "Admin"}: ${trimmedReason}`,
          account_id: redemption.account_id ?? null,
          customer_id: member?.customer_id,
          invoice_number: redemption.invoice_number ?? null,
          metadata: {
            redemption_id: redemption.id,
            points_redeemed: pointsToRefund,
            redemption_type: redemption.redemption_type,
            ...(redemption.cash_order_id ? { cash_order_id: redemption.cash_order_id } : {}),
          },
        });
      } catch (nErr) {
        console.warn("[process-loyalty-redemption] staff_notifications insert (void) failed (non-blocking):", nErr);
      }

      // 6b. Transactional email — gated by 'loyalty_email_redemption_voided' toggle
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("id, full_name, email")
          .eq("id", member?.customer_id)
          .single();
        const recipientEmail = customer?.email;
        const customerName = customer?.full_name || "Valued Customer";

        if (recipientEmail) {
          if (await gate("loyalty_email_redemption_voided")) {
            const portalUrl = await buildPortalLinkForCustomerId(supabase, member?.customer_id, "loyalty");
            const _emRes2 = await fetch(
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
            ).catch((e) => {
              console.warn("[process-loyalty-redemption] void email failed:", e);
              return null;
            });
            if (_emRes2 && !_emRes2.ok) {
              const _t = await _emRes2.text().catch(() => "<no body>");
              console.error(`[process-loyalty-redemption] send-transactional-email (void) failed (${_emRes2.status}): ${_t}`);
            }
          } else {
            console.log(
              "[email-gate] loyalty-redemption-voided skipped — toggle 'loyalty_email_redemption_voided' is OFF",
            );
          }
        }
      } catch (sideErr) {
        console.warn("[process-loyalty-redemption] void email side-effects block failed:", sideErr);
      }

      // 6c. Phase 4.2 in-app cancellation notification
      try {
        const voidedRewardName = await resolveRewardName(supabase, redemption);
        await emitNotification(supabase, redemption.member_id, {
          category: "redemption",
          ...buildRedemptionCancelledNotification({
            rewardName: voidedRewardName,
            reason: trimmedReason,
          }),
          link_target: "tab:points",
        });
      } catch (notifErr) {
        console.warn("[process-loyalty-redemption] phase 4.2 void notification failed (non-blocking):", notifErr);
      }

      // 6d. Google Sheet sync — emit "revoked" (canonical taxonomy)
      try {
        const { data: revokeCustomer } = await supabase
          .from("customers")
          .select("id, customer_code, full_name, email")
          .eq("id", member?.customer_id)
          .single();
        if (revokeCustomer) {
          const _syncRes2 = await fetch(
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
                  transaction_id: refundTxId,
                  points_amount: pointsToRefund,
                  invoice_number: redemption.invoice_number,
                  notes: `Voided redemption refund${trimmedReason ? ` — ${trimmedReason}` : ""}`,
                  created_by: user.email ?? "system",
                },
              }),
            },
          ).catch((e) => {
            console.warn("[process-loyalty-redemption] sheet sync (revoked) failed:", e);
            return null;
          });
          if (_syncRes2 && !_syncRes2.ok) {
            const _t = await _syncRes2.text().catch(() => "<no body>");
            console.error(`[process-loyalty-redemption] sync-loyalty-to-sheet (revoked) failed (${_syncRes2.status}): ${_t}`);
          }
        }
      } catch (sheetErr) {
        console.warn(
          "[process-loyalty-redemption] sheet sync (revoked) block failed:",
          sheetErr,
        );
      }

      // 7. Response — backward-compatible shape
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
