import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";

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

    const { token, pin, session_id } = await req.json();
    if ((!token && !session_id) || !pin) {
      return new Response(
        JSON.stringify({ error: "token (or session_id) and pin are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 1. Resolve customer via portal token or session_id
    let customerId: string;
    try {
      const auth = await resolvePortalAuth(supabase, { token, session_id });
      customerId = auth.customer_id;
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Invalid portal token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Fetch customer PIN fields
    const { data: customer } = await supabase
      .from("customers")
      .select("id, portal_pin_hash, portal_pin_attempts, portal_pin_locked_until, mobile_number")
      .eq("id", customerId)
      .maybeSingle();

    if (!customer) {
      return new Response(
        JSON.stringify({ error: "Customer not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Auto-set default PIN from last 4 digits of mobile_number
    if (!customer.portal_pin_hash) {
      const digits = (customer.mobile_number || '').replace(/\D/g, '');
      const defaultPin = digits.length >= 4 ? digits.slice(-4) : '0000';

      // Use Web Crypto API (available in Deno) to hash the PIN
      const encoder = new TextEncoder();
      const data = encoder.encode(defaultPin);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const defaultHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      await supabase
        .from('customers')
        .update({
          portal_pin_hash: defaultHash,
          portal_pin_attempts: 0,
          portal_pin_locked_until: null
        })
        .eq('id', customer.id);
      customer.portal_pin_hash = defaultHash;
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

    // 5. Verify PIN (SHA-256 compare)
    const encoder = new TextEncoder();
    const pinData = encoder.encode(String(pin));
    const pinHashBuffer = await crypto.subtle.digest('SHA-256', pinData);
    const pinHashArray = Array.from(new Uint8Array(pinHashBuffer));
    const pinHash = pinHashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const isMatch = pinHash === customer.portal_pin_hash;

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
