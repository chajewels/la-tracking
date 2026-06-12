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

    // Staff-only gate — prevents Phase B customers from injecting payment submissions for arbitrary accounts
    const { data: userIsStaff } = await supabase.rpc("is_staff", { _user_id: user.id });
    if (!userIsStaff) {
      return new Response(JSON.stringify({ error: "Staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { account_id, amount_paid, date_paid, payment_method, reference_number, remarks, preview_only, is_downpayment, carry_over = false, submission_type, force } = body;

    if (!account_id || !amount_paid || amount_paid <= 0) {
      return new Response(JSON.stringify({ error: "Invalid payment data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    // ── Rate limit per account per 24h ──
    //    downpayment on trade account (is_trade=true): max 10
    //    downpayment on non-trade account:             max 5
    //    installment / other:                          max 3
    const isDpSubmission =
      submission_type === "downpayment" || is_downpayment === true;
    const isTradeAccount = account?.is_trade === true;

    let rlCap: number;
    if (isDpSubmission && isTradeAccount) {
      rlCap = 10;
    } else if (isDpSubmission) {
      rlCap = 5;
    } else {
      rlCap = 3;
    }

    let rlQuery = supabase
      .from("payment_submissions")
      .select("*", { count: "exact", head: true })
      .eq("account_id", account_id)
      .neq("status", "rejected")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (isDpSubmission) {
      rlQuery = rlQuery.eq("submission_type", "downpayment");
    }

    const { count: recentCount } = await rlQuery;

    if ((recentCount ?? 0) >= rlCap) {
      return new Response(
        JSON.stringify({
          error: `Too many submissions. Maximum ${rlCap} ${isDpSubmission ? "downpayment " : ""}payment submissions per account per 24 hours. Please wait before submitting again.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Account must be in a payable state ──
    const payableStatuses = ["active", "overdue", "extension_active", "reactivated", "final_settlement"];
    if (!payableStatuses.includes(account.status)) {
      return new Response(JSON.stringify({ error: "Account is not active" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Universal submission-only path (Bug #219): every non-preview call,
    //    regardless of role, creates a pending payment_submissions row.
    //    Direct writes to the payments table happen ONLY via
    //    review-payment-submission. The previous confirm_payment-coupled
    //    direct-write branch was removed (Bug #218).
    if (!preview_only) {
      // Race-proof insert: insert_payment_submission_guarded takes a per-account
      // advisory lock, re-runs the duplicate check, and inserts atomically. The
      // prior separate-statement SELECT-then-INSERT could let two near-simultaneous
      // calls both pass the dup check (observed 411ms apart).
      const { data: guarded, error: subErr } = await supabase.rpc("insert_payment_submission_guarded", {
        p_account_id: account_id,
        p_customer_id: account.customer_id,
        p_submitted_amount: amount_paid,
        p_payment_date: date_paid || new Date().toISOString().split("T")[0],
        p_payment_method: payment_method || "cash",
        p_reference_number: reference_number || null,
        p_notes: remarks || null,
        p_submission_type: submission_type ?? "single",
        p_sender_name: (user.user_metadata as any)?.full_name || user.email || null,
        p_force: !!force,
      });

      if (subErr) {
        return new Response(JSON.stringify({ error: subErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (guarded?.duplicate === true) {
        const minutesAgo = Number(guarded.minutes_ago) || 1;
        const senderName = guarded.sender_name ?? "unknown";
        return new Response(
          JSON.stringify({
            error: "duplicate_submission_detected",
            message: `A ₱${Number(amount_paid).toLocaleString()} submission for this account is already pending review (submitted ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago by ${senderName}). If this is a different payment, add a distinguishing reference number or note, then retry with force=true.`,
            existing_submission_id: guarded.existing_submission_id ?? null,
            existing_submitted_at: guarded.existing_submitted_at ?? null,
            existing_sender_name: guarded.sender_name ?? null,
            existing_reference_number: guarded.existing_reference_number ?? null,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Audit log
      await supabase.from("audit_logs").insert({
        entity_type: "payment_submission",
        entity_id: guarded.submission_id,
        action: "staff_payment_submitted",
        new_value_json: { amount_paid, account_id, payment_method, date_paid },
        performed_by_user_id: user.id,
      });

      return new Response(JSON.stringify({
        submitted_for_confirmation: true,
        submission_id: guarded.submission_id,
        message: "Payment submitted for confirmation. An admin or finance user will review it.",
      }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── preview_only: compute allocation plan without writing anything ──

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
      total_due_amount?: number;
    }> = [];

    // Unified row-by-row waterfall — allocate penalty + installment for
    // EACH schedule row before advancing. Prevents cross-row penalty
    // leakage where a later month's penalty events could drain the
    // payment budget before the target month's base is covered.
    //
    // DP payments NEVER touch schedule rows; they are recorded purely
    // as a payment entry and reflected in total_paid/remaining_balance.
    if (!is_downpayment && schedule) {
      // Fetch existing allocations from payment_allocations — never use stale paid_amount cache
      const { data: existingAllocsRaw } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, allocation_type, payment_id")
        .in("schedule_id", schedule.map((s: any) => s.id));

      const { data: voidedPmts } = await supabase
        .from("payments")
        .select("id")
        .eq("account_id", account_id)
        .not("voided_at", "is", null);
      const voidedIds = new Set((voidedPmts || []).map((p: any) => p.id));

      const allocatedBySchedule = new Map<string, number>();
      const penaltyAllocBySchedule = new Map<string, number>();
      for (const alloc of (existingAllocsRaw || [])) {
        if (voidedIds.has(alloc.payment_id)) continue;
        if (alloc.allocation_type === "installment") {
          allocatedBySchedule.set(alloc.schedule_id,
            (allocatedBySchedule.get(alloc.schedule_id) || 0) + Number(alloc.allocated_amount));
        } else if (alloc.allocation_type === "penalty") {
          penaltyAllocBySchedule.set(alloc.schedule_id,
            (penaltyAllocBySchedule.get(alloc.schedule_id) || 0) + Number(alloc.allocated_amount));
        }
      }

      const unpaidItems = schedule.filter(
        (item: any) => item.status !== "paid" && item.status !== "cancelled"
      ).sort((a: any, b: any) => a.installment_number - b.installment_number);

      for (const item of unpaidItems) {
        if (remaining <= 0) break;

        // STEP A — Pay THIS row's penalties only (scoped to this schedule_id)
        if (unpaidPenalties) {
          const itemPenalties = unpaidPenalties.filter((pen: any) => pen.schedule_id === item.id);
          for (const pen of itemPenalties) {
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

        if (remaining <= 0) break;

        // STEP B — Pay THIS row's base installment
        const base = Number(item.base_installment_amount);
        const penalty = Number(item.penalty_amount || 0);
        const carried = Number(item.carried_amount || 0);
        const alreadyAllocated = allocatedBySchedule.get(item.id) || 0;
        // Include in-memory penalty allocations made in Step A for this row
        const alreadyAllocatedPenalty = (penaltyAllocBySchedule.get(item.id) || 0) +
          allocations.filter(a => a.schedule_id === item.id && a.allocation_type === "penalty")
            .reduce((sum, a) => sum + a.allocated_amount, 0);

        const naturalCeiling = base + penalty + carried;
        const rowCeiling = item.total_due_amount
          ? Math.min(naturalCeiling, Number(item.total_due_amount))
          : naturalCeiling;
        const due = Math.max(0, rowCeiling - alreadyAllocated - alreadyAllocatedPenalty);
        if (due <= 0) continue;

        const toApply = Math.round(Math.min(remaining, due) * 100) / 100;
        const newPaid = Math.round((alreadyAllocated + toApply) * 100) / 100;
        const isNowFullyPaid = newPaid + alreadyAllocatedPenalty >= rowCeiling - 0.005;

        // STEP C — Push allocation + schedule update (before decrementing remaining
        // so the explicit break right after remaining -= toApply does not skip it)
        allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
        scheduleUpdates.push({
          id: item.id,
          paid_amount: newPaid,
          status: isNowFullyPaid ? "paid" : "partially_paid",
        });

        remaining = Math.round((remaining - toApply) * 100) / 100;

        // STEP D — exhausted? stop immediately after Step B's remaining decrement,
        // before any chance of visiting the next row.
        if (remaining <= 0) break;
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

    // Canonical remaining_balance (CLAUDE.md):
    // remaining = total_amount + Σ(non-waived penalty_fees) - total_paid
    // Services are already in total_amount — do NOT add them separately.
    const { data: activePenaltiesData } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", account_id)
      .neq("status", "waived");
    const activePenaltySum = (activePenaltiesData || [])
      .reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
    const newRemainingBalance = Math.max(0,
      Math.round((
        Number(account.total_amount)
        + activePenaltySum
        - newTotalPaid
      ) * 100) / 100);
    const newStatus = newRemainingBalance <= 0 ? "completed" : account.status;

    // Preview mode — return allocation plan without saving. Direct-write to
    // payments has been removed entirely (Bug #219); see review-payment-submission.
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
  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
