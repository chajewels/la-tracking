// supabase/functions/shopify-order-diag/index.ts
// TEMPORARY diagnostic. Fetches a Shopify order's transaction breakdown so we can
// see how a store-credit payment is represented. DELETE after use.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { corsHeaders } from "../_shared/cors.ts";

const LOG = "[shopify-order-diag]";

// Shopify Admin API version — matches shopify-register-webhooks (hardcoded const,
// NOT an env var).
const SHOPIFY_API_VERSION = "2026-07";

// Mint a short-lived Admin API token via the client-credentials grant — the SAME
// pattern shopify-register-webhooks uses. There is no static admin-token secret;
// the token is minted at runtime from SHOPIFY_API_KEY + SHOPIFY_API_SECRET.
// Content-Type MUST be x-www-form-urlencoded — JSON is rejected by Shopify.
async function mintAccessToken(
  storeDomain: string,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const res = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`${LOG} token grant failed (${res.status}): ${body}`);
    throw new Error(`Shopify token grant failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  if (!json?.access_token) {
    console.error(`${LOG} token grant returned no access_token: ${JSON.stringify(json)}`);
    throw new Error("Shopify token grant returned no access_token");
  }
  return json.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
    const { data: { user }, error: authError } =
      await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    // Admin only.
    const { data: roleRows } = await supabase
      .from("user_roles").select("role").eq("user_id", user.id);
    const isAdmin = (roleRows ?? []).some((r: any) => r.role === "admin");
    if (!isAdmin) return json({ error: "admin required" }, 403);

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.order_id ?? "").trim();
    if (!orderId) return json({ error: "order_id is required" }, 400);

    // Reuse the EXACT secrets shopify-register-webhooks reads: SHOPIFY_STORE_DOMAIN
    // for the store, and SHOPIFY_API_KEY / SHOPIFY_API_SECRET to mint the Admin API
    // token via the client-credentials grant. (There is no SHOPIFY_ADMIN_ACCESS_TOKEN
    // secret, and SHOPIFY_API_VERSION is a hardcoded const, not an env var.)
    const storeDomain = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
    const apiKey = Deno.env.get("SHOPIFY_API_KEY")!;
    const apiSecret = Deno.env.get("SHOPIFY_API_SECRET")!;
    const token = await mintAccessToken(storeDomain, apiKey, apiSecret);

    const url =
      `https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/transactions.json`;
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    });
    const payload = await res.json().catch(() => null);

    console.log(`${LOG} TRANSACTIONS order=${orderId} status=${res.status} ` +
      JSON.stringify(payload));

    return json({ http_status: res.status, transactions: payload });
  } catch (e) {
    console.error(`${LOG} unhandled:`, e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
