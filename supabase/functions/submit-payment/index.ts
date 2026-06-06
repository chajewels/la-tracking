import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";

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
      session_id,
      account_id,        // for single payments (backward compat)
      submitted_amount,
      payment_date,
      payment_method,
      reference_number,
      sender_name,
      notes,
      proof_url,
      installment_number,
      submission_type,    // 'single' | 'split'
      allocations,        // Array<{ account_id, invoice_number, allocated_amount }>
      force,              // optional: bypass duplicate-submission guard
    } = body;


    // Validate required fields (auth handled below via resolvePortalAuth)
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
    // Proof of payment is REQUIRED for all customer-portal submissions.
    // Staff record-payment uses its own insert-then-attach-proof flow and is
    // unaffected. See CLAUDE.md PAYMENT SUBMISSION FLOW for the gate rule.
    if (typeof proof_url !== "string" || proof_url.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Proof of payment is required" }), {
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

    // Validate portal token, session_id, or Bearer JWT
    let customerId: string;
    try {
      const auth = await resolvePortalAuth(supabase, {
        portal_token,
        session_id,
        authHeader: req.headers.get('Authorization'),
      });
      customerId = auth.customer_id;
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Access denied" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

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

    // Rate limit: max 3 submissions per account per 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const aid of accountIds) {
      const { count: recentCount } = await supabase
        .from("payment_submissions")
        .select("*", { count: "exact", head: true })
        .eq("account_id", aid)
        .neq("status", "rejected")
        .gte("created_at", twentyFourHoursAgo);

      if ((recentCount ?? 0) >= 3) {
        return new Response(
          JSON.stringify({
            error: "Too many submissions. Maximum 3 payment submissions per account per 24 hours. Please wait before submitting again.",
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── Duplicate-submission soft block (bypass with force=true) ──
    if (!force) {
      try {
        const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        for (const aid of accountIds) {
          const { data: dupRows } = await supabase
            .from("payment_submissions")
            .select("id, created_at, sender_name, reference_number, submitted_amount")
            .eq("account_id", aid)
            .in("status", ["submitted", "under_review"])
            .gte("created_at", thirtyMinAgo)
            .order("created_at", { ascending: false })
            .limit(5);
          const dup = (dupRows || []).find(
            (r: any) => Math.abs(Number(r.submitted_amount) - Number(submitted_amount)) < 1,
          );
          if (dup) {
            const minutesAgo = Math.max(
              1,
              Math.round((Date.now() - new Date(dup.created_at).getTime()) / 60000),
            );
            return new Response(
              JSON.stringify({
                error: "duplicate_submission_detected",
                message: `A ₱${Number(submitted_amount).toLocaleString()} submission for this account is already pending review (submitted ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago by ${dup.sender_name ?? "unknown"}). If this is a different payment, add a distinguishing reference number or note, then retry with force=true.`,
                existing_submission_id: dup.id,
                existing_submitted_at: dup.created_at,
                existing_sender_name: dup.sender_name,
                existing_reference_number: dup.reference_number,
              }),
              { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
        }
      } catch (dupErr) {
        console.warn("[submit-payment] duplicate-check query failed (non-blocking):", dupErr);
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
        installment_number: installment_number || null,
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

    // Send payment-submitted email to customer (fire-and-forget)
    try {
      const { data: acctForEmail } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, currency, customers(full_name, email)")
        .eq("id", primaryAccountId)
        .single();
      const customerEmail = (acctForEmail as any)?.customers?.email;
      if (customerEmail) {
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            templateName: "payment-submitted",
            recipientEmail: customerEmail,
            idempotencyKey: `payment-submitted-${submission.id}`,
            templateData: {
              customerName: (acctForEmail as any)?.customers?.full_name || "Valued Customer",
              invoiceNumber: acctForEmail?.invoice_number || "",
              amountPaid: Number(submitted_amount).toLocaleString("en-US"),
              paymentDate: payment_date,
              paymentMethod: payment_method || "cash",
              currency: acctForEmail?.currency || "PHP",
              portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${acctForEmail?.invoice_number || ""}`,
            },
          }),
        });
      }
    } catch (emailErr) {
      console.warn("[submit-payment] email send failed (non-blocking):", emailErr);
    }

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
