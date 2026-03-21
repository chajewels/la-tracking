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
          await supabase.from("layaway_schedule").update({
            paid_amount: newPaid,
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

    // Step 2: Fix overpayment-reduced installments
    // When record-payment handles overpayment, it reduces base_installment_amount of
    // future installments (from the end). We need to restore those.
    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    if (schedule && schedule.length > 0) {
      const expectedInstallmentTotal = Number(account.total_amount) - Number(account.downpayment_amount);
      const currentBaseSum = schedule.reduce((sum, s) => sum + Number(s.base_installment_amount), 0);
      let deficit = Math.round((expectedInstallmentTotal - currentBaseSum) * 100) / 100;

      if (deficit > 0.5) {
        // Redistribute deficit to installments with reduced/zero base, from the last backwards
        const reversedSchedule = [...schedule].reverse();
        for (const item of reversedSchedule) {
          if (deficit <= 0) break;

          // Find installments whose base was likely reduced (base is 0 or suspiciously low)
          // A normal installment base should be roughly expectedTotal / planMonths
          const normalBase = expectedInstallmentTotal / schedule.length;
          const currentBase = Number(item.base_installment_amount);

          if (currentBase < normalBase * 0.5) {
            // This item was likely reduced by overpayment
            const restore = Math.min(deficit, normalBase - currentBase);
            const newBase = currentBase + restore;
            deficit -= restore;

            // If it was marked "paid" with 0 base and 0 paid, reset it
            const paidAmt = Number(item.paid_amount);
            const newStatus = determineScheduleStatus({
              paid_amount: paidAmt,
              base_installment_amount: newBase,
              due_date: item.due_date,
            });

            await supabase.from("layaway_schedule").update({
              base_installment_amount: newBase,
              total_due_amount: newBase + Number(item.penalty_amount || 0),
              status: newStatus,
            }).eq("id", item.id);

            // Update our local copy for remaining balance calc
            item.base_installment_amount = newBase;
            item.total_due_amount = newBase + Number(item.penalty_amount || 0);
            item.status = newStatus;
          }
        }

        // If there's still deficit (edge case), add it to the last non-paid item
        if (deficit > 0.5) {
          for (const item of reversedSchedule) {
            if (item.status !== "paid" && item.status !== "cancelled") {
              const currentBase = Number(item.base_installment_amount);
              const newBase = currentBase + deficit;
              const newStatus = determineScheduleStatus({
                paid_amount: Number(item.paid_amount),
                base_installment_amount: newBase,
                due_date: item.due_date,
              });
              await supabase.from("layaway_schedule").update({
                base_installment_amount: newBase,
                total_due_amount: newBase + Number(item.penalty_amount || 0),
                status: newStatus,
              }).eq("id", item.id);
              item.base_installment_amount = newBase;
              item.total_due_amount = newBase + Number(item.penalty_amount || 0);
              item.status = newStatus;
              break;
            }
          }
        }
      }

      // Step 3: Update all schedule statuses based on current paid amounts
      for (const item of schedule) {
        const correctStatus = determineScheduleStatus({
          paid_amount: Number(item.paid_amount),
          base_installment_amount: Number(item.base_installment_amount),
          due_date: item.due_date,
        });
        if (correctStatus !== item.status) {
          await supabase.from("layaway_schedule").update({ status: correctStatus }).eq("id", item.id);
          item.status = correctStatus;
        }
      }

      // Step 4: Recalculate account totals from schedule
      const newTotalPaid = Math.max(0, Number(account.total_paid) - Number(payment.amount_paid));
      const newRemaining = calcRemainingBalance(schedule);
      const newStatus = determineAccountStatus(schedule, account.status);

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
