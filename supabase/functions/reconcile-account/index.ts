import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reconcile a single layaway account using payments as the source of truth.
 *
 * Steps:
 *   1. Create missing payment_allocations for unallocated payments
 *      (allocates chronologically to schedule rows, skips downpayments)
 *   2. Sync layaway_schedule paid_amount and status from allocations
 *   3. Auto-waive unpaid penalty_fees on schedule rows that are now paid
 *      (these penalties were incorrectly generated while the row appeared overdue)
 *   4. Recalculate layaway_accounts.total_paid and remaining_balance
 *      using canonical formula: total_amount + activePenalties + services - totalPaid
 *
 * Body: { account_id?: string, invoice_number?: string }
 * Returns: summary object with changes made
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    let { account_id, invoice_number } = body;

    // Resolve account_id from invoice_number if needed
    if (!account_id && invoice_number) {
      const { data: found } = await supabase
        .from("layaway_accounts")
        .select("id")
        .eq("invoice_number", String(invoice_number))
        .single();
      if (!found) throw new Error(`Account not found: ${invoice_number}`);
      account_id = found.id;
    }
    if (!account_id) throw new Error("account_id or invoice_number required");

    // ── 0. Load all data for this account ─────────────────────────────────────
    const [
      { data: account },
      { data: schedule },
      { data: payments },
      { data: penalties },
      { data: services },
    ] = await Promise.all([
      supabase
        .from("layaway_accounts")
        .select("id, invoice_number, total_amount, total_paid, remaining_balance, status")
        .eq("id", account_id)
        .single(),
      supabase
        .from("layaway_schedule")
        .select("id, installment_number, due_date, base_installment_amount, penalty_amount, total_due_amount, paid_amount, status")
        .eq("account_id", account_id)
        .neq("status", "cancelled")
        .order("installment_number"),
      supabase
        .from("payments")
        .select("id, amount_paid, date_paid, payment_type, is_downpayment, reference_number, remarks")
        .eq("account_id", account_id)
        .is("voided_at", null),
      supabase
        .from("penalty_fees")
        .select("id, schedule_id, penalty_amount, penalty_date, status")
        .eq("account_id", account_id),
      supabase
        .from("account_services")
        .select("amount")
        .eq("account_id", account_id),
    ]);

    if (!account) throw new Error(`Account ${account_id} not found`);

    const scheduleRows: any[] = schedule || [];
    const paymentRows: any[] = payments || [];
    const penaltyRows: any[] = penalties || [];
    const serviceRows: any[] = services || [];
    const scheduleIds = scheduleRows.map((s) => s.id);
    const today = new Date().toISOString().split("T")[0];

    // Load payment_allocations for this account's schedule rows
    const allocRows: any[] = [];
    if (scheduleIds.length > 0) {
      for (let i = 0; i < scheduleIds.length; i += 200) {
        const chunk = scheduleIds.slice(i, i + 200);
        const { data: allocs } = await supabase
          .from("payment_allocations")
          .select("payment_id, schedule_id, allocated_amount")
          .in("schedule_id", chunk)
          .eq("allocation_type", "installment");
        if (allocs) allocRows.push(...allocs);
      }
    }

    const validPaymentIds = new Set(paymentRows.map((p) => p.id));

    // Build allocation sums per schedule row (non-voided payments only)
    const allocBySchedule: Record<string, number> = {};
    // Track which payments already have allocations
    const allocatedPaymentIds = new Set<string>();
    for (const a of allocRows) {
      if (!validPaymentIds.has(a.payment_id)) continue;
      allocBySchedule[a.schedule_id] = (allocBySchedule[a.schedule_id] || 0) + Number(a.allocated_amount);
      allocatedPaymentIds.add(a.payment_id);
    }

    const summary = {
      account_id,
      invoice_number: account.invoice_number,
      allocations_created: 0,
      schedule_rows_fixed: 0,
      penalties_waived: 0,
      account_totals_updated: false,
      changes: [] as string[],
    };

    // ── 1. Create missing allocations for unallocated payments ────────────────
    // Skip downpayments (they don't allocate to schedule installments).
    // Allocate remaining payments chronologically to schedule rows.
    const unallocated = paymentRows.filter((p) => !allocatedPaymentIds.has(p.id) && !isDownpayment(p));

    if (unallocated.length > 0) {
      const schedAllocated = { ...allocBySchedule };
      const sortedSchedule = [...scheduleRows].sort((a, b) => a.installment_number - b.installment_number);
      const sortedPayments = [...unallocated].sort((a, b) => a.date_paid.localeCompare(b.date_paid));

      for (const payment of sortedPayments) {
        let remaining = Number(payment.amount_paid);

        for (const sched of sortedSchedule) {
          if (remaining <= 0.005) break;
          const base = Number(sched.base_installment_amount);
          const alreadyAllocated = schedAllocated[sched.id] || 0;
          const needed = Math.max(0, base - alreadyAllocated);

          if (needed > 0.005) {
            const toAllocate = Math.min(remaining, needed);
            const { error } = await supabase.from("payment_allocations").insert({
              payment_id: payment.id,
              schedule_id: sched.id,
              allocated_amount: toAllocate,
              allocation_type: "installment",
            });
            if (!error) {
              schedAllocated[sched.id] = alreadyAllocated + toAllocate;
              allocBySchedule[sched.id] = schedAllocated[sched.id];
              summary.allocations_created++;
              summary.changes.push(
                `Allocation created: payment …${payment.id.slice(-6)} → installment #${sched.installment_number} ₱${toAllocate}`
              );
              remaining -= toAllocate;
            }
          }
        }
      }
    }

    // ── 2. Sync schedule paid_amount and status from allocations ──────────────
    // Track which rows transition to 'paid' so we can auto-waive their penalties
    const newlyPaidIds = new Set<string>();

    for (const sched of scheduleRows) {
      const correctPaid = allocBySchedule[sched.id] || 0;
      const base = Number(sched.base_installment_amount);

      let correctStatus: string;
      if (base > 0 && correctPaid >= base) {
        correctStatus = "paid";
      } else if (correctPaid > 0 && correctPaid < base) {
        correctStatus = "partially_paid";
      } else if (correctPaid === 0 && sched.due_date < today) {
        correctStatus = "overdue";
      } else {
        correctStatus = "pending";
      }

      const wasAlreadyPaid = sched.status === "paid";
      const paidAmountChanged = Math.abs(Number(sched.paid_amount) - correctPaid) > 0.01;
      const statusChanged = sched.status !== correctStatus;

      if (paidAmountChanged || statusChanged) {
        const update: any = {
          paid_amount: correctPaid,
          status: correctStatus,
          updated_at: new Date().toISOString(),
        };

        // When a row transitions to 'paid', strip the pending penalties from the schedule row
        // (the penalty_fees themselves will be waived in step 3)
        if (correctStatus === "paid" && !wasAlreadyPaid) {
          update.penalty_amount = 0;
          update.total_due_amount = base;
          newlyPaidIds.add(sched.id);
        }

        await supabase.from("layaway_schedule").update(update).eq("id", sched.id);
        summary.schedule_rows_fixed++;
        summary.changes.push(
          `Installment #${sched.installment_number}: ${sched.status}/${Number(sched.paid_amount)} → ${correctStatus}/${correctPaid}`
        );
      }
    }

    // ── 3. Auto-waive unpaid penalties on newly-paid schedule rows ─────────────
    // These penalties were generated while the installment appeared overdue
    // due to missing allocations. Now that it's confirmed paid, waive them.
    // Only waives 'unpaid' penalties — 'paid' penalties are kept (already collected).
    if (newlyPaidIds.size > 0) {
      const unpaidOnNewlyPaid = penaltyRows.filter(
        (p) => newlyPaidIds.has(p.schedule_id) && p.status === "unpaid"
      );
      for (const pen of unpaidOnNewlyPaid) {
        await supabase.from("penalty_fees").update({
          status: "waived",
          waived_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", pen.id);
        summary.penalties_waived++;
        summary.changes.push(
          `Penalty waived: …${pen.id.slice(-6)} ₱${pen.penalty_amount} on installment (schedule …${pen.schedule_id.slice(-6)})`
        );
      }
    }

    // ── 4. Recalculate account totals ─────────────────────────────────────────
    // total_paid = SUM(non-voided payments)
    // remaining_balance = total_amount + activePenalties + services - totalPaid
    //   activePenalties = SUM(penalty_fees WHERE status != 'waived')  ← per CLAUDE.md
    const totalPaid = paymentRows.reduce((s, p) => s + Number(p.amount_paid), 0);

    // Re-fetch penalties after waivers so the sum is current
    const { data: freshPenalties } = await supabase
      .from("penalty_fees")
      .select("penalty_amount, status")
      .eq("account_id", account_id)
      .neq("status", "waived");

    const activePenaltySum = (freshPenalties || []).reduce((s, p: any) => s + Number(p.penalty_amount), 0);
    const serviceSum = serviceRows.reduce((s, sv: any) => s + Number(sv.amount), 0);
    const correctRemaining = Math.max(
      0,
      Number(account.total_amount) + activePenaltySum + serviceSum - totalPaid
    );

    const accountNeedsUpdate =
      Math.abs(Number(account.total_paid) - totalPaid) > 0.01 ||
      Math.abs(Number(account.remaining_balance) - correctRemaining) > 0.01;

    if (accountNeedsUpdate) {
      // Derive correct account status from schedule state
      const finalAllocBySchedule = allocBySchedule;
      const hasOverdue = scheduleRows.some((s) => {
        const paid = finalAllocBySchedule[s.id] || 0;
        return s.due_date < today && paid < Number(s.base_installment_amount);
      });
      const allSchedulePaid = scheduleRows.every((s) => {
        const paid = finalAllocBySchedule[s.id] || 0;
        return paid >= Number(s.base_installment_amount);
      });

      let correctStatus = account.status;
      if (allSchedulePaid && correctRemaining <= 0.01) {
        correctStatus = "completed";
      } else if (hasOverdue && ["active", "overdue"].includes(account.status)) {
        correctStatus = "overdue";
      } else if (!hasOverdue && account.status === "overdue") {
        correctStatus = "active";
      }

      await supabase.from("layaway_accounts").update({
        total_paid: totalPaid,
        remaining_balance: correctRemaining,
        status: correctStatus,
        updated_at: new Date().toISOString(),
      }).eq("id", account_id);

      summary.account_totals_updated = true;
      summary.changes.push(
        `Account totals: total_paid ${account.total_paid}→${totalPaid}, remaining ${account.remaining_balance}→${correctRemaining}`
      );
      if (correctStatus !== account.status) {
        summary.changes.push(`Account status: ${account.status}→${correctStatus}`);
      }
    }

    console.log(
      `[reconcile-account] ${account.invoice_number}: ` +
      `${summary.allocations_created} allocations, ` +
      `${summary.schedule_rows_fixed} rows fixed, ` +
      `${summary.penalties_waived} penalties waived`
    );

    return new Response(JSON.stringify({ ok: true, ...summary }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("reconcile-account error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/**
 * Identify downpayment records so they are excluded from installment allocation.
 * Per CLAUDE.md Known Issues: check multiple fields.
 */
function isDownpayment(p: any): boolean {
  const remarks = (p.remarks || "").toLowerCase();
  const ref = (p.reference_number || "").toLowerCase();
  return (
    p.payment_type === "downpayment" ||
    p.payment_type === "dp" ||
    p.is_downpayment === true ||
    ref.startsWith("dp-") ||
    remarks.includes("down") ||
    remarks.includes("dp")
  );
}
