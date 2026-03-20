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
      downpayment_paid: dpPaidInput,
      remaining_dp_option, // 'split' | 'add_to_installments'
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
    const downpaymentTarget = dpAmountInput ? Math.round(Number(dpAmountInput)) : Math.round(totalAmountNum * 0.3);
    const downpaymentPaid = dpPaidInput ? Math.round(Number(dpPaidInput)) : downpaymentTarget;
    const remainingDp = Math.max(0, downpaymentTarget - downpaymentPaid);
    const hasShortDp = remainingDp > 0;

    // Base amount for installments (total minus full DP target)
    const baseForInstallments = totalAmountNum - downpaymentTarget;

    // Calculate end date
    const startDate = new Date(order_date);
    const endDate = new Date(startDate.getFullYear(), startDate.getMonth() + payment_plan_months, startDate.getDate());

    // Create account — remaining_balance = total minus what was actually paid as DP
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
        total_paid: downpaymentPaid,
        remaining_balance: totalAmountNum - downpaymentPaid,
        notes: hasShortDp
          ? `${notes || ''}${notes ? ' | ' : ''}Short DP: paid ${downpaymentPaid}, target ${downpaymentTarget}, remaining ${remainingDp} (${remaining_dp_option || 'split'})`.trim()
          : notes,
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

    // Generate schedule with remaining DP distributed per option
    const dayOfMonth = startDate.getDate();
    const scheduleRows = [];

    // Calculate base installment from the portion after full DP target
    const baseInstallment = Math.floor(baseForInstallments / payment_plan_months);
    const baseRemainder = baseForInstallments - baseInstallment * payment_plan_months;

    // Calculate remaining DP distribution
    let dpPerMonth = 0;
    let dpDistRemainder = 0;
    const option = remaining_dp_option || 'split';

    if (hasShortDp && option === 'split') {
      dpPerMonth = Math.floor(remainingDp / payment_plan_months);
      dpDistRemainder = remainingDp - dpPerMonth * payment_plan_months;
    }

    for (let i = 0; i < payment_plan_months; i++) {
      const dueDate = new Date(startDate.getFullYear(), startDate.getMonth() + i, dayOfMonth);
      if (dueDate.getDate() !== dayOfMonth) {
        dueDate.setDate(0);
      }

      const isLast = i === payment_plan_months - 1;
      let amount = isLast ? baseInstallment + baseRemainder : baseInstallment;

      // Add remaining DP based on option
      if (hasShortDp) {
        if (option === 'split') {
          amount += dpPerMonth;
          if (isLast) amount += dpDistRemainder;
        } else if (option === 'add_to_installments' && i === 0) {
          amount += remainingDp;
        }
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
      return new Response(JSON.stringify({ error: scheduleError.message }), {
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
        downpayment_paid: downpaymentPaid,
        remaining_dp: remainingDp,
        remaining_dp_option: option,
      },
      performed_by_user_id: user.id,
    });

    return new Response(
      JSON.stringify({ account, schedule: scheduleRows }),
      { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
