import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Reconcile a single layaway account — REPORT ONLY (no DB writes).
 *
 * Reads all data, computes canonical values, and returns a drift report
 * showing discrepancies between computed and stored values.
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
        .select("id, installment_number, base_installment_amount, penalty_amount, carried_amount, total_due_amount, paid_amount, status, due_date")
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
    const totalPaid = Math.round(
      paymentRows.reduce((s, p) => s + Number(p.amount_paid), 0) * 100
    ) / 100;

    // ── Step 2: HARD GUARD ────────────────────────────────────────────────────
    const currentTotalPaid = Number(account.total_paid);
    if (totalPaid < currentTotalPaid - 0.01) {
      return new Response(
        JSON.stringify({
          success: false,
          reason: "guard_total_paid_decrease",
          account_id,
          invoice_number: account.invoice_number,
          current_total_paid: currentTotalPaid,
          computed_total_paid: totalPaid,
          guardFired: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Step 3: Canonical remaining_balance ───────────────────────────────────
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

    // ── Step 5: Detect drift (no writes) ─────────────────────────────────────
    const driftItems: object[] = [];

    // Account level drift
    if (Math.abs(totalPaid - currentTotalPaid) > 0.005) {
      driftItems.push({
        type: "account_total_paid",
        expected: totalPaid,
        stored: currentTotalPaid,
      });
    }
    if (Math.abs(remaining_balance - Number(account.remaining_balance)) > 0.005) {
      driftItems.push({
        type: "account_remaining_balance",
        expected: remaining_balance,
        stored: Math.round(Number(account.remaining_balance) * 100) / 100,
      });
    }
    if (newStatus !== account.status) {
      driftItems.push({
        type: "account_status",
        expected: newStatus,
        stored: account.status,
      });
    }

    // ── Step 6: Schedule row drift ───────────────────────────────────────────
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

    for (const sched of scheduleRows) {
      const rowPaid = Math.round((allocBySchedule[sched.id] || 0) * 100) / 100;
      if (rowPaid <= 0) continue;
      if (sched.status === "paid") continue;

      const base = Number(sched.base_installment_amount);
      const penalty = Number(sched.penalty_amount || 0);
      const carried = Number(sched.carried_amount || 0);
      const ceiling = base + penalty + carried;

      const newRowStatus = rowPaid >= ceiling - 0.005 ? "paid" : "partially_paid";
      const newPaidAmount = Math.min(Math.round(rowPaid * 100) / 100, ceiling);

      if (newRowStatus !== sched.status) {
        driftItems.push({
          type: "schedule_status",
          schedule_id: sched.id,
          installment_number: sched.installment_number,
          expected: newRowStatus,
          stored: sched.status,
        });
      }
      if (Math.abs(newPaidAmount - Number(sched.paid_amount)) > 0.005) {
        driftItems.push({
          type: "schedule_paid_amount",
          schedule_id: sched.id,
          installment_number: sched.installment_number,
          expected: newPaidAmount,
          stored: Math.round(Number(sched.paid_amount) * 100) / 100,
        });
      }
    }

    // ── Step 7: Write drift report to reconciliation_log ───────────────────
    await supabase
      .from('reconciliation_log' as any)
      .insert({
        account_id,
        invoice_number: account.invoice_number,
        checked_at: new Date().toISOString(),
        drift_detected: driftItems.length > 0,
        drift_count: driftItems.length,
        drift: driftItems,
      });

    // ── Step 8: Return drift report ──────────────────────────────────────────
    const result = {
      account_id,
      invoice_number: account.invoice_number,
      drift_detected: driftItems.length > 0,
      drift_count: driftItems.length,
      computed: {
        total_paid: totalPaid,
        remaining_balance,
        status: newStatus,
      },
      stored: {
        total_paid: currentTotalPaid,
        remaining_balance: Math.round(Number(account.remaining_balance) * 100) / 100,
        status: account.status,
      },
      drift: driftItems,
      guardFired: false,
    };

    console.log(
      `[reconcile-account] ${account.invoice_number}: ` +
      `drift=${driftItems.length > 0 ? driftItems.length + " items" : "none"}`
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
