import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function determineAccountStatus(schedule: any[], currentStatus: string): string {
  if (currentStatus === "cancelled" || currentStatus === "forfeited") return currentStatus;
  const today = new Date().toISOString().split("T")[0];
  let allPaid = true;
  let hasOverdue = false;
  for (const item of schedule) {
    if (item.status === "cancelled") continue;
    if (item.status !== "paid") {
      allPaid = false;
      if (item.due_date <= today) hasOverdue = true;
    }
  }
  if (allPaid) return "completed";
  if (hasOverdue) return "overdue";
  return "active";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function calcRemainingBalance(schedule: any[]): number {
  let remaining = 0;
  for (const item of schedule) {
    if (item.status !== "paid" && item.status !== "cancelled") {
      remaining += Math.max(0, round2(Number(item.base_installment_amount) + Number(item.penalty_amount || 0) - Number(item.paid_amount)));
    }
  }
  return round2(remaining);
}

function scheduleStatusFor(base: number, paid: number, dueDate: string): string {
  if (round2(paid) >= round2(base)) return "paid";
  if (paid > 0) return "partially_paid";
  const today = new Date().toISOString().split("T")[0];
  return dueDate <= today ? "overdue" : "pending";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { payment_id, selected_schedule_ids } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*")
      .eq("id", payment_id)
      .not("voided_at", "is", null)
      .single();

    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found or not voided" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", payment.account_id)
      .single();

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: originalAllocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    if (!schedule || schedule.length === 0) {
      return new Response(JSON.stringify({ error: "Schedule not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const selectedIds = Array.isArray(selected_schedule_ids) ? selected_schedule_ids.filter(Boolean) : [];
    const originalInstallmentAllocations = (originalAllocations || []).filter((alloc) => alloc.allocation_type === "installment");
    const originalPenaltyAllocations = (originalAllocations || []).filter((alloc) => alloc.allocation_type === "penalty");

    let remainingInstallmentAmount = round2(originalInstallmentAllocations.reduce((sum, alloc) => sum + Number(alloc.allocated_amount), 0));

    // Primary targets: selected items first, then all unpaid items for overflow
    const selectedTargets = (selectedIds.length > 0
      ? schedule.filter((item) => selectedIds.includes(item.id))
      : schedule.filter((item) => item.status !== "paid" && item.status !== "cancelled")
    ).sort((a, b) => a.installment_number - b.installment_number);

    // Overflow targets: all remaining unpaid items not already in selectedTargets
    const selectedIdSet = new Set(selectedTargets.map((t) => t.id));
    const overflowTargets = schedule
      .filter((item) => !selectedIdSet.has(item.id) && item.status !== "paid" && item.status !== "cancelled")
      .sort((a, b) => a.installment_number - b.installment_number);

    const allTargets = [...selectedTargets, ...overflowTargets];

    if (allTargets.length === 0 && remainingInstallmentAmount > 0) {
      return new Response(JSON.stringify({ error: "No valid monthly dues available for restore" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── PHASE 1: DRY-RUN — compute all changes without mutating anything ──
    const plannedAllocations: Array<{ schedule_id: string; allocation_type: "penalty" | "installment"; allocated_amount: number }> = [];
    const plannedScheduleUpdates: Array<{ id: string; paid_amount: number; status: string }> = [];
    let dryRunRemaining = remainingInstallmentAmount;

    for (const item of allTargets) {
      if (dryRunRemaining <= 0) break;

      const base = Number(item.base_installment_amount);
      const paid = Number(item.paid_amount);
      const due = Math.max(0, round2(base - paid));
      if (due <= 0) continue;

      const toApply = round2(Math.min(dryRunRemaining, due));
      dryRunRemaining = round2(dryRunRemaining - toApply);

      const newPaid = round2(paid + toApply);
      const newStatus = scheduleStatusFor(base, newPaid, item.due_date);

      plannedScheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: newStatus });
      plannedAllocations.push({
        schedule_id: item.id,
        allocation_type: "installment",
        allocated_amount: toApply,
      });
    }

    // Validate: all installment amount must be covered
    if (dryRunRemaining > 0.01) {
      return new Response(JSON.stringify({ error: "Not enough unpaid monthly dues to fully restore this payment amount" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── PHASE 2: APPLY — all validation passed, now mutate ──

    // Handle penalty allocations
    for (const alloc of originalPenaltyAllocations) {
      const { data: penaltyFees } = await supabase
        .from("penalty_fees")
        .select("*")
        .eq("schedule_id", alloc.schedule_id)
        .eq("status", "unpaid")
        .eq("account_id", payment.account_id)
        .order("created_at", { ascending: true })
        .limit(1);

      if (penaltyFees && penaltyFees.length > 0) {
        await supabase.from("penalty_fees").update({ status: "paid" }).eq("id", penaltyFees[0].id);
        plannedAllocations.push({
          schedule_id: alloc.schedule_id,
          allocation_type: "penalty",
          allocated_amount: Number(alloc.allocated_amount),
        });
      }
    }

    // Apply schedule updates
    for (const update of plannedScheduleUpdates) {
      await supabase.from("layaway_schedule").update({
        paid_amount: update.paid_amount,
        status: update.status,
      }).eq("id", update.id);
    }

    // Recreate allocations
    await supabase.from("payment_allocations").delete().eq("payment_id", payment_id);
    for (const alloc of plannedAllocations) {
      await supabase.from("payment_allocations").insert({
        payment_id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });
    }

    // Update account totals
    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    if (updatedSchedule) {
      const newTotalPaid = round2(Number(account.total_paid) + Number(payment.amount_paid));
      const newRemaining = calcRemainingBalance(updatedSchedule);
      const newStatus = determineAccountStatus(updatedSchedule, account.status);

      await supabase.from("layaway_accounts").update({
        total_paid: newTotalPaid,
        remaining_balance: Math.max(0, newRemaining),
        status: newStatus,
      }).eq("id", payment.account_id);
    }

    // Clear voided flags — LAST step so everything is consistent
    await supabase.from("payments").update({
      voided_at: null,
      voided_by_user_id: null,
      void_reason: null,
    }).eq("id", payment_id);

    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "restore",
      old_value_json: { voided_at: payment.voided_at, void_reason: payment.void_reason },
      new_value_json: { restored_by: user.id, selected_schedule_ids: selectedIds },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
