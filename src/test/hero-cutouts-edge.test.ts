import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachHeroCutouts, handleHeroCutouts, heroCutoutFor, heroCutoutPath, heroKeyOk, HERO_MAX_FILE_BYTES, HERO_PATH_RE,
  isAlreadyExists, isWebp, timingSafeEqual, validateHeroMeta,
} from "../../supabase/functions/_shared/hero-cutouts.ts";

/**
 * Hero cut-outs in the `website` edge function (hero auto cut-out PR 3 of 5,
 * docs/HERO-CUTOUTS.md). The SQL side is migration 20261009100000_hero_cutouts.sql.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const INDEX = "supabase/functions/website/index.ts";
const MODULE = "supabase/functions/_shared/hero-cutouts.ts";

const KEY = "k".repeat(64);
const SRC = "https://abc.supabase.co/storage/v1/object/public/promotions/website/products/r3110/1.jpg";
const SHA = "a".repeat(64);
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 1, 2, 3, 4, ...new TextEncoder().encode("WEBPVP8L"), 9, 9]);

const meta = (over: Record<string, unknown> = {}) => ({
  source_url: SRC, source_sha256: SHA, source_width: 418, source_height: 370, status: "needs_review",
  flags: ["low_res:418x370"], coverage: 0.41, width: 339, height: 204, model: "birefnet-general@epoch_244",
  toolchain: { rembg: "2.0.0" }, ...over,
});

type Rpc = (fn: string, args?: unknown) => { data: unknown; error: unknown };
function client(rpc: Rpc, upload?: (path: string) => { data: unknown; error: unknown }) {
  const calls = { rpc: [] as [string, unknown][], upload: [] as [string, unknown][], remove: [] as string[][] };
  const bucket = {
    upload: vi.fn(async (path: string, _b: unknown, opts: unknown) => {
      calls.upload.push([path, opts]);
      return upload ? upload(path) : { data: { path }, error: null };
    }),
    remove: vi.fn(async (paths: string[]) => { calls.remove.push(paths); return { data: [], error: null }; }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://abc.supabase.co/storage/v1/object/public/promotions/${path}` } }),
  };
  const c = {
    rpc: vi.fn(async (fn: string, args?: unknown) => { calls.rpc.push([fn, args]); return rpc(fn, args); }),
    storage: { from: vi.fn(() => bucket) },
  };
  return { c, calls };
}

/** A multipart body built by hand, the way the workflow's `requests` sends it
 *  (jsdom's FormData does not serialise through Node's Request). */
