import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Verify the user from the JWT
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

    // ── CRITICAL: Only admin or finance can confirm/reject/clarify ──
    const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
    ]);

    if (!isAdmin && !isFinance) {
      return new Response(JSON.stringify({ error: "Access denied. Only admin or finance roles can review payment submissions." }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the submission
    const { data: submission, error: subErr } = await supabase
      .from("payment_submissions")
      .select("*, layaway_accounts!inner(id, currency, customer_id, remaining_balance, total_paid, invoice_number)")
      .eq("id", submission_id)
      .maybeSingle();

    if (subErr || !submission) {
      return new Response(JSON.stringify({ error: "Submission not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let confirmedPaymentId = null;

    // If confirming, create actual payment record via the same allocation logic
    if (action === "confirmed") {
      const account = submission.layaway_accounts;
      const accountId = account.id;
      const amountPaid = Number(submission.submitted_amount);

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

      // Allocate payment: penalties first, then installments
      let remaining = amountPaid;
      const allocations: Array<{
        schedule_id: string;
        allocation_type: "penalty" | "installment";
        allocated_amount: number;
        penalty_fee_id?: string;
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
            penalty_fee_id: pen.id,
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
          .filter(item => item.status !== "paid" && item.status !== "cancelled")
          .sort((a: any, b: any) => a.installment_number - b.installment_number);

        for (const item of unpaidItems) {
          if (remaining <= 0) break;
          const currentPaid = Number(item.paid_amount);
          const baseAmount = Number(item.base_installment_amount);
          const due = Math.max(0, baseAmount - currentPaid);
          if (due <= 0) continue;

          const toApply = Math.min(remaining, due);
          remaining -= toApply;
          const newPaid = currentPaid + toApply;
          const newStatus = newPaid >= baseAmount ? "paid" : "partially_paid";

          allocations.push({
            schedule_id: item.id,
            allocation_type: "installment",
            allocated_amount: toApply,
          });
          scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: newStatus });
        }
      }

      // Create payment record
      const { data: payment, error: payErr } = await supabase
        .from("payments")
        .insert({
          account_id: accountId,
          amount_paid: amountPaid,
          currency: account.currency,
          date_paid: submission.payment_date,
          payment_method: submission.payment_method,
          reference_number: submission.reference_number,
          remarks: `Payment submitted${submission.notes ? ': ' + submission.notes : ''}. Submission #${submission.id.substring(0, 8)}`,
          entered_by_user_id: user.id,
        })
        .select("id")
        .single();

      if (payErr) {
        console.error("Payment insert error:", payErr);
        return new Response(JSON.stringify({ error: "Failed to create payment record" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      confirmedPaymentId = payment.id;

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
      const newTotalPaid = Number(account.total_paid) + amountPaid;
      const { data: fullAccount } = await supabase
        .from("layaway_accounts")
        .select("total_amount")
        .eq("id", accountId)
        .single();
      const totalAmount = Number(fullAccount?.total_amount || 0);
      const newRemaining = Math.max(0, totalAmount - newTotalPaid);
      const newStatus = newRemaining <= 0 ? "completed" : undefined;

      const accountUpdate: Record<string, unknown> = {
        total_paid: newTotalPaid,
        remaining_balance: newRemaining,
      };
      if (newStatus) accountUpdate.status = newStatus;

      await supabase
        .from("layaway_accounts")
        .update(accountUpdate)
        .eq("id", accountId);
    }

    // Update submission status
    const updateData: Record<string, unknown> = {
      status: action,
      reviewer_user_id: user.id,
      reviewer_notes: reviewer_notes || null,
      updated_at: new Date().toISOString(),
    };

    if (confirmedPaymentId) {
      updateData.confirmed_payment_id = confirmedPaymentId;
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
        confirmed_payment_id: confirmedPaymentId,
      },
      old_value_json: { status: submission.status },
    });

    return new Response(JSON.stringify({ success: true, status: action, confirmed_payment_id: confirmedPaymentId }), {
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
