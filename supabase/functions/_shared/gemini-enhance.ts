/**
 * Direct Google Gemini connection for product-copy enhancement. Pure logic
 * (validation, request body, response + error mapping) so it is unit-testable;
 * the edge function gemini-product-enhance wires auth and the secret.
 *
 * Verified against ai.google.dev (2026-10-30): POST
 * https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent,
 * key in the x-goog-api-key header (never the URL, so it cannot reach a log),
 * image as parts[].inline_data { mime_type, data(base64) }, usage in
 * usageMetadata { promptTokenCount, candidatesTokenCount, thoughtsTokenCount,
 * totalTokenCount }, thinkingConfig.thinkingLevel "low" ("minimal" is NOT
 * supported on 3.8 Flash).
 */

export const GEMINI_MODEL = "gemini-3.8-flash";
export const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

export const LIMITS = {
  body_chars: 1_600_000,
  name: 200,
  description: 4000,
  short: 60,
  /** Combined variant sizes / stones ("40cm, 45cm"). */
  details: 200,
  images: 1,
  image_bytes: 1_048_576,
  max_output_tokens: 1024,
  timeout_ms: 20_000,
} as const;

export const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/** The only product a connectivity test ever sends. Fictional. */
export const FIXTURE: ProductInput = {
  name: "K18 Yellow Gold Necklace",
  weight_g: 2.0,
  length_cm: 40,
  description_en: "K18 gold necklace, 40cm, 2.0g.",
};

export interface ProductInput {
  name: string;
  weight_g?: number;
  length_cm?: number;
  description_en: string;
  /** Edit product fields (owner 2026-10-31): metal stamps as staff picked them, the
   *  brand (only for Branded pieces), condition, variant sizes and stones. Origin is
   *  never sent: the website's origin badge is the only place an origin is stated. */
  metal?: string;
  brand?: string;
  condition?: "New" | "Preloved";
  size?: string;
  stone?: string;
}
export interface ImageInput { mime_type: string; data_base64: string }
export interface EnhanceRequest { product: ProductInput; images: ImageInput[]; connectivity_test: boolean }

export type ErrorCategory =
  | "bad_request" | "not_configured" | "auth_or_access" | "rate_limited" | "quota_or_billing"
  | "timeout" | "network" | "upstream_unavailable" | "blocked" | "empty_response" | "unexpected_response";

export interface EnhanceResult {
  ok: boolean;
  model: string;
  connected: boolean;
  addition: string | null;
  usage: { prompt_tokens: number | null; output_tokens: number | null; thoughts_tokens: number | null; total_tokens: number | null } | null;
  image_processed: boolean;
  error_category: ErrorCategory | null;
  message: string | null;
}

const failure = (category: ErrorCategory, message: string, connected = false): EnhanceResult => ({
  ok: false, model: GEMINI_MODEL, connected, addition: null, usage: null,
  image_processed: false, error_category: category, message,
});

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Decoded size of a base64 string without decoding it. */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

const keysOf = (o: object) => Object.keys(o);
const unknownKeys = (o: object, allowed: readonly string[]) => keysOf(o).filter((k) => !allowed.includes(k));

/**
 * Validate the request body, STRICTLY: any field that is not explicitly
 * allowed is rejected, never ignored or forwarded.
 *
 * Connectivity test (QA-681-01): the body must be exactly
 * `{ "connectivity_test": true }` — no images, no product, no fixture text, no
 * other field. The fictional FIXTURE is the only content ever sent, so a test
 * cannot carry a real photo or real product data to Google.
 *
 * Enhancement request: `{ product, images? }` (connectivity_test absent or
 * false), with every nested field bounded.
 */
