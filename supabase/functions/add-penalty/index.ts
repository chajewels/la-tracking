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
      .select("id, invoice_number, status, payment_plan_months")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const planMonths = account.payment_plan_months || 6;

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
    let cap = installmentNumber >= planMonths ? Infinity : (currency === "PHP" ? 1000 : 2000);

    const { data: overrideRow } = await supabase
      .from("penalty_cap_overrides")
      .select("penalty_cap_amount")
      .eq("account_id", account_id)
      .eq("is_active", true)
      .maybeSingle();
    if (overrideRow && installmentNumber < planMonths) {
      cap = Number(overrideRow.penalty_cap_amount);
    }

    // Enforce penalty cap for months 1-5
    const currentPenalty = Number(schedItem.penalty_amount);
    if (currentPenalty + penalty_amount > cap) {
      const allowed = Math.max(0, cap - currentPenalty);
      if (allowed <= 0) {
        return new Response(JSON.stringify({ 
          error: `Penalty cap reached for month ${installmentNumber}. Max ${currency === "PHP" ? "\u20b11,000" : "\u00a52,000"} for months 1-5.` 
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

    // Freeze guard: block if account has a pending payment submission
    const { count: pendingCount } = await supabase
      .from("payment_submissions")
      .select("*", { count: "exact", head: true })
      .eq("account_id", account_id)
      .in("status", ["submitted", "under_review"]);
    if (pendingCount !== null && pendingCount > 0) {
      console.log(`[penalty-skip] ${account.invoice_number} — pending submission (${pendingCount}), skipping`);
      return new Response(JSON.stringify({
        skipped: true,
        reason: "Account has a pending payment submission. Penalty not added until submission is resolved.",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

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

    // Recalculate account totals using canonical formula:
    // remaining_balance = total_amount + \u03a3(non-waived penalty_fees) + \u03a3(services) \u2212 \u03a3(non-voided payments)
    // total_paid        = \u03a3(non-voided payments)  \u2190 payments table is SINGLE source of truth
    // total_amount is NEVER touched \u2014 it is base principal only and never changes.
    const [{ data: accTotals }, { data: allActivePens }, { data: allSvcs }, { data: allPays }] = await Promise.all([
      supabase.from("layaway_accounts").select("total_amount").eq("id", account_id).single(),
      supabase.from("penalty_fees").select("penalty_amount").eq("account_id", account_id).not("status", "eq", "waived"),
      supabase.from("account_services").select("amount").eq("account_id", account_id),
      supabase.from("payments").select("amount_paid").eq("account_id", account_id).is("voided_at", null),
    ]);

    if (accTotals) {
      const penSum  = (allActivePens || []).reduce((s: number, p: any)  => s + Number(p.penalty_amount), 0);
      const svcSum  = (allSvcs       || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);
      const paidSum = (allPays       || []).reduce((s: number, p: any)  => s + Number(p.amount_paid), 0);
      const newRemaining = Math.max(0, Number(accTotals.total_amount) + penSum + svcSum - paidSum);
      await supabase
        .from("layaway_accounts")
        .update({ remaining_balance: newRemaining, total_paid: paidSum })
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
      penalty_id: penaltyFee.id,
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
