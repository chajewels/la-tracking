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

    // 2. Permission gate (Bug #199 Batch A: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "create_cash_order");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "create_cash_order permission required" }), {
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
      order_date,
      expires_at,
      notes,
      agreement_version,
      is_trade, // boolean — optional, trade program flag (locked after creation)
    } = body;

    if (!customer_id || !invoice_number || !currency || total_amount == null || !expires_at) {
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
    // Validate expires_at parses to a real timestamp
    const expiresAtDate = new Date(expires_at);
    if (Number.isNaN(expiresAtDate.getTime())) {
      return new Response(JSON.stringify({ error: "expires_at must be a valid date/timestamp" }), {
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

    // 6b. Loyalty enforcement: if the customer is a loyalty member (any tier),
    // Loyalty Product Amount (JPY) is mandatory. Authoritative gate — the
    // NewCashOrder.tsx mirror is UX only. Matches create-layaway-account.
    const { data: memberRow } = await supabase
      .from("loyalty_members")
      .select("current_tier_id, current_tier:current_tier_id(name)")
      .eq("customer_id", customer_id)
      .maybeSingle();

    const hasLoyaltyTier = memberRow?.current_tier_id != null;
    if (hasLoyaltyTier && (loyaltyJpyAmount === null || loyaltyJpyAmount <= 0)) {
      return new Response(
        JSON.stringify({
          error: "LOYALTY_AMOUNT_REQUIRED",
          message: `Customer is a ${
            (memberRow.current_tier as any)?.name ?? "loyalty"
          } tier member. Loyalty Product Amount (JPY) is required.`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 7. Resolve order_date (defaults to today UTC date)
    const resolvedOrderDate = order_date || new Date().toISOString().split("T")[0];

    // 8. Build insert payload
    const insertRow: Record<string, unknown> = {
      customer_id,
      invoice_number,
      currency,
      total_amount: totalAmountNum,
      order_date: resolvedOrderDate,
      expires_at: expiresAtDate.toISOString(),
      notes: notes ?? null,
      status: "pending",
      total_paid: 0,
      remaining_balance: totalAmountNum,
      loyalty_jpy_amount: loyaltyJpyAmount,
      is_trade: is_trade ?? false,
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
