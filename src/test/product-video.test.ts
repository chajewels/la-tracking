import { describe, expect, it } from "vitest";
import { VIDEO_MAX_BYTES, checkVideoFile } from "@/lib/product-video";

/** Product video (D2-1): MP4 only, one per product, size-capped. */
describe("checkVideoFile", () => {
  const f = (name: string, type: string, size: number) => ({ name, type, size });

  it("accepts an MP4 under the limit", () => {
    expect(checkVideoFile(f("R7828.mp4", "video/mp4", 8 * 1024 * 1024))).toEqual({ ok: true });
  });
  it("accepts a .mp4 the browser gave no type for", () => {
    expect(checkVideoFile(f("R7828.MP4", "", 1000))).toEqual({ ok: true });
  });
  it("refuses MOV, WebM and photos", () => {
    for (const [n, t] of [["a.mov", "video/quicktime"], ["a.webm", "video/webm"], ["a.jpg", "image/jpeg"]]) {
      const r = checkVideoFile(f(n, t, 1000));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Only MP4/);
    }
  });
  it("refuses an empty file and one over the limit", () => {
    expect(checkVideoFile(f("a.mp4", "video/mp4", 0)).ok).toBe(false);
    const big = checkVideoFile(f("a.mp4", "video/mp4", VIDEO_MAX_BYTES + 1));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toMatch(/limit is 45 MB/);
  });
});