type Part = { name: string; value: Uint8Array | string; filename?: string; type?: string };
function multipart(parts: Part[]) {
  const boundary = "----herotest" + Math.random().toString(16).slice(2);
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += "\r\n";
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    chunks.push(enc.encode(head + "\r\n"), typeof p.value === "string" ? enc.encode(p.value) : p.value, enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { body.set(c, o); o += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
function postParts(parts: Part[], headers: Record<string, string> = {}) {
  const { body, contentType } = multipart(parts);
  return new Request("https://x/website/hero-cutouts", {
    method: "POST", body,
    headers: {
      "content-type": contentType, "content-length": String(body.length),
      "x-api-key": "site", "x-hero-cutout-key": KEY, ...headers,
    },
  });
}
async function post(m: unknown, file?: Uint8Array | string, headers: Record<string, string> = {}) {
  const parts: Part[] = [{ name: "meta", value: typeof m === "string" ? m : JSON.stringify(m), type: "application/json" }];
  if (typeof file === "string") parts.push({ name: "file", value: file });
  else if (file !== undefined) parts.push({ name: "file", value: file, filename: "cutout.webp", type: "image/webp" });
  return postParts(parts, headers);
}
const get = (key?: string) =>
  new Request("https://x/website/hero-cutouts", { headers: key === undefined ? {} : { "x-hero-cutout-key": key } });

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("auth: x-hero-cutout-key = HERO_CUTOUT_KEY, constant time, fail closed", () => {
  it("timingSafeEqual compares whole strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("an unset secret refuses everything, including an empty key", () => {
    expect(heroKeyOk("", "")).toBe(false);
    expect(heroKeyOk("", undefined)).toBe(false);
    expect(heroKeyOk(null, null)).toBe(false);
    expect(heroKeyOk(KEY, KEY)).toBe(true);
  });

  it.each([
    ["missing key", get(), KEY],
    ["wrong key", get("nope"), KEY],
    ["right key but secret unset", get(KEY), undefined],
    ["empty key and empty secret", get(""), ""],
  ])("%s → 401, no detail, nothing read", async (_n, req, secret) => {
    const { c, calls } = client(() => ({ data: [], error: null }));
    const res = await handleHeroCutouts(req, c, secret, "rid");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(calls.rpc).toEqual([]);
  });

  it("a POST with a wrong key is refused before the body is read or anything stored", async () => {
    const { c, calls } = client(() => ({ data: null, error: null }));
    const res = await handleHeroCutouts(await post(meta(), WEBP, { "x-hero-cutout-key": "wrong" }), c, KEY, "rid");
    expect(res.status).toBe(401);
    expect(calls.upload).toEqual([]);
    expect(calls.rpc).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("GET /hero-cutouts", () => {
  it("returns every record from hero_cutouts_known, no-store", async () => {
    const items = [{ source_url: SRC, source_sha256: SHA, status: "needs_review", coverage: 0.41 }];
    const { c, calls } = client(() => ({ data: items, error: null }));
    const res = await handleHeroCutouts(get(KEY), c, KEY, "rid");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ items });
    expect(calls.rpc).toEqual([["hero_cutouts_known", undefined]]);
  });

  it("an empty record is {items: []}", async () => {
    const { c } = client(() => ({ data: [], error: null }));
    expect(await (await handleHeroCutouts(get(KEY), c, KEY, "rid")).json()).toEqual({ items: [] });
  });

  it("other methods → 405", async () => {
    const { c } = client(() => ({ data: [], error: null }));
    const req = new Request("https://x/hero-cutouts", { method: "DELETE", headers: { "x-hero-cutout-key": KEY } });
    expect((await handleHeroCutouts(req, c, KEY, "rid")).status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
describe("POST /hero-cutouts: bad input → 422, nothing stored", () => {
  const cases: [string, unknown, Uint8Array | string | undefined, string, string][] = [
    ["approved", meta({ status: "approved" }), WEBP, "invalid_status", "status"],
    ["rejected", meta({ status: "rejected" }), WEBP, "invalid_status", "status"],
    ["unknown status", meta({ status: "great" }), WEBP, "invalid_status", "status"],
    ["meta not JSON", "{nope", WEBP, "invalid", "meta_json"],
    ["meta an array", "[]", WEBP, "invalid", "meta"],
    ["meta too large", meta({ toolchain: { x: "y".repeat(17000) } }), WEBP, "invalid", "meta_too_large"],
    ["upper-case sha", meta({ source_sha256: "A".repeat(64) }), WEBP, "invalid", "source_sha256"],
    ["short sha", meta({ source_sha256: "a".repeat(63) }), WEBP, "invalid", "source_sha256"],
    ["derived source", meta({ source_url: SRC.replace("/website/products/", "/website/derived/") }), WEBP, "invalid", "source_url"],
    ["other bucket", meta({ source_url: SRC.replace("/promotions/", "/avatars/") }), WEBP, "invalid", "source_url"],
    ["http source", meta({ source_url: SRC.replace("https", "http") }), WEBP, "invalid", "source_url"],
    ["source size 0", meta({ source_width: 0 }), WEBP, "invalid", "source_size"],
    ["flags not strings", meta({ flags: [1] }), WEBP, "invalid", "flags"],
    ["too many flags", meta({ flags: Array.from({ length: 51 }, (_, i) => `f${i}`) }), WEBP, "invalid", "flags"],
    ["coverage > 1", meta({ coverage: 1.2 }), WEBP, "invalid", "coverage"],
    ["no model", meta({ model: "" }), WEBP, "invalid", "model"],
    ["toolchain array", meta({ toolchain: [] }), WEBP, "invalid", "toolchain"],
    ["width 4001", meta({ width: 4001 }), WEBP, "invalid", "size"],
    ["height 0", meta({ height: 0 }), WEBP, "invalid", "size"],
    ["width not integer", meta({ width: 10.5 }), WEBP, "invalid", "size"],
    ["ok without a file", meta({ status: "ok" }), undefined, "invalid", "file_required"],
    ["failed with a file", meta({ status: "failed", width: null, height: null }), WEBP, "invalid", "file_forbidden_when_failed"],
    ["failed with a size", meta({ status: "failed" }), undefined, "invalid", "size_without_file"],
    ["file is a text field", meta(), "RIFF0000WEBP", "invalid", "file"],
    ["file not webp", meta(), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0]), "invalid", "file_not_webp"],
    ["file too short", meta(), new TextEncoder().encode("RIFF"), "invalid", "file_not_webp"],
  ];
  it.each(cases)("%s", async (_n, m, file, error, detail) => {
    const { c, calls } = client(() => ({ data: { result: "inserted", status: "needs_review" }, error: null }));
    const res = await handleHeroCutouts(await post(m, file), c, KEY, "rid");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error, detail });
    expect(calls.upload).toEqual([]);
    expect(calls.rpc).toEqual([]);
  });

  it("a file over 5 MB", async () => {
    const big = new Uint8Array(HERO_MAX_FILE_BYTES + 1);
    big.set(WEBP);
    const { c, calls } = client(() => ({ data: null, error: null }));
    const res = await handleHeroCutouts(await post(meta(), big), c, KEY, "rid");
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe("file_too_large");
    expect(calls.upload).toEqual([]);
  });

  it("a body over the limit is refused on its Content-Length, before parsing", async () => {
    const req = await post(meta(), WEBP, { "content-length": String(HERO_MAX_FILE_BYTES * 2) });
    const spy = vi.spyOn(req, "formData");
    const { c } = client(() => ({ data: null, error: null }));
    const res = await handleHeroCutouts(req, c, KEY, "rid");
    expect(res.status).toBe(422);
    expect((await res.json()).detail).toBe("body_too_large");
    expect(spy).not.toHaveBeenCalled();
  });

  it("no Content-Length / not multipart / two files", async () => {
    const { c } = client(() => ({ data: null, error: null }));
    const noLen = new Request("https://x/hero-cutouts", { method: "POST", body: "x", headers: { "x-hero-cutout-key": KEY } });
    expect((await (await handleHeroCutouts(noLen, c, KEY, "r")).json()).detail).toBe("content_length_required");
    const json = new Request("https://x/hero-cutouts", {
      method: "POST", body: "{}", headers: { "x-hero-cutout-key": KEY, "content-type": "application/json", "content-length": "2" },
    });
    expect((await (await handleHeroCutouts(json, c, KEY, "r")).json()).detail).toBe("multipart_required");
    const two = postParts([
      { name: "meta", value: JSON.stringify(meta()) },
      { name: "file", value: WEBP, filename: "a.webp", type: "image/webp" },
      { name: "file", value: WEBP, filename: "b.webp", type: "image/webp" },
    ]);
    expect((await (await handleHeroCutouts(two, c, KEY, "r")).json()).detail).toBe("fields");
  });
});

// ---------------------------------------------------------------------------
describe("POST /hero-cutouts: record", () => {
  it("uploads to the content-addressed path (upsert:false) and records it", async () => {
    const { c, calls } = client(() => ({ data: { result: "inserted", status: "needs_review" }, error: null }));
    const res = await handleHeroCutouts(await post({ ...meta(), cutout_path: "evil", extra: 1 }, WEBP), c, KEY, "rid");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "inserted", status: "needs_review" });
    const path = await heroCutoutPath(WEBP, SRC);
    expect(path).toMatch(HERO_PATH_RE);
    expect(calls.upload).toEqual([[path, { contentType: "image/webp", cacheControl: "31536000", upsert: false }]]);
    expect(c.storage.from).toHaveBeenCalledWith("promotions");
    // The record gets exactly the validated fields plus OUR path — a path or
    // unknown key sent in meta never reaches SQL.
    expect(calls.rpc).toEqual([["hero_cutout_record", { p: { ...meta(), cutout_path: path } }]]);
    expect(calls.remove).toEqual([]);
  });

  it("a failed run records no file", async () => {
    const { c, calls } = client(() => ({ data: { result: "inserted", status: "failed" }, error: null }));
    const m = meta({ status: "failed", width: null, height: null, flags: ["api_error:empty_mask"] });
    const res = await handleHeroCutouts(await post(m), c, KEY, "rid");
    expect(res.status).toBe(200);
    expect(calls.upload).toEqual([]);
    expect((calls.rpc[0][1] as { p: Record<string, unknown> }).p.cutout_path).toBeNull();
  });

  it("IDEMPOTENT: the same unchanged source again → unchanged, the stored file is kept", async () => {
    // Second run, same bytes: storage says the object exists (same path =
    // same bytes), the record says unchanged. Nothing is deleted: that file
    // is the record's own.
    const { c, calls } = client(
      () => ({ data: { result: "unchanged", status: "needs_review" }, error: null }),
      () => ({ data: null, error: { message: "The resource already exists", statusCode: "409", error: "Duplicate" } }),
    );
    const res = await handleHeroCutouts(await post(meta(), WEBP), c, KEY, "rid");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: "unchanged", status: "needs_review" });
    expect(calls.remove).toEqual([]);
  });

  it("unchanged source but new bytes → the new upload is removed, the record keeps its old file", async () => {
    const { c, calls } = client(() => ({ data: { result: "unchanged", status: "approved" }, error: null }));
    const res = await handleHeroCutouts(await post(meta(), WEBP), c, KEY, "rid");
    expect(await res.json()).toEqual({ result: "unchanged", status: "approved" });
    expect(calls.remove).toEqual([[await heroCutoutPath(WEBP, SRC)]]);
  });

  it("unknown_photo → 422 and the upload is removed", async () => {
    const { c, calls } = client(() => ({ data: { error: "unknown_photo" }, error: null }));
    const res = await handleHeroCutouts(await post(meta(), WEBP), c, KEY, "rid");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("unknown_photo");
    expect(calls.remove).toHaveLength(1);
  });

  it("SQL exception → 500 record_failed, upload removed, the key never logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { c, calls } = client(() => ({ data: null, error: { code: "P0001", message: "hero_cutout_record: boom" } }));
    const res = await handleHeroCutouts(await post(meta(), WEBP), c, KEY, "rid");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "record_failed", request_id: "rid" });
    expect(calls.remove).toHaveLength(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it("an upload error that is not a duplicate → 500, nothing recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { c, calls } = client(() => ({ data: null, error: null }), () => ({ data: null, error: { message: "bucket gone", statusCode: "500" } }));
    const res = await handleHeroCutouts(await post(meta(), WEBP), c, KEY, "rid");
    expect(res.status).toBe(500);
    expect(calls.rpc).toEqual([]);
  });

  it("an unexpected RPC answer → 500 and cleanup", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { c, calls } = client(() => ({ data: { ok: true }, error: null }));
    expect((await handleHeroCutouts(await post(meta(), WEBP), c, KEY, "rid")).status).toBe(500);
    expect(calls.remove).toHaveLength(1);
  });

  it("helpers", async () => {
    expect(isWebp(WEBP)).toBe(true);
    expect(isAlreadyExists({ message: "The resource already exists" })).toBe(true);
    expect(isAlreadyExists({ status: 409 })).toBe(true);
    expect(isAlreadyExists({ message: "nope", statusCode: "500" })).toBe(false);
    expect(validateHeroMeta(JSON.stringify(meta({ coverage: null, flags: undefined })), true).ok).toBe(true);
    // Same bytes + same source → the same path (why a duplicate means "same file").
    expect(await heroCutoutPath(WEBP, SRC)).toBe(await heroCutoutPath(new Uint8Array(WEBP), SRC));
    expect(await heroCutoutPath(WEBP, SRC)).not.toBe(await heroCutoutPath(WEBP, SRC + "x"));
  });
});

