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

    // 2. Admin or staff only
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    const { data: isStaff } = await supabase.rpc("has_role", { _user_id: user.id, _role: "staff" });
    if (!isAdmin && !isStaff) {
      return new Response(JSON.stringify({ error: "Admin or staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Parse + validate body
    const body = await req.json();
    const {
      customer_id,
      invoice_number,
      currency,
      total_amount,
      item_description,
      order_date,
      notes,
      agreement_version,
    } = body;

    if (!customer_id || !invoice_number || !currency || total_amount == null || !item_description) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!["PHP", "JPY"].includes(currency)) {
      return new Response(JSON.stringify({ error: "Currency must be PHP or JPY" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const totalAmountNum = Number(total_amount);
    if (!Number.isFinite(totalAmountNum) || totalAmountNum <= 0) {
      return new Response(JSON.stringify({ error: "total_amount must be a positive number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Customer must exist
    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customer_id)
      .maybeSingle();
    if (customerErr || !customer) {
      return new Response(JSON.stringify({ error: "customer_id not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. Invoice number must be unique across cash_orders AND layaway_accounts
    const [{ data: existingCash }, { data: existingLayaway }] = await Promise.all([
      supabase.from("cash_orders").select("id").eq("invoice_number", invoice_number).maybeSingle(),
      supabase.from("layaway_accounts").select("id").eq("invoice_number", invoice_number).maybeSingle(),
    ]);
    if (existingCash || existingLayaway) {
      return new Response(JSON.stringify({ error: `invoice_number ${invoice_number} already exists` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6. Loyalty-only product amount in JPY — manually entered by
    // admin/finance because total_amount can include shipping, service
    // fees, and insurance that don't count toward loyalty points. NULL
    // means the customer is not a loyalty member or the value was
    // intentionally left blank.
    const loyaltyJpyAmount =
      typeof body.loyalty_jpy_amount === "number" && body.loyalty_jpy_amount > 0
        ? Math.round(body.loyalty_jpy_amount)
        : null;

    // 7. Resolve order_date (defaults to today UTC date)
    const resolvedOrderDate = order_date || new Date().toISOString().split("T")[0];

    // 8. Build insert payload
    const insertRow: Record<string, unknown> = {
      customer_id,
      invoice_number,
      currency,
      total_amount: totalAmountNum,
      item_description,
      order_date: resolvedOrderDate,
      notes: notes ?? null,
      status: "pending",
      total_paid: 0,
      remaining_balance: totalAmountNum,
      loyalty_jpy_amount: loyaltyJpyAmount,
      created_by_user_id: user.id,
    };
    if (agreement_version) {
      insertRow.agreement_version = agreement_version;
      insertRow.accepted_by_user_id = user.id;
      insertRow.agreement_acceptance_datetime = new Date().toISOString();
    }

    // 9. Insert cash order
    const { data: cashOrder, error: insertErr } = await supabase
      .from("cash_orders")
      .insert(insertRow)
      .select()
      .single();
    if (insertErr || !cashOrder) {
      return new Response(JSON.stringify({ error: insertErr?.message || "Failed to create cash order" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 10. Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "cash_order",
      entity_id: cashOrder.id,
      action: "create",
      new_value_json: cashOrder,
      performed_by_user_id: user.id,
    });

    // 11. Return created record
    return new Response(JSON.stringify({ cash_order: cashOrder }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("create-cash-order error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
