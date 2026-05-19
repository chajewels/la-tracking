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

      // Phase B — type-aware order validation. catalog_reward passes through
      // unchanged (skips order-link checks entirely; reward validation
      // happened above). All non-catalog types require exactly one FK and
      // apply type-specific brand-new/invoice rules.
      if (redemption_type !== 'catalog_reward') {
        if (!account_id && !cash_order_id) {
          return json(
            { error: "account_id or cash_order_id is required for this redemption type" },
            400,
          );
        }
        if (account_id && cash_order_id) {
          return json(
            { error: "Specify either account_id or cash_order_id, not both" },
            400,
          );
        }

        if (redemption_type === 'new_order_discount') {
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
        } else {
          // shipping_fee or service_fee — any account/cash_order accepted regardless of state.
          // Invoice optional; if provided, must match the target order.
          if (account_id) {
            const { data: acct } = await supabase
              .from("layaway_accounts")
              .select("id, currency, invoice_number")
              .eq("id", account_id)
              .maybeSingle();
            if (!acct) return json({ error: "Account not found" }, 404);
            if (trimmedInvoice && acct.invoice_number !== trimmedInvoice) {
              return json({ error: "Invoice number does not match account" }, 400);
            }
            orderCurrency = acct.currency;
          } else {
            const { data: cash } = await supabase
              .from("cash_orders")
              .select("id, currency, invoice_number")
              .eq("id", cash_order_id)
              .maybeSingle();
            if (!cash) return json({ error: "Cash order not found" }, 404);
            if (trimmedInvoice && cash.invoice_number !== trimmedInvoice) {
              return json({ error: "Invoice number does not match cash order" }, 400);
            }
            orderCurrency = cash.currency;
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
          created_by_user_id: user?.id ?? null,
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

      // Phase B — apply discount to target order for non-catalog redemptions.
      // Catalog rewards are handled offline by staff and do not touch the
      // order's balance. All non-catalog types (new_order_discount,
      // shipping_fee, service_fee) insert a synthetic payment that reduces
      // the target order's remaining_balance via existing reconcile paths.
      // Best-effort: failures here are logged but do NOT block the approve
      // flow — the redemption flip and member balance update have already
      // succeeded.
      if (
        redemption.redemption_type !== 'catalog_reward' &&
        (redemption.account_id || redemption.cash_order_id)
      ) {
        try {
          // payments table has CHECK constraint limiting submitted_by_type to {'customer','staff'}.
          // cash_payments has no such constraint but we normalize both branches to 'staff' for consistency.
          // Audit trail of the actual approver is preserved via entered_by_user_id + submitted_by_name.
          const submittedByType = 'staff';
          const submittedByName = user.email ?? 'Admin';
          const today = new Date().toISOString().slice(0, 10);
          const refRef = `LOYALTY-${redemption.id}`;
          const remarksText = `Loyalty redemption: ${Number(redemption.points_redeemed)} pts (${redemption.redemption_type})`;

          if (redemption.account_id) {
            // Layaway path
            const { data: acct } = await supabase
              .from("layaway_accounts")
              .select("currency")
              .eq("id", redemption.account_id)
              .maybeSingle();
            const acctCurrency = acct?.currency ?? null;
            const paymentAmount = acctCurrency === 'PHP'
              ? Number(redemption.value_applied_php ?? 0)
              : Number(redemption.value_applied_jpy ?? 0);

            if (paymentAmount > 0 && acctCurrency) {
              const { data: newPayment, error: payErr } = await supabase
                .from("payments")
                .insert({
                  account_id: redemption.account_id,
                  amount_paid: paymentAmount,
                  currency: acctCurrency,
                  date_paid: today,
                  payment_method: 'loyalty_redemption',
                  reference_number: refRef,
                  remarks: remarksText,
                  entered_by_user_id: user.id,
                  submitted_by_type: submittedByType,
                  submitted_by_name: submittedByName,
                })
                .select("id")
                .single();
              if (payErr || !newPayment) {
                // NOTE: redemption is already status='confirmed', member
                // debited, and loyalty_transactions written above. Returning
                // 500 here leaves that inconsistent state intact (no payment
                // row, no reconcile). Admin sees the error in the UI; full
                // atomic rollback is a separate phase.
                console.error(
                  "[process-loyalty-redemption] synthetic layaway payment INSERT failed:",
                  { redemption_id: redemption.id, account_id: redemption.account_id, err: payErr },
                );
                return json(
                  {
                    error: "Synthetic payment INSERT failed after redemption approval",
                    detail: payErr.message ?? String(payErr),
                    redemption_id: redemption.id,
                    manual_action_required: true,
                  },
                  500,
                );
              } else {
                // Phase B Patch 2 — inline waterfall allocation (reconcile-account is diagnostic-only
                // per investigation 2026-05-18). Mirrors record-payment lines 374-389 pattern,
                // simplified for synthetic redemption payments (no DP detection, no penalty split,
                // no carry-over — straight waterfall to earliest unpaid schedule rows).

                // 1. Fetch active schedule rows for this account, ordered by due_date ASC
                const { data: scheduleRows, error: schedErr } = await supabase
                  .from("layaway_schedule")
                  .select("id, installment_number, total_due_amount, paid_amount, status, due_date")
                  .eq("account_id", redemption.account_id)
                  .in("status", ["overdue", "partially_paid", "pending"])
                  .order("due_date", { ascending: true });

                if (schedErr || !scheduleRows) {
                  console.error(
                    "[process-loyalty-redemption] failed to fetch schedule for allocation:",
                    { redemption_id: redemption.id, payment_id: newPayment.id, err: schedErr },
                  );
                  return json(
                    {
                      error: "Failed to fetch schedule rows for allocation after payment insert",
                      detail: schedErr?.message ?? "no rows returned",
                      redemption_id: redemption.id,
                      payment_id: newPayment.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                // 2. Plan the waterfall allocation
                let remainingToAllocate = paymentAmount;
                const planned: Array<{
                  schedule_id: string;
                  alloc_amount: number;
                  new_paid_amount: number;
                  new_status: string;
                }> = [];

                for (const row of scheduleRows) {
                  if (remainingToAllocate <= 0) break;
                  const due = Number(row.total_due_amount);
                  const paid = Number(row.paid_amount ?? 0);
                  const rowRemaining = due - paid;
                  if (rowRemaining <= 0) continue;

                  const allocAmount = Math.min(remainingToAllocate, rowRemaining);
                  const newPaid = paid + allocAmount;
                  // Status rule: fully covered → paid; if was pending → partially_paid; else keep
                  // existing status (overdue stays overdue when row is past due_date but not yet fully paid).
                  let newStatus: string;
                  if (newPaid >= due) {
                    newStatus = "paid";
                  } else if (row.status === "pending") {
                    newStatus = "partially_paid";
                  } else {
                    newStatus = row.status; // keep overdue or partially_paid
                  }

                  planned.push({
                    schedule_id: row.id,
                    alloc_amount: allocAmount,
                    new_paid_amount: newPaid,
                    new_status: newStatus,
                  });
                  remainingToAllocate -= allocAmount;
                }

                // Guard: payment exceeded total schedule capacity. Shouldn't happen if CREATE branch
                // validates value_applied_php against remaining_balance, but hard-fail if it does.
                if (remainingToAllocate > 0.01) {
                  console.error(
                    "[process-loyalty-redemption] payment exceeds total schedule capacity:",
                    {
                      redemption_id: redemption.id,
                      payment_id: newPayment.id,
                      leftover: remainingToAllocate,
                    },
                  );
                  return json(
                    {
                      error: "Payment amount exceeds total schedule remaining capacity",
                      leftover: remainingToAllocate,
                      redemption_id: redemption.id,
                      payment_id: newPayment.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                // 3. INSERT allocations + UPDATE schedule rows (sequential per row for clear error attribution)
                for (const p of planned) {
                  const { error: allocErr } = await supabase
                    .from("payment_allocations")
                    .insert({
                      payment_id: newPayment.id,
                      schedule_id: p.schedule_id,
                      allocation_type: "installment",
                      allocated_amount: p.alloc_amount,
                    });

                  if (allocErr) {
                    console.error(
                      "[process-loyalty-redemption] payment_allocations INSERT failed:",
                      { redemption_id: redemption.id, payment_id: newPayment.id, schedule_id: p.schedule_id, err: allocErr },
                    );
                    return json(
                      {
                        error: "payment_allocations INSERT failed",
                        detail: allocErr.message,
                        redemption_id: redemption.id,
                        payment_id: newPayment.id,
                        manual_action_required: true,
                      },
                      500,
                    );
                  }

                  const { error: schedUpdErr } = await supabase
                    .from("layaway_schedule")
                    .update({ paid_amount: p.new_paid_amount, status: p.new_status })
                    .eq("id", p.schedule_id);

                  if (schedUpdErr) {
                    console.error(
                      "[process-loyalty-redemption] schedule UPDATE failed:",
                      { redemption_id: redemption.id, payment_id: newPayment.id, schedule_id: p.schedule_id, err: schedUpdErr },
                    );
                    return json(
                      {
                        error: "Schedule UPDATE failed after allocation",
                        detail: schedUpdErr.message,
                        redemption_id: redemption.id,
                        payment_id: newPayment.id,
                        manual_action_required: true,
                      },
                      500,
                    );
                  }
                }

                // 4. UPDATE account totals (canonical formula: total_paid = SUM non-voided payments;
                //    we just inserted a new payment of paymentAmount, so simply increment).
                const { data: acctNow, error: acctReadErr } = await supabase
                  .from("layaway_accounts")
                  .select("total_paid, remaining_balance, status")
                  .eq("id", redemption.account_id)
                  .single();

                if (acctReadErr || !acctNow) {
                  console.error(
                    "[process-loyalty-redemption] failed to read account for totals update:",
                    { redemption_id: redemption.id, payment_id: newPayment.id, err: acctReadErr },
                  );
                  return json(
                    {
                      error: "Failed to read account for totals update",
                      detail: acctReadErr?.message ?? "no row returned",
                      redemption_id: redemption.id,
                      payment_id: newPayment.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                const newTotalPaid = Number(acctNow.total_paid) + paymentAmount;
                const newRemaining = Number(acctNow.remaining_balance) - paymentAmount;

                // Status: completed if fully paid; overdue → active if no overdue rows remain.
                // All other status transitions (active, forfeited, etc.) are out of scope here.
                let newAccountStatus = acctNow.status;
                if (newRemaining <= 0.01) {
                  newAccountStatus = "completed";
                } else if (acctNow.status === "overdue") {
                  const { data: stillOverdue } = await supabase
                    .from("layaway_schedule")
                    .select("id")
                    .eq("account_id", redemption.account_id)
                    .eq("status", "overdue")
                    .limit(1);
                  if (!stillOverdue || stillOverdue.length === 0) {
                    newAccountStatus = "active";
                  }
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
                    "[process-loyalty-redemption] account totals UPDATE failed:",
                    { redemption_id: redemption.id, payment_id: newPayment.id, err: acctUpdErr },
                  );
                  return json(
                    {
                      error: "Account totals UPDATE failed",
                      detail: acctUpdErr.message,
                      redemption_id: redemption.id,
                      payment_id: newPayment.id,
                      manual_action_required: true,
                    },
                    500,
                  );
                }

                // Allocation chain complete — synthetic payment is now reflected on the account.
              }
            } else {
              console.warn(
                "[process-loyalty-redemption] synthetic payment skipped — missing currency or zero amount:",
                { redemption_id: redemption.id, acctCurrency, paymentAmount },
              );
            }
          } else if (redemption.cash_order_id) {
            // Cash path
            const { data: cash } = await supabase
              .from("cash_orders")
              .select("currency, total_amount")
              .eq("id", redemption.cash_order_id)
              .maybeSingle();
            const cashCurrency = cash?.currency ?? null;
            const cashTotalAmount = Number(cash?.total_amount ?? 0);
            const paymentAmount = cashCurrency === 'PHP'
              ? Number(redemption.value_applied_php ?? 0)
              : Number(redemption.value_applied_jpy ?? 0);

            if (paymentAmount > 0 && cashCurrency) {
              const { error: payErr } = await supabase
                .from("cash_payments")
                .insert({
                  cash_order_id: redemption.cash_order_id,
                  amount_paid: paymentAmount,
                  currency: cashCurrency,
                  date_paid: today,
                  payment_method: 'loyalty_redemption',
                  reference_number: refRef,
                  remarks: remarksText,
                  entered_by_user_id: user.id,
                  submitted_by_type: submittedByType,
                  submitted_by_name: submittedByName,
                });
              if (payErr) {
                // NOTE: redemption is already status='confirmed', member
                // debited, and loyalty_transactions written above. Returning
                // 500 here leaves that inconsistent state intact (no payment
                // row, no recompute). Admin sees the error in the UI; full
                // atomic rollback is a separate phase.
                console.error(
                  "[process-loyalty-redemption] synthetic cash payment INSERT failed:",
                  { redemption_id: redemption.id, cash_order_id: redemption.cash_order_id, err: payErr },
                );
                return json(
                  {
                    error: "Synthetic payment INSERT failed after redemption approval",
                    detail: payErr.message ?? String(payErr),
                    redemption_id: redemption.id,
                    manual_action_required: true,
                  },
                  500,
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
                const newRemaining = cashTotalAmount - newTotalPaid;
                const cashUpdate: Record<string, any> = {
                  total_paid: newTotalPaid,
                  remaining_balance: newRemaining,
                  updated_at: new Date().toISOString(),
                };
                if (newRemaining <= 0) {
                  cashUpdate.status = 'completed';
                  cashUpdate.completed_at = new Date().toISOString();
                }
                const { error: cashUpdErr } = await supabase
                  .from("cash_orders")
                  .update(cashUpdate)
                  .eq("id", redemption.cash_order_id);
                if (cashUpdErr) {
                  console.warn(
                    "[process-loyalty-redemption] cash_orders totals update failed:",
                    { redemption_id: redemption.id, err: cashUpdErr },
                  );
                }
              }
            } else {
              console.warn(
                "[process-loyalty-redemption] synthetic cash payment skipped — missing currency or zero amount:",
                { redemption_id: redemption.id, cashCurrency, paymentAmount },
              );
            }
          }
        } catch (applyErr) {
          console.warn(
            "[process-loyalty-redemption] discount application block failed (manual reconcile needed):",
            { redemption_id: redemption.id, err: applyErr },
          );
        }
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
            // Phase 4.2 — emit the approved notification anyway: points
            // ARE debited at this point, so the customer needs to see
            // the redemption in their portal. Admin will manually
            // cancel/refund afterward, which (per Phase 3.2.1 TODO)
            // does not yet emit a separate notification.
            const raceRewardName = await resolveRewardName(supabase, redemption);
            await emitNotification(supabase, redemption.member_id, {
              category: "redemption",
              ...buildRedemptionApprovedNotification({
                rewardName: raceRewardName,
                points: Number(redemption.points_redeemed),
              }),
              link_target: "tab:points",
            });
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
        ...buildRedemptionApprovedNotification({
          rewardName: approvedRewardName,
          points: Number(redemption.points_redeemed),
        }),
        link_target: "tab:points",
      });

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
      // Catalog rewards have no synthetic payment to reverse. Best-effort:
      // failures here are logged but do NOT block the void flow — the
      // redemption flip and member balance refund have already succeeded.
      if (
        redemption.redemption_type !== 'catalog_reward' &&
        (redemption.account_id || redemption.cash_order_id)
      ) {
        try {
          const refRef = `LOYALTY-${redemption.id}`;
          const truncatedVoidReason = trimmedReason.slice(0, 250);
          const voidNotes = `Loyalty redemption voided: ${truncatedVoidReason}`;

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
