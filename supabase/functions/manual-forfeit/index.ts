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

    // Auth check — require valid Bearer token
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

    // Admin role check
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "Forbidden: admin role required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { account_id } = await req.json();
    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch account
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

    // Block already-terminal states
    const blocked = ["forfeited", "final_forfeited", "completed", "cancelled"];
    if (blocked.includes(account.status)) {
      return new Response(
        JSON.stringify({ error: `Cannot forfeit account with status '${account.status}'` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const now = new Date().toISOString();

    // Update account to forfeited
    const { error: updateErr } = await supabase
      .from("layaway_accounts")
      .update({ status: "forfeited", updated_at: now })
      .eq("id", account_id);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: "Failed to update account: " + updateErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Cancel all non-paid schedule rows
    const { error: schedErr } = await supabase
      .from("layaway_schedule")
      .update({ status: "cancelled", updated_at: now })
      .eq("account_id", account_id)
      .not("status", "eq", "paid");

    if (schedErr) {
      console.error("manual-forfeit: schedule cancel error:", schedErr.message);
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_account",
      entity_id: account_id,
      action: "manual_forfeit",
      performed_by_user_id: user.id,
      new_value_json: {
        invoice_number: account.invoice_number,
        previous_status: account.status,
        forfeited_at: now,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, invoice_number: account.invoice_number, account_id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("manual-forfeit error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
