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
      .select("id, account_id, installment_number, base_installment_amount, penalty_amount, carried_amount, status")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();

    if (srcErr || !source) return new Response(JSON.stringify({ error: "Source row not found" }), { status: 404, headers: corsHeaders });
    if (source.status !== "partially_paid") return new Response(JSON.stringify({ error: "Source row is not partially_paid" }), { status: 400, headers: corsHeaders });

    const { data: alloc } = await supabase
      .from("payment_allocations")
      .select("allocated_amount")
      .eq("schedule_id", schedule_row_id);

    const allocated = (alloc || []).reduce((sum, r) => sum + Number(r.allocated_amount), 0);
    const shortfall = Number(source.base_installment_amount) + Number(source.penalty_amount || 0) + Number(source.carried_amount || 0) - allocated;

    if (shortfall <= 0) return new Response(JSON.stringify({ error: "No shortfall to carry" }), { status: 400, headers: corsHeaders });

    const { data: nextRow, error: nextErr } = await supabase
      .from("layaway_schedule")
      .select("id")
      .eq("account_id", account_id)
      .eq("installment_number", source.installment_number + 1)
      .not("status", "in", '("paid","cancelled")')
      .single();

    if (nextErr || !nextRow) return new Response(JSON.stringify({ error: "No eligible next row found" }), { status: 400, headers: corsHeaders });

    await supabase
      .from("layaway_schedule")
      .update({ status: "paid", updated_at: new Date().toISOString() })
      .eq("id", schedule_row_id);

    const { error: carryErr } = await supabase
      .from("layaway_schedule")
      .update({
        carried_amount: shortfall,
        carried_from_schedule_id: schedule_row_id,
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

    await supabase.from("audit_logs").insert({
      account_id,
      action: "carry_over",
      details: { source_row_id: schedule_row_id, next_row_id: nextRow.id, shortfall }
    });

    console.log(`carry-over: account=${account_id} source=${schedule_row_id} next=${nextRow.id} shortfall=${shortfall}`);
    return new Response(JSON.stringify({ success: true, shortfall, next_row_id: nextRow.id }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("carry-over error:", err);
    return new Response(JSON.stringify({ error: "Unexpected error" }), { status: 500, headers: corsHeaders });
  }
});
