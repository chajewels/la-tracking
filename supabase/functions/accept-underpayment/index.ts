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

    // Admin-only operation
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { schedule_row_id, account_id } = await req.json();
    if (!schedule_row_id || !account_id) {
      return new Response(JSON.stringify({ error: "schedule_row_id and account_id are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Fetch the target row
    const { data: row, error: rowErr } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();

    if (rowErr || !row) {
      return new Response(JSON.stringify({ error: "Schedule row not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Verify status = 'partially_paid'
    if (row.status !== "partially_paid") {
      return new Response(JSON.stringify({ error: `Row status is '${row.status}', expected 'partially_paid'` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const paidAmount = Number(row.paid_amount);
    const currentTotalDue = Number(row.total_due_amount);

    // Shortfall = what remains unpaid.
    // If total_due_amount < paid_amount (new semantics), total_due IS the remaining.
    // If total_due_amount >= paid_amount (old semantics), remaining = total_due - paid.
    const shortfall = currentTotalDue < paidAmount
      ? Math.round(currentTotalDue * 100) / 100
      : Math.round((currentTotalDue - paidAmount) * 100) / 100;

    if (shortfall <= 0) {
      return new Response(JSON.stringify({ error: "No shortfall to carry over" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Find next row (earliest due_date, status pending/overdue/partially_paid, not current)
    const { data: nextRows } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", account_id)
      .in("status", ["pending", "overdue", "partially_paid"])
      .neq("id", schedule_row_id)
      .order("due_date", { ascending: true })
      .limit(1);

    const nextRow = nextRows?.[0] ?? null;

    if (!nextRow) {
      return new Response(JSON.stringify({
        error: "Cannot carry over — no future installment found. Record a new payment instead.",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Mark current row as paid — total_due_amount = actual amount paid
    const { error: updateCurrErr } = await supabase
      .from("layaway_schedule")
      .update({
        status: "paid",
        total_due_amount: paidAmount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", schedule_row_id);

    if (updateCurrErr) {
      return new Response(JSON.stringify({ error: updateCurrErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5. (Intentionally no write to next row's total_due_amount.)
    // Inflating the next row causes double-counting in display and audit checks.
    // The canonical remaining_balance already captures the full debt correctly.

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_schedule",
      entity_id: schedule_row_id,
      action: "accept_underpayment",
      old_value_json: {
        status: "partially_paid",
        paid_amount: paidAmount,
        total_due_amount: currentTotalDue,
        shortfall,
      },
      new_value_json: {
        current_row: { id: schedule_row_id, status: "paid", total_due_amount: paidAmount },
        next_row: { id: nextRow.id, note: "total_due_amount unchanged — no inflation" },
      },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({
      success: true,
      current_row_id: schedule_row_id,
      next_row_id: nextRow.id,
      shortfall_carried: shortfall,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
