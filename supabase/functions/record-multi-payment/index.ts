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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user via anon client
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await anonClient.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;

    // Service role client for data ops
    const supabase = createClient(supabaseUrl, serviceKey);

    // ── Role check: only admin/finance can directly record payments ──
    const [{ data: isAdmin }, { data: isFinance }] = await Promise.all([
      supabase.rpc("has_role", { _user_id: userId, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: userId, _role: "finance" }),
    ]);
    const canConfirm = isAdmin || isFinance;

    const body = await req.json();
    const {
      customer_id,
      total_amount_paid,
      date_paid,
      payment_method,
      remarks,
      preview_only,
      allocations: inputAllocations,
    } = body as {
      customer_id: string;
      total_amount_paid: number;
      date_paid?: string;
      payment_method?: string;
      remarks?: string;
      preview_only?: boolean;
      allocations: Array<{ account_id: string; amount: number; is_downpayment?: boolean; carry_over?: boolean }>;
    };

    // Validate input
    if (!customer_id || !inputAllocations || !Array.isArray(inputAllocations) || inputAllocations.length === 0) {
      return new Response(JSON.stringify({ error: "Missing customer_id or allocations" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        const unpaidItems = schedule.filter(
          item => item.status !== "paid" && item.status !== "cancelled"
        ).sort((a, b) => a.installment_number - b.installment_number);

        for (const item of unpaidItems) {
          if (remaining <= 0) break;

          const currentPaid = Number(item.paid_amount);
          const targetAmount = Number(item.total_due_amount); // DB value — may be adjusted from prior rollover
          // For partially_paid rows where total_due_amount was set to remaining (new semantics),
          // paid_amount exceeds total_due_amount — use total_due_amount directly as the remaining.
          const isNewPartialSemantics = item.status === "partially_paid" && currentPaid > targetAmount;
          const due = isNewPartialSemantics
            ? Math.max(0, targetAmount)
            : Math.max(0, targetAmount - currentPaid);
          if (due <= 0) continue;

          const availableForThisMonth = remaining;
          const toApply = Math.round(Math.min(remaining, due) * 100) / 100;
          remaining = Math.round((remaining - toApply) * 100) / 100;
          const newPaid = Math.round((currentPaid + toApply) * 100) / 100;
          const isNowFullyPaid = newPaid >= targetAmount;

          if (isNowFullyPaid && item.status === "partially_paid") {
            // GHOST PREVENTION: topping up a partial month — mark paid with actual total paid
            paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
            scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "paid" });
            remaining = 0;
            break;

          } else if (isNowFullyPaid) {
            // PENDING MONTH FULLY PAID — store actual cash; cascade excess to reduce subsequent months
            const storedPaid = Math.round((currentPaid + availableForThisMonth) * 100) / 100;
            paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: availableForThisMonth });
            scheduleUpdates.push({ id: item.id, paid_amount: storedPaid, status: "paid" });
            if (remaining > 0) {
              for (const nextItem of unpaidItems) {
                if (remaining <= 0) break;
                if (nextItem.installment_number <= item.installment_number) continue;
                const nextDue = Number(nextItem.total_due_amount);
                const creditAmt = Math.round(Math.min(remaining, nextDue) * 100) / 100;
                remaining = Math.round((remaining - creditAmt) * 100) / 100;
                scheduleUpdates.push({ id: nextItem.id, paid_amount: creditAmt, total_due_amount: Math.max(0, Math.round((nextDue - creditAmt) * 100) / 100), status: creditAmt >= nextDue ? "paid" : "partially_paid" });
                if (creditAmt > 0.005) {
                  paymentAllocations.push({
                    schedule_id: nextItem.id,
                    allocation_type: "installment",
                    allocated_amount: creditAmt,
                  });
                }
              }
              remaining = 0;
            }
            break;

          } else if (item.status !== "partially_paid") {
            // PENDING MONTH UNDERPAID — set partial row; carry shortfall only if carry_over=true
            const shortfall = Math.round((due - toApply) * 100) / 100;
            paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
            // Set total_due_amount = shortfall (remaining) on the partial row.
            // Do NOT inflate the next row's total_due_amount — canonical remaining_balance
            // already captures the full debt correctly and inflating future rows causes
            // double-counting in display and audit checks.
            scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "partially_paid", total_due_amount: shortfall });
            // remaining=0 after toApply; outer loop stops naturally

          } else {
            // PARTIALLY_PAID MONTH — additional payment, not completing
            const newRemaining = Math.max(0, Math.round((due - toApply) * 100) / 100);
            paymentAllocations.push({ schedule_id: item.id, allocation_type: "installment", allocated_amount: toApply });
            scheduleUpdates.push({ id: item.id, paid_amount: newPaid, status: "partially_paid", total_due_amount: newRemaining });
            // remaining=0; outer loop stops naturally
          }
        }
      }

      const newTotalPaid = Number(acct.total_paid) + amountForAccount;
      const newRemainingBalance = Number(acct.total_amount) - newTotalPaid;

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

      // If not preview, persist changes
      if (!preview_only && !canConfirm) {
        // Staff: create payment submission instead
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
      } else if (!preview_only && canConfirm) {
        console.log(`[multi-pay] Persisting payment for ${acct.invoice_number}: ${amountForAccount}, scheduleUpdates=${JSON.stringify(scheduleUpdates)}`);
        
        // Create payment record
        const { data: payment, error: payErr } = await supabase
          .from("payments")
          .insert({
            account_id: inputAlloc.account_id,
            amount_paid: amountForAccount,
            currency: acct.currency,
            date_paid: effectiveDate,
            payment_method: effectiveMethod,
            reference_number: batchId,
            remarks: remarks ? `[Multi-invoice] ${remarks}` : `[Multi-invoice batch: ${batchId}]`,
            entered_by_user_id: userId,
            submitted_by_type: "staff",
            submitted_by_name: (claimsData.user.user_metadata as any)?.full_name || claimsData.user.email || null,
          })
          .select()
          .single();

        if (payErr) {
          console.error(`[multi-pay] Payment insert error for ${acct.invoice_number}:`, payErr);
          throw payErr;
        }
        console.log(`[multi-pay] Payment inserted: ${payment.id}`);

        // Create allocations (duplicate guard: skip if row already exists)
        for (const alloc of paymentAllocations) {
          const { data: existing } = await supabase
            .from("payment_allocations")
            .select("id")
            .eq("schedule_id", alloc.schedule_id)
            .eq("payment_id", payment.id)
            .eq("allocation_type", alloc.allocation_type)
            .maybeSingle();
          if (existing) continue;

          const { error: allocErr } = await supabase.from("payment_allocations").insert({
            payment_id: payment.id,
            schedule_id: alloc.schedule_id,
            allocation_type: alloc.allocation_type,
            allocated_amount: alloc.allocated_amount,
          });
          if (allocErr) {
            console.error(`[multi-pay] Allocation insert error:`, allocErr);
            throw allocErr;
          }
        }

        // Update penalties
        for (const pen of penaltyUpdates) {
          const { error: penErr } = await supabase.from("penalty_fees").update({ status: pen.status }).eq("id", pen.id);
          if (penErr) {
            console.error(`[multi-pay] Penalty update error:`, penErr);
            throw penErr;
          }
        }

        // Update schedule (base_installment_amount is IMMUTABLE; total_due_amount only updated for rollover)
        for (const item of scheduleUpdates) {
          const schedFields: any = { paid_amount: item.paid_amount, status: item.status };
          if (item.total_due_amount !== undefined) schedFields.total_due_amount = item.total_due_amount;
          const { error: schedErr } = await supabase.from("layaway_schedule").update(schedFields).eq("id", item.id);
          if (schedErr) {
            console.error(`[multi-pay] Schedule update error:`, schedErr);
            throw schedErr;
          }
        }
        console.log(`[multi-pay] Schedule updated for ${acct.invoice_number}`);

        // Update account
        const { error: acctErr } = await supabase
          .from("layaway_accounts")
          .update({
            total_paid: newTotalPaid,
            remaining_balance: Math.max(0, newRemainingBalance),
            status: newStatus,
          })
          .eq("id", inputAlloc.account_id);
        if (acctErr) {
          console.error(`[multi-pay] Account update error:`, acctErr);
          throw acctErr;
        }
        console.log(`[multi-pay] Account updated: total_paid=${newTotalPaid}, remaining=${Math.max(0, newRemainingBalance)}, status=${newStatus}`);

        // Audit log
        await supabase.from("audit_logs").insert({
          entity_type: "payment",
          entity_id: payment.id,
          action: "create_multi",
          new_value_json: {
            batch_id: batchId,
            amount_paid: amountForAccount,
            account_id: inputAlloc.account_id,
            total_batch_amount: totalAllocated,
            allocations: paymentAllocations,
          },
          performed_by_user_id: userId,
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
              body: JSON.stringify({ account_id: inputAlloc.account_id }),
            }
          );
        } catch (reconcileErr) {
          console.warn(`[multi-pay] reconcile-account call failed for ${acct.invoice_number}:`, reconcileErr);
        }

      }
    }

    // If staff submitted (not preview, not canConfirm), return submission info
    if (!preview_only && !canConfirm) {
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
        preview: !!preview_only,
        batch_id: batchId,
        total_amount: totalAllocated,
        account_results: results,
      }),
      {
        status: preview_only ? 200 : 201,
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
