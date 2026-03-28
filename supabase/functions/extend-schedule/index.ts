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
    console.warn(`[extend-schedule] reconcile call failed for ${accountId}:`, e);
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

    const { schedule_row_id, account_id, new_due_date, reason } = await req.json();
    if (!schedule_row_id || !account_id || !new_due_date || !reason?.trim()) {
      return new Response(JSON.stringify({ error: "schedule_row_id, account_id, new_due_date, and reason are required" }), {
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
      .select("id, status, invoice_number")
      .eq("id", account_id)
      .single();
    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (["completed", "forfeited", "final_forfeited", "cancelled"].includes(account.status)) {
      return new Response(JSON.stringify({ error: `Cannot edit schedule on ${account.status} account` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: row } = await supabase
      .from("layaway_schedule")
      .select("id, due_date, installment_number, status, account_id")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();
    if (!row) {
      return new Response(JSON.stringify({ error: "Schedule row not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (row.status === "cancelled") {
      return new Response(JSON.stringify({ error: "Cannot extend a cancelled row" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (new_due_date <= row.due_date) {
      return new Response(JSON.stringify({ error: `new_due_date must be after current due_date (${row.due_date})` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const today = new Date().toISOString().split("T")[0];
    if (new_due_date < today) {
      return new Response(JSON.stringify({ error: "new_due_date cannot be in the past" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate no conflict with adjacent rows
    const { data: allRows } = await supabase
      .from("layaway_schedule")
      .select("installment_number, due_date")
      .eq("account_id", account_id)
      .neq("id", schedule_row_id)
      .neq("status", "cancelled")
      .order("installment_number", { ascending: true });

    const prevRow = (allRows || [])
      .filter((r: any) => r.installment_number < row.installment_number)
      .sort((a: any, b: any) => b.installment_number - a.installment_number)[0];
    const nextRow = (allRows || [])
      .filter((r: any) => r.installment_number > row.installment_number)
      .sort((a: any, b: any) => a.installment_number - b.installment_number)[0];

    if (prevRow && new_due_date <= prevRow.due_date) {
      return new Response(JSON.stringify({ error: `new_due_date must be after previous row due_date (${prevRow.due_date})` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (nextRow && new_due_date >= nextRow.due_date) {
      return new Response(JSON.stringify({ error: `new_due_date must be before next row due_date (${nextRow.due_date})` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Determine new status: if row was overdue and new date > today, set to pending
    const newStatus = (row.status === "overdue" && new_due_date > today) ? "pending" : row.status;

    await supabase
      .from("layaway_schedule")
      .update({ due_date: new_due_date, status: newStatus })
      .eq("id", schedule_row_id);

    await supabase.from("schedule_audit_log").insert({
      account_id,
      schedule_id: schedule_row_id,
      admin_user_id: user.id,
      action: "extend_due_date",
      field_changed: "due_date",
      old_value: row.due_date,
      new_value: new_due_date,
      reason: reason.trim(),
    });

    await callReconcile(supabase, account_id);

    return new Response(JSON.stringify({
      success: true,
      schedule_row_id,
      old_due_date: row.due_date,
      new_due_date,
      new_status: newStatus,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
