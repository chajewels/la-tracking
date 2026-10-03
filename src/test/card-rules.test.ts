import { describe, expect, it } from "vitest";
import {
  CARD_ATTEMPTS_PER_DAY, CARD_HOLD_DAYS, CARD_HOLD_WARN_DAYS, agreementRequired, cardAmountMatches, cardHoldExpired, cardHoldWarnDue,
  cardIdempotencyKey, cardNotOfferedReason, isSquarePaymentId, nextSquareRowStatus, normalizeSquareStatus, squareAppIdFamily, squareModeFrom,
} from "../../supabase/functions/_shared/card-rules.ts";

// Square card payments on a confirmed web order (S2, 2026-10-04, docs/SQUARE.md).
// The same file the website / review-payment-submission / square-webhook edge
// functions import. Twin of paidy-rules.test.ts.

const order = { currency: "JPY", status: "pending", payment_status: "pending_transfer", remaining_balance: 236800, source_channel: "web", ready_confirmed_at: "2026-10-03T00:00:00Z" };
const base = { mode: "on" as const, appId: "sq0idp-AbCdEf123456", locationId: "L8XK2M9Q4ZT1A", customerIsTest: false, order, pendingSubmissions: 0 };

describe("squareModeFrom — fail-closed, mirrors public.square_mode()", () => {
  it("accepts only the two exact strings, also JSON-quoted", () => {
    expect(squareModeFrom("on")).toBe("on");
    expect(squareModeFrom("test")).toBe("test");
    expect(squareModeFrom('"on"')).toBe("on");
    expect(squareModeFrom('"test"')).toBe("test");
  });
  it("anything else is off", () => {
    for (const v of ["off", "ON", "On ", "", null, undefined, 1, true, "live", '"live"', {}]) expect(squareModeFrom(v)).toBe("off");
  });
});

describe("squareAppIdFamily", () => {
  it("names the family of a public Application ID", () => {
    expect(squareAppIdFamily("sandbox-sq0idb-AbCdEf123456")).toBe("sandbox");
    expect(squareAppIdFamily("sq0idp-AbCdEf123456")).toBe("production");
  });
  it("refuses tokens, secrets, blanks and non-strings", () => {
    for (const v of ["EAAAl1234567890abcdef", "sq0atp-abcdef123456", "sq0csp-abcdef123456", "", null, 42, "sq0idp-ab"]) expect(squareAppIdFamily(v)).toBeNull();
  });
});

describe("cardNotOfferedReason — the first failing reason, in order", () => {
  it("offers on a confirmed yen web order with production ids, any country", () => {
    expect(cardNotOfferedReason(base)).toBeNull();
  });
  it("offers in test mode to a test customer with a sandbox id", () => {
    expect(cardNotOfferedReason({ ...base, mode: "test", appId: "sandbox-sq0idb-AbCdEf123456", customerIsTest: true })).toBeNull();
  });
  it("mode_off first", () => {
    expect(cardNotOfferedReason({ ...base, mode: "off", appId: "" })).toBe("mode_off");
  });
  it("test mode never shows to a real customer", () => {
    expect(cardNotOfferedReason({ ...base, mode: "test", appId: "sandbox-sq0idb-AbCdEf123456" })).toBe("test_mode_real_customer");
  });
  it("needs an Application ID of the mode's family", () => {
    expect(cardNotOfferedReason({ ...base, appId: "" })).toBe("no_app_id");
    expect(cardNotOfferedReason({ ...base, appId: "EAAAtoken1234567" })).toBe("no_app_id");
    expect(cardNotOfferedReason({ ...base, appId: "sandbox-sq0idb-AbCdEf123456" })).toBe("app_id_mode_mismatch");
    expect(cardNotOfferedReason({ ...base, mode: "test", customerIsTest: true })).toBe("app_id_mode_mismatch");
  });
  it("needs a Location ID", () => {
    expect(cardNotOfferedReason({ ...base, locationId: "" })).toBe("no_location_id");
    expect(cardNotOfferedReason({ ...base, locationId: null })).toBe("no_location_id");
  });
  it("yen only (D4)", () => {
    expect(cardNotOfferedReason({ ...base, order: { ...order, currency: "PHP" } })).toBe("not_jpy");
  });
  it("only an open order with money due", () => {
    expect(cardNotOfferedReason({ ...base, order: { ...order, status: "completed" } })).toBe("order_not_open");
    expect(cardNotOfferedReason({ ...base, order: { ...order, status: "cancelled" } })).toBe("order_not_open");
    expect(cardNotOfferedReason({ ...base, order: { ...order, payment_status: "paid" } })).toBe("no_payment_due");
    expect(cardNotOfferedReason({ ...base, order: { ...order, remaining_balance: 0 } })).toBe("nothing_due");
    expect(cardNotOfferedReason({ ...base, order: { ...order, remaining_balance: "-5" } })).toBe("nothing_due");
  });
  it("a web reservation must be confirmed first; a Hub order has no such flag", () => {
    expect(cardNotOfferedReason({ ...base, order: { ...order, ready_confirmed_at: null } })).toBe("not_ready_for_payment");
    expect(cardNotOfferedReason({ ...base, order: { ...order, source_channel: "hub", ready_confirmed_at: null } })).toBeNull();
  });
  it("never while a submission is being checked (INVARIANT 12)", () => {
    expect(cardNotOfferedReason({ ...base, pendingSubmissions: 1 })).toBe("submission_pending");
  });
});

