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

    const { payment_id, reason } = await req.json();
    if (!payment_id) {
      return new Response(JSON.stringify({ error: "payment_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the payment
    const { data: payment, error: payErr } = await supabase
      .from("payments")
      .select("*")
      .eq("id", payment_id)
      .is("voided_at", null)
      .single();

    if (payErr || !payment) {
      return new Response(JSON.stringify({ error: "Payment not found or already voided" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch allocations for this payment
    const { data: allocations } = await supabase
      .from("payment_allocations")
      .select("*")
      .eq("payment_id", payment_id);

    // Reverse each allocation
    for (const alloc of (allocations || [])) {
      if (alloc.allocation_type === "installment") {
        // Reverse schedule paid_amount
        const { data: sched } = await supabase
          .from("layaway_schedule")
          .select("*")
          .eq("id", alloc.schedule_id)
          .single();

        if (sched) {
          const newPaid = Math.max(0, Number(sched.paid_amount) - Number(alloc.allocated_amount));
          const newStatus = newPaid <= 0 ? "pending" : "partially_paid";
          await supabase.from("layaway_schedule").update({
            paid_amount: newPaid,
            status: newStatus,
          }).eq("id", alloc.schedule_id);
        }
      } else if (alloc.allocation_type === "penalty") {
        // Find the penalty_fee linked via payment_allocations and revert to unpaid
        // We need to find the penalty that was paid by this allocation
        const { data: penaltyFees } = await supabase
          .from("penalty_fees")
          .select("*")
          .eq("schedule_id", alloc.schedule_id)
          .eq("status", "paid")
          .eq("account_id", payment.account_id);

        if (penaltyFees && penaltyFees.length > 0) {
          // Revert the first matching paid penalty
          await supabase.from("penalty_fees").update({ status: "unpaid" }).eq("id", penaltyFees[0].id);
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
      const newTotalPaid = Math.max(0, Number(account.total_paid) - Number(payment.amount_paid));
      const newRemaining = Number(account.total_amount) - newTotalPaid;
      const newStatus = account.status === "completed" ? "active" : account.status;

      await supabase.from("layaway_accounts").update({
        total_paid: newTotalPaid,
        remaining_balance: Math.max(0, newRemaining),
        status: newStatus,
      }).eq("id", payment.account_id);
    }

    // Mark payment as voided
    await supabase.from("payments").update({
      voided_at: new Date().toISOString(),
      voided_by_user_id: user.id,
      void_reason: reason || "Voided by user",
    }).eq("id", payment_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment",
      entity_id: payment_id,
      action: "void",
      old_value_json: { amount_paid: payment.amount_paid, account_id: payment.account_id },
      new_value_json: { reason, voided_by: user.id },
      performed_by_user_id: user.id,
    });

    return new Response(JSON.stringify({ success: true, payment_id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
