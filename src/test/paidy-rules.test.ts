import { describe, expect, it } from "vitest";
import {
  isPaidyPublicKey, paidyAddressComplete, paidyAmountMatches, paidyAuthorizationExpired,
  normalizePaidyStatus, paidyModeFrom, paidyNotOfferedReason, paidyZip,
  paidyExpiryTime, paidyAuthorizationLapsed, paidyProviderOutcome, paidyCapturedAmount, paidyLatestCapture,
  paidyRecordProblem, paidyJapanDate, paidyBuyerHistory, paidyNewRefunds, paidyConfirmLeaseExpired,
  paidyYen, paidyJapaneseMobile, paidyAddressLines, paidyCheckoutBreakdown, paidyRefundTotal,
  PAIDY_CONFIRM_LEASE_MS,
  paidyFilingMismatch,
} from "../../supabase/functions/_shared/paidy-rules.ts";
import { paidyPublicKeyProblem } from "../components/settings/paidy-settings";

// Paidy ato-barai on a confirmed web order (2026-10-03, docs/PAIDY.md).
// The same file the website / review-payment-submission edge functions import.

const jp = { line1: "立石1-2-3", line2: "301", city: "葛飾区", region: "東京都", postal_code: "124-0012", country: "JP" };
const order = { currency: "JPY", status: "pending", payment_status: "pending_transfer", remaining_balance: 236800, source_channel: "web", ready_confirmed_at: "2026-10-03T00:00:00Z" };
const base = { mode: "on" as const, publicKey: "pk_live_abcdefgh1234", customerIsTest: false, order, address: jp, pendingSubmissions: 0 };

describe("paidy_mode is fail-closed", () => {
  it.each([["on", "on"], ['"on"', "on"], ["test", "test"], ["off", "off"], ["ON", "off"], [null, "off"], [true, "off"], ["yes", "off"]])(
    "%s → %s", (raw, want) => expect(paidyModeFrom(raw)).toBe(want),
  );
});

describe("only a public key reaches the website", () => {
  it("accepts pk_test_ / pk_live_, refuses sk_ and junk", () => {
    expect(isPaidyPublicKey("pk_test_iu36g8u0360h1fu787g74k2qgj")).toBe(true);
    expect(isPaidyPublicKey("pk_live_abcdefgh1234")).toBe(true);
    expect(isPaidyPublicKey("sk_test_abcdefgh1234")).toBe(false);
    expect(isPaidyPublicKey("pk_test_")).toBe(false);
    expect(isPaidyPublicKey(null)).toBe(false);
  });
  it("the settings card says so in words", () => {
    expect(paidyPublicKeyProblem("sk_test_abcdefgh1234")).toMatch(/SECRET/);
    expect(paidyPublicKeyProblem("hello")).toMatch(/Not a Paidy public key/);
    expect(paidyPublicKeyProblem("pk_test_iu36g8u0360h1fu787g74k2qgj")).toBeNull();
    expect(paidyPublicKeyProblem("")).toBeNull();
  });
});

describe("a Japanese address, complete to the room, with NNN-NNNN", () => {
  it("normalises the postal code", () => {
    expect(paidyZip("1240012")).toBe("124-0012");
    expect(paidyZip("〒124-0012")).toBe("124-0012");
    expect(paidyZip("１２４００１２")).toBe("124-0012");
    expect(paidyZip("1240")).toBeNull();
    expect(paidyZip(null)).toBeNull();
  });
  it("requires JP, line1, city, region and a postal code", () => {
    expect(paidyAddressComplete(jp)).toBe(true);
    expect(paidyAddressComplete({ ...jp, country: "PH" })).toBe(false);
    expect(paidyAddressComplete({ ...jp, country: "jp" })).toBe(true);
    expect(paidyAddressComplete({ ...jp, line1: "" })).toBe(false);
    expect(paidyAddressComplete({ ...jp, region: null })).toBe(false);
    expect(paidyAddressComplete({ ...jp, postal_code: "12" })).toBe(false);
    expect(paidyAddressComplete(null)).toBe(false);
  });
});

