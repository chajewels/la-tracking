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

    const now = new Date();
    const today = now.toISOString().split("T")[0];

    // Get penalty configuration
    const { data: settings } = await supabase
      .from("system_settings")
      .select("key, value")
      .in("key", ["penalty_php_week1", "penalty_php_week2", "penalty_jpy_week1", "penalty_jpy_week2"]);

    const config: Record<string, number> = {};
    if (settings) {
      for (const s of settings) {
        config[s.key] = Number(JSON.parse(String(s.value)));
      }
    }

    const getAmount = (currency: string, stage: string): number => {
      const key = `penalty_${currency.toLowerCase()}_${stage}`;
      return config[key] || (currency === "PHP" ? (stage === "week1" ? 500 : 1000) : (stage === "week1" ? 1000 : 2000));
    };

    // Find overdue unpaid schedule items
    const { data: overdueItems } = await supabase
      .from("layaway_schedule")
      .select("*, layaway_accounts!inner(id, currency, status)")
      .in("status", ["pending", "overdue", "partially_paid"])
      .lt("due_date", today)
      .in("layaway_accounts.status", ["active", "overdue"]);

    if (!overdueItems || overdueItems.length === 0) {
      return new Response(JSON.stringify({ message: "No overdue items found", penalties_created: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let penaltiesCreated = 0;

    for (const item of overdueItems) {
      const dueDate = new Date(item.due_date);
      const diffDays = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      const currency = (item as any).layaway_accounts.currency;
      const accountId = (item as any).layaway_accounts.id;

      // Calculate penalty cycle (each month is a new cycle)
      const cycle = Math.floor(diffDays / 30) + 1;

      // Check which penalties to create
      const stages: Array<{ stage: "week1" | "week2"; triggerDays: number }> = [
        { stage: "week1", triggerDays: 7 },
        { stage: "week2", triggerDays: 14 },
      ];

      for (const { stage, triggerDays } of stages) {
        const cycleStartDay = (cycle - 1) * 30;
        if (diffDays >= cycleStartDay + triggerDays) {
          // Check if penalty already exists for this stage+cycle
          const { data: existing } = await supabase
            .from("penalty_fees")
            .select("id")
            .eq("schedule_id", item.id)
            .eq("penalty_stage", stage)
            .eq("penalty_cycle", cycle)
            .maybeSingle();

          if (!existing) {
            const penaltyAmount = getAmount(currency, stage);

            const { error: penErr } = await supabase.from("penalty_fees").insert({
              account_id: accountId,
              schedule_id: item.id,
              currency,
              penalty_amount: penaltyAmount,
              penalty_stage: stage,
              penalty_cycle: cycle,
              penalty_date: today,
            });

            if (!penErr) {
              penaltiesCreated++;

              // Update schedule penalty_amount and total_due
              const { data: allPenalties } = await supabase
                .from("penalty_fees")
                .select("penalty_amount")
                .eq("schedule_id", item.id)
                .eq("status", "unpaid");

              const totalPenalty = (allPenalties || []).reduce(
                (sum, p) => sum + Number(p.penalty_amount), 0
              );

              await supabase.from("layaway_schedule").update({
                penalty_amount: totalPenalty,
                total_due_amount: Number(item.base_installment_amount) + totalPenalty,
                status: "overdue",
              }).eq("id", item.id);

              // Mark account as overdue
              await supabase.from("layaway_accounts")
                .update({ status: "overdue" })
                .eq("id", accountId);

              // Audit log
              await supabase.from("audit_logs").insert({
                entity_type: "penalty_fee",
                entity_id: item.id,
                action: "auto_penalty",
                new_value_json: { stage, cycle, amount: penaltyAmount, currency },
              });
            }
          }
        }
      }
    }

    return new Response(JSON.stringify({
      message: "Penalty engine completed",
      penalties_created: penaltiesCreated,
      items_checked: overdueItems.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
