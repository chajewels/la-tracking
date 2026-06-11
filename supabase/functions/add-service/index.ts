import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Verify auth token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Permission gate (Bug #204 Batch E: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "add_service");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "add_service permission required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse body (service_type is the DB column; service_name accepted as alias)
    const body = await req.json();
    const {
      account_id,
      service_type,
      service_name,
      description,
      amount,
      currency,
    } = body;
    const resolvedServiceType = service_type || service_name;

    if (!account_id || !resolvedServiceType || amount == null || !currency) {
      return new Response(JSON.stringify({ error: "account_id, service_type (or service_name), amount, and currency are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum < 0) {
      return new Response(JSON.stringify({ error: "amount must be a non-negative number" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const roundedAmount = Math.round(amountNum * 100) / 100;

    // 3. Fetch current account totals
    const { data: account, error: acctErr } = await supabase
      .from("layaway_accounts")
      .select("id, currency, total_amount, remaining_balance")
      .eq("id", account_id)
      .single();
    if (acctErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (account.currency !== currency) {
      return new Response(JSON.stringify({ error: `Currency mismatch: account is ${account.currency}, got ${currency}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Set bypass flag for enforce_total_amount_admin_only trigger
    await supabase.rpc("set_config", {
      setting: "app.allow_total_amount_edit",
      value: "true",
      is_local: true,
    });

    // 5. Insert service row
    const { error: insertErr } = await supabase
      .from("account_services")
      .insert({
        account_id,
        service_type: resolvedServiceType,
        description: description?.trim() || null,
        amount: roundedAmount,
        currency,
        created_by_user_id: user.id,
      });
    if (insertErr) throw insertErr;

    // 6. Update layaway_accounts totals
    const newTotalAmount = Math.round((Number(account.total_amount) + roundedAmount) * 100) / 100;
    const newRemainingBalance = Math.max(
      0,
      Math.round((Number(account.remaining_balance) + roundedAmount) * 100) / 100,
    );
    const { error: updateErr } = await supabase
      .from("layaway_accounts")
      .update({
        total_amount: newTotalAmount,
        remaining_balance: newRemainingBalance,
      })
      .eq("id", account_id);
    if (updateErr) throw updateErr;

    // 7. Return success
    return new Response(
      JSON.stringify({
        success: true,
        new_total_amount: newTotalAmount,
        new_remaining_balance: newRemainingBalance,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
