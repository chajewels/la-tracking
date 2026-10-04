import { describe, expect, it } from "vitest";
import {
  CARD_ATTEMPTS_PER_DAY, CARD_HOLD_DAYS, CARD_HOLD_WARN_BEFORE_DAYS, CARD_REFUSALS_PER_CUSTOMER, CARD_REFUSALS_PER_ORDER,
  agreementBindingProblem, agreementRequired, canonicalYen, cardAmountMatches, cardHoldDeadline, cardHoldExpired, cardHoldWarnDue,
  cardIdempotencyKey, cardNotOfferedReason, cardVerificationEvidence, isAttemptReference, isCanonicalYen, isCaptureAfterClose,
  isSquarePaymentId, jstDate, newAttemptReference, nextSquareRowStatus, normalizeSquareStatus, squareAppIdFamily,
  squareEnvironmentOf, squareModeFrom, termsTimeProblem,
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
  it("never while a card attempt / hold / capture is unresolved (SQ11, owner 3A)", () => {
    expect(cardNotOfferedReason({ ...base, cardUnresolved: true })).toBe("card_payment_unresolved");
  });
  it("never on a fractional balance — it is not rounded into a card amount (SQ12)", () => {
    expect(cardNotOfferedReason({ ...base, order: { ...order, remaining_balance: 51999.6 } })).toBe("fractional_balance");
    expect(cardNotOfferedReason({ ...base, order: { ...order, remaining_balance: "52000.00" } })).toBeNull();
  });
});

describe("hold window — Square's own deadline (SQ14)", () => {
  it("constants: 7-day fallback window, warning 2 days before the deadline", () => {
    expect(CARD_HOLD_DAYS).toBe(7);
    expect(CARD_HOLD_WARN_BEFORE_DAYS).toBe(2);
  });
  const t0 = new Date("2026-10-04T00:00:00Z");
  const day = (n: number) => new Date(t0.getTime() + n * 86_400_000);
  it("deadline: delayed_until when known, else authorised + 7 days, else null", () => {
    expect(cardHoldDeadline(t0.toISOString(), day(3).toISOString())?.toISOString()).toBe(day(3).toISOString());
    expect(cardHoldDeadline(t0.toISOString(), null)?.toISOString()).toBe(day(7).toISOString());
    expect(cardHoldDeadline("nope", "also nope")).toBeNull();
  });
  it("past the deadline by the clock (time, not proof)", () => {
    expect(cardHoldExpired(t0.toISOString(), day(6.99))).toBe(false);
    expect(cardHoldExpired(t0.toISOString(), day(7))).toBe(false);
    expect(cardHoldExpired(t0.toISOString(), day(7.01))).toBe(true);
    expect(cardHoldExpired(t0.toISOString(), day(3), day(2).toISOString())).toBe(true);
    expect(cardHoldExpired(t0.toISOString(), day(7.5), day(8).toISOString())).toBe(false);
    expect(cardHoldExpired("nope", t0)).toBe(true);
  });
  it("warning follows the real deadline: a short Square deadline warns early", () => {
    expect(cardHoldWarnDue(t0.toISOString(), day(4.99))).toBe(false);
    expect(cardHoldWarnDue(t0.toISOString(), day(5))).toBe(true);
    expect(cardHoldWarnDue(t0.toISOString(), day(1), day(3).toISOString())).toBe(true);
    expect(cardHoldWarnDue(t0.toISOString(), day(0.5), day(3).toISOString())).toBe(false);
    expect(cardHoldWarnDue(t0.toISOString(), day(7.5))).toBe(true);
    expect(cardHoldWarnDue("nope", t0)).toBe(false);
  });
  it("nextSquareRowStatus: provider COMPLETED always wins (SQ13); captured never moves; APPROVED reopens a wrongly closed row; CANCELED/FAILED close a live hold only", () => {
    const at = t0.toISOString();
    for (const cur of ["authorized", "expired", "voided", "failed", "rejected", "captured"]) {
      expect(nextSquareRowStatus(cur, "COMPLETED", at, null, day(1))).toBe("captured");
    }
    expect(nextSquareRowStatus("captured", "CANCELED", at, null, day(1))).toBe("captured");
    expect(nextSquareRowStatus("captured", "APPROVED", at, null, day(1))).toBe("captured");
    expect(nextSquareRowStatus("voided", "APPROVED", at, null, day(1))).toBe("authorized");
    expect(nextSquareRowStatus("expired", "CANCELED", at, null, day(1))).toBe("expired");
    expect(nextSquareRowStatus("authorized", "FAILED", at, null, day(1))).toBe("failed");
    expect(nextSquareRowStatus("authorized", "CANCELED", at, null, day(1))).toBe("voided");
    expect(nextSquareRowStatus("authorized", "CANCELED", at, null, day(8))).toBe("expired");
    expect(nextSquareRowStatus("authorized", "CANCELED", at, day(2).toISOString(), day(3))).toBe("expired");
    expect(nextSquareRowStatus("authorized", "PENDING", at, null, day(1))).toBe("authorized");
    expect(nextSquareRowStatus("authorized", "UNKNOWN", at, null, day(1))).toBe("authorized");
    expect(isCaptureAfterClose("expired", "COMPLETED")).toBe(true);
    expect(isCaptureAfterClose("authorized", "COMPLETED")).toBe(false);
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
  it("caps and fraud thresholds: 5 per order, 10 per customer, per rolling day", () => {
    expect(CARD_ATTEMPTS_PER_DAY).toBe(5);
    expect(CARD_REFUSALS_PER_ORDER).toBe(5);
    expect(CARD_REFUSALS_PER_CUSTOMER).toBe(10);
  });
  it("attempt reference: cja_ + hex, ≤ 40 chars (Square reference_id)", () => {
    const r = newAttemptReference(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 255]));
    expect(r).toBe("cja_000102030405060708090aff");
    expect(r.length).toBeLessThanOrEqual(40);
    expect(isAttemptReference(newAttemptReference())).toBe(true);
    expect(isAttemptReference("TEST-900063")).toBe(false);
  });
});

