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
    console.warn(`[add-installment] reconcile call failed for ${accountId}:`, e);
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

    const { account_id, due_date, base_amount, currency, reason } = await req.json();
    if (!account_id || !due_date || !base_amount || !currency || !reason?.trim()) {
      return new Response(JSON.stringify({ error: "account_id, due_date, base_amount, currency, and reason are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (Number(base_amount) <= 0) {
      return new Response(JSON.stringify({ error: "base_amount must be > 0" }), {
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
      .select("id, status, currency, total_amount, remaining_balance")
      .eq("id", account_id)
      .single();
    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (["completed", "forfeited", "final_forfeited", "cancelled"].includes(account.status)) {
      return new Response(JSON.stringify({ error: `Cannot add installment to ${account.status} account` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (account.currency !== currency) {
      return new Response(JSON.stringify({ error: `Currency mismatch: account is ${account.currency}, got ${currency}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existingRows } = await supabase
      .from("layaway_schedule")
      .select("installment_number, due_date")
      .eq("account_id", account_id)
      .neq("status", "cancelled")
      .order("due_date", { ascending: false });

    const maxDate = existingRows?.[0]?.due_date ?? null;
    if (maxDate && due_date <= maxDate) {
      return new Response(JSON.stringify({ error: `due_date must be after all existing rows (latest: ${maxDate})` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const maxInstNumber = Math.max(...(existingRows || []).map((r: any) => r.installment_number), 0);
    const nextNumber = maxInstNumber + 1;
    const roundedAmount = Math.round(Number(base_amount) * 100) / 100;

    const { data: newRow, error: insertErr } = await supabase
      .from("layaway_schedule")
      .insert({
        account_id,
        installment_number: nextNumber,
        due_date,
        base_installment_amount: roundedAmount,
        total_due_amount: roundedAmount,
        penalty_amount: 0,
        carried_amount: 0,
        paid_amount: 0,
        currency,
        status: "pending",
      })
      .select("id")
      .single();
    if (insertErr) throw insertErr;

    const newTotal = Math.round((Number(account.total_amount) + roundedAmount) * 100) / 100;
    const newRemaining = Math.round((Number(account.remaining_balance) + roundedAmount) * 100) / 100;
    await supabase
      .from("layaway_accounts")
      .update({ total_amount: newTotal, remaining_balance: Math.max(0, newRemaining) })
      .eq("id", account_id);

    await supabase.from("schedule_audit_log").insert({
      account_id,
      schedule_id: newRow.id,
      admin_user_id: user.id,
      action: "add_installment",
      field_changed: "base_installment_amount",
      old_value: "0",
      new_value: String(roundedAmount),
      reason: reason.trim(),
    });

    await callReconcile(supabase, account_id);

    return new Response(JSON.stringify({
      success: true,
      schedule_row_id: newRow.id,
      installment_number: nextNumber,
      base_amount: roundedAmount,
      due_date,
      new_total_amount: newTotal,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
