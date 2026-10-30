import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { requireAuth, requirePermission } from "../_shared/handler.ts";
import { LIMITS, callGemini, notConfigured, parseRequest } from "../_shared/gemini-enhance.ts";

/**
 * Staff-only server-to-server connection to the Google Gemini API.
 * Hub -> this function -> generativelanguage.googleapis.com -> structured reply.
 *
 * Read-only: it writes nothing (no database, no storage) and returns suggested
 * text only. A caller must show it next to the original and require explicit
 * acceptance before anything is saved — this function never saves.
 *
 * Body: { connectivity_test: true, images?: [...] }   (fictional fixture, nothing else is read)
 *    or { product: { name, weight_g?, length_cm?, description_en }, images?: [{ mime_type, data_base64 }] }
 * Auth: staff JWT + manage_website_catalog (verify_jwt = true at the gateway).
 * Secret: GEMINI_API_KEY (edge secret) — read here, sent only in the
 * x-goog-api-key header, never logged or returned.
 * Separate from translate-product-description (Lovable AI gateway).
 */
Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const ctx = await requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;

  const text = await req.text().catch(() => "");
  if (text.length > LIMITS.body_chars) return jsonResponse({ error: "Request is too large." }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return jsonResponse({ error: "Body must be JSON." }, 400); }
  const parsed = parseRequest(raw);
  if (!parsed.ok) return jsonResponse({ error: parsed.message }, 400);

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return jsonResponse(notConfigured(), 503);

  const result = await callGemini(parsed.req, apiKey);
  // Log the outcome only — never the key, the prompt or Google's error body.
  console.log("gemini-product-enhance:", result.ok ? "ok" : result.error_category,
    "test=" + parsed.req.connectivity_test, "image=" + result.image_processed);
  const status = result.ok ? 200
    : result.error_category === "rate_limited" ? 429
    : result.error_category === "timeout" ? 504
    : result.error_category === "bad_request" ? 400
    : 502;
  return jsonResponse(result, status);
});
