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
      .select("id, invoice_number, customer_id, status, source_channel, web_reference, total_paid, currency, customers(is_test)")
      .eq("id", cash_order_id)
      .maybeSingle();

    if (!order) {
      return new Response(JSON.stringify({ error: "Cash order not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Web orders are cancelled, never deleted: the customer's order history,
    // the stock hold and the points reversal all hang off this row. The DB
    // refuses too (trg_prevent_web_order_delete + delete_cash_order_atomic);
    // this is the readable answer.
    if (order.source_channel === "web") {
      return new Response(JSON.stringify({
        error: "web_order_delete_forbidden",
        message: `${order.web_reference ?? order.invoice_number} is a web order. Cancel it instead.`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Completed or paid orders are NEVER deleted (owner decision 2026-09-13,
    // after 19144 and 19278 vanished from the books). Cancel with a reason, or
    // void the payment — a reversal that stays on the books. The DB refuses too
    // (trg_prevent_paid_cash_order_delete + delete_cash_order_atomic); this is
    // the readable answer. Test customers' orders are exempt.
    const isTest = (order as any).customers?.is_test === true;
    if (!isTest && (order.status === "completed" || Number(order.total_paid ?? 0) > 0)) {
      return new Response(JSON.stringify({
        error: "paid_order_delete_forbidden",
        message: `INV ${order.invoice_number} is ${order.status} with ${order.currency} ${Number(order.total_paid ?? 0).toLocaleString()} received. Completed or paid orders are never deleted — cancel it with a reason, or void the payment.`,
      }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Loyalty points are revoked INSIDE delete_cash_order_atomic, in the same
    // transaction as the delete. The old fire-and-forget HTTP call to
    // revoke-loyalty-points could lose the race (2026-08-25 ledger note).

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
      const status = data.error === 'Cash order not found' ? 404
        : (data.error === 'web_order_delete_forbidden' || data.error === 'paid_order_delete_forbidden') ? 409 : 500;
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
