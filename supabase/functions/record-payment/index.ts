import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { account_id, amount_paid, date_paid, payment_method, reference_number, remarks, preview_only, is_downpayment } = body;

    if (!account_id || !amount_paid || amount_paid <= 0) {
      return new Response(JSON.stringify({ error: "Invalid payment data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Role check: only admin/finance can directly record payments ──
    const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
    ]);
    const canConfirm = isAdmin || isFinance;

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (account.status !== "active" && account.status !== "overdue") {
      return new Response(JSON.stringify({ error: "Account is not active" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Staff/CSR: redirect to payment_submissions instead of direct payment ──
    if (!canConfirm && !preview_only) {
      const { data: submission, error: subErr } = await supabase
        .from("payment_submissions")
        .insert({
          account_id,
          customer_id: account.customer_id,
          submitted_amount: amount_paid,
          payment_date: date_paid || new Date().toISOString().split("T")[0],
          payment_method: payment_method || "cash",
          reference_number: reference_number || null,
          notes: remarks || null,
          status: "submitted",
        })
        .select("id")
        .single();

      if (subErr) {
        return new Response(JSON.stringify({ error: subErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Audit log
      await supabase.from("audit_logs").insert({
        entity_type: "payment_submission",
        entity_id: submission.id,
        action: "staff_payment_submitted",
        new_value_json: { amount_paid, account_id, payment_method, date_paid },
        performed_by_user_id: user.id,
      });

      return new Response(JSON.stringify({
        submitted_for_confirmation: true,
        submission_id: submission.id,
        message: "Payment submitted for confirmation. An admin or finance user will review it.",
      }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── From here: admin/finance flow (unchanged) OR preview_only ──

    // Fetch schedule ordered by installment
    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", account_id)
      .order("installment_number", { ascending: true });

    if (!schedule) {
      return new Response(JSON.stringify({ error: "Schedule not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch unpaid penalties
    const { data: unpaidPenalties } = await supabase
      .from("penalty_fees")
      .select("*")
      .eq("account_id", account_id)
      .eq("status", "unpaid")
      .order("penalty_date", { ascending: true });

    // Allocate payment: penalties first, then installments
    let remaining = Math.round(Number(amount_paid) * 100) / 100;
    const allocations: Array<{
      schedule_id: string;
      allocation_type: "penalty" | "installment";
      allocated_amount: number;
      penalty_fee_id?: string;
    }> = [];
    const penaltyUpdates: Array<{ id: string; status: string; paid_amount: number }> = [];
    const scheduleUpdates: Array<{
      id: string;
      paid_amount: number;
      status: string;
    }> = [];

    // 1. Pay unpaid penalties first (not applicable for DP payments)
    if (!is_downpayment && unpaidPenalties) {
      for (const pen of unpaidPenalties) {
        if (remaining <= 0) break;
        const penAmount = Number(pen.penalty_amount);
        const toPay = Math.round(Math.min(remaining, penAmount) * 100) / 100;
        remaining = Math.round((remaining - toPay) * 100) / 100;
        allocations.push({
          schedule_id: pen.schedule_id,
          allocation_type: "penalty",
          allocated_amount: toPay,
          penalty_fee_id: pen.id,
        });
        penaltyUpdates.push({
          id: pen.id,
          status: toPay >= penAmount ? "paid" : "unpaid",
          paid_amount: toPay,
        });
      }
    }

    // 2. Allocate to installments — only for non-DP payments.
    //    DP payments NEVER touch schedule rows; they are recorded purely
    //    as a payment entry and reflected in total_paid/remaining_balance.
    if (!is_downpayment && remaining > 0 && schedule) {
      const unpaidItems = schedule.filter(
        item => item.status !== "paid" && item.status !== "cancelled"
      ).sort((a, b) => a.installment_number - b.installment_number);

      for (const item of unpaidItems) {
        if (remaining <= 0) break;

        const currentPaid = Number(item.paid_amount);
        const baseAmount = Number(item.base_installment_amount);
        // For partially_paid items, use total_due_amount as target to include any penalties
        const targetAmount = item.status === "partially_paid"
          ? Number(item.total_due_amount)
          : baseAmount;
        const due = Math.max(0, targetAmount - currentPaid);

        if (due <= 0) continue;

        const availableForThisMonth = remaining; // save before deduction
        const toApply = Math.round(Math.min(remaining, due) * 100) / 100;
        remaining = Math.round((remaining - toApply) * 100) / 100;

        const newPaid = Math.round((currentPaid + toApply) * 100) / 100;
        const isNowFullyPaid = newPaid >= targetAmount;
        const newStatus = isNowFullyPaid ? "paid" : "partially_paid";

        // Store actual cash received for display:
        // - pending month fully/overpaid: store full available (shows actual receipt)
        // - partially_paid month completing: cap at targetAmount (CLAUDE.md ghost prevention)
        // - partial payment: store amount paid so far
        const storedPaid = isNowFullyPaid && item.status !== "partially_paid"
          ? Math.round((currentPaid + availableForThisMonth) * 100) / 100
          : isNowFullyPaid
            ? targetAmount
            : newPaid;

        allocations.push({
          schedule_id: item.id,
          allocation_type: "installment",
          allocated_amount: toApply,
        });

        scheduleUpdates.push({
          id: item.id,
          paid_amount: storedPaid,
          status: newStatus,
        });

        // Completing a partial month — do not spill remainder to next month
        if (item.status === "partially_paid" && isNowFullyPaid) {
          remaining = 0;
        }
      }
    }

    // SINGLE SOURCE OF TRUTH: derive total_paid from SUM of all confirmed payments
    // (not from stored account.total_paid which may be stale)
    const { data: allActivePayments } = await supabase
      .from("payments")
      .select("amount_paid")
      .eq("account_id", account_id)
      .is("voided_at", null);
    const existingPaidSum = (allActivePayments || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
    // Add current payment amount (not yet inserted)
    const newTotalPaid = existingPaidSum + Number(amount_paid);

    // PRINCIPAL-ONLY remaining: exclude penalty payments from principal calculation
    // Get already-paid penalties from DB + penalties being paid in this transaction
    const { data: existingPaidPenalties } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", account_id)
      .eq("status", "paid");
    const existingPenaltyPaid = (existingPaidPenalties || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
    const newPenaltyBeingPaid = allocations
      .filter(a => a.allocation_type === "penalty")
      .reduce((s, a) => s + a.allocated_amount, 0);
    const totalPenaltyPaid = existingPenaltyPaid + newPenaltyBeingPaid;
    const principalPaid = newTotalPaid - totalPenaltyPaid;
    const newRemainingBalance = Math.max(0, Number(account.total_amount) - principalPaid);
    const newStatus = newRemainingBalance <= 0 ? "completed" : account.status;

    // Preview mode - return allocation plan without saving
    if (preview_only) {
      return new Response(JSON.stringify({
        preview: true,
        allocations,
        new_total_paid: newTotalPaid,
        new_remaining_balance: Math.max(0, newRemainingBalance),
        new_status: newStatus,
        schedule_updates: scheduleUpdates,
        penalty_updates: penaltyUpdates,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create payment record
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .insert({
        account_id,
        amount_paid,
        currency: account.currency,
        date_paid: date_paid || new Date().toISOString().split("T")[0],
        payment_method: payment_method || "cash",
        reference_number,
        remarks,
        entered_by_user_id: user.id,
        submitted_by_type: "staff",
        submitted_by_name: (user.user_metadata as any)?.full_name || user.email || null,
      })
      .select()
      .single();

    if (payErr) {
      return new Response(JSON.stringify({ error: payErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create allocations
    for (const alloc of allocations) {
      await supabase.from("payment_allocations").insert({
        payment_id: payment.id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });
    }

    // Update penalty statuses
    for (const pen of penaltyUpdates) {
      await supabase.from("penalty_fees").update({ status: pen.status }).eq("id", pen.id);
    }

    // Update schedule items
    for (const item of scheduleUpdates) {
      await supabase.from("layaway_schedule").update({
        paid_amount: item.paid_amount,
        status: item.status,
      }).eq("id", item.id);
    }

    // SINGLE SOURCE OF TRUTH: re-derive from all payments after insert
    const { data: postInsertPayments } = await supabase
      .from("payments")
      .select("amount_paid")
      .eq("account_id", account_id)
      .is("voided_at", null);
    const verifiedTotalPaid = (postInsertPayments || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);

    // PRINCIPAL-ONLY remaining: exclude penalty payments
    const { data: verifiedPaidPenalties } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", account_id)
      .eq("status", "paid");
    const verifiedPenaltyPaid = (verifiedPaidPenalties || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
    const verifiedRemaining = Math.max(0, Number(account.total_amount) - (verifiedTotalPaid - verifiedPenaltyPaid));

    // Recalculate correct status based on updated schedule state
    let verifiedStatus = account.status;
    if (verifiedRemaining <= 0) {
      verifiedStatus = "completed";
    } else if (["active", "overdue"].includes(account.status)) {
      // Check if any unpaid schedule items are still past due
      const todayStr = new Date().toISOString().split("T")[0];
      const { data: updatedSchedule } = await supabase
        .from("layaway_schedule")
        .select("due_date, status")
        .eq("account_id", account_id)
        .not("status", "in", '("paid","cancelled")');
      const hasOverdue = (updatedSchedule || []).some((s: any) => s.due_date < todayStr);
      verifiedStatus = hasOverdue ? "overdue" : "active";
    }

    await supabase.from("layaway_accounts").update({
      total_paid: verifiedTotalPaid,
      remaining_balance: verifiedRemaining,
      status: verifiedStatus,
    }).eq("id", account_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment.id,
      action: "create",
      new_value_json: { amount_paid, account_id, allocations },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({
      payment,
      allocations,
      new_total_paid: newTotalPaid,
      new_remaining_balance: Math.max(0, newRemainingBalance),
      new_status: newStatus,
    }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
