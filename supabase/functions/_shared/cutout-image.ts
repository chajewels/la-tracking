// Pixel work for product-photo cut-outs (docs/MEDIA-CUTOUTS.md "OUTPUTS").
// PURE: no imports, no I/O. The worker decodes/encodes with WASM codecs
// (_shared/cutout-codecs.ts); everything between decode and encode is here, so
// the timing test and vitest exercise exactly what ships.
//
// Budget: Supabase edge functions get 2 s of CPU per request. Everything below
// is single-pass over the pixels, resizes premultiplied (no halos), and the
// contact shadow is analytic (an ellipse), never a blur.
//
// Pixels are straight (non-premultiplied) RGBA bytes, row-major.

import type { Side } from "./cutout-qa.ts";

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** D2: the storefront's chalk (the product-card well), exactly. */
export const IVORY: readonly [number, number, number] = [0xf5, 0xf5, 0xf2];
/** Contact shadow: charcoal-deep at 18 % → 0. */
export const SHADOW_RGB: readonly [number, number, number] = [34, 34, 34];
export const SHADOW_OPACITY = 0.18;
export const SHADOW_WIDTH = 0.7;   // of the piece's width
export const SHADOW_HEIGHT = 0.06; // of the piece's width
/** The piece's box fills this share of the ivory square (DESIGN.md "~10 % inset"). */
export const IVORY_FILL = 0.8;
/** Box centre sits this share of the canvas above centre (optical centre). */
export const IVORY_LIFT = 0.02;
/** Sizes as planned (D5 square). */
export const CUTOUT_SIZES = { cutoutMax: 1200, catalog: 1600, catalogSmall: 800 } as const;
/**
 * D10 path A — what the worker stores. The timing test (docs/MEDIA-CUTOUTS.md
 * "TIMING TEST") measured the planned sizes at p95 984 ms on a fast laptop
 * core: with edge CPUs up to ~2× slower that misses the plan's 1.2 s bar and
 * reaches the 2 s kill. These sizes measured p95 645 ms. The grid shows
 * ≤ 400 CSS px (800 device px), so 1200 still covers it at 2×.
 */
export const CUTOUT_SIZES_PATH_A = { cutoutMax: 900, catalog: 1200, catalogSmall: 600 } as const;
/** Hero fade on a side the photo cut the piece off at. */
export const HERO_FADE = 0.14;
/** Trim pad around the piece's alpha bounds. */
export const TRIM_PAD = 0.02;

export function alphaChannel(img: Rgba): Uint8Array {
  const n = img.width * img.height;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = img.data[i * 4 + 3];
  return a;
}

/** Area-average an RGB(A) image to at most `max` on its long side → packed RGB. */
export function downsampleRgb(img: Rgba, targetW: number, targetH: number): Uint8Array {
  const { width: w, height: h, data } = img;
  const sum = new Float64Array(targetW * targetH * 3);
  const cnt = new Float64Array(targetW * targetH);
  const fx = targetW / w, fy = targetH / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(targetH - 1, Math.floor(y * fy)) * targetW;
    for (let x = 0; x < w; x++) {
      const di = dy + Math.min(targetW - 1, Math.floor(x * fx));
      const si = (y * w + x) * 4;
      sum[di * 3] += data[si]; sum[di * 3 + 1] += data[si + 1]; sum[di * 3 + 2] += data[si + 2];
      cnt[di] += 1;
    }
  }
  const out = new Uint8Array(targetW * targetH * 3);
  for (let i = 0; i < targetW * targetH; i++) {
    const c = cnt[i] || 1;
    out[i * 3] = Math.round(sum[i * 3] / c);
    out[i * 3 + 1] = Math.round(sum[i * 3 + 1] / c);
    out[i * 3 + 2] = Math.round(sum[i * 3 + 2] / c);
  }
  return out;
}

/**
 * Zero the alpha of everything the QA verdict did not keep. The keep mask is on
 * the coarse QA grid, so it is dilated by 2 cells first: a fine edge that fell
 * just outside a coarse cell is never shaved off.
 */
export function applyKeepMask(img: Rgba, keep: Uint8Array, dsW: number, dsH: number): void {
  const grown = new Uint8Array(keep.length);
  const R = 2;
  for (let y = 0; y < dsH; y++) {
    for (let x = 0; x < dsW; x++) {
      if (!keep[y * dsW + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= dsH) continue;
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < dsW) grown[ny * dsW + nx] = 1;
        }
      }
    }
  }
  const { width: w, height: h, data } = img;
  const fx = dsW / w, fy = dsH / h;
  for (let y = 0; y < h; y++) {
    const row = Math.min(dsH - 1, Math.floor(y * fy)) * dsW;
    for (let x = 0; x < w; x++) {
      if (!grown[row + Math.min(dsW - 1, Math.floor(x * fx))]) data[(y * w + x) * 4 + 3] = 0;
    }
  }
}

