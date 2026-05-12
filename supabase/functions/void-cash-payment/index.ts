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

    // 1. Verify auth
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

    // 2. Admin only — staff/finance cannot void
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Parse + validate body
    const body = await req.json();
    const { cash_payment_id, void_reason } = body;
    if (!cash_payment_id) {
      return new Response(JSON.stringify({ error: "cash_payment_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!void_reason || !String(void_reason).trim()) {
      return new Response(JSON.stringify({ error: "void_reason is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Fetch cash_payment + cash_order
    const { data: payment, error: payErr } = await supabase
      .from("cash_payments")
      .select("id, cash_order_id, amount_paid, voided_at")
      .eq("id", cash_payment_id)
      .maybeSingle();
    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "cash_payment not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (payment.voided_at) {
      return new Response(JSON.stringify({ error: "cash_payment is already voided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: order, error: orderErr } = await supabase
      .from("cash_orders")
      .select("id, status, total_paid, remaining_balance, customer_id, invoice_number")
      .eq("id", payment.cash_order_id)
      .single();
    if (orderErr || !order) {
      return new Response(JSON.stringify({ error: "cash_order not found" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const amount = Number(payment.amount_paid);
    const newTotalPaid = Math.max(0, Math.round((Number(order.total_paid) - amount) * 100) / 100);
    const newRemaining = Math.max(0, Math.round((Number(order.remaining_balance) + amount) * 100) / 100);
    const wasCompleted = order.status === "completed";
    const newStatus = wasCompleted ? "pending" : order.status;

    // 5. Mark payment voided FIRST so any concurrent read excludes it
    const voidedAt = new Date().toISOString();
    const { error: voidErr } = await supabase
      .from("cash_payments")
      .update({
        voided_at: voidedAt,
        voided_by_user_id: user.id,
        void_reason,
      })
      .eq("id", cash_payment_id);
    if (voidErr) {
      return new Response(JSON.stringify({ error: "Failed to void payment: " + voidErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6. Reverse cash_order totals + revert status if needed
    const orderUpdate: Record<string, unknown> = {
      total_paid: newTotalPaid,
      remaining_balance: newRemaining,
    };
    if (wasCompleted) {
      orderUpdate.status = "pending";
      orderUpdate.completed_at = null;
    }

    const { data: updatedOrder, error: updateErr } = await supabase
      .from("cash_orders")
      .update(orderUpdate)
      .eq("id", order.id)
      .select()
      .single();
    if (updateErr) {
      // Best-effort rollback: unvoid the payment so order/payment stay in sync
      await supabase
        .from("cash_payments")
        .update({ voided_at: null, voided_by_user_id: null, void_reason: null })
        .eq("id", cash_payment_id);
      return new Response(JSON.stringify({ error: "Failed to update cash_order: " + updateErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 7. Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "cash_payment",
      entity_id: cash_payment_id,
      action: "void",
      old_value_json: {
        amount_paid: amount,
        cash_order_id: order.id,
        order_status_before: order.status,
        order_total_paid_before: Number(order.total_paid),
        order_remaining_before: Number(order.remaining_balance),
      },
      new_value_json: {
        void_reason,
        amount_voided: amount,
        cash_order_id: order.id,
        status_changed_to: newStatus,
      },
      performed_by_user_id: user.id,
    });

    // Bug #99 — fire-and-forget loyalty revoke for voided cash payment.
    // Cash orders are JPY-native (CLAUDE.md: "Cash Orders (always JPY)").
    //   Guard: only revoke if the cash order was 'completed' BEFORE this void
    //   (award fires only when isFullyPaid per review-payment-submission line
    //   674 — partial payments don't award, so they have nothing to revoke).
    //   Reuses the existing `wasCompleted` variable captured at line 96 BEFORE
    //   any updates to cash_orders.status in this function.
    if (!wasCompleted) {
      console.log(`[void-cash-payment] order was not 'completed' pre-void, skipping loyalty revoke for cash_order ${order.id}`);
    } else {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/revoke-loyalty-points`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            customer_id: order.customer_id,
            source_reference: order.invoice_number,
            spend_jpy: amount,
            cash_order_id: payment.cash_order_id,
            payment_id: payment.id,
            invoice_number: order.invoice_number,
            notes: `Cash payment voided: ${payment.id}`,
            trigger_event: "void_cash",
          }),
        }).catch((e) => console.warn("[void-cash-payment] revoke-loyalty-points failed (non-blocking):", e));
      } catch (revokeErr) {
        console.warn("[void-cash-payment] revoke block failed (non-blocking):", revokeErr);
      }
    }

    // 8. Return updated records
    return new Response(JSON.stringify({
      cash_order: updatedOrder,
      cash_payment: {
        id: cash_payment_id,
        cash_order_id: order.id,
        amount_paid: amount,
        voided_at: voidedAt,
        voided_by_user_id: user.id,
        void_reason,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("void-cash-payment error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