describe("when Paidy is offered (the order page and the ready email agree)", () => {
  it("offered on a confirmed yen order to a Japanese address with nothing pending", () => {
    expect(paidyNotOfferedReason(base)).toBeNull();
  });
  it.each([
    ["mode_off", { mode: "off" as const }],
    ["test_mode_real_customer", { mode: "test" as const, publicKey: "pk_test_abcdefgh1234" }],
    ["no_public_key", { publicKey: "" }],
    ["key_mode_mismatch", { publicKey: "pk_test_abcdefgh1234" }],
    ["key_mode_mismatch", { mode: "test" as const, customerIsTest: true }],
    ["not_jpy", { order: { ...order, currency: "PHP" } }],
    ["order_not_open", { order: { ...order, status: "completed" } }],
    ["no_payment_due", { order: { ...order, payment_status: "awaiting_confirmation" } }],
    ["not_ready_for_payment", { order: { ...order, ready_confirmed_at: null } }],
    ["nothing_due", { order: { ...order, remaining_balance: 0 } }],
    ["address_not_jp_or_incomplete", { address: { ...jp, country: "PH" } }],
    ["address_not_jp_or_incomplete", { address: null }],
    ["submission_pending", { pendingSubmissions: 1 }],
    ["amount_not_whole_yen", { order: { ...order, remaining_balance: 236799.5 } }],
    ["part_paid", { totalPaid: 1000 }],
    ["payment_in_progress", { paymentLock: "paidy_checkout_open" }],
    ["payment_in_progress", { paymentLock: "submission_pending" }],
    ["no_buyer_name", { buyerName: "  " }],
    ["breakdown_mismatch", { breakdownOk: false }],
  ])("refused: %s", (reason, over) => {
    expect(paidyNotOfferedReason({ ...base, ...over })).toBe(reason);
  });
  it("test mode offers it to a test customer with a test key", () => {
    expect(paidyNotOfferedReason({ ...base, mode: "test", publicKey: "pk_test_abcdefgh1234", customerIsTest: true })).toBeNull();
  });
  it("a Hub-created yen order (no source_channel) can be paid with Paidy too", () => {
    expect(paidyNotOfferedReason({ ...base, order: { ...order, source_channel: null, ready_confirmed_at: null } })).toBeNull();
  });
});

describe("capture guards", () => {
  it("PD4: an authorisation older than 30 days is expired", () => {
    const now = new Date("2026-11-03T00:00:00Z");
    expect(paidyAuthorizationExpired("2026-10-04T00:00:01Z", now)).toBe(false);
    expect(paidyAuthorizationExpired("2026-10-03T23:59:59Z", now)).toBe(true);
    expect(paidyAuthorizationExpired("garbage", now)).toBe(true);
  });
  it("the amount must be the remaining balance, to the yen — never rounded (R14)", () => {
    expect(paidyAmountMatches(236800, "236800.00")).toBe(true);
    expect(paidyAmountMatches(236800, 236801)).toBe(false);
    expect(paidyAmountMatches(0, 0)).toBe(false);
    expect(paidyAmountMatches(52000, 51999.6)).toBe(false);
    expect(paidyAmountMatches(52000.4, 52000)).toBe(false);
  });
});

// The status normaliser (the live Checkout sent "authorized" in lower case on
// 2026-10-03; the reference says AUTHORIZED). Pure, in paidy-rules.ts, so this
// file never imports the Deno-only API client.
describe("normalizePaidyStatus", () => {
  it("upper-cases whatever Paidy sends", () => {
    expect(normalizePaidyStatus("authorized")).toBe("AUTHORIZED");
    expect(normalizePaidyStatus("CLOSED")).toBe("CLOSED");
    expect(normalizePaidyStatus(" rejected ")).toBe("REJECTED");
    expect(normalizePaidyStatus(undefined)).toBe("");
  });
});

// Integrity rules (2026-10-04, review P01–P12; docs/PAIDY.md "Integrity").
describe("P07 expiry follows Paidy's own expires_at", () => {
  const auth = "2026-10-01T00:00:00Z";
  it("uses expires_at when Paidy sent one", () => {
    expect(paidyExpiryTime(auth, "2026-10-20T00:00:00Z")).toBe(Date.parse("2026-10-20T00:00:00Z"));
  });
  it("falls back to 30 days (720 h) after authorisation", () => {
    expect(paidyExpiryTime(auth, null)).toBe(Date.parse("2026-10-31T00:00:00Z"));
    expect(paidyExpiryTime(auth, "garbage")).toBe(Date.parse("2026-10-31T00:00:00Z"));
  });
  it("unknown dates count as lapsed", () => {
    expect(paidyExpiryTime(null, null)).toBeNull();
    expect(paidyAuthorizationLapsed({})).toBe(true);
  });
  it("lapses exactly at expires_at, not before", () => {
    const rec = { authorized_at: auth, expires_at: "2026-10-20T00:00:00Z" };
    expect(paidyAuthorizationLapsed(rec, new Date("2026-10-19T23:59:59Z"))).toBe(false);
    expect(paidyAuthorizationLapsed(rec, new Date("2026-10-20T00:00:00Z"))).toBe(true);
  });
});