// ---------------------------------------------------------------------------
describe("read side: hero_cutout on every product_media entry, approved-only file URLs", () => {
  const url = (n: number) => `https://abc.supabase.co/storage/v1/object/public/promotions/website/p/${n}.jpg`;
  const P = `website/derived/hero/${"b".repeat(32)}/${"c".repeat(8)}/cutout.webp`;
  const products = () => [
    { id: "1", product_variants: [{ product_media: [{ url: url(1), alt: null, sort: 0 }, { url: url(2), alt: null, sort: 1 }] }] },
    { id: "2", product_variants: [{ product_media: [{ url: url(3), alt: null, sort: 0 }, { url: url(1), alt: "dup", sort: 1 }] },
                                  { product_media: [{ url: url(4), alt: null, sort: 0 }, { url: url(5), alt: null, sort: 1 }] }] },
  ];
  const rows = [
    { source_url: url(1), hero_cutout: { status: "approved", path: P, width: 339, height: 204 } },
    { source_url: url(2), hero_cutout: { status: "held" } },
    { source_url: url(3), hero_cutout: { status: "rejected" } },
    // A malformed approved row never yields a file URL.
    { source_url: url(5), hero_cutout: { status: "approved", path: "website/elsewhere.webp", width: 1, height: 1 } },
  ];

  it("maps the four states with ONE deduplicated call", async () => {
    const ps = products();
    const { c, calls } = client(() => ({ data: rows, error: null }));
    await attachHeroCutouts(c, ps);
    expect(calls.rpc).toEqual([["hero_cutouts_for_site", { p_urls: [url(1), url(2), url(3), url(4), url(5)] }]]);
    const m = ps.flatMap((p) => p.product_variants.flatMap((v) => v.product_media)) as Record<string, unknown>[];
    const approved = { status: "approved", url: `https://abc.supabase.co/storage/v1/object/public/promotions/${P}`, width: 339, height: 204 };
    expect(m.map((x) => x.hero_cutout)).toEqual([approved, { status: "held" }, { status: "rejected" }, approved, null, null]);
    // Existing fields untouched, and only approved ever carries a url.
    expect(m.map((x) => [x.url, x.alt, x.sort])).toEqual(
      [[url(1), null, 0], [url(2), null, 1], [url(3), null, 0], [url(1), "dup", 1], [url(4), null, 0], [url(5), null, 1]]);
    expect(m.filter((x) => (x.hero_cutout as { url?: string } | null)?.url).every((x) => (x.hero_cutout as { status: string }).status === "approved")).toBe(true);
    expect(m.every((x) => !("cutout" in x))).toBe(true);
  });

  it("an RPC error (migration not run) → every entry null, the read goes on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ps = products();
    const { c } = client(() => ({ data: null, error: { code: "42883", message: "function does not exist" } }));
    await expect(attachHeroCutouts(c, ps)).resolves.toBeUndefined();
    expect(ps.flatMap((p) => p.product_variants.flatMap((v) => v.product_media)).map((x) => (x as Record<string, unknown>).hero_cutout))
      .toEqual([null, null, null, null, null, null]);
  });

  it("an RPC that throws → every entry null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ps = products();
    const c = { rpc: vi.fn(async () => { throw new Error("network"); }), storage: { from: vi.fn() } };
    await attachHeroCutouts(c, ps);
    expect((ps[0].product_variants[0].product_media[0] as Record<string, unknown>).hero_cutout).toBeNull();
  });

  it("no media → no call; null products are skipped", async () => {
    const { c, calls } = client(() => ({ data: [], error: null }));
    await attachHeroCutouts(c, [null, { id: "x", product_variants: [{ product_media: [] }] }]);
    expect(calls.rpc).toEqual([]);
  });

  it("heroCutoutFor never builds a URL for anything but a well-formed approved row", () => {
    const pub = vi.fn((p: string) => `u/${p}`);
    expect(heroCutoutFor({ status: "held", path: P }, pub)).toEqual({ status: "held" });
    expect(heroCutoutFor({ status: "approved", path: P, width: 0, height: 5 }, pub)).toBeNull();
    expect(heroCutoutFor(null, pub)).toBeNull();
    expect(heroCutoutFor({ status: "ok" }, pub)).toBeNull();
    expect(pub).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("source: wiring and boundaries", () => {
  const index = src(INDEX);
  const mod = src(MODULE);
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("every catalogue read attaches hero_cutout (the four shapeProduct callers)", () => {
    expect(code(index).match(/shapeProduct\(/g)).toHaveLength(5); // 4 calls + the definition
    expect(code(index).match(/await attachHeroCutouts\(supabase, /g)).toHaveLength(4);
  });

  it("the route sits behind the global x-api-key check", () => {
    const c = code(index);
    expect(c.indexOf('Deno.env.get("WEBSITE_API_KEY")')).toBeGreaterThan(0);
    expect(c.indexOf("handleHeroCutouts(req, supabase")).toBeGreaterThan(c.indexOf('Deno.env.get("WEBSITE_API_KEY")'));
    expect(c).toContain('Deno.env.get("HERO_CUTOUT_KEY")');
  });

  it("only the three service-role functions; never approve/reject, never Photoroom", () => {
    const rpcs = [...code(mod).matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(["hero_cutout_record", "hero_cutouts_for_site", "hero_cutouts_known"]);
    for (const s of [code(mod), code(index)]) {
      expect(s).not.toContain("set_hero_cutout_mode");
      expect(s).not.toContain("website_media_cutouts");
      expect(s).not.toContain("review_hero_cutout");
    }
    expect(code(mod)).not.toMatch(/\.from\("(?!promotions)/); // storage only, the promotions bucket
    expect(code(mod)).not.toMatch(/headers\.entries|console\.[a-z]+\([^)]*req\.headers/);
  });
});
