import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

    const body = await req.json();
    const { account_id, amount_paid, date_paid, payment_method, reference_number, remarks, preview_only } = body;

    if (!account_id || !amount_paid || amount_paid <= 0) {
      return new Response(JSON.stringify({ error: "Invalid payment data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (account.status !== "active" && account.status !== "overdue") {
      return new Response(JSON.stringify({ error: "Account is not active" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch schedule ordered by installment
    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", account_id)
      .order("installment_number", { ascending: true });

    if (!schedule) {
      return new Response(JSON.stringify({ error: "Schedule not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch unpaid penalties
    const { data: unpaidPenalties } = await supabase
      .from("penalty_fees")
      .select("*")
      .eq("account_id", account_id)
      .eq("status", "unpaid")
      .order("penalty_date", { ascending: true });

    // Allocate payment: penalties first, then installments
    let remaining = Number(amount_paid);
    const allocations: Array<{
      schedule_id: string;
      allocation_type: "penalty" | "installment";
      allocated_amount: number;
      penalty_fee_id?: string;
    }> = [];
    const penaltyUpdates: Array<{ id: string; status: string; paid_amount: number }> = [];
    const scheduleUpdates: Array<{
      id: string;
      paid_amount?: number;
      status?: string;
      base_installment_amount?: number;
      total_due_amount?: number;
    }> = [];

    // 1. Pay unpaid penalties first
    if (unpaidPenalties) {
      for (const pen of unpaidPenalties) {
        if (remaining <= 0) break;
        const penAmount = Number(pen.penalty_amount);
        const toPay = Math.min(remaining, penAmount);
        remaining -= toPay;
        allocations.push({
          schedule_id: pen.schedule_id,
          allocation_type: "penalty",
          allocated_amount: toPay,
          penalty_fee_id: pen.id,
        });
        penaltyUpdates.push({
          id: pen.id,
          status: toPay >= penAmount ? "paid" : "unpaid",
          paid_amount: toPay,
        });
      }
    }

    // 2. For single-invoice payments, keep the full installment portion on one target installment
    //    and reduce the last remaining installments instead of splitting across the next due items.
    const effectiveDate = date_paid || new Date().toISOString().split("T")[0];
    const unpaidItems = schedule.filter(item => item.status !== "paid" && Number(item.base_installment_amount) - Number(item.paid_amount) > 0);
    const targetInstallment = unpaidItems.find(item => item.due_date <= effectiveDate) ?? unpaidItems[0];

    if (remaining > 0 && targetInstallment) {
      const currentPaid = Number(targetInstallment.paid_amount);
      const baseAmount = Number(targetInstallment.base_installment_amount);
      const installmentPortion = remaining;
      const newPaid = currentPaid + installmentPortion;

      allocations.push({
        schedule_id: targetInstallment.id,
        allocation_type: "installment",
        allocated_amount: installmentPortion,
      });

      const laterUnpaidItems = unpaidItems.filter(
        item => item.id !== targetInstallment.id && item.installment_number > targetInstallment.installment_number,
      );

      if (newPaid >= baseAmount) {
        // Full or overpayment — mark paid, reduce future installments from end with excess
        scheduleUpdates.push({
          id: targetInstallment.id,
          paid_amount: newPaid,
          status: "paid",
        });

        let excessAmount = Math.max(0, newPaid - baseAmount);

        for (const item of [...laterUnpaidItems].reverse()) {
          if (excessAmount <= 0) break;

          const itemBaseAmount = Number(item.base_installment_amount);
          const itemPaidAmount = Number(item.paid_amount);
          const remainingDue = Math.max(0, itemBaseAmount - itemPaidAmount);
          const reduction = Math.min(excessAmount, remainingDue);

          if (reduction <= 0) continue;

          excessAmount -= reduction;

          const newBase = Math.max(itemPaidAmount, itemBaseAmount - reduction);
          const nextStatus = itemPaidAmount >= newBase ? "paid" : itemPaidAmount > 0 ? "partially_paid" : item.status;

          scheduleUpdates.push({
            id: item.id,
            base_installment_amount: newBase,
            total_due_amount: newBase + Number(item.penalty_amount || 0),
            status: nextStatus,
          });
        }
      } else {
        // Short payment — mark current installment as paid for actual amount,
        // roll the shortfall forward to the next unpaid installment
        const shortfall = baseAmount - newPaid;

        scheduleUpdates.push({
          id: targetInstallment.id,
          paid_amount: newPaid,
          status: "paid",
          base_installment_amount: newPaid,
          total_due_amount: newPaid + Number(targetInstallment.penalty_amount || 0),
        });

        // Add shortfall to the next unpaid installment
        if (laterUnpaidItems.length > 0) {
          const nextItem = laterUnpaidItems[0];
          const nextBase = Number(nextItem.base_installment_amount) + shortfall;
          scheduleUpdates.push({
            id: nextItem.id,
            base_installment_amount: nextBase,
            total_due_amount: nextBase + Number(nextItem.penalty_amount || 0),
          });
        }
      }

      remaining = 0;
    }

    const newTotalPaid = Number(account.total_paid) + Number(amount_paid);

    // Calculate remaining balance from actual schedule amounts (accounts for overpayment reductions)
    let newRemainingBalance = 0;
    if (schedule) {
      for (const item of schedule) {
        // Check if this item has a schedule update pending
        const update = scheduleUpdates.find(u => u.id === item.id);
        const base = update?.base_installment_amount !== undefined ? update.base_installment_amount : Number(item.base_installment_amount);
        const penAmt = Number(item.penalty_amount || 0);
        const paid = update?.paid_amount !== undefined ? update.paid_amount : Number(item.paid_amount);
        const itemStatus = update?.status !== undefined ? update.status : item.status;
        if (itemStatus !== 'paid' && itemStatus !== 'cancelled') {
          newRemainingBalance += Math.max(0, base + penAmt - paid);
        }
      }
    }
    const newStatus = newRemainingBalance <= 0 ? "completed" : account.status;

    // Preview mode - return allocation plan without saving
    if (preview_only) {
      return new Response(JSON.stringify({
        preview: true,
        allocations,
        new_total_paid: newTotalPaid,
        new_remaining_balance: Math.max(0, newRemainingBalance),
        new_status: newStatus,
        schedule_updates: scheduleUpdates,
        penalty_updates: penaltyUpdates,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create payment record
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .insert({
        account_id,
        amount_paid,
        currency: account.currency,
        date_paid: date_paid || new Date().toISOString().split("T")[0],
        payment_method: payment_method || "cash",
        reference_number,
        remarks,
        entered_by_user_id: user.id,
      })
      .select()
      .single();

    if (payErr) {
      return new Response(JSON.stringify({ error: payErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create allocations
    for (const alloc of allocations) {
      await supabase.from("payment_allocations").insert({
        payment_id: payment.id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });
    }

    // Update penalty statuses
    for (const pen of penaltyUpdates) {
      await supabase.from("penalty_fees").update({ status: pen.status }).eq("id", pen.id);
    }

    // Update schedule items
    for (const item of scheduleUpdates) {
      const updateData: Record<string, unknown> = {};
      if (item.paid_amount !== undefined) updateData.paid_amount = item.paid_amount;
      if (item.status !== undefined) updateData.status = item.status;
      if (item.base_installment_amount !== undefined) updateData.base_installment_amount = item.base_installment_amount;
      if (item.total_due_amount !== undefined) updateData.total_due_amount = item.total_due_amount;
      await supabase.from("layaway_schedule").update(updateData).eq("id", item.id);
    }

    // Update account
    await supabase.from("layaway_accounts").update({
      total_paid: newTotalPaid,
      remaining_balance: Math.max(0, newRemainingBalance),
      status: newStatus,
    }).eq("id", account_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment.id,
      action: "create",
      new_value_json: { amount_paid, account_id, allocations },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({
      payment,
      allocations,
      new_total_paid: newTotalPaid,
      new_remaining_balance: Math.max(0, newRemainingBalance),
      new_status: newStatus,
    }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