describe("P03 decisions come from Paidy's read-back, never from an HTTP code", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  const exp = "2026-10-31T00:00:00Z";
  it("a capture on Paidy is captured whatever the status says", () => {
    expect(paidyProviderOutcome({ status: "CLOSED", captures: [{ id: "cap_1", amount: 1000 }], expires_at: exp }, now)).toBe("captured");
    expect(paidyProviderOutcome({ status: "authorized", captures: [{ id: "cap_1", amount: 1000 }] }, now)).toBe("captured");
  });
  it("authorized and in time / past expires_at", () => {
    expect(paidyProviderOutcome({ status: "AUTHORIZED", captures: [], expires_at: exp }, now)).toBe("authorized");
    expect(paidyProviderOutcome({ status: "AUTHORIZED", captures: [], expires_at: "2026-10-09T00:00:00Z" }, now)).toBe("expired");
  });
  it("closed without capture, rejected, unknown", () => {
    expect(paidyProviderOutcome({ status: "CLOSED", captures: [] }, now)).toBe("closed");
    expect(paidyProviderOutcome({ status: "rejected" }, now)).toBe("rejected");
    expect(paidyProviderOutcome({ status: "PENDING" }, now)).toBe("unknown");
    expect(paidyProviderOutcome(null, now)).toBe("unknown");
  });
  it("captured amount and the latest capture", () => {
    const p = { captures: [{ id: "cap_1", amount: 1000 }, { id: "cap_2", amount: "500" }] };
    expect(paidyCapturedAmount(p)).toBe(1500);
    expect(paidyCapturedAmount({ captures: [{ id: "c", amount: 999.5 }] })).toBeNaN();
    expect(paidyLatestCapture(p)).toEqual({ id: "cap_2", amount: 500, created_at: undefined });
    expect(paidyLatestCapture({ captures: [] })).toBeNull();
  });
});

describe("recording a dashboard capture: exact yen, nothing refunded (R14/R17, owner D4)", () => {
  const ok = { capturedAmount: 236800, recordAmount: "236800.00", submittedAmount: 236800, refundedAmount: 0 };
  it("all equal → no problem", () => expect(paidyRecordProblem(ok)).toBeNull());
  it.each([
    [{ capturedAmount: NaN }, "captured_amount_invalid"],
    [{ capturedAmount: 236000 }, "captured_vs_authorized"],
    [{ submittedAmount: 236799.6 }, "authorized_vs_submission"],
    [{ refundedAmount: 1000 }, "refunded"],
  ])("%o → %s", (patch, want) => expect(paidyRecordProblem({ ...ok, ...patch })).toBe(want));
});

describe("paidyYen — exact whole yen or nothing (R14)", () => {
  it.each([[52000, 52000], ["52000.00", 52000], [51999.6, null], [-1, null], [0, null], [NaN, null], [Infinity, null], ["", null], [null, null], [true, null]])(
    "%o → %o", (raw, want) => expect(paidyYen(raw)).toBe(want));
});

describe("Q5 the capture day is Japan time", () => {
  it("23:30 UTC is already the next day in Japan", () => {
    expect(paidyJapanDate("2026-10-04T15:30:00Z")).toBe("2026-10-05");
    expect(paidyJapanDate("2026-10-04T14:59:59Z")).toBe("2026-10-04");
  });
});

