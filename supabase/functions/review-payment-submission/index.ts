import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hasPermission(supabase: any, userId: string, permissionKey: string) {
  const { data: roles, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) throw roleError;

  const roleNames = (roles ?? []).map((row: any) => row.role);
  if (roleNames.length === 0) return false;

  const { data: permissions, error: permissionError } = await supabase
    .from("role_permissions")
    .select("role, is_allowed")
    .eq("permission_key", permissionKey)
    .in("role", roleNames);
  if (permissionError) throw permissionError;

  return (permissions ?? []).some((row: any) => row.is_allowed);
}

async function allocatePaymentToAccount(
  supabase: any,
  accountId: string,
  amountPaid: number,
  paymentDate: string,
  paymentMethod: string,
  referenceNumber: string | null,
  remarks: string,
  userId: string,
  currency: string,
  isDownpayment: boolean = false,
  submittedByType: "customer" | "staff" = "staff",
  submittedByName: string | null = null
): Promise<{ paymentId: string; error?: string }> {
  // Fetch schedule (only needed for installment payments)
  const { data: schedule } = isDownpayment ? { data: null } : await supabase
    .from("layaway_schedule")
    .select("*")
    .eq("account_id", accountId)
    .order("installment_number", { ascending: true });

  // Fetch unpaid penalties (not applicable for DP payments)
  const { data: unpaidPenalties } = isDownpayment ? { data: null } : await supabase
    .from("penalty_fees")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "unpaid")
    .order("penalty_date", { ascending: true });

  let remaining = amountPaid;
  const allocations: Array<{
    schedule_id: string;
    allocation_type: "penalty" | "installment";
    allocated_amount: number;
  }> = [];
  const penaltyUpdates: Array<{ id: string; status: string }> = [];
  const scheduleUpdates: Array<{ id: string; paid_amount: number; status: string; total_due_amount?: number }> = [];

  // DP payments skip all schedule and penalty allocation entirely.
  // They are recorded as a payment entry only; total_paid/remaining_balance
  // are updated below via the account totals section.
  if (!isDownpayment) {
    // 1. Pay unpaid penalties first
    if (unpaidPenalties) {
      for (const pen of unpaidPenalties) {
        if (remaining <= 0) break;
        const penAmount = Number(pen.penalty_amount);
        const toPay = Math.min(remaining, penAmount);
        remaining -= toPay;
        allocations.push({
          schedule_id: pen.schedule_id,
          allocation_type: "penalty",
          allocated_amount: toPay,
        });
        penaltyUpdates.push({
          id: pen.id,
          status: toPay >= penAmount ? "paid" : "unpaid",
        });
      }
    }

    // 2. Allocate remaining to installments
    if (remaining > 0 && schedule) {
      // CHANGE 1: fetch existing allocations for true per-row remaining
      // (CLAUDE.md INVARIANT 2 — paid_amount/total_due_amount are write-only caches)
      const { data: existingAllocs } = await supabase
        .from("payment_allocations")
        .select("schedule_id, allocated_amount, payment_id")
        .in("schedule_id", schedule.map((s: any) => s.id));

      const { data: voidedPayments } = await supabase
        .from("payments")
        .select("id")
        .eq("account_id", accountId)
        .not("voided_at", "is", null);

      const voidedIds = new Set((voidedPayments || []).map((p: any) => p.id));

      const allocatedBySchedule = new Map<string, number>();
      for (const alloc of (existingAllocs || [])) {
        if (!voidedIds.has(alloc.payment_id)) {
          allocatedBySchedule.set(
            alloc.schedule_id,
            (allocatedBySchedule.get(alloc.schedule_id) || 0) + Number(alloc.allocated_amount)
          );
        }
      }

      const unpaidItems = schedule
        .filter((item: any) => item.status !== "paid" && item.status !== "cancelled")
        .sort((a: any, b: any) => a.installment_number - b.installment_number);

      for (const item of unpaidItems) {
        if (remaining <= 0) break;
        // CHANGE 2: due from payment_allocations, not stale cache columns
        const alreadyAllocated = allocatedBySchedule.get(item.id) || 0;
        // Subtract any penalty already allocated in Phase 1 (in-memory) for this row
        // to avoid double-counting when rowCeiling also includes penalty_amount.
        const alreadyAllocatedPenalty = allocations
          .filter(a => a.schedule_id === item.id && a.allocation_type === 'penalty')
          .reduce((sum, a) => sum + a.allocated_amount, 0);
        const rowCeiling = Number(item.base_installment_amount) +
                           Number(item.penalty_amount || 0) +
                           Number(item.carried_amount || 0);
        const due = Math.max(0, rowCeiling - alreadyAllocated - alreadyAllocatedPenalty);
        if (due <= 0) continue;

        const toApply = Math.min(remaining, due);
        remaining -= toApply;
        const newPaid = alreadyAllocated + toApply;
        const isNowFullyPaid = newPaid >= rowCeiling;

        if (isNowFullyPaid && item.status === "partially_paid") {
          // GHOST PREVENTION: topping up a partial month — cap at ceiling, stop
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: rowCeiling, status: "paid" });
          remaining = 0;
          break;

        } else if (isNowFullyPaid) {
          // CHANGE 3: remove cascade that wrote paid_amount/total_due_amount on next
          // rows — outer loop now handles surplus naturally via continued iteration
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "paid" });
          // surplus in remaining flows to next unpaidItems iteration automatically

        } else if (item.status !== "partially_paid") {
          // PENDING MONTH UNDERPAID — record partial only.
          // Do NOT inflate next row's total_due_amount here; carry-over is
          // handled by accept-underpayment after payment_allocations are written.
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "partially_paid" });
          // remaining=0 after toApply; outer loop stops naturally

        } else {
          // PARTIALLY_PAID MONTH — additional payment, not completing
          allocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "partially_paid" });
          // remaining=0; outer loop stops naturally
        }
      }
    }
  }

  // Create payment record
  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .insert({
      account_id: accountId,
      amount_paid: amountPaid,
      currency,
      date_paid: paymentDate,
      payment_method: paymentMethod,
      reference_number: referenceNumber,
      remarks,
      entered_by_user_id: userId,
      submitted_by_type: submittedByType,
      submitted_by_name: submittedByName,
    })
    .select("id")
    .single();

  if (payErr) {
    console.error("Payment insert error:", payErr);
    return { paymentId: "", error: "Failed to create payment record" };
  }

  // Guard: skip allocation waterfall if this payment was already allocated (idempotency)
  const { data: existingAllocsGuard } = await supabase
    .from("payment_allocations")
    .select("id")
    .eq("payment_id", payment.id)
    .limit(1);
  const skipWaterfall = existingAllocsGuard != null && existingAllocsGuard.length > 0;
  if (skipWaterfall) {
    console.log(`[review] Payment ${payment.id} already has allocations — skipping waterfall`);
  }

  if (!skipWaterfall) {
    // Helper: attempt to roll back by deleting the payment row just inserted.
    // This is best-effort — full DB transactions are not available in edge functions.
    const rollbackPayment = async () => {
      await supabase.from("payments").delete().eq("id", payment.id);
    };

    // Create allocations (duplicate guard: skip if allocation already exists for this payment+schedule)
    for (const alloc of allocations) {
      const { data: existing } = await supabase
        .from("payment_allocations")
        .select("id")
        .eq("schedule_id", alloc.schedule_id)
        .eq("payment_id", payment.id)
        .eq("allocation_type", alloc.allocation_type)
        .maybeSingle();
      if (existing) continue;

      const { error: allocInsertErr } = await supabase.from("payment_allocations").insert({
        payment_id: payment.id,
        schedule_id: alloc.schedule_id,
        allocation_type: alloc.allocation_type,
        allocated_amount: alloc.allocated_amount,
      });

      if (allocInsertErr) {
        console.error(`[allocatePaymentToAccount] allocation insert failed for schedule ${alloc.schedule_id}:`, allocInsertErr);
        await rollbackPayment();
        return { paymentId: "", error: "Failed to create allocation: " + allocInsertErr.message };
      }
    }

    // Update penalty statuses
    for (const pen of penaltyUpdates) {
      const { error: penUpdateErr } = await supabase.from("penalty_fees").update({ status: pen.status }).eq("id", pen.id);
      if (penUpdateErr) {
        console.error(`[allocatePaymentToAccount] penalty update failed for ${pen.id}:`, penUpdateErr);
        await rollbackPayment();
        return { paymentId: "", error: "Failed to update penalty: " + penUpdateErr.message };
      }
    }

    // Update schedule items
    for (const item of scheduleUpdates) {
      const fields: any = { paid_amount: item.paid_amount, status: item.status };
      if (item.total_due_amount !== undefined) fields.total_due_amount = item.total_due_amount;
      const { error: schedUpdateErr } = await supabase.from("layaway_schedule").update(fields).eq("id", item.id);
      if (schedUpdateErr) {
        console.error(`[allocatePaymentToAccount] schedule update failed for ${item.id}:`, schedUpdateErr);
        await rollbackPayment();
        return { paymentId: "", error: "Failed to update schedule: " + schedUpdateErr.message };
      }
    }
  }

  // Re-derive remaining_balance from payments table (INVARIANT 1: SUM payments.amount_paid)
  // Must use payments table directly — payment_allocations has no rows for DP payments,
  // so allocation-based sums would incorrectly return 0 for downpayment approvals.
  const { data: nonVoidedPayments } = await supabase
    .from("payments")
    .select("amount_paid")
    .eq("account_id", accountId)
    .is("voided_at", null);
  const totalPaidFromPayments = (nonVoidedPayments || [])
    .reduce((sum: number, p: any) => sum + Number(p.amount_paid), 0);
  const { data: activePenaltiesData } = await supabase
    .from("penalty_fees")
    .select("penalty_amount")
    .eq("account_id", accountId)
    .neq("status", "waived");
  const totalPenaltiesVerified = (activePenaltiesData || [])
    .reduce((sum: number, p: any) => sum + Number(p.penalty_amount), 0);

  const { data: fullAccount } = await supabase
    .from("layaway_accounts")
    .select("total_amount, status")
    .eq("id", accountId)
    .single();
  const totalAmount = Number(fullAccount?.total_amount || 0);
  const verifiedRemaining = Math.max(0, totalAmount + totalPenaltiesVerified - totalPaidFromPayments);
  const verifiedTotalPaid = totalPaidFromPayments;

  // Recalculate correct status
  const currentStatus = fullAccount?.status || "active";
  let newStatus: string | undefined;
  if (verifiedRemaining <= 0) {
    newStatus = "completed";
  } else if (["active", "overdue"].includes(currentStatus)) {
    const todayStr = new Date().toISOString().split("T")[0];
    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("due_date, status")
      .eq("account_id", accountId)
      .not("status", "in", '("paid","cancelled")');
    const hasOverdue = (updatedSchedule || []).some((s: any) => s.due_date < todayStr);
    newStatus = hasOverdue ? "overdue" : "active";
  }

  const accountUpdate: Record<string, unknown> = {
    total_paid: verifiedTotalPaid,
    remaining_balance: verifiedRemaining,
  };
  if (newStatus) accountUpdate.status = newStatus;

  await supabase
    .from("layaway_accounts")
    .update(accountUpdate)
    .eq("id", accountId);

  return { paymentId: payment.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { submission_id, action, reviewer_notes } = body;

    if (!submission_id || !action) {
      return new Response(JSON.stringify({ error: "Missing submission_id or action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const validActions = ["under_review", "confirmed", "rejected", "needs_clarification"];
    if (!validActions.includes(action)) {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const permissionByAction: Record<string, string> = {
      under_review: "review_submission",
      needs_clarification: "review_submission",
      rejected: "reject_submission",
      confirmed: "confirm_payment",
    };

    const requiredPermission = permissionByAction[action];
    const isAllowed = requiredPermission
      ? await hasPermission(supabase, user.id, requiredPermission)
      : false;

    if (!isAllowed) {
      return new Response(JSON.stringify({ error: "Access denied for this submission action." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the submission
    const { data: submission, error: subErr } = await supabase
      .from("payment_submissions")
      .select("*")
      .eq("id", submission_id)
      .maybeSingle();

    if (subErr || !submission) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get allocations for this submission
    const { data: subAllocations } = await supabase
      .from("payment_submission_allocations")
      .select("*")
      .eq("submission_id", submission_id);

    const allocs = subAllocations || [];
    let confirmedPaymentIds: string[] = [];

    // If confirming, create actual payment records
    if (action === "confirmed") {
      // Detect DP submissions using the same heuristics as the payments table
      const subRef = String(submission.reference_number || '');
      const subNotes = String(submission.notes || '');
      const submissionIsDP =
        submission.submission_type === 'downpayment' ||
        subRef.toUpperCase().startsWith('DP-') ||
        /\bdown(payment)?\b|\bdp\b/i.test(subNotes);

      // Fetch customer name for submitted_by_name
      let customerName: string | null = null;
      if (submission.customer_id) {
        const { data: customer } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", submission.customer_id)
          .single();
        customerName = customer?.full_name || null;
      }

      // Single-account: either no allocations, or exactly one matching the submission account.
      // Always use submission.submitted_amount as the authoritative amount (handles edits correctly).
      const isSingleAccount =
        allocs.length === 0 ||
        (allocs.length === 1 && allocs[0].account_id === submission.account_id);

      if (isSingleAccount) {
        const { data: account } = await supabase
          .from("layaway_accounts")
          .select("currency")
          .eq("id", submission.account_id)
          .single();

        const result = await allocatePaymentToAccount(
          supabase,
          submission.account_id,
          Number(submission.submitted_amount),
          submission.payment_date,
          submission.payment_method,
          submission.reference_number,
          `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)}`,
          user.id,
          account?.currency || "PHP",
          submissionIsDP,
          "customer",
          customerName
        );

        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        confirmedPaymentIds.push(result.paymentId);
      } else {
        // Multi-account split: process each allocation separately.
        // For these, alloc.allocated_amount is the per-account split amount.
        for (const alloc of allocs) {
          const { data: account } = await supabase
            .from("layaway_accounts")
            .select("currency")
            .eq("id", alloc.account_id)
            .single();

          const result = await allocatePaymentToAccount(
            supabase,
            alloc.account_id,
            Number(alloc.allocated_amount),
            submission.payment_date,
            submission.payment_method,
            submission.reference_number,
            `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)} (${alloc.invoice_number})`,
            user.id,
            account?.currency || "PHP",
            submissionIsDP,
            "customer",
            customerName
          );

          if (result.error) {
            console.error(`Failed to process allocation for ${alloc.invoice_number}:`, result.error);
            continue;
          }
          confirmedPaymentIds.push(result.paymentId);
        }

        if (confirmedPaymentIds.length === 0) {
          return new Response(JSON.stringify({ error: "Failed to create any payment records" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Update submission status
    const updateData: Record<string, unknown> = {
      status: action,
      reviewer_user_id: user.id,
      reviewer_notes: reviewer_notes || null,
      updated_at: new Date().toISOString(),
    };

    if (confirmedPaymentIds.length === 1) {
      updateData.confirmed_payment_id = confirmedPaymentIds[0];
    }

    const { error: updateErr } = await supabase
      .from("payment_submissions")
      .update(updateData)
      .eq("id", submission_id);

    if (updateErr) {
      console.error("Update error:", updateErr);
      return new Response(JSON.stringify({ error: "Failed to update submission" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment_submission",
      entity_id: submission_id,
      action: `submission_${action}`,
      performed_by_user_id: user.id,
      new_value_json: {
        status: action,
        reviewer_notes,
        confirmed_payment_ids: confirmedPaymentIds,
        allocation_count: allocs.length,
      },
      old_value_json: { status: submission.status },
    });

    return new Response(JSON.stringify({
      success: true,
      status: action,
      confirmed_payment_ids: confirmedPaymentIds,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
