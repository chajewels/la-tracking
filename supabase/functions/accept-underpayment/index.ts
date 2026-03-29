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

    // Step 9: Audit log — record that staff accepted the underpayment.
    // Current row stays partially_paid. Next row is NOT touched.
    // Carry-over to the next month is a separate manual staff action.
    await supabase.from("schedule_audit_log").insert({
      account_id,
      schedule_id: schedule_row_id,
      admin_user_id: user.id,
      action: "accept_underpayment",
      field_changed: "status",
      old_value: "partially_paid",
      new_value: "partially_paid",
      reason: reason.trim(),
    });

    // Legacy audit_logs entry for backward compat
    await supabase.from("audit_logs").insert({
      entity_type: "layaway_schedule",
      entity_id: account_id,
      action: "accept_underpayment",
      old_value_json: {
        schedule_row_id,
        status: schedRow.status,
        paid_amount: schedRow.paid_amount,
        shortfall,
      },
      new_value_json: {
        current_row_status: "partially_paid",
        shortfall,
        next_row_id: nextRow.id,
        next_row_installment: nextRow.installment_number,
        reason: reason.trim(),
        note: "shortfall remains on current row — next row untouched",
      },
      performed_by_user_id: user.id,
    });

    // Step 10: Reconcile
    await callReconcile(account_id);

    // ── One-time cleanup: clear any invalid carries on this account ──
    // A carry is invalid if its source row (carried_from_schedule_id) is still
    // partially_paid — meaning the carry was written before the source was paid.
    try {
      const { data: carriedRows } = await supabase
        .from("layaway_schedule")
        .select("id, carried_from_schedule_id")
        .eq("account_id", account_id)
        .gt("carried_amount", 0);

      for (const row of (carriedRows || [])) {
        if (!row.carried_from_schedule_id) continue;
        const { data: sourceRow } = await supabase
          .from("layaway_schedule")
          .select("status")
          .eq("id", row.carried_from_schedule_id)
          .single();
        if (sourceRow?.status === "partially_paid") {
          await supabase
            .from("layaway_schedule")
            .update({
              carried_amount: 0,
              carried_from_schedule_id: null,
              carried_by_payment_id: null,
            })
            .eq("id", row.id);
          console.log(`[accept-underpayment] cleared invalid carry on row ${row.id} (source still partially_paid)`);
        }
      }
    } catch (cleanupErr) {
      console.warn("[accept-underpayment] cleanup pass failed (non-fatal):", cleanupErr);
    }

    return new Response(JSON.stringify({
      success: true,
      current_row_id: schedule_row_id,
      current_row_status: "partially_paid",
      shortfall,
      next_row_id: nextRow.id,
      next_row_installment: nextRow.installment_number,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
