import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Pancake POS order webhook receiver — Phase 1 (skeleton).
// PUBLIC, security-critical endpoint. Pancake sends NO signature, so the
// shared-secret request header (x-pancake-secret) is the ONLY authentication;
// verify it BEFORE any processing. This function only CAPTURES events into
// pancake_events (status 'pending'); it does NOT write cash_orders yet (Phase 2).
// MUST run with verify_jwt = false at the gateway.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pancake-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LOG = "[pancake-order-webhook]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Constant-time comparison — accumulate all differences, never early-return.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// Extract the stable Pancake order_id from order_link, e.g.
// https://pos.pages.fm/shop/5226933/order?order_id=90085118275294
function extractOrderId(orderLink: unknown, systemId: unknown): string | null {
  if (typeof orderLink === "string" && orderLink.length > 0) {
    try {
      const oid = new URL(orderLink).searchParams.get("order_id");
      if (oid) return oid;
    } catch (_) { /* fall through */ }
  }
  if (systemId !== null && systemId !== undefined) return String(systemId);
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // AUTH — shared-secret header, verified before anything else.
  const expected = Deno.env.get("PANCAKE_WEBHOOK_SECRET");
  if (!expected) {
    console.error(`${LOG} PANCAKE_WEBHOOK_SECRET not set`);
    return json({ error: "Server misconfigured" }, 500);
  }
  const provided = req.headers.get("x-pancake-secret") ?? "";
  if (!timingSafeEqual(provided, expected)) {
    console.warn(`${LOG} rejected: bad or missing secret`);
    return json({ error: "Unauthorized" }, 401);
  }

  // Parse.
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const pancakeOrderId = extractOrderId(body["order_link"], body["system_id"]);
  const eventType = typeof body["event_type"] === "string" ? (body["event_type"] as string) : "unknown";
  const eventUpdatedAt =
    typeof body["updated_at"] === "string" && body["updated_at"]
      ? (body["updated_at"] as string)
      : new Date().toISOString();

  if (!pancakeOrderId) {
    console.error(`${LOG} no pancake_order_id`, { event_type: eventType });
    return json({ ok: true, skipped: "no_order_id" }, 200);
  }

  // Capture to ledger (service role bypasses RLS). Exact-key redeliveries are
  // ignored (DO NOTHING); a new order version (new updated_at) is a new row and
  // is never blocked by a prior errored row.
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await supabase
    .from("pancake_events")
    .upsert(
      {
        pancake_order_id: pancakeOrderId,
        system_id: typeof body["system_id"] === "number" ? body["system_id"] : null,
        event_type: eventType,
        event_updated_at: eventUpdatedAt,
        status: "pending",
        raw_payload: body,
        received_at: new Date().toISOString(),
      },
      { onConflict: "pancake_order_id,event_type,event_updated_at", ignoreDuplicates: true },
    );

  if (error) {
    console.error(`${LOG} ledger upsert failed`, error);
    return json({ error: "Ledger write failed" }, 500); // 500 → Pancake retries; key makes retries safe
  }

  console.log(`${LOG} captured`, { pancakeOrderId, eventType });
  return json({ ok: true }, 200);
});
