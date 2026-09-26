// Automatic quality checks for a product-photo cut-out (docs/MEDIA-CUTOUTS.md
// "QUALITY CHECKS"). PURE: no imports, no I/O — the worker decodes the images
// and hands this module plain pixel arrays, so vitest tests the exact rules the
// worker runs (src/test/media-cutouts.test.ts).
//
// One verdict drives BOTH uses (owner decision D3): the hero cut-out and the
// ivory catalogue square. A piece cropped by the photo's frame is fixed, not
// held: it fades in the hero and runs to the square's edge in the catalogue.
//
// Order of precedence: needs_review beats auto_fixed beats ok. A provider error
// ("failed") never reaches this module — there is no cut-out to check.

export type CutoutStatus =
  | "pending" | "ok" | "auto_fixed" | "needs_review" | "approved" | "rejected" | "failed";

/** The statuses whose files the website may show (PR 2 sends only these). */
export const PUBLISHABLE_STATUSES: readonly CutoutStatus[] = ["ok", "auto_fixed", "approved"];

/** Alpha at or above this is "the piece". */
export const ALPHA_ON = 128;
/** Region checks run on the alpha downsampled so its long side is this. */
export const QA_SIZE = 256;
/** A second region counts as an extra object above this share of the largest. */
export const EXTRA_OBJECT_MIN = 0.02;
/** D7: with earrings / sets, a region 0.5–2× the largest is part of the piece. */
export const PAIR_RATIO_MIN = 0.5;
export const PAIR_RATIO_MAX = 2;
/** Share of the frame the piece should cover. */
export const COVERAGE_MIN = 0.03;
export const COVERAGE_MAX = 0.85;
/** Fine-detail loss: the cut-out must keep this share of the photo's non-background. */
export const DETAIL_KEEP_MIN = 0.8;
/** CIE76 ΔE from the photo's background colour above which a pixel is "something". */
export const DETAIL_DELTA_E = 12;
/** A colourless brightness shift smaller than this is backdrop (shadow, vignette). */
export const BACKDROP_DL = 30;
export const BACKDROP_DAB = 5;
/** Too little non-background in the photo to judge detail loss at all. */
export const DETAIL_MIN_SHARE = 0.005;
/** D4: long side of the ORIGINAL photo. */
export const MIN_CATALOG_PX = 800;
export const MIN_HERO_PX = 1200;
/** Soft matte: share of visible pixels that are semi-transparent (alpha 10–90 %). */
export const HAZE_MAX = 0.08;
export const HAZE_LOW = 26;
export const HAZE_HIGH = 229;

export type Side = "top" | "bottom" | "left" | "right";
export const SIDES: readonly Side[] = ["top", "bottom", "left", "right"];

export interface AlphaImage {
  width: number;
  height: number;
  /** One byte per pixel, 0–255. */
  alpha: Uint8Array;
}

/** The ORIGINAL photo, downsampled (long side ≈ QA_SIZE), RGB bytes. */
export interface RgbImage {
  width: number;
  height: number;
  rgb: Uint8Array;
}

export interface QaInput {
  /** Full-resolution alpha of the provider's cut-out. */
  cutout: AlphaImage;
  /** Size of the ORIGINAL photo (the resolution rule is about the photo). */
  sourceWidth: number;
  sourceHeight: number;
  /** The original, downsampled to the QA grid; null skips the detail check. */
  original?: RgbImage | null;
  /** D7: the product is earrings or a set — similar-size regions are one piece. */
  allowPairs?: boolean;
}

export interface Region {
  area: number;
  minX: number; minY: number; maxX: number; maxY: number;
}