describe("amounts, ids, statuses, agreement", () => {
  it("exact integer-yen equality — never rounded (SQ12)", () => {
    expect(cardAmountMatches(236800, "236800")).toBe(true);
    expect(cardAmountMatches(236800, 236800.0)).toBe(true);
    expect(cardAmountMatches(236800, "236800.00")).toBe(true);
    expect(cardAmountMatches(236800, 236801)).toBe(false);
    expect(cardAmountMatches(52000, 51999.6)).toBe(false);
    expect(cardAmountMatches(0, 0)).toBe(false);
    expect(cardAmountMatches("x", 1)).toBe(false);
  });
  it("canonical yen: positive safe integers only", () => {
    for (const ok of [1, 52000, "52000", "52000.00"]) expect(isCanonicalYen(ok)).toBe(true);
    for (const bad of [0, -1, 1.5, "1.5", NaN, Infinity, 2 ** 60, "", "1e3", null, undefined, "52,000"]) expect(isCanonicalYen(bad)).toBe(false);
    expect(canonicalYen("24980")).toBe(24980);
    expect(canonicalYen(24979.5)).toBeNull();
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

describe("environment, evidence, binding, dates (SQ18/SQ20/SQ21/SQ22)", () => {
  it("mode → environment", () => {
    expect(squareEnvironmentOf("test")).toBe("sandbox");
    expect(squareEnvironmentOf("on")).toBe("production");
    expect(squareEnvironmentOf("off")).toBeNull();
  });
  it("3DS evidence says only what the Hub can establish — never 'verified'", () => {
    expect(cardVerificationEvidence("sdk_tokenize_with_verification", false)).toBe("sdk_tokenize_with_verification");
    expect(cardVerificationEvidence(undefined, false)).toBe("unknown");
    expect(cardVerificationEvidence("anything", true)).toBe("verification_token_supplied");
    for (const v of ["sdk_tokenize_with_verification", "unknown", "verification_token_supplied"]) expect(v).not.toMatch(/VERIFIED/i);
  });
  const now = new Date("2026-10-04T10:00:00Z");
  const good = { version: "card-2026-v1", signed_at: "2026-10-04T09:00:00Z", customer_id: "c-1", amount_jpy: 24980, bound: true };
  it("agreement binds this customer and this amount (owner 5A)", () => {
    expect(agreementBindingProblem(good, "c-1", 24980, now)).toBeNull();
    expect(agreementBindingProblem(null, "c-1", 24980, now)).toBe("agreement_missing");
    expect(agreementBindingProblem({ ...good, bound: false }, "c-1", 24980, now)).toBe("agreement_unbound");
    expect(agreementBindingProblem(good, "c-2", 24980, now)).toBe("agreement_other_customer");
    expect(agreementBindingProblem(good, "c-1", 30000, now)).toBe("agreement_amount_changed");
    expect(agreementBindingProblem({ ...good, signed_at: "2026-10-05T10:00:00Z" }, "c-1", 24980, now)).toBe("agreement_time_invalid");
    expect(agreementBindingProblem({ ...good, signed_at: "nope" }, "c-1", 24980, now)).toBe("agreement_missing");
  });
  it("terms time: real, not in the future, within a day", () => {
    expect(termsTimeProblem("2026-10-04T09:59:00Z", now)).toBeNull();
    expect(termsTimeProblem("2026-10-04T11:00:00Z", now)).toBe("terms_time_invalid");
    expect(termsTimeProblem("2026-10-02T09:00:00Z", now)).toBe("terms_stale");
    expect(termsTimeProblem(undefined, now)).toBe("terms_missing");
  });
  it("date_paid of a capture is its Japan calendar day", () => {
    expect(jstDate("2026-10-04T15:30:00Z")).toBe("2026-10-05");
    expect(jstDate("2026-10-04T14:59:59Z")).toBe("2026-10-04");
  });
});

describe("C1 method lock (2026-10-05): a website order offers card only when card is its method", () => {
  it("transfer / paidy / null → method_not_chosen; square → offered; omitted → not checked", () => {
    expect(cardNotOfferedReason({ ...base, paymentMethod: "transfer" })).toBe("method_not_chosen");
    expect(cardNotOfferedReason({ ...base, paymentMethod: "paidy" })).toBe("method_not_chosen");
    expect(cardNotOfferedReason({ ...base, paymentMethod: null })).toBe("method_not_chosen");
    expect(cardNotOfferedReason({ ...base, paymentMethod: "square" })).toBeNull();
    expect(cardNotOfferedReason(base)).toBeNull();
  });
});
