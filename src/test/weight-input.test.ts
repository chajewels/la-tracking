import { describe, expect, it } from "vitest";
import { formatWeight, parseWeight } from "@/components/website/ProductDialog";

describe("Weight (grams) input — 2 decimals, no spinner (owner 2026-10-02)", () => {
  it("shows two decimals and keeps the trailing zero", () => {
    expect(formatWeight(2.5)).toBe("2.50");
    expect(formatWeight(16.2)).toBe("16.20");
    expect(formatWeight(null)).toBe("");
  });
  it("parses while typing: empty → null, partial → kept, junk → refused", () => {
    expect(parseWeight("")).toBeNull();
    expect(parseWeight("2.")).toBe(2);
    expect(parseWeight("2.50")).toBe(2.5);
    expect(parseWeight("2.505")).toBeUndefined();
    expect(parseWeight("abc")).toBeUndefined();
    expect(parseWeight("-1")).toBeUndefined();
  });
});
