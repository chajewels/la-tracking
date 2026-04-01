import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reactivate Account — One-time reactivation of a forfeited account
 *
 * ⛔ PERMANENT FORFEITURE LIFECYCLE — LOCKED RULE
 * DO NOT MODIFY without explicit business owner approval.
 *
 * GUARDS (all enforced server-side):
 *   - Account MUST be in 'forfeited' status
 *   - Account MUST NOT have is_reactivated = true (one-time only)
 *   - FINAL_FORFEITED accounts can NEVER be reactivated
 *
 * ACTIONS:
 *   1. Changes status to 'extension_active'
 *   2. Sets is_reactivated = true, extension_end_date = last_due + 1 month
 *   3. Records penalty_count_at_reactivation (penalty cycle continues, no reset)
 *   4. Un-cancels remaining schedule items
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allowed = await checkPermission(supabase, user.id, "reactivate_account");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Permission denied: reactivate_account not allowed" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { account_id } = await req.json();
    if (!account_id) {
      return new Response(JSON.stringify({ error: "account_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const staffUserId = user.id;

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, customer_id, status, is_reactivated, currency, payment_plan_months")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ⛔ LOCKED: FINAL_FORFEITED can NEVER be reactivated
    if (account.status === "final_forfeited") {
      return new Response(JSON.stringify({ error: "This account is PERMANENTLY FORFEITED. No reactivation, extension, or negotiation is allowed." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ⛔ LOCKED: must be forfeited status
    if (account.status !== "forfeited") {
      return new Response(JSON.stringify({ error: `Account is '${account.status}', not 'forfeited'. Only forfeited accounts can be reactivated.` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ⛔ LOCKED: one-time only — no second reactivation ever
    if (account.is_reactivated) {
      return new Response(JSON.stringify({ error: "This account has already been reactivated once. No further reactivation is allowed." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get current penalty count to preserve continuation
    const { data: penalties } = await supabase
      .from("penalty_fees")
      .select("id")
      .eq("account_id", account_id)
      .in("status", ["unpaid", "paid"]);
    const currentPenaltyCount = (penalties || []).length;

    // Get the last due date from schedule to compute extension end
    const { data: schedItems } = await supabase
      .from("layaway_schedule")
      .select("due_date, id, status")
      .eq("account_id", account_id)
      .order("installment_number", { ascending: false });

    const lastDueDate = schedItems && schedItems.length > 0
      ? schedItems[0].due_date
      : new Date().toISOString().split("T")[0];

    // Extension = 1 month after the last schedule due date
    const extDate = new Date(lastDueDate + "T00:00:00Z");
    extDate.setUTCMonth(extDate.getUTCMonth() + 1);
    const extensionEndDate = extDate.toISOString().split("T")[0];

    const now = new Date().toISOString();

    // Un-cancel remaining schedule items so penalty engine can continue
    const cancelledItems = (schedItems || []).filter((s: any) => s.status === "cancelled");
    for (const item of cancelledItems) {
      await supabase.from("layaway_schedule").update({
        status: "overdue",
        updated_at: now,
      }).eq("id", item.id);
    }

    // Update account
    const { error: updateErr } = await supabase
      .from("layaway_accounts")
      .update({
        status: "extension_active",
        is_reactivated: true,
        reactivated_at: now,
        reactivated_by_user_id: staffUserId,
        extension_end_date: extensionEndDate,
        penalty_count_at_reactivation: currentPenaltyCount,
        updated_at: now,
      })
      .eq("id", account_id);

    if (updateErr) throw updateErr;

    // Fetch customer name for audit
    const { data: cust } = await supabase
      .from("customers")
      .select("full_name")
      .eq("id", account.customer_id)
      .single();

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_account",
      entity_id: account_id,
      action: "reactivated",
      performed_by_user_id: staffUserId,
      new_value_json: {
        invoice_number: account.invoice_number,
        customer_name: cust?.full_name || "Unknown",
        penalty_count_at_reactivation: currentPenaltyCount,
        extension_end_date: extensionEndDate,
        timestamp: now,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      invoice_number: account.invoice_number,
      new_status: "extension_active",
      extension_end_date: extensionEndDate,
      penalty_count_preserved: currentPenaltyCount,
      message: `Account reactivated. Extension until ${extensionEndDate}. Penalty count continues from ${currentPenaltyCount}.`,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Reactivate account error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
