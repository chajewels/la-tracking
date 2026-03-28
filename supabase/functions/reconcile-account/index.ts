import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reconcile a single layaway account using payments as the source of truth.
 *
 * Steps:
 *   0b. Delete oversized allocations (single alloc > base for that row) so the
 *       waterfall in Step 1 can redistribute them correctly across subsequent rows.
 *   1. Create missing payment_allocations for unallocated payments
 *      (allocates chronologically to schedule rows, skips downpayments)
 *   2. Sync layaway_schedule paid_amount, total_due_amount and status from allocations
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

    // ── 0. Load all data for this account ─────────────────────────────────────────────
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

    // Build validPaymentIds BEFORE loading allocations so we can filter the
    // query itself — prevents cross-account allocations (payment from another
    // account that was incorrectly allocated to this account's schedule rows)
    // from being counted in allocBySchedule and inflating paid_amounts.
    //
    // CRITICAL: Every place that sums payment_allocations MUST enforce that
    //   payment_allocations.payment_id → payments.account_id = THIS account.
    // We achieve this by:
    //   (a) validPaymentIds: Set of non-voided payment IDs for THIS account only
    //       (used as a guard in the in-memory allocBySchedule build loop)
    //   (b) validPaymentIdList: deduplicated list used to filter the DB query
    //       so allocRows never contains a cross-account allocation to begin with
    const validPaymentIds = new Set(paymentRows.map((p) => p.id));
    // Deduplicate to prevent any payment appearing in multiple chunk windows,
    // which would cause its allocations to be fetched and counted twice.
    const validPaymentIdList = Array.from(validPaymentIds);

    // Load payment_allocations scoped to BOTH this account's schedule rows AND
    // this account's payments. Both dimensions are chunked at 100 (conservative,
    // well inside PostgREST URL limits even with long UUIDs).
    // An allocation has exactly one schedule_id and one payment_id, so it will
    // appear in exactly one (schedChunk × payChunk) combination — no duplicates.
    const allocRows: any[] = [];
    if (scheduleIds.length > 0 && validPaymentIdList.length > 0) {
      for (let i = 0; i < scheduleIds.length; i += 100) {
        const schedChunk = scheduleIds.slice(i, i + 100);
        for (let j = 0; j < validPaymentIdList.length; j += 100) {
          const payChunk = validPaymentIdList.slice(j, j + 100);
          const { data: allocs } = await supabase
            .from("payment_allocations")
            .select("id, payment_id, schedule_id, allocated_amount")
            .in("schedule_id", schedChunk)
            .in("payment_id", payChunk)
            .eq("allocation_type", "installment");
          if (allocs) allocRows.push(...allocs);
        }
      }
    }

    // Build a base-amount lookup for quick access
    const baseBySchedule: Record<string, number> = {};
    for (const s of scheduleRows) {
      baseBySchedule[s.id] = Number(s.base_installment_amount);
    }

    const summary = {
      account_id,
      invoice_number: account.invoice_number,
      oversized_allocations_fixed: 0,
      allocations_created: 0,
      schedule_rows_fixed: 0,
      penalties_waived: 0,
      account_totals_updated: false,
      changes: [] as string[],
    };

    // ── 0b. Delete oversized allocations so the waterfall can redistribute ────
    // record-payment may store an entire overflow amount in a single allocation
    // (e.g. ₱7,914 against a ₱3,014 base), leaving subsequent rows unallocated.
    // Delete them so Step 1 re-allocates the full payment correctly across rows.
    const oversizedAllocs = allocRows.filter(
      (a) =>
        validPaymentIds.has(a.payment_id) &&
        Number(a.allocated_amount) > (baseBySchedule[a.schedule_id] || 0) + 0.005
    );

    if (oversizedAllocs.length > 0) {
      for (const a of oversizedAllocs) {
        await supabase.from("payment_allocations").delete().eq("id", a.id);
        summary.oversized_allocations_fixed++;
        summary.changes.push(
          `Deleted oversized allocation: payment …${a.payment_id.slice(-6)} → schedule …${a.schedule_id.slice(-6)} ` +
          `was ₱${a.allocated_amount} (base ₱${baseBySchedule[a.schedule_id]})`
        );
      }
      // Remove deleted entries from allocRows so sums below reflect reality
      const deletedIds = new Set(oversizedAllocs.map((a) => a.id));
      allocRows.splice(0, allocRows.length, ...allocRows.filter((a) => !deletedIds.has(a.id)));
    }

    // Build allocation sums per schedule row AND per payment (non-voided payments only)
    const allocBySchedule: Record<string, number> = {};
    const allocByPayment: Record<string, number> = {};
    for (const a of allocRows) {
      if (!validPaymentIds.has(a.payment_id)) continue;
      allocBySchedule[a.schedule_id] = (allocBySchedule[a.schedule_id] || 0) + Number(a.allocated_amount);
      allocByPayment[a.payment_id]   = (allocByPayment[a.payment_id]   || 0) + Number(a.allocated_amount);
    }

    // ── 1. Create missing allocations for unallocated payments ────────────────────────
    // Skip downpayments (they don't allocate to schedule installments).
    // Include any non-DP payment where SUM(allocations) < amount_paid — this
    // handles both fully-unallocated payments AND partially-allocated ones
    // (e.g. a prior partial allocation left a gap, or an oversized alloc was deleted above).
    const needsAllocation = paymentRows.filter((p) => {
      if (isDownpayment(p)) return false;
      const allocated = allocByPayment[p.id] || 0;
      return allocated < Number(p.amount_paid) - 0.005; // > ₱0.005 unallocated
    });

    if (needsAllocation.length > 0) {
      const schedAllocated = { ...allocBySchedule };
      const sortedSchedule = [...scheduleRows].sort((a, b) => a.installment_number - b.installment_number);
      const sortedPayments = [...needsAllocation].sort((a, b) => a.date_paid.localeCompare(b.date_paid));

      for (const payment of sortedPayments) {
        // Start from the REMAINING unallocated portion, not the full amount.
        // This correctly handles payments that are partially allocated already.
        const alreadyAllocated = allocByPayment[payment.id] || 0;
        let remaining = Number(payment.amount_paid) - alreadyAllocated;

        for (const sched of sortedSchedule) {
          if (remaining <= 0.005) break;
          const base = Number(sched.base_installment_amount);
          const schedSoFar = schedAllocated[sched.id] || 0;
          const needed = Math.max(0, base - schedSoFar);

          if (needed > 0.005) {
            const toAllocate = Math.min(remaining, needed);
            const { error } = await supabase.from("payment_allocations").insert({
              payment_id: payment.id,
              schedule_id: sched.id,
              allocated_amount: toAllocate,
              allocation_type: "installment",
            });
            if (!error) {
              schedAllocated[sched.id] = schedSoFar + toAllocate;
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

    // ── 2. Sync schedule paid_amount, total_due_amount and status ─────────────────
    // Track which rows transition to 'paid' so we can auto-waive their penalties
    const newlyPaidIds = new Set<string>();

    for (const sched of scheduleRows) {
      const allocSum = allocBySchedule[sched.id] || 0;
      const base = Number(sched.base_installment_amount);
      const currentTotalDue = Number(sched.total_due_amount);
      const currentPenalty = Number(sched.penalty_amount) || 0;

      // A row is fully paid when allocation sum covers the base installment amount.
      // Cap paid_amount at base — never store overflow.
      //
      // NOTE: The old code had a second condition:
      //   (base > 0 && currentTotalDue <= 0.005)
      // This was meant to handle advance-credit rows where record-payment zeroed
      // total_due_amount without creating an allocation. It has been REMOVED because:
      //   1. Step 1 above now creates proper allocations for any unallocated payment,
      //      including advance-credit rows — allocSum will be >= base after Step 1.
      //   2. The condition caused a second inflation vector: if total_due_amount was
      //      zeroed by a previous bad reconcile run (not by a real payment), the row
      //      would be permanently marked 'paid' with paid_amount = base even with
      //      zero allocations, inflating paid_amount on every reconcile call.
      const fullyPaid = base > 0 && allocSum >= base - 0.005;

      const correctPaid = fullyPaid ? base : Math.min(allocSum, base);

      // Compute correct total_due_amount:
      //   paid:           base (normalised — penalties cleared)
      //   partially_paid: base - paid (remaining base owed)
      //   pending/overdue: base + penalty (full amount still owed)
      let correctStatus: string;
      let correctTotalDue: number;

      if (fullyPaid) {
        correctStatus = "paid";
        correctTotalDue = base;
      } else if (correctPaid > 0) {
        correctStatus = "partially_paid";
        correctTotalDue = base - correctPaid;
      } else if (sched.due_date < today) {
        correctStatus = "overdue";
        correctTotalDue = base + currentPenalty;
      } else {
        correctStatus = "pending";
        correctTotalDue = base + currentPenalty;
      }

      const wasAlreadyPaid = sched.status === "paid";
      const paidAmountChanged = Math.abs(Number(sched.paid_amount) - correctPaid) > 0.01;
      const statusChanged = sched.status !== correctStatus;
      const totalDueChanged = Math.abs(currentTotalDue - correctTotalDue) > 0.01;

      if (paidAmountChanged || statusChanged || totalDueChanged) {
        const update: any = {
          paid_amount: correctPaid,
          status: correctStatus,
          total_due_amount: correctTotalDue,
          updated_at: new Date().toISOString(),
        };

        if (correctStatus === "paid" && !wasAlreadyPaid) {
          // Only strip pending penalties on the first transition to paid
          update.penalty_amount = 0;
          newlyPaidIds.add(sched.id);
        }

        await supabase.from("layaway_schedule").update(update).eq("id", sched.id);
        summary.schedule_rows_fixed++;
        summary.changes.push(
          `Installment #${sched.installment_number}: ${sched.status}/${Number(sched.paid_amount)} → ${correctStatus}/${correctPaid} (total_due: ${currentTotalDue}→${correctTotalDue})`
        );
      }
    }

    // ── 3. Auto-waive unpaid penalties on newly-paid schedule rows ─────────────────
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

    // ── 4. Recalculate account totals ────────────────────────────────────────────────────────
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
      `${summary.oversized_allocations_fixed} oversized fixed, ` +
      `${summary.allocations_created} allocations created, ` +
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
