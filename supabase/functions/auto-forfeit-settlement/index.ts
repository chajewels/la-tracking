import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Auto Forfeit & Final Settlement Engine
 *
 * ⛔ PERMANENT FORFEITURE LIFECYCLE — LOCKED RULE
 * DO NOT MODIFY without explicit business owner approval.
 *
 * STATUS FLOW: OVERDUE → FORFEITED → EXTENSION_ACTIVE → FINAL_FORFEITED
 *
 * 1. Reference = FIRST UNPAID DUE DATE (never last paid)
 * 2. FORFEITED at exactly 3 calendar months (day-level precision)
 * 3. ONE-TIME reactivation → EXTENSION_ACTIVE (1-month extension)
 * 4. Unpaid after extension → FINAL_FORFEITED (permanent, no override)
 * 5. FINAL_FORFEITED blocks all further negotiation/reactivation
 * 6. No account may become FINAL_FORFEITED before extension ends
 * 7. Penalty cycle continues through extension (no reset)
 *
 * Also handles FINAL SETTLEMENT at 6th penalty occurrence.
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

    // Fetch all active/overdue/extension_active accounts
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, customer_id, currency, status, total_amount, total_paid, remaining_balance, payment_plan_months, downpayment_amount, is_reactivated, extension_end_date")
      .in("status", ["active", "overdue", "extension_active", "final_settlement"]);

    if (accErr) throw accErr;
    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ message: "No active/overdue accounts", settlements: 0, forfeitures: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountIds = accounts.map(a => a.id);

    // Fetch all schedules, penalties, customers, and allocations in parallel
    const [schedRes, penRes, custRes, allocRes] = await Promise.all([
      fetchAll(supabase, "layaway_schedule", accountIds),
      fetchAll(supabase, "penalty_fees", accountIds),
      supabase.from("customers").select("id, full_name").in("id", [...new Set(accounts.map(a => a.customer_id))]),
      fetchAllocations(supabase, accountIds),
    ]);
    // Build allocation sum map: schedule_id → total allocated (non-voided payments only)
    const allocBySchedule = new Map<string, number>();
    for (const alloc of allocRes) {
      allocBySchedule.set(alloc.schedule_id, (allocBySchedule.get(alloc.schedule_id) || 0) + Number(alloc.allocated_amount));
    }

    const customerMap = new Map((custRes.data || []).map((c: any) => [c.id, c.full_name]));
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
    const finalForfeitResults: any[] = [];

    for (const account of accounts) {
      // ── RULE: FINAL FORFEITURE for extension_active past end date ──
      if (account.status === "extension_active") {
        const extEnd = account.extension_end_date;
        if (extEnd && new Date(extEnd + "T23:59:59Z") < now) {
          const { error: ffErr } = await supabase.from("layaway_accounts").update({
            status: "final_forfeited",
            updated_at: now.toISOString(),
          }).eq("id", account.id);

          if (ffErr) {
            console.error(`[auto-forfeit] Failed to final-forfeit ${account.invoice_number} (ext expired):`, ffErr);
            continue;
          }

          const customerName = customerMap.get(account.customer_id) || "Unknown";
          finalForfeitResults.push({
            invoice_number: account.invoice_number,
            customer_name: customerName,
            extension_end_date: extEnd,
            status: "FINAL_FORFEITED",
          });
          await supabase.from("audit_logs").insert({
            entity_type: "layaway_account",
            entity_id: account.id,
            action: "final_forfeited",
            new_value_json: {
              invoice_number: account.invoice_number,
              customer_name: customerName,
              extension_end_date: extEnd,
              reason: "Extension period expired without payment",
              timestamp: now.toISOString(),
            },
          });
          continue;
        }
        // ── Check extension month penalty cap → final_forfeit ──
        const extCurrency = account.currency;
        const extSchedItems = (schedByAccount.get(account.id) || [])
          .filter((s: any) => s.status !== "cancelled");
        const extPenalties = penByAccount.get(account.id) || [];
        const extensionMonthItem = extSchedItems.find(
          (s: any) => s.installment_number === account.payment_plan_months + 1
        );
        if (extensionMonthItem) {
          const extPenTotal = extPenalties
            .filter((p: any) =>
              p.schedule_id === extensionMonthItem.id &&
              (p.status === "unpaid" || p.status === "paid")
            )
            .reduce((sum: number, p: any) => sum + Number(p.penalty_amount), 0);
          const extCap = extCurrency === "PHP" ? 1000 : 2000;
          if (
            extPenTotal >= extCap &&
            new Date(extensionMonthItem.due_date + "T00:00:00Z") <= now
          ) {
            console.log(`[auto-forfeit] ${account.invoice_number} — extension month penalty ${extPenTotal} >= ${extCap} → final forfeiting`);
            const { error: extFfErr } = await supabase.from("layaway_accounts").update({
              status: "final_forfeited",
              updated_at: now.toISOString(),
            }).eq("id", account.id);

            if (extFfErr) {
              console.error(`[auto-forfeit] Failed to final-forfeit ${account.invoice_number} (ext penalty cap):`, extFfErr);
              continue;
            }

            const extCustomerName = customerMap.get(account.customer_id) || "Unknown";
            finalForfeitResults.push({
              invoice_number: account.invoice_number,
              customer_name: extCustomerName,
              extension_penalty_total: extPenTotal,
              cap: extCap,
              status: "FINAL_FORFEITED",
            });
            await supabase.from("audit_logs").insert({
              entity_type: "layaway_account",
              entity_id: account.id,
              action: "auto_forfeit_extension_penalty_cap",
              new_value_json: {
                invoice_number: account.invoice_number,
                customer_name: extCustomerName,
                extension_penalty_total: extPenTotal,
                cap: extCap,
                currency: extCurrency,
                forfeited_at: now.toISOString(),
              },
            });
            continue;
          }
        }
        // Extension still active and under cap — skip further processing
        continue;
      }

      const currency = account.currency;
      const schedItems = (schedByAccount.get(account.id) || [])
        .filter((s: any) => s.status !== "cancelled")
        .sort((a: any, b: any) => a.installment_number - b.installment_number);
      const penalties = penByAccount.get(account.id) || [];

      if (schedItems.length === 0) continue;

      // ── RULE: FORFEIT if final month penalty reaches ¥6,000/₱3,000 ──
      const finalMonthItem = schedItems[schedItems.length - 1];
      if (finalMonthItem) {
        const finalMonthPenalties = penalties.filter((p: any) =>
          p.schedule_id === finalMonthItem.id &&
          (p.status === "unpaid" || p.status === "paid")
        );
        const finalMonthPenaltyTotal = finalMonthPenalties.reduce(
          (sum: number, p: any) => sum + Number(p.penalty_amount), 0
        );
        const finalMonthCap = currency === "PHP" ? 3000 : 6000;

        if (
          finalMonthPenaltyTotal >= finalMonthCap &&
          new Date(finalMonthItem.due_date + "T00:00:00Z") <= now
        ) {
          console.log(`[auto-forfeit] ${account.invoice_number} — final month penalty ${finalMonthPenaltyTotal} >= ${finalMonthCap} → forfeiting`);
          const { error: p1Err } = await supabase.from("layaway_accounts")
            .update({ status: "forfeited", updated_at: now.toISOString() })
            .eq("id", account.id);

          if (p1Err) {
            console.error(`[auto-forfeit] Failed to forfeit ${account.invoice_number} (final month cap):`, p1Err);
            continue;
          }

          const { error: p1SchedErr } = await supabase.from("layaway_schedule")
            .update({ status: "cancelled", updated_at: now.toISOString() })
            .eq("account_id", account.id)
            .not("status", "eq", "paid");
          if (p1SchedErr) {
            console.error(`[auto-forfeit] Failed to cancel schedule for ${account.invoice_number}:`, p1SchedErr);
          }

          await supabase.from("audit_logs").insert({
            entity_type: "layaway_account",
            entity_id: account.id,
            action: "auto_forfeit_final_month_penalty",
            performed_by_user_id: null,
            new_value_json: {
              invoice_number: account.invoice_number,
              final_month_penalty_total: finalMonthPenaltyTotal,
              cap: finalMonthCap,
              currency,
              forfeited_at: now.toISOString(),
            },
          });
          forfeitResults.push({
            account_id: account.id,
            invoice_number: account.invoice_number,
            reason: "final_month_penalty_cap"
          });
          continue;
        }
      }

      // Safety guard: skip if a payment was received within the last 90 days
      const { data: recentPayments } = await supabase
        .from("payments")
        .select("date_paid")
        .eq("account_id", account.id)
        .is("voided_at", null)
        .order("date_paid", { ascending: false })
        .limit(1);
      const lastPaymentDate = recentPayments?.[0]?.date_paid ?? null;
      const ninetyDaysAgo = new Date(now);
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      if (lastPaymentDate && new Date(lastPaymentDate + "T00:00:00Z") >= ninetyDaysAgo) {
        console.log(`Skipped forfeit for ${account.id} — payment within 90 days (${lastPaymentDate})`);
        continue;
      }

      // ── Determine FIRST UNPAID DUE DATE (forfeiture reference) ──
      const paidItems = schedItems.filter((s: any) => {
        const allocated = allocBySchedule.get(s.id) || 0;
        const rowDue = Number(s.base_installment_amount) + Number(s.penalty_amount || 0) + Number(s.carried_amount || 0);
        return allocated >= rowDue - 0.01;
      });
      const unpaidItems = schedItems.filter((s: any) => {
        const allocated = allocBySchedule.get(s.id) || 0;
        const rowDue = Number(s.base_installment_amount) + Number(s.penalty_amount || 0) + Number(s.carried_amount || 0);
        return allocated < rowDue - 0.01;
      });

      if (unpaidItems.length === 0) continue;

      const firstUnpaid = unpaidItems.sort((a: any, b: any) => a.installment_number - b.installment_number)[0];
      const firstUnpaidDueDate = firstUnpaid.due_date;

      // ── Count penalty occurrences on unpaid items ──
      const unpaidScheduleIds = new Set(unpaidItems.map((s: any) => s.id));
      const relevantPenalties = penalties.filter((p: any) =>
        unpaidScheduleIds.has(p.schedule_id) && (p.status === "unpaid" || p.status === "paid")
      );
      const penaltyOccurrenceCount = relevantPenalties.length;
      const penaltyTotalFromLastPaid = relevantPenalties.reduce(
        (sum: number, p: any) => sum + Number(p.penalty_amount), 0
      );

      // ── Calculate months overdue from FIRST UNPAID DUE DATE ──
      const refDate = new Date(firstUnpaidDueDate + "T00:00:00Z");
      const monthsOverdue = monthsDiff(refDate, now);

      // ── RULE 2: AUTO FORFEIT at 3 months overdue ──
      if (monthsOverdue >= 3 && account.status !== "forfeited") {
        const { error: forfeitErr } = await supabase.from("layaway_accounts").update({
          status: "forfeited",
          updated_at: now.toISOString(),
        }).eq("id", account.id);

        if (forfeitErr) {
          console.error(`[auto-forfeit] Failed to forfeit ${account.invoice_number}:`, forfeitErr);
          continue;
        }

        // Cancel remaining schedule items
        for (const item of unpaidItems) {
          const { error: cancelErr } = await supabase.from("layaway_schedule").update({
            status: "cancelled",
            updated_at: now.toISOString(),
          }).eq("id", item.id);
          if (cancelErr) {
            console.error(`[auto-forfeit] Failed to cancel schedule ${item.id}:`, cancelErr);
          }
        }

        const customerName = customerMap.get(account.customer_id) || "Unknown";
        forfeitResults.push({
          invoice_number: account.invoice_number,
          customer_name: customerName,
          first_unpaid_due_date: firstUnpaidDueDate,
          overdue_month_count: monthsOverdue,
          status: "FORFEITED",
        });

        await supabase.from("audit_logs").insert({
          entity_type: "layaway_account",
          entity_id: account.id,
          action: "auto_forfeited",
          new_value_json: {
            invoice_number: account.invoice_number,
            customer_name: customerName,
            first_unpaid_due_date: firstUnpaidDueDate,
            overdue_month_count: monthsOverdue,
            timestamp: now.toISOString(),
          },
        });

        continue;
      }

      // ── RULE 1: FINAL SETTLEMENT at 6th penalty occurrence ──
      // Threshold: PHP 3,000 / JPY 6,000 (6 × base penalty)
      if (penaltyOccurrenceCount >= 6 && !existingSettlementSet.has(account.id) && account.status !== "final_settlement") {
        const remainingPrincipal = unpaidItems.reduce(
          (sum: number, s: any) => sum + Number(s.base_installment_amount) - Number(s.paid_amount), 0
        );

        const finalSettlementAmount = Math.max(0, remainingPrincipal) + penaltyTotalFromLastPaid;

        const { error: settlInsertErr } = await supabase.from("final_settlement_records").insert({
          account_id: account.id,
          last_paid_month_date: firstUnpaidDueDate,
          penalty_occurrence_count: penaltyOccurrenceCount,
          penalty_total_from_last_paid: penaltyTotalFromLastPaid,
          remaining_principal: Math.max(0, remainingPrincipal),
          final_settlement_amount: finalSettlementAmount,
          calculation_json: {
            remaining_principal: remainingPrincipal,
            penalty_total: penaltyTotalFromLastPaid,
            penalty_occurrences: penaltyOccurrenceCount,
            threshold_rule: "6th penalty occurrence",
            first_unpaid_due_date: firstUnpaidDueDate,
            unpaid_installments: unpaidItems.map((s: any) => ({
              installment: s.installment_number,
              base: Number(s.base_installment_amount),
              penalty: Number(s.penalty_amount),
              paid: Number(s.paid_amount),
            })),
          },
        });

        if (settlInsertErr) {
          console.error(`[auto-forfeit] Failed to create settlement for ${account.invoice_number}:`, settlInsertErr);
          continue;
        }

        const { error: settlStatusErr } = await supabase.from("layaway_accounts").update({
          status: "final_settlement",
          remaining_balance: finalSettlementAmount,
          updated_at: now.toISOString(),
        }).eq("id", account.id);

        if (settlStatusErr) {
          console.error(`[auto-forfeit] Failed to update status for ${account.invoice_number}:`, settlStatusErr);
        }

        const customerName = customerMap.get(account.customer_id) || "Unknown";
        settlementResults.push({
          invoice_number: account.invoice_number,
          customer_name: customerName,
          first_unpaid_due_date: firstUnpaidDueDate,
          penalty_occurrence_count: penaltyOccurrenceCount,
          penalty_total: penaltyTotalFromLastPaid,
          remaining_principal: remainingPrincipal,
          final_settlement_amount: finalSettlementAmount,
          status: "FINAL_SETTLEMENT",
        });

        await supabase.from("audit_logs").insert({
          entity_type: "layaway_account",
          entity_id: account.id,
          action: "final_settlement_created",
          new_value_json: {
            invoice_number: account.invoice_number,
            customer_name: customerName,
            first_unpaid_due_date: firstUnpaidDueDate,
            penalty_occurrence_count: penaltyOccurrenceCount,
            penalty_total: penaltyTotalFromLastPaid,
            final_settlement_amount: finalSettlementAmount,
            threshold_rule: "6th penalty occurrence",
            timestamp: now.toISOString(),
          },
        });
      }
    }

    return new Response(JSON.stringify({
      message: "Auto forfeit/settlement engine completed",
      accounts_checked: accounts.length,
      settlements_created: settlementResults.length,
      forfeitures_applied: forfeitResults.length,
      final_forfeitures_applied: finalForfeitResults.length,
      settlement_details: settlementResults,
      forfeiture_details: forfeitResults,
      final_forfeiture_details: finalForfeitResults,
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

/** Fetch payment_allocations joined with non-voided payments for all account schedule rows */
async function fetchAllocations(supabase: any, accountIds: string[]): Promise<any[]> {
  let all: any[] = [];
  for (let i = 0; i < accountIds.length; i += 200) {
    const chunk = accountIds.slice(i, i + 200);
    const { data: schedIds } = await supabase
      .from("layaway_schedule")
      .select("id")
      .in("account_id", chunk);
    if (!schedIds || schedIds.length === 0) continue;
    const ids = schedIds.map((r: any) => r.id);
    for (let j = 0; j < ids.length; j += 200) {
      const idChunk = ids.slice(j, j + 200);
      const { data } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, payment_id")
        .in("schedule_id", idChunk);
      if (data) all = all.concat(data);
    }
  }
  if (all.length === 0) return [];
  const paymentIds = [...new Set(all.map((a: any) => a.payment_id))];
  const voidedIds = new Set<string>();
  for (let i = 0; i < paymentIds.length; i += 200) {
    const chunk = paymentIds.slice(i, i + 200);
    const { data } = await supabase
      .from("payments")
      .select("id")
      .in("id", chunk)
      .not("voided_at", "is", null);
    if (data) data.forEach((p: any) => voidedIds.add(p.id));
  }
  return all.filter((a: any) => !voidedIds.has(a.payment_id));
}

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

/** Calculate FULL month difference between two dates (day-level precision).
 *  Only counts a month as complete when the day of 'to' >= day of 'from'.
 *  E.g. Dec 24 → Mar 22 = 2 (not 3), Dec 24 → Mar 24 = 3. */
function monthsDiff(from: Date, to: Date): number {
  const rawMonths = (to.getFullYear() - from.getUTCFullYear()) * 12 +
    (to.getMonth() - from.getUTCMonth());
  // If the day hasn't been reached yet, subtract 1
  if (to.getDate() < from.getUTCDate()) {
    return Math.max(0, rawMonths - 1);
  }
  return rawMonths;
}
