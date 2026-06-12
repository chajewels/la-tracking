import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// award-loyalty-points skip reasons that surface as operator notifications.
// Benign skips (not_enrolled, below_minimum, already_awarded, no_loyalty_amount,
// missing_source) stay silent.
const ANOMALOUS_SKIP_REASONS = ["loyalty_disabled", "tier_not_found", "account_not_found", "cash_order_not_found"];

/**
 * Loyalty enrollment pre-check. Returns true iff a `loyalty_members` row
 * exists for the resolved customer. Used to gate award-loyalty-points
 * calls so non-enrolled customers never enter the loyalty pipeline (no
 * fetch, no push to loyaltyAwards / cashLoyaltyAward, no notification).
 *
 * Resolves the customer in this order:
 *   1. `customerId` arg if non-empty (cash path: cashOrder.customer_id;
 *      layaway paths: submission.customer_id).
 *   2. layaway_accounts.customer_id by `accountIdFallback` when the
 *      submission row didn't carry a customer_id.
 */
async function isCustomerLoyaltyEnrolled(
  supabase: any,
  customerId: string | null | undefined,
  accountIdFallback?: string | null,
): Promise<boolean> {
  let cid = customerId ?? null;
  if (!cid && accountIdFallback) {
    const { data: acct } = await supabase
      .from("layaway_accounts")
      .select("customer_id")
      .eq("id", accountIdFallback)
      .maybeSingle();
    cid = (acct as { customer_id?: string } | null)?.customer_id ?? null;
  }
  if (!cid) return false;
  const { data: member } = await supabase
    .from("loyalty_members")
    .select("id")
    .eq("customer_id", cid)
    .maybeSingle();
  return !!member;
}

/**
 * Resolve the display context (full_name, invoice) for a loyalty award
 * notification. Works for both layaway (account_id) and cash
 * (cash_order_id) sources. Lookup failures degrade gracefully — the
 * caller still gets a partial context rather than throwing, so the
 * notification insert is never blocked on this resolver.
 */
async function resolveAwardNotifyContext(
  supabase: any,
  src: {
    account_id?: string | null;
    cash_order_id?: string | null;
    customer_id?: string | null;
    invoice_number?: string | null;
  },
): Promise<{ fullName: string | null; invoice: string | null }> {
  if (src.cash_order_id) {
    try {
      let invoice = src.invoice_number ?? null;
      let custId = src.customer_id ?? null;
      if (!invoice || !custId) {
        const { data: order } = await supabase
          .from("cash_orders")
          .select("invoice_number, customer_id")
          .eq("id", src.cash_order_id)
          .maybeSingle();
        const row = order as { invoice_number?: string | null; customer_id?: string | null } | null;
        invoice = invoice ?? row?.invoice_number ?? null;
        custId = custId ?? row?.customer_id ?? null;
      }
      let fullName: string | null = null;
      if (custId) {
        const { data: cust } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", custId)
          .maybeSingle();
        fullName = (cust as { full_name?: string | null } | null)?.full_name ?? null;
      }
      return { fullName, invoice };
    } catch (_e) {
      return { fullName: null, invoice: src.invoice_number ?? null };
    }
  }
  if (src.account_id) {
    try {
      const { data: acct } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, customers(full_name)")
        .eq("id", src.account_id)
        .maybeSingle();
      const row = acct as { invoice_number?: string | null; customers?: { full_name?: string | null } | null } | null;
      return {
        fullName: row?.customers?.full_name ?? null,
        invoice: row?.invoice_number ?? null,
      };
    } catch (_e) {
      return { fullName: null, invoice: null };
    }
  }
  return { fullName: null, invoice: null };
}

/** Number formatter for the loyalty notification — en-US comma grouping. */
function fmtLoyaltyNum(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? 0);
  return v.toLocaleString("en-US");
}

/**
 * Compose the body of a successful loyalty award bell notification. Format:
 *   `+<pts>[ (+<bonus> bonus)] pts[ to <name>] · Inv #<inv|?> · balance <rem>[ · Tier upgraded: …]`
 * Mirrors the failing-notification customer-name policy and folds in the
 * existing tier-upgrade tail.
 */
function buildLoyaltyAwardBody(
  a: {
    points_earned?: number;
    bonus_points?: number;
    remaining_points?: number;
    tier_upgraded?: boolean;
    old_tier?: string;
    new_tier?: string;
  },
  ctx: { fullName: string | null; invoice: string | null },
): string {
  const bonus = a.bonus_points ? ` (+${fmtLoyaltyNum(a.bonus_points)} bonus)` : "";
  const who = ctx.fullName ? ` to ${ctx.fullName}` : "";
  const inv = ` · Inv #${ctx.invoice ?? "?"}`;
  const tier = a.tier_upgraded ? ` · Tier upgraded: ${a.old_tier} → ${a.new_tier}` : "";
  return `+${fmtLoyaltyNum(a.points_earned)}${bonus} pts${who}${inv} · balance ${fmtLoyaltyNum(a.remaining_points)}${tier}`;
}

