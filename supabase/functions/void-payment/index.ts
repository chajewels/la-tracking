import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function determineScheduleStatus(item: { paid_amount: number; base_installment_amount: number; due_date: string }): string {
  const today = new Date().toISOString().split("T")[0];
  if (item.paid_amount >= item.base_installment_amount && item.base_installment_amount > 0) return "paid";
  if (item.paid_amount > 0) return "partially_paid";
  if (item.due_date <= today) return "overdue";
  return "pending";
}

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

function calcRemainingBalance(schedule: any[]): number {
  let remaining = 0;
  for (const item of schedule) {
    if (item.status !== "paid" && item.status !== "cancelled") {
      remaining += Math.max(0, Number(item.base_installment_amount) + Number(item.penalty_amount || 0) - Number(item.paid_amount));
    }
  }
  return remaining;
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

    const { payment_id, reason } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*")
      .eq("id", payment_id)
      .is("voided_at", null)
      .single();

    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found or already voided" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get account info (need downpayment_amount for recalculation)
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

    // Get all allocations for this payment
    const { data: allocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    // Step 1: Reverse direct allocation effects on schedule items
    for (const alloc of (allocations || [])) {
      if (alloc.allocation_type === "installment") {
        const { data: sched } = await supabase
          .from("layaway_schedule")
          .select("*")
          .eq("id", alloc.schedule_id)
          .single();

        if (sched) {
          const newPaid = Math.max(0, Number(sched.paid_amount) - Number(alloc.allocated_amount));
          const baseAmount = Number(sched.base_installment_amount);
          // base_installment_amount is NEVER modified — only paid_amount and status
          const newStatus = newPaid >= baseAmount ? "paid"
            : newPaid > 0 ? "partially_paid"
            : sched.due_date <= new Date().toISOString().split("T")[0] ? "overdue"
            : "pending";

          await supabase.from("layaway_schedule").update({
            paid_amount: newPaid,
            status: newStatus,
          }).eq("id", alloc.schedule_id);
        }
      } else if (alloc.allocation_type === "penalty") {
        const { data: penaltyFees } = await supabase
          .from("penalty_fees")
          .select("*")
          .eq("schedule_id", alloc.schedule_id)
          .eq("status", "paid")
          .eq("account_id", payment.account_id)
          .order("created_at", { ascending: true })
          .limit(1);

        if (penaltyFees && penaltyFees.length > 0) {
          await supabase.from("penalty_fees").update({ status: "unpaid" }).eq("id", penaltyFees[0].id);
        }
      }
    }

    // Step 2: Update account totals using SINGLE SOURCE OF TRUTH
    // remaining_balance = total_amount - SUM(non-voided payments)
    const newTotalPaid = Math.max(0, Number(account.total_paid) - Number(payment.amount_paid));
    const newRemainingBalance = Math.max(0, Number(account.total_amount) - newTotalPaid);

    // Determine account status from schedule
    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    let newStatus = account.status;
    if (updatedSchedule) {
      const today = new Date().toISOString().split("T")[0];
      const allPaid = updatedSchedule.every(s => s.status === "paid" || s.status === "cancelled");
      const hasOverdue = updatedSchedule.some(s => s.status !== "paid" && s.status !== "cancelled" && s.due_date <= today);
      if (allPaid) newStatus = "completed";
      else if (hasOverdue) newStatus = "overdue";
      else newStatus = "active";
    }

    await supabase.from("layaway_accounts").update({
      total_paid: newTotalPaid,
      remaining_balance: newRemainingBalance,
      status: newStatus,
    }).eq("id", payment.account_id);

    // Mark payment as voided
    await supabase.from("payments").update({
      voided_at: new Date().toISOString(),
      voided_by_user_id: user.id,
      void_reason: reason || "Voided by user",
    }).eq("id", payment_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "void",
      old_value_json: { amount_paid: payment.amount_paid, account_id: payment.account_id },
      new_value_json: { reason, voided_by: user.id },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
