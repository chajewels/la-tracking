/**
 * Splits a list into consecutive slices of at most `size` items, in order.
 * Used to keep PostgREST `.in()` filters under the gateway's 16 KB URL limit
 * (website catalog list, 2026-10-15). Kept free of Deno APIs so
 * src/test/chunk.test.ts can import it.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
