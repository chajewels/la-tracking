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

    // Use SECURITY DEFINER RPC to bypass enforce_immutable_base trigger.
    // The function runs as the postgres owner and updates base_installment_amount,
    // total_due_amount, and paid_amount (when paid) atomically.
    const { error: updateErr } = await supabase.rpc(
      'admin_update_schedule_base',
      {
        p_schedule_id: schedule_id,
        p_new_base: new_base_amount,
        p_new_total_due: newTotalDue,
        p_is_paid: isPaid,
      }
    );

    if (updateErr) {
      return new Response(JSON.stringify({ error: "Failed to update schedule item", details: updateErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If item is paid, also update account total_paid to reflect the change
    if (isPaid) {
      const { data: paymentsData } = await supabase
        .from("payments")
        .select("amount_paid")
        .eq("account_id", schedItem.account_id)
        .is("voided_at", null);
      const newTotalPaid = (paymentsData || [])
        .reduce((sum, p) => sum + Number(p.amount_paid), 0);
      await supabase
        .from("layaway_accounts")
        .update({ total_paid: newTotalPaid })
        .eq("id", schedItem.account_id);
    }

    // Recalculate account remaining_balance using canonical formula:
    // total_amount + activePenalties + services - totalPaid
    const accountId = schedItem.account_id;

    const { data: penaltiesData } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", accountId)
      .neq("status", "waived");

    const { data: servicesData } = await supabase
      .from("account_services")
      .select("amount")
      .eq("account_id", accountId);

    const { data: paymentsData2 } = await supabase
      .from("payments")
      .select("amount_paid")
      .eq("account_id", accountId)
      .is("voided_at", null);

    const { data: accountData } = await supabase
      .from("layaway_accounts")
      .select("total_amount")
      .eq("id", accountId)
      .single();

    const activePenalties = (penaltiesData || [])
      .reduce((sum, p) => sum + Number(p.penalty_amount), 0);
    const services = (servicesData || [])
      .reduce((sum, s) => sum + Number(s.amount), 0);
    const totalPaidFromPayments = (paymentsData2 || [])
      .reduce((sum, p) => sum + Number(p.amount_paid), 0);
    const totalAmount = Number(accountData?.total_amount || 0);

    const newRemaining = totalAmount + activePenalties + services
      - totalPaidFromPayments;

    await supabase
      .from("layaway_accounts")
      .update({ remaining_balance: newRemaining })
      .eq("id", accountId);

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