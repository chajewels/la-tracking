import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Add Penalty Edge Function
 * Manually adds a penalty to a specific schedule item.
 * Payload: { account_id, schedule_id, currency, penalty_amount, penalty_stage? }
 */
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

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { account_id, schedule_id, currency, penalty_amount, penalty_stage = "week1" } = await req.json();

    if (!account_id || !schedule_id || !currency || !penalty_amount) {
      return new Response(JSON.stringify({ error: "Missing required fields: account_id, schedule_id, currency, penalty_amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate account exists
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate schedule item exists
    const { data: schedItem, error: schedErr } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("id", schedule_id)
      .single();

    if (schedErr || !schedItem) {
      return new Response(JSON.stringify({ error: "Schedule item not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check for per-invoice penalty cap override
    const installmentNumber = schedItem.installment_number;
    let cap = installmentNumber >= 6 ? Infinity : (currency === "PHP" ? 1000 : 2000);

    const { data: overrideRow } = await supabase
      .from("penalty_cap_overrides")
      .select("penalty_cap_amount")
      .eq("account_id", account_id)
      .eq("is_active", true)
      .maybeSingle();
    if (overrideRow && installmentNumber < 6) {
      cap = Number(overrideRow.penalty_cap_amount);
    }

    // Enforce penalty cap for months 1-5
    const currentPenalty = Number(schedItem.penalty_amount);
    if (currentPenalty + penalty_amount > cap) {
      const allowed = Math.max(0, cap - currentPenalty);
      if (allowed <= 0) {
        return new Response(JSON.stringify({ 
          error: `Penalty cap reached for month ${installmentNumber}. Max ${currency === "PHP" ? "₱1,000" : "¥2,000"} for months 1-5.` 
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // If the schedule item is already paid, the penalty is a correction — mark it paid immediately
    const isPaidItem = schedItem.status === "paid";

    // Find the next available penalty_cycle for this schedule+stage combo
    const { data: existingPenalties } = await supabase
      .from("penalty_fees")
      .select("penalty_cycle")
      .eq("schedule_id", schedule_id)
      .eq("penalty_stage", penalty_stage)
      .order("penalty_cycle", { ascending: false })
      .limit(1);

    const nextCycle = existingPenalties && existingPenalties.length > 0
      ? existingPenalties[0].penalty_cycle + 1
      : 1;

    // Insert penalty_fees record
    const { data: penaltyFee, error: penErr } = await supabase
      .from("penalty_fees")
      .insert({
        account_id,
        schedule_id,
        currency,
        penalty_amount,
        penalty_stage,
        penalty_cycle: nextCycle,
        status: isPaidItem ? "paid" : "unpaid",
      })
      .select()
      .single();

    if (penErr) {
      console.error("Failed to insert penalty:", penErr);
      return new Response(JSON.stringify({ error: "Failed to add penalty", details: penErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update schedule item: add penalty to penalty_amount and total_due_amount
    const newPenaltyAmount = Number(schedItem.penalty_amount) + penalty_amount;
    const newTotalDue = Number(schedItem.base_installment_amount) + newPenaltyAmount;
    const isPaid = schedItem.status === "paid";

    // If adding penalty to a paid installment (correction), also update paid_amount
    const schedUpdatePayload: Record<string, unknown> = {
      penalty_amount: newPenaltyAmount,
      total_due_amount: newTotalDue,
    };
    if (isPaid) {
      schedUpdatePayload.paid_amount = newTotalDue;
    }

    const { error: schedUpdateErr } = await supabase
      .from("layaway_schedule")
      .update(schedUpdatePayload)
      .eq("id", schedule_id);

    if (schedUpdateErr) {
      console.error("Failed to update schedule:", schedUpdateErr);
    }

    // If item was paid, also update account total_paid to reflect the correction
    if (isPaid) {
      const { data: allSchedulePaid } = await supabase
        .from("layaway_schedule")
        .select("paid_amount, status")
        .eq("account_id", account_id);
      if (allSchedulePaid) {
        const newTotalPaid = allSchedulePaid.reduce((sum, s) => sum + Number(s.paid_amount), 0);
        await supabase
          .from("layaway_accounts")
          .update({ total_paid: newTotalPaid })
          .eq("id", account_id);
      }
    }

    // Update account remaining_balance
    const { data: allSchedule } = await supabase
      .from("layaway_schedule")
      .select("total_due_amount, paid_amount, status")
      .eq("account_id", account_id);

    if (allSchedule) {
      const newRemaining = allSchedule.reduce((sum, s) => {
        if (s.status === 'paid' || s.status === 'cancelled') return sum;
        return sum + Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount));
      }, 0);

      await supabase
        .from("layaway_accounts")
        .update({ remaining_balance: newRemaining })
        .eq("id", account_id);
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "penalty",
      entity_id: penaltyFee.id,
      action: "manual_penalty_added",
      performed_by_user_id: user.id,
      new_value_json: {
        account_id,
        schedule_id,
        currency,
        penalty_amount,
        penalty_stage,
        invoice_number: account.invoice_number,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      penalty: penaltyFee,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("add-penalty error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
