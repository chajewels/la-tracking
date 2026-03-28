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
 * 1. Reference = FIRST of the last 3 consecutive zero-payment due installments
 * 2. FORFEITED at exactly 3 calendar months (day-level precision)
 * 3. ONE-TIME reactivation → EXTENSION_ACTIVE (1-month extension)
 * 4. Unpaid after extension → FINAL_FORFEITED (permanent, no override)
 * 5. FINAL_FORFEITED blocks all further negotiation/reactivation
 * 6. No account may become FINAL_FORFEITED before extension ends
 * 7. Penalty cycle continues through extension (no reset)
 *
 * FORFEITURE ELIGIBILITY RULES:
 * - The last 3 due installments must ALL have paid_amount = 0 (zero engagement)
 * - A partial payment (partially_paid status) counts as a payment — not non-payment
 * - No payment recorded on the account within the last 90 days
 * - The first of those 3 zero-payment months must be 3+ calendar months past due
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
      .in("status", ["active", "overdue", "extension_active"]);

    if (accErr) throw accErr;
    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ message: "No active/overdue accounts", settlements: 0, forfeitures: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountIds = accounts.map(a => a.id);

    // Fetch schedules, penalties, customers, and recent payments in parallel
    const [schedRes, penRes, custRes, paymentsRes] = await Promise.all([
      fetchAll(supabase, "layaway_schedule", accountIds),
      fetchAll(supabase, "penalty_fees", accountIds),
      supabase.from("customers").select("id, full_name").in("id", [...new Set(accounts.map(a => a.customer_id))]),
      fetchAll(supabase, "payments", accountIds, "account_id, created_at, voided_at"),
    ]);

    const customerMap = new Map((custRes.data || []).map((c: any) => [c.id, c.full_name]));
    const schedByAccount = groupBy(schedRes, "account_id");
    const penByAccount = groupBy(penRes, "account_id");

    // Build most recent non-voided payment date per account
    const lastPaymentByAccount = new Map<string, Date>();
    for (const p of paymentsRes) {
      if (p.voided_at != null) continue;
      const pDate = new Date(p.created_at);
      const existing = lastPaymentByAccount.get(p.account_id);
      if (!existing || pDate > existing) {
        lastPaymentByAccount.set(p.account_id, pDate);
      }
    }

    // Check for existing settlement records
    const { data: existingSettlements } = await supabase
      .from("final_settlement_records")
      .select("account_id")
      .in("account_id", accountIds);
    const existingSettlementSet = new Set((existingSettlements || []).map((s: any) => s.account_id));

    const settlementResults: any[] = [];
    const forfeitResults: any[] = [];
    const finalForfeitResults: any[] = [];
    const skippedResults: any[] = [];
    const auditEntries: any[] = [];

    for (const account of accounts) {
      // ── RULE: FINAL FORFEITURE for extension_active past end date ──
      if (account.status === "extension_active") {
        const extEnd = account.extension_end_date;
        if (extEnd && new Date(extEnd + "T23:59:59Z") < now) {
          await supabase.from("layaway_accounts").update({
            status: "final_forfeited",
            updated_at: now.toISOString(),
          }).eq("id", account.id);

          const customerName = customerMap.get(account.customer_id) || "Unknown";
          finalForfeitResults.push({
            invoice_number: account.invoice_number,
            customer_name: customerName,
            extension_end_date: extEnd,
            status: "FINAL_FORFEITED",
          });
          auditEntries.push({
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
        // Extension still active — skip further processing
        continue;
      }

      const schedItems = (schedByAccount.get(account.id) || [])
        .filter((s: any) => s.status !== "cancelled")
        .sort((a: any, b: any) => a.installment_number - b.installment_number);
      const penalties = penByAccount.get(account.id) || [];

      if (schedItems.length === 0) continue;

      // ── Determine unpaid items (for penalty counting + schedule cancellation) ──
      // "Unpaid" = not fully paid (includes partially_paid)
      const unpaidItems = schedItems.filter((s: any) =>
        s.status !== "paid" && Number(s.paid_amount) < Number(s.total_due_amount)
      );

      if (unpaidItems.length === 0) continue;

      // ── Count penalty occurrences on unpaid items ──
      const unpaidScheduleIds = new Set(unpaidItems.map((s: any) => s.id));
      const relevantPenalties = penalties.filter((p: any) =>
        unpaidScheduleIds.has(p.schedule_id) && (p.status === "unpaid" || p.status === "paid")
      );
      const penaltyOccurrenceCount = relevantPenalties.length;
      const penaltyTotalFromLastPaid = relevantPenalties.reduce(
        (sum: number, p: any) => sum + Number(p.penalty_amount), 0
      );

      const currency = account.currency;

      // ── RULE 2: AUTO FORFEIT ──
      //
      // An account is eligible for forfeiture only when ALL of the following are true:
      //   1. The last 3 due installments all have paid_amount = 0 (no engagement whatsoever)
      //      — a partial payment (partially_paid) has paid_amount > 0 → NOT eligible
      //   2. No non-voided payment recorded on the account within the last 90 days
      //   3. The due_date of the first of those 3 zero-payment months is 3+ calendar months ago
      //
      if (account.status !== "forfeited") {
        // All schedule items with a due date on or before today, sorted oldest→newest
        const dueItems = schedItems
          .filter((s: any) => new Date(s.due_date + "T00:00:00Z") <= now)
          .sort((a: any, b: any) => a.installment_number - b.installment_number);

        if (dueItems.length >= 3) {
          const lastThreeDue = dueItems.slice(-3);

          // Check 1: All 3 have zero payment (paid_amount = 0 strictly)
          const allZeroPayment = lastThreeDue.every(
            (s: any) => Number(s.paid_amount) === 0
          );

          // Check 2: No payment within the last 90 days
          const lastPayment = lastPaymentByAccount.get(account.id);
          const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          const hasRecentPayment = lastPayment != null && lastPayment >= ninetyDaysAgo;

          if (allZeroPayment && !hasRecentPayment) {
            // Check 3: First of the 3 zero-payment months is 3+ calendar months past due
            const refDate = new Date(lastThreeDue[0].due_date + "T00:00:00Z");
            const monthsOverdue = monthsDiff(refDate, now);

            if (monthsOverdue >= 3) {
              await supabase.from("layaway_accounts").update({
                status: "forfeited",
                updated_at: now.toISOString(),
              }).eq("id", account.id);

              // Cancel remaining unpaid schedule items
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
                forfeiture_ref_date: lastThreeDue[0].due_date,
                overdue_month_count: monthsOverdue,
                zero_payment_installments: lastThreeDue.map((s: any) => s.installment_number),
                status: "FORFEITED",
              });

              auditEntries.push({
                entity_type: "layaway_account",
                entity_id: account.id,
                action: "auto_forfeited",
                new_value_json: {
                  invoice_number: account.invoice_number,
                  customer_name: customerName,
                  forfeiture_ref_date: lastThreeDue[0].due_date,
                  overdue_month_count: monthsOverdue,
                  zero_payment_installments: lastThreeDue.map((s: any) => s.installment_number),
                  timestamp: now.toISOString(),
                },
              });

              continue;
            }
          } else if (!allZeroPayment) {
            // Has payment activity in last 3 due months — log as skipped for diagnostics
            const customerName = customerMap.get(account.customer_id) || "Unknown";
            skippedResults.push({
              invoice_number: account.invoice_number,
              customer_name: customerName,
              reason: "partial_or_full_payment_in_last_3_due_months",
              last_three_due: lastThreeDue.map((s: any) => ({
                installment: s.installment_number,
                due_date: s.due_date,
                paid_amount: Number(s.paid_amount),
                status: s.status,
              })),
            });
          } else if (hasRecentPayment) {
            const customerName = customerMap.get(account.customer_id) || "Unknown";
            skippedResults.push({
              invoice_number: account.invoice_number,
              customer_name: customerName,
              reason: "payment_within_90_days",
              last_payment_date: lastPayment?.toISOString(),
            });
          }
        }
      }

      // ── RULE 1: FINAL SETTLEMENT at 6th penalty occurrence ──
      // Threshold: PHP 3,000 / JPY 6,000 (6 × base penalty)
      if (penaltyOccurrenceCount >= 6 && !existingSettlementSet.has(account.id) && account.status !== "final_settlement") {
        const remainingPrincipal = unpaidItems.reduce(
          (sum: number, s: any) => sum + Number(s.base_installment_amount) - Number(s.paid_amount), 0
        );

        const finalSettlementAmount = Math.max(0, remainingPrincipal) + penaltyTotalFromLastPaid;

        await supabase.from("final_settlement_records").insert({
          account_id: account.id,
          last_paid_month_date: unpaidItems[0]?.due_date,
          penalty_occurrence_count: penaltyOccurrenceCount,
          penalty_total_from_last_paid: penaltyTotalFromLastPaid,
          remaining_principal: Math.max(0, remainingPrincipal),
          final_settlement_amount: finalSettlementAmount,
          calculation_json: {
            remaining_principal: remainingPrincipal,
            penalty_total: penaltyTotalFromLastPaid,
            penalty_occurrences: penaltyOccurrenceCount,
            threshold_rule: "6th penalty occurrence",
            first_unpaid_due_date: unpaidItems[0]?.due_date,
            unpaid_installments: unpaidItems.map((s: any) => ({
              installment: s.installment_number,
              base: Number(s.base_installment_amount),
              penalty: Number(s.penalty_amount),
              paid: Number(s.paid_amount),
            })),
          },
        });

        await supabase.from("layaway_accounts").update({
          status: "final_settlement",
          remaining_balance: finalSettlementAmount,
          updated_at: now.toISOString(),
        }).eq("id", account.id);

        const customerName = customerMap.get(account.customer_id) || "Unknown";
        settlementResults.push({
          invoice_number: account.invoice_number,
          customer_name: customerName,
          first_unpaid_due_date: unpaidItems[0]?.due_date,
          penalty_occurrence_count: penaltyOccurrenceCount,
          penalty_total: penaltyTotalFromLastPaid,
          remaining_principal: remainingPrincipal,
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
            first_unpaid_due_date: unpaidItems[0]?.due_date,
            penalty_occurrence_count: penaltyOccurrenceCount,
            penalty_total: penaltyTotalFromLastPaid,
            final_settlement_amount: finalSettlementAmount,
            threshold_rule: "6th penalty occurrence",
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
      final_forfeitures_applied: finalForfeitResults.length,
      skipped_forfeiture: skippedResults.length,
      settlement_details: settlementResults,
      forfeiture_details: forfeitResults,
      final_forfeiture_details: finalForfeitResults,
      skipped_details: skippedResults,
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

/** Fetch all rows from a table filtered by account_id IN (ids), paginated.
 *  Optionally pass a select string (defaults to "*"). */
async function fetchAll(supabase: any, table: string, accountIds: string[], select = "*"): Promise<any[]> {
  let all: any[] = [];
  for (let i = 0; i < accountIds.length; i += 200) {
    const chunk = accountIds.slice(i, i + 200);
    const { data } = await supabase.from(table).select(select).in("account_id", chunk);
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
