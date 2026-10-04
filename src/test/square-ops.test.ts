import { describe, expect, it } from "vitest";
import {
  SQUARE_DECISIONS, SQUARE_EXCEPTION_LABEL, ageLabel, defaultSettlementRange, isDeadlineSoon,
  isOpenSquareException, jstDate, orderRef, refundNotPaidBack, settlementCsv, settlementCsvRows,
  settlementFileName, settlementTotals, squareDecisionRefusal, squareExceptionLabel, squareHealthStatus,
  squareNoteRequired, squarePaymentStateLabel, type SettlementRow,
} from "../lib/square-ops";

// Website → Settings → Card payments operator panel (Square integrity,
// 2026-10-04, docs/SQUARE-INTEGRITY.md "Hub UI"). Pins the pure parts.

describe("squareExceptionLabel — every exception code in plain words", () => {
  it("covers exactly the codes square_payments_exception_check allows", () => {
    expect(Object.keys(SQUARE_EXCEPTION_LABEL).sort()).toEqual(
      ["amount_mismatch", "captured_after_close", "captured_unallocated", "refunded_before_record", "risk_high", "unfiled_hold", "void_unconfirmed"],
    );
  });
  it("uses the owner-facing wording", () => {
    expect(squareExceptionLabel("captured_after_close")).toBe("Square captured after the Hub had closed it");
    expect(squareExceptionLabel("captured_unallocated")).toBe("Captured but the order could not take it");
    expect(squareExceptionLabel("unfiled_hold")).toBe("Hold the order could not take");
    // QC15: the risk finding never claims the hold was voided — the state line says what Square did.
    expect(squareExceptionLabel("risk_high")).toBe("Square risk HIGH");
    expect(squareExceptionLabel("refunded_before_record")).toMatch(/refunded/);
    expect(squareExceptionLabel("void_unconfirmed")).toBe("Hub closed it but Square still holds it");
  });
  it("a capture without a code is 'captured, not recorded'; an unknown code is shown readably", () => {
    expect(squareExceptionLabel(null)).toBe("Captured, not recorded yet");
    expect(squareExceptionLabel("some_new_code")).toBe("some new code");
  });
});

describe("decisions mirror decide_square_case", () => {
  it("offers exactly the values the function accepts", () => {
    expect(SQUARE_DECISIONS.exception.map((d) => d.value)).toEqual(["record_on_order", "record_net_after_refund", "refunded_in_square", "voided_in_square", "other"]);
    expect(SQUARE_DECISIONS.exception.find((d) => d.value === "other")?.label).toMatch(/does not resolve/);
    expect(SQUARE_DECISIONS.refund.map((d) => d.value)).toEqual(["order_cancelled_refunded", "partial_refund_order_kept", "refund_failed_followed_up", "other"]);
    expect(SQUARE_DECISIONS.dispute.map((d) => d.value)).toEqual(["evidence_submitted", "accepted", "won", "lost", "other"]);
  });
  it("requires a note only for an exception", () => {
    expect(squareNoteRequired("exception")).toBe(true);
    expect(squareNoteRequired("refund")).toBe(false);
    expect(squareNoteRequired("dispute")).toBe(false);
  });
  it("explains refusals", () => {
    expect(squareDecisionRefusal("note_required")).toMatch(/note is required/);
    expect(squareDecisionRefusal("not_found")).toMatch(/Refresh/);
    expect(squareDecisionRefusal("not_permitted")).toMatch(/admin or finance/);
    expect(squareDecisionRefusal("refund_not_verified")).toMatch(/stays open/);
    expect(squareDecisionRefusal("void_not_verified")).toMatch(/stays open/);
    expect(squareDecisionRefusal("state_mismatch")).toMatch(/Square reports/);
    expect(squareDecisionRefusal("weird")).toBe("weird");
  });
});

describe("isDeadlineSoon", () => {
  const now = new Date("2026-10-04T00:00:00Z");
  it("warns under the threshold and when already past", () => {
    expect(isDeadlineSoon("2026-10-05T23:59:00Z", now, 2)).toBe(true);
    expect(isDeadlineSoon("2026-10-03T00:00:00Z", now, 2)).toBe(true);
  });
  it("does not warn at or beyond the threshold, or with no deadline", () => {
    expect(isDeadlineSoon("2026-10-06T00:00:00Z", now, 2)).toBe(false);
    expect(isDeadlineSoon("2026-10-10T00:00:00Z", now, 3)).toBe(false);
    expect(isDeadlineSoon(null, now, 2)).toBe(false);
    expect(isDeadlineSoon("not a date", now, 2)).toBe(false);
  });
});

describe("refundNotPaidBack", () => {
  it("is true only for FAILED / REJECTED", () => {
    expect(refundNotPaidBack("FAILED")).toBe(true);
    expect(refundNotPaidBack("rejected")).toBe(true);
    expect(refundNotPaidBack("COMPLETED")).toBe(false);
    expect(refundNotPaidBack("PENDING")).toBe(false);
    expect(refundNotPaidBack(null)).toBe(false);
  });
});

