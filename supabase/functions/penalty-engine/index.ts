import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Penalty Engine – Cha Jewels Alternating 14-Day Rule
 *
 * Penalty follows an alternating pattern from the due date:
 *   Due+7  → week1:1   (first penalty after 7-day grace)
 *   Due+14 → week2:1
 *   Due+1mo → week1:2
 *   Due+1mo+14d → week2:2
 *   Due+2mo → week1:3
 *   Due+2mo+14d → week2:3
 *   ... repeat until paid
 *
 * Each penalty event = PHP 500 / JPY 1,000
 * Cap per installment months 1-5: PHP 1,000 / JPY 2,000
 * Month 6+: uncapped (continues accumulating)
 */
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

    // ── Penalty amount configuration ──
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

    // Both week1 and week2 use the same amount: PHP 500, JPY 1000
    const getAmount = (currency: string, stage: string): number => {
      const key = `penalty_${currency.toLowerCase()}_${stage}`;
      return config[key] || (currency === "PHP" ? 500 : 1000);
    };

    const getPenaltyCap = (currency: string, installmentNumber: number, planMonths: number): number => {
      if (installmentNumber === planMonths) return currency === "PHP" ? 3000 : 6000;
      return currency === "PHP" ? 1000 : 2000;
    };

    // ── Fetch penalty cap overrides ──
    const { data: overrides } = await supabase
      .from("penalty_cap_overrides")
      .select("account_id, penalty_cap_amount, is_active")
      .eq("is_active", true);
    const overrideMap = new Map<string, number>();
    if (overrides) {
      for (const o of overrides) {
        overrideMap.set(o.account_id, Number(o.penalty_cap_amount));
      }
    }

    // ── Step 1: Fetch ALL overdue unpaid schedule items (paginated) ──
    let allOverdueItems: any[] = [];
    let page = 0;
    const pageSize = 500;
    while (true) {
      const { data: batch } = await supabase
        .from("layaway_schedule")
        .select("*, layaway_accounts!inner(id, currency, status, payment_plan_months)")
        .in("status", ["pending", "overdue", "partially_paid"])
        .lt("due_date", today)
        .in("layaway_accounts.status", ["active", "overdue", "extension_active"])
        .order("installment_number", { ascending: true })
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

    // ── Guard 1: Remove any items where paid_amount >= base_installment_amount ──
    // Even if status hasn't been updated to "paid", a fully-covered installment must never get a penalty
    allOverdueItems = allOverdueItems.filter(item => {
      return Number(item.paid_amount) < Number(item.base_installment_amount);
    });

    if (allOverdueItems.length === 0) {
      return new Response(JSON.stringify({ message: "No eligible overdue items (all fully paid)", penalties_created: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Guard 2: Cross-check payment_allocations for stale schedule rows ──
    // If schedule.paid_amount is stale but allocations show fully paid, skip the item.
    // This prevents false penalties when reconcile-account hasn't synced the row yet.
    const guardScheduleIds = allOverdueItems.map(i => i.id);
    let allAllocations: any[] = [];
    for (let i = 0; i < guardScheduleIds.length; i += 200) {
      const chunk = guardScheduleIds.slice(i, i + 200);
      const { data: allocBatch } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, payment_id")
        .in("schedule_id", chunk)
        .eq("allocation_type", "installment");
      if (allocBatch) allAllocations = allAllocations.concat(allocBatch);
    }

    // Also fetch non-voided payment IDs to exclude voided allocations
    const allocPaymentIds = [...new Set(allAllocations.map(a => a.payment_id))];
    const validAllocPaymentIds = new Set<string>();
    for (let i = 0; i < allocPaymentIds.length; i += 200) {
      const chunk = allocPaymentIds.slice(i, i + 200);
      const { data: payBatch } = await supabase
        .from("payments")
        .select("id")
        .in("id", chunk)
        .is("voided_at", null);
      if (payBatch) payBatch.forEach((p: any) => validAllocPaymentIds.add(p.id));
    }

    // Sum valid allocations per schedule_id
    const allocSumBySchedule = new Map<string, number>();
    for (const a of allAllocations) {
      if (!validAllocPaymentIds.has(a.payment_id)) continue;
      allocSumBySchedule.set(a.schedule_id, (allocSumBySchedule.get(a.schedule_id) || 0) + Number(a.allocated_amount));
    }

    const beforeGuard2Count = allOverdueItems.length;
    allOverdueItems = allOverdueItems.filter(item => {
      const allocSum = allocSumBySchedule.get(item.id) || 0;
      return allocSum < Number(item.base_installment_amount) - 0.01;
    });
    const guard2Skipped = beforeGuard2Count - allOverdueItems.length;
    if (guard2Skipped > 0) {
      console.log(`Guard 2 skipped ${guard2Skipped} item(s) with stale schedule.paid_amount — covered by allocations`);
    }

    if (allOverdueItems.length === 0) {
      return new Response(JSON.stringify({
        message: "No eligible overdue items (all covered by allocations)",
        penalties_created: 0,
        guard2_skipped: guard2Skipped,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 2: Batch-fetch existing penalties ──
    const scheduleIds = allOverdueItems.map(i => i.id);
    let allExistingPenalties: any[] = [];
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
    const currentPenaltyTotals = new Map<string, number>();
    for (const p of allExistingPenalties) {
      const key = `${p.penalty_stage}:${p.penalty_cycle}`;
      if (!existingPenaltyMap.has(p.schedule_id)) existingPenaltyMap.set(p.schedule_id, new Set());
      existingPenaltyMap.get(p.schedule_id)!.add(key);
      if (p.status === "unpaid" || p.status === "paid") {
        currentPenaltyTotals.set(p.schedule_id, (currentPenaltyTotals.get(p.schedule_id) || 0) + Number(p.penalty_amount));
      }
    }

    // ── Step 3: Determine which penalties to create ──
    const penaltiesToInsert: any[] = [];
    const scheduleUpdates = new Map<string, { totalPenalty: number; baseAmount: number; accountId: string }>();
    const accountsToMarkOverdue = new Set<string>();

    // ── Freeze guard: batch-fetch accounts with pending payment submissions ──
    // An account with a pending submission is frozen — no new penalties until resolved.
    const uniqueAccountIds = [...new Set(allOverdueItems.map((i: any) => i.layaway_accounts.id))];
    const frozenAccountIds = new Set<string>();
    for (let i = 0; i < uniqueAccountIds.length; i += 200) {
      const chunk = uniqueAccountIds.slice(i, i + 200);
      const { data: frozenRows } = await supabase
        .from("payment_submissions")
        .select("account_id")
        .in("account_id", chunk)
        .in("status", ["submitted", "under_review"]);
      if (frozenRows) frozenRows.forEach((r: any) => frozenAccountIds.add(r.account_id));
    }
    if (frozenAccountIds.size > 0) {
      console.log(`[penalty-engine] ${frozenAccountIds.size} account(s) frozen due to pending submissions — skipped`);
    }

    for (const item of allOverdueItems) {
      const dueDate = new Date(item.due_date + "T00:00:00Z");
      const currency = (item as any).layaway_accounts.currency;
      const accountId = (item as any).layaway_accounts.id;
      const planMonths = (item as any).layaway_accounts.payment_plan_months || 6;
      const installmentNumber = item.installment_number;
      const existingKeys = existingPenaltyMap.get(item.id) || new Set();
      const dueDayOfMonth = dueDate.getUTCDate();

      // Skip this item if the account has a pending submission
      if (frozenAccountIds.has(accountId)) continue;

      const currentTotal = currentPenaltyTotals.get(item.id) || 0;
      const overrideCap = overrideMap.get(accountId);
      const cap = overrideCap !== undefined
        ? (installmentNumber >= planMonths ? (currency === "PHP" ? 3000 : 6000) : overrideCap)
        : getPenaltyCap(currency, installmentNumber, planMonths);

      if (currentTotal >= cap) continue;

      // Build trigger dates using the alternating pattern
      const triggerDates: Array<{ date: Date; stage: "week1" | "week2"; cycle: number }> = [];

      // Phase 1: due + 7 → week1:1
      const phase1Date = new Date(dueDate);
      phase1Date.setUTCDate(phase1Date.getUTCDate() + 7);
      triggerDates.push({ date: phase1Date, stage: "week1", cycle: 1 });

      // Phase 2: due + 14 → week2:1
      const phase2Date = new Date(dueDate);
      phase2Date.setUTCDate(phase2Date.getUTCDate() + 14);
      triggerDates.push({ date: phase2Date, stage: "week2", cycle: 1 });

      // Phase 3+: alternating monthly checkpoint + 14 days
      for (let m = 1; m <= 12; m++) {
        const monthlyDate = new Date(Date.UTC(
          dueDate.getUTCFullYear(),
          dueDate.getUTCMonth() + m,
          Math.min(dueDayOfMonth, daysInMonth(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + m))
        ));
        triggerDates.push({ date: monthlyDate, stage: "week1", cycle: m + 1 });

        const plus14Date = new Date(monthlyDate);
        plus14Date.setUTCDate(plus14Date.getUTCDate() + 14);
        triggerDates.push({ date: plus14Date, stage: "week2", cycle: m + 1 });
      }

      let newPenaltyForItem = 0;

      for (const trigger of triggerDates) {
        if (now < trigger.date) break;

        const key = `${trigger.stage}:${trigger.cycle}`;
        if (existingKeys.has(key)) continue;

        let penaltyAmount = getAmount(currency, trigger.stage);

        // Enforce cap
        const projectedTotal = currentTotal + newPenaltyForItem + penaltyAmount;
        if (projectedTotal > cap) {
          penaltyAmount = Math.max(0, cap - currentTotal - newPenaltyForItem);
          if (penaltyAmount <= 0) break;
        }

        const penaltyDate = trigger.date.toISOString().split("T")[0];

        penaltiesToInsert.push({
          account_id: accountId,
          schedule_id: item.id,
          currency,
          penalty_amount: penaltyAmount,
          penalty_stage: trigger.stage,
          penalty_cycle: trigger.cycle,
          penalty_date: penaltyDate,
        });
        existingKeys.add(key);
        newPenaltyForItem += penaltyAmount;
      }

      if (newPenaltyForItem > 0) {
        const totalPenalty = currentTotal + newPenaltyForItem;
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
      for (let i = 0; i < penaltiesToInsert.length; i += 100) {
        const chunk = penaltiesToInsert.slice(i, i + 100);
        const { error } = await supabase.from("penalty_fees").insert(chunk);
        if (!error) penaltiesCreated += chunk.length;
        else console.error("Penalty insert error:", error);
      }
    }

    // ── Step 5: Update schedule items ──
    for (const [schedId, info] of scheduleUpdates) {
      await supabase.from("layaway_schedule").update({
        penalty_amount: info.totalPenalty,
        total_due_amount: info.baseAmount,
        status: "overdue",
      }).eq("id", schedId);
    }

    // ── Step 6: Mark accounts as overdue ──
    for (const accountId of accountsToMarkOverdue) {
      await supabase.from("layaway_accounts")
        .update({ status: "overdue" })
        .eq("id", accountId)
        .not("status", "eq", "extension_active");
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
          penalty_date: p.penalty_date,
        },
      }));
      for (let i = 0; i < auditEntries.length; i += 100) {
        await supabase.from("audit_logs").insert(auditEntries.slice(i, i + 100));
      }
    }

    // ── Step 8: Update remaining_balance for affected accounts ──
    // Use canonical formula: total_amount + Σ(non-waived penalties) + Σ(services) − Σ(payments)
    for (const accountId of accountsToMarkOverdue) {
      const [{ data: accTotals }, { data: allActivePens }, { data: allSvcs }, { data: allPays }] = await Promise.all([
        supabase.from("layaway_accounts").select("total_amount").eq("id", accountId).single(),
        supabase.from("penalty_fees").select("penalty_amount").eq("account_id", accountId).not("status", "eq", "waived"),
        supabase.from("account_services").select("amount").eq("account_id", accountId),
        supabase.from("payments").select("amount_paid").eq("account_id", accountId).is("voided_at", null),
      ]);

      if (accTotals) {
        const penSum  = (allActivePens || []).reduce((s: number, p: any)  => s + Number(p.penalty_amount), 0);
        const svcSum  = (allSvcs       || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);
        const paidSum = (allPays       || []).reduce((s: number, p: any)  => s + Number(p.amount_paid), 0);
        const newRemaining = Math.max(0, Number(accTotals.total_amount) + penSum + svcSum - paidSum);
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

/** Helper: days in a given month (0-indexed month, handles year rollover) */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
