import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

    // Step 1: Mark payment as voided FIRST so recalculations exclude it
    await supabase.from("payments").update({
      voided_at: new Date().toISOString(),
      voided_by_user_id: user.id,
      void_reason: reason || "Voided by user",
    }).eq("id", payment_id);

    // Step 1b: Clear carried_amount on any schedule row where this payment triggered a carry
    // (carried_by_payment_id = payment_id). Guard with try/catch in case column doesn't exist yet.
    try {
      const { data: carryRows } = await supabase
        .from("layaway_schedule")
        .select("id")
        .eq("carried_by_payment_id", payment_id);
      for (const row of (carryRows || [])) {
        await supabase.from("layaway_schedule").update({
          carried_amount: 0,
          carried_from_schedule_id: null,
          carried_by_payment_id: null,
        }).eq("id", row.id);
      }
    } catch (_carryErr) {
      // Column may not exist yet — safe to ignore until migration runs
    }

    // Step 2: Collect all schedule IDs affected by this payment
    const affectedScheduleIds = new Set<string>();
    for (const alloc of (allocations || [])) {
      affectedScheduleIds.add(alloc.schedule_id);
    }

    // Step 3: For each affected schedule item, recalculate paid_amount
    // from all remaining non-voided payment allocations (source-of-truth)
    const { data: validPayments } = await supabase
      .from("payments")
      .select("id")
      .eq("account_id", payment.account_id)
      .is("voided_at", null);
    const validPaymentIds = new Set((validPayments || []).map(p => p.id));

    for (const scheduleId of affectedScheduleIds) {
      // Recalculate installment paid_amount from non-voided allocations
      const { data: allAllocations } = await supabase
        .from("payment_allocations")
        .select("allocated_amount, allocation_type, payment_id")
        .eq("schedule_id", scheduleId)
        .eq("allocation_type", "installment");

      const recalcPaid = (allAllocations || [])
        .filter(a => validPaymentIds.has(a.payment_id))
        .reduce((sum, a) => sum + Number(a.allocated_amount), 0);

      const { data: sched } = await supabase
        .from("layaway_schedule")
        .select("base_installment_amount, due_date")
        .eq("id", scheduleId)
        .single();

      if (sched) {
        const base = Number(sched.base_installment_amount);
        const today = new Date().toISOString().split("T")[0];
        const newSchedStatus = Math.round(recalcPaid * 100) / 100 >= Math.round(base * 100) / 100 ? "paid"
          : recalcPaid > 0 ? "partially_paid"
          : sched.due_date <= today ? "overdue"
          : "pending";

        await supabase.from("layaway_schedule").update({
          paid_amount: recalcPaid,
          status: newSchedStatus,
        }).eq("id", scheduleId);
      }

      // Revert penalty allocations for this payment on this schedule
      const penaltyAllocs = (allocations || []).filter(
        a => a.schedule_id === scheduleId && a.allocation_type === "penalty"
      );
      for (const _pa of penaltyAllocs) {
        const { data: penaltyFees } = await supabase
          .from("penalty_fees")
          .select("id")
          .eq("schedule_id", scheduleId)
          .eq("status", "paid")
          .eq("account_id", payment.account_id)
          .order("created_at", { ascending: true })
          .limit(1);
        if (penaltyFees && penaltyFees.length > 0) {
          await supabase.from("penalty_fees").update({ status: "unpaid" }).eq("id", penaltyFees[0].id);
        }
      }
    }

    // Step 4: Recalculate account totals from non-voided payments
    const newTotalPaid = (validPayments || []).length > 0
      ? await (async () => {
          const { data: activePayments } = await supabase
            .from("payments")
            .select("amount_paid")
            .eq("account_id", payment.account_id)
            .is("voided_at", null);
          return (activePayments || []).reduce((s, p) => s + Number(p.amount_paid), 0);
        })()
      : 0;

    // PRINCIPAL-ONLY remaining: exclude penalty payments
    const { data: paidPenaltyFees } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", payment.account_id)
      .eq("status", "paid");
    const penaltyPaidSum = (paidPenaltyFees || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
    const newRemainingBalance = Math.max(0, Number(account.total_amount) - (newTotalPaid - penaltyPaidSum));

    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("status, due_date")
      .eq("account_id", payment.account_id);

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

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "void",
      old_value_json: { amount_paid: payment.amount_paid, account_id: payment.account_id },
      new_value_json: { reason, voided_by: user.id },
      performed_by_user_id: user.id,
    });

    // Trigger reconcile-account to sync schedule rows and verify totals
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/reconcile-account`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ account_id: payment.account_id }),
        }
      );
    } catch (reconcileErr) {
      console.warn(`[void-payment] reconcile-account call failed for ${payment.account_id}:`, reconcileErr);
    }

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