describe("R12 buyer history: completed yen orders, not Paidy, not refunded, by order value", () => {
  const now = new Date("2026-10-04T00:00:00Z");
  it("counts the right orders and dates the last one in days", () => {
    expect(paidyBuyerHistory([
      { status: "completed", currency: "JPY", total_amount: 50000, completed_at: "2026-09-30T00:00:00Z" },
      { status: "completed", currency: "JPY", total_amount: 12000, completed_at: "2026-08-01T00:00:00Z" },
      { status: "completed", currency: "JPY", total_amount: 80000, completed_at: "2026-10-01T00:00:00Z", paid_by_paidy: true },
      { status: "completed", currency: "JPY", total_amount: 7000, completed_at: "2026-10-02T00:00:00Z", refunded: true },
      { status: "cancelled", currency: "JPY", total_amount: 9000, completed_at: null },
      { status: "completed", currency: "PHP", total_amount: 9000, completed_at: "2026-10-02T00:00:00Z" },
    ], now)).toEqual({ order_count: 2, ltv: 62000, last_order_amount: 50000, last_order_at: 4 });
  });
  it("a first-time customer: zeros and no last-order fields (never invented)", () =>
    expect(paidyBuyerHistory([], now)).toEqual({ order_count: 0, ltv: 0 }));
});

describe("R13 contact and address", () => {
  it("only a Japanese mobile is prefilled", () => {
    expect(paidyJapaneseMobile("090-1234-5678")).toBe("09012345678");
    expect(paidyJapaneseMobile("+81 80 1234 5678")).toBe("08012345678");
    expect(paidyJapaneseMobile("03-1234-5678")).toBeNull();
    expect(paidyJapaneseMobile("+63 917 123 4567")).toBeNull();
    expect(paidyJapaneseMobile(null)).toBeNull();
  });
  it("building in line1, street in line2 (Paidy Checkout's convention)", () => {
    expect(paidyAddressLines(jp)).toEqual({ line1: "301", line2: "立石1-2-3", city: "葛飾区", state: "東京都", zip: "124-0012" });
    expect(paidyAddressLines({ ...jp, line2: "" }).line1).toBeUndefined();
  });
});

describe("R10 one charge breakdown that adds up to the amount", () => {
  const o = { total_amount: 101500, remaining_balance: 101500, shipping_fee: 1500, discount_amount: 0 };
  const line = (price: number, qty = 1) => ({ sku: "R1", quantity: qty, title: "Ring", unit_price_jpy: price });
  it("items + shipping = amount", () => {
    const b = paidyCheckoutBreakdown(o, [line(50000, 2)], "CJ-W-1")!;
    expect(b.amount).toBe(101500);
    expect(b.items).toEqual([{ id: "R1", quantity: 2, title: "Ring", unit_price: 50000 }]);
  });
  it("a discount is its own negative line", () => {
    const b = paidyCheckoutBreakdown({ ...o, total_amount: 96500, remaining_balance: 96500, discount_amount: 5000 }, [line(100000)], "CJ-W-1")!;
    expect(b.items.at(-1)).toEqual({ id: "discount", quantity: 1, title: "Discount", unit_price: -5000 });
    expect(b.items.reduce((s, i) => s + i.unit_price * i.quantity, 0) + b.shipping).toBe(96500);
  });
  it("a staff-added fee becomes an explicit line", () => {
    const b = paidyCheckoutBreakdown({ ...o, total_amount: 104500, remaining_balance: 104500 }, [line(100000)], "CJ-W-1")!;
    expect(b.items.at(-1)).toEqual({ id: "other", quantity: 1, title: "Other charges", unit_price: 3000 });
  });
  it("no item lines → one line for the order", () => {
    const b = paidyCheckoutBreakdown(o, [], "12345")!;
    expect(b.items).toEqual([{ id: "12345", quantity: 1, title: "Order 12345", unit_price: 100000 }]);
  });
  it("part-paid, fractional, or lines that claim more than the order → not offered", () => {
    expect(paidyCheckoutBreakdown({ ...o, remaining_balance: 81500 }, [line(100000)], "x")).toBeNull();
    expect(paidyCheckoutBreakdown({ ...o, total_amount: 101500.5, remaining_balance: 101500.5 }, [line(100000)], "x")).toBeNull();
    expect(paidyCheckoutBreakdown(o, [line(200000)], "x")).toBeNull();
  });
  it("points used at checkout: amount = total − points, with a negative Points line (2026-10-05)", () => {
    const b = paidyCheckoutBreakdown({ ...o, remaining_balance: 98500, points_applied: 3000 }, [line(100000)], "CJ-W-1")!;
    expect(b.amount).toBe(98500);
    expect(b.items.at(-1)).toEqual({ id: "points", quantity: 1, title: "Points", unit_price: -3000 });
    expect(b.items.reduce((s, i) => s + i.unit_price * i.quantity, 0) + b.shipping).toBe(98500);
    // money paid on top of points is still part-paid
    expect(paidyCheckoutBreakdown({ ...o, remaining_balance: 90000, points_applied: 3000 }, [line(100000)], "x")).toBeNull();
  });
});

