import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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

    // Role check: only admin or finance may void payments
    // Permission gate (Bug #201 Batch B: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "void_payment");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "void_payment permission required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { payment_id, reason } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*")
      .eq("id", payment_id)
      .is("voided_at", null)
      .single();

    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found or already voided" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get account info (need downpayment_amount for recalculation)
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

    // Get all allocations for this payment
    const { data: allocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    // Step 1: Mark payment as voided FIRST so recalculations exclude it
    await supabase.from("payments").update({
      voided_at: new Date().toISOString(),
      voided_by_user_id: user.id,
      void_reason: reason || "Voided by user",
    }).eq("id", payment_id);

    // Step 1a: Delete payment_allocations for this payment so schedule_with_actuals
    // immediately reflects the void (view sums payment_allocations directly)
    const { error: allocDeleteErr } = await supabase
      .from("payment_allocations")
      .delete()
      .eq("payment_id", payment_id);

    if (allocDeleteErr) {
      return new Response(
        JSON.stringify({ error: "Failed to delete allocations: " + allocDeleteErr.message }),
        { status: 500, headers: corsHeaders }
      );
    }

    // Step 1b: Clear carried_amount on any schedule row where this payment triggered a carry
    // (carried_by_payment_id = payment_id). Guard with try/catch in case column doesn't exist yet.
    try {
      const { data: carryRows } = await supabase
        .from("layaway_schedule")
        .select("id")
        .eq("carried_by_payment_id", payment_id);
      for (const row of (carryRows || [])) {
        await supabase.from("layaway_schedule").update({
          carried_amount: 0,
          carried_from_schedule_id: null,
          carried_by_payment_id: null,
        }).eq("id", row.id);
      }
    } catch (_carryErr) {
      // Column may not exist yet — safe to ignore until migration runs
    }

    // Step 2: Collect all schedule IDs affected by this payment
    const affectedScheduleIds = new Set<string>();
    for (const alloc of (allocations || [])) {
      affectedScheduleIds.add(alloc.schedule_id);
    }

    // Step 3: For each affected schedule item, recalculate paid_amount
    // from all remaining non-voided payment allocations (source-of-truth)
    const { data: validPayments } = await supabase
      .from("payments")
      .select("id")
      .eq("account_id", payment.account_id)
      .is("voided_at", null);
    const validPaymentIds = new Set((validPayments || []).map(p => p.id));

    for (const scheduleId of affectedScheduleIds) {
      // Recalculate installment paid_amount from non-voided allocations
      const { data: allAllocations } = await supabase
        .from("payment_allocations")
        .select("allocated_amount, allocation_type, payment_id")
        .eq("schedule_id", scheduleId)
        .eq("allocation_type", "installment");

      const recalcPaid = (allAllocations || [])
        .filter(a => validPaymentIds.has(a.payment_id))
        .reduce((sum, a) => sum + Number(a.allocated_amount), 0);

      const { data: sched } = await supabase
        .from("layaway_schedule")
        .select("base_installment_amount, due_date")
        .eq("id", scheduleId)
        .single();

      if (sched) {
        const base = Number(sched.base_installment_amount);
        const today = new Date().toISOString().split("T")[0];
        const newSchedStatus = Math.round(recalcPaid * 100) / 100 >= Math.round(base * 100) / 100 ? "paid"
          : recalcPaid > 0 ? "partially_paid"
          : sched.due_date <= today ? "overdue"
          : "pending";

        await supabase.from("layaway_schedule").update({
          paid_amount: recalcPaid,
          status: newSchedStatus,
        }).eq("id", scheduleId);
      }

      // Revert penalty allocations for this payment on this schedule
      const penaltyAllocs = (allocations || []).filter(
        a => a.schedule_id === scheduleId && a.allocation_type === "penalty"
      );
      for (const _pa of penaltyAllocs) {
        const { data: penaltyFees } = await supabase
          .from("penalty_fees")
          .select("id")
          .eq("schedule_id", scheduleId)
          .eq("status", "paid")
          .eq("account_id", payment.account_id)
          .order("created_at", { ascending: true })
          .limit(1);
        if (penaltyFees && penaltyFees.length > 0) {
          await supabase.from("penalty_fees").update({ status: "unpaid" }).eq("id", penaltyFees[0].id);
        }
      }
    }

    // Step 4: Recalculate account totals from non-voided payments
    const newTotalPaid = (validPayments || []).length > 0
      ? await (async () => {
          const { data: activePayments } = await supabase
            .from("payments")
            .select("amount_paid")
            .eq("account_id", payment.account_id)
            .is("voided_at", null);
          return (activePayments || []).reduce((s, p) => s + Number(p.amount_paid), 0);
        })()
      : 0;

    // Canonical remaining_balance (CLAUDE.md):
    // remaining = total_amount + Σ(non-waived penalties) - total_paid
    const { data: activePensFees } = await supabase
      .from("penalty_fees")
      .select("penalty_amount")
      .eq("account_id", payment.account_id)
      .neq("status", "waived");
    const activePenaltySum = (activePensFees || []).reduce((s: number, f: any) => s + Number(f.penalty_amount), 0);
    const newRemainingBalance = Math.max(0, Math.round((Number(account.total_amount) + activePenaltySum - newTotalPaid) * 100) / 100);

    const { data: updatedSchedule } = await supabase
      .from("layaway_schedule")
      .select("status, due_date")
      .eq("account_id", payment.account_id);

    let newStatus = account.status;
    if (updatedSchedule) {
      const today = new Date().toISOString().split("T")[0];
      const allPaid = updatedSchedule.every(s => s.status === "paid" || s.status === "cancelled");
      const hasOverdue = updatedSchedule.some(s => s.status !== "paid" && s.status !== "cancelled" && s.due_date <= today);
      if (allPaid) newStatus = "completed";
      else if (hasOverdue) newStatus = "overdue";
      else newStatus = "active";
    }

    await supabase.from("layaway_accounts").update({
      total_paid: newTotalPaid,
      remaining_balance: newRemainingBalance,
      status: newStatus,
    }).eq("id", payment.account_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "void",
      old_value_json: { amount_paid: payment.amount_paid, account_id: payment.account_id },
      new_value_json: { reason, voided_by: user.id },
      performed_by_user_id: user.id,
    });

    // Trigger reconcile-account to sync schedule rows and verify totals
    try {
      const _rcRes = await fetch(
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
      if (!_rcRes.ok) {
        const _t = await _rcRes.text().catch(() => "<no body>");
        console.error(`[void-payment] reconcile-account failed (${_rcRes.status}) for ${payment.account_id}: ${_t}`);
      }
    } catch (reconcileErr) {
      console.warn(`[void-payment] reconcile-account call failed for ${payment.account_id}:`, reconcileErr);
    }

    // Send payment-voided email (fire-and-forget)
    try {
      const { data: acctForEmail } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, currency, customers(full_name, email)")
        .eq("id", payment.account_id)
        .single();
      const customerEmail = (acctForEmail as any)?.customers?.email;
      const customerName = (acctForEmail as any)?.customers?.full_name;
      if (customerEmail) {
        const portalUrl = `https://portal.chajewelsjp.com/portal?invoice=${(acctForEmail as any)?.invoice_number || ""}`;
        const result = await sendTemplateEmail(
          "payment-voided",
          customerEmail,
          {
            templateData: {
              customerName,
              invoiceNumber: (acctForEmail as any)?.invoice_number,
              amountVoided: Number(payment.amount_paid).toLocaleString("en-US"),
              currency: (acctForEmail as any)?.currency,
              voidReason: reason || "Payment voided by administrator",
              remainingBalance: Number(newRemainingBalance).toLocaleString("en-US"),
              portalUrl,
            },
            idempotencyKey: `payment-voided-${payment_id}`,
          },
        );
        if (!result.sent) {
          console.log(`[void-payment] "payment-voided" suppressed for ${customerEmail}`);
        }
      }
    } catch (emailErr) {
      console.warn("[void-payment] email send failed (non-blocking):", emailErr);
    }

    // Bug #99 — fire-and-forget loyalty revoke for voided payment.
    //   Guard: only DP voids reverse the loyalty award (award fires on DP
    //   confirmation per review-payment-submission line 829 — installment
    //   payments do not award, so they have nothing to revoke). Mirrored from
    //   restore-payment/index.ts isDownpaymentPayment helper. Inlined rather
    //   than extracted to _shared/ — single call site, 5-line helper, two
    //   total consumers (this file + restore-payment).
    const isDownpaymentPayment = (p: {
      reference_number?: string | null;
      remarks?: string | null;
    }): boolean => {
      if (p.reference_number && String(p.reference_number).startsWith("DP-")) {
        return true;
      }
      if (p.remarks) {
        const r = String(p.remarks).toLowerCase();
        if (r.includes("down") || r.includes("dp")) return true;
      }
      return false;
    };

    if (!isDownpaymentPayment(payment)) {
      console.log(`[void-payment] non-DP void, skipping loyalty revoke for payment ${payment.id}`);
    } else {
      try {
        let spendJpy: number = Number(payment.amount_paid);
        if (account.currency === "PHP") {
          const { data: rateRow } = await supabase
            .from("system_settings")
            .select("value")
            .eq("key", "php_jpy_rate")
            .single();
          const phpJpyRate = rateRow ? parseFloat(String(rateRow.value)) : NaN;
          if (Number.isFinite(phpJpyRate) && phpJpyRate > 0) {
            spendJpy = Math.round(Number(payment.amount_paid) / phpJpyRate);
          } else {
            console.warn("[void-payment] php_jpy_rate unusable, skipping loyalty revoke:", rateRow);
            throw new Error("php_jpy_rate unusable");
          }
        }
        const _rvRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/revoke-loyalty-points`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            customer_id: account.customer_id,
            source_reference: account.invoice_number,
            spend_jpy: spendJpy,
            account_id: payment.account_id,
            payment_id: payment.id,
            invoice_number: account.invoice_number,
            notes: `Layaway payment voided: ${payment.id}`,
            trigger_event: "void_layaway",
          }),
        }).catch((e) => {
          console.warn("[void-payment] revoke-loyalty-points failed (non-blocking):", e);
          return null;
        });
        if (_rvRes && !_rvRes.ok) {
          const _t = await _rvRes.text().catch(() => "<no body>");
          console.error(`[void-payment] revoke-loyalty-points failed (${_rvRes.status}): ${_t}`);
        }
      } catch (revokeErr) {
        console.warn("[void-payment] revoke block failed (non-blocking):", revokeErr);
      }
    }

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
