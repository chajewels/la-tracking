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

    // Verify auth
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
    const {
      customer_id,
      invoice_number,
      currency,
      total_amount,
      payment_plan_months,
      order_date,
      notes,
      downpayment_amount: dpAmountInput,
      split_allocations, // Array<{ account_id: string; amount: number }> — optional
      lump_sum_total, // number — optional, total lump sum from customer
      custom_installments, // number[] — optional, exact amounts per month
    } = body;

    // Validation
    if (!customer_id || !invoice_number || !currency || !total_amount || !payment_plan_months || !order_date) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (![3, 6].includes(payment_plan_months)) {
      return new Response(JSON.stringify({ error: "Payment plan must be 3 or 6 months" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!["PHP", "JPY"].includes(currency)) {
      return new Response(JSON.stringify({ error: "Currency must be PHP or JPY" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (total_amount <= 0) {
      return new Response(JSON.stringify({ error: "Total amount must be positive" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalAmountNum = Number(total_amount);
    const downpaymentTarget = dpAmountInput ? Math.round(Number(dpAmountInput)) : 0;
    // DP is NEVER paid at creation — must go through portal → staff validation flow
    const downpaymentPaid = 0;

    // Base amount for installments (total minus full DP target)
    const baseForInstallments = totalAmountNum - downpaymentTarget;

    // Calculate end date
    const startDate = new Date(order_date);
    // End date = last installment due date (order month + plan months)
    const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + payment_plan_months, startDate.getDate());

    // Create account — confirmed DP is treated as real paid principal, without changing fixed schedule rows
    const { data: account, error: accountError } = await supabase
      .from("layaway_accounts")
      .insert({
        customer_id,
        invoice_number,
        currency,
        total_amount: totalAmountNum,
        downpayment_amount: downpaymentTarget,
        payment_plan_months,
        order_date,
        end_date: endDate.toISOString().split("T")[0],
        total_paid: 0,
        remaining_balance: totalAmountNum,
        notes,
        created_by_user_id: user.id,
      })
      .select()
      .single();

    if (accountError) {
      return new Response(JSON.stringify({ error: accountError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Generate schedule
    const dayOfMonth = startDate.getDate();
    const scheduleRows = [];
    const useCustom = Array.isArray(custom_installments) && custom_installments.length === payment_plan_months;

    // Validate custom installments sum to baseForInstallments
    if (useCustom) {
      const customSum = custom_installments.reduce((s: number, v: number) => s + Math.round(Number(v)), 0);
      if (customSum !== baseForInstallments) {
        // Rollback: delete the account row to prevent orphaned accounts
        await supabase.from("layaway_accounts").delete().eq("id", account.id);
        return new Response(JSON.stringify({
          error: `Custom installments total (${customSum}) does not match remaining balance (${baseForInstallments})`
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Calculate equal-distribution amounts (used when not custom)
    const baseInstallment = Math.floor(baseForInstallments / payment_plan_months);
    const baseRemainder = baseForInstallments - baseInstallment * payment_plan_months;

    for (let i = 0; i < payment_plan_months; i++) {
      const dueDate = new Date(startDate.getFullYear(), startDate.getMonth() + i + 1, dayOfMonth);
      if (dueDate.getDate() !== dayOfMonth) {
        dueDate.setDate(0);
      }

      let amount: number;

      if (useCustom) {
        // Use exact custom amount — no redistribution
        amount = Math.round(Number(custom_installments[i]));
      } else {
        const isLast = i === payment_plan_months - 1;
        amount = isLast ? baseInstallment + baseRemainder : baseInstallment;
      }

      scheduleRows.push({
        account_id: account.id,
        installment_number: i + 1,
        due_date: dueDate.toISOString().split("T")[0],
        base_installment_amount: amount,
        penalty_amount: 0,
        total_due_amount: amount,
        currency,
      });
    }

    const { error: scheduleError } = await supabase
      .from("layaway_schedule")
      .insert(scheduleRows);

    if (scheduleError) {
      // Rollback: delete the account row to prevent orphaned accounts
      await supabase.from("layaway_accounts").delete().eq("id", account.id);
      return new Response(JSON.stringify({ error: "Failed to create schedule: " + scheduleError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create audit log
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_account",
      entity_id: account.id,
      action: "create",
      new_value_json: {
        ...account,
        split_allocations: split_allocations || null,
        lump_sum_total: lump_sum_total || null,
      },
      performed_by_user_id: user.id,
    });

    // ── Process split allocations to existing accounts ──
    const splitResults: Array<{ account_id: string; invoice_number: string; amount: number; payment_id: string; completed?: boolean }> = [];

    if (Array.isArray(split_allocations) && split_allocations.length > 0) {
      for (const alloc of split_allocations) {
        const allocAmount = Math.round(Number(alloc.amount));
        if (allocAmount <= 0) continue;

        // Fetch the target account
        const { data: targetAcct, error: targetErr } = await supabase
          .from("layaway_accounts")
          .select("*")
          .eq("id", alloc.account_id)
          .single();

        if (targetErr || !targetAcct) continue;
        if (targetAcct.status !== "active" && targetAcct.status !== "overdue") continue;

        // Fetch schedule for this account
        const { data: targetSchedule } = await supabase
          .from("layaway_schedule")
          .select("*")
          .eq("account_id", alloc.account_id)
          .order("installment_number", { ascending: true });

        if (!targetSchedule) continue;

        // Fetch unpaid penalties
        const { data: targetPenalties } = await supabase
          .from("penalty_fees")
          .select("*")
          .eq("account_id", alloc.account_id)
          .eq("status", "unpaid")
          .order("penalty_date", { ascending: true });

        // Allocate: penalties first, then installments (same logic as record-payment)
        let rem = allocAmount;
        const payAllocations: Array<{ schedule_id: string; allocation_type: "penalty" | "installment"; allocated_amount: number }> = [];
        const penUpdates: Array<{ id: string; status: string }> = [];
        const schUpdates: Array<{ id: string; paid_amount?: number; status?: string }> = [];

        // Pay penalties first
        if (targetPenalties) {
          for (const pen of targetPenalties) {
            if (rem <= 0) break;
            const penAmt = Number(pen.penalty_amount);
            const toPay = Math.min(rem, penAmt);
            rem -= toPay;
            payAllocations.push({ schedule_id: pen.schedule_id, allocation_type: "penalty", allocated_amount: toPay });
            penUpdates.push({ id: pen.id, status: toPay >= penAmt ? "paid" : "unpaid" });
          }
        }

        // Pay installments sequentially (FIXED SCHEDULE — never modify base_installment_amount)
        if (rem > 0) {
          const unpaidItems = targetSchedule.filter(
            item => item.status !== "paid" && item.status !== "cancelled"
          ).sort((a, b) => a.installment_number - b.installment_number);

          for (const item of unpaidItems) {
            if (rem <= 0) break;
            const currentPaid = Number(item.paid_amount);
            const baseAmt = Number(item.base_installment_amount);
            const due = Math.max(0, baseAmt - currentPaid);
            if (due <= 0) continue;

            const toApply = Math.min(rem, due);
            rem -= toApply;
            const newPaid = currentPaid + toApply;
            const newStatus = newPaid >= baseAmt ? "paid" : "partially_paid";

            payAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
            schUpdates.push({ id: item.id, paid_amount: newPaid, status: newStatus });
          }
        }

        // Create payment record for existing account
        const { data: splitPayment, error: splitPayErr } = await supabase
          .from("payments")
          .insert({
            account_id: alloc.account_id,
            amount_paid: allocAmount,
            currency: targetAcct.currency,
            date_paid: order_date || new Date().toISOString().split("T")[0],
            payment_method: "cash",
            remarks: `Split payment from new layaway INV #${invoice_number} (lump sum)`,
            reference_number: `SPLIT-${invoice_number}`,
            entered_by_user_id: user.id,
          })
          .select()
          .single();

        if (splitPayErr || !splitPayment) continue;

        // Create allocations
        for (const pa of payAllocations) {
          await supabase.from("payment_allocations").insert({
            payment_id: splitPayment.id,
            schedule_id: pa.schedule_id,
            allocation_type: pa.allocation_type,
            allocated_amount: pa.allocated_amount,
          });
        }

        // Update penalties
        for (const pu of penUpdates) {
          await supabase.from("penalty_fees").update({ status: pu.status }).eq("id", pu.id);
        }

        // Update schedule items (only paid_amount and status — base_installment_amount is IMMUTABLE)
        for (const su of schUpdates) {
          const updateData: Record<string, unknown> = {};
          if (su.paid_amount !== undefined) updateData.paid_amount = su.paid_amount;
          if (su.status !== undefined) updateData.status = su.status;
          await supabase.from("layaway_schedule").update(updateData).eq("id", su.id);
        }

        // SINGLE SOURCE OF TRUTH: remaining = total_amount - SUM(actual payments)
        const newTotalPaid = Number(targetAcct.total_paid) + allocAmount;
        const newRemBal = Math.max(0, Number(targetAcct.total_amount) - newTotalPaid);
        const newAcctStatus = newRemBal <= 0 ? "completed" : targetAcct.status;

        await supabase.from("layaway_accounts").update({
          total_paid: newTotalPaid,
          remaining_balance: newRemBal,
          status: newAcctStatus,
        }).eq("id", alloc.account_id);

        // Audit log for split payment
        await supabase.from("audit_logs").insert({
          entity_type: "payment",
          entity_id: splitPayment.id,
          action: "create_split",
          new_value_json: {
            amount_paid: allocAmount,
            source_invoice: invoice_number,
            target_account_id: alloc.account_id,
            target_invoice: targetAcct.invoice_number,
            lump_sum_total: lump_sum_total,
          },
          performed_by_user_id: user.id,
        });

        splitResults.push({
          account_id: alloc.account_id,
          invoice_number: targetAcct.invoice_number,
          amount: allocAmount,
          payment_id: splitPayment.id,
          completed: newAcctStatus === "completed",
        });
      }
    }

    return new Response(
      JSON.stringify({ account, schedule: scheduleRows, split_payments: splitResults }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error('create-layaway-account error:', error);
    return new Response(JSON.stringify({ error: (error as Error).message || 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