describe("C1 method lock (2026-10-05): a website order offers Paidy only when Paidy is its method", () => {
  it("transfer / card / null method → method_not_chosen", () => {
    expect(paidyNotOfferedReason({ ...base, paymentMethod: "transfer" })).toBe("method_not_chosen");
    expect(paidyNotOfferedReason({ ...base, paymentMethod: "square" })).toBe("method_not_chosen");
    expect(paidyNotOfferedReason({ ...base, paymentMethod: null })).toBe("method_not_chosen");
  });
  it("paidy → offered; omitted → not checked", () => {
    expect(paidyNotOfferedReason({ ...base, paymentMethod: "paidy" })).toBeNull();
    expect(paidyNotOfferedReason(base)).toBeNull();
  });
});

describe("P11 refunds are recorded once per refund id", () => {
  it("returns only unseen, positive refunds", () => {
    const p = { refunds: [{ id: "ref_1", amount: 1000 }, { id: "ref_2", amount: 500, created_at: "2026-10-05T00:00:00Z" }, { id: "ref_3", amount: 0 }] };
    expect(paidyNewRefunds(p, ["ref_1"]).map(({ raw: _raw, ...r }) => r)).toEqual([{ id: "ref_2", amount: 500, created_at: "2026-10-05T00:00:00Z", capture_id: undefined, reason: null }]);
    expect(paidyNewRefunds({}, [])).toEqual([]);
  });
  it("R17: keeps the capture link and the full refund object", () => {
    const r = { id: "ref_9", amount: 2000, capture_id: "cap_1", reason: "requested_by_customer", created_at: "2026-10-05T00:00:00Z" };
    const [n] = paidyNewRefunds({ refunds: [r] }, []);
    expect(n.capture_id).toBe("cap_1");
    expect(n.raw).toEqual(r);
  });
  it("R06: the refund total is always the whole ledger", () => {
    expect(paidyRefundTotal({ refunds: [{ amount: 2000 }, { amount: 500 }] })).toBe(2500);
  });
});

describe("P02 an interrupted Confirm may be resumed after the lease", () => {
  const now = new Date("2026-10-04T03:00:00Z");
  it("no stamp (older code) → resumable", () => expect(paidyConfirmLeaseExpired(null, now)).toBe(true));
  it("inside the lease → not yet", () => expect(paidyConfirmLeaseExpired(new Date(now.getTime() - PAIDY_CONFIRM_LEASE_MS + 1000).toISOString(), now)).toBe(false));
  it("past the lease → resumable", () => expect(paidyConfirmLeaseExpired(new Date(now.getTime() - PAIDY_CONFIRM_LEASE_MS).toISOString(), now)).toBe(true));
});

describe("P01/P12 paidyFilingMismatch — one rule for callback, webhook and sweep", () => {
  const order = { remaining_balance: 52000 };
  const ok = { status: "AUTHORIZED", currency: "JPY", test: true, amount: 52000, order: { order_ref: "CJ-W-900011" } };
  const expect_ = { test: true, orderRef: "CJ-W-900011" };
  it("a matching authorisation files", () => expect(paidyFilingMismatch(ok, order, expect_)).toBeNull());
  it("lower-case status is still AUTHORIZED", () => expect(paidyFilingMismatch({ ...ok, status: "authorized" }, order, expect_)).toBeNull());
  it("no read-back → unknown_payment", () => expect(paidyFilingMismatch(null, order, expect_)).toBe("unknown_payment"));
  it("closed → not_authorized", () => expect(paidyFilingMismatch({ ...ok, status: "CLOSED" }, order, expect_)).toBe("not_authorized"));
  it("currency", () => expect(paidyFilingMismatch({ ...ok, currency: "USD" }, order, expect_)).toBe("not_jpy"));
  it("test flag must match the mode", () => expect(paidyFilingMismatch({ ...ok, test: false }, order, expect_)).toBe("test_flag"));
  it("amount must equal the balance", () => expect(paidyFilingMismatch({ ...ok, amount: 51999 }, order, expect_)).toBe("amount"));
  it("order_ref must name this order", () => expect(paidyFilingMismatch({ ...ok, order: { order_ref: "CJ-W-900012" } }, order, expect_)).toBe("order_ref"));
});
