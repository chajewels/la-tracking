// POST /functions/v1/shopify-sync-products — RETIRED 2026-10-03.
//
// It pulled the Shopify product catalog into public.products with NO
// authentication at all (Lovable scan 2026-10-03, finding "Anyone can trigger
// privileged Shopify catalog sync"): any holder of the public anon key could
// start a sync and mint a Shopify token. Nothing in the Hub or cron called it.
//
// The owner decided the same day that Shopify is no longer used, so the
// function is kept only as a fixed refusal — a stale caller gets a clear
// answer instead of a 404. Never restore the old body; if a catalog sync is
// ever wanted again it goes behind requireAuth + an admin permission like
// shopify-register-webhooks.
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";

Deno.serve((req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  return jsonResponse({ error: "retired", message: "Shopify catalog sync is no longer in use." }, 410);
});
