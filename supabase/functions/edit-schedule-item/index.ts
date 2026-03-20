import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/**
 * Edit Schedule Item Edge Function
 * Updates base_installment_amount on a schedule item, recalculates total_due and account balance.
 * Payload: { schedule_id, new_base_amount }
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

    const { schedule_id, new_base_amount } = await req.json();

    if (!schedule_id || new_base_amount === undefined || new_base_amount === null) {
      return new Response(JSON.stringify({ error: "Missing required fields: schedule_id, new_base_amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (typeof new_base_amount !== "number" || new_base_amount < 0) {
      return new Response(JSON.stringify({ error: "new_base_amount must be a non-negative number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the schedule item
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

    const oldBase = Number(schedItem.base_installment_amount);
    const penaltyAmount = Number(schedItem.penalty_amount);
    const newTotalDue = new_base_amount + penaltyAmount;
    const isPaid = schedItem.status === "paid";

    // Update the schedule item — also sync paid_amount if already paid
    const updatePayload: Record<string, unknown> = {
      base_installment_amount: new_base_amount,
      total_due_amount: newTotalDue,
    };
    if (isPaid) {
      updatePayload.paid_amount = newTotalDue;
    }

    const { error: updateErr } = await supabase
      .from("layaway_schedule")
      .update(updatePayload)
      .eq("id", schedule_id);

    if (updateErr) {
      return new Response(JSON.stringify({ error: "Failed to update schedule item", details: updateErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If item is paid, also update account total_paid to reflect the change
    if (isPaid) {
      const { data: allSchedule2 } = await supabase
        .from("layaway_schedule")
        .select("paid_amount, status")
        .eq("account_id", schedItem.account_id);
      if (allSchedule2) {
        const newTotalPaid = allSchedule2.reduce((sum, s) => sum + Number(s.paid_amount), 0);
        await supabase
          .from("layaway_accounts")
          .update({ total_paid: newTotalPaid })
          .eq("id", schedItem.account_id);
      }
    }

    // Recalculate account remaining_balance
    const accountId = schedItem.account_id;
    const { data: allSchedule } = await supabase
      .from("layaway_schedule")
      .select("total_due_amount, paid_amount, status")
      .eq("account_id", accountId);

    if (allSchedule) {
      const newRemaining = allSchedule.reduce((sum, s) => {
        if (s.status === "paid" || s.status === "cancelled") return sum;
        return sum + Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount));
      }, 0);

      await supabase
        .from("layaway_accounts")
        .update({ remaining_balance: newRemaining })
        .eq("id", accountId);
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "schedule",
      entity_id: schedule_id,
      action: "edit_installment_amount",
      performed_by_user_id: user.id,
      old_value_json: { base_installment_amount: oldBase },
      new_value_json: { base_installment_amount: new_base_amount, account_id: accountId },
    });

    return new Response(JSON.stringify({
      success: true,
      old_base: oldBase,
      new_base: new_base_amount,
      new_total_due: newTotalDue,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("edit-schedule-item error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});