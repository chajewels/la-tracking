import { describe, expect, it } from "vitest";
import {
  isPaidyPublicKey, paidyAddressComplete, paidyAmountMatches, paidyAuthorizationExpired,
  normalizePaidyStatus, paidyModeFrom, paidyNotOfferedReason, paidyZip,
  paidyExpiryTime, paidyAuthorizationLapsed, paidyProviderOutcome, paidyCapturedAmount, paidyLatestCapture,
  paidyCaptureAmountProblem, paidyJapanDate, paidyLastOrderAmount, paidyNewRefunds, paidyConfirmLeaseExpired,
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
  it("the amount must be the remaining balance, to the yen", () => {
    expect(paidyAmountMatches(236800, "236800.00")).toBe(true);
    expect(paidyAmountMatches(236800, 236801)).toBe(false);
    expect(paidyAmountMatches(0, 0)).toBe(false);
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
    expect(paidyLatestCapture(p)).toEqual({ id: "cap_2", amount: 500, created_at: undefined });
    expect(paidyLatestCapture({ captures: [] })).toBeNull();
  });
});

describe("P08 amounts agree before a capture", () => {
  const ok = { providerAmount: 236800, recordAmount: "236800.00", submittedAmount: 236800, remainingBalance: 236800 };
  it("all equal → no problem", () => expect(paidyCaptureAmountProblem(ok)).toBeNull());
  it.each([
    [{ providerAmount: 0 }, "provider_amount_missing"],
    [{ providerAmount: 236000 }, "provider_vs_record"],
    [{ submittedAmount: 236000 }, "record_vs_submission"],
    [{ remainingBalance: 100000 }, "exceeds_remaining"],
  ])("%o → %s", (patch, want) => expect(paidyCaptureAmountProblem({ ...ok, ...patch })).toBe(want));
});

describe("Q5 the capture day is Japan time", () => {
  it("23:30 UTC is already the next day in Japan", () => {
    expect(paidyJapanDate("2026-10-04T15:30:00Z")).toBe("2026-10-05");
    expect(paidyJapanDate("2026-10-04T14:59:59Z")).toBe("2026-10-04");
  });
});

describe("P10 last_order_amount is the latest COMPLETED order", () => {
  it("sorts by completed_at, ignores unpaid and pending", () => {
    expect(paidyLastOrderAmount([
      { total_paid: 50000, status: "completed", completed_at: "2026-09-30T00:00:00Z" },
      { total_paid: 12000, status: "completed", completed_at: "2026-08-01T00:00:00Z" },
      { total_paid: 99000, status: "pending", completed_at: null },
      { total_paid: 0, status: "completed", completed_at: "2026-10-01T00:00:00Z" },
    ])).toBe(50000);
  });
  it("none → undefined", () => expect(paidyLastOrderAmount([])).toBeUndefined());
});

describe("P11 refunds are recorded once per refund id", () => {
  it("returns only unseen, positive refunds", () => {
    const p = { refunds: [{ id: "ref_1", amount: 1000 }, { id: "ref_2", amount: 500, created_at: "2026-10-05T00:00:00Z" }, { id: "ref_3", amount: 0 }] };
    expect(paidyNewRefunds(p, ["ref_1"])).toEqual([{ id: "ref_2", amount: 500, created_at: "2026-10-05T00:00:00Z" }]);
    expect(paidyNewRefunds({}, [])).toEqual([]);
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