describe("isOpenSquareException mirrors the server filter", () => {
  const base = { status: "captured", cash_payment_id: null, exception: null, exception_resolved_at: null };
  it("captured and not recorded is open", () => expect(isOpenSquareException(base)).toBe(true));
  it("captured and recorded is not", () => expect(isOpenSquareException({ ...base, cash_payment_id: "p" })).toBe(false));
  it("any unresolved exception is open, whatever the status", () => {
    expect(isOpenSquareException({ ...base, status: "voided", exception: "risk_high" })).toBe(true);
  });
  it("a resolved one is never open", () => {
    expect(isOpenSquareException({ ...base, exception: "captured_unallocated", exception_resolved_at: "2026-10-04T00:00:00Z" })).toBe(false);
    expect(isOpenSquareException({ ...base, exception_resolved_at: "2026-10-04T00:00:00Z" })).toBe(false);
  });
  it("an authorised hold is not an exception", () => expect(isOpenSquareException({ ...base, status: "authorized" })).toBe(false));
});

describe("ageLabel", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  it("minutes, hours, days", () => {
    expect(ageLabel("2026-10-04T11:48:00Z", now)).toBe("12 min");
    expect(ageLabel("2026-10-04T07:00:00Z", now)).toBe("5 h");
    expect(ageLabel("2026-10-01T12:00:00Z", now)).toBe("3 d");
    expect(ageLabel(null, now)).toBe("—");
  });
});

describe("Japan dates for the report range", () => {
  it("uses the Japan calendar day (UTC 16:00 is already tomorrow in Japan)", () => {
    expect(jstDate(new Date("2026-10-31T16:00:00Z"))).toBe("2026-11-01");
    expect(defaultSettlementRange(new Date("2026-10-31T16:00:00Z"))).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(defaultSettlementRange(new Date("2026-10-04T03:00:00Z"))).toEqual({ from: "2026-10-01", to: "2026-10-04" });
  });
});

describe("settlement totals and CSV", () => {
  const rows: SettlementRow[] = [
    { day: "2026-10-01", captures: 2, gross_jpy: 50000, fees_jpy: 1800, refunds_completed_jpy: 0, refunds_open_jpy: 0, disputes_lost_jpy: 0, net_jpy: 48200 },
    { day: "2026-10-02", captures: "1", gross_jpy: "30000", fees_jpy: "1080", refunds_completed_jpy: "5000", refunds_open_jpy: "2000", disputes_lost_jpy: "0", net_jpy: "23920" },
  ];
  it("sums every column (bigint strings included)", () => {
    expect(settlementTotals(rows)).toEqual({
      captures: 3, gross_jpy: 80000, fees_jpy: 2880, refunds_completed_jpy: 5000,
      refunds_open_jpy: 2000, disputes_lost_jpy: 0, net_jpy: 72120, fees_missing: 0,
    });
  });
  it("empty report totals to zero", () => {
    expect(settlementTotals([]).net_jpy).toBe(0);
  });
  it("CSV has the header, one line per day and a Total line", () => {
    const { header, rows: body } = settlementCsvRows(rows);
    expect(header[0]).toBe("Day (Japan)");
    expect(body).toHaveLength(3);
    expect(body[2]).toEqual(["Total", 3, 80000, 2880, 5000, 2000, 0, 72120, 0]);
    const text = settlementCsv(rows).split("\n");
    // QC13: activity with an ESTIMATED net, and how many captures still lack Square's fee.
    expect(text[0]).toBe("Day (Japan),Captures,Gross JPY,Square fees JPY,Refunds completed JPY,Refunds pending JPY,Disputes lost JPY,Estimated net JPY,Captures with fee not reported");
    expect(text[1]).toBe("2026-10-01,2,50000,1800,0,0,0,48200,0");
    expect(text[3]).toBe("Total,3,80000,2880,5000,2000,0,72120,0");
  });
  it("file name carries the range", () => {
    expect(settlementFileName("2026-10-01", "2026-10-04")).toBe("square-card-activity-2026-10-01-to-2026-10-04");
  });
});

describe("orderRef", () => {
  it("prefers the web reference, then the invoice number", () => {
    expect(orderRef({ web_reference: "CJ-W-000123", invoice_number: "19500" })).toBe("CJ-W-000123");
    expect(orderRef({ web_reference: null, invoice_number: 19500 })).toBe("19500");
    expect(orderRef(null)).toBe("—");
  });
});

describe("squarePaymentStateLabel (QC15)", () => {
  it("says what Square did with the money, separately from the exception", () => {
    expect(squarePaymentStateLabel("authorized")).toBe("Still held on the card");
    expect(squarePaymentStateLabel("voided")).toMatch(/released/);
    expect(squarePaymentStateLabel("captured")).toMatch(/taken/);
  });
});

describe("squareHealthStatus (QC11)", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  it("no run yet is unknown", () => expect(squareHealthStatus(null, now)).toBe("unknown"));
  it("a recent good run is ok", () => {
    expect(squareHealthStatus({ last_run: { at: "2026-10-05T11:53:00Z", status: "ok" }, last_ok_at: "2026-10-05T11:53:00Z" }, now)).toBe("ok");
  });
  it("a good run older than 3 hours is stale (cron silent)", () => {
    expect(squareHealthStatus({ last_run: { at: "2026-10-05T07:53:00Z", status: "ok" }, last_ok_at: "2026-10-05T07:53:00Z" }, now)).toBe("stale");
  });
  it("degraded / failed runs show as such; dead events degrade an ok run", () => {
    expect(squareHealthStatus({ last_run: { at: "2026-10-05T11:53:00Z", status: "failed" }, last_ok_at: "2026-10-05T06:00:00Z" }, now)).toBe("failed");
    expect(squareHealthStatus({ last_run: { at: "2026-10-05T11:53:00Z", status: "ok" }, last_ok_at: "2026-10-05T11:53:00Z", events_dead: 1 }, now)).toBe("degraded");
  });
});
