import { describe, expect, it } from "vitest";
import {
  canMarkFurtherRefund, canMarkRefundIssued, cardRecordable, refundMethodChoice, refundPartsFrom, type RefundParts,
} from "../components/web-orders/MarkRefundIssuedDialog";

// L6 (2026-10-09, eighth release): the dialog mirrors of
// square_order_card_refund_recordable_jpy and web_order_refund_parts.
// The SQL is the authority (development/sql/square-l2-l8-2026-10-09.sql).

describe("L6: the card figure is capped at the card money RECORDED on the order", () => {
  const pays = new Map([
    ["p1", { amount_jpy: 10000, captured_amount_jpy: 10000, cash_payment_id: "c1" }],
    ["p2", { amount_jpy: 5000, captured_amount_jpy: 5000, cash_payment_id: "c2" }],
  ]);
  it("a refund made before the Hub recorded the net is not Hub money", () => {
    // captured 10,000; ¥3,000 refunded before recording; ¥7,000 recorded; then ¥7,000 refunded.
    const recorded = new Map([["c1", 7000]]);
    expect(cardRecordable([
      { amount_jpy: 3000, status: "COMPLETED", square_payment_row: "p1" },
      { amount_jpy: 7000, status: "COMPLETED", square_payment_row: "p1" },
    ], pays, recorded)).toBe(7000);
    // Only ¥2,000 refunded after recording → ¥2,000, not ¥5,000.
    expect(cardRecordable([
      { amount_jpy: 3000, status: "COMPLETED", square_payment_row: "p1" },
      { amount_jpy: 2000, status: "COMPLETED", square_payment_row: "p1" },
    ], pays, recorded)).toBe(2000);
  });
  it("a voided ledger row (absent from the recorded map) counts nothing", () => {
    expect(cardRecordable([{ amount_jpy: 5000, status: "COMPLETED", square_payment_row: "p2" }], pays, new Map([["c1", 10000]]))).toBe(0);
  });
});

describe("L6: web_order_refund_parts is read as the SQL answers it", () => {
  it("parses marks and the open parts; anything missing is closed", () => {
    const p = refundPartsFrom({
      marks: [{ method: "card", amount: 10000, refunded_on: "2026-10-09" }, { method: "", amount: 1 }],
      card_open: false, non_card_open: true, card_marked_jpy: 10000, non_card_jpy: 5000, paidy_jpy: 0,
    });
    expect(p.marks).toEqual([{ method: "card", amount: 10000, refundedOn: "2026-10-09" }]);
    expect([p.cardOpen, p.nonCardOpen, p.cardMarked, p.nonCard, p.paidy]).toEqual([false, true, 10000, 5000, 0]);
    expect(refundPartsFrom(null)).toEqual({ marks: [], cardOpen: false, nonCardOpen: false, cardMarked: 0, nonCard: 0, paidy: 0 });
  });
});

describe("L6: which methods the dialog offers", () => {
  const parts = (over: Partial<RefundParts> = {}): RefundParts => ({ marks: [], cardOpen: false, nonCardOpen: false, cardMarked: 0, nonCard: 0, paidy: 0, ...over });
  const mark = (method: string, amount = 1000) => ({ method, amount, refundedOn: "2026-10-09" });
  it("an open approval offers only its exception method", () => {
    expect(refundMethodChoice({ paidByCard: true, approvalPayout: "store_credit", exceptionOpen: true, parts: parts() }))
      .toEqual({ methods: ["store_credit_exception"], initial: "store_credit_exception" });
  });
  it("no card money: every ordinary method, bank transfer first", () => {
    expect(refundMethodChoice({ paidByCard: false, approvalPayout: null, exceptionOpen: false, parts: parts() }).initial).toBe("bank_transfer");
  });
  it("first mark on a card + bank order: card, the non-card methods, exceptions only when open", () => {
    const c = refundMethodChoice({ paidByCard: true, approvalPayout: null, exceptionOpen: true, parts: parts({ nonCard: 5000 }) });
    expect(c.initial).toBe("card");
    expect(c.methods).toEqual(["card", "bank_transfer", "cash", "other", "bank_transfer_exception", "store_credit_exception"]);
  });
  it("a card + Paidy order: the non-card part is Paidy only, never a bank-transfer default", () => {
    const first = refundMethodChoice({ paidByCard: true, approvalPayout: null, exceptionOpen: false, parts: parts({ nonCard: 5000, paidy: 5000 }) });
    expect(first.methods).toEqual(["card", "paidy"]);
    const further = refundMethodChoice({ paidByCard: true, approvalPayout: null, exceptionOpen: true,
      parts: parts({ marks: [mark("card")], nonCardOpen: true, nonCard: 5000, paidy: 5000 }) });
    expect(further).toEqual({ methods: ["paidy"], initial: "paidy" });
  });
  it("a further mark offers only the open part and never an exception method", () => {
    const c = refundMethodChoice({ paidByCard: true, approvalPayout: null, exceptionOpen: true,
      parts: parts({ marks: [mark("bank_transfer")], cardOpen: true, nonCard: 5000 }) });
    expect(c).toEqual({ methods: ["card"], initial: "card" });
  });
  it("the further-mark button is for a cancelled web order already marked refunded", () => {
    const o = { source_channel: "web", status: "cancelled", refund_status: "refund_issued" };
    expect(canMarkFurtherRefund(o)).toBe(true);
    expect(canMarkRefundIssued(o)).toBe(false);
    expect(canMarkFurtherRefund({ ...o, refund_status: "refund_pending" })).toBe(false);
    expect(canMarkFurtherRefund({ ...o, source_channel: "hub" })).toBe(false);
  });
});
