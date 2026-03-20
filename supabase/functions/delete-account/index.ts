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

    const { account_id } = await req.json();
    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify account exists
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get schedule IDs for this account
    const { data: scheduleItems } = await supabase
      .from("layaway_schedule")
      .select("id")
      .eq("account_id", account_id);
    const scheduleIds = (scheduleItems || []).map(s => s.id);

    // Get payment IDs for this account
    const { data: payments } = await supabase
      .from("payments")
      .select("id")
      .eq("account_id", account_id);
    const paymentIds = (payments || []).map(p => p.id);

    // Delete in order: allocations -> penalties -> waiver requests -> reminder logs -> payments -> schedule -> audit logs -> account
    if (paymentIds.length > 0) {
      await supabase.from("payment_allocations").delete().in("payment_id", paymentIds);
    }
    if (scheduleIds.length > 0) {
      await supabase.from("penalty_fees").delete().in("schedule_id", scheduleIds);
      await supabase.from("penalty_waiver_requests").delete().in("schedule_id", scheduleIds);
      await supabase.from("reminder_logs").delete().eq("account_id", account_id);
    }
    await supabase.from("payments").delete().eq("account_id", account_id);
    await supabase.from("layaway_schedule").delete().eq("account_id", account_id);
    await supabase.from("audit_logs").delete().eq("entity_id", account_id);
    await supabase.from("layaway_accounts").delete().eq("id", account_id);

    // Audit the deletion
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_account",
      entity_id: account_id,
      action: "delete",
      old_value_json: { invoice_number: account.invoice_number },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
