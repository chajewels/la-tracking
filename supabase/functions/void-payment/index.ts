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
      if (item.due_date <= today) {
        hasOverdue = true;
      }
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
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { payment_id, reason } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get all allocations for this payment
    const { data: allocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    // Reverse each allocation
    for (const alloc of (allocations || [])) {
      if (alloc.allocation_type === "installment") {
        const { data: sched } = await supabase
          .from("layaway_schedule")
          .select("*")
          .eq("id", alloc.schedule_id)
          .single();

        if (sched) {
          const newPaid = Math.max(0, Number(sched.paid_amount) - Number(alloc.allocated_amount));
          // Determine proper status based on paid amount and due date
          const today = new Date().toISOString().split("T")[0];
          let newStatus: string;
          if (newPaid >= Number(sched.base_installment_amount)) {
            newStatus = "paid";
          } else if (newPaid > 0) {
            newStatus = "partially_paid";
          } else if (sched.due_date <= today) {
            newStatus = "overdue";
          } else {
            newStatus = "pending";
          }

          await supabase.from("layaway_schedule").update({
            paid_amount: newPaid,
            status: newStatus,
          }).eq("id", alloc.schedule_id);
        }
      } else if (alloc.allocation_type === "penalty") {
        // Find matching paid penalty for this schedule item
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

          // Update the schedule item's penalty_amount to reflect unpaid penalty
          const { data: allPenalties } = await supabase
            .from("penalty_fees")
            .select("penalty_amount, status")
            .eq("schedule_id", alloc.schedule_id)
            .eq("account_id", payment.account_id);

          if (allPenalties) {
            const totalUnpaidPenalty = allPenalties
              .filter(p => p.status === "unpaid" || p.id === penaltyFees[0].id)
              .reduce((sum, p) => sum + Number(p.penalty_amount), 0);

            const { data: schedItem } = await supabase
              .from("layaway_schedule")
              .select("base_installment_amount")
              .eq("id", alloc.schedule_id)
              .single();

            if (schedItem) {
              await supabase.from("layaway_schedule").update({
                penalty_amount: totalUnpaidPenalty,
                total_due_amount: Number(schedItem.base_installment_amount) + totalUnpaidPenalty,
              }).eq("id", alloc.schedule_id);
            }
          }
        }
      }
    }

    // Now recalculate account from the updated schedule
    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", payment.account_id)
      .single();

    if (account && updatedSchedule) {
      const newTotalPaid = Math.max(0, Number(account.total_paid) - Number(payment.amount_paid));
      const newRemaining = calcRemainingBalance(updatedSchedule);
      const newStatus = determineAccountStatus(updatedSchedule, account.status);

      await supabase.from("layaway_accounts").update({
        total_paid: newTotalPaid,
        remaining_balance: Math.max(0, newRemaining),
        status: newStatus,
      }).eq("id", payment.account_id);
    }

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
