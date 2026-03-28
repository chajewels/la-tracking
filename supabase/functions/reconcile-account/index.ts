import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isDownpaymentPayment(pay: any): boolean {
  if (pay.reference_number && pay.reference_number.toUpperCase().startsWith("DP-")) return true;
  if (pay.remarks) {
    const r = pay.remarks.toLowerCase();
    if (r.includes("down") || r.includes("dp")) return true;
  }
  if (pay.payment_type === "downpayment" || pay.payment_type === "dp") return true;
  if (pay.is_downpayment === true) return true;
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { invoice_number, account_id } = body;

    if (!invoice_number && !account_id) {
      return new Response(JSON.stringify({ error: "invoice_number or account_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Find the account
    let query = supabase
      .from("layaway_accounts")
      .select("id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, downpayment_amount, payment_plan_months, customers!inner(full_name)");

    if (invoice_number) {
      query = query.eq("invoice_number", invoice_number);
    } else {
      query = query.eq("id", account_id);
    }

    const { data: acctData, error: acctErr } = await query.maybeSingle();
    if (acctErr || !acctData) {
      return new Response(JSON.stringify({ error: acctErr?.message || "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const acct = acctData;
    const changes: string[] = [];

    // Fetch schedule rows (non-cancelled), sorted by installment_number
    const { data: schedules } = await supabase
      .from("layaway_schedule")
      .select("id, installment_number, due_date, base_installment_amount, penalty_amount, total_due_amount, paid_amount, status, currency")
      .eq("account_id", acct.id)
      .neq("status", "cancelled")
      .order("installment_number", { ascending: true });

    if (!schedules || schedules.length === 0) {
      return new Response(JSON.stringify({ ok: true, account_id: acct.id, invoice_number: acct.invoice_number, allocations_created: 0, schedule_rows_fixed: 0, penalties_waived: 0, account_totals_updated: false, changes: ["No schedule rows found"] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch non-voided payments sorted by date
    const { data: payments } = await supabase
      .from("payments")
      .select("id, amount_paid, date_paid, currency, reference_number, remarks, payment_method")
      .eq("account_id", acct.id)
      .is("voided_at", null)
      .order("date_paid", { ascending: true })
      .order("created_at", { ascending: true });

    // Fetch existing allocations
    const { data: existingAllocations } = await supabase
      .from("payment_allocations")
      .select("id, payment_id, schedule_id, allocated_amount, allocation_type");

    const allocatedPaymentIds = new Set((existingAllocations || []).map((a: any) => a.payment_id));

    // Fetch penalty fees
    const { data: penalties } = await supabase
      .from("penalty_fees")
      .select("id, schedule_id, penalty_amount, status, penalty_stage, penalty_cycle")
      .eq("account_id", acct.id);

    // Fetch services
    const { data: services } = await supabase
      .from("account_services")
      .select("amount")
      .eq("account_id", acct.id);

    const servicesSum = (services || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);

    // ═══════════════════════════════════════════════════
    // STEP 1: Create allocations for unallocated payments
    // ═══════════════════════════════════════════════════
    let allocationsCreated = 0;
    const unallocatedPayments = (payments || []).filter((p: any) => !allocatedPaymentIds.has(p.id));

    // Separate DP payments from installment payments
    const dpPayments = unallocatedPayments.filter((p: any) => isDownpaymentPayment(p));
    const installmentPayments = unallocatedPayments.filter((p: any) => !isDownpaymentPayment(p));

    // For installment payments, allocate chronologically to schedule rows
    // Build a mutable copy of schedule paid amounts from existing allocations
    const schedAllocated: Record<string, number> = {};
    for (const s of schedules) {
      schedAllocated[s.id] = 0;
    }
    // Sum existing allocations per schedule
    for (const alloc of (existingAllocations || [])) {
      if (schedAllocated[alloc.schedule_id] !== undefined) {
        schedAllocated[alloc.schedule_id] += Number(alloc.allocated_amount);
      }
    }

    for (const pay of installmentPayments) {
      let remaining = Number(pay.amount_paid);

      for (const sched of schedules) {
        if (remaining <= 0.01) break;

        const alreadyAllocated = schedAllocated[sched.id] || 0;
        const totalDue = Number(sched.total_due_amount);
        const capacity = Math.max(0, totalDue - alreadyAllocated);

        if (capacity <= 0.01) continue;

        const allocAmt = Math.min(remaining, capacity);
        const allocType = Number(sched.penalty_amount) > 0 ? "penalty" : "installment";

        const { error: allocErr } = await supabase
          .from("payment_allocations")
          .insert({
            payment_id: pay.id,
            schedule_id: sched.id,
            allocated_amount: Math.round(allocAmt * 100) / 100,
            allocation_type: allocType,
          });

        if (!allocErr) {
          allocationsCreated++;
          schedAllocated[sched.id] = (schedAllocated[sched.id] || 0) + allocAmt;
          remaining -= allocAmt;
          changes.push(`Allocated ₱${allocAmt.toFixed(2)} from payment ${pay.id.slice(0, 8)} to inst #${sched.installment_number}`);
        }
      }
    }

    // ═══════════════════════════════════════════════════
    // STEP 2: Recompute schedule paid_amount and status from allocations
    // ═══════════════════════════════════════════════════
    // Re-fetch all allocations after creating new ones
    const { data: allAllocations } = await supabase
      .from("payment_allocations")
      .select("schedule_id, allocated_amount")
      .in("schedule_id", schedules.map((s: any) => s.id));

    // Also include DP payments and non-DP payments for total paid calc
    const totalPaidFromPayments = (payments || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);

    // Sum allocations per schedule
    const allocBySchedule: Record<string, number> = {};
    for (const a of (allAllocations || [])) {
      allocBySchedule[a.schedule_id] = (allocBySchedule[a.schedule_id] || 0) + Number(a.allocated_amount);
    }

    let scheduleRowsFixed = 0;

    for (const sched of schedules) {
      const allocatedTotal = allocBySchedule[sched.id] || 0;
      const totalDue = Number(sched.total_due_amount);
      const oldPaid = Number(sched.paid_amount);
      const oldStatus = sched.status;

      // Determine new status
      let newStatus = oldStatus;
      let newPaid = allocatedTotal;

      // If allocatedTotal > 0 but no allocations exist (DP-only accounts or legacy),
      // keep existing paid_amount if it's higher
      if (allocatedTotal < 0.01 && oldPaid > 0.01) {
        newPaid = oldPaid; // preserve existing
      }

      if (newPaid >= totalDue - 0.01 && totalDue > 0) {
        newStatus = "paid";
        newPaid = totalDue; // exact match to prevent ghost amounts
      } else if (newPaid > 0.01) {
        newStatus = "partially_paid";
      } else if (oldStatus === "paid" || oldStatus === "partially_paid") {
        // Don't downgrade if we have no allocation data but row was marked paid
        // (legacy data without allocations)
        newStatus = oldStatus;
        newPaid = oldPaid;
      }

      const statusChanged = newStatus !== oldStatus;
      const paidChanged = Math.abs(newPaid - oldPaid) > 0.01;

      if (statusChanged || paidChanged) {
        const updateData: any = {};
        if (paidChanged) updateData.paid_amount = Math.round(newPaid * 100) / 100;
        if (statusChanged) updateData.status = newStatus;

        // If transitioning to paid, reset penalty_amount on schedule row
        if (newStatus === "paid" && oldStatus !== "paid") {
          updateData.penalty_amount = 0;
          updateData.total_due_amount = Number(sched.base_installment_amount);
        }

        await supabase
          .from("layaway_schedule")
          .update(updateData)
          .eq("id", sched.id);

        scheduleRowsFixed++;
        changes.push(`Installment #${sched.installment_number}: ${oldStatus}/${oldPaid} → ${newStatus}/${Math.round(newPaid * 100) / 100}`);
      }
    }

    // ═══════════════════════════════════════════════════
    // STEP 3: Auto-waive unpaid penalties on newly-paid rows
    // ═══════════════════════════════════════════════════
    let penaltiesWaived = 0;

    // Re-fetch schedule statuses after updates
    const { data: updatedSchedules } = await supabase
      .from("layaway_schedule")
      .select("id, status")
      .eq("account_id", acct.id)
      .neq("status", "cancelled");

    const paidScheduleIds = new Set(
      (updatedSchedules || []).filter((s: any) => s.status === "paid").map((s: any) => s.id)
    );

    for (const pen of (penalties || [])) {
      if (pen.status === "unpaid" && paidScheduleIds.has(pen.schedule_id)) {
        await supabase
          .from("penalty_fees")
          .update({ status: "waived", waived_at: new Date().toISOString() })
          .eq("id", pen.id);

        penaltiesWaived++;
        changes.push(`Waived unpaid penalty ₱${pen.penalty_amount} on schedule ${pen.schedule_id.slice(0, 8)} (installment now paid)`);
      }
    }

    // ═══════════════════════════════════════════════════
    // STEP 4: Recalculate account totals
    // ═══════════════════════════════════════════════════
    // Re-fetch penalties after waivers
    const { data: finalPenalties } = await supabase
      .from("penalty_fees")
      .select("penalty_amount, status")
      .eq("account_id", acct.id);

    const activePenalties = (finalPenalties || [])
      .filter((p: any) => p.status !== "waived")
      .reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);

    const computedBalance = Math.max(0,
      Number(acct.total_amount) + activePenalties + servicesSum - totalPaidFromPayments
    );
    const computedBalance2dp = Math.round(computedBalance * 100) / 100;
    const totalPaid2dp = Math.round(totalPaidFromPayments * 100) / 100;

    const oldBalance = Number(acct.remaining_balance);
    const oldTotalPaid = Number(acct.total_paid);

    let accountTotalsUpdated = false;
    const updateFields: any = {};

    if (Math.abs(totalPaid2dp - oldTotalPaid) > 0.01) {
      updateFields.total_paid = totalPaid2dp;
    }
    if (Math.abs(computedBalance2dp - oldBalance) > 0.01) {
      updateFields.remaining_balance = computedBalance2dp;
    }

    // ═══════════════════════════════════════════════════
    // STEP 5: Status logic
    // ═══════════════════════════════════════════════════
    const allPaid = (updatedSchedules || []).every((s: any) => s.status === "paid");

    if (allPaid && computedBalance2dp <= 0.01) {
      if (acct.status !== "completed") {
        updateFields.status = "completed";
        changes.push(`Account status → completed (all installments paid, balance ≤ 0.01)`);
      }
    } else if (["active", "overdue"].includes(acct.status)) {
      const hasOverdue = (updatedSchedules || []).some((s: any) => s.status === "overdue");
      if (hasOverdue && acct.status !== "overdue") {
        updateFields.status = "overdue";
        changes.push(`Account status → overdue`);
      } else if (!hasOverdue && acct.status === "overdue") {
        updateFields.status = "active";
        changes.push(`Account status → active (no overdue rows)`);
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await supabase
        .from("layaway_accounts")
        .update(updateFields)
        .eq("id", acct.id);
      accountTotalsUpdated = true;

      if (updateFields.total_paid !== undefined || updateFields.remaining_balance !== undefined) {
        changes.push(`Account totals: paid ${oldTotalPaid}→${updateFields.total_paid ?? oldTotalPaid}, balance ${oldBalance}→${updateFields.remaining_balance ?? oldBalance}`);
      }
    }

    const result = {
      ok: true,
      account_id: acct.id,
      invoice_number: acct.invoice_number,
      allocations_created: allocationsCreated,
      schedule_rows_fixed: scheduleRowsFixed,
      penalties_waived: penaltiesWaived,
      account_totals_updated: accountTotalsUpdated,
      changes,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
