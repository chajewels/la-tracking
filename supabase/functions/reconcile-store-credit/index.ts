// supabase/functions/reconcile-store-credit/index.ts
// Detects DRIFT between the Hub's store-credit ledger (the SINGLE SOURCE OF
// TRUTH) and Shopify's mirror. It REPORTS — it never repairs. Over the last
// week the correct side has sometimes been the Hub and sometimes Shopify, so
// auto-healing would destroy correct data and mask the underlying bug. A human
// must look at each delta and decide.
//
// Called either by a scheduled service-role job or by an authenticated admin.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/jwt-claims.ts";

const LOG = "[reconcile-store-credit]";

// Shopify Admin API version — matches sync-store-credit-to-shopify (hardcoded const).
const SHOPIFY_API_VERSION = "2026-07";

// Cap the run so a single invocation cannot exhaust Shopify's rate limit.
const MAX_CUSTOMERS_PER_RUN = 200;
// Small delay between Shopify calls — the API is rate limited and we loop.
const SHOPIFY_CALL_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mint a short-lived Admin API token via the client-credentials grant — the SAME
// helper sync-store-credit-to-shopify uses. There is NO SHOPIFY_ADMIN_ACCESS_TOKEN
// secret; the token is minted at runtime from SHOPIFY_API_KEY + SHOPIFY_API_SECRET.
// Content-Type MUST be x-www-form-urlencoded — JSON is rejected by Shopify.
async function mintAccessToken(): Promise<string> {
  const storeDomain = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
  const apiKey = Deno.env.get("SHOPIFY_API_KEY")!;
  const apiSecret = Deno.env.get("SHOPIFY_API_SECRET")!;
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
  const j = await res.json();
  if (!j?.access_token) {
    console.error(`${LOG} token grant returned no access_token: ${JSON.stringify(j)}`);
    throw new Error("Shopify token grant returned no access_token");
  }
  return j.access_token as string;
}

// Read a customer's Shopify store-credit balances. Requires the
// read_store_credit_accounts scope (already granted). Returns the JPY balance,
// defaulting to 0 when the customer has no store-credit account at all.
// Throws on transport / GraphQL / no-data failures — the caller records the row
// as 'shopify_unreadable' and continues.
const STORE_CREDIT_QUERY = `
  query CustomerStoreCredit($id: ID!) {
    customer(id: $id) {
      id
      storeCreditAccounts(first: 10) {
        edges { node { id balance { amount currencyCode } } }
      }
    }
  }`;

