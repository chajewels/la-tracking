import { describe, expect, it } from "vitest";
import {
  SQUARE_MODE_LABEL, squareAgreementLabel, squareAppIdProblem, squareEffect,
  squareLocationIdProblem, squareRefusal,
} from "../components/settings/square-settings";

// Website → Settings → Card payments (Square), S1 (2026-10-04, docs/SQUARE.md).
// Pins the pure parts of the card: the id checks mirror set_square_settings.

describe("squareAppIdProblem — only a PUBLIC Application ID is ever stored", () => {
  it("accepts a sandbox and a production Application ID", () => {
    expect(squareAppIdProblem("sandbox-sq0idb-AbCdEf123456")).toBeNull();
    expect(squareAppIdProblem("sq0idp-AbCdEf123456")).toBeNull();
  });
  it("refuses an access token / application secret, naming the Lovable secret", () => {
    expect(squareAppIdProblem("EAAAl1234567890abcdef")).toMatch(/ACCESS TOKEN/);
    expect(squareAppIdProblem("EAAAl1234567890abcdef")).toMatch(/SQUARE_ACCESS_TOKEN/);
    expect(squareAppIdProblem("sq0atp-abcdef123456")).toMatch(/ACCESS TOKEN/);
    expect(squareAppIdProblem("sq0csp-abcdef123456")).toMatch(/ACCESS TOKEN/);
  });
  it("refuses anything else, and allows blank (clear)", () => {
    expect(squareAppIdProblem("pk_live_abc")).toMatch(/Not a Square Application ID/);
    expect(squareAppIdProblem("sq0idp-ab")).toMatch(/Not a Square Application ID/);
    expect(squareAppIdProblem("")).toBeNull();
  });
});

describe("squareLocationIdProblem", () => {
  it("accepts capital letters and digits of 8+", () => {
    expect(squareLocationIdProblem("L8XK2M9Q4ZT1A")).toBeNull();
    expect(squareLocationIdProblem("")).toBeNull();
  });
  it("refuses lowercase, short or spaced values", () => {
    expect(squareLocationIdProblem("l8xk2m9q4zt1a")).toMatch(/Not a Square Location ID/);
    expect(squareLocationIdProblem("L8XK2")).toMatch(/Not a Square Location ID/);
    expect(squareLocationIdProblem("L8XK 2M9Q4")).toMatch(/Not a Square Location ID/);
  });
});

describe("agreement threshold label — owner decision D9 (every card payment)", () => {
  it("0 means every card payment needs the signed agreement", () => {
    expect(squareAgreementLabel(0)).toMatch(/Every card payment/);
    expect(squareAgreementLabel(-1)).toMatch(/Every card payment/);
  });
  it("a positive threshold names the yen amount", () => {
    expect(squareAgreementLabel(50000)).toMatch(/¥50,000 and above/);
  });
});

describe("mode labels, effects and refusals", () => {
  it("test mode says test customers only and sandbox", () => {
    expect(SQUARE_MODE_LABEL.test).toMatch(/test customers only/);
    expect(squareEffect("test")).toMatch(/is_test/);
    expect(squareEffect("test")).toMatch(/SANDBOX/);
  });
  it("on says capture only on Confirm; off says not offered", () => {
    expect(squareEffect("on")).toMatch(/Confirm/);
    expect(squareEffect("off")).toMatch(/not offered/);
  });
  it("maps every setter refusal to plain words and echoes unknown codes", () => {
    for (const code of [
      "permission_denied", "stale", "invalid_mode", "invalid_app_id", "invalid_location_id",
      "invalid_agreement_min", "sandbox_app_id_required", "production_app_id_required",
      "location_id_required", "setting_missing", "user_identity_required",
    ]) {
      expect(squareRefusal(code)).not.toBe(code);
    }
    expect(squareRefusal("something_else")).toBe("something_else");
  });
});
