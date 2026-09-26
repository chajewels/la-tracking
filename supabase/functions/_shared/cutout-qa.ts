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
  /**
   * The provider's own confidence, 0 (sure) – 1 (unsure): Photoroom's
   * `x-uncertainty-score` header. null / undefined = not given (fal, or -1).
   */
  providerUncertainty?: number | null;
}

/**
 * Photoroom documents "high uncertainty: between 0.6 and 1", "low: between 0
 * and 0.3" (docs.photoroom.com/remove-background-api-basic-plan/uncertainty-score).
 * Held from the middle of the gap: a false hold costs a click, a false OK
 * shows a broken photo.
 */
export const UNCERTAINTY_REVIEW = 0.45;

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
// Interior holes (added 2026-09-27 after "Test 30": fal.ai erased part of the
// dial of C1395 and C0983 and both passed — the dial hole is INSIDE the
// watch, so no region / edge / coverage check sees it, and detail_loss missed
// it: C0983's white dial is within ΔE 12 of its white backdrop, so the erased
// dial never counted as "something"; C1395's hole is ~5 % of the piece, far
// under the 20 % detail_loss allowance).
//
// A hole = transparent cells fully enclosed by the piece (not reachable from
// the frame's border). A real opening (an open heart, a ring's centre, chain
// links) shows the BACKDROP through it, and the piece around it is a
// different material. An erasure cuts through ONE continuous surface: the
// piece right around the hole looks like what was removed. So a hole is
// "not plausible background" when either
//   (a) most of what the photo shows there is not backdrop (same rule as the
//       detail check: ΔE > 12 and not a colourless brightness shift), or
//   (b) most of its rim (kept piece cells touching it) has the colour of the
//       hole's content (ΔE ≤ HOLE_RIM_DE) AND that surface carries on well
//       past the hole (HOLE_SURFACE_RATIO) — the cut ran through a surface.
//       (a) alone cannot see C0983: the white dial IS backdrop-coloured.
// Such holes adding up to HOLE_REVIEW_SHARE of the piece → needs_review.
// Without the original on the same grid, colour cannot be judged: sizeable
// holes are then held as "unchecked" (review is the safe direction).
// ---------------------------------------------------------------------------
/** Ignore holes smaller than this share of the piece (pavé gaps, chain links)… */
export const HOLE_MIN_SHARE = 0.002;
/** …and smaller than this many QA-grid cells. */
export const HOLE_MIN_CELLS = 6;
/** Rim colour within this ΔE of the hole's content = one continuous surface. */
export const HOLE_RIM_DE = 10;
/** Share of a hole's content / rim that decides (a) / (b). */
export const HOLE_EVIDENCE = 0.5;
/**
 * (b) also needs the kept surface of the hole's colour, grown from its rim,
 * to be at least this many times the hole: the rest of a dial is several
 * times the bite taken out of it (C0983: 7×), while the light metal round a
 * bracelet seen from the side is a thin strip next to a big opening (0.1–0.3×
 * on C0983_3/_4, C1395_3 of "Test 30").
 */
export const HOLE_SURFACE_RATIO = 2;
/** Implausible holes adding up to this share of the piece → needs_review. */
export const HOLE_REVIEW_SHARE = 0.004;

export interface HoleReport {
  /** Implausible (erased) hole area as a share of the piece; 0 when none. */
  erasedShare: number;
  /** All enclosed hole area (above the size floor) as a share of the piece. */
  holeShare: number;
  /** True when the original was not available and colour was not judged. */
  unchecked: boolean;
}

