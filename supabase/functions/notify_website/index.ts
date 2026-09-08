import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";

/**
 * Catalog change notifier. Called by DB triggers on website_products,
 * website_product_variants, website_product_media, website_collection_products.
 * Forwards { productSlug?, collectionSlug? } to ${WEBSITE_URL}/api/revalidate
 * with header x-revalidate-secret.
 */
Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  if (!ctx.isService) return jsonResponse({ error: "Unauthorized" }, 401);

  const websiteUrl = (Deno.env.get("WEBSITE_URL") ?? "").replace(/\/$/, "");
  const secret = Deno.env.get("REVALIDATE_SECRET") ?? "";
  if (!websiteUrl || !secret) {
    console.log("notify_website skipped: WEBSITE_URL or REVALIDATE_SECRET not configured");
    return jsonResponse({ skipped: true, reason: "not_configured" });
  }

  const body = await req.json().catch(() => ({}));
  const payload: Record<string, string> = {};
  if (body?.productSlug) payload.productSlug = String(body.productSlug);
  if (body?.collectionSlug) payload.collectionSlug = String(body.collectionSlug);

  try {
    const res = await fetch(`${websiteUrl}/api/revalidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-revalidate-secret": secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("revalidate failed", res.status, await res.text().catch(() => ""));
      return jsonResponse({ ok: false, status: res.status }, 200);
    }
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("revalidate error", (err as Error)?.message ?? err);
    return jsonResponse({ ok: false, error: "unreachable" }, 200);
  }
});
