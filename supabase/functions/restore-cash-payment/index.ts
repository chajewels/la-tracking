import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface RequestBody {
  cash_payment_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // --- Auth ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse(401, { error: "Missing Authorization header" });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return jsonResponse(401, { error: "Invalid auth token" });
    }
    const user = userData.user;

    const { data: isAdminData, error: roleErr } = await supabase.rpc("has_role", {
      _user_id: user.id,
      _role: "admin",
    });
    if (roleErr || !isAdminData) {
      return jsonResponse(403, { error: "Admin role required" });
    }

    // --- Body validation ---
    const body: RequestBody = await req.json();
    if (!body.cash_payment_id) {
      return jsonResponse(400, { error: "cash_payment_id is required" });
    }

    // --- Fetch voided cash_payment ---
    const { data: cashPayment, error: cpErr } = await supabase
      .from("cash_payments")
      .select("id, cash_order_id, amount_paid, voided_at")
      .eq("id", body.cash_payment_id)
      .single();

    if (cpErr || !cashPayment) {
      return jsonResponse(404, { error: "Cash payment not found" });
    }
    if (!cashPayment.voided_at) {
      return jsonResponse(400, { error: "Cash payment is not voided" });
    }

    // --- Fetch parent cash_order ---
    const { data: cashOrder, error: coErr } = await supabase
      .from("cash_orders")
      .select("id, status, total_amount, total_paid, remaining_balance, customer_id, invoice_number")
      .eq("id", cashPayment.cash_order_id)
      .single();

    if (coErr || !cashOrder) {
      return jsonResponse(404, { error: "Parent cash order not found" });
    }

    // --- State machine guards ---
    if (cashOrder.status === "cancelled") {
      return jsonResponse(400, { error: "Cannot restore payment on cancelled order" });
    }
    if (cashOrder.status === "expired") {
      return jsonResponse(400, { error: "Cannot restore payment on expired order" });
    }

    // --- Compute deltas ---
    const amount = Number(cashPayment.amount_paid);
    const currentTotalPaid = Number(cashOrder.total_paid);
    const totalAmount = Number(cashOrder.total_amount);
    const newTotalPaid = currentTotalPaid + amount;

    // Ceiling check
    if (newTotalPaid > totalAmount + 0.01) {
      return jsonResponse(400, {
        error: `Restore would exceed order total (new paid: ${newTotalPaid}, total: ${totalAmount})`,
      });
    }

    const newRemaining = Math.max(0, totalAmount - newTotalPaid);
    const becomesCompleted = newTotalPaid >= totalAmount - 0.01;
    const newStatus = becomesCompleted ? "completed" : "pending";

    // --- Unvoid the cash_payment ---
    const { error: unvoidErr } = await supabase
      .from("cash_payments")
      .update({
        voided_at: null,
        voided_by_user_id: null,
        void_reason: null,
      })
      .eq("id", body.cash_payment_id);

    if (unvoidErr) {
      return jsonResponse(500, { error: `Failed to unvoid cash payment: ${unvoidErr.message}` });
    }

    // --- Update cash_orders ---
    const orderUpdate: Record<string, unknown> = {
      total_paid: newTotalPaid,
      remaining_balance: newRemaining,
      status: newStatus,
    };
    if (becomesCompleted) {
      orderUpdate.completed_at = new Date().toISOString();
    }

    const { error: orderUpdErr } = await supabase
      .from("cash_orders")
      .update(orderUpdate)
      .eq("id", cashOrder.id);

    if (orderUpdErr) {
      // Best-effort rollback: re-void the cash_payment
      await supabase
        .from("cash_payments")
        .update({
          voided_at: cashPayment.voided_at,
          voided_by_user_id: user.id,
          void_reason: "Auto-revert: restore failed",
        })
        .eq("id", body.cash_payment_id);

      return jsonResponse(500, { error: `Failed to update cash order: ${orderUpdErr.message}` });
    }

    // --- Audit log ---
    await supabase.from("audit_logs").insert({
      entity_type: "cash_payment",
      entity_id: body.cash_payment_id,
      action: "restore",
      performed_by_user_id: user.id,
      new_value_json: {
        cash_order_id: cashOrder.id,
        amount_paid: amount,
        previous_status: cashOrder.status,
        new_status: newStatus,
        new_total_paid: newTotalPaid,
        new_remaining: newRemaining,
      },
    });

    // --- Fire-and-forget: loyalty restore if order is now completed ---
    if (becomesCompleted) {
      try {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/restore-loyalty-points`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            cash_order_id: cashOrder.id,
            customer_id: cashOrder.customer_id,
          }),
        });
      } catch (loyaltyErr) {
        console.warn("[restore-cash-payment] loyalty restore failed (non-blocking):", loyaltyErr);
      }
    }

    // --- Fetch updated rows for response ---
    const { data: updatedOrder } = await supabase
      .from("cash_orders")
      .select("*")
      .eq("id", cashOrder.id)
      .single();
    const { data: updatedPayment } = await supabase
      .from("cash_payments")
      .select("*")
      .eq("id", body.cash_payment_id)
      .single();

    return jsonResponse(200, {
      success: true,
      cash_order: updatedOrder,
      cash_payment: updatedPayment,
    });
  } catch (err) {
    console.error("[restore-cash-payment] error:", err);
    return jsonResponse(500, { error: (err as Error).message });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
