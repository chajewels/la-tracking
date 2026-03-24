import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const round2 = (n: number) => Math.round(n * 100) / 100;

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

    // Only admin/finance can edit payment amounts
    const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
    ]);
    if (!isAdmin && !isFinance) {
      return new Response(JSON.stringify({ error: "Only admin/finance can edit payment amounts" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { payment_id, new_amount, reason } = await req.json();
    if (!payment_id || new_amount == null || Number(new_amount) <= 0) {
      return new Response(JSON.stringify({ error: "payment_id and valid new_amount are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const newAmount = round2(Number(new_amount));

    // Fetch original payment (must be non-voided)
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

    const oldAmount = round2(Number(payment.amount_paid));
    if (oldAmount === newAmount) {
      return new Response(JSON.stringify({ error: "New amount is the same as current amount" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
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

    // ══════════════════════════════════════════════
    // PHASE 1: REVERSE old allocations
    // ══════════════════════════════════════════════

    // Get old allocations for this payment
    const { data: oldAllocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    // Get all valid payment IDs (excluding current one for recalculation)
    const { data: validPayments } = await supabase
      .from("payments")
      .select("id")
      .eq("account_id", payment.account_id)
      .is("voided_at", null);
    const otherPaymentIds = new Set((validPayments || []).filter(p => p.id !== payment_id).map(p => p.id));

    // For each schedule item affected, recalculate from other payments only
    const affectedScheduleIds = new Set<string>();
    for (const alloc of (oldAllocations || [])) {
      affectedScheduleIds.add(alloc.schedule_id);
    }

    for (const scheduleId of affectedScheduleIds) {
      const { data: allAllocs } = await supabase
        .from("payment_allocations")
        .select("allocated_amount, payment_id")
        .eq("schedule_id", scheduleId)
        .eq("allocation_type", "installment");

      const paidWithoutThis = round2((allAllocs || [])
        .filter(a => otherPaymentIds.has(a.payment_id))
        .reduce((sum, a) => sum + Number(a.allocated_amount), 0));

      const { data: sched } = await supabase
        .from("layaway_schedule")
        .select("base_installment_amount, due_date")
        .eq("id", scheduleId)
        .single();

      if (sched) {
        const base = round2(Number(sched.base_installment_amount));
        const today = new Date().toISOString().split("T")[0];
        const status = paidWithoutThis >= base ? "paid"
          : paidWithoutThis > 0 ? "partially_paid"
          : sched.due_date <= today ? "overdue" : "pending";

        await supabase.from("layaway_schedule").update({
          paid_amount: paidWithoutThis,
          status,
        }).eq("id", scheduleId);
      }

      // Revert penalty allocations
      const penAllocForSchedule = (oldAllocations || []).filter(
        a => a.schedule_id === scheduleId && a.allocation_type === "penalty"
      );
      for (const _pa of penAllocForSchedule) {
        const { data: penFees } = await supabase
          .from("penalty_fees")
          .select("id")
          .eq("schedule_id", scheduleId)
          .eq("status", "paid")
          .eq("account_id", payment.account_id)
          .order("created_at", { ascending: true })
          .limit(1);
        if (penFees && penFees.length > 0) {
          await supabase.from("penalty_fees").update({ status: "unpaid" }).eq("id", penFees[0].id);
        }
      }
    }

    // Delete old allocations for this payment
    await supabase.from("payment_allocations").delete().eq("payment_id", payment_id);

    // ══════════════════════════════════════════════
    // PHASE 2: UPDATE payment amount
    // ══════════════════════════════════════════════
    await supabase.from("payments").update({ amount_paid: newAmount }).eq("id", payment_id);

    // ══════════════════════════════════════════════
    // PHASE 3: RE-ALLOCATE with new amount
    // ══════════════════════════════════════════════

    // Fetch fresh schedule
    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    // Fetch unpaid penalties
    const { data: unpaidPenalties } = await supabase
      .from("penalty_fees")
      .select("*")
      .eq("account_id", payment.account_id)
      .eq("status", "unpaid")
      .order("penalty_date", { ascending: true });

    let remaining = newAmount;
    const newAllocations: Array<{
      schedule_id: string;
      allocation_type: "penalty" | "installment";
      allocated_amount: number;
    }> = [];

    // Pay penalties first
    if (unpaidPenalties) {
      for (const pen of unpaidPenalties) {
        if (remaining <= 0) break;
        const penAmount = Number(pen.penalty_amount);
        const toPay = round2(Math.min(remaining, penAmount));
        remaining = round2(remaining - toPay);
        newAllocations.push({
          schedule_id: pen.schedule_id,
          allocation_type: "penalty",
          allocated_amount: toPay,
        });
        await supabase.from("penalty_fees").update({
          status: toPay >= penAmount ? "paid" : "unpaid",
        }).eq("id", pen.id);
      }
    }

    // Allocate to installments
    if (remaining > 0 && schedule) {
      const unpaidItems = schedule.filter(
        item => item.status !== "paid" && item.status !== "cancelled"
      ).sort((a, b) => a.installment_number - b.installment_number);

      for (const item of unpaidItems) {
        if (remaining <= 0) break;
        const currentPaid = Number(item.paid_amount);
        const baseAmount = Number(item.base_installment_amount);
        const due = Math.max(0, round2(baseAmount - currentPaid));
        if (due <= 0) continue;

        const toApply = round2(Math.min(remaining, due));
        remaining = round2(remaining - toApply);
        const newPaid = round2(currentPaid + toApply);
        const newStatus = newPaid >= baseAmount ? "paid" : "partially_paid";

        newAllocations.push({
          schedule_id: item.id,
          allocation_type: "installment",
          allocated_amount: toApply,
        });

        await supabase.from("layaway_schedule").update({
          paid_amount: newPaid,
          status: newStatus,
        }).eq("id", item.id);
      }
    }

    // Insert new allocations
    for (const alloc of newAllocations) {
      await supabase.from("payment_allocations").insert({
        payment_id: payment_id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });
    }

    // ══════════════════════════════════════════════
    // PHASE 4: RECONCILE account totals
    // ══════════════════════════════════════════════
    const { data: postEditPayments } = await supabase
      .from("payments")
      .select("amount_paid")
      .eq("account_id", payment.account_id)
      .is("voided_at", null);
    const verifiedTotalPaid = round2((postEditPayments || []).reduce((s, p) => s + Number(p.amount_paid), 0));
    const verifiedRemaining = round2(Math.max(0, Number(account.total_amount) - verifiedTotalPaid));

    const { data: finalSchedule } = await supabase
      .from("layaway_schedule")
      .select("status, due_date")
      .eq("account_id", payment.account_id);

    let newAccountStatus = account.status;
    if (finalSchedule) {
      const today = new Date().toISOString().split("T")[0];
      const allPaid = finalSchedule.every(s => s.status === "paid" || s.status === "cancelled");
      const hasOverdue = finalSchedule.some(s => s.status !== "paid" && s.status !== "cancelled" && s.due_date <= today);
      if (allPaid) newAccountStatus = "completed";
      else if (hasOverdue) newAccountStatus = "overdue";
      else newAccountStatus = "active";
    }

    await supabase.from("layaway_accounts").update({
      total_paid: verifiedTotalPaid,
      remaining_balance: verifiedRemaining,
      status: newAccountStatus,
    }).eq("id", payment.account_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "edit_amount",
      old_value_json: { amount_paid: oldAmount, account_id: payment.account_id },
      new_value_json: { amount_paid: newAmount, reason: reason || "Amount corrected", edited_by: user.id },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({
      success: true,
      payment_id,
      old_amount: oldAmount,
      new_amount: newAmount,
      new_total_paid: verifiedTotalPaid,
      new_remaining_balance: verifiedRemaining,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
