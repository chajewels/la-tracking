import { describe, expect, it } from "vitest";
import {
  MONEY_EPSILON,
  validateAllocations,
  validateSingleAmount,
} from "../../supabase/functions/_shared/payment-validation.ts";

/**
 * Audit F04 — payment allocation validation.
 *
 * The module under test lives in supabase/functions/_shared/ and is imported
 * here by relative path on purpose: it is the SAME file the edge functions
 * run, not a copy. It is pure by construction (no Deno globals, no Supabase
 * client) precisely so this import works.
 *
 * The case that started it: a batch of +100 and -50 sums to 50, so the old
 * `Math.abs(totalAllocated - total_amount_paid) > 1` check passed against a
 * declared total of 50. The loop then hit `if (amount <= 0) continue`, silently
 * dropped the -50 leg, and submitted 100. The customer was recorded as paying
 * twice what the batch said.
 */

const ok = (over: Partial<{ account_id: string; amount: number; currency: string }> = {}) => ({
  account_id: over.account_id ?? "acct-1",
  amount: over.amount ?? 100,
  currency: over.currency ?? "PHP",
});

describe("validateAllocations — the F04 case", () => {
  it("rejects the +100 / -50 pair that nets to a matching total", () => {
    expect(() =>
      validateAllocations(
        [ok({ account_id: "a", amount: 100 }), ok({ account_id: "b", amount: -50 })],
        50,
        "PHP",
      ),
    ).toThrow(/must be greater than 0/);
  });

  it("names the offending account rather than failing generically", () => {
    expect(() =>
      validateAllocations(
        [ok({ account_id: "a", amount: 100 }), ok({ account_id: "bad-acct", amount: -50 })],
        50,
        "PHP",
      ),
    ).toThrow(/bad-acct/);
  });
});

describe("validateAllocations — amount sanity", () => {
  it("rejects a single negative amount", () => {
    expect(() => validateAllocations([ok({ amount: -1 })], 1, "PHP")).toThrow(
      /must be greater than 0/,
    );
  });

  it("rejects zero", () => {
    expect(() => validateAllocations([ok({ amount: 0 })], 100, "PHP")).toThrow(
      /must be greater than 0/,
    );
  });

  it("rejects NaN — a bare comparison never catches it", () => {
    // Guard the premise: NaN passes BOTH ordering tests, which is why an
    // explicit finite check is required rather than `amount <= 0`.
    expect(NaN <= 0).toBe(false);
    expect(NaN > 0).toBe(false);
    expect(() => validateAllocations([ok({ amount: NaN })], 100, "PHP")).toThrow(
      /must be a finite number/,
    );
  });

  it("rejects Infinity", () => {
    expect(() => validateAllocations([ok({ amount: Infinity })], 100, "PHP")).toThrow(
      /must be a finite number/,
    );
    expect(() => validateAllocations([ok({ amount: -Infinity })], 100, "PHP")).toThrow(
      /must be a finite number/,
    );
  });

  it("rejects a non-numeric string", () => {
    expect(() =>
      validateAllocations(
        [{ account_id: "a", amount: "abc" as unknown as number, currency: "PHP" }],
        100,
        "PHP",
      ),
    ).toThrow(/must be a finite number/);
  });
});

describe("validateAllocations — currency precision (DECIMAL RULES)", () => {
  it("rejects JPY with decimals", () => {
    expect(() => validateAllocations([ok({ amount: 100.5, currency: "JPY" })], 100.5, "JPY")).toThrow(
      /whole number of yen/,
    );
  });

  it("accepts whole yen", () => {
    expect(() =>
      validateAllocations([ok({ amount: 1000, currency: "JPY" })], 1000, "JPY"),
    ).not.toThrow();
  });

  it("rejects PHP with 3 decimal places", () => {
    expect(() => validateAllocations([ok({ amount: 10.555 })], 10.555, "PHP")).toThrow(
      /at most 2 decimal places/,
    );
  });

  it("accepts PHP with exactly 2 decimal places", () => {
    expect(() => validateAllocations([ok({ amount: 10.55 })], 10.55, "PHP")).not.toThrow();
  });

  it("does not mistake binary float noise for extra precision", () => {
    // 0.1 + 0.2 === 0.30000000000000004. That is 30 centavos, not 3 decimals.
    const noisy = 0.1 + 0.2;
    expect(noisy).not.toBe(0.3);
    expect(() => validateAllocations([ok({ amount: noisy })], noisy, "PHP")).not.toThrow();
  });
});

