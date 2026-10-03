import { describe, expect, it } from "vitest";
import { parsePhpJpyRate, rateAsOf } from "../../supabase/functions/_shared/php-jpy-rate.ts";

// ONE PESO RATE (owner decision 2026-10-03): the website reads the Hub's
// system_settings.php_jpy_rate. The same file the website and
// cart-reminder-sweep edge functions import.

describe("parsePhpJpyRate — the Hub's php_jpy_rate, as stored", () => {
  it.each([
    ['"0.42"', 0.42],   // the live storage: a JSON string
    ["0.42", 0.42],
    [0.42, 0.42],
    [" 0.397199 ", 0.397199],
  ])("%s → %s", (raw, want) => expect(parsePhpJpyRate(raw)).toBe(want));

  it.each([[null], [undefined], [""], ['""'], ["abc"], [0], [-1], [1], [42], [true], [{}]])(
    "unusable %s → null (fail closed, never a fallback)", (raw) => expect(parsePhpJpyRate(raw)).toBeNull(),
  );
});

describe("rateAsOf — the PHT day the setting last changed", () => {
  it("formats a timestamp in Asia/Manila", () => {
    expect(rateAsOf("2026-10-02T17:30:00Z")).toBe("2026-10-03");
  });
  it("falls back to today for a missing timestamp", () => {
    expect(rateAsOf(null)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
