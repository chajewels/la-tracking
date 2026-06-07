import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------------------------------------------------------------------------
// Hashing helpers — PBKDF2 via Deno's built-in crypto.subtle (no external deps)
// Stored format: "pbkdf2:<32-char-salt-hex>:<64-char-hash-hex>"
// Legacy format: 64-char SHA-256 hex (no prefix) — migrated on next successful login
// ---------------------------------------------------------------------------

async function hashPinPbkdf2(pin: string, saltBytes?: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(pin)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const salt = saltBytes ?? crypto.getRandomValues(new Uint8Array(16));
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPinPbkdf2(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;
  const salt = new Uint8Array(
    parts[1].match(/.{2}/g)!.map((b) => parseInt(b, 16)),
  );
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(pin)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex === parts[2];
}

// Legacy SHA-256 verifier (for migration only — never used to create new hashes)
async function verifySha256(pin: string, storedHash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(String(pin)));
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === storedHash;
}

// ---------------------------------------------------------------------------

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

    // 1. Resolve customer
    let customerId: string;
    try {
      const auth = await resolvePortalAuth(supabase, {
        token,
        session_id,
        authHeader: req.headers.get("Authorization"),
      });
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

    // 3. Auto-set default PIN from last 4 digits of mobile_number — PBKDF2 from the start
    if (!customer.portal_pin_hash) {
      const digits = (customer.mobile_number || "").replace(/\D/g, "");
      const defaultPin = digits.length >= 4 ? digits.slice(-4) : "0000";
      const defaultHash = await hashPinPbkdf2(defaultPin);

      await supabase
        .from("customers")
        .update({ portal_pin_hash: defaultHash, portal_pin_attempts: 0, portal_pin_locked_until: null })
        .eq("id", customer.id);
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

    // 5. Verify PIN — with lazy migration from SHA-256 → PBKDF2
    const isLegacyFormat = !customer.portal_pin_hash.startsWith("pbkdf2:");
    let isMatch: boolean;

    if (isLegacyFormat) {
      // Legacy SHA-256 path — verify once, then silently re-hash if correct
      isMatch = await verifySha256(pin, customer.portal_pin_hash);
      if (isMatch) {
        // Migrate to PBKDF2 immediately on successful login
        const newHash = await hashPinPbkdf2(pin);
        await supabase
          .from("customers")
          .update({ portal_pin_hash: newHash })
          .eq("id", customer.id);
        customer.portal_pin_hash = newHash;
      }
    } else {
      isMatch = await verifyPinPbkdf2(pin, customer.portal_pin_hash);
    }

    if (!isMatch) {
      const nextAttempts = (customer.portal_pin_attempts ?? 0) + 1;
      const updatePayload: Record<string, any> = { portal_pin_attempts: nextAttempts };
      if (nextAttempts >= 3) {
        updatePayload.portal_pin_locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
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