export function parseRequest(raw: unknown): { ok: true; req: EnhanceRequest } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "Body must be a JSON object." };
  const body = raw as Record<string, unknown>;

  if (body.connectivity_test === true) {
    if (unknownKeys(body, ["connectivity_test"]).length) {
      return { ok: false, message: 'A connectivity test takes only { "connectivity_test": true } — no images, product or other fields.' };
    }
    return { ok: true, req: { product: FIXTURE, images: [], connectivity_test: true } };
  }
  if (body.connectivity_test !== undefined && body.connectivity_test !== false) {
    return { ok: false, message: "connectivity_test must be true or omitted." };
  }
  const extra = unknownKeys(body, ["product", "images", "connectivity_test"]);
  if (extra.length) return { ok: false, message: `Unexpected field: ${extra[0]}.` };

  const images: ImageInput[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) return { ok: false, message: "images must be an array." };
    if (body.images.length > LIMITS.images) return { ok: false, message: `At most ${LIMITS.images} image per request.` };
    for (const i of body.images) {
      if (!i || typeof i !== "object" || Array.isArray(i) || unknownKeys(i, ["mime_type", "data_base64"]).length) {
        return { ok: false, message: "Each image must be { mime_type, data_base64 } only." };
      }
      const mime = str((i as ImageInput).mime_type);
      const data = str((i as ImageInput).data_base64);
      if (!(IMAGE_MIME as readonly string[]).includes(mime)) return { ok: false, message: "Image type must be JPEG, PNG or WebP." };
      if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, message: "Image data must be base64." };
      if (base64Bytes(data) > LIMITS.image_bytes) return { ok: false, message: "Image is too large (max 1 MB)." };
      images.push({ mime_type: mime, data_base64: data });
    }
  }
  const p = body.product as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return { ok: false, message: "product is required." };
  const badField = unknownKeys(p, ["name", "weight_g", "length_cm", "description_en", "metal", "brand", "condition", "size", "stone"]);
  if (badField.length) return { ok: false, message: `Unexpected product field: ${badField[0]}.` };
  const name = str(p.name);
  const description_en = str(p.description_en);
  if (!name) return { ok: false, message: "product.name is required." };
  if (name.length > LIMITS.name) return { ok: false, message: `product.name is too long (max ${LIMITS.name}).` };
  if (description_en.length > LIMITS.description) return { ok: false, message: `product.description_en is too long (max ${LIMITS.description}).` };
  const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
  const weight_g = num(p.weight_g);
  const length_cm = num(p.length_cm);
  for (const [k, v] of [["weight_g", weight_g], ["length_cm", length_cm]] as const) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 100000)) return { ok: false, message: `product.${k} is not a valid number.` };
  }
  const extras: Pick<ProductInput, "metal" | "brand" | "size" | "stone"> = {};
  for (const [k, max] of [["metal", LIMITS.short], ["brand", LIMITS.short], ["size", LIMITS.details], ["stone", LIMITS.details]] as const) {
    if (p[k] === undefined || p[k] === null) continue;
    if (typeof p[k] !== "string") return { ok: false, message: `product.${k} must be text.` };
    const v = str(p[k]);
    if (v.length > max) return { ok: false, message: `product.${k} is too long (max ${max}).` };
    if (v) extras[k] = v;
  }
  let condition: ProductInput["condition"];
  if (p.condition !== undefined && p.condition !== null) {
    if (p.condition !== "New" && p.condition !== "Preloved") return { ok: false, message: "product.condition must be New or Preloved." };
    condition = p.condition;
  }
  return {
    ok: true,
    req: { product: { name, weight_g, length_cm, description_en, ...extras, ...(condition ? { condition } : {}) }, images, connectivity_test: false },
  };
}

/**
 * Owner 2026-10-30/31: a warm description written ABOVE the existing text (the
 * caller places it; the existing description is never changed), in the shape of
 * the approved R8913 sample: the piece itself (about 60-90 words), a preloved
 * line for preloved pieces, and a "Lovely for:" line of occasions and gifts.
 */
const INSTRUCTION = [
  "You write product descriptions for Cha Jewels, a jewelry shop. Using ONLY the facts and the photo below, write in warm, elegant English, in exactly this shape, with one blank line between the parts:",
  "1. One or two short paragraphs (about 60-90 words in total) describing the piece itself: its colour, sparkle, shape and how it looks when worn.",
  "2. ONLY if the facts say Condition: Preloved, one short sentence such as: \"A preloved piece, carefully checked by our team before listing, ready to start its next chapter with you.\"",
  "3. A last line that starts with \"Lovely for: \" followed by 3 to 5 occasions or gift ideas separated by \" · \" (for example: anniversaries · a birthday gift for her · a treat for yourself · evenings out).",
  "Rules: do not repeat the product name or the existing description. Do not invent materials, stones, brands, measurements or numbers beyond the facts. Write metals exactly as given (for example K18, PT900, SV925) and never put a country or nationality before \"gold\". Never say where the piece was made and never mention Japan or Tokyo. Never mention authenticity, certificates, guarantees, price, sale, discount, points, layaway, installments or payment. No headings, bullets or markdown.",
].join("\n");

