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
  currency: string
): Promise<{ paymentId: string; error?: string }> {
  // Fetch schedule
  const { data: schedule } = await supabase
    .from("layaway_schedule")
    .select("*")
    .eq("account_id", accountId)
    .order("installment_number", { ascending: true });

  // Fetch unpaid penalties
  const { data: unpaidPenalties } = await supabase
    .from("penalty_fees")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "unpaid")
    .order("penalty_date", { ascending: true });

  // Allocate: penalties first, then installments
  let remaining = amountPaid;
  const allocations: Array<{
    schedule_id: string;
    allocation_type: "penalty" | "installment";
    allocated_amount: number;
  }> = [];
  const penaltyUpdates: Array<{ id: string; status: string }> = [];
  const scheduleUpdates: Array<{ id: string; paid_amount: number; status: string }> = [];

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
    const unpaidItems = schedule
      .filter((item: any) => item.status !== "paid" && item.status !== "cancelled")
      .sort((a: any, b: any) => a.installment_number - b.installment_number);

    for (const item of unpaidItems) {
      if (remaining <= 0) break;
      const currentPaid = Number(item.paid_amount);
      const baseAmount = Number(item.base_installment_amount);
      // Use total_due_amount for partially_paid items (ghost prevention — same as record-payment)
      const targetAmount = item.status === "partially_paid"
        ? Number(item.total_due_amount)
        : baseAmount;
      const due = Math.max(0, targetAmount - currentPaid);
      if (due <= 0) continue;

      const toApply = Math.min(remaining, due);
      remaining -= toApply;
      const newPaid = currentPaid + toApply;
      const isNowFullyPaid = newPaid >= targetAmount;
      const newStatus = isNowFullyPaid ? "paid" : "partially_paid";

      allocations.push({
        schedule_id: item.id,
        allocation_type: "installment",
        allocated_amount: toApply,
      });
      scheduleUpdates.push({
        id: item.id,
        paid_amount: isNowFullyPaid ? targetAmount : newPaid,
        status: newStatus,
      });
      // Stop after one installment — never cascade to next months
      remaining = 0;
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
    })
    .select("id")
    .single();

  if (payErr) {
    console.error("Payment insert error:", payErr);
    return { paymentId: "", error: "Failed to create payment record" };
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

  // Update account totals
  const { data: fullAccount } = await supabase
    .from("layaway_accounts")
    .select("total_amount, total_paid, status")
    .eq("id", accountId)
    .single();

  const newTotalPaid = Number(fullAccount?.total_paid || 0) + amountPaid;
  const totalAmount = Number(fullAccount?.total_amount || 0);

  // PRINCIPAL-ONLY remaining: exclude penalty payments
  const { data: paidPenaltyFees } = await supabase
    .from("penalty_fees")
    .select("penalty_amount")
    .eq("account_id", accountId)
    .eq("status", "paid");
  const penaltyPaidForAccount = (paidPenaltyFees || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
  // Add penalties being paid in this allocation that haven't been committed yet
  const newPenaltyInAlloc = allocations
    .filter(a => a.allocation_type === "penalty")
    .reduce((s, a) => s + a.allocated_amount, 0);
  const totalPenaltyPaid = penaltyPaidForAccount + newPenaltyInAlloc;
  const newRemaining = Math.max(0, totalAmount - (newTotalPaid - totalPenaltyPaid));

  // Recalculate correct status
  const currentStatus = fullAccount?.status || "active";
  let newStatus: string | undefined;
  if (newRemaining <= 0) {
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
    total_paid: newTotalPaid,
    remaining_balance: newRemaining,
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
      if (allocs.length === 0) {
        // Fallback: single payment with account_id from submission
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
          account?.currency || "PHP"
        );

        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        confirmedPaymentIds.push(result.paymentId);
      } else {
        // Process each allocation as a separate payment
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
            account?.currency || "PHP"
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
