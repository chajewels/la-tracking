import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reconcile a single layaway account.
 *
 * Step 1 — Compute totalPaid from payments table ONLY (never from allocations).
 * Step 2 — HARD GUARD: abort if new totalPaid < current accounts.total_paid.
 * Step 3 — Compute remaining_balance via canonical formula:
 *             total_amount + activePenalties + services - totalPaid
 * Step 4 — Compute account status (completed / overdue / active).
 * Step 5 — Update accounts table.
 * Step 6 — Update schedule rows WHERE allocations exist.
 *           NEVER reset a row to pending/overdue based on absence of allocations.
 * Step 7 — Return full reconciliation result.
 *
 * Body: { account_id?: string, invoice_number?: string }
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

    // Resolve account_id from invoice_number if provided
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

    // ── Step 1: Load data & compute totalPaid from payments only ─────────────
    const [
      { data: account },
      { data: payments },
      { data: penalties },
      { data: services },
      { data: schedule },
    ] = await Promise.all([
      supabase
        .from("layaway_accounts")
        .select("id, invoice_number, total_amount, total_paid, remaining_balance, status")
        .eq("id", account_id)
        .single(),
      supabase
        .from("payments")
        .select("id, amount_paid")
        .eq("account_id", account_id)
        .is("voided_at", null),
      supabase
        .from("penalty_fees")
        .select("penalty_amount, status")
        .eq("account_id", account_id),
      supabase
        .from("account_services")
        .select("amount")
        .eq("account_id", account_id),
      supabase
        .from("layaway_schedule")
        .select("id, installment_number, base_installment_amount, penalty_amount, total_due_amount, paid_amount, status, due_date")
        .eq("account_id", account_id)
        .neq("status", "cancelled")
        .order("installment_number"),
    ]);

    if (!account) throw new Error(`Account ${account_id} not found`);

    const paymentRows: any[] = payments || [];
    const penaltyRows: any[] = penalties || [];
    const serviceRows: any[] = services || [];
    const scheduleRows: any[] = schedule || [];

    // totalPaid = SUM(payments.amount_paid) WHERE voided_at IS NULL
    // NEVER derived from payment_allocations
    const totalPaid = Math.round(
      paymentRows.reduce((s, p) => s + Number(p.amount_paid), 0) * 100
    ) / 100;

    // ── Step 2: HARD GUARD ────────────────────────────────────────────────────
    const currentTotalPaid = Number(account.total_paid);
    if (totalPaid < currentTotalPaid - 0.01) {
      const msg =
        `GUARD: reconcile would decrease total_paid for ${account_id} ` +
        `(${account.invoice_number}) from ${currentTotalPaid} to ${totalPaid}. Aborting.`;
      console.error(`[reconcile-account] ${msg}`);
      return new Response(
        JSON.stringify({
          success: false,
          reason: "guard_total_paid_decrease",
          account_id,
          invoice_number: account.invoice_number,
          current_total_paid: currentTotalPaid,
          computed_total_paid: totalPaid,
          message: msg,
          guardFired: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 3: Canonical remaining_balance ───────────────────────────────────
    // activePenalties = SUM(penalty_fees.penalty_amount WHERE status != 'waived')
    const activePenalties = penaltyRows
      .filter((p) => p.status !== "waived")
      .reduce((s, p) => s + Number(p.penalty_amount), 0);
    const serviceSum = serviceRows.reduce((s, sv) => s + Number(sv.amount), 0);
    const remaining_balance = Math.max(
      0,
      Math.round(
        (Number(account.total_amount) + activePenalties + serviceSum - totalPaid) * 100
      ) / 100
    );

    // ── Step 4: Compute account status ────────────────────────────────────────
    // Preserve special statuses that reconcile must never override
    const PRESERVED_STATUSES = new Set([
      "forfeited", "final_forfeited", "cancelled",
      "extension_active", "reactivated", "final_settlement",
    ]);

    let newStatus: string;
    if (PRESERVED_STATUSES.has(account.status)) {
      newStatus = account.status;
    } else if (remaining_balance <= 0) {
      newStatus = "completed";
    } else if (scheduleRows.some((s) => s.status === "overdue")) {
      newStatus = "overdue";
    } else {
      newStatus = "active";
    }

    // ── Step 5: Update accounts table ────────────────────────────────────────
    await supabase
      .from("layaway_accounts")
      .update({
        total_paid: totalPaid,
        remaining_balance,
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", account_id);

    // ── Step 6: Update schedule rows — only where allocations exist ───────────
    // Build allocBySchedule from payment_allocations scoped to this account's
    // payments (to prevent cross-account contamination).
    const validPaymentIds = new Set(paymentRows.map((p) => p.id));
    const allocBySchedule: Record<string, number> = {};

    const scheduleIds = scheduleRows.map((s) => s.id);
    const payIdList = Array.from(validPaymentIds);

    if (scheduleIds.length > 0 && payIdList.length > 0) {
      for (let i = 0; i < scheduleIds.length; i += 100) {
        const schedChunk = scheduleIds.slice(i, i + 100);
        for (let j = 0; j < payIdList.length; j += 100) {
          const payChunk = payIdList.slice(j, j + 100);
          const { data: allocs } = await supabase
            .from("payment_allocations")
            .select("schedule_id, allocated_amount")
            .in("schedule_id", schedChunk)
            .in("payment_id", payChunk);
          for (const a of allocs || []) {
            allocBySchedule[a.schedule_id] =
              (allocBySchedule[a.schedule_id] || 0) + Number(a.allocated_amount);
          }
        }
      }
    }

    let rowsUpdated = 0;
    for (const sched of scheduleRows) {
      const rowPaid = Math.round((allocBySchedule[sched.id] || 0) * 100) / 100;
      if (rowPaid <= 0) continue; // No allocations — skip; never reset to pending

      const base = Number(sched.base_installment_amount);
      const newRowStatus = rowPaid >= base - 0.005 ? "paid" : "partially_paid";
      // Cap paid_amount at base to avoid overflow; allocations should never exceed base
      const newPaidAmount = Math.min(Math.round(rowPaid * 100) / 100, base);

      const statusChanged = sched.status !== newRowStatus;
      const paidChanged = Math.abs(Number(sched.paid_amount) - newPaidAmount) > 0.005;

      if (statusChanged || paidChanged) {
        // When a row transitions to paid and it had a carried_amount, clear the carry
        // fields — the carry was consumed by this payment.
        const clearCarry =
          newRowStatus === "paid" && Number(sched.carried_amount) > 0.005;

        await supabase
          .from("layaway_schedule")
          .update({
            paid_amount: newPaidAmount,
            status: newRowStatus,
            updated_at: new Date().toISOString(),
            ...(clearCarry
              ? {
                  carried_amount: 0,
                  carried_from_schedule_id: null,
                  carried_by_payment_id: null,
                }
              : {}),
          })
          .eq("id", sched.id);
        rowsUpdated++;
      }
    }

    // ── Step 7: Return result ─────────────────────────────────────────────────
    const result = {
      success: true,
      account_id,
      invoice_number: account.invoice_number,
      totalPaid,
      remaining_balance,
      status: newStatus,
      rowsUpdated,
      guardFired: false,
      changes: {
        total_paid: { from: currentTotalPaid, to: totalPaid },
        remaining_balance: {
          from: Math.round(Number(account.remaining_balance) * 100) / 100,
          to: remaining_balance,
        },
        status: { from: account.status, to: newStatus },
      },
    };

    console.log(
      `[reconcile-account] ${account.invoice_number}: ` +
      `totalPaid=${totalPaid}, remaining=${remaining_balance}, ` +
      `status=${newStatus}, rowsUpdated=${rowsUpdated}`
    );

    return new Response(JSON.stringify(result, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[reconcile-account] error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
