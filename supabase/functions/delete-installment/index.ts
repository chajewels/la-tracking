import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function callReconcile(supabase: any, accountId: string) {
  try {
    await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/reconcile-account`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ account_id: accountId }),
      }
    );
  } catch (e) {
    console.warn(`[delete-installment] reconcile call failed for ${accountId}:`, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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

    const { schedule_row_id, account_id, reason } = await req.json();
    if (!schedule_row_id || !account_id || !reason?.trim()) {
      return new Response(JSON.stringify({ error: "schedule_row_id, account_id, and reason are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Admin only
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("id, status, total_amount, remaining_balance")
      .eq("id", account_id)
      .single();
    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (["completed", "forfeited", "final_forfeited", "cancelled"].includes(account.status)) {
      return new Response(JSON.stringify({ error: `Cannot delete installment on ${account.status} account` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: row } = await supabase
      .from("layaway_schedule")
      .select("id, installment_number, base_installment_amount, carried_amount, status, account_id")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();
    if (!row) {
      return new Response(JSON.stringify({ error: "Schedule row not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate: row must have zero allocations
    const { count: allocCount } = await supabase
      .from("payment_allocations")
      .select("id", { count: "exact", head: true })
      .eq("schedule_id", schedule_row_id);
    if ((allocCount || 0) > 0) {
      return new Response(JSON.stringify({
        error: "Cannot delete row with recorded payments. Void all payments first."
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Validate: no carried amount
    if (Number(row.carried_amount) > 0.005) {
      return new Response(JSON.stringify({
        error: `Cannot delete row with carried amount of ${row.carried_amount}. Resolve carry-over first.`
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const baseAmt = Number(row.base_installment_amount);

    await supabase.from("schedule_audit_log").insert({
      account_id,
      schedule_id: schedule_row_id,
      admin_user_id: user.id,
      action: "delete_installment",
      field_changed: "base_installment_amount",
      old_value: String(baseAmt),
      new_value: "0",
      reason: reason.trim(),
    });

    await supabase
      .from("layaway_schedule")
      .delete()
      .eq("id", schedule_row_id);

    const newTotal = Math.max(0, Math.round((Number(account.total_amount) - baseAmt) * 100) / 100);
    const newRemaining = Math.max(0, Math.round((Number(account.remaining_balance) - baseAmt) * 100) / 100);
    await supabase
      .from("layaway_accounts")
      .update({ total_amount: newTotal, remaining_balance: newRemaining })
      .eq("id", account_id);

    await callReconcile(supabase, account_id);

    return new Response(JSON.stringify({
      success: true,
      deleted_schedule_row_id: schedule_row_id,
      installment_number: row.installment_number,
      base_amount_removed: baseAmt,
      new_total_amount: newTotal,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
