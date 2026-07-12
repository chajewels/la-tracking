import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";

// ─────────────────────────────────────────────────────────────
// shopify-register-webhooks
// Registers the Path-B storefront webhooks (orders/create, orders/paid,
// orders/cancelled) with Shopify via the Admin GraphQL API so they are HMAC-signed with the
// app's SHOPIFY_API_SECRET — matching the shopify-webhook receiver's
// verification. Idempotent: re-running skips subscriptions that already
// point at our callbackUrl for the same topic.
//
// Auth to Shopify is the client-credentials grant (Dev-Dashboard app) —
// same pattern as shopify-sync-products; a short-lived token is minted per
// call. This function mutates app config, so it requires an authenticated
// ADMIN caller (unlike the public webhook receiver).
// ─────────────────────────────────────────────────────────────

const SHOPIFY_API_VERSION = "2026-07";
const LOG = "[shopify-register-webhooks]";

// The receiver's public invoke URL — the callbackUrl the webhooks POST to.
const CALLBACK_URL = "https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/shopify-webhook";

const TOPICS = ["ORDERS_CREATE", "ORDERS_PAID", "ORDERS_CANCELLED"] as const;

const CREATE_MUTATION = `
mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
    userErrors { field message }
  }
}`;

const LIST_QUERY = `
query {
  webhookSubscriptions(first: 50) {
    edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
  }
}`;

// Mint a short-lived Admin API token via the client-credentials grant.
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
    // Log the Shopify error body verbatim (esp. shop_not_permitted).
    console.error(
      `${LOG} token grant failed (${res.status}): ${body}`,
    );
    throw new Error(`Shopify token grant failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  if (!json?.access_token) {
    console.error(
      `${LOG} token grant returned no access_token: ${JSON.stringify(json)}`,
    );
    throw new Error("Shopify token grant returned no access_token");
  }
  return json.access_token as string;
}

async function shopifyGraphQL(
  gqlUrl: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(gqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  try {
    const SHOPIFY_API_KEY = Deno.env.get("SHOPIFY_API_KEY");
    const SHOPIFY_API_SECRET = Deno.env.get("SHOPIFY_API_SECRET");
    const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_STORE_DOMAIN) {
      return jsonResponse(
        { error: "Missing SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_STORE_DOMAIN" },
        500,
      );
    }

    // ── Admin gate — this endpoint mutates app config, requires a JWT ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");

    // Identify the caller with an anon-key client, then authorize with the
    // service-role client (RLS-bypassing role read).
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const isAdmin = (roleRows ?? []).some((r: any) => r.role === "admin");
    if (!isAdmin) {
      console.warn(`${LOG} forbidden — user ${user.id} is not admin`);
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // ── Mint Shopify token + resolve endpoints ──
    const accessToken = await mintAccessToken(
      SHOPIFY_STORE_DOMAIN,
      SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET,
    );
    const gqlUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    // ── Idempotency: fetch existing subscriptions once ──
    const listData = await shopifyGraphQL(gqlUrl, accessToken, LIST_QUERY);
    const existing = (listData?.webhookSubscriptions?.edges ?? []).map((e: any) => e.node);
    const existingByTopic = new Map<string, { id: string; callbackUrl?: string }>();
    for (const node of existing) {
      const callbackUrl = node?.endpoint?.callbackUrl;
      // Key on topic+callback so multiple subs per topic are all considered.
      if (node?.topic && callbackUrl === CALLBACK_URL) {
        existingByTopic.set(node.topic, { id: node.id, callbackUrl });
      }
    }

    const results: Array<{
      topic: string;
      status: "created" | "already_registered" | "error";
      id?: string;
      errors?: Array<{ field?: string[] | null; message: string }>;
    }> = [];

    for (const topic of TOPICS) {
      // Already registered for our callback → skip creation.
      const already = existingByTopic.get(topic);
      if (already) {
        console.log(`${LOG} topic=${topic} already_registered id=${already.id}`);
        results.push({ topic, status: "already_registered", id: already.id });
        continue;
      }

      try {
        const data = await shopifyGraphQL(gqlUrl, accessToken, CREATE_MUTATION, {
          topic,
          webhookSubscription: { callbackUrl: CALLBACK_URL, format: "JSON" },
        });
        const payload = data?.webhookSubscriptionCreate;
        const userErrors: Array<{ field?: string[] | null; message: string }> =
          payload?.userErrors ?? [];

        if (userErrors.length > 0) {
          // "address ... has already been taken" is not a real error — the
          // subscription exists, just wasn't matched above (race/format quirk).
          const alreadyTaken = userErrors.some((e) =>
            /already been taken/i.test(e.message ?? "")
          );
          if (alreadyTaken) {
            console.log(`${LOG} topic=${topic} already_registered (address taken)`);
            results.push({ topic, status: "already_registered" });
          } else {
            console.warn(`${LOG} topic=${topic} userErrors=${JSON.stringify(userErrors)}`);
            results.push({ topic, status: "error", errors: userErrors });
          }
          continue;
        }

        const sub = payload?.webhookSubscription;
        console.log(`${LOG} topic=${topic} created id=${sub?.id}`);
        results.push({ topic, status: "created", id: sub?.id });
      } catch (e) {
        console.error(`${LOG} topic=${topic} create failed: ${(e as Error).message}`);
        results.push({ topic, status: "error", errors: [{ message: (e as Error).message }] });
      }
    }

    return jsonResponse({ results }, 200);
  } catch (e) {
    console.error(`${LOG} fatal: ${(e as Error).message}`);
    return jsonResponse({ error: (e as Error).message ?? "registration failed" }, 500);
  }
});
