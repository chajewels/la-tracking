import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Auto Forfeit & Final Settlement Engine
 *
 * Checks all overdue accounts and:
 * 1. Creates FINAL SETTLEMENT when 5th penalty occurrence is reached after last paid month
 * 2. Auto-FORFEITS when 3 months overdue after last paid month
 *
 * Reference point: LAST PAID MONTH (not invoice start date)
 *
 * Penalty threshold for final settlement:
 *   PHP → total penalty reaches ₱2,500 (5 × ₱500)
 *   JPY → total penalty reaches ¥5,000 (5 × ¥1,000)
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

    // Fetch all active/overdue accounts
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, customer_id, currency, status, total_amount, total_paid, remaining_balance, payment_plan_months, downpayment_amount")
      .in("status", ["active", "overdue"]);

    if (accErr) throw accErr;
    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ message: "No active/overdue accounts", settlements: 0, forfeitures: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountIds = accounts.map(a => a.id);

    // Fetch all schedules and penalties in parallel
    const [schedRes, penRes, custRes] = await Promise.all([
      fetchAll(supabase, "layaway_schedule", accountIds),
      fetchAll(supabase, "penalty_fees", accountIds),
      supabase.from("customers").select("id, full_name").in("id", [...new Set(accounts.map(a => a.customer_id))]),
    ]);

    const customerMap = new Map((custRes.data || []).map((c: any) => [c.id, c.full_name]));

    // Group by account
    const schedByAccount = groupBy(schedRes, "account_id");
    const penByAccount = groupBy(penRes, "account_id");

    // Check for existing settlement records
    const { data: existingSettlements } = await supabase
      .from("final_settlement_records")
      .select("account_id")
      .in("account_id", accountIds);
    const existingSettlementSet = new Set((existingSettlements || []).map((s: any) => s.account_id));

    const settlementResults: any[] = [];
    const forfeitResults: any[] = [];
    const auditEntries: any[] = [];

    for (const account of accounts) {
      const schedItems = (schedByAccount.get(account.id) || [])
        .filter((s: any) => s.status !== "cancelled")
        .sort((a: any, b: any) => a.installment_number - b.installment_number);
      const penalties = penByAccount.get(account.id) || [];

      if (schedItems.length === 0) continue;

      // ── Determine LAST PAID MONTH ──
      const paidItems = schedItems.filter((s: any) =>
        s.status === "paid" || Number(s.paid_amount) >= Number(s.total_due_amount)
      );
      const unpaidItems = schedItems.filter((s: any) =>
        s.status !== "paid" && Number(s.paid_amount) < Number(s.total_due_amount)
      );

      if (unpaidItems.length === 0) continue; // Fully paid

      // Last paid month date = due_date of the last paid installment
      // If no installments paid, use the first due_date minus 1 month as reference
      let lastPaidMonthDate: string | null = null;
      if (paidItems.length > 0) {
        const lastPaid = paidItems.sort((a: any, b: any) => b.installment_number - a.installment_number)[0];
        lastPaidMonthDate = lastPaid.due_date;
      }

      // First unpaid item
      const firstUnpaid = unpaidItems.sort((a: any, b: any) => a.installment_number - b.installment_number)[0];
      const referenceDate = lastPaidMonthDate || firstUnpaid.due_date;

      // ── Count penalty occurrences AFTER last paid month ──
      // Only count unpaid/paid penalties on unpaid schedule items
      const unpaidScheduleIds = new Set(unpaidItems.map((s: any) => s.id));
      const relevantPenalties = penalties.filter((p: any) =>
        unpaidScheduleIds.has(p.schedule_id) && (p.status === "unpaid" || p.status === "paid")
      );
      const penaltyOccurrenceCount = relevantPenalties.length;
      const penaltyTotalFromLastPaid = relevantPenalties.reduce(
        (sum: number, p: any) => sum + Number(p.penalty_amount), 0
      );

      // ── Calculate months overdue from last paid month ──
      const refDate = new Date(referenceDate + "T00:00:00Z");
      const monthsOverdue = monthsDiff(refDate, now);

      const currency = account.currency;
      const settlementThreshold = currency === "PHP" ? 2500 : 5000;

      // ── RULE 3: AUTO FORFEIT at 3 months overdue ──
      if (monthsOverdue >= 3 && account.status !== "forfeited") {
        await supabase.from("layaway_accounts").update({
          status: "forfeited",
          updated_at: now.toISOString(),
        }).eq("id", account.id);

        // Cancel remaining schedule items
        for (const item of unpaidItems) {
          await supabase.from("layaway_schedule").update({
            status: "cancelled",
            updated_at: now.toISOString(),
          }).eq("id", item.id);
        }

        const customerName = customerMap.get(account.customer_id) || "Unknown";
        forfeitResults.push({
          invoice_number: account.invoice_number,
          customer_name: customerName,
          last_paid_month: lastPaidMonthDate,
          overdue_month_count: monthsOverdue,
          status: "FORFEITED",
        });

        auditEntries.push({
          entity_type: "layaway_account",
          entity_id: account.id,
          action: "auto_forfeited",
          new_value_json: {
            invoice_number: account.invoice_number,
            customer_name: customerName,
            last_paid_month: lastPaidMonthDate,
            overdue_month_count: monthsOverdue,
            timestamp: now.toISOString(),
          },
        });

        continue; // Skip settlement check since account is forfeited
      }

      // ── RULE 2: FINAL SETTLEMENT at 5th penalty occurrence ──
      if (penaltyOccurrenceCount >= 5 && !existingSettlementSet.has(account.id) && account.status !== "final_settlement") {
        // Calculate final settlement amount
        const remainingPrincipal = unpaidItems.reduce(
          (sum: number, s: any) => sum + Number(s.base_installment_amount) - Number(s.paid_amount), 0
        );

        // Calculate 3rd-month penalty projection (all checkpoints that would fire)
        const thirdMonthPenalty = compute3rdMonthPenalty(firstUnpaid, currency, now);

        const finalSettlementAmount = Math.max(0, remainingPrincipal) + penaltyTotalFromLastPaid + thirdMonthPenalty;

        // Insert settlement record
        await supabase.from("final_settlement_records").insert({
          account_id: account.id,
          last_paid_month_date: lastPaidMonthDate,
          penalty_occurrence_count: penaltyOccurrenceCount,
          penalty_total_from_last_paid: penaltyTotalFromLastPaid,
          remaining_principal: Math.max(0, remainingPrincipal),
          final_settlement_amount: finalSettlementAmount,
          calculation_json: {
            remaining_principal: remainingPrincipal,
            penalty_total: penaltyTotalFromLastPaid,
            third_month_penalty_projection: thirdMonthPenalty,
            penalty_occurrences: penaltyOccurrenceCount,
            unpaid_installments: unpaidItems.map((s: any) => ({
              installment: s.installment_number,
              base: Number(s.base_installment_amount),
              penalty: Number(s.penalty_amount),
              paid: Number(s.paid_amount),
            })),
          },
        });

        // Update account status
        await supabase.from("layaway_accounts").update({
          status: "final_settlement",
          remaining_balance: finalSettlementAmount,
          updated_at: now.toISOString(),
        }).eq("id", account.id);

        const customerName = customerMap.get(account.customer_id) || "Unknown";
        settlementResults.push({
          invoice_number: account.invoice_number,
          customer_name: customerName,
          last_paid_month: lastPaidMonthDate,
          penalty_occurrence_count: penaltyOccurrenceCount,
          penalty_total: penaltyTotalFromLastPaid,
          remaining_principal: remainingPrincipal,
          third_month_penalty: thirdMonthPenalty,
          final_settlement_amount: finalSettlementAmount,
          status: "FINAL_SETTLEMENT",
        });

        auditEntries.push({
          entity_type: "layaway_account",
          entity_id: account.id,
          action: "final_settlement_created",
          new_value_json: {
            invoice_number: account.invoice_number,
            customer_name: customerName,
            last_paid_month: lastPaidMonthDate,
            penalty_occurrence_count: penaltyOccurrenceCount,
            penalty_total: penaltyTotalFromLastPaid,
            final_settlement_amount: finalSettlementAmount,
            timestamp: now.toISOString(),
          },
        });
      }
    }

    // Insert audit logs
    if (auditEntries.length > 0) {
      for (let i = 0; i < auditEntries.length; i += 100) {
        await supabase.from("audit_logs").insert(auditEntries.slice(i, i + 100));
      }
    }

    return new Response(JSON.stringify({
      message: "Auto forfeit/settlement engine completed",
      accounts_checked: accounts.length,
      settlements_created: settlementResults.length,
      forfeitures_applied: forfeitResults.length,
      settlement_details: settlementResults,
      forfeiture_details: forfeitResults,
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Auto forfeit/settlement error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/** Fetch all rows from a table filtered by account_id IN (ids), paginated */
async function fetchAll(supabase: any, table: string, accountIds: string[]): Promise<any[]> {
  let all: any[] = [];
  for (let i = 0; i < accountIds.length; i += 200) {
    const chunk = accountIds.slice(i, i + 200);
    const { data } = await supabase.from(table).select("*").in("account_id", chunk);
    if (data) all = all.concat(data);
  }
  return all;
}

/** Group array by a key field */
function groupBy(items: any[], key: string): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const item of items) {
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

/** Calculate month difference between two dates */
function monthsDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getUTCFullYear()) * 12 +
    (to.getMonth() - from.getUTCMonth());
}

/**
 * Compute penalty amount that would apply at the 3rd month checkpoint
 * after the first unpaid due date. This includes both week1 and week2
 * penalties at that month.
 */
function compute3rdMonthPenalty(firstUnpaidItem: any, currency: string, now: Date): number {
  const dueDate = new Date(firstUnpaidItem.due_date + "T00:00:00Z");
  const penaltyAmount = currency === "PHP" ? 500 : 1000;

  // 3rd month checkpoint = due + 3 months
  const thirdMonth = new Date(Date.UTC(
    dueDate.getUTCFullYear(),
    dueDate.getUTCMonth() + 3,
    Math.min(dueDate.getUTCDate(), daysInMonth(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + 3))
  ));

  // If 3rd month hasn't arrived yet, project both week1 and week2
  let projected = 0;
  if (now >= thirdMonth) {
    // Already past — penalties should already exist in the system
    return 0;
  }
  // Project week1:4 + week2:4 (cycle 4 = 3rd month after initial)
  projected = penaltyAmount * 2;
  return projected;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
