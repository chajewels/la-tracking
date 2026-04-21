import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as bcrypt from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { token, pin } = await req.json();
    if (!token || !pin) {
      return new Response(
        JSON.stringify({ error: "token and pin are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 1. Resolve customer via customer_portal_tokens (the canonical portal token store)
    const { data: tokenRow } = await supabase
      .from("customer_portal_tokens")
      .select("customer_id, is_active, expires_at")
      .eq("token", token)
      .eq("is_active", true)
      .maybeSingle();

    if (!tokenRow) {
      return new Response(
        JSON.stringify({ error: "Invalid portal token" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: "Portal link has expired" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Fetch customer PIN fields
    const { data: customer } = await supabase
      .from("customers")
      .select("id, portal_pin_hash, portal_pin_attempts, portal_pin_locked_until")
      .eq("id", tokenRow.customer_id)
      .maybeSingle();

    if (!customer) {
      return new Response(
        JSON.stringify({ error: "Customer not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. PIN not configured
    if (!customer.portal_pin_hash) {
      return new Response(
        JSON.stringify({ error: "PIN not set. Please contact your staff." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 4. Lockout check
    if (customer.portal_pin_locked_until && new Date(customer.portal_pin_locked_until) > new Date()) {
      const unlockTime = new Date(customer.portal_pin_locked_until).toLocaleTimeString();
      return new Response(
        JSON.stringify({
          error: `Account locked. Try again after ${unlockTime}.`,
          locked_until: customer.portal_pin_locked_until,
        }),
        { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 5. Verify PIN
    const isMatch = await bcrypt.compare(String(pin), customer.portal_pin_hash);

    if (!isMatch) {
      const nextAttempts = (customer.portal_pin_attempts ?? 0) + 1;
      const updatePayload: Record<string, any> = { portal_pin_attempts: nextAttempts };
      if (nextAttempts >= 3) {
        const lockUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        updatePayload.portal_pin_locked_until = lockUntil;
      }
      await supabase.from("customers").update(updatePayload).eq("id", customer.id);

      const attemptsRemaining = Math.max(0, 3 - nextAttempts);
      const message = attemptsRemaining === 0
        ? "Too many incorrect attempts. Account locked for 30 minutes."
        : `Incorrect PIN. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`;

      return new Response(
        JSON.stringify({ error: message, attempts_remaining: attemptsRemaining }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 6. PIN correct — reset counters
    await supabase
      .from("customers")
      .update({ portal_pin_attempts: 0, portal_pin_locked_until: null })
      .eq("id", customer.id);

    return new Response(
      JSON.stringify({ success: true, customer_id: customer.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