export interface QaResult {
  status: "ok" | "auto_fixed" | "needs_review";
  /** Machine flags, e.g. "extra_objects:1", "edge_touch:top,bottom", "low_res:418x370". */
  flags: string[];
  coverage: number;
  /** Frame sides the piece is cut by (drives the hero fade / catalogue bleed). */
  edges: Side[];
  /** QA-grid mask (dsWidth × dsHeight) of what to KEEP; null = keep everything. */
  keep: Uint8Array | null;
  dsWidth: number;
  dsHeight: number;
  /** Photo is ≥ MIN_HERO_PX on its long side and the verdict is usable. */
  heroUsable: boolean;
  detailKept: number | null;
  haze: number;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

/** Area-average an alpha image down so its long side is at most `max`. */
export function downsampleAlpha(img: AlphaImage, max = QA_SIZE): AlphaImage {
  const { width: w, height: h, alpha } = img;
  const scale = Math.min(1, max / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  if (dw === w && dh === h) return { width: w, height: h, alpha: alpha.slice() };
  const sum = new Float64Array(dw * dh);
  const cnt = new Float64Array(dw * dh);
  const fx = dw / w, fy = dh / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor(y * fy)) * dw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const di = dy + Math.min(dw - 1, Math.floor(x * fx));
      sum[di] += alpha[row + x];
      cnt[di] += 1;
    }
  }
  const out = new Uint8Array(dw * dh);
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? Math.round(sum[i] / cnt[i]) : 0;
  return { width: dw, height: dh, alpha: out };
}

/** 8-connected regions of alpha ≥ ALPHA_ON. `labels` holds region index + 1. */
export function findRegions(img: AlphaImage): { labels: Int32Array; regions: Region[] } {
  const { width: w, height: h, alpha } = img;
  const labels = new Int32Array(w * h);
  const regions: Region[] = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== 0 || alpha[start] < ALPHA_ON) continue;
    const id = regions.length + 1;
    const r: Region = { area: 0, minX: w, minY: h, maxX: -1, maxY: -1 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      r.area++;
      if (x < r.minX) r.minX = x;
      if (x > r.maxX) r.maxX = x;
      if (y < r.minY) r.minY = y;
      if (y > r.maxY) r.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (labels[q] === 0 && alpha[q] >= ALPHA_ON) {
            labels[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    regions.push(r);
  }
  return { labels, regions };
}

/**
 * Which frame sides the piece is cut by, on the FULL-resolution alpha: a side
 * counts when at least max(2, 0.2 % of its length) of its outermost pixels are
 * opaque — one stray anti-aliased pixel is not a crop.
 */
export function edgeTouches(img: AlphaImage): Side[] {
  const { width: w, height: h, alpha } = img;
  const count = (fn: (i: number) => number, len: number) => {
    let c = 0;
    for (let i = 0; i < len; i++) if (fn(i) >= ALPHA_ON) c++;
    return c;
  };
  const need = (len: number) => Math.max(2, Math.round(len * 0.002));
  const out: Side[] = [];
  if (count((x) => alpha[x], w) >= need(w)) out.push("top");
  if (count((x) => alpha[(h - 1) * w + x], w) >= need(w)) out.push("bottom");
  if (count((y) => alpha[y * w], h) >= need(h)) out.push("left");
  if (count((y) => alpha[y * w + w - 1], h) >= need(h)) out.push("right");
  return out;
}

/**
 * Fog: share of the visible pixels that are semi-transparent (alpha 10–90 %)
 * AND have no opaque pixel within HAZE_REACH px. The soft edge every piece
 * has — anti-aliasing, a thin chain, a cross — always touches its opaque core
 * and is not fog; a veil of partial alpha left around a bracelet does not.
 * Measured: AL3 (thin cross) counted 0.064 as "all semi pixels" at full size
 * and 0.095 at half size; edge-aware it no longer depends on the resolution.
 * Every 2nd pixel is sampled.
 */
export const HAZE_REACH = 2;
export function hazeShare(img: AlphaImage): number {
  const { width: w, height: h, alpha } = img;
  let visible = 0, fog = 0;
  for (let i = 0; i < alpha.length; i += 2) {
    const a = alpha[i];
    if (a < HAZE_LOW) continue;
    visible++;
    if (a > HAZE_HIGH) continue;
    const x = i % w, y = (i - x) / w;
    let nearCore = false;
    for (let dy = -HAZE_REACH; dy <= HAZE_REACH && !nearCore; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -HAZE_REACH; dx <= HAZE_REACH; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < w && alpha[ny * w + nx] > HAZE_HIGH) { nearCore = true; break; }
      }
    }
    if (!nearCore) fog++;
  }
  return visible ? fog / visible : 0;
}

