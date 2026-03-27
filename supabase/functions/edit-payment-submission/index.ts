import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    submission_id,
    action = "edit", // 'edit' | 'cancel'
    submitted_amount,
    payment_method,
    proof_url,
    reference_number,
    sender_name,
    notes,
  } = body;

  if (!portal_token || !submission_id) {
    return new Response(JSON.stringify({ error: "Missing required fields: portal_token, submission_id" }), {
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

  // Fetch submission — verify ownership
  const { data: submission, error: subErr } = await supabase
    .from("payment_submissions")
    .select("id, customer_id, status")
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

  const now = new Date().toISOString();

  // ── CANCEL ──
  if (action === "cancel") {
    const { error: updateErr } = await supabase
      .from("payment_submissions")
      .update({ status: "cancelled", updated_at: now })
      .eq("id", submission_id);

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

  const updates: Record<string, any> = {
    customer_edited_at: now,
    updated_at: now,
  };

  if (submitted_amount !== undefined) updates.submitted_amount = Number(submitted_amount);
  if (payment_method !== undefined) updates.payment_method = payment_method;
  if (proof_url !== undefined) updates.proof_url = proof_url;
  if (reference_number !== undefined) updates.reference_number = reference_number || null;
  if (sender_name !== undefined) updates.sender_name = sender_name || null;
  if (notes !== undefined) updates.notes = notes || null;

  const { data: updated, error: updateErr } = await supabase
    .from("payment_submissions")
    .update(updates)
    .eq("id", submission_id)
    .select()
    .single();

  if (updateErr) {
    return new Response(JSON.stringify({ error: updateErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
