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

    // Penalty cap: months 1-5 max PHP 1000 / JPY 2000
    const getPenaltyCap = (currency: string, installmentNumber: number): number => {
      if (installmentNumber >= 6) return Infinity;
      return currency === "PHP" ? 1000 : 2000;
    };

    // ── Step 1: Fetch ALL overdue unpaid schedule items in one query ──
    // Paginate to handle >1000 rows
    let allOverdueItems: any[] = [];
    let page = 0;
    const pageSize = 500;
    while (true) {
      const { data: batch } = await supabase
        .from("layaway_schedule")
        .select("*, layaway_accounts!inner(id, currency, status)")
        .in("status", ["pending", "overdue", "partially_paid"])
        .lt("due_date", today)
        .in("layaway_accounts.status", ["active", "overdue"])
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (!batch || batch.length === 0) break;
      allOverdueItems = allOverdueItems.concat(batch);
      if (batch.length < pageSize) break;
      page++;
    }

    if (allOverdueItems.length === 0) {
      return new Response(JSON.stringify({ message: "No overdue items found", penalties_created: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 2: Batch-fetch ALL existing penalties for these schedule items ──
    const scheduleIds = allOverdueItems.map(i => i.id);
    let allExistingPenalties: any[] = [];
    // Fetch in chunks of 200 to avoid URL length limits
    for (let i = 0; i < scheduleIds.length; i += 200) {
      const chunk = scheduleIds.slice(i, i + 200);
      const { data: penBatch } = await supabase
        .from("penalty_fees")
        .select("id, schedule_id, penalty_stage, penalty_cycle, penalty_amount, status")
        .in("schedule_id", chunk);
      if (penBatch) allExistingPenalties = allExistingPenalties.concat(penBatch);
    }

    // Build lookup: schedule_id -> Set of "stage:cycle" keys
    const existingPenaltyMap = new Map<string, Set<string>>();
    const unpaidPenaltyTotals = new Map<string, number>();
    for (const p of allExistingPenalties) {
      const key = `${p.penalty_stage}:${p.penalty_cycle}`;
      if (!existingPenaltyMap.has(p.schedule_id)) existingPenaltyMap.set(p.schedule_id, new Set());
      existingPenaltyMap.get(p.schedule_id)!.add(key);
      if (p.status === "unpaid") {
        unpaidPenaltyTotals.set(p.schedule_id, (unpaidPenaltyTotals.get(p.schedule_id) || 0) + Number(p.penalty_amount));
      }
    }

    // ── Step 3: Determine which penalties to create ──
    const penaltiesToInsert: any[] = [];
    const scheduleUpdates = new Map<string, { totalPenalty: number; baseAmount: number; accountId: string }>();
    const accountsToMarkOverdue = new Set<string>();

    for (const item of allOverdueItems) {
      const dueDate = new Date(item.due_date + "T00:00:00Z");
      const diffDays = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
      const currency = (item as any).layaway_accounts.currency;
      const accountId = (item as any).layaway_accounts.id;
      const existingKeys = existingPenaltyMap.get(item.id) || new Set();

      const cycle = Math.floor(diffDays / 30) + 1;
      const stages: Array<{ stage: "week1" | "week2"; triggerDays: number }> = [
        { stage: "week1", triggerDays: 7 },
        { stage: "week2", triggerDays: 14 },
      ];

      let newPenaltyForItem = 0;

      for (const { stage, triggerDays } of stages) {
        const cycleStartDay = (cycle - 1) * 30;
        if (diffDays >= cycleStartDay + triggerDays) {
          const key = `${stage}:${cycle}`;
          if (!existingKeys.has(key)) {
            const penaltyAmount = getAmount(currency, stage);
            penaltiesToInsert.push({
              account_id: accountId,
              schedule_id: item.id,
              currency,
              penalty_amount: penaltyAmount,
              penalty_stage: stage,
              penalty_cycle: cycle,
              penalty_date: today,
            });
            existingKeys.add(key); // prevent duplicates within same run
            newPenaltyForItem += penaltyAmount;
          }
        }
      }

      if (newPenaltyForItem > 0) {
        const existingUnpaid = unpaidPenaltyTotals.get(item.id) || 0;
        const totalPenalty = existingUnpaid + newPenaltyForItem;
        scheduleUpdates.set(item.id, {
          totalPenalty,
          baseAmount: Number(item.base_installment_amount),
          accountId,
        });
        accountsToMarkOverdue.add(accountId);
      }
    }

    // ── Step 4: Batch insert penalties ──
    let penaltiesCreated = 0;
    if (penaltiesToInsert.length > 0) {
      // Insert in chunks of 100
      for (let i = 0; i < penaltiesToInsert.length; i += 100) {
        const chunk = penaltiesToInsert.slice(i, i + 100);
        const { error } = await supabase.from("penalty_fees").insert(chunk);
        if (!error) penaltiesCreated += chunk.length;
        else console.error("Penalty insert error:", error);
      }
    }

    // ── Step 5: Update schedule items with new penalty totals ──
    for (const [schedId, info] of scheduleUpdates) {
      await supabase.from("layaway_schedule").update({
        penalty_amount: info.totalPenalty,
        total_due_amount: info.baseAmount + info.totalPenalty,
        status: "overdue",
      }).eq("id", schedId);
    }

    // ── Step 6: Mark accounts as overdue ──
    for (const accountId of accountsToMarkOverdue) {
      await supabase.from("layaway_accounts")
        .update({ status: "overdue" })
        .eq("id", accountId);
    }

    // ── Step 7: Batch audit log ──
    if (penaltiesToInsert.length > 0) {
      const auditEntries = penaltiesToInsert.map(p => ({
        entity_type: "penalty_fee",
        entity_id: p.schedule_id,
        action: "auto_penalty",
        new_value_json: {
          stage: p.penalty_stage,
          cycle: p.penalty_cycle,
          amount: p.penalty_amount,
          currency: p.currency,
        },
      }));
      for (let i = 0; i < auditEntries.length; i += 100) {
        await supabase.from("audit_logs").insert(auditEntries.slice(i, i + 100));
      }
    }

    // ── Step 8: Update remaining_balance for affected accounts ──
    for (const accountId of accountsToMarkOverdue) {
      const { data: allSchedule } = await supabase
        .from("layaway_schedule")
        .select("total_due_amount, paid_amount, status")
        .eq("account_id", accountId);

      if (allSchedule) {
        const newRemaining = allSchedule.reduce((sum, s) => {
          if (s.status === "paid" || s.status === "cancelled") return sum;
          return sum + Math.max(0, Number(s.total_due_amount) - Number(s.paid_amount));
        }, 0);
        await supabase.from("layaway_accounts")
          .update({ remaining_balance: newRemaining })
          .eq("id", accountId);
      }
    }

    return new Response(JSON.stringify({
      message: "Penalty engine completed",
      penalties_created: penaltiesCreated,
      items_checked: allOverdueItems.length,
      accounts_affected: accountsToMarkOverdue.size,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Penalty engine error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
