import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    const { payment_id } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the voided payment
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*")
      .eq("id", payment_id)
      .not("voided_at", "is", null)
      .single();

    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found or not voided" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch allocations to reapply
    const { data: allocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    // Reapply each allocation
    for (const alloc of (allocations || [])) {
      if (alloc.allocation_type === "installment") {
        const { data: sched } = await supabase
          .from("layaway_schedule")
          .select("*")
          .eq("id", alloc.schedule_id)
          .single();

        if (sched) {
          const newPaid = Number(sched.paid_amount) + Number(alloc.allocated_amount);
          const newStatus = newPaid >= Number(sched.base_installment_amount) ? "paid" : "partially_paid";
          await supabase.from("layaway_schedule").update({
            paid_amount: newPaid,
            status: newStatus,
          }).eq("id", alloc.schedule_id);
        }
      } else if (alloc.allocation_type === "penalty") {
        const { data: penaltyFees } = await supabase
          .from("penalty_fees")
          .select("*")
          .eq("schedule_id", alloc.schedule_id)
          .eq("status", "unpaid")
          .eq("account_id", payment.account_id);

        if (penaltyFees && penaltyFees.length > 0) {
          await supabase.from("penalty_fees").update({ status: "paid" }).eq("id", penaltyFees[0].id);
        }
      }
    }

    // Update account totals
    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", payment.account_id)
      .single();

    if (account) {
      const newTotalPaid = Number(account.total_paid) + Number(payment.amount_paid);
      const newRemaining = Number(account.total_amount) - newTotalPaid;
      const newStatus = newRemaining <= 0 ? "completed" : account.status;

      await supabase.from("layaway_accounts").update({
        total_paid: newTotalPaid,
        remaining_balance: Math.max(0, newRemaining),
        status: newStatus,
      }).eq("id", payment.account_id);

      // Recalculate remaining installment amounts
      if (newRemaining > 0) {
        const { data: schedule } = await supabase
          .from("layaway_schedule")
          .select("*")
          .eq("account_id", payment.account_id)
          .order("installment_number", { ascending: true });

        if (schedule) {
          const unpaidInstallments = schedule.filter(
            (s) => s.status !== "paid"
          );

          if (unpaidInstallments.length > 0) {
            const { data: unpaidPenalties } = await supabase
              .from("penalty_fees")
              .select("*")
              .eq("account_id", payment.account_id)
              .eq("status", "unpaid");

            const totalUnpaidPenalties = (unpaidPenalties || [])
              .reduce((sum, p) => sum + Number(p.penalty_amount), 0);

            const alreadyPartiallyPaid = unpaidInstallments
              .reduce((sum, s) => sum + Number(s.paid_amount), 0);
            const remainingPrincipal = Math.max(0, newRemaining - totalUnpaidPenalties);
            const principalToDistribute = remainingPrincipal - alreadyPartiallyPaid;

            const perMonth = Math.floor(principalToDistribute / unpaidInstallments.length);
            const rem = principalToDistribute - perMonth * unpaidInstallments.length;

            for (let i = 0; i < unpaidInstallments.length; i++) {
              const newBase = Number(unpaidInstallments[i].paid_amount) + (i === 0 ? perMonth + rem : perMonth);
              const penAmt = Number(unpaidInstallments[i].penalty_amount);
              await supabase.from("layaway_schedule").update({
                base_installment_amount: newBase,
                total_due_amount: newBase + penAmt,
              }).eq("id", unpaidInstallments[i].id);
            }
          }
        }
      }
    }

    // Clear void fields
    await supabase.from("payments").update({
      voided_at: null,
      voided_by_user_id: null,
      void_reason: null,
    }).eq("id", payment_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "restore",
      old_value_json: { voided_at: payment.voided_at, void_reason: payment.void_reason },
      new_value_json: { restored_by: user.id },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
