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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const {
      cash_order_id,
      submitted_amount,
      payment_method,
      reference_number,
      payment_date,
      sender_name,
      proof_url,
      notes,
      portal_token,
    } = body;

    // 1. Basic body validation
    if (!cash_order_id || submitted_amount == null || !payment_method || !payment_date || !sender_name) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const submittedNum = Number(submitted_amount);
    if (!Number.isFinite(submittedNum) || submittedNum <= 0) {
      return new Response(JSON.stringify({ error: "submitted_amount must be a positive number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Auth — Path A (portal_token in body) or Path B (Bearer token)
    let pathACustomerId: string | null = null;
    let pathBUserId: string | null = null;

    if (portal_token) {
      // Path A: customer portal
      const { data: tokenRow, error: tokenErr } = await supabase
        .from("customer_portal_tokens")
        .select("customer_id, expires_at, is_active")
        .eq("token", portal_token)
        .eq("is_active", true)
        .maybeSingle();
      if (tokenErr || !tokenRow) {
        return new Response(JSON.stringify({ error: "Invalid portal token" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "Portal link has expired" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      pathACustomerId = tokenRow.customer_id;
    } else {
      // Path B: staff bearer token
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
      const [{ data: isAdmin }, { data: isFinance }, { data: isStaff }] = await Promise.all([
        supabase.rpc("has_role", { _user_id: user.id, _role: "admin" }),
        supabase.rpc("has_role", { _user_id: user.id, _role: "finance" }),
        supabase.rpc("has_role", { _user_id: user.id, _role: "staff" }),
      ]);
      if (!isAdmin && !isFinance && !isStaff) {
        return new Response(JSON.stringify({ error: "Admin, finance, or staff access required" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      pathBUserId = user.id;
    }

    // 3. Fetch cash order — must exist and be pending
    const { data: cashOrder, error: cashErr } = await supabase
      .from("cash_orders")
      .select("id, customer_id, status, remaining_balance, currency, invoice_number")
      .eq("id", cash_order_id)
      .maybeSingle();
    if (cashErr || !cashOrder) {
      return new Response(JSON.stringify({ error: "cash_order_id not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (cashOrder.status !== "pending") {
      return new Response(JSON.stringify({ error: `cash_order is ${cashOrder.status}, cannot accept payment` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Path A — customer must own this cash order
    if (pathACustomerId && cashOrder.customer_id !== pathACustomerId) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4a. Block duplicate pending submission for this cash order
    const { data: existingSubmission } = await supabase
      .from('payment_submissions')
      .select('id, status')
      .eq('cash_order_id', cash_order_id)
      .in('status', ['submitted', 'under_review'])
      .maybeSingle();

    if (existingSubmission) {
      return new Response(
        JSON.stringify({ error: 'A payment submission is already pending review for this order. Please wait for it to be reviewed or cancel it first.' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4b. Rate limit — max 3 non-rejected submissions per cash order in 24 hours
    const { count: recentCount } = await supabase
      .from('payment_submissions')
      .select('*', { count: 'exact', head: true })
      .eq('cash_order_id', cash_order_id)
      .neq('status', 'rejected')
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if ((recentCount ?? 0) >= 3) {
      return new Response(
        JSON.stringify({ error: 'Too many submissions. Maximum 3 payment submissions per 24 hours.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 5. submitted_amount must not exceed remaining_balance
    const remaining = Number(cashOrder.remaining_balance);
    if (submittedNum > remaining + 0.005) {
      return new Response(JSON.stringify({
        error: `submitted_amount (${submittedNum}) exceeds remaining_balance (${remaining})`,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6. Insert into payment_submissions
    const insertRow: Record<string, unknown> = {
      account_id: null,
      cash_order_id,
      customer_id: cashOrder.customer_id,
      submitted_amount: submittedNum,
      payment_method,
      reference_number: reference_number || null,
      payment_date,
      sender_name,
      proof_url: proof_url || null,
      notes: notes || null,
      status: "submitted",
      submission_type: "cash_payment",
    };
    if (portal_token) insertRow.portal_token = portal_token;

    const { data: submission, error: insertErr } = await supabase
      .from("payment_submissions")
      .insert(insertRow)
      .select()
      .single();
    if (insertErr || !submission) {
      console.error("submit-cash-payment insert error:", insertErr);
      return new Response(JSON.stringify({ error: insertErr?.message || "Failed to create submission" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 7. Audit log
    const auditRow: Record<string, unknown> = {
      entity_type: "cash_payment_submission",
      entity_id: submission.id,
      action: "submission_created",
      new_value_json: {
        cash_order_id,
        invoice_number: cashOrder.invoice_number,
        amount: submittedNum,
        method: payment_method,
        reference: reference_number,
        sender_name,
        path: pathACustomerId ? "portal" : "staff",
      },
    };
    if (pathBUserId) auditRow.performed_by_user_id = pathBUserId;
    await supabase.from("audit_logs").insert(auditRow);

    // 8. Fire-and-forget cash-payment-submitted email
    try {
      const { data: customer } = await supabase
        .from("customers")
        .select("full_name, email")
        .eq("id", cashOrder.customer_id)
        .single();
      const customerEmail = customer?.email;
      if (customerEmail) {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            templateName: "cash-payment-submitted",
            recipientEmail: customerEmail,
            idempotencyKey: `cash-payment-submitted-${submission.id}`,
            templateData: {
              customerName: customer?.full_name || "Valued Customer",
              invoiceNumber: cashOrder.invoice_number,
              amountPaid: Number(submittedNum).toLocaleString("en-US"),
              paymentDate: payment_date,
              paymentMethod: payment_method,
              referenceNumber: reference_number || undefined,
              currency: cashOrder.currency,
              portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${cashOrder.invoice_number}`,
            },
          }),
        });
      }
    } catch (emailErr) {
      console.warn("[submit-cash-payment] email send failed (non-blocking):", emailErr);
    }

    // 9. Return created submission
    return new Response(JSON.stringify({ submission }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("submit-cash-payment error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
