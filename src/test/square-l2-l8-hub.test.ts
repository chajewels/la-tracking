import { describe, expect, it } from "vitest";
import {
  canMarkFurtherRefund, canMarkRefundIssued, cardMarkedTotal, cardRecordable, refundPartsOpen,
} from "../components/web-orders/MarkRefundIssuedDialog";

// L6 (2026-10-09, eighth release): the dialog mirrors of
// square_order_card_refund_recordable_jpy and mark_web_order_refund_issued_atomic.
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

describe("L6: one more mark per part on a mixed order", () => {
  const mixed = { paidByCard: true, cardRecordable: 10000, nonCardPaid: 5000 };
  it("after the card part, the other part is open; after both, nothing is", () => {
    expect(refundPartsOpen([{ method: "card", amount: 10000, refundedOn: "2026-10-09" }], mixed)).toEqual({ card: false, nonCard: true });
    expect(refundPartsOpen([{ method: "bank_transfer", amount: 5000, refundedOn: "2026-10-09" }], mixed)).toEqual({ card: true, nonCard: false });
    expect(refundPartsOpen([
      { method: "card", amount: 10000, refundedOn: "2026-10-09" },
      { method: "bank_transfer", amount: 5000, refundedOn: "2026-10-09" },
    ], mixed)).toEqual({ card: false, nonCard: false });
  });
  it("a later completed Square refund opens the card part again for the remainder", () => {
    const marks = [{ method: "card", amount: 4000, refundedOn: "2026-10-09" }];
    expect(cardMarkedTotal(marks)).toBe(4000);
    expect(refundPartsOpen(marks, { paidByCard: true, cardRecordable: 10000, nonCardPaid: 0 })).toEqual({ card: true, nonCard: false });
  });
  it("a refund outside Square closes the card part; a card-only order has no other part", () => {
    expect(refundPartsOpen([{ method: "bank_transfer_exception", amount: 10000, refundedOn: null }], mixed).card).toBe(false);
    expect(refundPartsOpen([], { paidByCard: true, cardRecordable: 0, nonCardPaid: 0 })).toEqual({ card: false, nonCard: false });
    expect(refundPartsOpen([], { paidByCard: false, cardRecordable: 0, nonCardPaid: 5000 })).toEqual({ card: false, nonCard: false });
  });
  it("the further-mark button is for a cancelled web order already marked refunded", () => {
    const o = { source_channel: "web", status: "cancelled", refund_status: "refund_issued" };
    expect(canMarkFurtherRefund(o)).toBe(true);
    expect(canMarkRefundIssued(o)).toBe(false);
    expect(canMarkFurtherRefund({ ...o, refund_status: "refund_pending" })).toBe(false);
    expect(canMarkFurtherRefund({ ...o, source_channel: "hub" })).toBe(false);
  });
});
