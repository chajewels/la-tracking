import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user via service role client
    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;

    // Staff-only gate — prevents Phase B customers from injecting payment submissions for arbitrary accounts
    const { data: userIsStaff } = await supabase.rpc("is_staff", { _user_id: userId });
    if (!userIsStaff) {
      return new Response(JSON.stringify({ error: "Staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Universal submission-only path (Bug #219): every non-preview call,
    //    regardless of role, creates pending payment_submissions rows.
    //    Direct writes to the payments table happen ONLY via
    //    review-payment-submission.
    const body = await req.json();
    const {
      customer_id,
      total_amount_paid,
      date_paid,
      payment_method,
      remarks,
      preview_only,
      allocations: inputAllocations,
      proof_url,
    } = body as {
      customer_id: string;
      total_amount_paid: number;
      date_paid?: string;
      payment_method?: string;
      remarks?: string;
      preview_only?: boolean;
      allocations: Array<{ account_id: string; amount: number; is_downpayment?: boolean; carry_over?: boolean }>;
      proof_url?: string;
    };

    // Validate input
    if (!customer_id || !inputAllocations || !Array.isArray(inputAllocations) || inputAllocations.length === 0) {
      return new Response(JSON.stringify({ error: "Missing customer_id or allocations" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PROOF REQUIRED (2026-06-30): every non-preview submit must carry a
    // non-empty proof_url. Preview writes nothing, so it is exempt.
    if (!preview_only && (typeof proof_url !== "string" || proof_url.trim().length === 0)) {
      return new Response(JSON.stringify({ error: "Proof of payment is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const totalAllocated = inputAllocations.reduce((s, a) => s + Number(a.amount), 0);
    if (totalAllocated <= 0) {
      return new Response(JSON.stringify({ error: "Total allocated must be > 0" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check total matches
    if (total_amount_paid && Math.abs(totalAllocated - Number(total_amount_paid)) > 1) {
      return new Response(
        JSON.stringify({ error: "Allocation total does not match total_amount_paid" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch all target accounts
    const accountIds = inputAllocations.map((a) => a.account_id);
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .in("id", accountIds)
      .eq("customer_id", customer_id);

    if (accErr || !accounts || accounts.length !== accountIds.length) {
      return new Response(
        JSON.stringify({ error: "One or more accounts not found or don't belong to this customer" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate each account is active/overdue and amount <= remaining_balance
    for (const alloc of inputAllocations) {
      const acct = accounts.find((a) => a.id === alloc.account_id);
      if (!acct) continue;
      if (acct.status !== "active" && acct.status !== "overdue") {
        return new Response(
          JSON.stringify({ error: `Account ${acct.invoice_number} is not active` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (Number(alloc.amount) > Number(acct.remaining_balance) + 1) {
        return new Response(
          JSON.stringify({
            error: `Amount for ${acct.invoice_number} exceeds remaining balance`,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Process each account's allocation using the same logic as record-payment
    const results: Array<{
      account_id: string;
      invoice_number: string;
      amount_allocated: number;
      payment_allocations: any[];
      new_total_paid: number;
      new_remaining_balance: number;
      new_status: string;
    }> = [];

    const effectiveDate = date_paid || new Date().toISOString().split("T")[0];
    const effectiveMethod = payment_method || "cash";
    const batchId = crypto.randomUUID();

    for (const inputAlloc of inputAllocations) {
      if (Number(inputAlloc.amount) <= 0) continue;

      const acct = accounts.find((a) => a.id === inputAlloc.account_id)!;
      const amountForAccount = Number(inputAlloc.amount);
      const carryOver = !!inputAlloc.carry_over;
      console.log(`[multi-pay] Processing account ${acct.invoice_number}: amount=${amountForAccount}`);

      // Fetch schedule
      const { data: schedule } = await supabase
        .from("layaway_schedule")
        .select("*")
        .eq("account_id", inputAlloc.account_id)
        .order("installment_number", { ascending: true });

      // Fetch unpaid penalties
      const { data: unpaidPenalties } = await supabase
        .from("penalty_fees")
        .select("*")
        .eq("account_id", inputAlloc.account_id)
        .eq("status", "unpaid")
        .order("penalty_date", { ascending: true });

      // Allocate: penalties first, then installments
      let remaining = Math.round(amountForAccount * 100) / 100;
      const paymentAllocations: Array<{
        schedule_id: string;
        allocation_type: "penalty" | "installment";
        allocated_amount: number;
        penalty_fee_id?: string;
      }> = [];
      const penaltyUpdates: Array<{ id: string; status: string }> = [];
      const scheduleUpdates: Array<{
        id: string;
        paid_amount: number;
        status: string;
        total_due_amount?: number;
      }> = [];

      // DP payments skip all schedule and penalty allocation.
      const isDP = !!inputAlloc.is_downpayment;

      if (!isDP && unpaidPenalties) {
        for (const pen of unpaidPenalties) {
          if (remaining <= 0) break;
          const penAmount = Number(pen.penalty_amount);
          const toPay = Math.round(Math.min(remaining, penAmount) * 100) / 100;
          remaining = Math.round((remaining - toPay) * 100) / 100;
          paymentAllocations.push({
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

      // Allocate remaining to installments sequentially — not for DP payments.
      if (!isDP && schedule && remaining > 0) {
        // Fetch existing allocations from payment_allocations — never use stale paid_amount cache
        const { data: existingAllocsRaw } = await supabase
          .from("payment_allocations")
          .select("schedule_id, allocated_amount, allocation_type, payment_id")
          .in("schedule_id", schedule.map((s: any) => s.id));

        const { data: voidedPmts } = await supabase
          .from("payments")
          .select("id")
          .eq("account_id", inputAlloc.account_id)
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

          const base = Number(item.base_installment_amount);
          const penalty = Number(item.penalty_amount || 0);
          const carried = Number(item.carried_amount || 0);
          const alreadyAllocated = allocatedBySchedule.get(item.id) || 0;
          const alreadyAllocatedPenalty = (penaltyAllocBySchedule.get(item.id) || 0) +
            paymentAllocations.filter(a => a.schedule_id === item.id && a.allocation_type === "penalty")
              .reduce((sum, a) => sum + a.allocated_amount, 0);

          const naturalCeiling = base + penalty + carried;
          const rowCeiling = item.total_due_amount
            ? Math.min(naturalCeiling, Number(item.total_due_amount))
            : naturalCeiling;
          const due = Math.max(0, rowCeiling - alreadyAllocated - alreadyAllocatedPenalty);
          if (due <= 0) continue;

          const toApply = Math.round(Math.min(remaining, due) * 100) / 100;
          remaining = Math.round((remaining - toApply) * 100) / 100;
          const newPaid = Math.round((alreadyAllocated + toApply) * 100) / 100;
          const isNowFullyPaid = newPaid + alreadyAllocatedPenalty >= rowCeiling - 0.005;

          paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
          scheduleUpdates.push({
            id: item.id,
            paid_amount: newPaid,
            status: isNowFullyPaid ? "paid" : "partially_paid",
          });
        }
      }

      const newTotalPaid = Number(acct.total_paid) + amountForAccount;
      // Preview approximation: total_amount + activePenalties - newTotalPaid
      // (uses cached acct.total_paid + new amount as approximation before DB insert)
      const { data: previewPens } = await supabase
        .from("penalty_fees")
        .select("penalty_amount")
        .eq("account_id", inputAlloc.account_id)
        .neq("status", "waived");
      const previewPenaltySum = (previewPens || [])
        .reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
      const newRemainingBalance = Math.max(0,
        Math.round((Number(acct.total_amount) + previewPenaltySum - newTotalPaid) * 100) / 100);

      // Recalculate correct status based on updated schedule state
      let newStatus: string;
      if (newRemainingBalance <= 0) {
        newStatus = "completed";
      } else if (["active", "overdue"].includes(acct.status)) {
        const todayStr = new Date().toISOString().split("T")[0];
        // Check if there will still be overdue items after applying scheduleUpdates
        const paidIds = new Set(scheduleUpdates.filter((u: any) => u.status === "paid").map((u: any) => u.id));
        const stillOverdue = (schedule || []).some((s: any) =>
          s.status !== "paid" && s.status !== "cancelled" && !paidIds.has(s.id) && s.due_date < todayStr
        );
        newStatus = stillOverdue ? "overdue" : "active";
      } else {
        newStatus = acct.status;
      }

      results.push({
        account_id: inputAlloc.account_id,
        invoice_number: acct.invoice_number,
        amount_allocated: amountForAccount,
        payment_allocations: paymentAllocations,
        new_total_paid: newTotalPaid,
        new_remaining_balance: Math.max(0, newRemainingBalance),
        new_status: newStatus,
      });

      // If not preview, create a pending payment_submissions row for every
      // role (Bug #219). Direct writes to the payments table happen ONLY via
      // review-payment-submission. The prior canConfirm direct-write branch
      // was removed (Bug #218).
      if (!preview_only) {
        const { data: submission, error: subErr } = await supabase
          .from("payment_submissions")
          .insert({
            account_id: inputAlloc.account_id,
            customer_id: customer_id,
            submitted_amount: amountForAccount,
            payment_date: effectiveDate,
            payment_method: effectiveMethod,
            reference_number: batchId,
            notes: remarks ? `[Multi-invoice] ${remarks}` : `[Multi-invoice batch: ${batchId}]`,
            status: "submitted",
            submission_type: inputAlloc.is_downpayment ? 'downpayment' : 'installment',
            sender_name: (claimsData.user.user_metadata as any)?.full_name || claimsData.user.email || null,
            proof_url: proof_url.trim(),
          })
          .select("id")
          .single();
        if (subErr) throw subErr;

        await supabase.from("audit_logs").insert({
          entity_type: "payment_submission",
          entity_id: submission.id,
          action: "staff_multi_payment_submitted",
          new_value_json: {
            batch_id: batchId,
            amount: amountForAccount,
            account_id: inputAlloc.account_id,
          },
          performed_by_user_id: userId,
        });
      }
    }

    // Non-preview: every account in the batch was submitted for confirmation.
    if (!preview_only) {
      return new Response(
        JSON.stringify({
          submitted_for_confirmation: true,
          batch_id: batchId,
          total_amount: totalAllocated,
          message: "Payments submitted for confirmation. Admin/Finance will review.",
        }),
        {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        preview: true,
        batch_id: batchId,
        total_amount: totalAllocated,
        account_results: results,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
