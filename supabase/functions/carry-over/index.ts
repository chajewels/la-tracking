import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { schedule_row_id, account_id } = await req.json();

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: source, error: srcErr } = await supabase
      .from("layaway_schedule")
      .select("id, account_id, installment_number, base_installment_amount, penalty_amount, carried_amount, paid_amount, status")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();

    if (srcErr || !source) return new Response(JSON.stringify({ error: "Source row not found" }), { status: 404, headers: corsHeaders });
    if (source.status !== "partially_paid") return new Response(JSON.stringify({ error: "Source row is not partially_paid" }), { status: 400, headers: corsHeaders });
    if (!Number(source.paid_amount)) return new Response(JSON.stringify({ error: "Source row has no paid amount — nothing to carry over" }), { status: 400, headers: corsHeaders });

    // Use paid_amount from the schedule row as the authoritative source for how much was paid
    const paidOnRow = Number(source.paid_amount);
    const ceiling = Number(source.base_installment_amount) + Number(source.penalty_amount || 0) + Number(source.carried_amount || 0);
    const shortfall = Math.round((ceiling - paidOnRow) * 100) / 100;

    if (shortfall <= 0) return new Response(JSON.stringify({ error: "No shortfall to carry" }), { status: 400, headers: corsHeaders });

    const { data: nextRow, error: nextErr } = await supabase
      .from("layaway_schedule")
      .select("id, carried_amount")
      .eq("account_id", account_id)
      .gt("installment_number", source.installment_number)
      .not("status", "in", '("paid","cancelled")')
      .order("installment_number", { ascending: true })
      .limit(1)
      .single();

    if (nextErr || !nextRow) return new Response(JSON.stringify({ error: "No eligible next row found" }), { status: 400, headers: corsHeaders });

    // Guard against overwriting an existing carried_amount on the next row.
    // Health Check 21 flags accounts with multiple carried rows — this prevents
    // silently nuking a prior carry with a new one.
    if (Number(nextRow.carried_amount) > 0) {
      return new Response(
        JSON.stringify({
          error: "Next row already has a carried amount. Clear it first before applying carry-over."
        }),
        { status: 400, headers: corsHeaders }
      );
    }

    await supabase
      .from("layaway_schedule")
      .update({ status: "paid", paid_amount: paidOnRow, updated_at: new Date().toISOString() })
      .eq("id", schedule_row_id);

    const { error: carryErr } = await supabase
      .from("layaway_schedule")
      .update({
        carried_amount: shortfall,
        carried_from_schedule_id: schedule_row_id,
        carried_by_payment_id: null,
        updated_at: new Date().toISOString()
      })
      .eq("id", nextRow.id);

    if (carryErr) {
      await supabase
        .from("layaway_schedule")
        .update({ status: "partially_paid", updated_at: new Date().toISOString() })
        .eq("id", schedule_row_id);
      return new Response(JSON.stringify({ error: "Failed to write carry, reverted" }), { status: 500, headers: corsHeaders });
    }

    // Recompute account.status after the source row transitioned to 'paid'.
    // If there are no more overdue rows, an account previously marked 'overdue'
    // should flip back to 'active'. (total_paid and remaining_balance do not change
    // from a carry-over — no money moved — so they are not touched here.)
    const { data: schedRows } = await supabase
      .from("layaway_schedule")
      .select("status, due_date")
      .eq("account_id", account_id)
      .neq("status", "cancelled");

    const today = new Date().toISOString().split("T")[0];
    const hasOverdue = (schedRows || []).some(
      (r: any) => r.status === "overdue" ||
        (r.status !== "paid" && r.due_date < today)
    );

    const { data: acct } = await supabase
      .from("layaway_accounts")
      .select("status")
      .eq("id", account_id)
      .single();

    if (acct && acct.status === "overdue" && !hasOverdue) {
      await supabase
        .from("layaway_accounts")
        .update({ status: "active" })
        .eq("id", account_id);
    }

    await supabase.from("audit_logs").insert({
      entity_id: account_id,
      entity_type: "layaway_account",
      action: "carry_over",
      old_value_json: { source_row_id: schedule_row_id, status: "partially_paid" },
      new_value_json: { next_row_id: nextRow.id, carried_amount: shortfall }
    });

    console.log(`carry-over: account=${account_id} source=${schedule_row_id} next=${nextRow.id} shortfall=${shortfall}`);
    return new Response(JSON.stringify({ success: true, shortfall, next_row_id: nextRow.id }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("carry-over error:", err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), { status: 500, headers: corsHeaders });
  }
});
