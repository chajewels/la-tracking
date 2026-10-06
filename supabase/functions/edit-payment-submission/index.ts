import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import { INVALID_PROOF_URL, isOwnProofUrl } from "../_shared/proof-url.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const {
    portal_token,
    session_id,
    submission_id,
    action = "edit", // 'edit' | 'cancel'
    submitted_amount,
    payment_method,
    proof_url,
    reference_number,
    sender_name,
    notes,
  } = body;

  if (!submission_id) {
    return new Response(JSON.stringify({ error: "Missing required field: submission_id" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!["edit", "cancel"].includes(action)) {
    return new Response(JSON.stringify({ error: "Invalid action. Must be 'edit' or 'cancel'" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

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

  // Fetch submission — verify ownership
  const { data: submission, error: subErr } = await supabase
    .from("payment_submissions")
    .select("id, customer_id, status, payment_method, square_payment_id, paidy_payment_id")
    .eq("id", submission_id)
    .maybeSingle();

  if (subErr || !submission) {
    return new Response(JSON.stringify({ error: "Submission not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (submission.customer_id !== customerId) {
    return new Response(JSON.stringify({ error: "Access denied" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Only 'submitted' status can be edited or cancelled
  if (submission.status !== "submitted") {
    return new Response(
      JSON.stringify({ error: "This submission is already being reviewed and can no longer be edited." }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // R01/R03 (2026-10-04): a Paidy submission is Paidy's own record — its
  // method, amount and link never change, and it is not cancelled here (the
  // customer cancels in MyPaidy; Paidy then closes it and the Hub follows).
  // The database refuses the same edits (trg_guard_payment_submission_paidy).
  if (submission.paidy_payment_id || submission.payment_method === "paidy") {
    return new Response(
      JSON.stringify({ error: "paidy_submission_locked", message: "A Paidy payment cannot be edited or cancelled here. To cancel it, cancel it in the Paidy app; Cha Jewels can also release it." }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  // SQ10 (2026-10-04): a card (Square) submission is the hold on her card. Its
  // method and amount are fixed, and it ends only by staff Confirm (capture)
  // or Reject (void) — a customer edit or cancel would leave the hold in place.
  // The database refuses it too (guard_provider_submission).
  if (submission.square_payment_id || String(submission.payment_method ?? "").toLowerCase() === "square") {
    return new Response(
      JSON.stringify({ error: "card_submission_locked", message: "A card payment cannot be edited or cancelled here. Please contact us." }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  // Nor can a customer relabel any submission as Paidy or card.
  if (action !== "cancel" && payment_method !== undefined
      && ["paidy", "square"].includes(String(payment_method).toLowerCase())) {
    const locked = String(payment_method).toLowerCase() === "square" ? "card_submission_locked" : "paidy_submission_locked";
    return new Response(JSON.stringify({ error: locked }), {
      status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const now = new Date().toISOString();

  // ── CANCEL ──
  if (action === "cancel") {
    const { data: cancelled, error: updateErr } = await supabase
      .from("payment_submissions")
      .update({ status: "cancelled", updated_at: now })
      .eq("id", submission_id)
      // R03: compare-and-set — never overwrite a Confirm that claimed it meanwhile.
      .eq("status", "submitted")
      .select("id");

    if (!updateErr && (!cancelled || cancelled.length === 0)) {
      return new Response(JSON.stringify({ error: "This submission is already being reviewed and can no longer be cancelled." }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (updateErr) {
      return new Response(JSON.stringify({ error: updateErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await supabase.from("audit_logs").insert({
      entity_type: "payment_submission",
      entity_id: submission_id,
      action: "customer_cancelled_submission",
      new_value_json: { submission_id },
    });

    return new Response(JSON.stringify({ success: true, action: "cancelled" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── EDIT ──
  if (submitted_amount !== undefined && Number(submitted_amount) <= 0) {
    return new Response(JSON.stringify({ error: "Amount must be greater than 0" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // QC P1-1 (2026-10-06): a replacement proof must be a file in our own
  // payment-proofs bucket. Proof stays required, so it is never cleared here.
  if (proof_url !== undefined && !isOwnProofUrl(proof_url)) {
    return new Response(JSON.stringify(INVALID_PROOF_URL), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const updates: Record<string, any> = {
    customer_edited_at: now,
    updated_at: now,
  };

  if (submitted_amount !== undefined) updates.submitted_amount = Number(submitted_amount);
  if (payment_method !== undefined) updates.payment_method = payment_method;
  if (proof_url !== undefined) updates.proof_url = String(proof_url).trim();
  if (reference_number !== undefined) updates.reference_number = reference_number || null;
  if (sender_name !== undefined) updates.sender_name = sender_name || null;
  if (notes !== undefined) updates.notes = notes || null;

  const { data: updated, error: updateErr } = await supabase
    .from("payment_submissions")
    .update(updates)
    .eq("id", submission_id)
    .eq("status", "submitted") // compare-and-set, like cancel
    .select()
    .maybeSingle();
  if (!updateErr && !updated) {
    return new Response(JSON.stringify({ error: "This submission is already being reviewed and can no longer be edited." }), {
      status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (updateErr) {
    return new Response(JSON.stringify({ error: updateErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // If amount was edited, sync the single allocation (if exactly one exists).
  // Multi-account allocations are not auto-redistributed — admin handles those.
  if (submitted_amount !== undefined) {
    const { data: allocs } = await supabase
      .from("payment_submission_allocations")
      .select("id")
      .eq("submission_id", submission_id);
    if (allocs && allocs.length === 1) {
      await supabase
        .from("payment_submission_allocations")
        .update({ allocated_amount: Number(submitted_amount) })
        .eq("id", allocs[0].id);
    }
  }

  await supabase.from("audit_logs").insert({
    entity_type: "payment_submission",
    entity_id: submission_id,
    action: "customer_edited_submission",
    new_value_json: { submission_id, fields_updated: Object.keys(updates).filter(k => k !== "customer_edited_at" && k !== "updated_at") },
  });

  return new Response(JSON.stringify({ success: true, submission: updated }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
