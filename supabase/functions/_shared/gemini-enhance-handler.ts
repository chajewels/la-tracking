import { corsPreflight, jsonResponse } from "./cors.ts";
import { LIMITS, callGemini, notConfigured, parseRequest } from "./gemini-enhance.ts";

/**
 * The request pipeline of gemini-product-enhance, with auth, the secret and
 * fetch injected so it can be driven end to end in tests. index.ts passes the
 * real ones. Order is fixed and tested:
 *   method -> auth -> permission -> body size -> JSON -> STRICT validation
 *   -> read GEMINI_API_KEY -> one Gemini call.
 * The secret is read only after the request is known to be valid, so a bad
 * request never touches it and never reaches Google.
 */
export interface EnhanceDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: Request) => Promise<any | Response>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requirePermission: (ctx: any, key: string) => Promise<Response | null>;
  getApiKey: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export async function handleEnhance(req: Request, deps: EnhanceDeps): Promise<Response> {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const ctx = await deps.requireAuth(req);
  if (ctx instanceof Response) return ctx;
  const denied = await deps.requirePermission(ctx, "manage_website_catalog");
  if (denied) return denied;

  const text = await req.text().catch(() => "");
  if (text.length > LIMITS.body_chars) return jsonResponse({ error: "Request is too large." }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return jsonResponse({ error: "Body must be JSON." }, 400); }
  const parsed = parseRequest(raw);
  if (!parsed.ok) return jsonResponse({ error: parsed.message }, 400);

  const apiKey = deps.getApiKey();
  if (!apiKey) return jsonResponse(notConfigured(), 503);

  const result = await callGemini(parsed.req, apiKey, deps.fetchImpl);
  // Log the outcome only — never the key, the prompt or Google's error body.
  console.log("gemini-product-enhance:", result.ok ? "ok" : result.error_category,
    "test=" + parsed.req.connectivity_test, "image=" + result.image_processed);
  const status = result.ok ? 200
    : result.error_category === "rate_limited" ? 429
    : result.error_category === "timeout" ? 504
    : result.error_category === "bad_request" ? 400
    : 502;
  return jsonResponse(result, status);
}
