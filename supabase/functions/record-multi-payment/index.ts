import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user via anon client
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await anonClient.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;

    // Service role client for data ops
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const {
      customer_id,
      total_amount_paid,
      date_paid,
      payment_method,
      remarks,
      preview_only,
      allocations: inputAllocations,
    } = body as {
      customer_id: string;
      total_amount_paid: number;
      date_paid?: string;
      payment_method?: string;
      remarks?: string;
      preview_only?: boolean;
      allocations: Array<{ account_id: string; amount: number }>;
    };

    // Validate input
    if (!customer_id || !inputAllocations || !Array.isArray(inputAllocations) || inputAllocations.length === 0) {
      return new Response(JSON.stringify({ error: "Missing customer_id or allocations" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalAllocated = inputAllocations.reduce((s, a) => s + Number(a.amount), 0);
    if (totalAllocated <= 0) {
      return new Response(JSON.stringify({ error: "Total allocated must be > 0" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check total matches
    if (total_amount_paid && Math.abs(totalAllocated - Number(total_amount_paid)) > 1) {
      return new Response(
        JSON.stringify({ error: "Allocation total does not match total_amount_paid" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch all target accounts
    const accountIds = inputAllocations.map((a) => a.account_id);
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .in("id", accountIds)
      .eq("customer_id", customer_id);

    if (accErr || !accounts || accounts.length !== accountIds.length) {
      return new Response(
        JSON.stringify({ error: "One or more accounts not found or don't belong to this customer" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate each account is active/overdue and amount <= remaining_balance
    for (const alloc of inputAllocations) {
      const acct = accounts.find((a) => a.id === alloc.account_id);
      if (!acct) continue;
      if (acct.status !== "active" && acct.status !== "overdue") {
        return new Response(
          JSON.stringify({ error: `Account ${acct.invoice_number} is not active` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (Number(alloc.amount) > Number(acct.remaining_balance) + 1) {
        return new Response(
          JSON.stringify({
            error: `Amount for ${acct.invoice_number} exceeds remaining balance`,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Process each account's allocation using the same logic as record-payment
    const results: Array<{
      account_id: string;
      invoice_number: string;
      amount_allocated: number;
      payment_allocations: any[];
      new_total_paid: number;
      new_remaining_balance: number;
      new_status: string;
    }> = [];

    const effectiveDate = date_paid || new Date().toISOString().split("T")[0];
    const effectiveMethod = payment_method || "cash";
    const batchId = crypto.randomUUID();

    for (const inputAlloc of inputAllocations) {
      if (Number(inputAlloc.amount) <= 0) continue;

      const acct = accounts.find((a) => a.id === inputAlloc.account_id)!;
      const amountForAccount = Number(inputAlloc.amount);

      // Fetch schedule
      const { data: schedule } = await supabase
        .from("layaway_schedule")
        .select("*")
        .eq("account_id", inputAlloc.account_id)
        .order("installment_number", { ascending: true });

      // Fetch unpaid penalties
      const { data: unpaidPenalties } = await supabase
        .from("penalty_fees")
        .select("*")
        .eq("account_id", inputAlloc.account_id)
        .eq("status", "unpaid")
        .order("penalty_date", { ascending: true });

      // Allocate: penalties first, then installments
      let remaining = amountForAccount;
      const paymentAllocations: Array<{
        schedule_id: string;
        allocation_type: "penalty" | "installment";
        allocated_amount: number;
        penalty_fee_id?: string;
      }> = [];
      const penaltyUpdates: Array<{ id: string; status: string }> = [];
      const scheduleUpdates: Array<{
        id: string;
        paid_amount?: number;
        status?: string;
        base_installment_amount?: number;
        total_due_amount?: number;
      }> = [];

      if (unpaidPenalties) {
        for (const pen of unpaidPenalties) {
          if (remaining <= 0) break;
          const penAmount = Number(pen.penalty_amount);
          const toPay = Math.min(remaining, penAmount);
          remaining -= toPay;
          paymentAllocations.push({
            schedule_id: pen.schedule_id,
            allocation_type: "penalty",
            allocated_amount: toPay,
            penalty_fee_id: pen.id,
          });
          penaltyUpdates.push({
            id: pen.id,
            status: toPay >= penAmount ? "paid" : "unpaid",
          });
        }
      }

      if (schedule) {
        const unpaidItems = schedule.filter(item => item.status !== "paid" && Number(item.base_installment_amount) - Number(item.paid_amount) > 0);
        const dueItems = unpaidItems.filter(item => item.due_date <= effectiveDate);
        const futureItems = unpaidItems.filter(item => item.due_date > effectiveDate);

        // Pay due/overdue in ascending order
        for (const item of dueItems) {
          if (remaining <= 0) break;
          const owed = Number(item.base_installment_amount) - Number(item.paid_amount);
          const toPay = Math.min(remaining, owed);
          remaining -= toPay;
          const newPaid = Number(item.paid_amount) + toPay;
          const newStatus = newPaid >= Number(item.base_installment_amount) ? "paid" : "partially_paid";
          paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toPay });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: newStatus });
        }

        // Excess reduces LAST future installment's due amount
        if (remaining > 0 && futureItems.length > 0) {
          for (const item of [...futureItems].reverse()) {
            if (remaining <= 0) break;
            const baseAmount = Number(item.base_installment_amount);
            const reduction = Math.min(remaining, baseAmount);
            remaining -= reduction;

            paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: reduction });

            if (reduction >= baseAmount) {
              scheduleUpdates.push({ id: item.id, paid_amount: baseAmount, status: "paid" });
            } else {
              const newBase = baseAmount - reduction;
              scheduleUpdates.push({
                id: item.id,
                base_installment_amount: newBase,
                total_due_amount: newBase + Number(item.penalty_amount || 0),
              });
            }
          }
        }
      }

      const newTotalPaid = Number(acct.total_paid) + amountForAccount;
      const newRemainingBalance = Number(acct.total_amount) - newTotalPaid;
      const newStatus = newRemainingBalance <= 0 ? "completed" : acct.status;

      results.push({
        account_id: inputAlloc.account_id,
        invoice_number: acct.invoice_number,
        amount_allocated: amountForAccount,
        payment_allocations: paymentAllocations,
        new_total_paid: newTotalPaid,
        new_remaining_balance: Math.max(0, newRemainingBalance),
        new_status: newStatus,
      });

      // If not preview, persist changes
      if (!preview_only) {
        // Create payment record
        const { data: payment, error: payErr } = await supabase
          .from("payments")
          .insert({
            account_id: inputAlloc.account_id,
            amount_paid: amountForAccount,
            currency: acct.currency,
            date_paid: effectiveDate,
            payment_method: effectiveMethod,
            reference_number: batchId,
            remarks: remarks ? `[Multi-invoice] ${remarks}` : `[Multi-invoice batch: ${batchId}]`,
            entered_by_user_id: userId,
          })
          .select()
          .single();

        if (payErr) throw payErr;

        // Create allocations
        for (const alloc of paymentAllocations) {
          await supabase.from("payment_allocations").insert({
            payment_id: payment.id,
            schedule_id: alloc.schedule_id,
            allocation_type: alloc.allocation_type,
            allocated_amount: alloc.allocated_amount,
          });
        }

        // Update penalties
        for (const pen of penaltyUpdates) {
          await supabase.from("penalty_fees").update({ status: pen.status }).eq("id", pen.id);
        }

        // Update schedule
        for (const item of scheduleUpdates) {
          await supabase
            .from("layaway_schedule")
            .update({ paid_amount: item.paid_amount, status: item.status })
            .eq("id", item.id);
        }

        // Update account
        await supabase
          .from("layaway_accounts")
          .update({
            total_paid: newTotalPaid,
            remaining_balance: Math.max(0, newRemainingBalance),
            status: newStatus,
          })
          .eq("id", inputAlloc.account_id);

        // Audit log
        await supabase.from("audit_logs").insert({
          entity_type: "payment",
          entity_id: payment.id,
          action: "create_multi",
          new_value_json: {
            batch_id: batchId,
            amount_paid: amountForAccount,
            account_id: inputAlloc.account_id,
            total_batch_amount: totalAllocated,
            allocations: paymentAllocations,
          },
          performed_by_user_id: userId,
        });
      }
    }

    return new Response(
      JSON.stringify({
        preview: !!preview_only,
        batch_id: batchId,
        total_amount: totalAllocated,
        account_results: results,
      }),
      {
        status: preview_only ? 200 : 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
