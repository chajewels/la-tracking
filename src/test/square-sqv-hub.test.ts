import { describe, expect, it } from "vitest";
import {
  customerCodesProblem, parseCustomerCodes, preflightLines, squareEffect, squareRefusal,
} from "../components/settings/square-settings";
import {
  authorizedOverOneYear, cardException, cardRecordable, exceptionCap, oneYearBefore, phtDay,
} from "../components/web-orders/MarkRefundIssuedDialog";

// SQV / D-G04 / D-SQV05 (owner 2026-10-09): the pure parts of the Hub UI.

describe("D-G04 settings: audience wording and customer codes", () => {
  it("On + listed names how many customers see card; On + everyone says every customer", () => {
    expect(squareEffect("on", "listed", 2)).toMatch(/Only the 2 listed customers/);
    expect(squareEffect("on", "listed", 1)).toMatch(/Only the 1 listed customer /);
    expect(squareEffect("on", "everyone", 0)).toMatch(/Every customer/);
    expect(squareEffect("test", "listed", 5)).toMatch(/is_test/);
  });
  it("parses codes one per line or comma separated, upper-cased, de-duplicated", () => {
    expect(parseCustomerCodes(" cj-2026-00008\nCJ-2026-00016, cj-2026-00008 ;")).toEqual(["CJ-2026-00008", "CJ-2026-00016"]);
    expect(parseCustomerCodes("")).toEqual([]);
    expect(customerCodesProblem(["CJ-2026-00008"])).toBeNull();
    expect(customerCodesProblem(["CJ-2026-00008", "ÑO!"])).toMatch(/ÑO!/);
  });
  it("names the new refusals", () => {
    expect(squareRefusal("unknown_customer_code")).toMatch(/do not exist/);
    expect(squareRefusal("invalid_audience")).toMatch(/audience/i);
  });
});

describe("D-SQV05 preflight lines", () => {
  it("nothing run → no lines", () => expect(preflightLines(null)).toEqual([]));
  it("shows the secret NAME, a 401 as refused, and every step's verdict", () => {
    const lines = preflightLines({
      passed: false, token: { state: "auth_failed", secret: "SQUARE_PRODUCTION_ACCESS_TOKEN" },
      location_configured: "L1", location_match: null, locations: [], app_id_family: "production",
      events: { state: "not_configured" },
    });
    expect(lines).toHaveLength(6);
    expect(lines[0]).toEqual({ ok: false, text: expect.stringMatching(/SQUARE_PRODUCTION_ACCESS_TOKEN.*401\/403/) });
    expect(lines[1].ok).toBe(false);
    expect(lines[2].ok).toBe(false); // M2: location not read
    expect(lines[3].ok).toBe(false); // F-14: webhook key not reported
    expect(lines[4].ok).toBe(true);
    expect(lines[5].ok).toBe(false);
  });
  it("M2 / F-14: an ACTIVE yen location in Japan and a set webhook key pass", () => {
    const lines = preflightLines({ location: { status: "ACTIVE", currency: "JPY", country: "JP" }, webhook_key: true });
    expect(lines[2].ok).toBe(true);
    expect(lines[3].ok).toBe(true);
    expect(preflightLines({ location: { status: "INACTIVE", currency: "JPY", country: "JP" } })[2].ok).toBe(false);
  });
});

describe("SQV04: the exception's age is the original authorisation, one CALENDAR year", () => {
  const now = new Date("2026-10-09T03:00:00Z");
  it("one calendar year, not 365 days", () => {
    expect(oneYearBefore(now).toISOString()).toBe("2025-10-09T03:00:00.000Z");
    // 2027-03-01 → 2028-03-01 is 366 days (leap day 2028-02-29); one calendar year still lands on 2027-03-01.
    expect(oneYearBefore(new Date("2028-03-01T00:00:00Z")).toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });
  it("strictly older than a year opens it; exactly a year or newer does not", () => {
    expect(authorizedOverOneYear("2025-10-09T02:59:59Z", now)).toBe(true);
    expect(authorizedOverOneYear("2025-10-09T03:00:00Z", now)).toBe(false);
    expect(authorizedOverOneYear("2026-01-01T00:00:00Z", now)).toBe(false);
    expect(authorizedOverOneYear(null, now)).toBe(false);
    expect(authorizedOverOneYear("not a date", now)).toBe(false);
  });
  it("cardException: a FAILED/REJECTED refund or the age rule, card-paid only", () => {
    expect(cardException({ paidByCard: true, failedRefunds: [], authorizedOverOneYear: true })).toBe(true);
    expect(cardException({ paidByCard: true, failedRefunds: [{ id: "r", status: "FAILED", amount: 1 }], authorizedOverOneYear: false })).toBe(true);
    expect(cardException({ paidByCard: true, failedRefunds: [], authorizedOverOneYear: false })).toBe(false);
    expect(cardException({ paidByCard: false, failedRefunds: [], authorizedOverOneYear: true })).toBe(false);
    expect(cardException(null)).toBe(false);
  });
  it("cap = captured − completed − credit, never negative", () => {
    expect(exceptionCap({ cardCaptured: 10000, refundedCompleted: 3000, creditIssued: 2000 })).toBe(5000);
    // F-02 / F-17 (QC 2026-10-09): chargeback money is subtracted too
    expect(exceptionCap({ cardCaptured: 10000, refundedCompleted: 0, creditIssued: 0, disputed: 10000 })).toBe(0);
    expect(exceptionCap({ cardCaptured: 1000, refundedCompleted: 1000, creditIssued: 500 })).toBe(0);
  });
  it("the approval day is the Philippine day (the SQL's day boundary)", () => {
    expect(phtDay("2026-10-08T16:30:00Z")).toBe("2026-10-09");
    expect(phtDay("2026-10-08T15:59:59Z")).toBe("2026-10-08");
  });
});

describe('F-03: the dialog card figure matches mark_web_order_refund_issued_atomic', () => {
  it('counts only refunds of recorded captures, capped per payment', () => {
    const pays = new Map([
      ['p1', { amount_jpy: 10000, captured_amount_jpy: 8000, cash_payment_id: 'c1' }],
      ['p2', { amount_jpy: 5000, captured_amount_jpy: 5000, cash_payment_id: null }],
    ]);
    expect(cardRecordable([
      { amount_jpy: 6000, status: 'COMPLETED', square_payment_row: 'p1' },
      { amount_jpy: 4000, status: 'COMPLETED', square_payment_row: 'p1' },
      { amount_jpy: 3000, status: 'COMPLETED', square_payment_row: 'p2' },
      { amount_jpy: 1000, status: 'PENDING', square_payment_row: 'p1' },
    ], pays)).toBe(8000);
  });
});
