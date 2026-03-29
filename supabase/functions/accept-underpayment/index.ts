import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function callReconcile(accountId: string) {
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
    console.warn(`[accept-underpayment] reconcile call failed for ${accountId}:`, e);
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

    // Admin only
    const { data: isAdmin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { schedule_row_id, account_id, reason } = await req.json();
    if (!schedule_row_id || !account_id) {
      return new Response(JSON.stringify({ error: "schedule_row_id and account_id are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!reason?.trim()) {
      return new Response(JSON.stringify({ error: "reason is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 2: Fetch the current row from layaway_schedule directly.
    // Deliberately NOT using schedule_with_actuals view — the view requires
    // Phase 1 migration to be deployed and is intended for display reads.
    // Edge functions that write must read from the DB table directly.
    const { data: schedRow, error: schedErr } = await supabase
      .from("layaway_schedule")
      .select("id, account_id, installment_number, due_date, status, base_installment_amount, penalty_amount, paid_amount, total_due_amount, carried_amount, carried_from_schedule_id")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();

    if (schedErr || !schedRow) {
      return new Response(JSON.stringify({ error: "Schedule row not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 3: Validate status = 'partially_paid' using DB status directly
    if (schedRow.status !== "partially_paid") {
      return new Response(JSON.stringify({
        error: `Row must be partially_paid, got: ${schedRow.status}`
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Step 4: Compute shortfall = base + penalty + carried - paid
    // This is the canonical remaining amount for the row, no view needed.
    const shortfall = Math.round(Math.max(0,
      Number(schedRow.base_installment_amount)
      + Number(schedRow.penalty_amount ?? 0)
      + Number(schedRow.carried_amount ?? 0)
      - Number(schedRow.paid_amount)
    ) * 100) / 100;

    if (shortfall <= 0.005) {
      return new Response(JSON.stringify({ error: "Row has no remaining shortfall to carry over" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 6: Find next row: lowest due_date WHERE status IN ('pending','overdue','partially_paid')
    //          AND id != current row. Select base_installment_amount for ceiling response.
    //          carried_amount may not exist pre-Phase-1-migration; guard below with ?? 0.
    const { data: allRows } = await supabase
      .from("layaway_schedule")
      .select("id, installment_number, due_date, status, base_installment_amount, carried_amount")
      .eq("account_id", account_id)
      .in("status", ["pending", "overdue", "partially_paid"])
      .neq("id", schedule_row_id)
      .order("due_date", { ascending: true })
      .limit(1);

    if (!allRows || allRows.length === 0) {
      return new Response(JSON.stringify({
        error: "Cannot carry over — no future installment found"
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const nextRow = allRows[0];

    // Step 8: Validate next row has no existing carried_amount (guard with ?? 0 pre-migration)
    if (Number(nextRow.carried_amount ?? 0) > 0.005) {
      return new Response(JSON.stringify({
        error: `Month ${nextRow.installment_number} already has a carried amount of ${nextRow.carried_amount}. Resolve it first.`
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Get the latest payment on the current row (to track carried_by_payment_id)
    const { data: latestAlloc } = await supabase
      .from("payment_allocations")
      .select("payment_id")
      .eq("schedule_id", schedule_row_id)
      .eq("allocation_type", "installment")
      .order("created_at", { ascending: false })
      .limit(1);
    const carriedByPaymentId = latestAlloc?.[0]?.payment_id ?? null;

    // Step 9: Mark current row as paid (db_status = 'paid')
    await supabase
      .from("layaway_schedule")
      .update({ status: "paid" })
      .eq("id", schedule_row_id);

    // Step 10: Set carried_amount on next row
    await supabase
      .from("layaway_schedule")
      .update({
        carried_amount: shortfall,
        carried_from_schedule_id: schedule_row_id,
        carried_by_payment_id: carriedByPaymentId,
      })
      .eq("id", nextRow.id);

    // Step 11: Audit log
    await supabase.from("schedule_audit_log").insert({
      account_id,
      schedule_id: schedule_row_id,
      admin_user_id: user.id,
      action: "accept_carry_over",
      field_changed: "carried_amount",
      old_value: "0",
      new_value: String(shortfall),
      reason: reason.trim(),
    });

    // Legacy audit_logs entry for backward compat
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_schedule",
      entity_id: account_id,
      action: "accept_carry_over",
      old_value_json: {
        schedule_row_id,
        status: schedRow.status,
        paid_amount: schedRow.paid_amount,
        shortfall,
      },
      new_value_json: {
        current_row_status: "paid",
        next_row_id: nextRow.id,
        next_row_installment: nextRow.installment_number,
        carried_amount: shortfall,
        carried_by_payment_id: carriedByPaymentId,
        reason: reason.trim(),
        note: "carried_amount set on next row — total_due_amount unchanged",
      },
      performed_by_user_id: user.id,
    });

    // Step 12: Reconcile
    await callReconcile(account_id);

    return new Response(JSON.stringify({
      success: true,
      current_row_id: schedule_row_id,
      current_row_now: "paid",
      shortfall,
      next_row_id: nextRow.id,
      next_row_installment: nextRow.installment_number,
      next_row_new_ceiling: Math.round((Number(nextRow.base_installment_amount ?? 0) + shortfall) * 100) / 100,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
