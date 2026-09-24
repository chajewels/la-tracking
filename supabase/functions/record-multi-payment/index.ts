import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateAllocations } from "../_shared/payment-validation.ts";
import { firstUnconfirmedReservation, staffNotReadyForPaymentBody } from "../_shared/web-reservation-rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user via service role client
    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getUser(token);
    if (claimsError || !claimsData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.user.id;

    // Staff-only gate — prevents Phase B customers from injecting payment submissions for arbitrary accounts
    const { data: userIsStaff } = await supabase.rpc("is_staff", { _user_id: userId });
    if (!userIsStaff) {
      return new Response(JSON.stringify({ error: "Staff access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Universal submission-only path (Bug #219): every non-preview call,
    //    regardless of role, creates pending payment_submissions rows.
    //    Direct writes to the payments table happen ONLY via
    //    review-payment-submission.
    const body = await req.json();
    const {
      customer_id,
      total_amount_paid,
      date_paid,
      payment_method,
      remarks,
      preview_only,
      allocations: inputAllocations,
      proof_url,
    } = body as {
      customer_id: string;
      /** REQUIRED (F04). Enforced by validateAllocations, which rejects a
       *  missing, non-finite or non-positive value outright — the previous
       *  `if (total_amount_paid && …)` made the cross-check optional. */
      total_amount_paid: number;
      date_paid?: string;
      payment_method?: string;
      remarks?: string;
      preview_only?: boolean;
      allocations: Array<{ account_id: string; amount: number; is_downpayment?: boolean; carry_over?: boolean }>;
      proof_url?: string;
    };

    // Validate input
    if (!customer_id || !inputAllocations || !Array.isArray(inputAllocations) || inputAllocations.length === 0) {
      return new Response(JSON.stringify({ error: "Missing customer_id or allocations" }), {
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

    const totalAllocated = inputAllocations.reduce((s, a) => s + Number(a.amount), 0);

    // The former guards here — `totalAllocated <= 0` and the OPTIONAL
    // `if (total_amount_paid && Math.abs(diff) > 1)` — are gone. They are
    // replaced by validateAllocations below, which runs after the account
    // fetch because it needs the resolved currency. See F04 / #291:
    //   - the ±1 window let a batch be a whole peso or yen out;
    //   - the `total_amount_paid &&` prefix made the cross-check optional, so
    //     omitting the field skipped it entirely;
    //   - a per-leg sign check is the only thing that catches a +100/-50 pair,
    //     which nets to a "matching" total.

    // Fetch all target accounts
    const accountIds = inputAllocations.map((a) => a.account_id);
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .in("id", accountIds)
      .eq("customer_id", customer_id);

    if (accErr || !accounts || accounts.length !== accountIds.length) {
      return new Response(
        JSON.stringify({ error: "One or more accounts not found or don't belong to this customer" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // RESERVE-FIRST: one unconfirmed web plan in the batch refuses the whole
    // batch, before any write — a split payment is all or nothing.
    const reservation = firstUnconfirmedReservation(accounts);
    if (reservation) {
      return new Response(JSON.stringify(staffNotReadyForPaymentBody(reservation)), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── F04: validate the whole batch BEFORE any write ──
    // Runs here, not earlier, because the currency comes from the fetched
    // accounts. Everything above this point is a read. Any failure is a 400
    // carrying the validator's specific message — the caller is told which
    // leg is wrong and why, not just "invalid".
    try {
      validateAllocations(
        inputAllocations.map((a) => {
          const acct = accounts.find((x) => x.id === a.account_id);
          return {
            account_id: a.account_id,
            amount: a.amount as unknown as number,
            currency: acct?.currency ?? null,
          };
        }),
        total_amount_paid,
        accounts[0]?.currency ?? "",
      );
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e?.message ?? "Invalid allocations" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate each account is active/overdue and amount <= remaining_balance
    for (const alloc of inputAllocations) {
      const acct = accounts.find((a) => a.id === alloc.account_id);
      if (!acct) continue;
      if (acct.status !== "active" && acct.status !== "overdue") {
        return new Response(
          JSON.stringify({ error: `Account ${acct.invoice_number} is not active` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (Number(alloc.amount) > Number(acct.remaining_balance) + 1) {
        return new Response(
          JSON.stringify({
            error: `Amount for ${acct.invoice_number} exceeds remaining balance`,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Process each account's allocation using the same logic as record-payment
    const results: Array<{
      account_id: string;
      invoice_number: string;
      amount_allocated: number;
      payment_allocations: any[];
      new_total_paid: number;
      new_remaining_balance: number;
      new_status: string;
    }> = [];

    const effectiveDate = date_paid || new Date().toISOString().split("T")[0];
    const effectiveMethod = payment_method || "cash";
    const batchId = crypto.randomUUID();

    // TODO (deferred — needs an RPC, tracked as its own step): this loop is
    // NOT atomic and NOT idempotent.
    //   PARTIAL BATCH: each leg inserts its own payment_submissions row inside
    //   the loop. A failure on leg 3 of 5 leaves legs 1-2 submitted and 3-5
    //   not, with no rollback and no marker on the batch_id, so the reviewer
    //   sees a batch that is short by two legs and nothing says why.
    //   RETRY: batch_id is a fresh crypto.randomUUID() per call, so a client
    //   retry after a timeout creates a SECOND full set of submissions for the
    //   same money. Nothing dedupes them — the per-account advisory-lock guard
    //   that record-payment gets from insert_payment_submission_guarded has no
    //   equivalent here.
    // Both need one transactional RPC that takes the whole batch plus a
    // caller-supplied idempotency key. Deliberately NOT attempted in this step
    // (F04 / #291 is validation only).
    for (const inputAlloc of inputAllocations) {
      // The former `if (Number(inputAlloc.amount) <= 0) continue;` is GONE.
      // validateAllocations has already rejected every non-positive and
      // non-finite amount, so nothing reaching here can be skipped — and
      // silently dropping a leg is exactly what produced the wrong total.
      const acct = accounts.find((a) => a.id === inputAlloc.account_id)!;
      const amountForAccount = Number(inputAlloc.amount);
      const carryOver = !!inputAlloc.carry_over;
      console.log(`[multi-pay] Processing account ${acct.invoice_number}: amount=${amountForAccount}`);

      // Fetch schedule
      const { data: schedule } = await supabase
        .from("layaway_schedule")
        .select("*")
        .eq("account_id", inputAlloc.account_id)
        .order("installment_number", { ascending: true });

      const { data, error } = await supabase.rpc('allocate_payment_atomic', {
        p_account_id: inputAlloc.account_id,
        p_amount_paid: amountForAccount,
        p_payment_date: effectiveDate,
        p_payment_method: effectiveMethod,
        p_reference_number: batchId,
        p_remarks: remarks ?? null,
        p_user_id: userId,
        p_currency: acct.currency,
        p_is_downpayment: !!inputAlloc.is_downpayment,
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

      // INVARIANT-1-exact preview totals from allocate_payment_atomic (p_preview:true),
      // replacing the prior cached-total approximation.
      const newTotalPaid = data.new_total_paid;
      const newRemainingBalance = Math.max(0, data.new_remaining_balance);

      // Recalculate correct status based on updated schedule state
      let newStatus: string;
      if (newRemainingBalance <= 0) {
        newStatus = "completed";
      } else if (["active", "overdue"].includes(acct.status)) {
        const todayStr = new Date().toISOString().split("T")[0];
        // Check if there will still be overdue items after applying the RPC's schedule updates
        const paidIds = new Set((data.schedule_updates || []).filter((u: any) => u.status === "paid").map((u: any) => u.id));
        const stillOverdue = (schedule || []).some((s: any) =>
          s.status !== "paid" && s.status !== "cancelled" && !paidIds.has(s.id) && s.due_date < todayStr
        );
        newStatus = stillOverdue ? "overdue" : "active";
      } else {
        newStatus = acct.status;
      }

      results.push({
        account_id: inputAlloc.account_id,
        invoice_number: acct.invoice_number,
        amount_allocated: amountForAccount,
        payment_allocations: data.allocations,
        new_total_paid: newTotalPaid,
        new_remaining_balance: Math.max(0, newRemainingBalance),
        new_status: newStatus,
      });

      // If not preview, create a pending payment_submissions row for every
      // role (Bug #219). Direct writes to the payments table happen ONLY via
      // review-payment-submission. The prior canConfirm direct-write branch
      // was removed (Bug #218).
      if (!preview_only) {
        const { data: submission, error: subErr } = await supabase
          .from("payment_submissions")
          .insert({
            account_id: inputAlloc.account_id,
            customer_id: customer_id,
            submitted_amount: amountForAccount,
            payment_date: effectiveDate,
            payment_method: effectiveMethod,
            reference_number: batchId,
            notes: remarks ? `[Multi-invoice] ${remarks}` : `[Multi-invoice batch: ${batchId}]`,
            status: "submitted",
            submission_type: inputAlloc.is_downpayment ? 'downpayment' : 'installment',
            sender_name: (claimsData.user.user_metadata as any)?.full_name || claimsData.user.email || null,
            proof_url: proof_url!.trim(),
          })
          .select("id")
          .single();
        if (subErr) throw subErr;

        // Audit write is best-effort, but NEVER silently ignored: the
        // submission already exists, so failing the request here would leave
        // the caller thinking nothing was booked. Log loudly instead.
        const { error: auditErr } = await supabase.from("audit_logs").insert({
          entity_type: "payment_submission",
          entity_id: submission.id,
          action: "staff_multi_payment_submitted",
          new_value_json: {
            batch_id: batchId,
            amount: amountForAccount,
            account_id: inputAlloc.account_id,
          },
          performed_by_user_id: userId,
        });
        if (auditErr) {
          console.error(
            `[multi-pay] audit_logs insert FAILED for submission ${submission.id} ` +
              `(batch ${batchId}, account ${inputAlloc.account_id}): ${auditErr.message}`,
          );
        }
      }
    }

    // Non-preview: every account in the batch was submitted for confirmation.
    if (!preview_only) {
      return new Response(
        JSON.stringify({
          submitted_for_confirmation: true,
          batch_id: batchId,
          total_amount: totalAllocated,
          message: "Payments submitted for confirmation. Admin/Finance will review.",
        }),
        {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        preview: true,
        batch_id: batchId,
        total_amount: totalAllocated,
        account_results: results,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
