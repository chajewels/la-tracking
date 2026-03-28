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
    // ISO date string for safe string-to-string due_date comparisons (avoids UTC midnight edge cases)
    const todayStr = now.toISOString().split("T")[0]; // e.g. "2026-03-28"

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

    // Fetch schedules, penalties, customers, and payments in parallel
    const [schedRes, penRes, custRes, paymentsRes] = await Promise.all([
      fetchAll(supabase, "layaway_schedule", accountIds),
      fetchAll(supabase, "penalty_fees", accountIds),
      supabase.from("customers").select("id, full_name").in("id", [...new Set(accounts.map(a => a.customer_id))]),
      // Fetch date_paid (not created_at) — used for the 90-day recent-activity guard
      fetchAll(supabase, "payments", accountIds, "account_id, date_paid, voided_at"),
    ]);

    const customerMap = new Map((custRes.data || []).map((c: any) => [c.id, c.full_name]));
    const schedByAccount = groupBy(schedRes, "account_id");
    const penByAccount = groupBy(penRes, "account_id");

    // Build most recent non-voided date_paid per account
    // Equivalent to: SELECT MAX(date_paid) FROM payments WHERE voided_at IS NULL GROUP BY account_id
    const lastPaymentByAccount = new Map<string, Date>();
    for (const p of paymentsRes) {
      if (p.voided_at != null) continue;
      const pDate = new Date(p.date_paid + "T00:00:00Z");
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
      // Eligibility: ALL 4 steps must pass:
      //
      // STEP 1 — Get the 3 most recent due installments (due_date <= today), ordered due_date DESC
      // STEP 2 — All 3 must have paid_amount = 0 (partial payment = NOT zero = active customer)
      // STEP 3 — Must have exactly 3 due installments to check (not enough history otherwise)
      // STEP 4 — MAX(date_paid) from payments WHERE voided_at IS NULL must be > 90 days ago
      //
      if (account.status !== "forfeited") {
        const customerName = customerMap.get(account.customer_id) || "Unknown";

        // STEP 1: 3 most recent due installments, ordered by due_date DESC
        // Use string comparison (ISO dates sort lexicographically) to avoid UTC midnight edge cases
        const last3Due = schedItems
          .filter((s: any) => s.due_date <= todayStr)
          .sort((a: any, b: any) => {
            // Primary: due_date DESC; secondary: installment_number DESC (tiebreak)
            if (b.due_date !== a.due_date) return b.due_date > a.due_date ? 1 : -1;
            return b.installment_number - a.installment_number;
          })
          .slice(0, 3);

        // STEP 3: Need at least 3 due installments
        if (last3Due.length < 3) {
          console.log(`[SKIP] ${account.invoice_number} — only ${last3Due.length} due installment(s), need 3`);
          skippedResults.push({
            invoice_number: account.invoice_number,
            customer_name: customerName,
            reason: "fewer_than_3_due_installments",
            due_installment_count: last3Due.length,
          });
        } else {
          // STEP 2: All 3 must have paid_amount = 0
          // Use parseFloat() to handle Postgres numeric values returned as strings ("0.00")
          // strict === 0 can fail for string "0.00"; parseFloat("0.00") === 0 is always true
          const allZero = last3Due.every((s: any) => parseFloat(s.paid_amount) === 0);

          // STEP 4: Most recent date_paid must be > 90 days ago
          const lastPayment = lastPaymentByAccount.get(account.id);
          const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          const hasRecentPayment = lastPayment != null && lastPayment > ninetyDaysAgo;

          const last3Summary = last3Due.map((s: any) => ({
            installment: s.installment_number,
            due_date: s.due_date,
            paid_amount: parseFloat(s.paid_amount),
            status: s.status,
          }));

          // Always log the 3 rows evaluated so we can verify correct rows were selected
          console.log(
            `[CHECK] ${account.invoice_number} — evaluating last 3 due installments:`,
            JSON.stringify(last3Summary)
          );

          if (!allZero) {
            console.log(`[SKIP] ${account.invoice_number} — payment found in last 3 due installments (allZero=false)`);
            skippedResults.push({
              invoice_number: account.invoice_number,
              customer_name: customerName,
              reason: "payment_in_last_3_due_installments",
              last_3_due: last3Summary,
            });
          } else if (hasRecentPayment) {
            console.log(`[SKIP] ${account.invoice_number} — payment within 90 days (last: ${lastPayment!.toISOString().slice(0, 10)})`);
            skippedResults.push({
              invoice_number: account.invoice_number,
              customer_name: customerName,
              reason: "payment_within_90_days",
              last_payment_date: lastPayment!.toISOString().slice(0, 10),
              last_3_due: last3Summary,
            });
          } else {
            // All 4 checks passed — verify the 3-month calendar threshold
            // Reference = oldest of the 3 zero-payment due installments (last3Due is DESC, so index 2)
            const oldestZero = last3Due[last3Due.length - 1];
            const refDate = new Date(oldestZero.due_date + "T00:00:00Z");
            const monthsOverdue = monthsDiff(refDate, now);

            if (monthsOverdue < 3) {
              console.log(`[SKIP] ${account.invoice_number} — only ${monthsOverdue} month(s) overdue from ${oldestZero.due_date}, need 3`);
              skippedResults.push({
                invoice_number: account.invoice_number,
                customer_name: customerName,
                reason: "not_yet_3_months_overdue",
                months_overdue: monthsOverdue,
                ref_due_date: oldestZero.due_date,
                last_3_due: last3Summary,
              });
            } else {
              // ✅ ALL CHECKS PASSED — FORFEIT
              console.log(`[FORFEIT] ${account.invoice_number} — ${customerName} — ref date ${oldestZero.due_date} is ${monthsOverdue} months overdue, all 3 due installments have zero payment, last payment > 90 days ago`);

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

              forfeitResults.push({
                invoice_number: account.invoice_number,
                customer_name: customerName,
                forfeiture_ref_date: oldestZero.due_date,
                months_overdue: monthsOverdue,
                last_payment_date: lastPayment?.toISOString().slice(0, 10) ?? null,
                zero_payment_installments: last3Summary,
                status: "FORFEITED",
              });

              auditEntries.push({
                entity_type: "layaway_account",
                entity_id: account.id,
                action: "auto_forfeited",
                new_value_json: {
                  invoice_number: account.invoice_number,
                  customer_name: customerName,
                  forfeiture_ref_date: oldestZero.due_date,
                  months_overdue: monthsOverdue,
                  last_payment_date: lastPayment?.toISOString().slice(0, 10) ?? null,
                  zero_payment_installments: last3Summary,
                  timestamp: now.toISOString(),
                },
              });

              continue;
            }
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
