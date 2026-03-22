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

    // Verify staff role
    const { data: isStaff } = await supabase.rpc("is_staff", { _user_id: user.id });
    if (!isStaff) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
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

    // If confirming, create actual payment record
    if (action === "confirmed") {
      const account = submission.layaway_accounts;

      // Create payment via record-payment edge function logic
      const { data: payment, error: payErr } = await supabase
        .from("payments")
        .insert({
          account_id: submission.account_id,
          amount_paid: submission.submitted_amount,
          currency: account.currency,
          date_paid: submission.payment_date,
          payment_method: submission.payment_method,
          reference_number: submission.reference_number,
          remarks: `Payment submitted via portal. Submission #${submission.id.substring(0, 8)}`,
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

      // Update account totals
      const newTotalPaid = Number(account.total_paid) + Number(submission.submitted_amount);
      const newRemaining = Number(account.remaining_balance) - Number(submission.submitted_amount);

      await supabase
        .from("layaway_accounts")
        .update({
          total_paid: Math.max(0, newTotalPaid),
          remaining_balance: Math.max(0, newRemaining),
        })
        .eq("id", submission.account_id);
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
