import { describe, expect, it } from "vitest";
import {
  isPaidyPublicKey, paidyAddressComplete, paidyAmountMatches, paidyAuthorizationExpired,
  normalizePaidyStatus, paidyModeFrom, paidyNotOfferedReason, paidyZip,
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