export interface Box { x: number; y: number; w: number; h: number }

/** Bounds of alpha > 0, grown by `pad` of the long side, clamped to the image. */
export function alphaBounds(img: Rgba, pad = TRIM_PAD, threshold = 8): Box | null {
  const { width: w, height: h, data } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const p = Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * pad);
  const x = Math.max(0, minX - p), y = Math.max(0, minY - p);
  return { x, y, w: Math.min(w - 1, maxX + p) - x + 1, h: Math.min(h - 1, maxY + p) - y + 1 };
}

/**
 * Resize a region of `src` to dw × dh, premultiplied so transparent pixels
 * never bleed their (meaningless) colour into the edge. Downscale = box
 * average (exact area coverage); upscale = bilinear.
 */
export function resizeRegion(src: Rgba, box: Box, dw: number, dh: number): Rgba {
  const out = new Uint8Array(dw * dh * 4);
  const s = src.data, sw = src.width;
  if (dw <= box.w && dh <= box.h) {
    const acc = new Float64Array(dw * dh * 4);
    const area = new Float64Array(dw * dh);
    const fx = dw / box.w, fy = dh / box.h;
    for (let y = 0; y < box.h; y++) {
      const dy = Math.min(dh - 1, Math.floor(y * fy)) * dw;
      const srow = ((box.y + y) * sw + box.x) * 4;
      for (let x = 0; x < box.w; x++) {
        const di = dy + Math.min(dw - 1, Math.floor(x * fx));
        const si = srow + x * 4;
        const a = s[si + 3];
        acc[di * 4] += s[si] * a; acc[di * 4 + 1] += s[si + 1] * a; acc[di * 4 + 2] += s[si + 2] * a;
        acc[di * 4 + 3] += a;
        area[di] += 1;
      }
    }
    for (let i = 0; i < dw * dh; i++) {
      const a = acc[i * 4 + 3];
      if (a > 0) {
        out[i * 4] = Math.round(acc[i * 4] / a);
        out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / a);
        out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / a);
      }
      out[i * 4 + 3] = Math.round(a / (area[i] || 1));
    }
    return { width: dw, height: dh, data: out };
  }
  const sx = box.w / dw, sy = box.h / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.max(0, Math.min(box.h - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(box.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.max(0, Math.min(box.w - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(box.w - 1, x0 + 1), tx = fx - x0;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [xx, yy, wgt] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
        const si = ((box.y + yy) * sw + box.x + xx) * 4;
        const pa = s[si + 3] * wgt;
        r += s[si] * pa; g += s[si + 1] * pa; b += s[si + 2] * pa; a += pa;
      }
      const di = (y * dw + x) * 4;
      if (a > 0) { out[di] = Math.round(r / a); out[di + 1] = Math.round(g / a); out[di + 2] = Math.round(b / a); }
      out[di + 3] = Math.round(a);
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Fade the alpha towards each cut side over `share` of that dimension (hero). */
export function fadeEdges(img: Rgba, sides: readonly Side[], share = HERO_FADE): void {
  if (sides.length === 0) return;
  const { width: w, height: h, data } = img;
  const fh = Math.max(1, Math.round(h * share)), fw = Math.max(1, Math.round(w * share));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 1;
      if (sides.includes("top") && y < fh) k = Math.min(k, y / fh);
      if (sides.includes("bottom") && y >= h - fh) k = Math.min(k, (h - 1 - y) / fh);
      if (sides.includes("left") && x < fw) k = Math.min(k, x / fw);
      if (sides.includes("right") && x >= w - fw) k = Math.min(k, (w - 1 - x) / fw);
      if (k < 1) {
        const i = (y * w + x) * 4 + 3;
        data[i] = Math.round(data[i] * k * k * (3 - 2 * k)); // smoothstep
      }
    }
  }
}

/**
 * The hero cut-out: trimmed to the piece (+2 %), long side ≤ cutoutMax (never
 * upscaled), cut sides faded. Returns null when nothing is visible.
 */
export function makeHeroCutout(img: Rgba, edges: readonly Side[], cutoutMax: number = CUTOUT_SIZES.cutoutMax): Rgba | null {
  const box = alphaBounds(img);
  if (!box) return null;
  // A cut side keeps no pad: the piece really ends at the frame.
  if (edges.includes("top")) { box.h += box.y; box.y = 0; }
  if (edges.includes("left")) { box.w += box.x; box.x = 0; }
  if (edges.includes("bottom")) box.h = img.height - box.y;
  if (edges.includes("right")) box.w = img.width - box.x;
  const scale = Math.min(1, cutoutMax / Math.max(box.w, box.h));
  const out = resizeRegion(img, box, Math.max(1, Math.round(box.w * scale)), Math.max(1, Math.round(box.h * scale)));
  fadeEdges(out, edges);
  return out;
}

/** Where the piece goes on a size × size ivory square (D5, D3). */
export function ivoryPlacement(pieceW: number, pieceH: number, edges: readonly Side[], size: number): Box & { scale: number } {
  const has = (s: Side) => edges.includes(s);
  let scale = Math.min((size * IVORY_FILL) / pieceW, (size * IVORY_FILL) / pieceH);
  // A piece cut on two opposite sides spans the square in that direction.
  if (has("top") && has("bottom")) scale = size / pieceH;
  else if (has("left") && has("right")) scale = size / pieceW;
  const w = pieceW * scale, h = pieceH * scale;
  let x = (size - w) / 2;
  let y = (size - h) / 2 - size * IVORY_LIFT;
  // A cut side is anchored to the canvas edge: the piece bleeds off, like a crop.
  if (has("top")) y = 0;
  else if (has("bottom")) y = size - h;
  if (has("left")) x = 0;
  else if (has("right")) x = size - w;
  return { x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), scale };
}

/**
 * The uniform catalogue image: flat chalk square, the piece at 80 % fill,
 * optically centred, one analytic contact shadow. No alpha in the result.
 * `piece` is the trimmed, UNFADED cut-out at full resolution.
 */
export function composeIvory(piece: Rgba, edges: readonly Side[], size: number): Rgba {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = IVORY[0]; out[i * 4 + 1] = IVORY[1]; out[i * 4 + 2] = IVORY[2]; out[i * 4 + 3] = 255;
  }
  const place = ivoryPlacement(piece.width, piece.height, edges, size);

  // Contact shadow under the base — skipped when the base is cut by the frame.
  if (!edges.includes("bottom")) {
    const cx = place.x + place.w / 2, cy = place.y + place.h;
    const rx = (place.w * SHADOW_WIDTH) / 2, ry = Math.max(1, (place.w * SHADOW_HEIGHT) / 2);
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(size - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(size - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= 1) continue;
        const a = SHADOW_OPACITY * (1 - d);
        const i = (y * size + x) * 4;
        out[i] = Math.round(out[i] * (1 - a) + SHADOW_RGB[0] * a);
        out[i + 1] = Math.round(out[i + 1] * (1 - a) + SHADOW_RGB[1] * a);
        out[i + 2] = Math.round(out[i + 2] * (1 - a) + SHADOW_RGB[2] * a);
      }
    }
  }

  const scaled = resizeRegion(piece, { x: 0, y: 0, w: piece.width, h: piece.height }, place.w, place.h);
  const sd = scaled.data;
  for (let y = 0; y < place.h; y++) {
    const ty = place.y + y;
    if (ty < 0 || ty >= size) continue;
    for (let x = 0; x < place.w; x++) {
      const tx = place.x + x;
      if (tx < 0 || tx >= size) continue;
      const si = (y * place.w + x) * 4;
      const a = sd[si + 3] / 255;
      if (a === 0) continue;
      const di = (ty * size + tx) * 4;
      out[di] = Math.round(sd[si] * a + out[di] * (1 - a));
      out[di + 1] = Math.round(sd[si + 1] * a + out[di + 1] * (1 - a));
      out[di + 2] = Math.round(sd[si + 2] * a + out[di + 2] * (1 - a));
    }
  }
  return { width: size, height: size, data: out };
}

/** Halve an opaque square exactly (2×2 box) — the 800 from the 1600. */
export function halve(img: Rgba): Rgba {
  const w = Math.floor(img.width / 2), h = Math.floor(img.height / 2);
  const s = img.data, sw = img.width;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((2 * y) * sw + 2 * x) * 4, b = a + 4, c = a + sw * 4, d = c + 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (s[a + k] + s[b + k] + s[c + k] + s[d + k] + 2) >> 2;
    }
  }
  return { width: w, height: h, data: out };
}

/** Trimmed piece (no pad, no fade) for the ivory composite. */
export function trimPiece(img: Rgba, edges: readonly Side[]): Rgba | null {
  const box = alphaBounds(img, 0);
  if (!box) return null;
  if (edges.includes("top")) { box.h += box.y; box.y = 0; }
  if (edges.includes("left")) { box.w += box.x; box.x = 0; }
  if (edges.includes("bottom")) box.h = img.height - box.y;
  if (edges.includes("right")) box.w = img.width - box.x;
  const out = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4;
    out.set(img.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return { width: box.w, height: box.h, data: out };
}
