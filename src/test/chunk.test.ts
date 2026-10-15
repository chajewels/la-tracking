import { describe, expect, it } from "vitest";
import { chunk } from "../../supabase/functions/_shared/chunk.ts";

describe("chunk (website catalog list batching, 2026-10-15)", () => {
  it("splits in order into slices of at most n", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no slices for an empty list (no request issued)", () => {
    expect(chunk([], 150)).toEqual([]);
  });

  it("keeps every item exactly once for the 406-product catalogue at 150 per batch", () => {
    const ids = Array.from({ length: 406 }, (_, i) => `id-${i}`);
    const parts = chunk(ids, 150);
    expect(parts.map((p) => p.length)).toEqual([150, 150, 106]);
    expect(parts.flat()).toEqual(ids);
  });

  it("a list exactly the batch size is one slice", () => {
    expect(chunk(["a", "b"], 2)).toEqual([["a", "b"]]);
  });

  it("refuses a size that would loop forever or drop items", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });
});
