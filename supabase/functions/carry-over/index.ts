import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const { schedule_row_id, account_id } = await req.json();

    if (!schedule_row_id || !account_id) {
      return new Response(
        JSON.stringify({ error: "schedule_row_id and account_id are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 1: Fetch source row ──────────────────────────────────────────────
    const { data: sourceRow, error: sourceErr } = await supabase
      .from("layaway_schedule")
      .select("id, account_id, installment_number, base_installment_amount, penalty_amount, carried_amount, status")
      .eq("id", schedule_row_id)
      .eq("account_id", account_id)
      .single();

    if (sourceErr || !sourceRow) {
      return new Response(
        JSON.stringify({ error: "Schedule row not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (sourceRow.status !== "partially_paid") {
      return new Response(
        JSON.stringify({ error: `Source row must be partially_paid, got: ${sourceRow.status}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 2: Calculate shortfall via payment_allocations ──────────────────
    const { data: allocRows, error: allocErr } = await supabase
      .from("payment_allocations")
      .select("allocated_amount")
      .eq("schedule_id", schedule_row_id);

    if (allocErr) {
      throw new Error(`Failed to fetch payment allocations: ${allocErr.message}`);
    }

    const allocated = (allocRows ?? []).reduce(
      (sum, r) => sum + Number(r.allocated_amount ?? 0),
      0
    );

    const shortfall = Math.round(
      Math.max(
        0,
        Number(sourceRow.base_installment_amount) +
          Number(sourceRow.penalty_amount ?? 0) +
          Number(sourceRow.carried_amount ?? 0) -
          allocated
      ) * 100
    ) / 100;

    if (shortfall <= 0) {
      return new Response(
        JSON.stringify({ error: "No shortfall to carry — row is fully paid" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 3: Fetch next row ────────────────────────────────────────────────
    const { data: nextRows, error: nextErr } = await supabase
      .from("layaway_schedule")
      .select("id, installment_number, status")
      .eq("account_id", account_id)
      .eq("installment_number", sourceRow.installment_number + 1)
      .not("status", "in", '("paid","cancelled")')
      .limit(1);

    if (nextErr) {
      throw new Error(`Failed to fetch next installment row: ${nextErr.message}`);
    }

    if (!nextRows || nextRows.length === 0) {
      return new Response(
        JSON.stringify({
          error: `No eligible next installment found after month ${sourceRow.installment_number}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const nextRow = nextRows[0];

    // ── Step 4: Mark source row as paid ───────────────────────────────────────
    const { error: sourceUpdateErr } = await supabase
      .from("layaway_schedule")
      .update({ status: "paid", updated_at: new Date().toISOString() })
      .eq("id", schedule_row_id);

    if (sourceUpdateErr) {
      throw new Error(`Failed to mark source row as paid: ${sourceUpdateErr.message}`);
    }

    // ── Step 5: Write carry to next row (revert step 4 on failure) ────────────
    const { error: nextUpdateErr } = await supabase
      .from("layaway_schedule")
      .update({
        carried_amount: shortfall,
        carried_from_schedule_id: schedule_row_id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", nextRow.id);

    if (nextUpdateErr) {
      // Revert source row back to partially_paid
      await supabase
        .from("layaway_schedule")
        .update({ status: "partially_paid", updated_at: new Date().toISOString() })
        .eq("id", schedule_row_id);

      throw new Error(`Failed to write carry to next row: ${nextUpdateErr.message}`);
    }

    // ── Step 6: Reconcile ─────────────────────────────────────────────────────
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/reconcile-account`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ account_id }),
        }
      );
    } catch (reconcileErr) {
      console.warn(`[carry-over] reconcile-account call failed for ${account_id}:`, reconcileErr);
    }

    console.log(
      `[carry-over] account ${account_id}: ` +
      `row ${schedule_row_id} → paid, shortfall ₱${shortfall} carried to row ${nextRow.id}`
    );

    return new Response(
      JSON.stringify({ success: true, shortfall, next_row_id: nextRow.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[carry-over] error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
