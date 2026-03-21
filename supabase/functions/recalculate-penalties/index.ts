import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * FULL system-wide penalty recalculation.
 *
 * Cha Jewels Alternating 14-day Rule:
 *   Due+7  → week1:1   (first penalty, grace period)
 *   Due+14 → week2:1
 *   Due+1mo → week1:2
 *   Due+1mo+14d → week2:2
 *   Due+2mo → week1:3
 *   Due+2mo+14d → week2:3
 *   ... repeat until paid
 *
 * Each penalty = PHP 500 / JPY 1,000
 * Cap per installment months 1-5: PHP 1,000 / JPY 2,000
 * Month 6+: uncapped
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchOffset = body.offset ?? 0;
    const batchLimit = body.limit ?? 100;
    const targetInvoice = body.invoice_number ?? null;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const now = new Date();
    const today = now.toISOString().split("T")[0];

    // ── Config ──
    const { data: settings } = await supabase
      .from("system_settings")
      .select("key, value")
      .in("key", ["penalty_php_week1", "penalty_php_week2", "penalty_jpy_week1", "penalty_jpy_week2"]);

    const config: Record<string, number> = {};
    if (settings) {
      for (const s of settings) config[s.key] = Number(JSON.parse(String(s.value)));
    }

    const getAmount = (currency: string, stage: string): number => {
      const key = `penalty_${currency.toLowerCase()}_${stage}`;
      // Both week1 and week2 are the same amount: PHP 500, JPY 1000
      return config[key] || (currency === "PHP" ? 500 : 1000);
    };

    const getCap = (currency: string, instNum: number): number => {
      if (instNum >= 6) return Infinity;
      return currency === "PHP" ? 1000 : 2000;
    };

    // ── Fetch penalty cap overrides ──
    const { data: overrides } = await supabase
      .from("penalty_cap_overrides")
      .select("account_id, penalty_cap_amount, is_active")
      .eq("is_active", true);
    const overrideMap = new Map<string, number>();
    if (overrides) {
      for (const o of overrides) overrideMap.set(o.account_id, Number(o.penalty_cap_amount));
    }

    // ── Fetch schedule items (with optional invoice filter and batching) ──
    // First get the target account IDs
    let targetAccountIds: string[] = [];
    if (targetInvoice) {
      const { data: accts } = await supabase
        .from("layaway_accounts")
        .select("id")
        .eq("invoice_number", targetInvoice);
      targetAccountIds = (accts || []).map((a: any) => a.id);
    } else {
      // Get all active/overdue account IDs with batching
      const { data: accts } = await supabase
        .from("layaway_accounts")
        .select("id")
        .in("status", ["active", "overdue"])
        .order("invoice_number")
        .range(batchOffset, batchOffset + batchLimit - 1);
      targetAccountIds = (accts || []).map((a: any) => a.id);
    }

    if (targetAccountIds.length === 0) {
      return new Response(JSON.stringify({ message: "No accounts to process", changes: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let allItems: any[] = [];
    for (let i = 0; i < targetAccountIds.length; i += 50) {
      const chunk = targetAccountIds.slice(i, i + 50);
      const { data: batch } = await supabase
        .from("layaway_schedule")
        .select("*, layaway_accounts!inner(id, currency, status, total_paid, downpayment_amount, total_amount, invoice_number)")
        .in("account_id", chunk)
        .order("installment_number", { ascending: true });
      if (batch) allItems = allItems.concat(batch);
    }

    // Group by account
    const accountSchedules = new Map<string, any[]>();
    for (const item of allItems) {
      const accId = item.account_id;
      if (!accountSchedules.has(accId)) accountSchedules.set(accId, []);
      accountSchedules.get(accId)!.push(item);
    }

    // ── Fetch ALL existing penalty_fees ──
    const accountIds = [...accountSchedules.keys()];
    let allPenaltyFees: any[] = [];
    for (let i = 0; i < accountIds.length; i += 200) {
      const chunk = accountIds.slice(i, i + 200);
      const { data: pBatch } = await supabase
        .from("penalty_fees")
        .select("*")
        .in("account_id", chunk);
      if (pBatch) allPenaltyFees = allPenaltyFees.concat(pBatch);
    }

    // Group penalty_fees by schedule_id
    const penaltyFeesBySchedule = new Map<string, any[]>();
    for (const pf of allPenaltyFees) {
      if (!penaltyFeesBySchedule.has(pf.schedule_id)) penaltyFeesBySchedule.set(pf.schedule_id, []);
      penaltyFeesBySchedule.get(pf.schedule_id)!.push(pf);
    }

    const report: any[] = [];
    const scheduleUpdates: Array<{ id: string; penalty_amount: number; total_due_amount: number; status: string }> = [];
    const penaltyFeesToInsert: any[] = [];
    const penaltyFeeIdsToWaive: string[] = [];
    const penaltyFeesToUpdate: Array<{ id: string; penalty_amount: number; penalty_date: string; status: string }> = [];
    const accountUpdates = new Map<string, { total_amount: number; remaining_balance: number; status: string }>();

    // ── Process each account ──
    for (const [accountId, schedItems] of accountSchedules) {
      const acct = schedItems[0].layaway_accounts;
      const currency = acct.currency;
      const invoiceNumber = acct.invoice_number;
      const totalPaid = Number(acct.total_paid);

      let totalSchedulePenaltyBefore = 0;
      let totalSchedulePenaltyAfter = 0;
      let anyChange = false;
      let hasOverdue = false;

      for (const item of schedItems) {
        const oldPenalty = Number(item.penalty_amount);
        totalSchedulePenaltyBefore += oldPenalty;
        const baseAmount = Number(item.base_installment_amount);
        const instNum = item.installment_number;
        const dueDate = new Date(item.due_date + "T00:00:00Z");

        // Cancelled items: skip
        if (item.status === "cancelled") {
          totalSchedulePenaltyAfter += oldPenalty;
          continue;
        }

        // Items not yet due: no penalty
        if (item.due_date >= today) {
          if (oldPenalty !== 0) {
            scheduleUpdates.push({
              id: item.id, penalty_amount: 0,
              total_due_amount: baseAmount, status: item.status,
            });
            anyChange = true;
          }
          // Remove unpaid/waived penalty_fees
          const existingPFs = penaltyFeesBySchedule.get(item.id) || [];
          for (const pf of existingPFs) {
            if (pf.status !== "paid") penaltyFeeIdsToWaive.push(pf.id);
          }
          continue;
        }

        // OVERDUE (or paid but was overdue): compute correct penalty
        const dueDayOfMonth = dueDate.getUTCDate();

        // Build trigger dates using the alternating pattern
        const triggerDates: Array<{ date: Date; stage: "week1" | "week2"; cycle: number }> = [];

        // Phase 1: due + 7 → week1:1
        const p1 = new Date(dueDate);
        p1.setUTCDate(p1.getUTCDate() + 7);
        triggerDates.push({ date: p1, stage: "week1", cycle: 1 });

        // Phase 2: due + 14 → week2:1
        const p2 = new Date(dueDate);
        p2.setUTCDate(p2.getUTCDate() + 14);
        triggerDates.push({ date: p2, stage: "week2", cycle: 1 });

        // Phase 3+: alternating monthly checkpoint + 14 days
        for (let m = 1; m <= 12; m++) {
          const monthlyDate = new Date(Date.UTC(
            dueDate.getUTCFullYear(),
            dueDate.getUTCMonth() + m,
            Math.min(dueDayOfMonth, daysInMonth(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + m))
          ));
          triggerDates.push({ date: monthlyDate, stage: "week1", cycle: m + 1 });

          const plus14 = new Date(monthlyDate);
          plus14.setUTCDate(plus14.getUTCDate() + 14);
          triggerDates.push({ date: plus14, stage: "week2", cycle: m + 1 });
        }

        // Compute correct penalty with cap
        const overrideCap = overrideMap.get(accountId);
        const cap = overrideCap !== undefined
          ? (instNum >= 6 ? Infinity : overrideCap)
          : getCap(currency, instNum);

        let correctPenalty = 0;
        const correctEntries: Array<{ stage: string; cycle: number; amount: number; date: string }> = [];

        for (const trigger of triggerDates) {
          if (now < trigger.date) break;

          let penAmt = getAmount(currency, trigger.stage);
          const projected = correctPenalty + penAmt;
          if (projected > cap) {
            penAmt = Math.max(0, cap - correctPenalty);
            if (penAmt <= 0) break;
          }

          correctPenalty += penAmt;
          correctEntries.push({
            stage: trigger.stage,
            cycle: trigger.cycle,
            amount: penAmt,
            date: trigger.date.toISOString().split("T")[0],
          });
        }

        totalSchedulePenaltyAfter += correctPenalty;

        // Determine correct status for the schedule item
        const isPaidItem = item.status === "paid";
        const isEffectivelyPaid = Number(item.paid_amount) >= (baseAmount + correctPenalty);
        const newStatus = isPaidItem || isEffectivelyPaid ? "paid" : (correctPenalty > 0 ? "overdue" : item.status);
        
        if (!isPaidItem && !isEffectivelyPaid && item.due_date < today) {
          hasOverdue = true;
        }

        // Update schedule if penalty changed
        if (Math.abs(correctPenalty - oldPenalty) > 0.001 || (item.status !== newStatus && newStatus === "overdue")) {
          anyChange = true;
          scheduleUpdates.push({
            id: item.id,
            penalty_amount: correctPenalty,
            total_due_amount: baseAmount + correctPenalty,
            status: newStatus,
          });
        }

        // ── Sync penalty_fees ──
        const existingPFs = penaltyFeesBySchedule.get(item.id) || [];

        // Build a map of existing penalty_fees by stage:cycle
        const existingByKey = new Map<string, any>();
        for (const pf of existingPFs) {
          const key = `${pf.penalty_stage}:${pf.penalty_cycle}`;
          existingByKey.set(key, pf);
        }

        // Build set of correct keys
        const correctKeys = new Set(correctEntries.map(e => `${e.stage}:${e.cycle}`));

        // For each correct entry, either update existing or insert new
        for (const entry of correctEntries) {
          const key = `${entry.stage}:${entry.cycle}`;
          const existing = existingByKey.get(key);
          const penaltyStatus = isPaidItem ? "paid" : "unpaid";

          if (existing) {
            // Record exists — update it if needed (amount, status, date)
            if (Math.abs(Number(existing.penalty_amount) - entry.amount) > 0.001 ||
                existing.status === "waived" || existing.penalty_date !== entry.date ||
                (isPaidItem && existing.status !== "paid")) {
              penaltyFeesToUpdate.push({
                id: existing.id,
                penalty_amount: entry.amount,
                penalty_date: entry.date,
                status: penaltyStatus,
              });
            }
          } else {
            // No existing record — insert
            penaltyFeesToInsert.push({
              account_id: accountId,
              schedule_id: item.id,
              currency,
              penalty_amount: entry.amount,
              penalty_stage: entry.stage,
              penalty_cycle: entry.cycle,
              penalty_date: entry.date,
              status: penaltyStatus,
            });
          }
        }

        // Waive penalty_fees that shouldn't exist (not in correctKeys and not paid)
        for (const pf of existingPFs) {
          const key = `${pf.penalty_stage}:${pf.penalty_cycle}`;
          if (!correctKeys.has(key) && pf.status !== "paid") {
            penaltyFeeIdsToWaive.push(pf.id);
          }
        }
      }

      // Recalculate account totals from schedule
      const downpayment = Number(acct.downpayment_amount);
      let totalBase = 0;
      let totalPenaltyAll = 0;
      let unpaidDue = 0;

      for (const item of schedItems) {
        if (item.status === "cancelled") continue;
        totalBase += Number(item.base_installment_amount);

        const updatedEntry = scheduleUpdates.find(u => u.id === item.id);
        const itemPenalty = updatedEntry ? updatedEntry.penalty_amount : Number(item.penalty_amount);
        const itemTotalDue = updatedEntry ? updatedEntry.total_due_amount : Number(item.total_due_amount);
        const itemStatus = updatedEntry ? updatedEntry.status : item.status;

        totalPenaltyAll += itemPenalty;

        if (itemStatus !== "paid" && itemStatus !== "cancelled") {
          unpaidDue += Math.max(0, itemTotalDue - Number(item.paid_amount));
        }
      }

      const newTotalAmount = downpayment + totalBase + totalPenaltyAll;

      if (anyChange || Math.abs(Number(acct.total_amount) - newTotalAmount) > 0.001) {
        accountUpdates.set(accountId, {
          total_amount: newTotalAmount,
          remaining_balance: unpaidDue,
          status: hasOverdue ? "overdue" : acct.status,
        });
      }

      if (anyChange) {
        report.push({
          invoice_number: invoiceNumber,
          currency,
          penalty_before: totalSchedulePenaltyBefore,
          penalty_after: totalSchedulePenaltyAfter,
          total_amount_before: Number(acct.total_amount),
          total_amount_after: newTotalAmount,
          remaining_before: Number(acct.remaining_balance ?? 0),
          remaining_after: unpaidDue,
        });
      }
    }

    // ── Execute updates ──

    // 1. Update schedule items
    let schedUpdated = 0;
    for (const upd of scheduleUpdates) {
      const { error } = await supabase.from("layaway_schedule").update({
        penalty_amount: upd.penalty_amount,
        total_due_amount: upd.total_due_amount,
        status: upd.status,
        updated_at: new Date().toISOString(),
      }).eq("id", upd.id);
      if (!error) schedUpdated++;
      else console.error("Schedule update error:", upd.id, error);
    }

    // 2. Waive incorrect penalty_fees
    let penaltiesRemoved = 0;
    for (let i = 0; i < penaltyFeeIdsToWaive.length; i += 100) {
      const chunk = penaltyFeeIdsToWaive.slice(i, i + 100);
      const { error } = await supabase.from("penalty_fees").update({
        status: "waived",
        waived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).in("id", chunk);
      if (!error) penaltiesRemoved += chunk.length;
      else console.error("Penalty waive error:", error);
    }

    // 3. Update existing penalty_fees
    let penaltiesUpdated = 0;
    for (const upd of penaltyFeesToUpdate) {
      const { error } = await supabase.from("penalty_fees").update({
        penalty_amount: upd.penalty_amount,
        penalty_date: upd.penalty_date,
        status: upd.status,
        waived_at: null,
        updated_at: new Date().toISOString(),
      }).eq("id", upd.id);
      if (!error) penaltiesUpdated++;
      else console.error("Penalty update error:", upd.id, error);
    }

    // 4. Insert new penalty_fees
    let penaltiesInserted = 0;
    for (let i = 0; i < penaltyFeesToInsert.length; i += 100) {
      const chunk = penaltyFeesToInsert.slice(i, i + 100);
      const { error } = await supabase.from("penalty_fees").insert(chunk);
      if (!error) penaltiesInserted += chunk.length;
      else console.error("Penalty insert error:", error);
    }

    // 4. Update account totals
    let accountsUpdated = 0;
    for (const [accId, upd] of accountUpdates) {
      const { error } = await supabase.from("layaway_accounts").update({
        total_amount: upd.total_amount,
        remaining_balance: upd.remaining_balance,
        status: upd.status,
        updated_at: new Date().toISOString(),
      }).eq("id", accId);
      if (!error) accountsUpdated++;
      else console.error("Account update error:", accId, error);
    }

    // 5. Audit log
    if (report.length > 0) {
      const auditEntries = report.slice(0, 50).map(r => ({
        entity_type: "layaway_account",
        entity_id: accountIds[0] || "00000000-0000-0000-0000-000000000000",
        action: "system_penalty_recalculation_v2",
        new_value_json: {
          invoice: r.invoice_number,
          penalty_before: r.penalty_before,
          penalty_after: r.penalty_after,
          rule: "alternating_14day_pattern",
        },
      }));
      await supabase.from("audit_logs").insert(auditEntries);
    }

    return new Response(JSON.stringify({
      message: "System-wide penalty recalculation completed",
      schedule_items_updated: schedUpdated,
      penalty_fees_removed: penaltiesRemoved,
      penalty_fees_updated: penaltiesUpdated,
      penalty_fees_created: penaltiesInserted,
      accounts_updated: accountsUpdated,
      invoices_changed: report.length,
      total_accounts_checked: accountSchedules.size,
      changes: report,
      confirmation: "All penalties are now derived from schedule only and fully synchronized",
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Recalculation error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
