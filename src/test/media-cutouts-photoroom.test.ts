import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkCutout, describeFlag, HOLE_REVIEW_SHARE, interiorHoles, UNCERTAINTY_REVIEW, type AlphaImage, type RgbImage,
} from "../../supabase/functions/_shared/cutout-qa.ts";
import {
  DEFAULT_PRICE_USD, estimateCost, PHOTOROOM_URL, photoroomForm, photoroomProvider, ProviderError, readPriceSetting,
  readProviderSetting, readUncertainty,
} from "../../supabase/functions/_shared/cutout-provider.ts";
import { isOwnDerivedUrl, syncResultPath, TICK } from "../../supabase/functions/_shared/media-cutout-rules.ts";

/**
 * Background removal → Photoroom + the interior-hole check (docs/MEDIA-CUTOUTS.md,
 * owner decision 2026-09-27 after "Test 30"). The SQL is proven by
 * docs/sql/20261007_media_cutout_photoroom_local_tests.sql.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const WORKER = "supabase/functions/media-cutout-worker/index.ts";
const MIGRATION = "supabase/migrations/20261007100000_media_cutout_photoroom.sql";

// ---------------------------------------------------------------------------
// The REAL fal.ai results of "Test 30" (2026-09-27), read-only from their
// public Storage URLs by development/cutout-fal-fixtures.ts: the stored
// master's alpha at 512 px and the original on the QA grid.
// ---------------------------------------------------------------------------
type Fx = { sourceWidth: number; sourceHeight: number; alphaWidth: number; alphaHeight: number; alpha: string;
            rgb: string; rgbWidth: number; rgbHeight: number; originalUrl: string; masterUrl: string };
const LIVE = JSON.parse(src("src/test/fixtures/media-cutouts-fal-live.json")) as Record<string, Fx>;
const REMBG = JSON.parse(src("src/test/fixtures/media-cutouts.json")) as Record<string, Omit<Fx, "rgb"> & { rgb: string | null }>;
const unzip = (b64: string) => new Uint8Array(gunzipSync(Buffer.from(b64, "base64")));
const live = (name: string, providerUncertainty: number | null = null) => {
  const f = LIVE[name];
  return checkCutout({
    cutout: { width: f.alphaWidth, height: f.alphaHeight, alpha: unzip(f.alpha) },
    sourceWidth: f.sourceWidth, sourceHeight: f.sourceHeight,
    original: { width: f.rgbWidth, height: f.rgbHeight, rgb: unzip(f.rgb) },
    providerUncertainty,
  });
};

describe("interior holes — the fal.ai results the owner rejected", () => {
  it("the fixtures are the stored Test 30 masters", () => {
    expect(LIVE.c1395.masterUrl).toMatch(/\/promotions\/website\/derived\/f080dfe5babf94348c63a77ccf6cb2a6\/r1\/master\.png$/);
    expect(LIVE.c0983.masterUrl).toMatch(/\/derived\/f1cc6f39a0b09fb9417aa0139f96ed8f\/r1\/master\.png$/);
    expect(LIVE.r3341.masterUrl).toMatch(/\/derived\/8a23a7a0ccf7ab424f4281007b84eed3\/r1\/master\.png$/);
  });

  it("C1395 — part of the dark dial erased: held (was auto_fixed)", () => {
    const qa = live("c1395");
    expect(qa.status).toBe("needs_review");
    expect(qa.flags).toContain("edge_touch:bottom,left,right");
    const hole = qa.flags.find((f) => f.startsWith("interior_hole:"));
    expect(hole).toBeDefined();
    expect(Number(hole!.split(":")[1])).toBeGreaterThan(0.04);
    expect(qa.heroUsable).toBe(false);
  });

  it("C0983 — a chunk of the WHITE dial erased: held, although the dial is backdrop-coloured", () => {
    const qa = live("c0983");
    expect(qa.status).toBe("needs_review");
    expect(qa.flags.some((f) => f.startsWith("interior_hole:"))).toBe(true);
    // detail_loss could not see it: the white dial is within ΔE 12 of the white backdrop.
    expect(qa.detailKept).toBeGreaterThan(0.9);
  });

  it("C0983's second run (dial intact) stays auto-fixed", () => {
    expect(live("c0983_r2")).toMatchObject({ status: "auto_fixed", flags: ["edge_touch:top,bottom"] });
  });

  it("R3341 stays OK; R7828, AL3 and AL112 (open heart — a REAL opening) are not held for holes", () => {
    for (const n of ["r3341", "r7828", "al3", "al112"]) {
      const qa = live(n);
      expect(qa.status, n).toBe("ok");
      expect(qa.flags, n).toEqual([]);
    }
  });

  it("AL123 stays held for its inset, not for its openings", () => {
    const qa = live("al123");
    expect(qa.status).toBe("needs_review");
    expect(qa.flags).toEqual(["extra_objects:1"]);
  });

  it("without the original on the grid, sizeable openings are held as unchecked (review is the safe side)", () => {
    const f = REMBG.al3;
    const qa = checkCutout({
      cutout: { width: f.alphaWidth, height: f.alphaHeight, alpha: unzip(f.alpha) },
      sourceWidth: f.sourceWidth, sourceHeight: f.sourceHeight, original: null,
    });
    expect(qa.status).toBe("needs_review");
    expect(qa.flags.some((f) => f.startsWith("interior_hole_unchecked:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rule on drawn shapes.
// ---------------------------------------------------------------------------
function ring(w: number, h: number, outer: number, inner: number) {
  const piece = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - w / 2, y - h / 2);
    if (d <= outer && d > inner) piece[y * w + x] = 1;
  }
  return piece;
}
function photo(w: number, h: number, colourAt: (x: number, y: number) => [number, number, number]): RgbImage {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(colourAt(x, y), (y * w + x) * 3);
  return { width: w, height: h, rgb };
}
const W = 100, H = 100;
const inDisc = (x: number, y: number, r: number) => Math.hypot(x - W / 2, y - H / 2) <= r;

describe("interiorHoles", () => {
  it("a ring's centre that shows the backdrop is a real opening", () => {
    const orig = photo(W, H, (x, y) => (inDisc(x, y, 40) && !inDisc(x, y, 20) ? [200, 160, 60] : [250, 250, 250]));
    const r = interiorHoles(ring(W, H, 40, 20), W, H, orig);
    expect(r.holeShare).toBeGreaterThan(0.2);
    expect(r.erasedShare).toBe(0);
  });

  it("(a) a hole where the photo shows something else than the backdrop is an erasure (C1395's dark dial)", () => {
    const orig = photo(W, H, (x, y) => (inDisc(x, y, 40) ? [40, 40, 40] : [250, 250, 250]));
    expect(interiorHoles(ring(W, H, 40, 10), W, H, orig).erasedShare).toBeGreaterThan(0.05);
  });

  it("(b) a backdrop-coloured hole cut through a large surface of the same colour is an erasure (C0983's white dial)", () => {
    // White dial (r ≤ 34) inside a gold bezel; the cut-out lost r ≤ 10 of the dial.
    const orig = photo(W, H, (x, y) => (inDisc(x, y, 34) ? [246, 244, 238] : inDisc(x, y, 40) ? [200, 160, 60] : [250, 250, 250]));
    expect(interiorHoles(ring(W, H, 40, 10), W, H, orig).erasedShare).toBeGreaterThan(0.05);
  });

  it("(b) needs the surface to carry on: a thin light rim round a big opening is not enough", () => {
    // Light metal only 3 px wide around a backdrop-coloured opening (a bracelet from the side).
    const orig = photo(W, H, (x, y) => (inDisc(x, y, 40) && !inDisc(x, y, 37) ? [240, 240, 240] : [250, 250, 250]));
    expect(interiorHoles(ring(W, H, 40, 37), W, H, orig).erasedShare).toBe(0);
  });

  it("pinholes under the size floor are ignored (pavé gaps)", () => {
    const piece = ring(W, H, 40, 0);
    piece[50 * W + 50] = 0; piece[50 * W + 51] = 0;
    const orig = photo(W, H, (x, y) => (inDisc(x, y, 40) ? [40, 40, 40] : [250, 250, 250]));
    expect(interiorHoles(piece, W, H, orig)).toEqual({ erasedShare: 0, holeShare: 0, unchecked: false });
  });

  it("the verdict threshold and the plain words", () => {
    expect(HOLE_REVIEW_SHARE).toBe(0.004);
    expect(describeFlag("interior_hole:0.054")).toMatch(/erased from inside it \(5\.4% of the piece/);
    expect(describeFlag("interior_hole_unchecked:0.010")).toMatch(/could not be compared/);
    expect(describeFlag("uncertain:0.62")).toMatch(/unsure of this photo \(uncertainty 0\.62\)/);
  });
});

describe("Photoroom's uncertainty score feeds the verdict", () => {
  const disc: AlphaImage = { width: 200, height: 200, alpha: new Uint8Array(200 * 200) };
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (Math.hypot(x - 100, y - 100) <= 60) disc.alpha[y * 200 + x] = 255;
  const base = { cutout: disc, sourceWidth: 1500, sourceHeight: 1500 };

  it(`>= ${UNCERTAINTY_REVIEW} holds the photo; below it or absent changes nothing`, () => {
    expect(checkCutout({ ...base, providerUncertainty: 0.62 })).toMatchObject({ status: "needs_review", flags: ["uncertain:0.62"] });
    expect(checkCutout({ ...base, providerUncertainty: 0.45 }).status).toBe("needs_review");
    expect(checkCutout({ ...base, providerUncertainty: 0.2 })).toMatchObject({ status: "ok", flags: [] });
    expect(checkCutout({ ...base, providerUncertainty: null })).toMatchObject({ status: "ok", flags: [] });
    expect(checkCutout(base).status).toBe("ok");
  });

  it("reads the header: 0–1 kept, -1 / missing / garbage → null", () => {
    expect(readUncertainty("0.1234")).toBe(0.1234);
    expect(readUncertainty("1")).toBe(1);
    expect(readUncertainty("-1")).toBeNull();
    expect(readUncertainty(null)).toBeNull();
    expect(readUncertainty("")).toBeNull();
    expect(readUncertainty("high")).toBeNull();
    expect(readUncertainty("1.5")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Photoroom adapter, mocked.
// ---------------------------------------------------------------------------
const PKEY = "sk_pr_live_1234567890abcdef1234";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const pngRes = (headers: Record<string, string> = {}) =>
  new Response(PNG, { status: 200, headers: { "content-type": "image/png", ...headers } });
const errRes = (status: number, detail = "nope") =>
  new Response(JSON.stringify({ detail, status_code: status, type: "error" }), { status, headers: { "content-type": "application/json" } });
const asFetch = (f: unknown) => f as typeof fetch;

describe("photoroomProvider (Remove Background API, Basic plan)", () => {
  it("POSTs the photo's bytes as multipart to /v1/segment with x-api-key; asks for a full-size transparent PNG, uncropped, no background", async () => {
    const f = vi.fn(async () => pngRes({ "x-uncertainty-score": "0.08" }));
    const out = await photoroomProvider(PKEY, asFetch(f)).remove(JPEG, { highDetail: false, contentType: "image/jpeg" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sdk.photoroom.com/v1/segment");
    expect(PHOTOROOM_URL).toBe(url);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(PKEY);
    // fetch sets the multipart boundary; a hand-set Content-Type breaks the request.
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain("content-type");
    const form = init.body as FormData;
    expect(form.get("format")).toBe("png");
    expect(form.get("channels")).toBe("rgba");
    expect(form.get("size")).toBe("full");
    expect(form.get("crop")).toBe("false");
    expect(form.get("bg_color")).toBeNull();
    expect(form.get("despill")).toBeNull();
    const file = form.get("image_file") as File;
    expect(file.name).toBe("photo.jpg");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG);
    expect(out).toEqual({ bytes: PNG, uncertainty: 0.08, model: "photoroom/v1/segment" });
  });

  it("names the upload after its type", () => {
    expect((photoroomForm(PNG, "image/png").get("image_file") as File).name).toBe("photo.png");
    expect((photoroomForm(PNG, "image/webp").get("image_file") as File).name).toBe("photo.webp");
  });

  it("no uncertainty header (or -1) → null", async () => {
    expect((await photoroomProvider(PKEY, asFetch(async () => pngRes())).remove(JPEG, { highDetail: false })).uncertainty).toBeNull();
    expect((await photoroomProvider(PKEY, asFetch(async () => pngRes({ "x-uncertainty-score": "-1" })))
      .remove(JPEG, { highDetail: false })).uncertainty).toBeNull();
  });

  const failWith = async (fetchFn: unknown, timeoutMs?: number) =>
    photoroomProvider(PKEY, asFetch(fetchFn), timeoutMs).remove(JPEG, { highDetail: false }).then(() => null, (e) => e as ProviderError);

  it("400 (bad photo) — this photo only: not retried, the tick goes on", async () => {
    const e = await failWith(async () => errRes(400, "image_file is not an image"));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ status: 400, retryable: false, haltTick: false });
    expect(e!.message).toMatch(/photoroom: HTTP 400 .*image_file is not an image/);
  });

  it("429 rate limit — retried later AND the rest of the tick stops", async () => {
    expect(await failWith(async () => errRes(429))).toMatchObject({ status: 429, retryable: true, haltTick: true });
  });

  it("402 no credits / 403 bad key — account problems: retried later, the tick stops, never marked failed on the first try", async () => {
    expect(await failWith(async () => errRes(402, "No credits"))).toMatchObject({ status: 402, retryable: true, haltTick: true });
    expect(await failWith(async () => errRes(403))).toMatchObject({ status: 403, retryable: true, haltTick: true });
  });

  it("5xx — retried, the tick goes on", async () => {
    expect(await failWith(async () => errRes(503))).toMatchObject({ status: 503, retryable: true, haltTick: false });
  });

  it("timeout — 408, retried", async () => {
    const hang = (_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const e = await failWith(hang, 20);
    expect(e).toMatchObject({ status: 408, retryable: true });
    expect(e!.message).toMatch(/no answer within/);
  });

  it("a network failure is retried; a 200 that is not a PNG is refused", async () => {
    expect(await failWith(async () => { throw new TypeError("connection reset"); })).toMatchObject({ status: 503, retryable: true });
    expect(await failWith(async () => new Response(JSON.stringify({ base64img: "…" }), { status: 200, headers: { "content-type": "application/json" } })))
      .toMatchObject({ status: 502, retryable: true });
  });

  it("never lets the key into an error message", async () => {
    const e = await failWith(async () => errRes(403, `bad key ${PKEY}`));
    expect(e!.message).not.toContain(PKEY);
    expect(e!.message).toContain("[secret]");
  });
});

describe("provider setting and price", () => {
  it("the setting fails to Photoroom", () => {
    expect(readProviderSetting("fal")).toBe("fal");
    expect(readProviderSetting("replicate")).toBe("replicate");
    for (const v of ["photoroom", "FAL", "", null, undefined, 3, "bria"]) expect(readProviderSetting(v)).toBe("photoroom");
  });

  it("price: a number 0–10 (≤ 4 decimals), else the provider's list price", () => {
    expect(DEFAULT_PRICE_USD).toEqual({ photoroom: 0.02, fal: 0.036, replicate: null });
    expect(readPriceSetting("0.02", "photoroom")).toBe(0.02);
    expect(readPriceSetting("0.0250", "photoroom")).toBe(0.025);
    expect(readPriceSetting(0.05, "fal")).toBe(0.05);
    expect(readPriceSetting("lots", "photoroom")).toBe(0.02);
    expect(readPriceSetting("11", "fal")).toBe(0.036);
    expect(readPriceSetting(null, "replicate")).toBeNull();
  });

  it("estimates: the 36-photo re-test at Photoroom is $0.72; a 600 cap is $12", () => {
    expect(estimateCost(36, 0.02)).toBe(0.72);
    expect(estimateCost(600, 0.02)).toBe(12);
    expect(estimateCost(36, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Worker, migration, rules (source assertions; the function runs in Deno).
// ---------------------------------------------------------------------------
describe("worker: Photoroom path and speed", () => {
  const w = src(WORKER);
  const tick = w.slice(w.indexOf("async function tick("));

  it("the setting picks the provider; nothing is submitted without its key", () => {
    expect(tick).toContain('.eq("key", "media_cutout_provider")');
    expect(tick).toContain("pickProvider(env, providerName)");
    expect(tick).toMatch(/no provider configured \(\$\{PROVIDER_SECRET\[providerName\]\}/);
  });

  it("a sync result is stored under derived/, recorded in ONE call, and processed in the same tick", () => {
    expect(w).toContain('supabase.rpc("media_cutout_sync_result"');
    expect(w).toContain("syncResultPath(await sha256Hex(original), provider.name, requestId)");
    expect(tick.indexOf("media_cutout_submit_batch")).toBeLessThan(tick.indexOf("media_cutout_process_batch"));
    expect(syncResultPath("a".repeat(64), "photoroom", "r1")).toBe(`website/derived/${"a".repeat(32)}/photoroom-r1.png`);
    expect(isOwnDerivedUrl("https://x.supabase.co/storage/v1/object/public/promotions/website/derived/ab/photoroom-r1.png")).toBe(true);
    expect(isOwnDerivedUrl("https://v3.fal.media/files/out.png")).toBe(false);
  });

  it("the stored Photoroom result is the master — never uploaded twice; its uncertainty reaches the checks", () => {
    expect(w).toContain("const master = own ? null : storedMaster ?? await store(");
    expect(w).toMatch(/const doubt = storedMaster && \(extra as AnyRec \| null\)\?\.provider === "photoroom"/);
    expect(w).toContain("providerUncertainty: doubt == null ? null : Number(doubt)");
  });

  it("an account problem stops the tick's submissions", () => {
    expect(tick).toMatch(/if \(r instanceof ProviderError && r\.haltTick\) \{ halted = true;/);
  });

  it("speed: 12 a tick, 4 at a time, within the minute; each photo still gets its own invocation", () => {
    expect(TICK).toMatchObject({ submit: 12, submitParallel: 4, process: 12, processParallel: 4, budgetMs: 45_000 });
    expect(TICK.budgetMs).toBeLessThan(60_000);
    expect(TICK.submit * 1).toBeLessThanOrEqual(60); // Photoroom: 60 images a minute
    expect(w).toContain("inParallel((ready ?? []) as string[], TICK.processParallel");
    expect(w).toContain('body: JSON.stringify({ action: "process", source_url: url })');
  });
});

describe("migration 20261007100000_media_cutout_photoroom", () => {
  const sql = src(MIGRATION);
  it("md5-guards the two live functions it calls and redefines none", () => {
    expect(sql).toContain("IS DISTINCT FROM 'ca732b540ffce05c1ede53ea1317c1b2'");
    expect(sql).toContain("IS DISTINCT FROM 'd8ae98dfc64f5d6336ab7ad08b29c9e5'");
    for (const fn of ["media_cutout_submitted", "media_cutout_result_ready", "set_media_cutout_settings", "media_cutout_finish",
                      "guard_media_cutout_settings", "get_media_cutout_overview"]) {
      expect(sql, fn).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
    }
  });

  it("never writes the switch or the cap; seeds provider/price only when absent; guarded", () => {
    expect(sql).not.toMatch(/UPDATE public\.system_settings[^;]*media_cutout_mode/);
    expect(sql).not.toMatch(/app\.allow_media_cutout_settings_change/);
    expect(sql).toMatch(/VALUES \('media_cutout_provider', '"photoroom"'::jsonb,[\s\S]*?ON CONFLICT \(key\) DO NOTHING/);
    expect(sql).toMatch(/VALUES \('media_cutout_price_usd', '"0\.02"'::jsonb,[\s\S]*?ON CONFLICT \(key\) DO NOTHING/);
    expect(sql).toContain("CREATE TRIGGER trg_guard_media_cutout_provider_settings");
  });

  it("runs the worker every minute with the Vault key; the sync call is service-role only", () => {
    expect(sql).toContain("cron.schedule('media-cutout-worker', '* * * * *'");
    expect(sql).toContain("vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.media_cutout_sync_result\(text, text, text, text, text, numeric\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/PHOTOROOM_API_KEY'|sk_pr_/);
  });
});