describe("hold window", () => {
  it("constants: 7-day card hold, warning at day 5", () => {
    expect(CARD_HOLD_DAYS).toBe(7);
    expect(CARD_HOLD_WARN_DAYS).toBe(5);
  });
  const t0 = new Date("2026-10-04T00:00:00Z");
  const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
  it("expires after 7 full days, not before", () => {
    expect(cardHoldExpired(t0.toISOString(), day(6.99))).toBe(false);
    expect(cardHoldExpired(t0.toISOString(), day(7))).toBe(false);
    expect(cardHoldExpired(t0.toISOString(), day(7.01))).toBe(true);
  });
  it("Square's own delayed_until (capture_by) wins over the 7-day rule", () => {
    expect(cardHoldExpired(t0.toISOString(), day(3), day(2).toISOString())).toBe(true);
    expect(cardHoldExpired(t0.toISOString(), day(7.5), day(8).toISOString())).toBe(false);
    expect(cardHoldExpired(t0.toISOString(), day(7.5), "garbage")).toBe(true);
    expect(cardHoldExpired(t0.toISOString(), day(6), null)).toBe(false);
  });
  it("warning is due from day 5 on, including past expiry (then it says Reject)", () => {
    expect(cardHoldWarnDue(t0.toISOString(), day(4.99))).toBe(false);
    expect(cardHoldWarnDue(t0.toISOString(), day(5))).toBe(true);
    expect(cardHoldWarnDue(t0.toISOString(), day(6.5))).toBe(true);
    expect(cardHoldWarnDue(t0.toISOString(), day(7.5))).toBe(true);
  });
  it("nextSquareRowStatus: settled rows never move; CANCELED → expired past the window, else voided; PENDING/UNKNOWN change nothing", () => {
    const at = t0.toISOString();
    for (const cur of ["captured", "expired", "voided", "failed"]) {
      expect(nextSquareRowStatus(cur, "CANCELED", at, null, day(1))).toBe(cur);
      expect(nextSquareRowStatus(cur, "COMPLETED", at, null, day(1))).toBe(cur);
    }
    expect(nextSquareRowStatus("authorized", "COMPLETED", at, null, day(1))).toBe("captured");
    expect(nextSquareRowStatus("authorized", "FAILED", at, null, day(1))).toBe("failed");
    expect(nextSquareRowStatus("authorized", "CANCELED", at, null, day(1))).toBe("voided");
    expect(nextSquareRowStatus("authorized", "CANCELED", at, null, day(8))).toBe("expired");
    expect(nextSquareRowStatus("authorized", "CANCELED", at, day(2).toISOString(), day(3))).toBe("expired");
    expect(nextSquareRowStatus("authorized", "PENDING", at, null, day(1))).toBe("authorized");
    expect(nextSquareRowStatus("authorized", "UNKNOWN", at, null, day(1))).toBe("authorized");
    expect(nextSquareRowStatus("authorized", "APPROVED", at, null, day(1))).toBe("authorized");
  });
  it("an unparsable timestamp counts as expired and not warnable", () => {
    expect(cardHoldExpired("nope", t0)).toBe(true);
    expect(cardHoldWarnDue("nope", t0)).toBe(false);
  });
});

describe("idempotency key — one per card token (review B1)", () => {
  it("same order + same nonce → same key; a different nonce or order → a different key; ≤ 45 chars", async () => {
    const a = await cardIdempotencyKey("order-1", "cnon:CBASEabc");
    const b = await cardIdempotencyKey("order-1", "cnon:CBASEabc");
    const c = await cardIdempotencyKey("order-1", "cnon:CBASExyz");
    const d = await cardIdempotencyKey("order-2", "cnon:CBASEabc");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a.length).toBeLessThanOrEqual(45);
    expect(a).toMatch(/^cj-card-[0-9a-f]{36}$/);
  });
  it("the card-attempt cap is 5 per order per day", () => {
    expect(CARD_ATTEMPTS_PER_DAY).toBe(5);
  });
});

describe("amounts, ids, statuses, agreement", () => {
  it("whole-yen equality, positive only", () => {
    expect(cardAmountMatches(236800, "236800")).toBe(true);
    expect(cardAmountMatches(236800, 236800.0)).toBe(true);
    expect(cardAmountMatches(236800, 236801)).toBe(false);
    expect(cardAmountMatches(0, 0)).toBe(false);
    expect(cardAmountMatches("x", 1)).toBe(false);
  });
  it("Square payment ids", () => {
    expect(isSquarePaymentId("hYy9pRFVxpDsO1FB05SunFWUe9JZY")).toBe(true);
    expect(isSquarePaymentId("ab")).toBe(false);
    expect(isSquarePaymentId("has space here")).toBe(false);
    expect(isSquarePaymentId(null)).toBe(false);
  });
  it("normalises Square statuses, unknown stays UNKNOWN", () => {
    expect(normalizeSquareStatus("approved")).toBe("APPROVED");
    expect(normalizeSquareStatus(" COMPLETED ")).toBe("COMPLETED");
    expect(normalizeSquareStatus("CANCELED")).toBe("CANCELED");
    expect(normalizeSquareStatus("FAILED")).toBe("FAILED");
    expect(normalizeSquareStatus("PENDING")).toBe("PENDING");
    expect(normalizeSquareStatus("CANCELLED")).toBe("UNKNOWN");
    expect(normalizeSquareStatus(undefined)).toBe("UNKNOWN");
  });
  it("D9: threshold 0 (or below) means every card payment needs the agreement", () => {
    expect(agreementRequired(100, 0)).toBe(true);
    expect(agreementRequired(1, -1)).toBe(true);
    expect(agreementRequired(49999, 50000)).toBe(false);
    expect(agreementRequired(50000, 50000)).toBe(true);
    expect(agreementRequired(50000, "50000" as unknown as number)).toBe(true);
    expect(agreementRequired(1, NaN)).toBe(true);
  });
});
