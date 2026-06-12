import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) throw new Error("Unauthorized");

    const canDeleteCustomer = await checkPermission(supabase, user.id, "delete_customer");
    if (!canDeleteCustomer) throw new Error("You do not have permission to delete customers");

    const { customer_id } = await req.json();
    if (!customer_id) throw new Error("customer_id is required");

    // Capture customer info for audit log (must happen before delete so
    // the row data is still in scope).
    const { data: customerRow } = await supabase
      .from("customers")
      .select("id, full_name, customer_code")
      .eq("id", customer_id)
      .single();

    // Consolidated pre-check — list ALL blockers in one response.
    // FK is RESTRICT/NO ACTION on both, so we block on ALL rows
    // regardless of status (status filter would let cancelled/expired
    // rows slip through and hit a generic FK 500 instead of our
    // friendly 400).
    const [accountsRes, cashOrdersRes] = await Promise.all([
      supabase
        .from("layaway_accounts")
        .select("id, invoice_number")
        .eq("customer_id", customer_id),
      supabase
        .from("cash_orders")
        .select("id, invoice_number")
        .eq("customer_id", customer_id),
    ]);
    if (accountsRes.error) throw accountsRes.error;
    if (cashOrdersRes.error) throw cashOrdersRes.error;

    const accounts = accountsRes.data || [];
    const cashOrders = cashOrdersRes.data || [];

    if (accounts.length > 0 || cashOrders.length > 0) {
      const blocked_by: Record<string, { count: number; invoice_numbers: string[] }> = {};
      if (accounts.length > 0) {
        blocked_by.layaway_accounts = {
          count: accounts.length,
          invoice_numbers: accounts.map((a: any) => a.invoice_number),
        };
      }
      if (cashOrders.length > 0) {
        blocked_by.cash_orders = {
          count: cashOrders.length,
          invoice_numbers: cashOrders.map((c: any) => c.invoice_number),
        };
      }
      const parts: string[] = [];
      if (accounts.length > 0)   parts.push(`${accounts.length} layaway account(s)`);
      if (cashOrders.length > 0) parts.push(`${cashOrders.length} cash order(s)`);
      return new Response(
        JSON.stringify({
          error: `Cannot delete: customer has ${parts.join(' and ')}. Reassign or close them first.`,
          blocked_by,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Extension requests cleanup (FK is NO ACTION — must explicitly delete)
    const { error: erErr } = await supabase
      .from("extension_requests")
      .delete()
      .eq("customer_id", customer_id);
    if (erErr) throw erErr;

    // 2. Payment submissions cleanup (FK is NO ACTION — must explicitly delete)
    const { error: psErr } = await supabase
      .from("payment_submissions")
      .delete()
      .eq("customer_id", customer_id);
    if (psErr) throw psErr;

    // 3. Service jobs cleanup (FK is NO ACTION — must explicitly delete)
    const { error: sjErr } = await supabase
      .from("service_jobs")
      .delete()
      .eq("customer_id", customer_id);
    if (sjErr) throw sjErr;

    // 4. Trade-ins cleanup (FK is NO ACTION — must explicitly delete)
    const { error: tiErr } = await supabase
      .from("trade_ins")
      .delete()
      .eq("customer_id", customer_id);
    if (tiErr) throw tiErr;

    // 5. Safe to delete — also clean up analytics
    await supabase.from("customer_analytics").delete().eq("customer_id", customer_id);
    const { error: delErr } = await supabase.from("customers").delete().eq("id", customer_id);
    if (delErr) throw delErr;

    // 4. Audit log — matches delete-account pattern from commit bf368a6
    await supabase.from("audit_logs").insert({
      entity_type: "customer",
      entity_id: customer_id,
      action: "delete",
      old_value_json: {
        full_name: customerRow?.full_name,
        customer_code: customerRow?.customer_code,
      },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