const NB4 = (p: number, w: number, h: number): number[] => {
  const x = p % w, y = (p - x) / w;
  return [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
};

/**
 * `piece`: 1 where the (kept) piece is, on the QA grid. `original`: the photo
 * on the same grid, or null.
 */
export function interiorHoles(piece: Uint8Array, w: number, h: number, original: RgbImage | null): HoleReport {
  let pieceArea = 0;
  for (let i = 0; i < piece.length; i++) pieceArea += piece[i];
  if (pieceArea === 0) return { erasedShare: 0, holeShare: 0, unchecked: false };

  // Empty cells reachable from the frame's border (4-connected) are outside;
  // every other empty cell is inside a hole.
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const seed = (i: number) => { if (!piece[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp > 0) for (const q of NB4(stack[--sp], w, h)) if (q >= 0) seed(q);

  let lab: Float32Array | null = null;
  let bgLab: [number, number, number] = [0, 0, 0];
  if (original && original.width === w && original.height === h) {
    lab = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const [L, A, B] = rgbToLab(original.rgb[i * 3], original.rgb[i * 3 + 1], original.rgb[i * 3 + 2]);
      lab[i * 3] = L; lab[i * 3 + 1] = A; lab[i * 3 + 2] = B;
    }
    const [br, bg, bb] = cornerBackground(original);
    bgLab = rgbToLab(br, bg, bb);
  }

  const minCells = Math.max(HOLE_MIN_CELLS, pieceArea * HOLE_MIN_SHARE);
  const seen = new Uint8Array(w * h);
  let holeArea = 0, erased = 0;
  for (let start = 0; start < w * h; start++) {
    if (piece[start] || outside[start] || seen[start]) continue;
    const cells: number[] = [];
    sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      cells.push(p);
      for (const q of NB4(p, w, h)) if (q >= 0 && !piece[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
    }
    if (cells.length < minCells) continue;
    holeArea += cells.length;
    if (!lab) continue;

    // (a) What the photo shows in the hole.
    let notBackdrop = 0, mL = 0, mA = 0, mB = 0;
    for (const p of cells) {
      const L = lab[p * 3], A = lab[p * 3 + 1], B = lab[p * 3 + 2];
      mL += L; mA += A; mB += B;
      const dL = L - bgLab[0], dA = A - bgLab[1], dB = B - bgLab[2];
      const backdrop = Math.sqrt(dL * dL + dA * dA + dB * dB) <= DETAIL_DELTA_E ||
        (Math.abs(dL) < BACKDROP_DL && Math.abs(dA) < BACKDROP_DAB && Math.abs(dB) < BACKDROP_DAB);
      if (!backdrop) notBackdrop++;
    }
    mL /= cells.length; mA /= cells.length; mB /= cells.length;
    // (b) The rim: kept piece cells 4-adjacent to the hole.
    let rim = 0, rimSame = 0;
    const rimSeen = new Set<number>();
    for (const p of cells) {
      for (const q of NB4(p, w, h)) {
        if (q < 0 || !piece[q] || rimSeen.has(q)) continue;
        rimSeen.add(q);
        rim++;
        const dL = lab[q * 3] - mL, dA = lab[q * 3 + 1] - mA, dB = lab[q * 3 + 2] - mB;
        if (Math.sqrt(dL * dL + dA * dA + dB * dB) <= HOLE_RIM_DE) rimSame++;
      }
    }
    // The kept surface that continues the hole: piece cells reachable from
    // the matching rim through cells of the hole's colour.
    const near = (q: number) => Math.hypot(lab[q * 3] - mL, lab[q * 3 + 1] - mA, lab[q * 3 + 2] - mB) <= HOLE_RIM_DE;
    const surf = new Set<number>();
    const grow: number[] = [];
    for (const q of rimSeen) if (near(q)) { surf.add(q); grow.push(q); }
    while (grow.length) {
      for (const q of NB4(grow.pop()!, w, h)) if (q >= 0 && piece[q] && !surf.has(q) && near(q)) { surf.add(q); grow.push(q); }
    }
    const showsPiece = notBackdrop >= cells.length * HOLE_EVIDENCE;
    const cutThroughSurface = rim > 0 && rimSame >= rim * HOLE_EVIDENCE && surf.size >= cells.length * HOLE_SURFACE_RATIO;
    if (showsPiece || cutThroughSurface) erased += cells.length;
  }
  return { erasedShare: erased / pieceArea, holeShare: holeArea / pieceArea, unchecked: !lab };
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

  // 4b. Part of the piece erased from INSIDE its outline (a watch dial).
  const pieceMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) pieceMask[i] = ds.alpha[i] >= ALPHA_ON && (!keep || keep[i]) ? 1 : 0;
  const holes = interiorHoles(pieceMask, ds.width, ds.height, input.original ?? null);
  if (holes.unchecked) {
    if (holes.holeShare >= HOLE_REVIEW_SHARE) {
      review = true;
      flags.push(`interior_hole_unchecked:${holes.holeShare.toFixed(3)}`);
    }
  } else if (holes.erasedShare >= HOLE_REVIEW_SHARE) {
    review = true;
    flags.push(`interior_hole:${holes.erasedShare.toFixed(3)}`);
  }

  // 4c. The provider's own doubt (Photoroom's x-uncertainty-score).
  const doubt = input.providerUncertainty;
  if (typeof doubt === "number" && doubt >= UNCERTAINTY_REVIEW) {
    review = true;
    flags.push(`uncertain:${doubt.toFixed(2)}`);
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
    case "interior_hole":
      return `Part of the piece was erased from inside it (${(Number(value) * 100).toFixed(1)}% of the piece — e.g. a watch dial) — check it`;
    case "interior_hole_unchecked":
      return "The piece has openings that could not be compared with the photo — check it";
    case "uncertain":
      return `The background-removal service was unsure of this photo (uncertainty ${value}) — check it`;
    case "soft_matte":
      return "A haze was left around the piece";
    case "api_error":
      return `The background-removal service failed: ${value}`;
    default:
      return flag;
  }
}
