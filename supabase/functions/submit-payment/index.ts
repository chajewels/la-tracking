import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Allocation {
  account_id: string;
  invoice_number: string;
  allocated_amount: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      portal_token,
      account_id,        // for single payments (backward compat)
      submitted_amount,
      payment_date,
      payment_method,
      reference_number,
      sender_name,
      notes,
      proof_url,
      submission_type,    // 'single' | 'split'
      allocations,        // Array<{ account_id, invoice_number, allocated_amount }>
    } = body;

    // Validate required fields
    if (!portal_token || portal_token.length < 16) {
      return new Response(JSON.stringify({ error: "Invalid portal token" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!submitted_amount || !payment_date || !payment_method) {
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

    const isSplit = submission_type === 'split';
    const parsedAllocations: Allocation[] = isSplit ? (allocations || []) : [];

    // For single payment, account_id is required
    if (!isSplit && !account_id) {
      return new Response(JSON.stringify({ error: "Missing account_id for single payment" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // For split payment, validate allocations
    if (isSplit) {
      if (!parsedAllocations.length) {
        return new Response(JSON.stringify({ error: "Split payment requires allocations" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const allocTotal = parsedAllocations.reduce((s, a) => s + Number(a.allocated_amount), 0);
      const diff = Math.abs(allocTotal - Number(submitted_amount));
      if (diff > 0.01) {
        return new Response(JSON.stringify({ error: `Allocation total (${allocTotal}) does not match submitted amount (${submitted_amount})` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
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

    const customerId = tokenRow.customer_id;

    // Determine the primary account_id (first allocation for split, or the given one)
    const primaryAccountId = isSplit ? parsedAllocations[0].account_id : account_id;

    // Verify all accounts belong to this customer
    const accountIds = isSplit
      ? [...new Set(parsedAllocations.map(a => a.account_id))]
      : [account_id];

    for (const aid of accountIds) {
      const { data: acct } = await supabase
        .from("layaway_accounts")
        .select("id, customer_id")
        .eq("id", aid)
        .eq("customer_id", customerId)
        .maybeSingle();
      if (!acct) {
        return new Response(JSON.stringify({ error: "Account not found or access denied" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Check for duplicate submissions within last 5 minutes
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: recentDupes } = await supabase
      .from("payment_submissions")
      .select("id")
      .eq("customer_id", customerId)
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
        customer_id: customerId,
        account_id: primaryAccountId,
        submitted_amount,
        payment_date,
        payment_method,
        reference_number: reference_number || null,
        sender_name: sender_name || null,
        notes: notes || null,
        proof_url: proof_url || null,
        portal_token,
        status: "submitted",
        submission_type: body.submission_type ?? (isSplit ? "split" : "single"),
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

    // Insert allocations for split payments
    if (isSplit && parsedAllocations.length > 0) {
      const allocRows = parsedAllocations.map(a => ({
        submission_id: submission.id,
        account_id: a.account_id,
        invoice_number: a.invoice_number,
        allocated_amount: a.allocated_amount,
      }));
      const { error: allocErr } = await supabase
        .from("payment_submission_allocations")
        .insert(allocRows);
      if (allocErr) {
        console.error("Allocation insert error:", allocErr);
        // Don't fail the whole submission, the submission is already created
      }
    }

    // For single payments, also create an allocation record for consistency
    if (!isSplit) {
      const { data: acctData } = await supabase
        .from("layaway_accounts")
        .select("invoice_number")
        .eq("id", primaryAccountId)
        .single();
      await supabase
        .from("payment_submission_allocations")
        .insert({
          submission_id: submission.id,
          account_id: primaryAccountId,
          invoice_number: acctData?.invoice_number || '',
          allocated_amount: submitted_amount,
        });
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "payment_submission",
      entity_id: submission.id,
      action: "submission_created",
      new_value_json: {
        account_id: primaryAccountId,
        amount: submitted_amount,
        method: payment_method,
        reference: reference_number,
        submission_type: isSplit ? "split" : "single",
        allocation_count: isSplit ? parsedAllocations.length : 1,
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
