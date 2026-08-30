import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hashPinPbkdf2(pin: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(String(pin)), { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256,
  );
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(derivedBits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Auth: admin or staff JWT required
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    // Permission gate (Bug #205 Batch F: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "set_customer_pin");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "set_customer_pin permission required" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Validate input
    const { customer_id, pin } = await req.json();
    if (!customer_id || !pin) {
      return new Response(JSON.stringify({ error: "customer_id and pin are required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!/^\d{4}$/.test(String(pin))) {
      return new Response(JSON.stringify({ error: "PIN must be exactly 4 digits" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 3. Hash PIN with PBKDF2 (SHA-256 removed — portal_pin_hash column no longer exists on customers)
    const hash = await hashPinPbkdf2(String(pin));

    // 4. Upsert into customer_pins
    const { error: upsertError } = await supabase
      .from("customer_pins")
      .upsert({ customer_id, pin_hash: hash, pin_attempts: 0, pin_locked_until: null });

    if (upsertError) {
      return new Response(JSON.stringify({ error: upsertError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Audit log (best-effort)
    try {
      await supabase.from("audit_logs").insert({
        entity_type: "customer",
        entity_id: customer_id,
        action: "portal_pin_set",
        performed_by_user_id: user.id,
      });
    } catch { /* ignored */ }

    return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message || "Internal error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
