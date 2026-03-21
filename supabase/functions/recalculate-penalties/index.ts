import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * One-time system-wide penalty recalculation.
 *
 * For every unpaid/overdue schedule item whose due_date < today:
 *   1. Compute penalty checkpoints using the alternating pattern
 *   2. Apply cap (inst 1-5: PHP 1000, JPY 2000; inst 6+: uncapped)
 *   3. Update schedule row penalty_amount and total_due_amount
 *   4. Sync penalty_fees entries
 *   5. Recalculate account totals
 *
 * Alternating pattern (example due Jan 21):
 *   Jan 28 → week1:1 (due+7)
 *   Feb  4 → week2:1 (due+14)
 *   Feb 21 → week1:2 (due+1mo)
 *   Mar  7 → week2:2 (due+1mo+14d)
 *   Mar 21 → week1:3 (due+2mo)
 *   Apr  4 → week2:3 (due+2mo+14d)
 *   ...
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
      return config[key] || (currency === "PHP" ? (stage === "week1" ? 500 : 1000) : (stage === "week1" ? 1000 : 2000));
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

    // ── Fetch ALL schedule items for active/overdue accounts (paginated) ──
    let allItems: any[] = [];
    let page = 0;
    const pageSize = 500;
    while (true) {
      const { data: batch } = await supabase
        .from("layaway_schedule")
        .select("*, layaway_accounts!inner(id, currency, status, total_paid, downpayment_amount, total_amount, invoice_number)")
        .in("layaway_accounts.status", ["active", "overdue"])
        .order("installment_number", { ascending: true })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (!batch || batch.length === 0) break;
      allItems = allItems.concat(batch);
      if (batch.length < pageSize) break;
      page++;
    }

    // Group by account
    const accountSchedules = new Map<string, any[]>();
    for (const item of allItems) {
      const accId = item.account_id;
      if (!accountSchedules.has(accId)) accountSchedules.set(accId, []);
      accountSchedules.get(accId)!.push(item);
    }

    // ── Fetch existing penalty_fees for these accounts ──
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
    const penaltyFeeIdsToDelete: string[] = [];
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
        const paidAmount = Number(item.paid_amount);
        const instNum = item.installment_number;
        const dueDate = new Date(item.due_date + "T00:00:00Z");

        // For paid or cancelled items, keep penalty as-is
        if (item.status === "paid" || item.status === "cancelled") {
          totalSchedulePenaltyAfter += oldPenalty;
          continue;
        }

        // For items not yet due, no penalty
        if (item.due_date >= today) {
          if (oldPenalty !== 0) {
            scheduleUpdates.push({
              id: item.id,
              penalty_amount: 0,
              total_due_amount: baseAmount,
              status: item.status,
            });
            anyChange = true;
          }
          // Remove any penalty_fees for this non-overdue item
          const existingPFs = penaltyFeesBySchedule.get(item.id) || [];
          for (const pf of existingPFs) {
            if (pf.status === "unpaid") penaltyFeeIdsToDelete.push(pf.id);
          }
          continue;
        }

        // OVERDUE: compute correct penalty using alternating pattern
        hasOverdue = true;
        const dueDayOfMonth = dueDate.getUTCDate();

        // Build trigger dates
        const triggerDates: Array<{ date: Date; stage: "week1" | "week2"; cycle: number }> = [];

        // Phase 1: +7 days
        const p1 = new Date(dueDate);
        p1.setUTCDate(p1.getUTCDate() + 7);
        triggerDates.push({ date: p1, stage: "week1", cycle: 1 });

        // Phase 2: +14 days
        const p2 = new Date(dueDate);
        p2.setUTCDate(p2.getUTCDate() + 14);
        triggerDates.push({ date: p2, stage: "week2", cycle: 1 });

        // Phase 3+: alternating monthly + 14 days
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

        // Compute correct penalty
        const overrideCap = overrideMap.get(accountId);
        const cap = overrideCap !== undefined
          ? (instNum >= 6 ? Infinity : overrideCap)
          : getCap(currency, instNum);

        let correctPenalty = 0;
        const correctPenaltyEntries: Array<{ stage: string; cycle: number; amount: number; date: string }> = [];

        for (const trigger of triggerDates) {
          if (now < trigger.date) break;

          let penAmt = getAmount(currency, trigger.stage);
          const projected = correctPenalty + penAmt;
          if (projected > cap) {
            penAmt = Math.max(0, cap - correctPenalty);
            if (penAmt <= 0) break;
          }

          correctPenalty += penAmt;
          correctPenaltyEntries.push({
            stage: trigger.stage,
            cycle: trigger.cycle,
            amount: penAmt,
            date: trigger.date.toISOString().split("T")[0],
          });
        }

        totalSchedulePenaltyAfter += correctPenalty;

        // Update schedule if different
        if (Math.abs(correctPenalty - oldPenalty) > 0.001) {
          anyChange = true;
          const newStatus = "overdue";
          scheduleUpdates.push({
            id: item.id,
            penalty_amount: correctPenalty,
            total_due_amount: baseAmount + correctPenalty,
            status: newStatus,
          });
        }

        // Sync penalty_fees: remove old unpaid ones, add correct ones
        const existingPFs = penaltyFeesBySchedule.get(item.id) || [];

        // Build lookup of existing paid penalty_fees (don't touch these)
        const paidPFKeys = new Set<string>();
        for (const pf of existingPFs) {
          if (pf.status === "paid") {
            paidPFKeys.add(`${pf.penalty_stage}:${pf.penalty_cycle}`);
          }
        }

        // Remove unpaid/waived penalty_fees for this schedule item
        for (const pf of existingPFs) {
          if (pf.status === "unpaid" || pf.status === "waived") {
            penaltyFeeIdsToDelete.push(pf.id);
          }
        }

        // Re-insert correct unpaid penalty entries (skip ones already paid)
        for (const entry of correctPenaltyEntries) {
          const key = `${entry.stage}:${entry.cycle}`;
          if (paidPFKeys.has(key)) continue; // already paid, skip

          penaltyFeesToInsert.push({
            account_id: accountId,
            schedule_id: item.id,
            currency,
            penalty_amount: entry.amount,
            penalty_stage: entry.stage,
            penalty_cycle: entry.cycle,
            penalty_date: entry.date,
            status: "unpaid",
          });
        }
      }

      // Recalculate account totals
      // total_amount = downpayment + sum(base_installment_amount) + sum(penalty for all schedule items) + services
      // But we should derive it from schedule to match the "no phantom penalty" rule
      const downpayment = Number(acct.downpayment_amount);

      // Get total base from all schedule items
      let totalBase = 0;
      let totalPenaltyAll = 0;
      let unpaidDue = 0;
      for (const item of schedItems) {
        totalBase += Number(item.base_installment_amount);
        const instPaid = Number(item.paid_amount);

        // Use the corrected penalty if we updated it, otherwise the existing one
        const updatedEntry = scheduleUpdates.find(u => u.id === item.id);
        let itemPenalty: number;
        let itemTotalDue: number;

        if (updatedEntry) {
          itemPenalty = updatedEntry.penalty_amount;
          itemTotalDue = updatedEntry.total_due_amount;
        } else {
          itemPenalty = Number(item.penalty_amount);
          itemTotalDue = Number(item.total_due_amount);
        }

        totalPenaltyAll += itemPenalty;

        if (item.status !== "paid" && item.status !== "cancelled") {
          unpaidDue += Math.max(0, itemTotalDue - instPaid);
        }
      }

      const newTotalAmount = downpayment + totalBase + totalPenaltyAll;
      const newRemaining = Math.max(0, newTotalAmount - totalPaid);

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

    // 2. Delete incorrect penalty_fees (mark as waived to preserve audit trail - actually update status)
    let penaltiesRemoved = 0;
    for (let i = 0; i < penaltyFeeIdsToDelete.length; i += 100) {
      const chunk = penaltyFeeIdsToDelete.slice(i, i + 100);
      // We can't delete due to RLS, so update status to indicate they were recalculated away
      const { error } = await supabase.from("penalty_fees").update({
        status: "waived",
        waived_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).in("id", chunk);
      if (!error) penaltiesRemoved += chunk.length;
      else console.error("Penalty fees waive error:", error);
    }

    // 3. Insert correct penalty_fees
    let penaltiesInserted = 0;
    for (let i = 0; i < penaltyFeesToInsert.length; i += 100) {
      const chunk = penaltyFeesToInsert.slice(i, i + 100);
      const { error } = await supabase.from("penalty_fees").insert(chunk);
      if (!error) penaltiesInserted += chunk.length;
      else console.error("Penalty fees insert error:", error);
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
      const auditEntries = report.map(r => ({
        entity_type: "layaway_account",
        entity_id: r.invoice_number,
        action: "system_penalty_recalculation",
        old_value_json: {
          total_penalty: r.penalty_before,
          total_amount: r.total_amount_before,
          remaining_balance: r.remaining_before,
        },
        new_value_json: {
          total_penalty: r.penalty_after,
          total_amount: r.total_amount_after,
          remaining_balance: r.remaining_after,
          rule: "alternating_week1_week2_pattern",
        },
      }));
      for (let i = 0; i < auditEntries.length; i += 100) {
        await supabase.from("audit_logs").insert(auditEntries.slice(i, i + 100));
      }
    }

    // ── Validation pass ──
    const validationErrors: string[] = [];
    for (const [accountId, schedItems] of accountSchedules) {
      const acct = schedItems[0].layaway_accounts;
      // Re-read updated data
      const { data: freshSchedule } = await supabase
        .from("layaway_schedule")
        .select("*")
        .eq("account_id", accountId);
      const { data: freshAccount } = await supabase
        .from("layaway_accounts")
        .select("*")
        .eq("id", accountId)
        .maybeSingle();

      if (!freshSchedule || !freshAccount) continue;

      const schedPenSum = freshSchedule.reduce((s: number, r: any) => s + Number(r.penalty_amount), 0);
      const unpaidSum = freshSchedule
        .filter((r: any) => r.status !== "paid" && r.status !== "cancelled")
        .reduce((s: number, r: any) => s + Math.max(0, Number(r.total_due_amount) - Number(r.paid_amount)), 0);

      const remaining = Number(freshAccount.remaining_balance);

      if (Math.abs(unpaidSum - remaining) > 1) {
        validationErrors.push(
          `INV#${acct.invoice_number}: remaining_balance(${remaining}) != unpaid_schedule_sum(${unpaidSum})`
        );
      }
    }

    return new Response(JSON.stringify({
      message: "System-wide penalty recalculation completed",
      schedule_items_updated: schedUpdated,
      penalty_fees_removed: penaltiesRemoved,
      penalty_fees_created: penaltiesInserted,
      accounts_updated: accountsUpdated,
      invoices_changed: report.length,
      changes: report,
      validation_errors: validationErrors,
      confirmation: validationErrors.length === 0
        ? "All penalties are now derived from schedule only and fully synchronized"
        : `${validationErrors.length} validation issues found`,
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
