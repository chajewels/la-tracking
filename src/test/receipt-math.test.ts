import { describe, expect, it } from "vitest";
import {
  cancelReason, cleanReceiptDetails, includedTax, isReissue, methodLabel, normaliseVerifyCode, purposeFor,
  readReceiptSwitch, receiptDate, receiptMinus, receiptMoney, receiptNumber, receiptTotals, showItemAmounts, switchAllowsIssue,
  DEFAULT_PURPOSE,
} from "../../supabase/functions/_shared/receipt-math.ts";

// WEBSITE RECEIPTS (owner 2026-10-27, docs/RECEIPTS.md). The SQL twin
// (web_receipt_snapshot) is proven by supabase/tests/website-receipts/; these
// cases pin the same numbers on the TypeScript side.

describe("消費税（10%） = round(product amount × 10 / 110), every amount already tax-included", () => {
  it.each([
    [100000, 9091],   // owner example
    [91950, 8359],
    [30000, 2727],
    [1100, 100],
    [11, 1],
    [5.5, 1],         // exactly .5 → up
    [16.5, 2],        // 1.5 → 2
    [0, 0],
    [-5, 0],
    [42000, 3818],
    [43000, 3909],
  ])("%s → %s", (taxable, tax) => expect(includedTax(taxable)).toBe(tax));
});

describe("the totals block (owner 2026-10-27: tax on the products, discount after tax, shipping after tax)", () => {
  const zero = { discount: 0, points: 0, shipping: 0, codFee: 0, penalties: 0 };

  it("owner example: ¥100,000, no discount, no shipping", () => {
    expect(receiptTotals({ ...zero, productAmount: 100000, received: 100000 })).toEqual({
      subtotal: 90909, tax: 9091, discount: 0, shipping: 0, codFee: 0, penalties: 0, total: 100000, addsUp: true,
    });
  });

  it("discount (coupon 5,000 + points 3,000), shipping 800, COD fee 1,150 on ¥98,000 of products", () => {
    // 89,091 + 8,909 − 8,000 + 800 + 1,150 = 91,950
    expect(receiptTotals({ productAmount: 98000, discount: 5000, points: 3000, shipping: 800, codFee: 1150, penalties: 0, received: 91950 }))
      .toEqual({ subtotal: 89091, tax: 8909, discount: 8000, shipping: 800, codFee: 1150, penalties: 0, total: 91950, addsUp: true });
  });

  it("layaway with a late fee: the fee is its own line, no tax on it", () => {
    expect(receiptTotals({ ...zero, productAmount: 100000, penalties: 1000, received: 101000 }))
      .toEqual({ subtotal: 90909, tax: 9091, discount: 0, shipping: 0, codFee: 0, penalties: 1000, total: 101000, addsUp: true });
  });

  it("peso order: every figure in pesos, no yen", () => {
    expect(receiptTotals({ ...zero, productAmount: 42000, shipping: 3500, received: 45500 }))
      .toEqual({ subtotal: 38182, tax: 3818, discount: 0, shipping: 3500, codFee: 0, penalties: 0, total: 45500, addsUp: true });
  });

  it("does not add up → flagged, never forced (an overpayment, lines edited at Confirm, no item lines)", () => {
    expect(receiptTotals({ ...zero, productAmount: 42000, received: 43000 }).addsUp).toBe(false);
    expect(receiptTotals({ ...zero, productAmount: 45000, received: 50000 }).addsUp).toBe(false);
    expect(receiptTotals({ ...zero, productAmount: 0, received: 0 }).addsUp).toBe(false);
  });

  it("the discount line is always a minus, even at zero", () => {
    expect(receiptMinus(0, "JPY")).toBe("\u2212¥0");
    expect(receiptMinus(8000, "JPY")).toBe("\u2212¥8,000");
    expect(receiptMinus(1000, "PHP")).toBe("\u2212PHP 1,000");
  });
});

describe("numbering", () => {
  it("CJR-<JST year>-NNNNNN", () => {
    expect(receiptNumber(1, new Date("2026-10-27T03:00:00Z"))).toBe("CJR-2026-000001");
    expect(receiptNumber(123456, new Date("2026-10-27T03:00:00Z"))).toBe("CJR-2026-123456");
  });
  it("the year is Japan's: 31 Dec 16:00 UTC is already 1 Jan in Tokyo", () => {
    expect(receiptNumber(7, new Date("2026-12-31T16:00:00Z"))).toBe("CJR-2027-000007");
    expect(receiptNumber(7, new Date("2026-12-31T14:59:59Z"))).toBe("CJR-2026-000007");
  });
  it("verify codes are 40 hex characters, case-insensitive", () => {
    const c = "a".repeat(40);
    expect(normaliseVerifyCode(c.toUpperCase())).toBe(c);
    expect(normaliseVerifyCode("abc")).toBeNull();
    expect(normaliseVerifyCode("g".repeat(40))).toBeNull();
  });
});

