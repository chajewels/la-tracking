import { describe, expect, it, vi } from "vitest";
import { fetchJpyPhpMarketRate, formatMarketRate, plausibleRate } from "@/lib/marketRate";

/**
 * Today's market rate for the Payslips yen pre-fill (owner 2026-10-26). Primary open.er-api.com,
 * fallback frankfurter.dev, 8 s timeout each, only 0.2 < rate < 1.0, null when both fail —
 * never the system php_jpy_rate.
 */

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const bad = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

describe("market rate", () => {
  it("uses the primary source", async () => {
    const f = vi.fn((url: string) =>
      url.includes("open.er-api.com")
        ? ok({ result: "success", rates: { PHP: 0.4057 }, time_last_update_utc: "Mon, 26 Oct 2026 00:02:31 +0000" })
        : ok({}));
    const r = await fetchJpyPhpMarketRate(f);
    expect(r).toEqual({ php_per_jpy: 0.4057, source: "open.er-api.com", as_of: "Mon, 26 Oct 2026 00:02:31 +0000" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("https://open.er-api.com/v6/latest/JPY");
  });

  it("falls back to frankfurter when the primary fails", async () => {
    const f = vi.fn((url: string) =>
      url.includes("open.er-api.com") ? bad() : ok({ amount: 1, base: "JPY", date: "2026-10-26", rates: { PHP: 0.4061 } }));
    const r = await fetchJpyPhpMarketRate(f);
    expect(r).toEqual({ php_per_jpy: 0.4061, source: "frankfurter.dev", as_of: "2026-10-26" });
    expect(f.mock.calls[1][0]).toBe("https://api.frankfurter.dev/v1/latest?from=JPY&to=PHP");
  });

  it("returns null when both fail (never a stored or default rate)", async () => {
    const f = vi.fn(() => Promise.reject(new Error("offline")));
    expect(await fetchJpyPhpMarketRate(f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("refuses an out-of-band answer from either source", async () => {
    const f = vi.fn((url: string) => ok(url.includes("open.er-api") ? { rates: { PHP: 2.46 } } : { rates: { PHP: 0.1 } }));
    expect(await fetchJpyPhpMarketRate(f)).toBeNull();
    expect(plausibleRate(0.2)).toBeNull();
    expect(plausibleRate(1)).toBeNull();
    expect(plausibleRate("0.41")).toBe(0.41);
    expect(plausibleRate(undefined)).toBeNull();
  });

  it("times out a hanging source and moves on", async () => {
    const f = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (url.includes("open.er-api")) {
        return new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return ok({ date: "2026-10-26", rates: { PHP: 0.405 } });
    });
    const r = await fetchJpyPhpMarketRate(f, 20);
    expect(r?.source).toBe("frankfurter.dev");
  });

  it("formats up to 4 decimals", () => {
    expect(formatMarketRate(0.40571)).toBe("0.4057");
    expect(formatMarketRate(0.4)).toBe("0.40");
  });
});
