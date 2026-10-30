import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

describe("request validation", () => {
  it("a connectivity test always uses the fictional fixture and ignores any product sent", () => {
    const p = parseRequest({ connectivity_test: true, product: { name: "REAL PIECE", description_en: "secret" } });
    expect(p.ok && p.req.product).toEqual(FIXTURE);
    expect(FIXTURE.name).toBe("K18 Yellow Gold Necklace");
  });
  it("needs a product with a name otherwise", () => {
    expect(parseRequest({}).ok).toBe(false);
    expect(parseRequest({ product: { description_en: "x" } }).ok).toBe(false);
    expect(parseRequest("nope").ok).toBe(false);
  });
  it("bounds name, description and numbers", () => {
    expect(parseRequest({ product: { name: "a".repeat(LIMITS.name + 1), description_en: "" } }).ok).toBe(false);
    expect(parseRequest({ product: { name: "a", description_en: "b".repeat(LIMITS.description + 1) } }).ok).toBe(false);
    expect(parseRequest({ product: { name: "a", description_en: "", weight_g: -1 } }).ok).toBe(false);
    expect(parseRequest({ product: { name: "a", description_en: "", weight_g: "abc" } }).ok).toBe(false);
  });
  it("limits images by count, type, encoding and size", () => {
    const img = { mime_type: "image/png", data_base64: "AAAA" };
    expect(parseRequest({ connectivity_test: true, images: [img] }).ok).toBe(true);
    expect(parseRequest({ connectivity_test: true, images: [img, img] }).ok).toBe(false);
    expect(parseRequest({ connectivity_test: true, images: [{ ...img, mime_type: "image/gif" }] }).ok).toBe(false);
    expect(parseRequest({ connectivity_test: true, images: [{ ...img, data_base64: "not base64!" }] }).ok).toBe(false);
    const big = "A".repeat(Math.ceil((LIMITS.image_bytes + 10) / 3) * 4);
    expect(base64Bytes(big)).toBeGreaterThan(LIMITS.image_bytes);
    expect(parseRequest({ connectivity_test: true, images: [{ ...img, data_base64: big }] }).ok).toBe(false);
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
  it("an image goes in as inline_data before the text", () => {
    const p = parseRequest({ connectivity_test: true, images: [{ mime_type: "image/png", data_base64: "AAAA" }] });
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
    const withImg = parseRequest({ connectivity_test: true, images: [{ mime_type: "image/png", data_base64: "AAAA" }] });
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

describe("function wiring (source-anchored)", () => {
  const fn = code(src("supabase/functions/gemini-product-enhance/index.ts"));
  const lib = code(src("supabase/functions/_shared/gemini-enhance.ts"));

  it("authenticates and checks manage_website_catalog before it touches the secret or the body", () => {
    const auth = fn.indexOf("requireAuth(req)");
    const perm = fn.indexOf('requirePermission(ctx, "manage_website_catalog")');
    const body = fn.indexOf("req.text()");
    const secret = fn.indexOf('Deno.env.get("GEMINI_API_KEY")');
    expect(auth).toBeGreaterThan(-1);
    expect(perm).toBeGreaterThan(auth);
    expect(body).toBeGreaterThan(perm);
    expect(secret).toBeGreaterThan(body);
  });
  it("is JWT-verified at the gateway", () => {
    expect(src("supabase/config.toml")).toMatch(/\[functions\.gemini-product-enhance\]\s+verify_jwt = true/);
  });
  it("writes nothing: no database, storage or RPC call", () => {
    for (const s of [fn, lib]) expect(s).not.toMatch(/\.from\(|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.storage/);
  });
  it("never logs or returns the key, and keeps it out of the URL", () => {
    expect(fn).not.toMatch(/console\.\w+\([^)]*apiKey/);
    expect(fn).not.toMatch(/jsonResponse\([^)]*apiKey/);
    expect(lib).not.toMatch(/\?key=|key=\$\{/);
    expect(lib).toContain('"x-goog-api-key": apiKey');
  });
  it("is separate from the Lovable-powered translator", () => {
    expect(fn).not.toContain("LOVABLE_API_KEY");
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