describe("validateAllocations — batch shape", () => {
  it("rejects an empty allocation list", () => {
    expect(() => validateAllocations([], 100, "PHP")).toThrow(/At least one payment allocation/);
  });

  it("rejects a duplicate account_id", () => {
    expect(() =>
      validateAllocations(
        [ok({ account_id: "dup", amount: 50 }), ok({ account_id: "dup", amount: 50 })],
        100,
        "PHP",
      ),
    ).toThrow(/Duplicate allocation for account dup/);
  });

  it("rejects a mixed-currency batch", () => {
    expect(() =>
      validateAllocations(
        [
          ok({ account_id: "a", amount: 100, currency: "PHP" }),
          ok({ account_id: "b", amount: 100, currency: "JPY" }),
        ],
        200,
        "PHP",
      ),
    ).toThrow(/must share one currency/);
  });
});

describe("validateAllocations — total_amount_paid is REQUIRED", () => {
  it("rejects a missing total", () => {
    expect(() => validateAllocations([ok()], undefined, "PHP")).toThrow(
      /total_amount_paid is required/,
    );
    expect(() => validateAllocations([ok()], null, "PHP")).toThrow(
      /total_amount_paid is required/,
    );
  });

  it("rejects a non-finite total", () => {
    expect(() => validateAllocations([ok()], NaN, "PHP")).toThrow(/must be a finite number/);
  });

  it("rejects a zero or negative total", () => {
    // 0 is the case the old `if (total_amount_paid && …)` prefix swallowed:
    // falsy, so the cross-check was skipped entirely.
    expect(() => validateAllocations([ok()], 0, "PHP")).toThrow(/must be greater than 0/);
    expect(() => validateAllocations([ok()], -5, "PHP")).toThrow(/must be greater than 0/);
  });
});

describe("validateAllocations — sum vs total, on MONEY_EPSILON not ±1", () => {
  it("rejects a mismatch beyond epsilon", () => {
    expect(() => validateAllocations([ok({ amount: 100 })], 150, "PHP")).toThrow(
      /does not match total_amount_paid/,
    );
  });

  it("rejects a mismatch the OLD ±1 tolerance would have accepted", () => {
    // 0.99 off. Under `Math.abs(diff) > 1` this passed and was booked.
    expect(() => validateAllocations([ok({ amount: 100 })], 100.99, "PHP")).toThrow(
      /does not match total_amount_paid/,
    );
  });

  it("PASSES a difference within epsilon", () => {
    expect(MONEY_EPSILON).toBe(0.01);
    // 0.004 apart — well inside epsilon, the kind of gap float arithmetic
    // leaves behind. Must not be treated as a mismatch.
    expect(() => validateAllocations([ok({ amount: 100 })], 100.004, "PHP")).not.toThrow();
  });

  it("treats a gap of exactly 0.01 as a mismatch (strict <, mirrors moneyEqual)", () => {
    expect(() => validateAllocations([ok({ amount: 100 })], 100.01, "PHP")).toThrow(
      /does not match total_amount_paid/,
    );
  });

  it("accepts a valid multi-account batch", () => {
    expect(() =>
      validateAllocations(
        [
          ok({ account_id: "a", amount: 1500.25 }),
          ok({ account_id: "b", amount: 2300.75 }),
          ok({ account_id: "c", amount: 199.0 }),
        ],
        4000.0,
        "PHP",
      ),
    ).not.toThrow();
  });

  it("sums in integer cents, so repeated thirds do not drift", () => {
    // 33.33 × 3 = 99.99, which is 0.01 from 100.00 — a real mismatch, not
    // float noise, and it must be reported as one.
    expect(() =>
      validateAllocations(
        [
          ok({ account_id: "a", amount: 33.33 }),
          ok({ account_id: "b", amount: 33.33 }),
          ok({ account_id: "c", amount: 33.33 }),
        ],
        100,
        "PHP",
      ),
    ).toThrow(/does not match total_amount_paid/);
  });
});

describe("validateSingleAmount — record-payment path", () => {
  it("rejects missing, NaN, Infinity, zero and negative", () => {
    expect(() => validateSingleAmount(undefined, "PHP")).toThrow(/is required/);
    expect(() => validateSingleAmount(NaN, "PHP")).toThrow(/finite number/);
    expect(() => validateSingleAmount(Infinity, "PHP")).toThrow(/finite number/);
    expect(() => validateSingleAmount(0, "PHP")).toThrow(/greater than 0/);
    expect(() => validateSingleAmount(-10, "PHP")).toThrow(/greater than 0/);
  });

  it("applies currency precision", () => {
    expect(() => validateSingleAmount(100.5, "JPY")).toThrow(/whole number of yen/);
    expect(() => validateSingleAmount(10.555, "PHP")).toThrow(/at most 2 decimal places/);
    expect(() => validateSingleAmount(10.55, "PHP")).not.toThrow();
    expect(() => validateSingleAmount(1000, "JPY")).not.toThrow();
  });

  it("uses the field name it is given, so the caller's error names the field", () => {
    expect(() => validateSingleAmount(-1, "PHP", "submitted_amount")).toThrow(/submitted_amount/);
  });
});
