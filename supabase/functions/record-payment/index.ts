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

    // 2. Pay due/overdue installments in ascending order
    const effectiveDate = date_paid || new Date().toISOString().split("T")[0];
    const unpaidItems = schedule.filter(item => item.status !== "paid" && Number(item.base_installment_amount) - Number(item.paid_amount) > 0);
    const dueItems = unpaidItems.filter(item => item.due_date <= effectiveDate);
    const futureItems = unpaidItems.filter(item => item.due_date > effectiveDate);

    for (const item of dueItems) {
      if (remaining <= 0) break;
      const owed = Number(item.base_installment_amount) - Number(item.paid_amount);
      const toPay = Math.min(remaining, owed);
      remaining -= toPay;
      const newPaid = Number(item.paid_amount) + toPay;
      const newStatus = newPaid >= Number(item.base_installment_amount) ? "paid" : "partially_paid";
      allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toPay });
      scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: newStatus });
    }

    // 3. Excess reduces the LAST future installment's due amount (no partial payments on future months)
    if (remaining > 0 && futureItems.length > 0) {
      for (const item of [...futureItems].reverse()) {
        if (remaining <= 0) break;
        const baseAmount = Number(item.base_installment_amount);
        const reduction = Math.min(remaining, baseAmount);
        remaining -= reduction;

        allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: reduction });

        if (reduction >= baseAmount) {
          // Fully covers this installment — mark as paid
          scheduleUpdates.push({ id: item.id, paid_amount: baseAmount, status: "paid" });
        } else {
          // Reduce the due amount, keep status pending
          const newBase = baseAmount - reduction;
          scheduleUpdates.push({
            id: item.id,
            base_installment_amount: newBase,
            total_due_amount: newBase + Number(item.penalty_amount || 0),
          });
        }
      }
    }

    const newTotalPaid = Number(account.total_paid) + Number(amount_paid);
    const newRemainingBalance = Number(account.total_amount) - newTotalPaid;
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
      await supabase.from("layaway_schedule").update({
        paid_amount: item.paid_amount,
        status: item.status,
      }).eq("id", item.id);
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
