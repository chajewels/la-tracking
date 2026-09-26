// Image decode / encode for the cut-out worker (docs/MEDIA-CUTOUTS.md).
// jSquash (Squoosh's WASM codecs) from esm.sh — the repo's import style. The
// pixel work between decode and encode is in _shared/cutout-image.ts.
//
// jSquash expects the browser's ImageData; Deno has none, so a minimal shape
// is provided before any codec runs.

import decodePng from "https://esm.sh/@jsquash/png@3.1.1/decode.js";
import decodeJpeg from "https://esm.sh/@jsquash/jpeg@1.6.0/decode.js";
import decodeWebp from "https://esm.sh/@jsquash/webp@1.5.0/decode.js";
import encodeWebpRaw from "https://esm.sh/@jsquash/webp@1.5.0/encode.js";
import type { Rgba } from "./cutout-image.ts";

type ImageDataCtor = new (data: Uint8ClampedArray, width: number, height: number) => object;
const g = globalThis as unknown as { ImageData?: ImageDataCtor };
if (typeof g.ImageData === "undefined") {
  g.ImageData = class ImageData {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  };
}

export type ImageKind = "png" | "jpeg" | "webp";

export function sniff(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return null;
}

export async function decodeImage(bytes: Uint8Array): Promise<Rgba> {
  const kind = sniff(bytes);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // jSquash's own ImageData typing differs between its packages; only the
  // three fields below are read.
  let img: { width: number; height: number; data: ArrayLike<number> & Uint8ClampedArray };
  if (kind === "png") img = await decodePng(buf) as unknown as typeof img;
  else if (kind === "jpeg") img = await decodeJpeg(buf) as unknown as typeof img;
  else if (kind === "webp") img = await decodeWebp(buf) as unknown as typeof img;
  else throw new Error("unsupported_image_format");
  return { width: img.width, height: img.height, data: img.data };
}

/** Lossy WebP. With `alpha` the transparency is kept (the hero cut-out). */
export async function encodeWebp(img: Rgba, quality: number, alpha: boolean): Promise<Uint8Array> {
  const data = img.data instanceof Uint8ClampedArray
    ? img.data
    : new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const imageData = new (g.ImageData as ImageDataCtor)(data, img.width, img.height) as Parameters<typeof encodeWebpRaw>[0];
  const out = await encodeWebpRaw(imageData, {
    quality,
    alpha_quality: alpha ? 90 : 100,
    exact: 0,
    method: 4,
  });
  return new Uint8Array(out);
}
