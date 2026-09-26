// Builds src/test/fixtures/media-cutouts-fal-live.json from the REAL fal.ai
// BiRefNet results of the 2026-09-27 "Test 30" batch (docs/MEDIA-CUTOUTS.md
// "INTERIOR HOLES"). Read-only: it GETs the originals and the stored masters
// from their public Storage URLs and writes one local file. It calls no
// provider and needs no key.
//
//   deno run --allow-net --allow-write=src/test/fixtures development/cutout-fal-fixtures.ts
//
// Each entry: the master's alpha downsampled to 512 px (gzip, base64) and the
// original on the QA grid the checks derive from that alpha — produced with
// the worker's own decoders and downsamplers, so the test sees what the worker
// would. Pass --all to also print a verdict table for every photo in CASES.

import { gzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { decodeImage } from "../supabase/functions/_shared/cutout-codecs.ts";
import { alphaChannel, downsampleRgb } from "../supabase/functions/_shared/cutout-image.ts";
import { checkCutout, downsampleAlpha } from "../supabase/functions/_shared/cutout-qa.ts";

const STORAGE = "https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/";

/** name → [original path, derived dir (sha256 of the original, first 32 hex), run]. */
const CASES: Record<string, [string, string, number]> = {
  c1395: ["website/page365/80288116/450589077-1758212309.jpeg", "f080dfe5babf94348c63a77ccf6cb2a6", 1],
  c0983: ["website/page365/80288104/450588971-1758211904.jpeg", "f1cc6f39a0b09fb9417aa0139f96ed8f", 1],
  c0983_r2: ["website/page365/80288104/450588971-1758211904.jpeg", "f1cc6f39a0b09fb9417aa0139f96ed8f", 2],
  r3341: ["website/0be8abc2-12d9-4c0e-b978-bf1a36fa2daf.jpeg", "8a23a7a0ccf7ab424f4281007b84eed3", 1],
  r7828: ["website/5137940f-f947-487d-b71b-50bcd057243a.jpeg", "79bfb049e5b7aaa4ebcc5a5bfae77f8a", 1],
  al112: ["website/page365/81333344/462264810-1773219921.jpeg", "881bfbc87686e431979077020379e89c", 1],
  al123: ["website/page365/79213257/437392479-1742360877.jpeg", "6a6e0681ec2c89579025cc37a000c838", 1],
  al3: ["website/page365/81580781/472533236-1777358458.jpeg", "e79a7c0b862287cae7becec920a7b562", 1],
};

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

const gz = (b: Uint8Array) => Buffer.from(gzipSync(b)).toString("base64");
const out: Record<string, unknown> = {};

for (const [name, [origPath, sha, run]] of Object.entries(CASES)) {
  const origUrl = STORAGE + origPath;
  const masterUrl = `${STORAGE}website/derived/${sha}/r${run}/master.png`;
  const [orig, master] = await Promise.all([get(origUrl).then(decodeImage), get(masterUrl).then(decodeImage)]);
  const a512 = downsampleAlpha({ width: master.width, height: master.height, alpha: alphaChannel(master) }, 512);
  const grid = downsampleAlpha(a512);
  const rgb = downsampleRgb(orig, grid.width, grid.height);
  out[name] = {
    sourceWidth: orig.width, sourceHeight: orig.height,
    alphaWidth: a512.width, alphaHeight: a512.height, alpha: gz(a512.alpha),
    rgb: gz(rgb), rgbWidth: grid.width, rgbHeight: grid.height,
    originalUrl: origUrl, masterUrl,
  };
  if (Deno.args.includes("--all")) {
    const qa = checkCutout({
      cutout: a512, sourceWidth: orig.width, sourceHeight: orig.height,
      original: { width: grid.width, height: grid.height, rgb },
    });
    console.log(name.padEnd(10), qa.status.padEnd(13), qa.flags.join(" "));
  }
}

await Deno.writeTextFile("src/test/fixtures/media-cutouts-fal-live.json", JSON.stringify(out) + "\n");
console.log("wrote", Object.keys(out).length, "fixtures");
