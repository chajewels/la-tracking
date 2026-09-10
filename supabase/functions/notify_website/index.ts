import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";

/**
 * Catalog change notifier. Called by DB triggers on website_products,
 * website_product_variants, website_product_media, website_collection_products
 * and website_collections.
 *
 * Forwards { productSlug?, collectionSlug? } to ${WEBSITE_URL}/api/revalidate
 * with header x-revalidate-secret.
 *
 * NEVER return 200 on a failure. The caller is a DB trigger using
 * `PERFORM net.http_post(...)`, which is fire-and-forget: the catalog write
 * commits regardless of what happens here, and the ONLY trace of a failure is
 * this function's log line plus the row pg_net records in net._http_response.
 * A 200 on a missed revalidation makes that row indistinguishable from success,
 * and the symptom — a storefront that quietly stops updating — can then run for
 * weeks unnoticed. Status codes are the health signal:
 *
 *   500  misconfigured   WEBSITE_URL or REVALIDATE_SECRET missing
 *   502  undelivered     storefront rejected the call or was unreachable
 *   200  delivered       storefront accepted the revalidation
 *
 * Monitor with: SELECT * FROM net._http_response WHERE status_code <> 200;
 */
Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const ctx = await requireAuth(req, { allowServiceRole: true });
  if (ctx instanceof Response) return ctx;
  if (!ctx.isService) return jsonResponse({ error: "Unauthorized" }, 401);

  const websiteUrl = (Deno.env.get("WEBSITE_URL") ?? "").replace(/\/$/, "");
  const secret = Deno.env.get("REVALIDATE_SECRET") ?? "";
  const missing = [
    !websiteUrl ? "WEBSITE_URL" : null,
    !secret ? "REVALIDATE_SECRET" : null,
  ].filter(Boolean) as string[];

  if (missing.length > 0) {
    console.error(
      `notify_website NOT CONFIGURED: ${missing.join(", ")} unset. ` +
        "Catalog changes are NOT reaching the storefront.",
    );
    return jsonResponse(
      { ok: false, error: "not_configured", missing },
      500,
    );
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
      const detail = await res.text().catch(() => "");
      console.error("notify_website revalidate rejected", res.status, detail);
      return jsonResponse(
        { ok: false, error: "revalidate_rejected", status: res.status, payload },
        502,
      );
    }
    return jsonResponse({ ok: true, payload });
  } catch (err) {
    console.error("notify_website revalidate unreachable", (err as Error)?.message ?? err);
    return jsonResponse({ ok: false, error: "unreachable", payload }, 502);
  }
});
