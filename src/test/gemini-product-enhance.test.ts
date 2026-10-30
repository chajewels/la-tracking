import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleEnhance, type EnhanceDeps } from "../../supabase/functions/_shared/gemini-enhance-handler.ts";
import {
  FIXTURE, GEMINI_ENDPOINT, GEMINI_MODEL, LIMITS, base64Bytes, buildBody, callGemini,
  categorizeStatus, estimateCostUsd, parseRequest, parseResponse,
} from "../../supabase/functions/_shared/gemini-enhance.ts";

/**
 * Direct Gemini connection (gemini-product-enhance). EVERYTHING here is a
 * mocked fetch: it proves request shape, validation and error mapping, NOT
 * that Google accepts the secret. Live connectivity is a separate, owner-approved run.
 */

const ROOT = resolve(__dirname, "../..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
const KEY = "AIza-TEST-KEY-never-real-0123456789";

const okJson = (over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text: "Layer it with a white tee." }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 40, totalTokenCount: 190 },
  ...over,
});
const fetchOk = (json: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
const test = () => { const p = parseRequest({ connectivity_test: true }); if (!p.ok) throw new Error(p.message); return p.req; };

const PRODUCT = { name: "Test Ring", description_en: "Plain band." };
const IMG = { mime_type: "image/png", data_base64: "AAAA" };

describe("request validation", () => {
  it("a connectivity test is exactly { connectivity_test: true } and sends the fictional fixture", () => {
    const p = parseRequest({ connectivity_test: true });
    expect(p.ok && p.req).toEqual({ product: FIXTURE, images: [], connectivity_test: true });
    expect(FIXTURE.name).toBe("K18 Yellow Gold Necklace");
  });
  it("QA-681-01: a connectivity test with an image is rejected, not ignored", () => {
    const p = parseRequest({ connectivity_test: true, images: [IMG] });
    expect(p.ok).toBe(false);
    expect(parseRequest({ connectivity_test: true, images: [] }).ok).toBe(false);
  });
  it("a connectivity test with product data or replacement fixture text is rejected", () => {
    expect(parseRequest({ connectivity_test: true, product: { name: "REAL PIECE", description_en: "secret" } }).ok).toBe(false);
    expect(parseRequest({ connectivity_test: true, fixture: "my own text" }).ok).toBe(false);
    expect(parseRequest({ connectivity_test: true, prompt: "x" }).ok).toBe(false);
  });
  it("unexpected fields are rejected everywhere", () => {
    expect(parseRequest({ product: PRODUCT, sku: "AL112" }).ok).toBe(false);
    expect(parseRequest({ product: { ...PRODUCT, sku: "AL112" } }).ok).toBe(false);
    expect(parseRequest({ product: PRODUCT, images: [{ ...IMG, url: "https://x" }] }).ok).toBe(false);
    expect(parseRequest({ connectivity_test: "yes", product: PRODUCT }).ok).toBe(false);
  });
  it("needs a product with a name otherwise", () => {
    expect(parseRequest({}).ok).toBe(false);
    expect(parseRequest({ product: { description_en: "x" } }).ok).toBe(false);
    expect(parseRequest("nope").ok).toBe(false);
    expect(parseRequest([]).ok).toBe(false);
  });
  it("a normal enhancement request still validates (connectivity_test false or absent)", () => {
    expect(parseRequest({ product: PRODUCT }).ok).toBe(true);
    const p = parseRequest({ connectivity_test: false, product: { ...PRODUCT, weight_g: 2, length_cm: 40 }, images: [IMG] });
    expect(p.ok && p.req.connectivity_test).toBe(false);
    expect(p.ok && p.req.images).toHaveLength(1);
  });
  it("bounds name, description and numbers", () => {
    expect(parseRequest({ product: { name: "a".repeat(LIMITS.name + 1), description_en: "" } }).ok).toBe(false);
    expect(parseRequest({ product: { name: "a", description_en: "b".repeat(LIMITS.description + 1) } }).ok).toBe(false);
    expect(parseRequest({ product: { name: "a", description_en: "", weight_g: -1 } }).ok).toBe(false);
    expect(parseRequest({ product: { name: "a", description_en: "", weight_g: "abc" } }).ok).toBe(false);
  });
  it("limits images by count, type, encoding and size", () => {
    expect(parseRequest({ product: PRODUCT, images: [IMG, IMG] }).ok).toBe(false);
    expect(parseRequest({ product: PRODUCT, images: [{ ...IMG, mime_type: "image/gif" }] }).ok).toBe(false);
    expect(parseRequest({ product: PRODUCT, images: [{ ...IMG, data_base64: "not base64!" }] }).ok).toBe(false);
    const big = "A".repeat(Math.ceil((LIMITS.image_bytes + 10) / 3) * 4);
    expect(base64Bytes(big)).toBeGreaterThan(LIMITS.image_bytes);
    expect(parseRequest({ product: PRODUCT, images: [{ ...IMG, data_base64: big }] }).ok).toBe(false);
  });
});

describe("description writer (owner 2026-10-30/31)", () => {
  it("accepts the Edit product fields, trimmed, and passes them to the prompt", () => {
    const p = parseRequest({ product: { ...PRODUCT, metal: " PT900 ", brand: "Tiffany & Co.", condition: "Preloved", size: "40cm, 45cm", stone: "Diamond" } });
    if (!p.ok) throw new Error(p.message);
    expect(p.req.product).toMatchObject({ metal: "PT900", brand: "Tiffany & Co.", condition: "Preloved", size: "40cm, 45cm", stone: "Diamond" });
    const text = String((buildBody(p.req) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts[0].text);
    for (const line of ["Metal: PT900", "Brand: Tiffany & Co.", "Condition: Preloved", "Size: 40cm, 45cm", "Stone: Diamond"]) expect(text).toContain(line);
  });
  it("empty optional fields are left out of the prompt", () => {
    const p = parseRequest({ product: { ...PRODUCT, metal: " ", brand: "" } });
    if (!p.ok) throw new Error(p.message);
    expect(p.req.product.metal).toBeUndefined();
    expect(String((buildBody(p.req) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts[0].text)).not.toContain("Metal:");
  });
  it("rejects origin (never sent), a bad condition, non-text and over-long fields", () => {
    expect(parseRequest({ product: { ...PRODUCT, origin: "JAPAN" } }).ok).toBe(false);
    expect(parseRequest({ product: { ...PRODUCT, condition: "Used" } }).ok).toBe(false);
    expect(parseRequest({ product: { ...PRODUCT, metal: 18 } }).ok).toBe(false);
    expect(parseRequest({ product: { ...PRODUCT, brand: "b".repeat(LIMITS.short + 1) } }).ok).toBe(false);
    expect(parseRequest({ product: { ...PRODUCT, size: "s".repeat(LIMITS.details + 1) } }).ok).toBe(false);
  });
  it("the instruction asks for the approved shape and forbids the risky claims", () => {
    const text = String((buildBody(test()) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts[0].text);
    expect(text).toMatch(/60-90 words/);
    expect(text).toMatch(/Lovely for: /);
    expect(text).toMatch(/ONLY if the facts say Condition: Preloved/);
    expect(text).toMatch(/never mention Japan or Tokyo/);
    expect(text).toMatch(/never put a country or nationality before \\"gold\\"|never put a country or nationality before "gold"/);
    expect(text).toMatch(/layaway/);
  });
});

describe("request sent to Google", () => {
  it("is the verified endpoint and model, with the key in a header and never in the URL", async () => {
    expect(GEMINI_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    const f = fetchOk(okJson());
    await callGemini(test(), KEY, f);
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect(url).not.toContain("key=");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(init.method).toBe("POST");
  });
  it("carries only the fixture text, a bounded output, low thinking and no image by default", () => {
    const body = buildBody(test()) as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(1);
    expect(String(parts[0].text)).toContain("K18 Yellow Gold Necklace");
    expect(String(parts[0].text)).toContain("2g");
    expect(body.generationConfig.maxOutputTokens).toBe(LIMITS.max_output_tokens);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });
  it("an image goes in as inline_data before the text (enhancement requests only)", () => {
    const p = parseRequest({ product: PRODUCT, images: [IMG] });
    if (!p.ok) throw new Error(p.message);
    const parts = (buildBody(p.req) as { contents: { parts: Record<string, unknown>[] }[] }).contents[0].parts;
    expect(parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
    expect(parts).toHaveLength(2);
  });
  it("makes exactly one request, no retry, even on failure", async () => {
    const f = fetchOk({}, 503);
    await callGemini(test(), KEY, f);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("result", () => {
  it("success is structured with the model, text and token usage", async () => {
    const r = await callGemini(test(), KEY, fetchOk(okJson()));
    expect(r).toMatchObject({
      ok: true, connected: true, model: GEMINI_MODEL, addition: "Layer it with a white tee.",
      image_processed: false, error_category: null,
      usage: { prompt_tokens: 120, output_tokens: 30, thoughts_tokens: 40, total_tokens: 190 },
    });
  });
  it("image_processed is true only when an image was actually sent", async () => {
    const withImg = parseRequest({ product: PRODUCT, images: [IMG] });
    if (!withImg.ok) throw new Error();
    expect((await callGemini(withImg.req, KEY, fetchOk(okJson()))).image_processed).toBe(true);
    expect((await callGemini(test(), KEY, fetchOk(okJson()))).image_processed).toBe(false);
  });
  it("maps Google errors to categories without echoing the body", async () => {
    const leaky = { error: { message: `bad key ${KEY} in request` } };
    for (const [status, cat] of [[429, "rate_limited"], [403, "auth_or_access"], [401, "auth_or_access"], [400, "bad_request"], [503, "upstream_unavailable"], [402, "quota_or_billing"]] as const) {
      const r = await callGemini(test(), KEY, fetchOk(leaky, status));
      expect(r.ok).toBe(false);
      expect(r.error_category).toBe(cat);
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
    expect(categorizeStatus(418).error_category).toBe("unexpected_response");
  });
  it("blocked and empty responses are reported, not treated as success", () => {
    expect(parseResponse({ promptFeedback: { blockReason: "SAFETY" } }, false).error_category).toBe("blocked");
    expect(parseResponse({ candidates: [{ finishReason: "SAFETY" }] }, false).error_category).toBe("blocked");
    expect(parseResponse({ candidates: [{ content: { parts: [{ text: "  " }] }, finishReason: "STOP" }] }, false).error_category).toBe("empty_response");
    expect(parseResponse({}, false).ok).toBe(false);
  });
  it("a network failure and a timeout are separate categories", async () => {
    const down = vi.fn(async () => { throw new TypeError(`fetch failed ${KEY}`); }) as unknown as typeof fetch;
    const r = await callGemini(test(), KEY, down);
    expect(r.error_category).toBe("network");
    expect(JSON.stringify(r)).not.toContain(KEY);
    vi.useFakeTimers();
    const hang = vi.fn((_u: unknown, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
    const p = callGemini(test(), KEY, hang);
    await vi.advanceTimersByTimeAsync(LIMITS.timeout_ms + 1);
    expect((await p).error_category).toBe("timeout");
    vi.useRealTimers();
  });
  it("estimates paid-tier cost from the real token counts at the verified price", () => {
    // (120 * 0.75 + (30 + 40) * 3.75) / 1e6
    expect(estimateCostUsd({ prompt_tokens: 120, output_tokens: 30, thoughts_tokens: 40, total_tokens: 190 })).toBeCloseTo(0.0003525, 9);
  });
});

/** The real pipeline, with auth, the secret and fetch injected. */
function harness(over: Partial<EnhanceDeps> & { allowed?: boolean; signedIn?: boolean } = {}) {
  const getApiKey = vi.fn(() => KEY);
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(okJson()), { status: 200 }));
  const requireAuth = vi.fn(async () => (over.signedIn === false
    ? new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    : { user: { id: "u1" }, isService: false }));
  const requirePermission = vi.fn(async (_c: unknown, key: string) =>
    over.allowed === false ? new Response(JSON.stringify({ error: "Access denied", key }), { status: 403 }) : null);
  const deps: EnhanceDeps = {
    requireAuth, requirePermission, getApiKey,
    fetchImpl: fetchImpl as unknown as typeof fetch, ...over,
  };
  const call = (body: unknown, init: RequestInit = {}) => handleEnhance(
    new Request("https://x.test/gemini-product-enhance", {
      method: "POST", headers: { Authorization: "Bearer t" },
      body: typeof body === "string" ? body : JSON.stringify(body), ...init,
    }), deps);
  return { call, getApiKey, fetchImpl, requireAuth, requirePermission };
}

describe("entrypoint pipeline (mocked auth and fetch)", () => {
  it("a valid fictional text-only connectivity request succeeds and sends the exact fixture", async () => {
    const h = harness();
    const res = await h.call({ connectivity_test: true });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, connected: true, model: GEMINI_MODEL, image_processed: false });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GEMINI_ENDPOINT);
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual(buildBody({ product: FIXTURE, images: [], connectivity_test: true }));
    expect(sent.contents[0].parts).toHaveLength(1);
    const prompt = sent.contents[0].parts[0].text as string;
    expect(prompt).toContain("Product: K18 Yellow Gold Necklace");
    expect(prompt).toContain("Weight: 2g");
    expect(prompt).toContain("Length: 40cm");
    expect(prompt).toContain("Existing description (keep as it is, do not repeat): K18 gold necklace, 40cm, 2.0g.");
  });
  it.each([
    ["an image", { connectivity_test: true, images: [IMG] }],
    ["real product data", { connectivity_test: true, product: { name: "AL112", description_en: "real" } }],
    ["replacement fixture text", { connectivity_test: true, fixture: "text" }],
    ["an unexpected field", { connectivity_test: true, sku: "AL112" }],
    ["a non-boolean flag", { connectivity_test: "true", product: PRODUCT }],
    ["malformed JSON", "{not json"],
    ["an empty body", ""],
  ])("an invalid request (%s) returns 400 without reading the secret or calling Gemini", async (_n, body) => {
    const h = harness();
    const res = await h.call(body);
    expect(res.status).toBe(400);
    expect(h.getApiKey).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("a normal enhancement request still works end to end, image included", async () => {
    const h = harness();
    const res = await h.call({ product: PRODUCT, images: [IMG] });
    expect(res.status).toBe(200);
    expect((await res.json()).image_processed).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("a request with no session is refused before the body, the secret or Gemini", async () => {
    const h = harness({ signedIn: false });
    const res = await h.call({ connectivity_test: true });
    expect(res.status).toBe(401);
    expect(h.requirePermission).not.toHaveBeenCalled();
    expect(h.getApiKey).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("a signed-in user without manage_website_catalog gets 403 and nothing else happens", async () => {
    const h = harness({ allowed: false });
    const res = await h.call({ connectivity_test: true });
    expect(res.status).toBe(403);
    expect(h.requirePermission).toHaveBeenCalledWith(expect.anything(), "manage_website_catalog");
    expect(h.getApiKey).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("only POST is served", async () => {
    const h = harness();
    const res = await handleEnhance(new Request("https://x.test/", { method: "GET" }), {
      requireAuth: h.requireAuth, requirePermission: h.requirePermission, getApiKey: h.getApiKey,
    });
    expect(res.status).toBe(405);
    expect(h.requireAuth).not.toHaveBeenCalled();
  });
  it("a missing secret is a safe 503 and Gemini is not called", async () => {
    const h = harness({ getApiKey: () => undefined });
    const res = await h.call({ connectivity_test: true });
    expect(res.status).toBe(503);
    expect((await res.json()).error_category).toBe("not_configured");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("an oversized body is refused before parsing", async () => {
    const h = harness();
    const res = await h.call("x".repeat(LIMITS.body_chars + 1));
    expect(res.status).toBe(413);
    expect(h.getApiKey).not.toHaveBeenCalled();
  });
  it("Google failures reach the caller as categories, with no key, product text or Google body", async () => {
    const leak = { error: { message: `key ${KEY} product K18 Yellow Gold Necklace` } };
    for (const status of [429, 403, 500, 400]) {
      const h = harness({ fetchImpl: fetchOk(leak, status) });
      const res = await h.call({ connectivity_test: true });
      const text = await res.text();
      expect(res.ok).toBe(false);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("K18 Yellow Gold Necklace");
      expect(text).not.toContain("Google");
    }
  });
  it("the key never appears in a successful response, the Gemini URL or the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const res = await h.call({ connectivity_test: true });
    expect(await res.text()).not.toContain(KEY);
    expect(String((h.fetchImpl.mock.calls as unknown as [string][])[0][0])).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
    log.mockRestore();
  });
});

describe("wiring (source-anchored)", () => {
  const index = code(src("supabase/functions/gemini-product-enhance/index.ts"));
  const handler = code(src("supabase/functions/_shared/gemini-enhance-handler.ts"));
  const lib = code(src("supabase/functions/_shared/gemini-enhance.ts"));

  it("the deployed entrypoint passes the real auth, the real permission gate and the env secret", () => {
    expect(index).toContain('import { requireAuth, requirePermission } from "../_shared/handler.ts";');
    expect(index).toMatch(/handleEnhance\(req, \{\s*requireAuth,\s*requirePermission,/);
    expect(index).toContain('Deno.env.get("GEMINI_API_KEY")');
  });
  it("the pipeline order is auth, permission, body, validation, then the secret", () => {
    const at = (s: string) => handler.indexOf(s);
    expect(at("deps.requireAuth(req)")).toBeGreaterThan(-1);
    expect(at('deps.requirePermission(ctx, "manage_website_catalog")')).toBeGreaterThan(at("deps.requireAuth(req)"));
    expect(at("req.text()")).toBeGreaterThan(at("deps.requirePermission("));
    expect(at("parseRequest(raw)")).toBeGreaterThan(at("req.text()"));
    expect(at("deps.getApiKey()")).toBeGreaterThan(at("parseRequest(raw)"));
    expect(at("callGemini(")).toBeGreaterThan(at("deps.getApiKey()"));
  });
  it("is JWT-verified at the gateway", () => {
    expect(src("supabase/config.toml")).toMatch(/\[functions\.gemini-product-enhance\]\s+verify_jwt = true/);
  });
  it("writes nothing and reads no product or image storage: no database, storage or RPC call", () => {
    for (const s of [index, handler, lib]) {
      expect(s).not.toMatch(/\.from\(|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.storage|createClient/);
    }
  });
  it("never logs or returns the key, and keeps it out of the URL", () => {
    expect(handler).not.toMatch(/console\.\w+\([^)]*apiKey/);
    expect(handler).not.toMatch(/jsonResponse\([^)]*apiKey/);
    expect(lib).not.toMatch(/\?key=|key=\$\{/);
    expect(lib).toContain('"x-goog-api-key": apiKey');
  });
  it("is separate from the Lovable-powered translator", () => {
    expect(index + handler + lib).not.toContain("LOVABLE_API_KEY");
    expect(code(src("supabase/functions/translate-product-description/index.ts"))).not.toContain("GEMINI_API_KEY");
  });
  it("GEMINI_API_KEY appears nowhere in the browser bundle source", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap(n => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    const self = resolve(__dirname, "gemini-product-enhance.test.ts");
    const hits = walk(resolve(ROOT, "src")).filter(p => p !== self && readFileSync(p, "utf8").includes("GEMINI_API_KEY"));
    expect(hits).toEqual([]);
  });
});