async function allocatePaymentToAccount(
  supabase: any,
  accountId: string,
  amountPaid: number,
  paymentDate: string,
  paymentMethod: string,
  referenceNumber: string | null,
  remarks: string,
  userId: string,
  currency: string,
  isDownpayment: boolean = false,
  submittedByType: "customer" | "staff" = "staff",
  submittedByName: string | null = null
): Promise<{ paymentId: string; error?: string }> {
  // Fetch schedule (only needed for installment payments)
  const { data: schedule } = isDownpayment ? { data: null } : await supabase
    .from("layaway_schedule")
    .select("*")
    .eq("account_id", accountId)
    .order("installment_number", { ascending: true });

  // Fetch unpaid penalties (not applicable for DP payments)
  const { data: unpaidPenalties } = isDownpayment ? { data: null } : await supabase
    .from("penalty_fees")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "unpaid")
    .order("penalty_date", { ascending: true });

  let remaining = amountPaid;
  const allocations: Array<{
    schedule_id: string;
    allocation_type: "penalty" | "installment";
    allocated_amount: number;
  }> = [];
  const penaltyUpdates: Array<{ id: string; status: string }> = [];
  const scheduleUpdates: Array<{ id: string; paid_amount: number; status: string; total_due_amount?: number }> = [];

  // DP payments skip all schedule and penalty allocation entirely.
  // They are recorded as a payment entry only; total_paid/remaining_balance
  // are updated below via the account totals section.
  if (!isDownpayment) {
    // Unified row-by-row waterfall — allocate penalty + installment for
    // EACH schedule row before advancing. Prevents cross-row penalty
    // leakage where a later month's penalty events could drain the
    // payment budget before the target month's base is covered.
    if (schedule) {
      // CHANGE 1: fetch existing allocations for true per-row remaining
      // (CLAUDE.md INVARIANT 2 — paid_amount/total_due_amount are write-only caches)
      const { data: existingAllocs } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, payment_id")
        .in("schedule_id", schedule.map((s: any) => s.id));

      const { data: voidedPayments } = await supabase
        .from("payments")
        .select("id")
        .eq("account_id", accountId)
        .not("voided_at", "is", null);

      const voidedIds = new Set((voidedPayments || []).map((p: any) => p.id));

      const allocatedBySchedule = new Map<string, number>();
      for (const alloc of (existingAllocs || [])) {
        if (!voidedIds.has(alloc.payment_id)) {
          allocatedBySchedule.set(
            alloc.schedule_id,
            (allocatedBySchedule.get(alloc.schedule_id) || 0) + Number(alloc.allocated_amount)
          );
        }
      }

      const unpaidItems = schedule
        .filter((item: any) => item.status !== "paid" && item.status !== "cancelled")
        .sort((a: any, b: any) => a.installment_number - b.installment_number);

      for (const item of unpaidItems) {
        if (remaining <= 0) break;

        // Carry-over guard: respect admin carry-over decisions. If the NEXT
        // installment row already holds a non-zero carried_amount, this row
        // was administratively closed via carry-over. Do NOT re-allocate
        // (penalty or installment) to it — skip so remaining funds flow on.
        const nextItem = (schedule || []).find(
          (i: any) => Number(i.installment_number) === Number(item.installment_number) + 1
        );
        if (nextItem && Number(nextItem.carried_amount || 0) > 0.005) {
          continue;
        }

        // STEP A — Pay THIS row's penalties only (scoped to this schedule_id)
        if (unpaidPenalties) {
          const itemPenalties = unpaidPenalties.filter((pen: any) => pen.schedule_id === item.id);
          for (const pen of itemPenalties) {
            if (remaining <= 0) break;
            const penAmount = Number(pen.penalty_amount);
            const toPay = Math.min(remaining, penAmount);
            remaining -= toPay;
            allocations.push({
              schedule_id: pen.schedule_id,
              allocation_type: "penalty",
              allocated_amount: toPay,
            });
            penaltyUpdates.push({
              id: pen.id,
              status: toPay >= penAmount ? "paid" : "unpaid",
            });
          }
        }

        if (remaining <= 0) break;

        // STEP B — Pay THIS row's base installment
        const alreadyAllocated = allocatedBySchedule.get(item.id) || 0;
        // In-memory penalty allocations made in Step A for this row
        const alreadyAllocatedPenalty = allocations
          .filter(a => a.schedule_id === item.id && a.allocation_type === 'penalty')
          .reduce((sum, a) => sum + a.allocated_amount, 0);
        const naturalCeiling = Number(item.base_installment_amount) +
                               Number(item.penalty_amount || 0) +
                               Number(item.carried_amount || 0);
        // Keep credits: a lowered total_due_amount (written by the Keep
        // handler on the next pending row) caps the obligation BELOW the
        // natural ceiling. Respect it here so the waterfall does not refill
        // the credited portion.
        const rowCeiling = item.total_due_amount
          ? Math.min(naturalCeiling, Number(item.total_due_amount))
          : naturalCeiling;
        const due = Math.max(0, rowCeiling - alreadyAllocated - alreadyAllocatedPenalty);
        if (due <= 0) continue;

        const toApply = Math.min(remaining, due);
        const newPaid = alreadyAllocated + toApply;
        const isNowFullyPaid = newPaid + alreadyAllocatedPenalty >= rowCeiling - 0.005;

        // STEP C — Push allocation + schedule update (before decrementing remaining
        // so the explicit break right after remaining -= toApply does not skip it)
        if (isNowFullyPaid && item.status === "partially_paid") {
          // Topping up a partial month — cap paid_amount at ceiling.
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: rowCeiling, status: "paid" });
        } else if (isNowFullyPaid) {
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "paid" });
        } else if (item.status !== "partially_paid") {
          // PENDING MONTH UNDERPAID — record partial only.
          // Do NOT inflate next row's total_due_amount here; carry-over is
          // handled by accept-underpayment after payment_allocations are written.
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "partially_paid" });
        } else {
          // PARTIALLY_PAID MONTH — additional payment, not completing
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "partially_paid" });
        }

        remaining -= toApply;

        // STEP D — exhausted? stop immediately after Step B's remaining decrement,
        // before any chance of visiting the next row.
        if (remaining <= 0) break;
      }
    }
  }

  // Create payment record
  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .insert({
      account_id: accountId,
      amount_paid: amountPaid,
      currency,
      date_paid: paymentDate,
      payment_method: paymentMethod,
      reference_number: referenceNumber,
      remarks,
      entered_by_user_id: userId,
      submitted_by_type: submittedByType,
      submitted_by_name: submittedByName,
    })
    .select("id")
    .single();

  if (payErr) {
    console.error("Payment insert error:", payErr);
    return { paymentId: "", error: "Failed to create payment record" };
  }

  // Guard: skip allocation waterfall if this payment was already allocated (idempotency)
  const { data: existingAllocsGuard } = await supabase
    .from("payment_allocations")
    .select("id")
    .eq("payment_id", payment.id)
    .limit(1);
  const skipWaterfall = existingAllocsGuard != null && existingAllocsGuard.length > 0;
  if (skipWaterfall) {
    console.log(`[review] Payment ${payment.id} already has allocations — skipping waterfall`);
  }

  if (!skipWaterfall) {
    // Helper: attempt to roll back by deleting the payment row just inserted.
    // This is best-effort — full DB transactions are not available in edge functions.
    const rollbackPayment = async () => {
      await supabase.from("payments").delete().eq("id", payment.id);
    };

    // Merge multiple penalty allocations for the same schedule_id into a
    // single row to avoid violating the unique constraint on
    // (schedule_id, payment_id, allocation_type). Installment rows are
    // naturally unique per schedule_id (one per loop iteration).
    const mergedAllocations: typeof allocations = [];
    const penaltyBySchedule = new Map<string, number>();
    for (const alloc of allocations) {
      if (alloc.allocation_type === 'penalty') {
        penaltyBySchedule.set(
          alloc.schedule_id,
          (penaltyBySchedule.get(alloc.schedule_id) || 0) + alloc.allocated_amount
        );
      } else {
        mergedAllocations.push(alloc);
      }
    }
    for (const [scheduleId, totalPenalty] of penaltyBySchedule) {
      mergedAllocations.push({
        schedule_id: scheduleId,
        allocation_type: 'penalty',
        allocated_amount: totalPenalty,
      });
    }

    // Create allocations (duplicate guard: skip if allocation already exists for this payment+schedule)
    for (const alloc of mergedAllocations) {
      const { data: existing } = await supabase
        .from("payment_allocations")
        .select("id")
        .eq("schedule_id", alloc.schedule_id)
        .eq("payment_id", payment.id)
        .eq("allocation_type", alloc.allocation_type)
        .maybeSingle();
      if (existing) continue;

      const { error: allocInsertErr } = await supabase.from("payment_allocations").insert({
        payment_id: payment.id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });

      if (allocInsertErr) {
        console.error(`[allocatePaymentToAccount] allocation insert failed for schedule ${alloc.schedule_id}:`, allocInsertErr);
        await rollbackPayment();
        return { paymentId: "", error: "Failed to create allocation: " + allocInsertErr.message };
      }
    }

    // Update penalty statuses
    for (const pen of penaltyUpdates) {
      const { error: penUpdateErr } = await supabase.from("penalty_fees").update({ status: pen.status }).eq("id", pen.id);
      if (penUpdateErr) {
        console.error(`[allocatePaymentToAccount] penalty update failed for ${pen.id}:`, penUpdateErr);
        await rollbackPayment();
        return { paymentId: "", error: "Failed to update penalty: " + penUpdateErr.message };
      }
    }

    // Update schedule items
    for (const item of scheduleUpdates) {
      const fields: any = { paid_amount: item.paid_amount, status: item.status };
      if (item.total_due_amount !== undefined) fields.total_due_amount = item.total_due_amount;
      const { error: schedUpdateErr } = await supabase.from("layaway_schedule").update(fields).eq("id", item.id);
      if (schedUpdateErr) {
        console.error(`[allocatePaymentToAccount] schedule update failed for ${item.id}:`, schedUpdateErr);
        await rollbackPayment();
        return { paymentId: "", error: "Failed to update schedule: " + schedUpdateErr.message };
      }
    }
  }

  // Re-derive remaining_balance from payments table (INVARIANT 1: SUM payments.amount_paid)
  // Must use payments table directly — payment_allocations has no rows for DP payments,
  // so allocation-based sums would incorrectly return 0 for downpayment approvals.
  const { data: nonVoidedPayments } = await supabase
    .from("payments")
    .select("amount_paid")
    .eq("account_id", accountId)
    .is("voided_at", null);
  const totalPaidFromPayments = (nonVoidedPayments || [])
    .reduce((sum: number, p: any) => sum + Number(p.amount_paid), 0);
  const { data: activePenaltiesData } = await supabase
    .from("penalty_fees")
    .select("penalty_amount")
    .eq("account_id", accountId)
    .neq("status", "waived");
  const totalPenaltiesVerified = (activePenaltiesData || [])
    .reduce((sum: number, p: any) => sum + Number(p.penalty_amount), 0);

  const { data: fullAccount } = await supabase
    .from("layaway_accounts")
    .select("total_amount, status")
    .eq("id", accountId)
    .single();
  const totalAmount = Number(fullAccount?.total_amount || 0);
  const verifiedRemaining = Math.max(0, totalAmount + totalPenaltiesVerified - totalPaidFromPayments);
  const verifiedTotalPaid = totalPaidFromPayments;

  // Recalculate correct status
  const currentStatus = fullAccount?.status || "active";
  let newStatus: string | undefined;
  if (verifiedRemaining <= 0) {
    newStatus = "completed";
  } else if (["active", "overdue"].includes(currentStatus)) {
    const todayStr = new Date().toISOString().split("T")[0];
    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("due_date, status")
      .eq("account_id", accountId)
      .not("status", "in", '("paid","cancelled")');
    const hasOverdue = (updatedSchedule || []).some((s: any) => s.due_date < todayStr);
    newStatus = hasOverdue ? "overdue" : "active";
  }

  const accountUpdate: Record<string, unknown> = {
    total_paid: verifiedTotalPaid,
    remaining_balance: verifiedRemaining,
  };
  if (newStatus) accountUpdate.status = newStatus;

  await supabase
    .from("layaway_accounts")
    .update(accountUpdate)
    .eq("id", accountId);

  return { paymentId: payment.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { submission_id, action, reviewer_notes } = body;

    if (!submission_id || !action) {
      return new Response(JSON.stringify({ error: "Missing submission_id or action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validActions = ["under_review", "confirmed", "rejected", "needs_clarification", "restore"];
    if (!validActions.includes(action)) {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const permissionByAction: Record<string, string> = {
      under_review: "review_submission",
      needs_clarification: "review_submission",
      rejected: "reject_submission",
      confirmed: "confirm_payment",
      restore: "reject_submission",
    };

    const requiredPermission = permissionByAction[action];
    const isAllowed = requiredPermission
      ? await checkPermission(supabase, user.id, requiredPermission)
      : false;

    if (!isAllowed) {
      return new Response(JSON.stringify({ error: "Access denied for this submission action." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the submission
    const { data: submission, error: subErr } = await supabase
      .from("payment_submissions")
      .select("*")
      .eq("id", submission_id)
      .maybeSingle();

    if (subErr || !submission) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get allocations for this submission
    const { data: subAllocations } = await supabase
      .from("payment_submission_allocations")
      .select("*")
      .eq("submission_id", submission_id);

    const allocs = subAllocations || [];
    let confirmedPaymentIds: string[] = [];

    // ── RESTORE PATH ──
    // Restoring a rejected submission flips status back to 'submitted' so
    // it re-enters the queue for proper validation. Preserves the original
    // reviewer_user_id and reviewer_notes as rejection history. The restorer
    // and optional restore reason are captured in audit_logs. Short-circuits
    // both the cash-order and layaway branches.
    if (action === "restore") {
      if (submission.status !== "rejected") {
        return new Response(JSON.stringify({
          error: `Cannot restore submission with status '${submission.status}'. Only rejected submissions can be restored.`,
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: restoreErr } = await supabase
        .from("payment_submissions")
        .update({
          status: "submitted",
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);

      if (restoreErr) {
        return new Response(JSON.stringify({
          error: "Failed to restore submission: " + restoreErr.message,
        }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await supabase.from("audit_logs").insert({
        entity_type: "payment_submission",
        entity_id: submission_id,
        action: "restored_from_rejected",
        old_value_json: {
          status: "rejected",
          reviewer_user_id: submission.reviewer_user_id,
          reviewer_notes: submission.reviewer_notes,
        },
        new_value_json: {
          status: "submitted",
          restore_reason: reviewer_notes || null,
        },
        performed_by_user_id: user.id,
      });

      return new Response(JSON.stringify({
        success: true,
        status: "submitted",
        submission: { id: submission_id, status: "submitted" },
        restored: true,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ── CASH ORDER CONFIRMATION PATH ──
    // Cash order submissions are identified by cash_order_id IS NOT NULL
    // (account_id IS NULL). Handled entirely separately from layaway with
    // an early return — does not touch payment_allocations, schedule, or
    // penalty engine.
    if (action === "confirmed" && submission.cash_order_id) {
      // Idempotency guard — a re-confirmed submission would create a duplicate cash_payment
      if (submission.status === "confirmed" && submission.confirmed_payment_id) {
        return new Response(JSON.stringify({
          error: "Submission already confirmed",
          confirmed_payment_id: submission.confirmed_payment_id,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 1. Fetch cash order — must exist and be pending
      const { data: cashOrder, error: cashOrderErr } = await supabase
        .from("cash_orders")
        .select("id, customer_id, currency, invoice_number, status, total_paid, remaining_balance, completed_at, cash_receipt_sheet_id")
        .eq("id", submission.cash_order_id)
        .maybeSingle();
      if (cashOrderErr || !cashOrder) {
        return new Response(JSON.stringify({ error: "cash_order not found" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (cashOrder.status === "cancelled" || cashOrder.status === "expired") {
        return new Response(JSON.stringify({ error: `cash_order is ${cashOrder.status}, cannot confirm payment` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 2. Re-validate ceiling at review time (other payments may have arrived between submission and review)
      const submittedAmount = Number(submission.submitted_amount);
      const liveRemaining = Number(cashOrder.remaining_balance);
      if (submittedAmount > liveRemaining + 0.005) {
        return new Response(JSON.stringify({
          error: `submitted_amount (${submittedAmount}) exceeds current remaining_balance (${liveRemaining})`,
        }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 3. Insert cash_payments row
      const submittedByType = submission.portal_token ? "customer" : "staff";
      const { data: cashPayment, error: cpErr } = await supabase
        .from("cash_payments")
        .insert({
          cash_order_id: cashOrder.id,
          amount_paid: submittedAmount,
          currency: cashOrder.currency,
          date_paid: submission.payment_date,
          payment_method: submission.payment_method,
          reference_number: submission.reference_number,
          remarks: submission.notes,
          entered_by_user_id: user.id,
          submitted_by_type: submittedByType,
          submitted_by_name: submission.sender_name,
        })
        .select()
        .single();
      if (cpErr || !cashPayment) {
        console.error("cash_payments insert error:", cpErr);
        return new Response(JSON.stringify({ error: cpErr?.message || "Failed to create cash_payment" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 4. Update cash_orders totals + status if fully paid.
      //
      // Before mutating, capture a pre-update snapshot so we can revert if
      // step 5 (submission update) fails. Edge functions don't have DB
      // transactions across multiple statements, so we hand-roll rollback to
      // prevent the half-confirmed state where cash_payment + cash_order are
      // updated but the submission row is still 'submitted' (caught in
      // production 2026-04-28 — fully paid order with stale submission row,
      // customer unable to retry because remaining_balance was 0).
      const cashOrderSnapshot = {
        total_paid: cashOrder.total_paid,
        remaining_balance: cashOrder.remaining_balance,
        status: cashOrder.status,
        completed_at: cashOrder.completed_at,
      };
      const newTotalPaid = Math.round((Number(cashOrder.total_paid) + submittedAmount) * 100) / 100;
      const newRemaining = Math.max(0, Math.round((liveRemaining - submittedAmount) * 100) / 100);
      const isFullyPaid = newRemaining <= 0.005;
      // Preserve existing status when not fully paid — partial payments do NOT
      // flip an expired/extension/etc. order back to pending. The line 476 block
      // above already prevents confirming on cancelled/expired orders, so this
      // is defense in depth for any future status enum additions.
      const statusAfter = isFullyPaid ? "completed" : cashOrder.status;
      const orderUpdate: Record<string, unknown> = {
        total_paid: newTotalPaid,
        remaining_balance: newRemaining,
      };
      if (isFullyPaid) {
        orderUpdate.status = "completed";
        orderUpdate.completed_at = new Date().toISOString();
      }
      const { data: updatedOrder, error: orderUpdErr } = await supabase
        .from("cash_orders")
        .update(orderUpdate)
        .eq("id", cashOrder.id)
        .select()
        .single();
      if (orderUpdErr) {
        // Step 4 failed — rollback the cash_payment from step 3.
        await supabase.from("cash_payments").delete().eq("id", cashPayment.id);
        return new Response(JSON.stringify({ error: "Failed to update cash_order: " + orderUpdErr.message }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // 5. Update submission status
      const subUpdate: Record<string, unknown> = {
        status: "confirmed",
        reviewer_user_id: user.id,
        reviewer_notes: reviewer_notes || null,
        confirmed_payment_id: cashPayment.id,
        updated_at: new Date().toISOString(),
      };
      const { error: subUpdErr } = await supabase
        .from("payment_submissions")
        .update(subUpdate)
        .eq("id", submission_id);
      if (subUpdErr) {
        console.error("[review-payment-submission] submission update failed for cash confirm — rolling back:", subUpdErr);
        // Step 5 failed — manual rollback of step 4 (cash_orders) and step 3
        // (cash_payments) to prevent half-confirmed state.
        const { error: orderRevertErr } = await supabase
          .from("cash_orders")
          .update({
            total_paid: cashOrderSnapshot.total_paid,
            remaining_balance: cashOrderSnapshot.remaining_balance,
            status: cashOrderSnapshot.status,
            completed_at: cashOrderSnapshot.completed_at,
          })
          .eq("id", cashOrder.id);
        if (orderRevertErr) {
          // Revert failed — flag this loudly. We are now in a state where:
          //   - cash_payment exists
          //   - cash_order is updated (not reverted)
          //   - submission is still 'submitted'
          // This requires manual reconciliation. Audit-log the situation.
          console.error("[review-payment-submission] CRITICAL: cash_orders revert failed after submission update failure:", orderRevertErr);
          await supabase.from("audit_logs").insert({
            entity_type: "cash_payment_submission",
            entity_id: submission_id,
            action: "confirm_rollback_failed",
            performed_by_user_id: user.id,
            new_value_json: {
              cash_payment_id: cashPayment.id,
              cash_order_id: cashOrder.id,
              submission_update_error: subUpdErr.message,
              order_revert_error: orderRevertErr.message,
              snapshot: cashOrderSnapshot,
            },
          });
          return new Response(JSON.stringify({
            error: "Failed to record confirmation and rollback also failed. Manual reconciliation required. cash_payment_id=" + cashPayment.id,
          }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        const { error: cpDeleteErr } = await supabase
          .from("cash_payments")
          .delete()
          .eq("id", cashPayment.id);
        if (cpDeleteErr) {
          console.error("[review-payment-submission] cash_payment delete failed during rollback:", cpDeleteErr);
        }
        return new Response(JSON.stringify({
          error: "Failed to record confirmation: " + subUpdErr.message + ". State has been rolled back; please retry.",
        }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // 6. Audit log
      await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission",
        entity_id: submission_id,
        action: "confirm",
        performed_by_user_id: user.id,
        new_value_json: {
          cash_payment_id: cashPayment.id,
          amount_confirmed: submittedAmount,
          remaining_after: newRemaining,
          status_after: statusAfter,
        },
        old_value_json: { status: submission.status },
      });

      // 7. Fire-and-forget: cash-payment-confirmed email
      try {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name, email")
          .eq("id", cashOrder.customer_id)
          .single();
        const customerEmail = customer?.email;
        if (customerEmail) {
          await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({
              templateName: "cash-payment-confirmed",
              recipientEmail: customerEmail,
              idempotencyKey: `cash-payment-confirmed-${cashPayment.id}`,
              templateData: {
                customerName: customer?.full_name || "Valued Customer",
                invoiceNumber: cashOrder.invoice_number,
                amountPaid: Number(submittedAmount).toLocaleString("en-US"),
                currency: cashOrder.currency,
                remainingBalance: Number(newRemaining).toLocaleString("en-US"),
                totalPaid: Number(newTotalPaid).toLocaleString("en-US"),
                isFullyPaid,
                portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${cashOrder.invoice_number}`,
              },
            }),
          });
        }
      } catch (emailErr) {
        console.warn("[review-payment-submission] cash-payment-confirmed email failed (non-blocking):", emailErr);
      }

      // 8. Capture-and-record: award-loyalty-points if order is now completed.
      // Failures here NEVER affect the confirmation outcome — they flow
      // through as data on cashLoyaltyAward.
      //
      // Membership pre-check: skip the entire loyalty pipeline (no fetch,
      // no failure notification) for non-enrolled customers. The skip is
      // now surfaced as a benign trace (`pre_check_not_enrolled`) instead
      // of silently leaving no record — see Bug #223 hardening. Reason
      // isn't in ANOMALOUS_SKIP_REASONS, so the notification loop treats
      // it as informational and emits nothing.
      let cashLoyaltyAward: Record<string, unknown> | null = null;
      if (isFullyPaid) {
        const enrolled = await isCustomerLoyaltyEnrolled(supabase, cashOrder.customer_id);
        if (enrolled) {
          try {
            const lpRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                cash_order_id: cashOrder.id,
                customer_id: cashOrder.customer_id,
              }),
            });
            const lpJson = await lpRes.json().catch(() => null);
            if (!lpRes.ok) {
              // Explicit HTTP-status check — closes the gap that let the
              // 4-day 401 outage stay silent.
              const bodyErr = (lpJson as { error?: string } | null)?.error;
              cashLoyaltyAward = {
                cash_order_id: cashOrder.id,
                error: bodyErr ?? `http_${lpRes.status}`,
                status: lpRes.status,
                ...(lpJson ?? {}),
              };
            } else {
              cashLoyaltyAward = { cash_order_id: cashOrder.id, ...(lpJson ?? { error: "no_response" }) };
            }
          } catch (loyaltyErr) {
            console.warn("[review-payment-submission] award-loyalty-points failed (non-blocking):", loyaltyErr);
            cashLoyaltyAward = { cash_order_id: cashOrder.id, error: String(loyaltyErr) };
          }
        } else {
          cashLoyaltyAward = {
            cash_order_id: cashOrder.id,
            skipped: true,
            reason: "pre_check_not_enrolled",
          };
        }
      }

      if (cashLoyaltyAward) {
        try {
          const a: any = cashLoyaltyAward;
          if (a.awarded === true) {
            const ctx = await resolveAwardNotifyContext(supabase, {
              cash_order_id: cashOrder.id,
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
            });
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award",
              title: "Loyalty points awarded",
              body: buildLoyaltyAwardBody(a, ctx),
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
              metadata: cashLoyaltyAward,
            });
          } else if (a.error) {
            // Resolve customer display name for the failure body. If the
            // lookup itself fails, fall back to the existing body — the
            // notification must NEVER be skipped because of a name miss.
            let cashFullName: string | null = null;
            try {
              const { data: cust } = await supabase
                .from("customers")
                .select("full_name")
                .eq("id", cashOrder.customer_id)
                .maybeSingle();
              cashFullName = (cust as { full_name?: string | null } | null)?.full_name ?? null;
            } catch (_lookupErr) {
              cashFullName = null;
            }
            const failBody = cashFullName
              ? `${cashFullName} · Inv #${cashOrder.invoice_number ?? "?"} — ${String(a.error)}`
              : String(a.error) + ` · Inv #${cashOrder.invoice_number}`;
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award_failed",
              title: "Loyalty award FAILED — check wiring",
              body: failBody,
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
              metadata: cashLoyaltyAward,
            });
          } else if (a.skipped === true && ANOMALOUS_SKIP_REASONS.includes(String(a.reason))) {
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award_failed",
              title: "Loyalty award SKIPPED — needs attention",
              body: `Award skipped: ${a.reason} · Inv #${cashOrder.invoice_number ?? '?'}`,
              customer_id: cashOrder.customer_id,
              invoice_number: cashOrder.invoice_number,
              metadata: cashLoyaltyAward,
            });
          }
          // benign skips (not_enrolled, below_minimum, already_awarded, no_loyalty_amount, missing_source): no notification
        } catch (nErr) {
          console.warn("[review-payment-submission] staff_notifications insert failed (non-blocking):", nErr);
        }
      }

      // 9. Fire-and-forget: append-cash-receipt if invoice exists
      if (cashOrder.cash_receipt_sheet_id && submission.proof_url) {
        try {
          // Compute slot_index = count of confirmed submissions
          // for this cash_order up to (and including) the current one
          const { count: slotIndex, error: countErr } = await supabase
            .from("payment_submissions")
            .select("id", { count: "exact", head: true })
            .eq("cash_order_id", cashOrder.id)
            .eq("status", "confirmed")
            .not("proof_url", "is", null)
            .lte("created_at", submission.created_at);

          if (countErr || slotIndex == null) {
            console.warn(
              "[review-payment-submission] cash-receipt: failed to compute slot_index (non-blocking):",
              countErr,
            );
          } else if (slotIndex < 1 || slotIndex > 13) {
            console.warn(
              `[review-payment-submission] cash-receipt: slot_index ${slotIndex} out of range (1-13), skipping append`,
            );
          } else {
            // Fetch PHP→JPY rate for amount conversion
            let phpJpyRate = 1.0;
            const { data: rateRow } = await supabase
              .from("system_settings")
              .select("value")
              .eq("key", "php_jpy_rate")
              .single();
            if (rateRow?.value) {
              const parsed = parseFloat(String(rateRow.value));
              if (!isNaN(parsed) && parsed > 0) phpJpyRate = parsed;
            }

            // Fire-and-forget POST (awaited try/catch per cash-branch precedent)
            try {
              await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/append-cash-receipt`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                },
                body: JSON.stringify({
                  sheet_id: cashOrder.cash_receipt_sheet_id,
                  slot_index: slotIndex,
                  proof_url: submission.proof_url,
                  invoice_number: cashOrder.invoice_number,
                  payment_date: submission.payment_date,
                  amount: cashOrder.currency === "JPY"
                    ? submission.submitted_amount
                    : Math.round(submission.submitted_amount / phpJpyRate),
                }),
              });
            } catch (appendErr) {
              console.warn(
                "[review-payment-submission] append-cash-receipt failed (non-blocking):",
                appendErr,
              );
            }
          }
        } catch (cashReceiptErr) {
          console.warn(
            "[review-payment-submission] cash-receipt block failed (non-blocking):",
            cashReceiptErr,
          );
        }
      }

      // 10. Early return — do NOT fall through to layaway logic below
      return new Response(JSON.stringify({
        success: true,
        status: "confirmed",
        submission: { id: submission_id, status: "confirmed", confirmed_payment_id: cashPayment.id },
        cash_order: updatedOrder,
        cash_payment: cashPayment,
        loyalty_awards: cashLoyaltyAward ? [cashLoyaltyAward] : [],
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // ── END CASH ORDER PATH ──

    const loyaltyAwards: Array<Record<string, unknown>> = [];

    // If confirming, create actual payment records
    if (action === "confirmed") {
      // Detect DP submissions using the same heuristics as the payments table
      const subRef = String(submission.reference_number || '');
      const subNotes = String(submission.notes || '');
      const submissionIsDP =
        submission.submission_type === 'downpayment' ||
        subRef.toUpperCase().startsWith('DP-') ||
        /\bdown(payment)?\b|\bdp\b/i.test(subNotes);

      // Fetch customer name for submitted_by_name
      let customerName: string | null = null;
      if (submission.customer_id) {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", submission.customer_id)
          .single();
        customerName = customer?.full_name || null;
      }

      // Single-account: either no allocations, or exactly one matching the submission account.
      // Always use submission.submitted_amount as the authoritative amount (handles edits correctly).
      const isSingleAccount =
        allocs.length === 0 ||
        (allocs.length === 1 && allocs[0].account_id === submission.account_id);

      if (isSingleAccount) {
        const { data: account } = await supabase
          .from("layaway_accounts")
          .select("currency")
          .eq("id", submission.account_id)
          .single();

        const result = await allocatePaymentToAccount(
          supabase,
          submission.account_id,
          Number(submission.submitted_amount),
          submission.payment_date,
          submission.payment_method,
          submission.reference_number,
          `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)}`,
          user.id,
          account?.currency || "PHP",
          submissionIsDP,
          "customer",
          customerName
        );

        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        confirmedPaymentIds.push(result.paymentId);

        if (submissionIsDP) {
          // Membership pre-check: skip the entire loyalty pipeline (no
          // fetch, no push to loyaltyAwards, no notification) when the
          // customer is not enrolled. Only enrolled customers should
          // produce a loyalty record.
          const enrolled = await isCustomerLoyaltyEnrolled(
            supabase,
            (submission as { customer_id?: string | null }).customer_id ?? null,
            submission.account_id,
          );
          if (enrolled) {
            try {
              const lpRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                },
                body: JSON.stringify({ account_id: submission.account_id }),
              });
              const lpJson = await lpRes.json().catch(() => null);
              if (!lpRes.ok) {
                // Explicit HTTP-status check — closes the gap that let
                // the 4-day 401 outage stay silent.
                const bodyErr = (lpJson as { error?: string } | null)?.error;
                loyaltyAwards.push({
                  account_id: submission.account_id,
                  error: bodyErr ?? `http_${lpRes.status}`,
                  status: lpRes.status,
                  ...(lpJson ?? {}),
                });
              } else {
                loyaltyAwards.push({ account_id: submission.account_id, ...(lpJson ?? { error: "no_response" }) });
              }
            } catch (err) {
              console.warn("[review-payment-submission] award-loyalty-points failed (non-blocking):", err);
              loyaltyAwards.push({ account_id: submission.account_id, error: String(err) });
            }
          } else {
            // Benign skip trace — reason isn't in ANOMALOUS_SKIP_REASONS,
            // so the notification loop emits nothing, but the entry
            // appears in the response payload for diagnosability.
            loyaltyAwards.push({
              account_id: submission.account_id,
              skipped: true,
              reason: "pre_check_not_enrolled",
            });
          }
        }
      } else {
        // Multi-account split: process each allocation separately.
        // For these, alloc.allocated_amount is the per-account split amount.
        for (const alloc of allocs) {
          const { data: account } = await supabase
            .from("layaway_accounts")
            .select("currency")
            .eq("id", alloc.account_id)
            .single();

          const result = await allocatePaymentToAccount(
            supabase,
            alloc.account_id,
            Number(alloc.allocated_amount),
            submission.payment_date,
            submission.payment_method,
            submission.reference_number,
            `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)} (${alloc.invoice_number})`,
            user.id,
            account?.currency || "PHP",
            submissionIsDP,
            "customer",
            customerName
          );

          if (result.error) {
            console.error(`Failed to process allocation for ${alloc.invoice_number}:`, result.error);
            continue;
          }
          confirmedPaymentIds.push(result.paymentId);

          if (submissionIsDP) {
            // Membership pre-check: see comment on the single-submission
            // branch above. Skip the entire loyalty pipeline for
            // non-enrolled customers.
            const enrolled = await isCustomerLoyaltyEnrolled(
              supabase,
              (submission as { customer_id?: string | null }).customer_id ?? null,
              alloc.account_id,
            );
            if (enrolled) {
              try {
                const lpRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                  },
                  body: JSON.stringify({ account_id: alloc.account_id }),
                });
                const lpJson = await lpRes.json().catch(() => null);
                if (!lpRes.ok) {
                  // Explicit HTTP-status check — closes the gap that let
                  // the 4-day 401 outage stay silent.
                  const bodyErr = (lpJson as { error?: string } | null)?.error;
                  loyaltyAwards.push({
                    account_id: alloc.account_id,
                    error: bodyErr ?? `http_${lpRes.status}`,
                    status: lpRes.status,
                    ...(lpJson ?? {}),
                  });
                } else {
                  loyaltyAwards.push({ account_id: alloc.account_id, ...(lpJson ?? { error: "no_response" }) });
                }
              } catch (err) {
                console.warn("[review-payment-submission] award-loyalty-points failed (non-blocking):", err);
                loyaltyAwards.push({ account_id: alloc.account_id, error: String(err) });
              }
            } else {
              // Benign skip trace — see comment on the single-submission
              // branch. Informational only; no notification.
              loyaltyAwards.push({
                account_id: alloc.account_id,
                skipped: true,
                reason: "pre_check_not_enrolled",
              });
            }
          }
        }

        if (confirmedPaymentIds.length === 0) {
          return new Response(JSON.stringify({ error: "Failed to create any payment records" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Update submission status
    const updateData: Record<string, unknown> = {
      status: action,
      reviewer_user_id: user.id,
      reviewer_notes: reviewer_notes || null,
      updated_at: new Date().toISOString(),
    };

    if (confirmedPaymentIds.length === 1) {
      updateData.confirmed_payment_id = confirmedPaymentIds[0];
    }

    const { error: updateErr } = await supabase
      .from("payment_submissions")
      .update(updateData)
      .eq("id", submission_id);

    if (updateErr) {
      console.error("Update error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to update submission" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fire-and-forget: append-cash-receipt for single-allocation submissions
    // (matches the line-834 precedent: confirmed_payment_id is only written
    // when confirmedPaymentIds.length === 1; same rule applies here)
    if (
      confirmedPaymentIds.length === 1 &&
      submission.account_id &&
      submission.proof_url
    ) {
      try {
        // Fetch parent account's cash_receipt_sheet_id + invoice_number
        const { data: account, error: acctErr } = await supabase
          .from("layaway_accounts")
          .select("invoice_number, cash_receipt_sheet_id, currency")
          .eq("id", submission.account_id)
          .single();

        if (acctErr || !account) {
          console.warn(
            "[review-payment-submission] cash-receipt: failed to fetch account (non-blocking):",
            acctErr,
          );
        } else if (!account.cash_receipt_sheet_id) {
          // Invoice not yet generated — skip silently (expected case)
          console.log(
            "[review-payment-submission] cash-receipt: no cash_receipt_sheet_id on account, skipping append",
          );
        } else {
          // Compute slot_index
          const { count: slotIndex, error: countErr } = await supabase
            .from("payment_submissions")
            .select("id", { count: "exact", head: true })
            .eq("account_id", submission.account_id)
            .eq("status", "confirmed")
            .not("proof_url", "is", null)
            .lte("created_at", submission.created_at);

          if (countErr || slotIndex == null) {
            console.warn(
              "[review-payment-submission] cash-receipt: failed to compute slot_index (non-blocking):",
              countErr,
            );
          } else if (slotIndex < 1 || slotIndex > 13) {
            console.warn(
              `[review-payment-submission] cash-receipt: slot_index ${slotIndex} out of range (1-13), skipping append`,
            );
          } else {
            // Fetch PHP→JPY rate
            let phpJpyRate = 1.0;
            const { data: rateRow } = await supabase
              .from("system_settings")
              .select("value")
              .eq("key", "php_jpy_rate")
              .single();
            if (rateRow?.value) {
              const parsed = parseFloat(String(rateRow.value));
              if (!isNaN(parsed) && parsed > 0) phpJpyRate = parsed;
            }

            // Fire-and-forget POST (.catch() per layaway-branch precedent at line 811)
            fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/append-cash-receipt`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify({
                sheet_id: account.cash_receipt_sheet_id,
                slot_index: slotIndex,
                proof_url: submission.proof_url,
                invoice_number: account.invoice_number,
                payment_date: submission.payment_date,
                amount: account.currency === "JPY"
                  ? submission.submitted_amount
                  : Math.round(submission.submitted_amount / phpJpyRate),
              }),
            }).catch((err) => {
              console.warn(
                "[review-payment-submission] append-cash-receipt failed (non-blocking):",
                err,
              );
            });
          }
        }
      } catch (cashReceiptErr) {
        console.warn(
          "[review-payment-submission] cash-receipt block failed (non-blocking):",
          cashReceiptErr,
        );
      }
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment_submission",
      entity_id: submission_id,
      action: `submission_${action}`,
      performed_by_user_id: user.id,
      new_value_json: {
        status: action,
        reviewer_notes,
        confirmed_payment_ids: confirmedPaymentIds,
        allocation_count: allocs.length,
      },
      old_value_json: { status: submission.status },
    });

    // Send status-change email to customer (fire-and-forget)
    try {
      const { data: acctForEmail } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, currency, remaining_balance, customers(full_name, email)")
        .eq("id", submission.account_id)
        .single();
      const customerEmail = (acctForEmail as any)?.customers?.email;
      if (customerEmail) {
        let templateName = "";
        const baseData: Record<string, unknown> = {
          customerName: (acctForEmail as any)?.customers?.full_name || "Valued Customer",
          invoiceNumber: acctForEmail?.invoice_number || "",
          amountPaid: Number(submission.submitted_amount).toLocaleString("en-US"),
          currency: acctForEmail?.currency || "PHP",
          portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${acctForEmail?.invoice_number || ""}`,
        };

        if (action === "confirmed") {
          templateName = "payment-confirmed";
          baseData.paymentDate = submission.payment_date;
          baseData.paymentMethod = submission.payment_method || "cash";
          baseData.remainingBalance = Number(acctForEmail?.remaining_balance ?? 0).toLocaleString("en-US");
        } else if (action === "rejected") {
          templateName = "payment-rejected";
          baseData.rejectionReason = reviewer_notes || "";
        } else if (action === "needs_clarification") {
          templateName = "payment-needs-clarification";
          baseData.clarificationNotes = reviewer_notes || "";
        }

        if (templateName) {
          await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({
              templateName,
              recipientEmail: customerEmail,
              idempotencyKey: `${templateName}-${submission_id}`,
              templateData: baseData,
            }),
          });
        }
      }
    } catch (emailErr) {
      console.warn("[review-payment-submission] email send failed (non-blocking):", emailErr);
    }

    for (const award of loyaltyAwards) {
      try {
        if ((award as any).awarded) {
          const a: any = award;
          const ctx = await resolveAwardNotifyContext(supabase, {
            account_id: a.account_id ?? null,
          });
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award",
            title: "Loyalty points awarded",
            body: buildLoyaltyAwardBody(a, ctx),
            account_id: a.account_id ?? null,
            metadata: a,
          });
        } else if ((award as any).error) {
          const a: any = award;
          // Resolve customer name + invoice via layaway_accounts join. If
          // the lookup itself fails, fall back to the original String(a.error)
          // body — the notification must never be skipped on a name miss.
          let layawayFullName: string | null = null;
          let layawayInvoice: string | null = null;
          if (a.account_id) {
            try {
              const { data: acct } = await supabase
                .from("layaway_accounts")
                .select("invoice_number, customers(full_name)")
                .eq("id", a.account_id)
                .maybeSingle();
              const row = acct as { invoice_number?: string | null; customers?: { full_name?: string | null } | null } | null;
              layawayFullName = row?.customers?.full_name ?? null;
              layawayInvoice = row?.invoice_number ?? null;
            } catch (_lookupErr) {
              layawayFullName = null;
              layawayInvoice = null;
            }
          }
          const failBody = (layawayFullName || layawayInvoice)
            ? `${layawayFullName ?? "Unknown"} · Inv #${layawayInvoice ?? "?"} — ${String(a.error)}`
            : String(a.error);
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award_failed",
            title: "Loyalty award FAILED — check wiring",
            body: failBody,
            account_id: a.account_id ?? null,
            metadata: a,
          });
        } else if ((award as any).skipped === true && ANOMALOUS_SKIP_REASONS.includes(String((award as any).reason))) {
          const a: any = award;
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award_failed",
            title: "Loyalty award SKIPPED — needs attention",
            body: `Award skipped: ${a.reason} · Inv #?`,
            account_id: a.account_id ?? null,
            metadata: a,
          });
        }
        // benign skips (not_enrolled, below_minimum, already_awarded, no_loyalty_amount, missing_source): no notification
      } catch (nErr) {
        console.warn("[review-payment-submission] staff_notifications insert failed (non-blocking):", nErr);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      status: action,
      confirmed_payment_ids: confirmedPaymentIds,
      loyalty_awards: loyaltyAwards,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
