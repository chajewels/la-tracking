import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePortalAuth, type PortalAuthResult } from "../_shared/portal-auth.ts";

// A correct PIN opens a PORTAL SESSION for this long (owner 2026-10-03: "until
// the tab closes, max 12 hours" — the browser keeps the id in sessionStorage).
const PIN_SESSION_HOURS = 12;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function hashPinPbkdf2(pin: string, saltBytes?: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(String(pin)), { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const salt = saltBytes ?? crypto.getRandomValues(new Uint8Array(16));
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256,
  );
  const saltHex = Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(derivedBits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPinPbkdf2(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;
  const salt = new Uint8Array(parts[1].match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(String(pin)), { name: "PBKDF2" }, false, ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, 256,
  );
  const hashHex = Array.from(new Uint8Array(derivedBits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex === parts[2];
}

async function verifySha256(pin: string, storedHash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(String(pin)));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === storedHash;
}

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
    let auth: PortalAuthResult;
    try {
      // The ONE caller allowed to resolve a bare link token: this function IS
      // the PIN check (portal-auth.ts allowBareToken).
      auth = await resolvePortalAuth(supabase, {
        token,
        session_id,
        authHeader: req.headers.get("Authorization"),
        allowBareToken: true,
      });
      customerId = auth.customer_id;
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: err?.message || "Invalid portal token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Fetch customer — mobile_number only; PIN fields now live in customer_pins
    const { data: customer } = await supabase
      .from("customers")
      .select("id, mobile_number")
      .eq("id", customerId)
      .maybeSingle();

    if (!customer) {
      return new Response(
        JSON.stringify({ error: "Customer not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Fetch PIN record
    let { data: pins } = await supabase
      .from("customer_pins")
      .select("pin_hash, pin_attempts, pin_locked_until")
      .eq("customer_id", customerId)
      .maybeSingle();

    // 4. Auto-set default PIN from last 4 digits of mobile_number if no record exists
    if (!pins || !pins.pin_hash) {
      const digits = (customer.mobile_number || "").replace(/\D/g, "");
      const defaultPin = digits.length >= 4 ? digits.slice(-4) : "0000";
      const defaultHash = await hashPinPbkdf2(defaultPin);

      await supabase.from("customer_pins").upsert({
        customer_id: customer.id,
        pin_hash: defaultHash,
        pin_attempts: 0,
        pin_locked_until: null,
      });

      pins = { pin_hash: defaultHash, pin_attempts: 0, pin_locked_until: null };
    }

    // 5. Lockout check
    if (pins.pin_locked_until && new Date(pins.pin_locked_until) > new Date()) {
      const unlockTime = new Date(pins.pin_locked_until).toLocaleTimeString();
      return new Response(
        JSON.stringify({
          error: `Account locked. Try again after ${unlockTime}.`,
          locked_until: pins.pin_locked_until,
        }),
        { status: 423, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 6. Verify PIN — lazy migration from SHA-256 → PBKDF2 on successful login
    const isLegacyFormat = !pins.pin_hash.startsWith("pbkdf2:");
    let isMatch: boolean;

    if (isLegacyFormat) {
      isMatch = await verifySha256(pin, pins.pin_hash);
      if (isMatch) {
        const newHash = await hashPinPbkdf2(pin);
        await supabase
          .from("customer_pins")
          .update({ pin_hash: newHash })
          .eq("customer_id", customer.id);
      }
    } else {
      isMatch = await verifyPinPbkdf2(pin, pins.pin_hash);
    }

    if (!isMatch) {
      const nextAttempts = (pins.pin_attempts ?? 0) + 1;
      const updatePayload: Record<string, any> = { pin_attempts: nextAttempts };
      if (nextAttempts >= 3) {
        updatePayload.pin_locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      }
      await supabase.from("customer_pins").update(updatePayload).eq("customer_id", customer.id);

      const attemptsRemaining = Math.max(0, 3 - nextAttempts);
      const message = attemptsRemaining === 0
        ? "Too many incorrect attempts. Account locked for 30 minutes."
        : `Incorrect PIN. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`;

      return new Response(
        JSON.stringify({ error: message, attempts_remaining: attemptsRemaining }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 7. PIN correct — reset counters
    await supabase
      .from("customer_pins")
      .update({ pin_attempts: 0, pin_locked_until: null })
      .eq("customer_id", customer.id);

    // 8. Open a portal session. Every other portal call refuses a bare link
    // token (pin_required) and accepts only this session_id. A call that
    // already came in on a session keeps it; a JWT sign-in needs none.
    let portalSessionId: string | null = auth.via === "session" ? (auth.session_id ?? null) : null;
    let portalSessionExpiresAt: string | null = null;
    if (auth.via === "token" && auth.source_token_id) {
      portalSessionExpiresAt = new Date(Date.now() + PIN_SESSION_HOURS * 60 * 60 * 1000).toISOString();
      const { data: created, error: sessErr } = await supabase
        .from("customer_portal_sessions")
        .insert({
          customer_id: customer.id,
          source_token_id: auth.source_token_id,
          expires_at: portalSessionExpiresAt,
          user_agent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
        })
        .select("session_id")
        .single();
      if (sessErr || !created) {
        console.error("[verify-portal-pin] session insert failed:", sessErr?.message ?? sessErr);
        return new Response(
          JSON.stringify({ error: "Could not open your account. Please try again." }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      portalSessionId = created.session_id;
    }

    return new Response(
      JSON.stringify({
        success: true,
        customer_id: customer.id,
        session_id: portalSessionId,
        expires_at: portalSessionExpiresAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
