import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import { checkPermission } from "../_shared/check-permission.ts";

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
      session_id,
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
    // Proof of payment is REQUIRED for all customer-portal cash submissions.
    // Staff record-payment uses its own insert-then-attach-proof flow and is
    // unaffected. See CLAUDE.md PAYMENT SUBMISSION FLOW for the gate rule.
    if (typeof proof_url !== "string" || proof_url.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Proof of payment is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Auth — Path A (portal_token in body) or Path B (Bearer token)
    // Dispatch — staff/customer JWT disambiguation (2026-05-10)
    //   1. portal_token OR session_id in body → Path A directly
    //   2. Authorization header only:
    //        a. validate Bearer JWT, get user
    //        b. checkPermission('submit_cash_payment_staff') — matrix-driven dispatch (Bug #205)
    //        c. user has any staff role → Path B (preserves staff
    //           role-gated submission)
    //        d. user has no staff role → Path A (Phase B customer
    //           Bearer JWT — resolvePortalAuth Path 0 handles them)
    //   3. Else (no portal_token, no session_id, no Authorization) → 401
    let pathACustomerId: string | null = null;
    let pathBUserId: string | null = null;

    const headerAuth = req.headers.get('Authorization');

    // Pre-resolved Path B identity + role flags. Populated when
    // Authorization header is present and JWT validates so the
    // dispatch can decide between Path A (no staff role → customer
    // JWT) and Path B (staff role) without duplicating the lookup.
    let preResolvedUser: { id: string } | null = null;
    let preResolvedIsStaffRole = false;

    if (!portal_token && !session_id && headerAuth) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(
        headerAuth.replace("Bearer ", "")
      );
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Permission gate dispatch (Bug #205 Batch F: matrix-driven path discrimination)
      // Determines whether this Bearer JWT routes to Path B (staff direct entry) or Path A (customer flow).
      // NOT an access gate — both paths submit cash payments; this only chooses which business logic runs.
      preResolvedUser = { id: user.id };
      preResolvedIsStaffRole = await checkPermission(supabase, user.id, "submit_cash_payment_staff");
    }

    if (portal_token || session_id || (headerAuth && !preResolvedIsStaffRole)) {
      // Path A: customer portal (token, session_id, or Phase B customer Bearer JWT)
      try {
        const auth = await resolvePortalAuth(supabase, {
          portal_token,
          session_id,
          authHeader: headerAuth,
        });
        pathACustomerId = auth.customer_id;
      } catch (err: any) {
        return new Response(
          JSON.stringify({ error: err?.message || "Invalid portal token" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    } else if (preResolvedIsStaffRole && preResolvedUser) {
      // Path B: staff bearer token (user + role already validated above)
      pathBUserId = preResolvedUser.id;
    } else {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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

    // 4a. Block exact-duplicate pending submission for this cash order.
    // Different amounts / different methods are allowed — legitimate sequential
    // partial payments. Only block when a row with the SAME amount AND SAME
    // method is already pending review.
    const { data: existingSubmission } = await supabase
      .from('payment_submissions')
      .select('id, status')
      .eq('cash_order_id', cash_order_id)
      .eq('submitted_amount', submittedNum)
      .eq('payment_method', payment_method)
      .in('status', ['submitted', 'under_review'])
      .maybeSingle();

    if (existingSubmission) {
      return new Response(
        JSON.stringify({ error: 'A payment submission with the same amount and method is already pending review for this order. Please wait for it to be reviewed or cancel it first.' }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4b. Rate limit — max 3 non-rejected submissions per cash order in 24 hours
    const { count: recentCount } = await supabase
      .from('payment_submissions')
      .select('*', { count: 'exact', head: true })
      .eq('cash_order_id', cash_order_id)
      .not('status', 'in', '("rejected","cancelled")')
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
        const _emRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
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
        if (!_emRes.ok) {
          const _t = await _emRes.text().catch(() => "<no body>");
          console.error(`[submit-cash-payment] send-transactional-email failed (${_emRes.status}): ${_t}`);
        }
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
