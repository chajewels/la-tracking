import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

    // Staff-only gate — prevents Phase B customers from injecting payment submissions for arbitrary accounts
    const { data: userIsStaff } = await supabase.rpc("is_staff", { _user_id: user.id });
    if (!userIsStaff) {
      return new Response(JSON.stringify({ error: "Staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { account_id, amount_paid, date_paid, payment_method, reference_number, remarks, preview_only, is_downpayment, carry_over = false, submission_type, force, proof_url } = body;

    if (!account_id || !amount_paid || amount_paid <= 0) {
      return new Response(JSON.stringify({ error: "Invalid payment data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PROOF REQUIRED (2026-06-30): every non-preview submit must carry a
    // non-empty proof_url. Preview writes nothing, so it is exempt.
    if (!preview_only && (typeof proof_url !== "string" || proof_url.trim().length === 0)) {
      return new Response(JSON.stringify({ error: "Proof of payment is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Rate limit per account per 24h ──
    //    downpayment on trade account (is_trade=true): max 10
    //    downpayment on non-trade account:             max 5
    //    installment / other:                          max 3
    const isDpSubmission =
      submission_type === "downpayment" || is_downpayment === true;
    const isTradeAccount = account?.is_trade === true;

    let rlCap: number;
    if (isDpSubmission && isTradeAccount) {
      rlCap = 10;
    } else if (isDpSubmission) {
      rlCap = 5;
    } else {
      rlCap = 3;
    }

    let rlQuery = supabase
      .from("payment_submissions")
      .select("*", { count: "exact", head: true })
      .eq("account_id", account_id)
      .neq("status", "rejected")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (isDpSubmission) {
      rlQuery = rlQuery.eq("submission_type", "downpayment");
    }

    const { count: recentCount } = await rlQuery;

    if ((recentCount ?? 0) >= rlCap) {
      return new Response(
        JSON.stringify({
          error: `Too many submissions. Maximum ${rlCap} ${isDpSubmission ? "downpayment " : ""}payment submissions per account per 24 hours. Please wait before submitting again.`,
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Account must be in a payable state ──
    const payableStatuses = ["active", "overdue", "extension_active", "reactivated", "final_settlement"];
    if (!payableStatuses.includes(account.status)) {
      return new Response(JSON.stringify({ error: "Account is not active" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Universal submission-only path (Bug #219): every non-preview call,
    //    regardless of role, creates a pending payment_submissions row.
    //    Direct writes to the payments table happen ONLY via
    //    review-payment-submission. The previous confirm_payment-coupled
    //    direct-write branch was removed (Bug #218).
    if (!preview_only) {
      // Race-proof insert: insert_payment_submission_guarded takes a per-account
      // advisory lock, re-runs the duplicate check, and inserts atomically. The
      // prior separate-statement SELECT-then-INSERT could let two near-simultaneous
      // calls both pass the dup check (observed 411ms apart).
      const { data: guarded, error: subErr } = await supabase.rpc("insert_payment_submission_guarded", {
        p_account_id: account_id,
        p_customer_id: account.customer_id,
        p_submitted_amount: amount_paid,
        p_payment_date: date_paid || new Date().toISOString().split("T")[0],
        p_payment_method: payment_method || "cash",
        p_reference_number: reference_number || null,
        p_notes: remarks || null,
        p_submission_type: submission_type ?? "single",
        p_sender_name: (user.user_metadata as any)?.full_name || user.email || null,
        p_force: !!force,
      });

      if (subErr) {
        return new Response(JSON.stringify({ error: subErr.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (guarded?.duplicate === true) {
        const minutesAgo = Number(guarded.minutes_ago) || 1;
        const senderName = guarded.sender_name ?? "unknown";
        return new Response(
          JSON.stringify({
            error: "duplicate_submission_detected",
            message: `A ₱${Number(amount_paid).toLocaleString()} submission for this account is already pending review (submitted ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago by ${senderName}). If this is a different payment, add a distinguishing reference number or note, then retry with force=true.`,
            existing_submission_id: guarded.existing_submission_id ?? null,
            existing_submitted_at: guarded.existing_submitted_at ?? null,
            existing_sender_name: guarded.sender_name ?? null,
            existing_reference_number: guarded.existing_reference_number ?? null,
          }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Audit log
      await supabase.from("audit_logs").insert({
        entity_type: "payment_submission",
        entity_id: guarded.submission_id,
        action: "staff_payment_submitted",
        new_value_json: { amount_paid, account_id, payment_method, date_paid },
        performed_by_user_id: user.id,
      });

      // Attach proof to the submission (proof_url validated above).
      await supabase.from("payment_submissions").update({ proof_url: proof_url.trim() }).eq("id", guarded.submission_id);

      return new Response(JSON.stringify({
        submitted_for_confirmation: true,
        submission_id: guarded.submission_id,
        message: "Payment submitted for confirmation. An admin or finance user will review it.",
      }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── preview_only: compute allocation plan without writing anything ──

    const { data, error } = await supabase.rpc('allocate_payment_atomic', {
      p_account_id: account_id,
      p_amount_paid: amount_paid,
      p_payment_date: date_paid,
      p_payment_method: payment_method,
      p_reference_number: reference_number,
      p_remarks: remarks,
      p_user_id: user.id,
      p_currency: account.currency,
      p_is_downpayment: is_downpayment,
      p_submitted_by_type: "staff",
      p_submitted_by_name: null,
      p_preview: true,
    });
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Preview mode — exact allocation plan from allocate_payment_atomic (p_preview:true).
    // Values are INVARIANT-1-exact; direct writes happen only in review-payment-submission.
    return new Response(JSON.stringify({
      preview: true,
      allocations: data.allocations,
      new_total_paid: data.new_total_paid,
      new_remaining_balance: data.new_remaining_balance,
      new_status: data.new_status,
      schedule_updates: data.schedule_updates,
      penalty_updates: data.penalty_updates,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
