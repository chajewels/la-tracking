import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Permission gate (Bug #201 Batch B: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "confirm_payment");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "confirm_payment permission required" }), {
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

    // Fetch the current row for audit context
    const { data: schedRow, error: schedErr } = await supabase
      .from("layaway_schedule")
      .select("id, account_id, installment_number, due_date, status, base_installment_amount, penalty_amount, paid_amount, total_due_amount, carried_amount")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();

    if (schedErr || !schedRow) {
      return new Response(JSON.stringify({ error: "Schedule row not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (schedRow.status !== "partially_paid") {
      return new Response(JSON.stringify({
        error: `Row must be partially_paid, got: ${schedRow.status}`
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const shortfall = Math.round(Math.max(0,
      Number(schedRow.base_installment_amount)
      + Number(schedRow.penalty_amount ?? 0)
      + Number(schedRow.carried_amount ?? 0)
      - Number(schedRow.paid_amount)
    ) * 100) / 100;

    // AUDIT LOG ONLY — zero row changes per CLAUDE.md:
    // "accept-underpayment: Records AUDIT LOG only when staff acknowledges
    //  an underpayment. Does NOT write carried_amount, does NOT mark source
    //  row as paid, does NOT touch next row. Net DB effect: Zero row changes."
    // Actual carry-over is handled exclusively by the carry-over edge function.

    await supabase.from("schedule_audit_log").insert({
      account_id,
      schedule_id: schedule_row_id,
      admin_user_id: user.id,
      action: "accept_underpayment",
      field_changed: "acknowledgement",
      old_value: String(schedRow.paid_amount),
      new_value: String(shortfall),
      reason: reason.trim(),
    });

    await supabase.from("audit_logs").insert({
      entity_type: "layaway_schedule",
      entity_id: account_id,
      action: "accept_underpayment",
      old_value_json: {
        schedule_row_id,
        installment_number: schedRow.installment_number,
        status: schedRow.status,
        paid_amount: schedRow.paid_amount,
        shortfall,
      },
      new_value_json: {
        action: "audit_log_only",
        reason: reason.trim(),
        note: "Underpayment acknowledged — no schedule rows modified. Use carry-over to close the row.",
      },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({
      success: true,
      schedule_row_id,
      shortfall,
      note: "Underpayment acknowledged. Use Carry Over to close this row and move shortfall to the next month.",
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
