/**
 * sync-loyalty-to-sheet — STUB
 *
 * Placeholder for the real Google Sheets mirror. The mirror is deferred
 * until a Google service account is provisioned; this stub exists so
 * upstream loyalty functions (award-loyalty-points, etc.) can call it
 * unconditionally from day one without erroring out. When Google access
 * is ready, swap the body of this handler — callers stay the same.
 *
 * Future implementation plan:
 *   - Read GOOGLE_SHEETS_SERVICE_ACCOUNT_KEY from Supabase Vault.
 *   - Authenticate to the Google Sheets API via JWT.
 *   - 'enrolled' → write a row to Sheet #2 Master
 *       (id: 15_YAjsYtlXJmFKpMTkHV9QAhvt26PcmhmWsuQ1PFi6k).
 *   - 'earned' / 'bonus' / 'redeemed':
 *       Look up customer email in Sheet #1 first
 *         (id: 1uekBf3HV5XEOEpHjrxiKXsRremtp5o6Vlg0F_oRZe7M),
 *       fall back to Sheet #2 if not found.
 *       Append row: Date | Amount | Invoice | Email.
 *       Use a negative amount for 'redeemed'.
 *   - 'expired' / 'tier_change': decide row layout when wiring real sync.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => null) as
    | {
      event_type?: string;
      customer?: { customer_id?: string; full_name?: string; email?: string };
      payload?: Record<string, unknown>;
    }
    | null;

  if (!body) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const eventType = body.event_type;
  const customerId = body.customer?.customer_id;

  if (!eventType || !customerId) {
    return json({ error: "event_type and customer.customer_id are required" }, 400);
  }

  console.log(
    "[sync-loyalty-to-sheet STUB]",
    JSON.stringify({
      event_type: eventType,
      customer: body.customer,
      payload: body.payload ?? {},
    }),
  );

  return json({
    success: true,
    stubbed: true,
    message: "Sheet sync deferred — Google access not yet configured",
    event_type: eventType,
    customer_id: customerId,
  });
});
