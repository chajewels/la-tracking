import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Fix account totals AND schedule allocations using SINGLE SOURCE OF TRUTH:
 * 1. remaining_balance = total_amount - SUM(actual non-voided payments)
 * 2. total_paid = SUM(actual non-voided payments)
 * 3. Creates missing allocation records for unallocated payments (e.g. bulk imports)
 * 4. Schedule paid_amount = SUM(non-voided allocations per schedule row)
 * 5. Schedule status = derived from paid_amount vs base_installment_amount
 * 
 * Never derives from schedule rows to avoid rounding/gap discrepancies.
 * Supports ?offset=N&limit=N for chunked execution.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const limit = parseInt(url.searchParams.get("limit") || "200");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: accounts } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, total_amount, remaining_balance, total_paid, downpayment_amount, status")
      .in("status", ["active", "overdue"])
      .order("invoice_number")
      .range(offset, offset + limit - 1);

    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ message: "No more accounts", accounts_fixed: 0, schedule_rows_fixed: 0, allocations_created: 0, fixes: [], offset, done: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountIds = accounts.map((a: any) => a.id);

    // Batch fetch all payments (SINGLE SOURCE OF TRUTH for remaining balance)
    let allPayments: any[] = [];
    for (let i = 0; i < accountIds.length; i += 50) {
      const chunk = accountIds.slice(i, i + 50);
      const { data: pays } = await supabase
        .from("payments")
        .select("id, account_id, amount_paid, date_paid, remarks")
        .in("account_id", chunk)
        .is("voided_at", null)
        .limit(5000);
      if (pays) allPayments = allPayments.concat(pays);
    }

    // Batch fetch all schedules
    let allSchedules: any[] = [];
    for (let i = 0; i < accountIds.length; i += 50) {
      const chunk = accountIds.slice(i, i + 50);
      const { data: scheds } = await supabase
        .from("layaway_schedule")
        .select("id, account_id, status, paid_amount, base_installment_amount, due_date, installment_number")
        .in("account_id", chunk)
        .neq("status", "cancelled")
        .order("installment_number")
        .limit(5000);
      if (scheds) allSchedules = allSchedules.concat(scheds);
    }

    // Batch fetch all payment allocations for these accounts' schedules
    const scheduleIds = allSchedules.map((s: any) => s.id);
    let allAllocations: any[] = [];
    for (let i = 0; i < scheduleIds.length; i += 50) {
      const chunk = scheduleIds.slice(i, i + 50);
      const { data: allocs } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, payment_id, allocation_type")
        .in("schedule_id", chunk)
        .eq("allocation_type", "installment")
        .limit(10000);
      if (allocs) allAllocations = allAllocations.concat(allocs);
    }

    // Build valid payment ID set (non-voided)
    const validPaymentIds = new Set(allPayments.map((p: any) => p.id));

    // Index by account
    const payByAcct: Record<string, any[]> = {};
    for (const p of allPayments) {
      (payByAcct[p.account_id] ||= []).push(p);
    }
    const schedByAcct: Record<string, any[]> = {};
    for (const s of allSchedules) {
      (schedByAcct[s.account_id] ||= []).push(s);
    }
    // Index allocations by schedule_id AND by payment_id, filtered to non-voided payments only
    const allocBySchedule: Record<string, any[]> = {};
    const allocByPayment: Record<string, any[]> = {};
    for (const a of allAllocations) {
      if (validPaymentIds.has(a.payment_id)) {
        (allocBySchedule[a.schedule_id] ||= []).push(a);
        (allocByPayment[a.payment_id] ||= []).push(a);
      }
    }

    const fixes: any[] = [];
    let scheduleRowsFixed = 0;
    let allocationsCreated = 0;
    const today = new Date().toISOString().split("T")[0];

    for (const acct of accounts) {
      const payments = (payByAcct[acct.id] || []).sort(
        (a: any, b: any) => a.date_paid.localeCompare(b.date_paid)
      );
      const schedule = (schedByAcct[acct.id] || []).sort(
        (a: any, b: any) => a.installment_number - b.installment_number
      );

      // ── Step 0: Create missing allocations for unallocated payments ──
      // Identify payments that have NO allocation records at all
      const unallocatedPayments = payments.filter((p: any) => {
        const allocs = allocByPayment[p.id];
        return !allocs || allocs.length === 0;
      });

      if (unallocatedPayments.length > 0) {
        // Build current allocation state per schedule row
        const schedAllocated: Record<string, number> = {};
        for (const s of schedule) {
          const allocs = allocBySchedule[s.id] || [];
          schedAllocated[s.id] = allocs.reduce((sum: number, a: any) => sum + Number(a.allocated_amount), 0);
        }

        for (const payment of unallocatedPayments) {
          let remaining = Number(payment.amount_paid);

          // Check if this is a downpayment (skip - downpayments don't allocate to schedule)
          const isDownpayment = (payment.remarks || "").toLowerCase().includes("downpayment");
          if (isDownpayment) continue;

          // Allocate chronologically to schedule rows that still need payment
          for (const sched of schedule) {
            if (remaining <= 0) break;
            const base = Number(sched.base_installment_amount);
            const alreadyAllocated = schedAllocated[sched.id] || 0;
            const needed = Math.max(0, base - alreadyAllocated);

            if (needed > 0) {
              const toAllocate = Math.min(remaining, needed);
              const { error: insertErr } = await supabase
                .from("payment_allocations")
                .insert({
                  payment_id: payment.id,
                  schedule_id: sched.id,
                  allocated_amount: toAllocate,
                  allocation_type: "installment",
                });

              if (!insertErr) {
                allocationsCreated++;
                schedAllocated[sched.id] = alreadyAllocated + toAllocate;
                // Update local index so schedule sync below picks it up
                const newAlloc = { payment_id: payment.id, schedule_id: sched.id, allocated_amount: toAllocate, allocation_type: "installment" };
                (allocBySchedule[sched.id] ||= []).push(newAlloc);
                remaining -= toAllocate;
              }
            }
          }
        }
      }

      // ACCOUNT TOTALS: total_paid = SUM(actual non-voided payments)
      const correctTotalPaid = payments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);

      // PRINCIPAL-ONLY remaining: exclude penalty payments from remaining balance calculation
      const { data: paidPenalties } = await supabase
        .from("penalty_fees")
        .select("penalty_amount")
        .eq("account_id", acct.id)
        .eq("status", "paid");
      const penaltyPaidSum = (paidPenalties || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
      const correctRemaining = Math.max(0, Number(acct.total_amount) - (correctTotalPaid - penaltyPaidSum));

      const accountNeedsUpdate =
        Math.abs(Number(acct.total_paid) - correctTotalPaid) > 0.01 ||
        Math.abs(Number(acct.remaining_balance) - correctRemaining) > 0.01;

      // SCHEDULE SYNC: recalculate paid_amount per row from allocations
      for (const sched of schedule) {
        const allocations = allocBySchedule[sched.id] || [];
        const correctPaidAmount = allocations.reduce((s: number, a: any) => s + Number(a.allocated_amount), 0);
        const base = Number(sched.base_installment_amount);

        let correctStatus = sched.status;
        if (correctPaidAmount >= base && base > 0) {
          correctStatus = "paid";
        } else if (correctPaidAmount > 0 && correctPaidAmount < base) {
          correctStatus = "partially_paid";
        } else if (sched.due_date < today && correctPaidAmount === 0) {
          correctStatus = "overdue";
        } else if (correctPaidAmount === 0) {
          correctStatus = "pending";
        }

        const schedNeedsUpdate =
          Math.abs(Number(sched.paid_amount) - correctPaidAmount) > 0.01 ||
          sched.status !== correctStatus;

        if (schedNeedsUpdate) {
          await supabase.from("layaway_schedule").update({
            paid_amount: correctPaidAmount,
            status: correctStatus,
          }).eq("id", sched.id);
          scheduleRowsFixed++;
        }
      }

      if (accountNeedsUpdate) {
        const hasOverdue = schedule.some((r: any) => {
          const allocs = allocBySchedule[r.id] || [];
          const paidAmt = allocs.reduce((s: number, a: any) => s + Number(a.allocated_amount), 0);
          return r.due_date < today && paidAmt < Number(r.base_installment_amount);
        });
        
        await supabase.from("layaway_accounts").update({
          remaining_balance: correctRemaining,
          total_paid: correctTotalPaid,
          status: hasOverdue ? "overdue" : acct.status,
          updated_at: new Date().toISOString(),
        }).eq("id", acct.id);

        fixes.push({
          invoice: acct.invoice_number,
          old_remaining: Number(acct.remaining_balance),
          new_remaining: correctRemaining,
          old_total_paid: Number(acct.total_paid),
          new_total_paid: correctTotalPaid,
        });
      }
    }

    return new Response(JSON.stringify({
      message: "Account totals and schedule allocations corrected",
      accounts_processed: accounts.length,
      accounts_fixed: fixes.length,
      schedule_rows_fixed: scheduleRowsFixed,
      allocations_created: allocationsCreated,
      offset,
      next_offset: offset + limit,
      done: accounts.length < limit,
      fixes,
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