async function readShopifyJpyBalance(
  token: string,
  shopifyCustomerId: string,
): Promise<number> {
  const url = `https://${Deno.env.get("SHOPIFY_STORE_DOMAIN")}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: STORE_CREDIT_QUERY, variables: { id: gid } }),
  });
  const gj = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(gj)}`);
  }
  if (gj?.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(gj.errors)}`);
  }
  const customer = gj?.data?.customer;
  if (!customer) {
    throw new Error(`no customer data returned: ${JSON.stringify(gj)}`);
  }
  const edges: any[] = customer?.storeCreditAccounts?.edges ?? [];
  // No store-credit account at all → balance is 0 (not an error).
  const jpyNode = edges
    .map((e) => e?.node)
    .find((n) => n?.balance?.currencyCode === "JPY");
  const raw = jpyNode?.balance?.amount;
  return raw != null ? Number(raw) : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ── Auth: internal service-role call OR an authenticated admin ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
    const token = authHeader.replace("Bearer ", "");

    if (!isServiceRole(token)) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) return json({ error: "Unauthorized" }, 401);
      const { data: roleRows } = await supabase
        .from("user_roles").select("role").eq("user_id", user.id);
      const isAdmin = (roleRows ?? []).some((r: any) => r.role === "admin");
      if (!isAdmin) return json({ error: "admin required" }, 403);
    }

    const run_id = crypto.randomUUID();
    const checkedAt = new Date().toISOString();

    // ── Fetch every customer with a Shopify identity ──
    const { data: customerRows, error: custErr } = await supabase
      .from("customers")
      .select("id, full_name, email, shopify_customer_id")
      .not("shopify_customer_id", "is", null);
    if (custErr) {
      console.error(`${LOG} failed to load customers:`, custErr);
      return json({ error: custErr.message ?? "failed to load customers" }, 500);
    }

    let customers = customerRows ?? [];
    const capHit = customers.length > MAX_CUSTOMERS_PER_RUN;
    if (capHit) {
      console.warn(
        `${LOG} run=${run_id} customer cap hit — ${customers.length} eligible, ` +
        `checking first ${MAX_CUSTOMERS_PER_RUN}`,
      );
      customers = customers.slice(0, MAX_CUSTOMERS_PER_RUN);
    }

    // Mint the Shopify token once for the whole run.
    let shopifyToken: string;
    try {
      shopifyToken = await mintAccessToken();
    } catch (e) {
      console.error(`${LOG} run=${run_id} could not mint Shopify token:`, e);
      return json({ error: `Shopify token mint failed: ${String((e as any)?.message ?? e)}` }, 500);
    }

    let checked = 0;
    let matched = 0;
    const drift: Array<Record<string, unknown>> = [];
    const unreadable: Array<Record<string, unknown>> = [];

    for (let i = 0; i < customers.length; i++) {
      const c = customers[i] as any;
      checked++;

      // a) HUB balance — active, unexpired JPY lots. Default 0.
      let hubBalance = 0;
      try {
        const { data: lots } = await supabase
          .from("store_credit_lots")
          .select("remaining_amount")
          .eq("customer_id", c.id)
          .eq("currency", "JPY")
          .eq("status", "active")
          .gt("expires_at", checkedAt);
        hubBalance = (lots ?? []).reduce(
          (sum: number, l: any) => sum + Number(l.remaining_amount ?? 0),
          0,
        );
      } catch (e) {
        console.warn(`${LOG} run=${run_id} customer=${c.id} hub lot read failed:`, e);
      }

      // b/c) SHOPIFY balance.
      let shopifyBalance: number | null = null;
      let unreadableDetail: string | null = null;
      try {
        shopifyBalance = await readShopifyJpyBalance(shopifyToken, c.shopify_customer_id);
      } catch (e) {
        unreadableDetail = String((e as any)?.message ?? e);
      }

      // Throttle between Shopify calls (skip the wait after the last one).
      if (i < customers.length - 1) await sleep(SHOPIFY_CALL_DELAY_MS);

      if (shopifyBalance === null) {
        // c) Shopify read failed — record and continue.
        unreadable.push({ customer_id: c.id, full_name: c.full_name, detail: unreadableDetail });
        try {
          await supabase.from("store_credit_reconciliation").insert({
            run_id,
            customer_id: c.id,
            shopify_customer_id: c.shopify_customer_id,
            currency: "JPY",
            hub_balance: hubBalance,
            shopify_balance: null,
            delta: null,
            status: "shopify_unreadable",
            detail: unreadableDetail,
            checked_at: checkedAt,
          });
        } catch (e) {
          console.warn(`${LOG} run=${run_id} customer=${c.id} failed to insert unreadable row:`, e);
        }
        continue;
      }

      // d) Compare.
      const delta = hubBalance - shopifyBalance;
      const isMatch = Math.abs(delta) <= 0.01;
      const status = isMatch ? "match" : "drift";
      if (isMatch) {
        matched++;
      } else {
        drift.push({
          customer_id: c.id,
          full_name: c.full_name,
          email: c.email,
          hub_balance: hubBalance,
          shopify_balance: shopifyBalance,
          delta,
        });
      }

      // e) Record the reconciliation row.
      try {
        await supabase.from("store_credit_reconciliation").insert({
          run_id,
          customer_id: c.id,
          shopify_customer_id: c.shopify_customer_id,
          currency: "JPY",
          hub_balance: hubBalance,
          shopify_balance: shopifyBalance,
          delta,
          status,
          detail: null,
          checked_at: checkedAt,
        });
      } catch (e) {
        console.warn(`${LOG} run=${run_id} customer=${c.id} failed to insert ${status} row:`, e);
      }
    }

    // 5) Gather unresolved sync rows — KNOWN drift (a push that did not land).
    // A separate signal; NOT inserted into the reconciliation table.
    let failedSyncs: any[] = [];
    try {
      const { data: syncRows } = await supabase
        .from("store_credit_shopify_sync")
        .select("id, customer_id, direction, amount, status, error_detail, created_at")
        .in("status", ["pending", "failed"]);
      failedSyncs = syncRows ?? [];
    } catch (e) {
      console.warn(`${LOG} run=${run_id} failed to load unresolved sync rows:`, e);
    }

    const summary = {
      run_id,
      checked,
      matched,
      drift,
      unreadable,
      failed_syncs: failedSyncs,
      ...(capHit ? { cap_hit: true, max_per_run: MAX_CUSTOMERS_PER_RUN } : {}),
    };

    const line =
      `${LOG} run=${run_id} checked=${checked} matched=${matched} ` +
      `drift=${drift.length} unreadable=${unreadable.length} failed_syncs=${failedSyncs.length}`;
    if (drift.length > 0 || failedSyncs.length > 0) {
      console.warn(line);
    } else {
      console.log(line);
    }

    return json(summary);
  } catch (e) {
    console.error(`${LOG} unhandled:`, e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
