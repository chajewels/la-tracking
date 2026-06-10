import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

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

    // Validate JWT
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

    // Permission gate (Bug #199 Batch A: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "delete_account");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "delete_account permission required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse and validate input
    const { account_id } = await req.json();
    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch account details for loyalty revoke (Bug #99 — Decision 9 path-a)
    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, customer_id, status")
      .eq("id", account_id)
      .maybeSingle();

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Bug #99 — fire-and-forget loyalty revoke BEFORE deletion (Decision 9 path-a)
    try {
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/revoke-loyalty-points`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          customer_id: account.customer_id,
          source_reference: account.invoice_number,
          account_id: account.id,
          invoice_number: account.invoice_number,
          notes: `Account deleted: ${account.invoice_number}`,
          trigger_event: "delete_account",
          spend_jpy: 0,
        }),
      }).catch((e) => console.warn("[delete-account] revoke-loyalty-points failed (non-blocking):", e));
    } catch (revokeErr) {
      console.warn("[delete-account] revoke block failed (non-blocking):", revokeErr);
    }

    // Atomic delete via RPC (16 cleanup steps + audit log, single transaction)
    // RPC body lives in supabase/migrations/<timestamp>_delete_account_atomic.sql
    const { data, error: rpcError } = await supabase.rpc('delete_account_atomic', {
      p_account_id: account_id,
      p_performed_by_user_id: user.id,
    });

    if (rpcError) {
      return new Response(JSON.stringify({ error: rpcError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (data?.error) {
      const status = data.error === 'Account not found' ? 404 : 500;
      return new Response(JSON.stringify({ error: data.error }), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
