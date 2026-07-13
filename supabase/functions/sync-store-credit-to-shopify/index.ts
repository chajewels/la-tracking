// supabase/functions/sync-store-credit-to-shopify/index.ts
// Mirrors a Hub store-credit movement into Shopify's native store-credit
// account so the customer can spend it at Shopify checkout. The Hub is the
// SINGLE SOURCE OF TRUTH — Shopify never mints credit on its own. Called
// service-to-service by issue-store-credit / void-store-credit-lot /
// redeem-store-credit / cancel-cash-order AFTER their RPC succeeds.
//
// A Shopify sync failure NEVER fails the Hub operation (the credit is already
// committed); it is recorded in store_credit_shopify_sync for retry.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/jwt-claims.ts";

const LOG = "[sync-store-credit-to-shopify]";

// Shopify Admin API version — matches shopify-register-webhooks (hardcoded const).
const SHOPIFY_API_VERSION = "2026-07";

// Mint a short-lived Admin API token via the client-credentials grant — the SAME
// helper shopify-register-webhooks / shopify-order-diag use. There is NO
// SHOPIFY_ADMIN_ACCESS_TOKEN secret; the token is minted at runtime from
// SHOPIFY_API_KEY + SHOPIFY_API_SECRET. Content-Type MUST be
// x-www-form-urlencoded — JSON is rejected by Shopify.
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

    // ── Validate ──
    const body = await req.json().catch(() => ({}));
    const customer_id = body.customer_id ?? null;
    const direction = body.direction ?? null;
    const amount = typeof body.amount === "number" ? body.amount : null;
    const currency = body.currency ?? null;
    const lot_id = body.lot_id ?? null;
    const expires_at = typeof body.expires_at === "string" ? body.expires_at : null;
    const reason = typeof body.reason === "string" ? body.reason : null;

    if (!customer_id) return json({ error: "customer_id is required" }, 400);
    if (direction !== "credit" && direction !== "debit") {
      return json({ error: "direction must be 'credit' or 'debit'" }, 400);
    }
    if (amount === null || !(amount > 0)) {
      return json({ error: "amount must be greater than 0" }, 400);
    }

    // Record a skipped sync row and return 200. These are NORMAL, not errors.
    const recordSkip = async (skipReason: string, shopifyCustomerId: string | null) => {
      try {
        await supabase.from("store_credit_shopify_sync").insert({
          customer_id,
          shopify_customer_id: shopifyCustomerId,
          lot_id,
          direction,
          amount,
          currency,
          status: "skipped",
          reason: reason ?? skipReason,
          attempts: 0,
          error_detail: skipReason,
        });
      } catch (e) {
        console.warn(`${LOG} failed to record skip row (${skipReason}):`, e);
      }
      console.log(`${LOG} skipped customer=${customer_id} reason=${skipReason}`);
      return json({ skipped: skipReason });
    };

    // ── Skip: the Shopify store is JPY-only. PHP credit stays Hub-only. ──
    if (currency !== "JPY") {
      return await recordSkip("non_jpy_currency", null);
    }

    // ── Resolve the Shopify customer id ──
    const { data: customerRow } = await supabase
      .from("customers")
      .select("shopify_customer_id")
      .eq("id", customer_id)
      .maybeSingle();
    const shopifyCustomerId: string | null = customerRow?.shopify_customer_id ?? null;

    // ── Skip: no Shopify identity (live-selling / layaway customers). ──
    if (!shopifyCustomerId) {
      return await recordSkip("no_shopify_customer", null);
    }

    // ── Record a pending row BEFORE calling Shopify ──
    const { data: syncRow, error: syncInsertErr } = await supabase
      .from("store_credit_shopify_sync")
      .insert({
        customer_id,
        shopify_customer_id: shopifyCustomerId,
        lot_id,
        direction,
        amount,
        currency,
        status: "pending",
        reason,
        attempts: 1,
      })
      .select("id")
      .single();
    if (syncInsertErr || !syncRow) {
      console.error(`${LOG} failed to insert pending sync row:`, syncInsertErr);
      return json({ error: syncInsertErr?.message ?? "sync row insert failed" }, 500);
    }
    const syncRowId = syncRow.id;

    // Mark the sync row failed and return 200 — a Shopify failure must NEVER fail
    // the Hub operation that called us.
    const recordFailure = async (detail: string) => {
      try {
        await supabase.from("store_credit_shopify_sync")
          .update({ status: "failed", error_detail: detail })
          .eq("id", syncRowId);
      } catch (e) {
        console.warn(`${LOG} failed to record failure row:`, e);
      }
      console.error(`${LOG} sync FAILED customer=${customer_id} direction=${direction}: ${detail}`);
      return json({ success: false, error: detail });
    };

    // ── Build + send the GraphQL mutation ──
    const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
    const amountStr = String(amount);

    let query: string;
    let variables: Record<string, unknown>;
    if (direction === "credit") {
      query = `
        mutation CreditStoreCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
          storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
            storeCreditAccountTransaction {
              id
              amount { amount currencyCode }
            }
            userErrors { field message }
          }
        }`;
      variables = {
        id: gid,
        creditInput: {
          creditAmount: { amount: amountStr, currencyCode: "JPY" },
          ...(expires_at ? { expiresAt: expires_at } : {}),
        },
      };
    } else {
      query = `
        mutation DebitStoreCredit($id: ID!, $debitInput: StoreCreditAccountDebitInput!) {
          storeCreditAccountDebit(id: $id, debitInput: $debitInput) {
            storeCreditAccountTransaction {
              id
              amount { amount currencyCode }
            }
            userErrors { field message }
          }
        }`;
      variables = {
        id: gid,
        debitInput: {
          debitAmount: { amount: amountStr, currencyCode: "JPY" },
        },
      };
    }

    let gj: any = null;
    try {
      const token = await mintAccessToken();
      const url = `https://${Deno.env.get("SHOPIFY_STORE_DOMAIN")}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      gj = await res.json().catch(() => null);
      if (!res.ok) {
        return await recordFailure(`Shopify HTTP ${res.status}: ${JSON.stringify(gj)}`);
      }
    } catch (e) {
      return await recordFailure(`transport error: ${String((e as any)?.message ?? e)}`);
    }

    const root = direction === "credit"
      ? gj?.data?.storeCreditAccountCredit
      : gj?.data?.storeCreditAccountDebit;
    const userErrors: any[] = Array.isArray(root?.userErrors) ? root.userErrors : [];

    // userErrors = Shopify rejected the write (business validation). A real failure.
    if (userErrors.length > 0) {
      return await recordFailure(`userErrors: ${JSON.stringify(userErrors)}`);
    }

    const txn = root?.storeCreditAccountTransaction;

    // No transaction returned AND a top-level GraphQL error => the mutation did
    // not execute. This is the only case where gj.errors signals a real failure.
    if (!txn) {
      return await recordFailure(
        gj?.errors
          ? `GraphQL errors: ${JSON.stringify(gj.errors)}`
          : "no transaction returned by Shopify",
      );
    }

    // A transaction WAS returned — the write committed. If gj.errors is non-empty
    // at this point it is a partial error on a field we requested but do not need
    // (e.g. a nested read requiring a scope we don't hold). Log it as a warning and
    // treat the sync as SUCCESSFUL. Recording it as 'failed' would invite a retry
    // and DOUBLE-CREDIT the customer.
    if (gj?.errors) {
      console.warn(`${LOG} write succeeded but response had partial errors (non-fatal): ${JSON.stringify(gj.errors)}`);
    }

    const shopifyTransactionId: string | null = txn?.id ?? null;

    try {
      await supabase.from("store_credit_shopify_sync")
        .update({
          status: "synced",
          synced_at: new Date().toISOString(),
          shopify_transaction_id: shopifyTransactionId,
          shopify_balance_after: null,
        })
        .eq("id", syncRowId);
    } catch (e) {
      console.warn(`${LOG} failed to mark sync row synced:`, e);
    }

    console.log(
      `${LOG} synced customer=${customer_id} direction=${direction} amount=${amountStr} ` +
      `txn=${shopifyTransactionId}`,
    );
    return json({
      success: true,
      shopify_transaction_id: shopifyTransactionId,
    });
  } catch (e) {
    console.error(`${LOG} unhandled:`, e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
