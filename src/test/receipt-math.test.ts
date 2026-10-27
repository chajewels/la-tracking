import { describe, expect, it } from "vitest";
import {
  cancelReason, cleanReceiptDetails, includedTax, isReissue, methodLabel, normaliseVerifyCode, purposeFor,
  pesoLines, readReceiptSwitch, receiptDate, receiptMinus, receiptMoney, receiptNumber, receiptTotals, switchAllowsIssue, unitPriceExTax,
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

describe("item rows excl. tax and the totals block (owner 2026-10-27, generate-invoice's rule)", () => {
  const none = { discount: 0, points: 0, shipping: 0, codFee: 0, penalties: 0 };
  const item = (unitPrice: number, quantity = 1) => ({ unitPrice, quantity, lineTotal: unitPrice * quantity });

  it("unit price excl. tax = Math.round(÷ 1.1)", () => {
    expect(unitPriceExTax(100000)).toBe(90909);
    expect(unitPriceExTax(60000)).toBe(54545);  // 54,545.45
    expect(unitPriceExTax(40000)).toBe(36364);  // 36,363.6
    expect(unitPriceExTax(19000)).toBe(17273);  // 17,272.7
    expect(unitPriceExTax(11)).toBe(10);
    expect(unitPriceExTax(5.5)).toBe(5);        // 5.0 exactly
    expect(unitPriceExTax(0.55)).toBe(1);       // 0.5 → up
  });

  it("1 item ¥100,000: unit/amount ¥90,909, subtotal ¥90,909, tax ¥9,091, total ¥100,000", () => {
    const t = receiptTotals({ currency: "JPY", items: [item(100000)], ...none, received: 100000 });
    expect(t.lines).toEqual([{ unitPriceEx: 90909, lineEx: 90909 }]);
    expect([t.subtotal, t.tax, t.discount, t.shipping, t.total, t.addsUp]).toEqual([90909, 9091, 0, 0, 100000, true]);
  });

  it("owner example, 2 items: K18 ¥54,545 + PT900 ¥36,364 = ¥90,909; tax ¥9,091; total ¥100,000", () => {
    const t = receiptTotals({ currency: "JPY", items: [item(60000), item(40000)], ...none, received: 100000 });
    expect(t.lines).toEqual([{ unitPriceEx: 54545, lineEx: 54545 }, { unitPriceEx: 36364, lineEx: 36364 }]);
    expect([t.subtotal, t.tax, t.total, t.addsUp]).toEqual([90909, 9091, 100000, true]);
  });

  it("3 items, qty 2 on one line, discount (coupon + points), shipping, COD fee", () => {
    // 30,000 + 2 × 19,000 + 30,000 = 98,000 incl. → excl. 27,273 + 34,546 + 27,273 = 89,092; tax 8,908
    // 89,092 + 8,908 − (5,000 + 3,000) + 800 + 1,150 = 91,950
    const t = receiptTotals({ currency: "JPY", items: [item(30000), item(19000, 2), item(30000)],
      discount: 5000, points: 3000, shipping: 800, codFee: 1150, penalties: 0, received: 91950 });
    expect(t.lines).toEqual([{ unitPriceEx: 27273, lineEx: 27273 }, { unitPriceEx: 17273, lineEx: 34546 }, { unitPriceEx: 27273, lineEx: 27273 }]);
    expect([t.subtotal, t.tax, t.discount, t.shipping, t.codFee, t.total, t.addsUp]).toEqual([89092, 8908, 8000, 800, 1150, 91950, true]);
  });

  it("layaway with a late fee: its own line, outside the 10%", () => {
    const t = receiptTotals({ currency: "JPY", items: [item(100000)], ...none, penalties: 1000, received: 101000 });
    expect([t.subtotal, t.tax, t.penalties, t.total, t.addsUp]).toEqual([90909, 9091, 1000, 101000, true]);
  });

  it("peso multi-item (option a): each line converted at the order's rate; rows add up to the peso product amount", () => {
    const p = pesoLines([{ unitPriceJpy: 60000, quantity: 1 }, { unitPriceJpy: 40000, quantity: 1 }], 0.42, 42000);
    if ("error" in p) throw new Error(p.error);
    expect(p.items.map((i) => i.lineTotal)).toEqual([25200, 16800]);
    expect(p.remainder).toBe(0);
    const t = receiptTotals({ currency: "PHP", items: p.items, ...none, received: 42000 });
    // 25,200 ÷ 1.1 = 22,909.09 → 22,909; 16,800 ÷ 1.1 = 15,272.7 → 15,273
    expect(t.lines).toEqual([{ unitPriceEx: 22909, lineEx: 22909 }, { unitPriceEx: 15273, lineEx: 15273 }]);
    expect([t.subtotal, t.tax, t.total, t.addsUp]).toEqual([38182, 3818, 42000, true]);
  });

  it("peso rounding remainder goes on the largest quantity-1 line (qty 2 on another line)", () => {
    // rate 0.308345: ¥19,000 → ₱5,858.555 → 5,859; ¥30,000 → ₱9,250.35 → 9,250
    // checkout: ¥68,000 × 0.308345 = ₱20,967.46 → 20,967; Σ lines 20,968 → remainder −1 on the ¥30,000 line
    const p = pesoLines([{ unitPriceJpy: 19000, quantity: 2 }, { unitPriceJpy: 30000, quantity: 1 }], 0.308345, 20967);
    if ("error" in p) throw new Error(p.error);
    expect([p.remainder, p.fixedIndex]).toEqual([-1, 1]);
    expect(p.items.map((i) => [i.unitPrice, i.lineTotal])).toEqual([[5859, 11718], [9249, 9249]]);
    const t = receiptTotals({ currency: "PHP", items: p.items, ...none, received: 20967 });
    expect([t.total, t.addsUp]).toEqual([20967, true]);
  });

  it("peso with discount and shipping", () => {
    const p = pesoLines([{ unitPriceJpy: 60000, quantity: 1 }], 0.42, 25200);
    if ("error" in p) throw new Error(p.error);
    const t = receiptTotals({ currency: "PHP", items: p.items, discount: 2100, points: 0, shipping: 1470, codFee: 0, penalties: 0, received: 24570 });
    expect([t.subtotal, t.tax, t.discount, t.shipping, t.total, t.addsUp]).toEqual([22909, 2291, 2100, 1470, 24570, true]);
  });

  it("peso: no rate, or a remainder with no quantity-1 line → flagged, never forced", () => {
    expect(pesoLines([{ unitPriceJpy: 60000, quantity: 1 }], null, 25200)).toEqual({ error: "peso_no_rate" });
    expect(pesoLines([{ unitPriceJpy: 19000, quantity: 2 }], 0.308345, 11717)).toEqual({ error: "peso_lines_mismatch" });
  });

  it("does not add up → flagged, never forced", () => {
    expect(receiptTotals({ currency: "JPY", items: [item(45000)], ...none, received: 50000 }).problem).toBe("block_mismatch");
    expect(receiptTotals({ currency: "JPY", items: [{ unitPrice: 50000, quantity: 1, lineTotal: 45000 }], ...none, received: 50000 }).problem).toBe("lines_mismatch");
    expect(receiptTotals({ currency: "JPY", items: [], ...none, received: 0 }).problem).toBe("no_items");
  });

  it("the discount line is always a minus, even at zero", () => {
    expect(receiptMinus(0, "JPY")).toBe("\u2212¥0");
    expect(receiptMinus(8000, "JPY")).toBe("\u2212¥8,000");
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
});
