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
    const body = await req.json();
    const {
      portal_token,
      account_id,
      submitted_amount,
      payment_date,
      payment_method,
      reference_number,
      sender_name,
      notes,
      proof_url,
    } = body;

    // Validate required fields
    if (!portal_token || portal_token.length < 16) {
      return new Response(JSON.stringify({ error: "Invalid portal token" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!account_id || !submitted_amount || !payment_date || !payment_method) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (submitted_amount <= 0) {
      return new Response(JSON.stringify({ error: "Amount must be positive" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validate portal token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("customer_portal_tokens")
      .select("customer_id, expires_at, is_active")
      .eq("token", portal_token)
      .eq("is_active", true)
      .maybeSingle();

    if (tokenErr || !tokenRow) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "Portal link has expired" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify account belongs to this customer
    const { data: account } = await supabase
      .from("layaway_accounts")
      .select("id, customer_id, status, remaining_balance, currency")
      .eq("id", account_id)
      .eq("customer_id", tokenRow.customer_id)
      .maybeSingle();

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found or access denied" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check for duplicate submissions within last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentDupes } = await supabase
      .from("payment_submissions")
      .select("id")
      .eq("account_id", account_id)
      .eq("submitted_amount", submitted_amount)
      .eq("payment_method", payment_method)
      .gte("created_at", fiveMinAgo)
      .limit(1);

    if (recentDupes && recentDupes.length > 0) {
      return new Response(JSON.stringify({ error: "A similar submission was already made recently. Please wait before submitting again." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert submission
    const { data: submission, error: insertErr } = await supabase
      .from("payment_submissions")
      .insert({
        customer_id: tokenRow.customer_id,
        account_id,
        submitted_amount,
        payment_date,
        payment_method,
        reference_number: reference_number || null,
        sender_name: sender_name || null,
        notes: notes || null,
        proof_url: proof_url || null,
        portal_token,
        status: "submitted",
      })
      .select("id, status, created_at")
      .single();

    if (insertErr) {
      console.error("Insert error:", insertErr);
      return new Response(JSON.stringify({ error: "Failed to submit payment" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment_submission",
      entity_id: submission.id,
      action: "submission_created",
      new_value_json: {
        account_id,
        amount: submitted_amount,
        method: payment_method,
        reference: reference_number,
      },
    });

    return new Response(JSON.stringify({ success: true, submission }), {
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
