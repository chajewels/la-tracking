import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkCutout, describeFlag, downsampleAlpha, edgeTouches, findRegions, hazeShare, MIN_CATALOG_PX, MIN_HERO_PX,
  PUBLISHABLE_STATUSES, type AlphaImage,
} from "../../supabase/functions/_shared/cutout-qa.ts";
import {
  alphaBounds, applyKeepMask, composeIvory, CUTOUT_SIZES_PATH_A, fadeEdges, halve, IVORY, IVORY_FILL, ivoryPlacement,
  makeHeroCutout, type Rgba, trimPiece,
} from "../../supabase/functions/_shared/cutout-image.ts";
import {
  capLeft, derivedPaths, isCutoutSource, OWN_CUTOUT_RE, readCutoutCap, readCutoutMode, RETRY_BACKOFF_MINUTES, MAX_RETRIES,
  shouldRingCapBell, storagePathOf,
} from "../../supabase/functions/_shared/media-cutout-rules.ts";
import {
  falProvider, falRequestBody, isRetryableStatus, pickProvider, ProviderError, replicateProvider, scrub,
} from "../../supabase/functions/_shared/cutout-provider.ts";

/**
 * Automatic background removal, PR 1 (docs/MEDIA-CUTOUTS.md). The SQL is the
 * authority for the queue and is proven by docs/sql/20261005_media_cutouts_local_tests.sql
 * (keying across the Catalog's delete-reinsert, fail-to-off, cap + bell,
 * retries, staff decisions). This file pins the quality checks on REAL
 * BiRefNet output of the eight comps photos, the compositor, the provider
 * adapters, the TS mirror of the SQL rules, and the worker's gates.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const MIGRATION = "supabase/migrations/20261006100000_media_cutouts.sql";
const WORKER = "supabase/functions/media-cutout-worker/index.ts";

// ---------------------------------------------------------------------------
// Real photos. src/test/fixtures/media-cutouts.json: each comps photo's
// BiRefNet alpha (rembg birefnet-general, the model the owner validated 8/8)
// at 512 px, and for three of them the original on the QA grid. R3110 keeps
// its true 418 × 370; the two watches are rebuilt at their recorded 1440².
// ---------------------------------------------------------------------------
type Fx = { sourceWidth: number; sourceHeight: number; alphaWidth: number; alphaHeight: number; alpha: string;
            rgb: string | null; rgbWidth: number; rgbHeight: number };
const FIXTURES = JSON.parse(src("src/test/fixtures/media-cutouts.json")) as Record<string, Fx>;
const verdictOf = (name: string, allowPairs = false) => {
  const f = FIXTURES[name];
  return checkCutout({
    cutout: { width: f.alphaWidth, height: f.alphaHeight, alpha: new Uint8Array(gunzipSync(Buffer.from(f.alpha, "base64"))) },
    sourceWidth: f.sourceWidth, sourceHeight: f.sourceHeight,
    original: f.rgb ? { width: f.rgbWidth, height: f.rgbHeight, rgb: new Uint8Array(gunzipSync(Buffer.from(f.rgb, "base64"))) } : null,
    allowPairs,
  });
};

describe("quality checks on the eight real photos", () => {
  it("AL123 — the inset BACK photo is a second object: held, and only the main piece is kept", () => {
    const qa = verdictOf("al123");
    expect(qa.status).toBe("needs_review");
    expect(qa.flags).toContain("extra_objects:1");
    expect(qa.keep).not.toBeNull();
  });

  it("R3110 — 418 × 370 px is below the 800 px catalogue minimum: held", () => {
    const qa = verdictOf("r3110");
    expect(qa.status).toBe("needs_review");
    expect(qa.flags).toContain("low_res:418x370");
    expect(qa.heroUsable).toBe(false);
  });

  it("the clean cut-outs pass (AL112 on a black vignette backdrop too — no false 'detail loss')", () => {
    // al3 is judged with its original in media-cutouts-photoroom.test.ts: this
    // fixture has none, and without it the bail's opening is held as
    // "interior_hole_unchecked" (asserted there).
    for (const n of ["al112", "r7828", "r3341"]) {
      const qa = verdictOf(n);
      expect(qa.status, n).toBe("ok");
      expect(qa.flags, n).toEqual([]);
      expect(qa.heroUsable, n).toBe(true);
    }
    expect(verdictOf("al112").detailKept).toBeGreaterThan(0.9);
  });

  it("watches cropped by the frame are fixed, not held: which sides", () => {
    expect(verdictOf("c0983")).toMatchObject({ status: "auto_fixed", edges: ["top", "bottom"] });
    expect(verdictOf("c1395")).toMatchObject({ status: "auto_fixed", edges: ["bottom", "left", "right"] });
  });

  it("no clean photo trips the fog check (edge-aware haze)", () => {
    for (const n of Object.keys(FIXTURES)) expect(verdictOf(n).haze, n).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// Synthetic shapes for the rules the eight photos do not exercise.
// ---------------------------------------------------------------------------
function canvas(w: number, h: number): AlphaImage { return { width: w, height: h, alpha: new Uint8Array(w * h) }; }
function disc(img: AlphaImage, cx: number, cy: number, r: number, a = 255) {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.alpha[y * img.width + x] = a;
}
const big = { sourceWidth: 1500, sourceHeight: 1500 };

describe("rules", () => {
  it("D7 — an earring pair is two similar regions: held as extra objects unless the product is earrings/a set", () => {
    const img = canvas(400, 400);
    disc(img, 120, 200, 50);
    disc(img, 280, 200, 45);
    expect(checkCutout({ cutout: img, ...big })).toMatchObject({ status: "needs_review", flags: ["extra_objects:1"] });
    const pair = checkCutout({ cutout: img, ...big, allowPairs: true });
    expect(pair.status).toBe("ok");
    expect(pair.keep).toBeNull(); // both earrings stay in the picture
  });

  it("D7 does not let a small inset through on an earrings product", () => {
    const img = canvas(400, 400);
    disc(img, 150, 200, 80);
    disc(img, 340, 60, 30); // (30/80)² ≈ 0.14 of the piece — not a pair
    expect(checkCutout({ cutout: img, ...big, allowPairs: true }).flags).toContain("extra_objects:1");
  });

  it("specks under 2 % inside the piece's box stay; outside it they are dropped silently", () => {
    const img = canvas(400, 400);
    disc(img, 200, 200, 100);
    disc(img, 200, 200, 3, 0);
    disc(img, 200, 200, 2); // speck inside the ring's box
    disc(img, 380, 380, 4); // speck far outside
    const qa = checkCutout({ cutout: img, ...big });
    expect(qa.status).toBe("ok");
    expect(qa.keep).not.toBeNull();
  });

  it("coverage outside 3–85 % is held", () => {
    const tiny = canvas(400, 400); disc(tiny, 200, 200, 20);
    expect(checkCutout({ cutout: tiny, ...big }).flags[0]).toMatch(/^coverage:0\.0/);
    const full = canvas(400, 400); full.alpha.fill(255);
    const qa = checkCutout({ cutout: full, ...big });
    expect(qa.status).toBe("needs_review");
    expect(qa.flags.some((f) => f.startsWith("coverage:1."))).toBe(true);
  });

  it("D4 — 800–1199 px is fine for the catalogue but not the hero; under 800 is held", () => {
    const img = canvas(400, 400); disc(img, 200, 200, 120);
    const mid = checkCutout({ cutout: img, sourceWidth: 1000, sourceHeight: 900 });
    expect(mid.status).toBe("ok");
    expect(mid.flags).toEqual(["hero_low_res:1000x900"]);
    expect(mid.heroUsable).toBe(false);
    expect(checkCutout({ cutout: img, sourceWidth: 799, sourceHeight: 600 }).status).toBe("needs_review");
    expect(MIN_CATALOG_PX).toBe(800);
    expect(MIN_HERO_PX).toBe(1200);
  });

  it("one stray opaque pixel on the frame is not a crop", () => {
    const img = canvas(1000, 1000); disc(img, 500, 500, 200);
    img.alpha[0] = 255;
    expect(edgeTouches(img)).toEqual([]);
    for (let x = 400; x < 600; x++) img.alpha[999 * 1000 + x] = 255;
    expect(edgeTouches(img)).toEqual(["bottom"]);
  });

  it("fog: a veil of partial alpha away from the piece is held; a soft edge is not", () => {
    const img = canvas(300, 300);
    disc(img, 150, 150, 140, 90);   // haze all around
    disc(img, 150, 150, 60, 255);   // the piece
    expect(hazeShare(img)).toBeGreaterThan(0.08);
    expect(checkCutout({ cutout: img, ...big }).flags.some((f) => f.startsWith("soft_matte:"))).toBe(true);
    const clean = canvas(300, 300);
    disc(clean, 150, 150, 61, 120); disc(clean, 150, 150, 60, 255); // 1-px anti-aliased rim
    expect(hazeShare(clean)).toBe(0);
  });

  it("fine detail erased: the photo has a chain the cut-out lost", () => {
    const w = 256, h = 256;
    const rgb = new Uint8Array(w * h * 3).fill(250); // white backdrop
    const cut = canvas(w, h);
    for (let y = 60; y < 200; y++) for (let x = 60; x < 200; x++) {
      const i = (y * w + x) * 3; rgb[i] = 200; rgb[i + 1] = 160; rgb[i + 2] = 40; // gold piece
      cut.alpha[y * w + x] = 255;
    }
    for (let y = 0; y < 60; y++) for (let x = 125; x < 135; x++) {
      const i = (y * w + x) * 3; rgb[i] = 200; rgb[i + 1] = 160; rgb[i + 2] = 40; // chain…
    }
    for (let y = 200; y < 256; y++) for (let x = 0; x < 256; x++) {
      const i = (y * w + x) * 3; rgb[i] = 225; rgb[i + 1] = 225; rgb[i + 2] = 225; // …and a grey drop shadow
    }
    const kept = checkCutout({ cutout: cut, ...big, original: { width: w, height: h, rgb } });
    expect(kept.detailKept).toBeGreaterThan(0.9); // the shadow is not counted as the piece
    // now the cut-out also drops half the pendant
    for (let y = 60; y < 200; y++) for (let x = 130; x < 200; x++) cut.alpha[y * w + x] = 0;
    const lost = checkCutout({ cutout: cut, ...big, original: { width: w, height: h, rgb } });
    expect(lost.status).toBe("needs_review");
    expect(lost.flags.some((f) => f.startsWith("detail_loss:"))).toBe(true);
  });

  it("regions and downsampling", () => {
    const img = canvas(1024, 512); disc(img, 200, 256, 100); disc(img, 800, 256, 100);
    const ds = downsampleAlpha(img);
    expect([ds.width, ds.height]).toEqual([256, 128]);
    expect(findRegions(ds).regions).toHaveLength(2);
  });

  it("only ok / auto_fixed / approved are publishable; every flag reads as plain words", () => {
    expect(PUBLISHABLE_STATUSES).toEqual(["ok", "auto_fixed", "approved"]);
    expect(describeFlag("low_res:418x370")).toBe("Too small: 418 × 370 px (at least 800 px needed)");
    expect(describeFlag("extra_objects:1")).toMatch(/second object/);
    expect(describeFlag("edge_touch:top,bottom")).toMatch(/top, bottom/);
    for (const f of ["coverage:0.010", "coverage:0.990", "detail_loss:0.42", "hero_low_res:1000x900", "soft_matte:0.2", "api_error:HTTP 500"]) {
      expect(describeFlag(f)).not.toBe(f);
    }
  });
});

// ---------------------------------------------------------------------------
// Compositor.
// ---------------------------------------------------------------------------
function rgba(w: number, h: number, fill?: (x: number, y: number) => [number, number, number, number] | null): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = fill?.(x, y); if (p) data.set(p, (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}
const px = (img: Rgba, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("ivory catalogue square (D2, D3, D5)", () => {
  it("is exactly chalk #F5F5F2 where there is no piece, opaque, square", () => {
    const piece = rgba(100, 60, () => [200, 160, 40, 255]);
    const out = composeIvory(piece, [], 400);
    expect([out.width, out.height]).toEqual([400, 400]);
    expect(px(out, 0, 0)).toEqual([...IVORY, 255]);
    expect(px(out, 399, 0)).toEqual([...IVORY, 255]);
    expect(IVORY).toEqual([0xf5, 0xf5, 0xf2]);
  });

  it("fits the piece's box to 80 %, centred, lifted 2 % (optical centre)", () => {
    const p = ivoryPlacement(200, 100, [], 1000);
    expect(p.w).toBe(1000 * IVORY_FILL);
    expect(p.x).toBe(100);
    expect(p.y).toBe(Math.round((1000 - 400) / 2 - 20));
  });

  it("a piece cut top and bottom spans the square; one cut at the bottom sits on the edge", () => {
    expect(ivoryPlacement(80, 200, ["top", "bottom"], 1000)).toMatchObject({ y: 0, h: 1000 });
    expect(ivoryPlacement(300, 100, ["bottom", "left", "right"], 1000)).toMatchObject({ x: 0, w: 1000 });
    const b = ivoryPlacement(100, 100, ["bottom"], 1000);
    expect(b.y + b.h).toBe(1000);
  });

  it("draws the contact shadow under the base, and none when the base is cropped", () => {
    const piece = rgba(100, 100, () => [200, 160, 40, 255]);
    const withShadow = composeIvory(piece, [], 500);
    const p = ivoryPlacement(100, 100, [], 500);
    const below = px(withShadow, p.x + p.w / 2, p.y + p.h + 2);
    expect(below[0]).toBeLessThan(IVORY[0]);
    const cropped = composeIvory(piece, ["bottom"], 500);
    expect(px(cropped, 250, 20)).toEqual([...IVORY, 255]);
  });

  it("the small square is an exact 2× reduction", () => {
    const out = composeIvory(rgba(50, 50, () => [10, 20, 30, 255]), [], 200);
    const small = halve(out);
    expect([small.width, small.height]).toEqual([100, 100]);
    expect(px(small, 0, 0)).toEqual([...IVORY, 255]);
  });

  it("stores D10 path A sizes", () => {
    expect(CUTOUT_SIZES_PATH_A).toEqual({ cutoutMax: 900, catalog: 1200, catalogSmall: 600 });
  });
});

describe("hero cut-out", () => {
  it("is trimmed to the piece (+2 %), never upscaled, and fades a cropped side", () => {
    const img = rgba(1000, 1000, (x, y) => (x >= 300 && x < 700 && y >= 200 ? [180, 180, 180, 255] : null));
    const cut = makeHeroCutout(img, ["bottom"], 900)!;
    expect(cut.height).toBeLessThanOrEqual(900);
    expect(px(cut, Math.floor(cut.width / 2), cut.height - 1)[3]).toBe(0);     // faded to nothing at the crop
    expect(px(cut, Math.floor(cut.width / 2), Math.floor(cut.height / 2))[3]).toBe(255);
    const small = makeHeroCutout(rgba(200, 200, (x, y) => (x > 50 && x < 150 && y > 50 && y < 150 ? [1, 2, 3, 255] : null)), [], 900)!;
    expect(small.width).toBeLessThan(200); // trimmed, not upscaled to 900
  });

  it("alphaBounds pads 2 %; trimPiece has no pad; fadeEdges only touches cut sides", () => {
    const img = rgba(500, 500, (x, y) => (x >= 100 && x < 400 && y >= 100 && y < 400 ? [9, 9, 9, 255] : null));
    expect(alphaBounds(img)).toEqual({ x: 94, y: 94, w: 312, h: 312 });
    expect(trimPiece(img, [])).toMatchObject({ width: 300, height: 300 });
    const f = rgba(10, 10, () => [0, 0, 0, 255]);
    fadeEdges(f, ["left"], 0.5);
    expect(px(f, 0, 5)[3]).toBe(0);
    expect(px(f, 9, 5)[3]).toBe(255);
  });

  it("applyKeepMask removes the inset but keeps the piece's fine edge", () => {
    const img = rgba(400, 400, (x, y) => ((x - 150) ** 2 + (y - 200) ** 2 < 90 ** 2 || (x > 330 && y < 60) ? [5, 5, 5, 255] : null));
    const alpha = { width: 400, height: 400, alpha: new Uint8Array(400 * 400).map((_, i) => img.data[i * 4 + 3]) };
    const qa = checkCutout({ cutout: alpha, ...big });
    expect(qa.flags).toContain("extra_objects:1");
    applyKeepMask(img, qa.keep!, qa.dsWidth, qa.dsHeight);
    expect(px(img, 360, 30)[3]).toBe(0);   // inset gone
    expect(px(img, 150, 111)[3]).toBe(255); // the piece's top edge is still there
  });
});

// ---------------------------------------------------------------------------
// The switch, the cap, URL keying — TS mirror of the SQL.
// ---------------------------------------------------------------------------
describe("switch fails to off; cap; URL keying", () => {
  it("anything but the exact strings test/on is OFF", () => {
    expect(readCutoutMode("on")).toBe("on");
    expect(readCutoutMode("test")).toBe("test");
    for (const v of ["ON", "on ", "true", true, 1, null, undefined, "", "off", { mode: "on" }]) expect(readCutoutMode(v)).toBe("off");
  });

  it("a cap that is not a whole number reads 0 — nothing is submitted", () => {
    expect(readCutoutCap(600)).toBe(600);
    expect(readCutoutCap("600")).toBe(600);
    for (const v of ["lots", -1, 1.5, "1e3", null, "", 10_000_000]) expect(readCutoutCap(v)).toBe(0);
    expect(capLeft(600, 599)).toBe(1);
    expect(capLeft(600, 700)).toBe(0);
  });

  it("the 80 % bell rings once", () => {
    expect(shouldRingCapBell(479, 600, false)).toBe(false);
    expect(shouldRingCapBell(480, 600, false)).toBe(true);
    expect(shouldRingCapBell(590, 600, true)).toBe(false);
    expect(shouldRingCapBell(10, 0, false)).toBe(false);
  });

  it("only our own website photos are queued, never our derived files", () => {
    const base = "https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/";
    expect(isCutoutSource(`${base}page365/12/3-178.jpg`)).toBe(true);
    expect(isCutoutSource(`${base}0b7c.webp`)).toBe(true);
    expect(isCutoutSource(`${base}derived/abc/r1/cutout.webp`)).toBe(false);
    expect(isCutoutSource("https://cdn.page365.net/x.jpg")).toBe(false);
    expect(isCutoutSource(null)).toBe(false);
    expect(OWN_CUTOUT_RE.test(`${base}derived/own/1f3a.png`)).toBe(true);
    expect(OWN_CUTOUT_RE.test(`${base}derived/own/../x.png`)).toBe(false);
    expect(storagePathOf(`${base}derived/own/1f3a.png`)).toBe("website/derived/own/1f3a.png");
  });

  it("derived files are keyed by the original's bytes and the run", () => {
    const sha = "a".repeat(64);
    expect(derivedPaths(sha, 3)).toEqual({
      master: `website/derived/${"a".repeat(32)}/r3/master.png`,
      cutout: `website/derived/${"a".repeat(32)}/r3/cutout.webp`,
      catalog: `website/derived/${"a".repeat(32)}/r3/catalog.webp`,
      catalogSmall: `website/derived/${"a".repeat(32)}/r3/catalog-small.webp`,
    });
    expect([MAX_RETRIES, ...RETRY_BACKOFF_MINUTES]).toEqual([3, 5, 30, 180]);
  });

  it("the SQL says the same", () => {
    const sql = src(MIGRATION);
    // keyed by the photo URL, never by website_product_media.id
    expect(sql).toMatch(/source_url\s+text PRIMARY KEY/);
    expect(sql).not.toMatch(/REFERENCES public\.website_product_media/);
    expect(sql).toMatch(/AFTER INSERT OR UPDATE OF url ON public\.website_product_media/);
    expect(sql).toMatch(/ON CONFLICT \(source_url\) DO NOTHING;\n {2}EXCEPTION WHEN OTHERS THEN/);
    expect(sql).toContain("p_url ~ '^https://[^/]+/storage/v1/object/public/promotions/website/'");
    expect(sql).toContain("p_url !~ '/promotions/website/derived/'");
    // fail-closed switch and cap; seeded off / 600; changed only via the RPC
    expect(sql).toMatch(/CASE WHEN v IN \('test','on'\) THEN v ELSE 'off' END/);
    expect(sql).toMatch(/CASE WHEN v ~ '\^\[0-9\]\{1,6\}\$' THEN v::integer ELSE 0 END/);
    expect(sql).toContain("VALUES ('media_cutout_mode', '\"off\"'::jsonb,");
    expect(sql).toContain("VALUES ('media_cutout_monthly_cap', '600'::jsonb,");
    expect(sql).toMatch(/IF v_mode = 'off' THEN\s+RETURN jsonb_build_object\('mode', v_mode, 'rows', '\[\]'::jsonb/);
    // cap, bell, retries, cron
    expect(sql).toContain("v_used * 5 >= v_cap * 4");
    expect(sql).toContain("IF p_retryable AND r.attempts < 3 THEN");
    expect(sql).toMatch(/WHEN 0 THEN interval '5 minutes'\s+WHEN 1 THEN interval '30 minutes'\s+ELSE interval '3 hours'/);
    expect(sql).toContain("cron.schedule('media-cutout-worker', '1-59/2 * * * *'");
    expect(sql).toContain("vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'");
    // redefines no existing function
    expect(sql).not.toMatch(/FUNCTION public\.notify_website_revalidate/);
    expect(sql).not.toMatch(/FUNCTION public\.page365_inventory_record_photo/);
  });
});

// ---------------------------------------------------------------------------
// Providers (D1): fal primary, Replicate backup, same interface.
// ---------------------------------------------------------------------------
const KEY = "fal-secret-key-1234567890abcdef";
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("fal adapter", () => {
  it("submits BiRefNet v2 Heavy at 2048 (high detail: Dynamic 2304) to the queue with the key header", async () => {
    const f = vi.fn(async () => jsonRes({ request_id: "r1", status_url: "https://queue.fal.run/s/r1", response_url: "https://queue.fal.run/r/r1" }));
    const job = await falProvider(KEY, f as unknown as typeof fetch).submit("https://x/p.jpg", { highDetail: false });
    expect(job).toMatchObject({ provider: "fal", requestId: "r1", statusUrl: "https://queue.fal.run/s/r1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://queue.fal.run/fal-ai/birefnet/v2");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Key ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual(falRequestBody("https://x/p.jpg", false));
    expect(falRequestBody("u", false)).toMatchObject({ model: "General Use (Heavy)", operating_resolution: "2048x2048", output_format: "png", refine_foreground: true });
    expect(falRequestBody("u", true)).toMatchObject({ model: "General Use (Dynamic)", operating_resolution: "2304x2304" });
  });

  it("polls: pending → done (result image url); errors are classified", async () => {
    const job = { requestId: "r1", statusUrl: "https://s", responseUrl: "https://r" };
    const pending = falProvider(KEY, (async () => jsonRes({ status: "IN_PROGRESS" })) as unknown as typeof fetch);
    expect(await pending.poll(job)).toEqual({ state: "pending" });
    const done = falProvider(KEY, (async (u: string) => u === "https://s" ? jsonRes({ status: "COMPLETED" })
      : jsonRes({ image: { url: "https://v3.fal.media/files/out.png" } })) as unknown as typeof fetch);
    expect(await done.poll(job)).toEqual({ state: "done", resultUrl: "https://v3.fal.media/files/out.png" });
    const limited = falProvider(KEY, (async () => jsonRes({}, 429)) as unknown as typeof fetch);
    expect(await limited.poll(job)).toMatchObject({ state: "error", retryable: true });
  });

  it("never lets the key into an error message", async () => {
    const leaky = falProvider(KEY, (async () => new Response(`bad key ${KEY} / Key ${KEY}`, { status: 401 })) as unknown as typeof fetch);
    const err = await leaky.submit("https://x/p.jpg", { highDetail: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).not.toContain(KEY);
    expect(err.retryable).toBe(false);
    expect(scrub(`Authorization: Bearer abcdefghijklmnopqrstuvwxyz`, undefined)).not.toContain("abcdefghijklmnop");
    expect([429, 500, 503, 408].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });
});

describe("provider choice and the Replicate backup", () => {
  const envOf = (m: Record<string, string>) => (k: string) => m[k];
  it("the SETTING picks the provider (Photoroom by default); fal / Replicate only when selected and keyed", () => {
    const all = { PHOTOROOM_API_KEY: "p", FAL_KEY: "k", REPLICATE_API_TOKEN: "t", REPLICATE_BIREFNET_VERSION: "v" };
    expect(pickProvider(envOf(all))?.name).toBe("photoroom");
    expect(pickProvider(envOf(all), "photoroom")?.name).toBe("photoroom");
    expect(pickProvider(envOf(all), "fal")?.name).toBe("fal");
    expect(pickProvider(envOf(all), "replicate")?.name).toBe("replicate");
    // FAL_KEY alone never makes a fal call: the default is Photoroom, unkeyed → nothing.
    expect(pickProvider(envOf({ FAL_KEY: "k" }))).toBeNull();
    expect(pickProvider(envOf({ FAL_KEY: "k" }), "garbage")).toBeNull();
    expect(pickProvider(envOf({ REPLICATE_API_TOKEN: "t" }), "replicate")).toBeNull();
    expect(pickProvider(envOf({}))).toBeNull();
  });

  it("Replicate submits by version and polls the prediction", async () => {
    const f = vi.fn(async (u: string) => u.endsWith("/predictions")
      ? jsonRes({ id: "p1", urls: { get: "https://api.replicate.com/v1/predictions/p1" } })
      : jsonRes({ status: "succeeded", output: "https://replicate.delivery/out.png" }));
    const p = replicateProvider("tok-123456789", "abcdef1234567890", f as unknown as typeof fetch);
    const job = await p.submit("https://x/p.jpg", { highDetail: false });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ version: "abcdef1234567890", input: { image: "https://x/p.jpg" } });
    expect(await p.poll(job)).toEqual({ state: "done", resultUrl: "https://replicate.delivery/out.png" });
  });
});

// ---------------------------------------------------------------------------
// The worker's gates (source assertions; the function runs in Deno).
// ---------------------------------------------------------------------------
describe("media-cutout-worker", () => {
  const w = src(WORKER);
  it("uses the shared auth gate: service role for the cron, manage_website_catalog for staff", () => {
    expect(w).toContain('requireAuth(req, { allowServiceRole: true })');
    expect(w).toContain('requirePermission(ctx, "manage_website_catalog")');
    expect(w).toMatch(/if \(!ctx\.isService\) return jsonResponse\(\{ error: "Access denied" \}, 403\);/);
  });

  it("reads the switch first and does nothing at all while it is off (fail-closed on a read error)", () => {
    const t = w.slice(w.indexOf("async function tick("));
    expect(t.indexOf("readCutoutMode(")).toBeLessThan(t.indexOf("media_cutout_lease"));
    expect(t).toMatch(/const mode = modeErr \? "off" : readCutoutMode/);
    expect(t).toMatch(/if \(mode === "off"\) return \{ ok: true, mode/);
  });

  it("processes one job per invocation, stores path A sizes, never writes an original", () => {
    expect(w).toContain('body: JSON.stringify({ action: "process", source_url: url })');
    expect(w).toContain("sizes: CUTOUT_SIZES_PATH_A");
    expect(w).toContain('output: c.cpu_fallback === true ? "cutout_only" : "baked"');
    expect(w).toMatch(/upload\(path, bytes, \{ contentType: type, upsert: false \}\)/);
    expect(w).not.toMatch(/storage\.from\(BUCKET\)\.update\(/);
  });

  it("never logs or stores a provider secret", () => {
    for (const line of w.split("\n").filter((l) => /console\.(log|error|warn)/.test(l))) {
      expect(line).not.toMatch(/FAL_KEY|REPLICATE_API_TOKEN|env\(/);
    }
    expect(src(MIGRATION)).not.toMatch(/FAL_KEY/);
    expect(w).not.toMatch(/console\.(log|error|warn)\([^)]*PHOTOROOM_API_KEY/);
  });
});