export function buildBody(req: EnhanceRequest): Record<string, unknown> {
  const p = req.product;
  const facts = [
    `Product: ${p.name}`,
    p.weight_g !== undefined ? `Weight: ${p.weight_g}g` : "",
    p.length_cm !== undefined ? `Length: ${p.length_cm}cm` : "",
    p.metal ? `Metal: ${p.metal}` : "",
    p.brand ? `Brand: ${p.brand}` : "",
    p.condition ? `Condition: ${p.condition}` : "",
    p.size ? `Size: ${p.size}` : "",
    p.stone ? `Stone: ${p.stone}` : "",
    p.description_en ? `Existing description (keep as it is, do not repeat): ${p.description_en}` : "",
  ].filter(Boolean).join("\n");
  const parts: Record<string, unknown>[] = [
    ...req.images.map((i) => ({ inline_data: { mime_type: i.mime_type, data: i.data_base64 } })),
    { text: `${INSTRUCTION}\n\n${facts}` },
  ];
  return {
    contents: [{ parts }],
    generationConfig: {
      maxOutputTokens: LIMITS.max_output_tokens,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
}

/** Map a non-2xx Google status to a category. Never echoes Google's body (it can quote the request). */
export function categorizeStatus(status: number): EnhanceResult {
  if (status === 429) return failure("rate_limited", "Gemini rate limit reached. Try again in a moment.", true);
  if (status === 400) return failure("bad_request", "Gemini rejected the request.", true);
  if (status === 401 || status === 403) return failure("auth_or_access", "Gemini refused the credential (invalid, restricted or not enabled for this model).", true);
  if (status === 402) return failure("quota_or_billing", "Gemini quota or billing needs attention.", true);
  if (status >= 500) return failure("upstream_unavailable", `Gemini is temporarily unavailable (${status}).`, true);
  return failure("unexpected_response", `Unexpected Gemini status ${status}.`, true);
}

interface GeminiJson {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
}

export function parseResponse(json: GeminiJson, hadImage: boolean): EnhanceResult {
  if (json?.promptFeedback?.blockReason) return failure("blocked", "Gemini declined this content.", true);
  const cand = json?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p?.text ?? "").join("").trim();
  if (!text) {
    return cand?.finishReason && cand.finishReason !== "STOP"
      ? failure("blocked", "Gemini returned no text for this content.", true)
      : failure("empty_response", "Gemini returned an empty response.", true);
  }
  const u = json.usageMetadata;
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    ok: true, model: GEMINI_MODEL, connected: true, addition: text,
    usage: u ? {
      prompt_tokens: n(u.promptTokenCount), output_tokens: n(u.candidatesTokenCount),
      thoughts_tokens: n(u.thoughtsTokenCount), total_tokens: n(u.totalTokenCount),
    } : null,
    // True only when an image part was actually in the request that Gemini answered.
    image_processed: hadImage,
    error_category: null, message: null,
  };
}

/**
 * One call to Gemini, no retries. The key goes in a header; nothing from the
 * key, the request or Google's error body is ever placed in the result.
 */
export async function callGemini(
  req: EnhanceRequest, apiKey: string, fetchImpl: typeof fetch = fetch,
): Promise<EnhanceResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITS.timeout_ms);
  try {
    const res = await fetchImpl(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(req)),
      signal: ctl.signal,
    });
    if (!res.ok) return categorizeStatus(res.status);
    let json: GeminiJson;
    try { json = await res.json(); } catch { return failure("unexpected_response", "Gemini sent an unreadable response.", true); }
    return parseResponse(json, req.images.length > 0);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return failure("timeout", `Gemini did not answer within ${LIMITS.timeout_ms / 1000}s.`);
    return failure("network", "Could not reach Gemini.");
  } finally {
    clearTimeout(timer);
  }
}

export const notConfigured = (): EnhanceResult => failure("not_configured", "The Gemini connection is not configured on the server.");

/** Verified list prices, USD per 1M tokens, valid through 2026-12-31 (ai.google.dev/pricing, read 2026-10-30). */
export const PRICE_PER_M = { input: 0.75, output: 3.75 } as const;

/** Paid-tier estimate; thinking tokens bill as output. Free tier would be $0 — only the key's project knows its tier. */
export function estimateCostUsd(u: NonNullable<EnhanceResult["usage"]>): number {
  const out = (u.output_tokens ?? 0) + (u.thoughts_tokens ?? 0);
  return ((u.prompt_tokens ?? 0) * PRICE_PER_M.input + out * PRICE_PER_M.output) / 1_000_000;
}