// ---------------------------------------------------------------------------
// Fine-detail loss
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Background colour of a photo: per-channel median of its four corner patches. */
export function cornerBackground(img: RgbImage): [number, number, number] {
  const { width: w, height: h, rgb } = img;
  const p = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  const means: [number, number, number][] = [];
  for (const [x0, y0] of [[0, 0], [w - p, 0], [0, h - p], [w - p, h - p]]) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + p; y++) {
      for (let x = x0; x < x0 + p; x++) {
        const i = (y * w + x) * 3;
        r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++;
      }
    }
    means.push([r / n, g / n, b / n]);
  }
  const med = (k: 0 | 1 | 2) => {
    const s = means.map((m) => m[k]).sort((a, b) => a - b);
    return (s[1] + s[2]) / 2;
  };
  return [med(0), med(1), med(2)];
}

/**
 * Share of the photo's non-background the cut-out kept, on the QA grid (the
 * two images must be the same grid size). A pixel is "something" when its
 * colour is more than DETAIL_DELTA_E from the background — EXCEPT a soft,
 * neutral darkening (a drop shadow on the backdrop), which the cut-out is
 * supposed to drop. null = too little in the photo to judge.
 */
export function detailKept(original: RgbImage, cutoutDs: AlphaImage): number | null {
  if (original.width !== cutoutDs.width || original.height !== cutoutDs.height) return null;
  const [br, bg, bb] = cornerBackground(original);
  const [bL, bA, bB] = rgbToLab(br, bg, bb);
  let something = 0, kept = 0;
  const n = original.width * original.height;
  for (let i = 0; i < n; i++) {
    const [L, A, B] = rgbToLab(original.rgb[i * 3], original.rgb[i * 3 + 1], original.rgb[i * 3 + 2]);
    const dL = L - bL, dA = A - bA, dB = B - bB;
    if (Math.sqrt(dL * dL + dA * dA + dB * dB) <= DETAIL_DELTA_E) continue;
    // The backdrop itself, not the piece: a colourless shift of brightness —
    // a drop shadow on white, a vignette / spotlight on black. The cut-out is
    // supposed to drop both. (Measured: AL112's black backdrop.)
    if (Math.abs(dL) < BACKDROP_DL && Math.abs(dA) < BACKDROP_DAB && Math.abs(dB) < BACKDROP_DAB) continue;
    something++;
    if (cutoutDs.alpha[i] >= ALPHA_ON) kept++;
  }
  if (something < n * DETAIL_MIN_SHARE) return null;
  return kept / something;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export function checkCutout(input: QaInput): QaResult {
  const flags: string[] = [];
  let review = false;
  let fixed = false;

  const ds = downsampleAlpha(input.cutout);
  const { labels, regions } = findRegions(ds);
  const total = ds.width * ds.height;

  // 1. Regions: keep the largest (and, for earrings/sets, the similar ones).
  let keep: Uint8Array | null = null;
  let visibleArea = 0;
  if (regions.length > 0) {
    const largest = regions.reduce((a, b) => (b.area > a.area ? b : a));
    const keepIds = new Set<number>();
    let extras = 0;
    regions.forEach((r, i) => {
      const ratio = r.area / largest.area;
      if (r === largest) keepIds.add(i + 1);
      else if (input.allowPairs && ratio >= PAIR_RATIO_MIN && ratio <= PAIR_RATIO_MAX) keepIds.add(i + 1);
      else if (ratio > EXTRA_OBJECT_MIN) extras++;
      // Specks at or below 2 % inside the piece's box stay; outside it they go.
      else if (r.minX >= largest.minX && r.maxX <= largest.maxX && r.minY >= largest.minY && r.maxY <= largest.maxY) keepIds.add(i + 1);
    });
    if (extras > 0) {
      review = true;
      flags.push(`extra_objects:${extras}`);
    }
    if (keepIds.size < regions.length) {
      keep = new Uint8Array(total);
      for (let i = 0; i < total; i++) if (labels[i] && keepIds.has(labels[i])) keep[i] = 1;
    }
    for (const id of keepIds) visibleArea += regions[id - 1].area;
  }

  // 2. Cropped by the frame → fixed, not held.
  const edges = edgeTouches(input.cutout);
  if (edges.length > 0) {
    fixed = true;
    flags.push(`edge_touch:${edges.join(",")}`);
  }

  // 3. Coverage.
  const coverage = total ? visibleArea / total : 0;
  if (coverage < COVERAGE_MIN || coverage > COVERAGE_MAX) {
    review = true;
    flags.push(`coverage:${coverage.toFixed(3)}`);
  }

  // 4. Fine detail erased (chains, pavé).
  let kept: number | null = null;
  if (input.original) {
    kept = detailKept(input.original, ds);
    if (kept !== null && kept < DETAIL_KEEP_MIN) {
      review = true;
      flags.push(`detail_loss:${kept.toFixed(2)}`);
    }
  }

  // 5. Resolution of the ORIGINAL photo (D4).
  const long = Math.max(input.sourceWidth, input.sourceHeight);
  if (long < MIN_CATALOG_PX) {
    review = true;
    flags.push(`low_res:${input.sourceWidth}x${input.sourceHeight}`);
  } else if (long < MIN_HERO_PX) {
    flags.push(`hero_low_res:${input.sourceWidth}x${input.sourceHeight}`);
  }

  // 6. Fog around the piece.
  const haze = hazeShare(input.cutout);
  if (haze > HAZE_MAX) {
    review = true;
    flags.push(`soft_matte:${haze.toFixed(2)}`);
  }

  const status = review ? "needs_review" : fixed ? "auto_fixed" : "ok";
  return {
    status,
    flags,
    coverage,
    edges,
    keep,
    dsWidth: ds.width,
    dsHeight: ds.height,
    heroUsable: status !== "needs_review" && long >= MIN_HERO_PX,
    detailKept: kept,
    haze,
  };
}

/** Plain words for a flag, for the Hub's Photos tab. */
export function describeFlag(flag: string): string {
  const [kind, value = ""] = flag.split(":");
  switch (kind) {
    case "extra_objects":
      return `A second object is in the photo (e.g. an inset "BACK" view) — ${value} extra, removed from the cut-out`;
    case "edge_touch":
      return `The piece is cut off by the photo's edge (${value.replace(/,/g, ", ")}) — faded in the hero, runs to the edge in the catalogue`;
    case "coverage":
      return Number(value) < COVERAGE_MIN
        ? "Almost nothing was kept — the piece may have been removed with the background"
        : "Almost nothing was removed — the background may still be there";
    case "detail_loss":
      return `Fine detail may be erased (only ${Math.round(Number(value) * 100)}% of the piece kept) — check chains and stones`;
    case "low_res":
      return `Too small: ${value.replace("x", " × ")} px (at least ${MIN_CATALOG_PX} px needed)`;
    case "hero_low_res":
      return `Fine for the catalogue; too small for the hero (${value.replace("x", " × ")} px, hero needs ${MIN_HERO_PX})`;
    case "soft_matte":
      return "A haze was left around the piece";
    case "api_error":
      return `The background-removal service failed: ${value}`;
    default:
      return flag;
  }
}