describe("reissue flag", () => {
  it("first download is the original, every later one 再発行", () => {
    expect(isReissue(1)).toBe(false);
    expect(isReissue(2)).toBe(true);
    expect(isReissue(9)).toBe(true);
  });
});

describe("cancellation (mirror of web_receipt_sync)", () => {
  const ok = { status: "completed", refunds: 0, disputed: false, fullyPaid: true, addsUp: true, ownerChanged: false, figuresChanged: false };
  it("unchanged → kept", () => expect(cancelReason(ok)).toBeNull());
  it.each([
    [{ status: "pending" }, "not_completed"],
    [{ status: "cancelled" }, "not_completed"],
    [{ refunds: 1 }, "refunded"],
    [{ disputed: true }, "disputed"],
    [{ fullyPaid: false }, "not_fully_paid"],
    [{ addsUp: false }, "does_not_add_up"],
    [{ ownerChanged: true }, "owner_changed"],
    [{ figuresChanged: true }, "figures_changed"],
  ])("%o → %s", (patch, reason) => expect(cancelReason({ ...ok, ...patch })).toBe(reason));
});

describe("the switch", () => {
  const live = new Date("2026-11-01T00:00:00Z");
  const after = new Date("2026-11-02T00:00:00Z");
  const before = new Date("2026-10-31T00:00:00Z");
  it("off issues nothing", () => expect(switchAllowsIssue("off", live, after, false)).toBe(false));
  it("on: real orders only", () => {
    expect(switchAllowsIssue("on", live, after, false)).toBe(true);
    expect(switchAllowsIssue("on", live, after, true)).toBe(false);
  });
  it("test: TEST- orders only", () => {
    expect(switchAllowsIssue("test", live, after, true)).toBe(true);
    expect(switchAllowsIssue("test", live, after, false)).toBe(false);
  });
  it("completed before the switch went on: never", () => expect(switchAllowsIssue("on", live, before, false)).toBe(false));
  it("reads fail closed", () => {
    expect(readReceiptSwitch('"on"')).toBe("on");
    expect(readReceiptSwitch("test")).toBe("test");
    expect(readReceiptSwitch("ON")).toBe("off");
    expect(readReceiptSwitch(null)).toBe("off");
  });
});

describe("addressee and purpose", () => {
  it("trimmed; empty addressee = none; empty purpose = お品代として", () => {
    expect(cleanReceiptDetails("  株式会社テスト ", "")).toEqual({ addressee: "株式会社テスト", purpose: DEFAULT_PURPOSE });
  });
  it("limits", () => {
    expect(cleanReceiptDetails("あ".repeat(61), "x")).toEqual({ error: "addressee_too_long" });
    expect(cleanReceiptDetails("A", "x".repeat(41))).toEqual({ error: "purpose_too_long" });
    expect(cleanReceiptDetails("A\nB", "x")).toEqual({ error: "invalid_characters" });
  });
  it("the default purpose prints in English as 'Payment for goods'", () => {
    expect(purposeFor(DEFAULT_PURPOSE, "en")).toBe("Payment for goods");
    expect(purposeFor(DEFAULT_PURPOSE, "ja")).toBe("お品代として");
    expect(purposeFor("Ring repair", "en")).toBe("Ring repair");
  });
});

describe("printing", () => {
  it("yen with ¥, pesos with the ISO code (never ₱)", () => {
    expect(receiptMoney(100000, "JPY")).toBe("¥100,000");
    expect(receiptMoney(42000, "PHP")).toBe("PHP 42,000");
    expect(receiptMoney(42000.5, "PHP")).toBe("PHP 42,000.50");
    expect(receiptMoney(-3000, "JPY")).toBe("-¥3,000");
  });
  it("dates are Japan's", () => {
    expect(receiptDate("2026-10-27T16:00:00Z", "ja")).toBe("2026年10月28日");
    expect(receiptDate("2026-10-27T16:00:00Z", "en")).toBe("28 October 2026");
  });
  it("method names", () => {
    expect(methodLabel("cod", "ja")).toBe("代金引換");
    expect(methodLabel("square", "en")).toBe("Credit card");
    expect(methodLabel("store_credit", "ja")).toBe("ストアクレジット");
    expect(methodLabel("bdo", "en")).toBe("Bank transfer");
    expect(methodLabel("Some Bank", "en")).toBe("Some Bank");
  });
  it("item amounts only on a yen receipt whose lines add up to the goods total", () => {
    const items = [{ title: "A", quantity: 1, line_total_jpy: 60000 }, { title: "B", quantity: 2, line_total_jpy: 38000 }];
    expect(showItemAmounts(items, 98000, "JPY")).toBe(true);
    expect(showItemAmounts(items, 99000, "JPY")).toBe(false);
    expect(showItemAmounts(items, 98000, "PHP")).toBe(false);
  });
});
