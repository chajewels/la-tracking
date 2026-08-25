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

    // Reuses the delete_account permission key — same admin-level destructive
    // action, and delete_cash_order_atomic independently enforces admin role.
    const allowed = await checkPermission(supabase, user.id, "delete_account");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "delete_account permission required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { cash_order_id } = await req.json();
    if (!cash_order_id) {
      return new Response(JSON.stringify({ error: "cash_order_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: order } = await supabase
      .from("cash_orders")
      .select("id, invoice_number, customer_id, status")
      .eq("id", cash_order_id)
      .maybeSingle();

    if (!order) {
      return new Response(JSON.stringify({ error: "Cash order not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Loyalty revoke BEFORE deletion. loyalty_transactions.cash_order_id is
    // ON DELETE SET NULL, so points and cumulative_spend_jpy survive the
    // delete — without this the member's balance stays inflated by an order
    // that no longer exists. Mirrors delete-account (Bug #99 Decision 9 path-a).
    try {
      const _rvRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/revoke-loyalty-points`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          customer_id: order.customer_id,
          source_reference: order.invoice_number,
          cash_order_id: order.id,
          invoice_number: order.invoice_number,
          notes: `Cash order deleted: ${order.invoice_number}`,
          // Must be a key of TRIGGER_TO_REASON in revoke-loyalty-points —
          // "delete_cash_order" is not one, and returns 400 (fire-and-forget,
          // so the delete silently proceeds without revoking). Reusing
          // delete_account maps to RevokeReason "account_deleted", which
          // accurately describes a deleted cash order.
          trigger_event: "delete_account",
          spend_jpy: 0,
        }),
      }).catch((e) => { console.warn("[delete-cash-order] revoke-loyalty-points failed (non-blocking):", e); return null; });
      if (_rvRes && !_rvRes.ok) {
        const _t = await _rvRes.text().catch(() => "<no body>");
        console.error(`[delete-cash-order] revoke-loyalty-points failed (${_rvRes.status}): ${_t}`);
      }
    } catch (revokeErr) {
      console.warn("[delete-cash-order] revoke block failed (non-blocking):", revokeErr);
    }

    const { data, error: rpcError } = await supabase.rpc('delete_cash_order_atomic', {
      p_cash_order_id: cash_order_id,
      p_performed_by_user_id: user.id,
    });

    if (rpcError) {
      return new Response(JSON.stringify({ error: rpcError.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (data?.error) {
      const status = data.error === 'Cash order not found' ? 404 : 500;
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
