// POST /functions/v1/redeem-portal-token — RETIRED 2026-10-03.
//
// It exchanged a bare portal link token for a 180-day customer_portal_sessions
// row WITHOUT checking the PIN, so anyone holding a customer's link could mint
// a long-lived login to that customer's portal. Nothing called it (last
// session created 2026-05-06; no Hub, portal or storefront caller).
//
// The only way to a portal session is now verify-portal-pin: a correct PIN
// issues a 12-hour session (owner decision 2026-10-03). This endpoint is kept
// as a fixed refusal rather than deleted so a stale caller gets a clear
// answer instead of a 404. Never restore the old body.
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";

Deno.serve((req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  return jsonResponse({ error: "retired", message: "Open your portal link and enter your PIN." }, 410);
});
