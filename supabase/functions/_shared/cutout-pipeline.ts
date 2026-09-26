// One finished provider job → verdict + stored files (docs/MEDIA-CUTOUTS.md).
// Decode (WASM) → QA (cutout-qa.ts) → trim / fade / ivory (cutout-image.ts)
// → encode WebP (WASM). Every step is timed; the worker writes the timings to
// the row so the 2 s CPU limit is watched in production, not assumed.

import { decodeImage, encodeWebp } from "./cutout-codecs.ts";
import {
  alphaChannel, applyKeepMask, composeIvory, CUTOUT_SIZES, CUTOUT_SIZES_PATH_A, downsampleRgb, halve, makeHeroCutout, type Rgba,
  trimPiece,
} from "./cutout-image.ts";

export { CUTOUT_SIZES_PATH_A };
import { checkCutout, downsampleAlpha, type QaResult } from "./cutout-qa.ts";

export interface PipelineOptions {
  allowPairs: boolean;
  /**
   * D10. "baked" (default) stores cut-out + ivory squares. "cutout_only" is
   * D10 path B: the storefront draws the chalk well itself; the Hub stores
   * only the cut-out. Sizes come from CUTOUT_SIZES unless overridden (path A).
   */
  output?: "baked" | "cutout_only";
  sizes?: { cutoutMax: number; catalog: number; catalogSmall: number };
  /** Photoroom's x-uncertainty-score for this result (null = none given). */
  providerUncertainty?: number | null;
}

export interface PipelineResult {
  qa: QaResult;
  sourceWidth: number;
  sourceHeight: number;
  cutout: { bytes: Uint8Array; width: number; height: number } | null;
  catalog: { bytes: Uint8Array; width: number; height: number } | null;
  catalogSmall: { bytes: Uint8Array; width: number; height: number } | null;
  timingsMs: Record<string, number>;
}

export const CUTOUT_QUALITY = 85;
export const CATALOG_QUALITY = 82;

/**
 * `providerBytes`: the provider's RGBA cut-out (PNG/WebP, same framing as the
 * original). `originalBytes`: the photo as stored in promotions/ — used for
 * its true size and the fine-detail check. Pixels of the original are never
 * written anywhere.
 */
export async function runPipeline(
  providerBytes: Uint8Array,
  originalBytes: Uint8Array,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const t: Record<string, number> = {};
  let mark = performance.now();
  const lap = (k: string) => { const now = performance.now(); t[k] = Math.round((now - mark) * 10) / 10; mark = now; };
  const sizes = opts.sizes ?? CUTOUT_SIZES;

  const cut = await decodeImage(providerBytes);
  lap("decode_cutout");
  const orig = await decodeImage(originalBytes);
  lap("decode_original");

  const cutAlpha = { width: cut.width, height: cut.height, alpha: alphaChannel(cut) };
  const ds = downsampleAlpha(cutAlpha);
  // The provider returns the original's framing; if it did not (a scaled
  // result), the detail check is skipped rather than comparing wrong grids.
  const sameFrame = Math.abs(cut.width / cut.height - orig.width / orig.height) < 0.01;
  const original = sameFrame
    ? { width: ds.width, height: ds.height, rgb: downsampleRgb(orig, ds.width, ds.height) }
    : null;
  const qa = checkCutout({
    cutout: cutAlpha,
    sourceWidth: orig.width,
    sourceHeight: orig.height,
    original,
    allowPairs: opts.allowPairs,
    providerUncertainty: opts.providerUncertainty ?? null,
  });
  lap("qa");

  if (qa.keep) applyKeepMask(cut, qa.keep, qa.dsWidth, qa.dsHeight);
  const hero = makeHeroCutout(cut, qa.edges, sizes.cutoutMax);
  lap("trim_cutout");
  const cutoutBytes = hero ? await encodeWebp(hero, CUTOUT_QUALITY, true) : null;
  lap("encode_cutout");

  let catalog: PipelineResult["catalog"] = null;
  let catalogSmall: PipelineResult["catalogSmall"] = null;
  if (opts.output !== "cutout_only") {
    const piece = trimPiece(cut, qa.edges);
    if (piece) {
      const big = composeIvory(piece, qa.edges, sizes.catalog);
      const small = sizes.catalogSmall * 2 === sizes.catalog ? halve(big) : composeIvory(piece, qa.edges, sizes.catalogSmall);
      lap("compose_ivory");
      catalog = { bytes: await encodeWebp(big, CATALOG_QUALITY, false), width: big.width, height: big.height };
      lap("encode_catalog");
      catalogSmall = { bytes: await encodeWebp(small, CATALOG_QUALITY, false), width: small.width, height: small.height };
      lap("encode_catalog_small");
    }
  }

  t.total = Object.values(t).reduce((a, b) => a + b, 0);
  return {
    qa,
    sourceWidth: orig.width,
    sourceHeight: orig.height,
    cutout: hero && cutoutBytes ? { bytes: cutoutBytes, width: hero.width, height: hero.height } : null,
    catalog,
    catalogSmall,
    timingsMs: t,
  };
}

export type { Rgba };
