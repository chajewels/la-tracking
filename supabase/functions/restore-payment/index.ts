import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function determineAccountStatus(schedule: any[], currentStatus: string): string {
  if (currentStatus === "cancelled" || currentStatus === "forfeited") return currentStatus;
  const today = new Date().toISOString().split("T")[0];
  let allPaid = true;
  let hasOverdue = false;
  for (const item of schedule) {
    if (item.status === "cancelled") continue;
    if (item.status !== "paid") {
      allPaid = false;
      if (item.due_date <= today) hasOverdue = true;
    }
  }
  if (allPaid) return "completed";
  if (hasOverdue) return "overdue";
  return "active";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function scheduleStatusFor(base: number, paid: number, dueDate: string): string {
  if (round2(paid) >= round2(base)) return "paid";
  if (paid > 0) return "partially_paid";
  const today = new Date().toISOString().split("T")[0];
  return dueDate <= today ? "overdue" : "pending";
}

function isDownpaymentPayment(p: {
  reference_number?: string | null;
  remarks?: string | null;
}): boolean {
  if (p.reference_number && String(p.reference_number).startsWith('DP-')) {
    return true;
  }
  if (p.remarks) {
    const r = String(p.remarks).toLowerCase();
    if (r.includes('down') || r.includes('dp')) {
      return true;
    }
  }
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

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Role check: only admin or finance may restore payments
    const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
    ]);
    if (!isAdmin && !isFinance) {
      return new Response(JSON.stringify({ error: "Admin or finance role required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { payment_id, selected_schedule_ids } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*")
      .eq("id", payment_id)
      .not("voided_at", "is", null)
      .single();

    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found or not voided" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", payment.account_id)
      .single();

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── DP RESTORATION SHORT-CIRCUIT ──
    // DPs don't have payment_allocations rows on this schema
    // (allocation_type enum is 'installment' | 'penalty' only).
    // For DP restoration, just unvoid the payment and recompute
    // account totals — do NOT run the installment waterfall.
    if (isDownpaymentPayment(payment)) {
      const { error: unvoidErr } = await supabase
        .from("payments")
        .update({
          voided_at: null,
          voided_by_user_id: null,
          void_reason: null,
        })
        .eq("id", payment_id);

      if (unvoidErr) {
        console.error("Failed to unvoid DP payment:", unvoidErr);
        return new Response(
          JSON.stringify({
            error: "Could not restore DP payment",
            details: unvoidErr.message,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const accountId = payment.account_id;

      const [paymentsRes, penaltiesRes, servicesRes, accountRes] = await Promise.all([
        supabase.from("payments").select("amount_paid")
          .eq("account_id", accountId).is("voided_at", null),
        supabase.from("penalty_fees").select("penalty_amount")
          .eq("account_id", accountId).neq("status", "waived"),
        supabase.from("account_services" as any).select("amount").eq("account_id", accountId),
        supabase.from("layaway_accounts").select("total_amount").eq("id", accountId).single(),
      ]);

      if (accountRes.error || !accountRes.data) {
        return new Response(
          JSON.stringify({ error: "Could not fetch account for recompute" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const newTotalPaid = round2(
        (paymentsRes.data ?? []).reduce((sum: number, p: any) => sum + Number(p.amount_paid), 0)
      );
      const penaltyTotal = (penaltiesRes.data ?? []).reduce((sum: number, p: any) => sum + Number(p.penalty_amount), 0);
      const serviceTotal = (servicesRes.data ?? []).reduce((sum: number, s: any) => sum + Number(s.amount), 0);
      const totalAmount = Number(accountRes.data.total_amount ?? 0);

      const newRemaining = Math.max(0, round2(
        totalAmount + penaltyTotal + serviceTotal - newTotalPaid
      ));

      const { error: updateErr } = await supabase
        .from("layaway_accounts")
        .update({
          total_paid: newTotalPaid,
          remaining_balance: newRemaining,
        })
        .eq("id", accountId);

      if (updateErr) {
        return new Response(
          JSON.stringify({
            error: "DP unvoided but account totals update failed",
            details: updateErr.message,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      await supabase.from("audit_logs").insert({
        entity_type: "payment",
        entity_id: payment_id,
        action: "restore",
        old_value_json: {
          voided_at: payment.voided_at,
          void_reason: payment.void_reason,
          kind: "downpayment",
        },
        new_value_json: {
          restored_by: user.id,
          kind: "downpayment",
          new_total_paid: newTotalPaid,
          new_remaining_balance: newRemaining,
        },
        performed_by_user_id: user.id,
      });

      // Bug #99 — fire-and-forget loyalty restore for DP restoration.
      // Looks up the revoke transaction by payment_id; if missing (e.g. payment
      // pre-dates loyalty enrollment), logs debug and skips.
      try {
        const { data: revokeTxn } = await supabase
          .from("loyalty_transactions")
          .select("id")
          .eq("payment_id", payment_id)
          .eq("transaction_type", "revoked")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (revokeTxn?.id) {
          await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/restore-loyalty-points`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({
              revoke_transaction_id: revokeTxn.id,
              created_by_user_id: user.id,
            }),
          }).catch((e) => console.warn("[restore-payment] restore-loyalty-points failed (DP path, non-blocking):", e));
        } else {
          console.log(`[restore-payment] no revoke transaction found for DP payment ${payment_id} — skipping loyalty restore`);
        }
      } catch (restoreErr) {
        console.warn("[restore-payment] DP loyalty restore block failed (non-blocking):", restoreErr);
      }

      return new Response(
        JSON.stringify({
          success: true,
          payment_id,
          kind: "downpayment",
          total_paid: newTotalPaid,
          remaining_balance: newRemaining,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // ── END DP SHORT-CIRCUIT ──

    const { data: originalAllocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", payment.account_id)
      .order("installment_number", { ascending: true });

    if (!schedule || schedule.length === 0) {
      return new Response(JSON.stringify({ error: "Schedule not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const selectedIds = Array.isArray(selected_schedule_ids) ? selected_schedule_ids.filter(Boolean) : [];
    const originalInstallmentAllocations = (originalAllocations || []).filter((alloc) => alloc.allocation_type === "installment");
    const originalPenaltyAllocations = (originalAllocations || []).filter((alloc) => alloc.allocation_type === "penalty");

    let remainingInstallmentAmount = round2(Number(payment.amount_paid));

    // Primary targets: selected items first, then all unpaid items for overflow
    const selectedTargets = (selectedIds.length > 0
      ? schedule.filter((item) => selectedIds.includes(item.id))
      : schedule.filter((item) => item.status !== "paid" && item.status !== "cancelled")
    ).sort((a, b) => a.installment_number - b.installment_number);

    // Overflow targets: all remaining unpaid items not already in selectedTargets
    const selectedIdSet = new Set(selectedTargets.map((t) => t.id));
    const overflowTargets = schedule
      .filter((item) => !selectedIdSet.has(item.id) && item.status !== "paid" && item.status !== "cancelled")
      .sort((a, b) => a.installment_number - b.installment_number);

    const allTargets = [...selectedTargets, ...overflowTargets];

    if (allTargets.length === 0 && remainingInstallmentAmount > 0) {
      return new Response(JSON.stringify({ error: "No valid monthly dues available for restore" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── PHASE 1: DRY-RUN — compute all changes without mutating anything ──
    const plannedAllocations: Array<{ schedule_id: string; allocation_type: "penalty" | "installment"; allocated_amount: number }> = [];
    const plannedScheduleUpdates: Array<{ id: string; paid_amount: number; status: string }> = [];
    let dryRunRemaining = remainingInstallmentAmount;

    for (const item of allTargets) {
      if (dryRunRemaining <= 0) break;

      const base = Number(item.base_installment_amount);
      const penalty = Number(item.penalty_amount ?? 0);
      const carried = Number(item.carried_amount ?? 0);
      const paid = Number(item.paid_amount);
      const naturalCeiling = base + penalty + carried;
      const rowCeiling = item.total_due_amount
        ? Math.min(naturalCeiling, Number(item.total_due_amount))
        : naturalCeiling;
      const due = Math.max(0, round2(rowCeiling - paid));
      if (due <= 0) continue;

      const toApply = round2(Math.min(dryRunRemaining, due));
      dryRunRemaining = round2(dryRunRemaining - toApply);

      const newPaid = round2(paid + toApply);
      const newStatus = scheduleStatusFor(base, newPaid, item.due_date);

      plannedScheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: newStatus });
      plannedAllocations.push({
        schedule_id: item.id,
        allocation_type: "installment",
        allocated_amount: toApply,
      });
    }

    // Validate: all installment amount must be covered
    if (dryRunRemaining > 0.01) {
      return new Response(JSON.stringify({ error: "Not enough unpaid monthly dues to fully restore this payment amount" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── PHASE 2: APPLY — all validation passed, now mutate ──

    // Handle penalty allocations
    for (const alloc of originalPenaltyAllocations) {
      const { data: penaltyFees } = await supabase
        .from("penalty_fees")
        .select("*")
        .eq("schedule_id", alloc.schedule_id)
        .eq("status", "unpaid")
        .eq("account_id", payment.account_id)
        .order("created_at", { ascending: true })
        .limit(1);

      if (penaltyFees && penaltyFees.length > 0) {
        await supabase.from("penalty_fees").update({ status: "paid" }).eq("id", penaltyFees[0].id);
        plannedAllocations.push({
          schedule_id: alloc.schedule_id,
          allocation_type: "penalty",
          allocated_amount: Number(alloc.allocated_amount),
        });
      }
    }

    // Apply schedule updates
    for (const update of plannedScheduleUpdates) {
      await supabase.from("layaway_schedule").update({
        paid_amount: update.paid_amount,
        status: update.status,
      }).eq("id", update.id);
    }

    // Recreate allocations
    await supabase.from("payment_allocations").delete().eq("payment_id", payment_id);
    for (const alloc of plannedAllocations) {
      await supabase.from("payment_allocations").insert({
        payment_id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });
    }

    // Clear voided flags BEFORE recalculating totals — the totals query
    // filters is("voided_at", null), so the payment must be unvoided first
    await supabase.from("payments").update({
      voided_at: null,
      voided_by_user_id: null,
      void_reason: null,
    }).eq("id", payment_id);

    // Recalculate account totals using canonical formula
    const accountId = payment.account_id;

    const { data: allPayments } = await supabase
      .from("payments")
      .select("amount_paid")
      .eq("account_id", accountId)
      .is("voided_at", null);

    const { data: activePenalties } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", accountId)
      .neq("status", "waived");

    const { data: services } = await supabase
      .from("account_services" as any)
      .select("amount")
      .eq("account_id", accountId);

    const { data: accountData } = await supabase
      .from("layaway_accounts")
      .select("total_amount")
      .eq("id", accountId)
      .single();

    const newTotalPaid = round2((allPayments ?? [])
      .reduce((sum: number, p: any) => sum + Number(p.amount_paid), 0));

    const penaltyTotal = (activePenalties ?? [])
      .reduce((sum: number, p: any) => sum + Number(p.penalty_amount), 0);

    const serviceTotal = (services ?? [])
      .reduce((sum: number, s: any) => sum + Number(s.amount), 0);

    const newRemainingBalance = Math.max(0, round2(
      Number(accountData?.total_amount ?? 0) + penaltyTotal + serviceTotal - newTotalPaid
    ));

    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("status, due_date")
      .eq("account_id", accountId);
    const newStatus = updatedSchedule
      ? determineAccountStatus(updatedSchedule, account.status)
      : account.status;

    const { error: accountUpdateError } = await supabase.from("layaway_accounts").update({
      total_paid: newTotalPaid,
      remaining_balance: newRemainingBalance,
      status: newStatus,
    }).eq("id", accountId);

    if (accountUpdateError) {
      console.error("Failed to update account totals:", accountUpdateError);
      return new Response(
        JSON.stringify({ error: "Failed to update account totals", details: accountUpdateError }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "restore",
      old_value_json: { voided_at: payment.voided_at, void_reason: payment.void_reason },
      new_value_json: { restored_by: user.id, selected_schedule_ids: selectedIds },
      performed_by_user_id: user.id,
    });

    // Trigger reconcile-account to sync schedule rows and verify totals
    try {
      await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/reconcile-account`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ account_id: payment.account_id }),
        }
      );
    } catch (reconcileErr) {
      console.warn(`[restore-payment] reconcile-account call failed for ${payment.account_id}:`, reconcileErr);
    }

    // Bug #99 — fire-and-forget loyalty restore for installment payment.
    // Looks up the revoke transaction by payment_id; if missing (e.g. payment
    // pre-dates loyalty enrollment), logs debug and skips.
    try {
      const { data: revokeTxn } = await supabase
        .from("loyalty_transactions")
        .select("id")
        .eq("payment_id", payment_id)
        .eq("transaction_type", "revoked")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (revokeTxn?.id) {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/restore-loyalty-points`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            revoke_transaction_id: revokeTxn.id,
            created_by_user_id: user.id,
          }),
        }).catch((e) => console.warn("[restore-payment] restore-loyalty-points failed (installment path, non-blocking):", e));
      } else {
        console.log(`[restore-payment] no revoke transaction found for installment payment ${payment_id} — skipping loyalty restore`);
      }
    } catch (restoreErr) {
      console.warn("[restore-payment] installment loyalty restore block failed (non-blocking):", restoreErr);
    }

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
