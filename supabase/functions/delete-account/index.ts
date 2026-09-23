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
      .select("id, invoice_number, customer_id, status, total_paid, currency, customers(is_test)")
      .eq("id", account_id)
      .maybeSingle();

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Completed or paid accounts are NEVER deleted (owner decision 2026-09-13,
    // after layaway 19278 — ₱523,712 fully paid — was deleted with its payments).
    // Cancel/forfeit with a reason, or void the payment. Checked here BEFORE the
    // loyalty revoke so nothing is revoked on the way to a refusal; the DB
    // refuses too (trg_prevent_paid_layaway_delete + delete_account_atomic).
    // Test customers' accounts are exempt.
    const isTest = (account as any).customers?.is_test === true;
    if (!isTest && (account.status === "completed" || Number(account.total_paid ?? 0) > 0)) {
      return new Response(JSON.stringify({
        error: "paid_order_delete_forbidden",
        message: `INV ${account.invoice_number} is ${account.status} with ${account.currency} ${Number(account.total_paid ?? 0).toLocaleString()} received. Completed or paid accounts are never deleted — cancel it with a reason, or void the payment.`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Loyalty reversal moved INTO delete_account_atomic (2026-09-14, Bug #271).
    // It now runs in the same transaction as the delete, so a delete that fails
    // no longer leaves the points revoked, and it reads the spend basis from the
    // ledger while the order row is still there. The RPC's call is idempotent,
    // so nothing breaks if an older build of this function is still deployed.

    // Atomic delete via RPC (16 cleanup steps + audit log, single transaction)
    // RPC body lives in supabase/migrations/<timestamp>_delete_account_atomic.sql
    const { data, error: rpcError } = await supabase.rpc('delete_account_atomic', {
      p_account_id: account_id,
      p_performed_by_user_id: user.id,
    });

    if (rpcError) {
      // trg_prevent_web_layaway_delete RAISEs inside the RPC's transaction, so a
      // refused web plan arrives here as an ordinary RPC error and used to render
      // as a bare 500 with no explanation. The trigger's own sentence is the one
      // staff should read, so pass it through verbatim as a 409 — the refusal is a
      // rule, not a failure. Everything else keeps the 500 it had.
      const rpcMsg = rpcError.message ?? "";
      if (rpcMsg.includes("web_layaway_delete_forbidden")) {
        return new Response(JSON.stringify({
          error: "web_layaway_delete_forbidden",
          message: rpcMsg.replace(/^[\s\S]*?web_layaway_delete_forbidden:\s*/, ""),
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: rpcError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (data?.error) {
      const status = data.error === 'Account not found' ? 404
        : data.error === 'paid_order_delete_forbidden' ? 409
        : data.error === 'web_layaway_delete_forbidden' ? 409 : 500;
      return new Response(JSON.stringify({ error: data.error, message: data.message ?? undefined }), {
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
