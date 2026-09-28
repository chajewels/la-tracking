import { describe, expect, it } from "vitest";
import { WORKING_MAX_PX, workingUrl } from "../../supabase/functions/_shared/media-cutout-rules.ts";

describe("workingUrl (NL366: bounded working copy for the provider and the process step)", () => {
  const base = "https://pfoicalpzdcmyxzvwyhz.supabase.co";
  it("maps a public storage photo to its image transformation, fit inside 1600², same format", () => {
    const src = `${base}/storage/v1/object/public/promotions/website/page365/76836010/408530636-1709884146.jpeg`;
    expect(workingUrl(src)).toBe(
      `${base}/storage/v1/render/image/public/promotions/website/page365/76836010/408530636-1709884146.jpeg` +
      `?width=${WORKING_MAX_PX}&height=${WORKING_MAX_PX}&resize=contain&format=origin`,
    );
    expect(WORKING_MAX_PX).toBeGreaterThanOrEqual(1200); // never below the largest stored output / hero minimum
  });
  it("leaves any other URL unchanged (external hosts, signed or already-transformed URLs)", () => {
    for (const u of [
      "https://example.com/photo.jpg",
      `${base}/storage/v1/object/sign/promotions/a.jpg?token=x`,
      `${base}/storage/v1/render/image/public/promotions/a.jpg?width=800`,
      `${base}/storage/v1/object/public/promotions/a.jpg?download=1`,
    ]) expect(workingUrl(u)).toBe(u);
  });
});
