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

    // Delete in dependency order to avoid FK constraint violations
    // 1. Payment submission allocations (references payment_submissions + layaway_accounts)
    await supabase.from("payment_submission_allocations").delete().eq("account_id", account_id);

    // 2. Payment submissions (references layaway_accounts)
    await supabase.from("payment_submissions").delete().eq("account_id", account_id);

    // 3. Payment allocations (references payments + layaway_schedule)
    if (paymentIds.length > 0) {
      await supabase.from("payment_allocations").delete().in("payment_id", paymentIds);
    }

    // 4. Penalty waiver requests (references penalty_fees + layaway_schedule)
    await supabase.from("penalty_waiver_requests").delete().eq("account_id", account_id);

    // 5. Penalty fees (references layaway_schedule + layaway_accounts)
    await supabase.from("penalty_fees").delete().eq("account_id", account_id);

    // 6. CSR notifications (references layaway_accounts + layaway_schedule)
    await supabase.from("csr_notifications").delete().eq("account_id", account_id);

    // 7. Reminder logs (references layaway_accounts)
    await supabase.from("reminder_logs").delete().eq("account_id", account_id);

    // 8. Account services (references layaway_accounts)
    await supabase.from("account_services").delete().eq("account_id", account_id);

    // 9. Final settlement records (references layaway_accounts)
    await supabase.from("final_settlement_records").delete().eq("account_id", account_id);

    // 10. Penalty cap overrides (references layaway_accounts)
    await supabase.from("penalty_cap_overrides").delete().eq("account_id", account_id);

    // 11. Statement tokens (references layaway_accounts)
    await supabase.from("statement_tokens").delete().eq("account_id", account_id);

    // 12. Payments (references layaway_accounts)
    await supabase.from("payments").delete().eq("account_id", account_id);

    // 13. Layaway schedule (references layaway_accounts)
    await supabase.from("layaway_schedule").delete().eq("account_id", account_id);

    // 14. Audit logs for this entity
    await supabase.from("audit_logs").delete().eq("entity_id", account_id);

    // 15. Finally, the account itself
    const { error: delErr } = await supabase.from("layaway_accounts").delete().eq("id", account_id);
    if (delErr) {
      console.error("Failed to delete account:", delErr);
      return new Response(JSON.stringify({ error: "Failed to delete account: " + delErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
