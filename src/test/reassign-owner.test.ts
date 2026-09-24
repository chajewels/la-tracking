import { describe, expect, it } from "vitest";
import {
  cashAwardPoint,
  catchUpDecision,
  catchUpPurchaseDates,
  classifyAwardResult,
  expiredOnAward,
  hasLoyaltyHistory,
  httpStatusFor,
  isClosedStatus,
  isDownpaymentPayment,
  layawayAwardPoint,
  lotExpiresOn,
  priorityRefusal,
  withinGrace,
} from "../../supabase/functions/_shared/reassign-owner-rules.ts";

/**
 * Reassign Owner rules (CLAUDE.md "REASSIGN OWNER — NON-NEGOTIABLE").
 * reassign_order_owner_atomic is authoritative; these guard the TS mirror the
 * edge function and award-loyalty-points actually run. Each one fails SILENTLY
 * if it regresses: an order leaves a points account, a catch-up is granted to
 * someone who enrolled after paying, or a lot's expiry is pulled backwards.
 */

describe("closed statuses (R5)", () => {
  it("layaway: cancelled, forfeited and final_forfeited are closed", () => {
    for (const s of ["cancelled", "forfeited", "final_forfeited"]) expect(isClosedStatus("layaway", s)).toBe(true);
    for (const s of ["active", "overdue", "completed", "extension_active", "reactivated", "final_settlement"]) {
      expect(isClosedStatus("layaway", s)).toBe(false);
    }
  });
  it("cash: cancelled and expired are closed; completed is not", () => {
    expect(isClosedStatus("cash", "cancelled")).toBe(true);
    expect(isClosedStatus("cash", "expired")).toBe(true);
    expect(isClosedStatus("cash", "completed")).toBe(false);
    expect(isClosedStatus("cash", "pending")).toBe(false);
  });
});

describe("points account (R1)", () => {
  it("any loyalty history counts — points, spend or migration baseline", () => {
    expect(hasLoyaltyHistory(null)).toBe(false);
    expect(hasLoyaltyHistory({ total_points_earned: 0, cumulative_spend_jpy: 0, spend_baseline_jpy: 0 })).toBe(false);
    expect(hasLoyaltyHistory({ total_points_earned: 1 })).toBe(true);
    expect(hasLoyaltyHistory({ cumulative_spend_jpy: 5000 })).toBe(true);
    expect(hasLoyaltyHistory({ spend_baseline_jpy: 20000 })).toBe(true);
  });
  it("the order never leaves a points account; both → owner handles it", () => {
    const pts = { total_points_earned: 100 };
    expect(priorityRefusal(pts, null)).toBe("points_account_is_current_owner");
    expect(priorityRefusal(pts, pts)).toBe("both_have_points");
    expect(priorityRefusal(null, pts)).toBeNull();
    expect(priorityRefusal(null, null)).toBeNull();
  });
});

describe("award point (R6)", () => {
  it("layaway uses the earliest DP payment's created_at, skipping LOYALTY-% and voided rows", () => {
    const pay = [
      { created_at: "2026-08-05T00:00:00Z", reference_number: "DP-1" },
      { created_at: "2026-07-30T00:00:00Z", reference_number: "LOYALTY-9", remarks: "downpayment" },
      { created_at: "2026-08-01T00:00:00Z", reference_number: "DP-0", voided_at: "2026-08-02T00:00:00Z" },
      { created_at: "2026-08-03T00:00:00Z", reference_number: "BANK", remarks: "Down payment" },
      { created_at: "2026-07-01T00:00:00Z", reference_number: "BANK", remarks: "installment" },
    ];
    expect(layawayAwardPoint(pay, [])).toEqual({ at: "2026-08-03T00:00:00Z", source: "downpayment_payment" });
  });
  it("layaway falls back to the confirmed DP submission, then to no award point", () => {
    expect(layawayAwardPoint([], ["2026-08-09T00:00:00Z", "2026-08-07T00:00:00Z"]))
      .toEqual({ at: "2026-08-07T00:00:00Z", source: "downpayment_submission" });
    expect(layawayAwardPoint([], [])).toEqual({ at: null, source: null });
  });
  it("DP detection matches the Hub rule", () => {
    expect(isDownpaymentPayment({ created_at: "", reference_number: "DP-5" })).toBe(true);
    expect(isDownpaymentPayment({ created_at: "", remarks: "DOWNPAYMENT" })).toBe(true);
    expect(isDownpaymentPayment({ created_at: "", reference_number: "LOYALTY-1", remarks: "downpayment" })).toBe(false);
    expect(isDownpaymentPayment({ created_at: "", reference_number: "X" })).toBe(false);
  });
  it("cash uses completed_at, else the payment that made it fully paid", () => {
    const order = { status: "completed", completed_at: null, total_amount: 200 };
    const pays = [
      { created_at: "2026-02-05T00:00:00Z", amount_paid: 100 },
      { created_at: "2026-02-02T00:00:00Z", amount_paid: 100 },
      { created_at: "2026-02-01T00:00:00Z", amount_paid: 500, voided_at: "2026-02-01T01:00:00Z" },
    ];
    expect(cashAwardPoint(order, pays)).toEqual({ at: "2026-02-05T00:00:00Z", source: "fully_paid_payment" });
    expect(cashAwardPoint({ ...order, completed_at: "2026-02-06T00:00:00Z" }, pays))
      .toEqual({ at: "2026-02-06T00:00:00Z", source: "completed_at" });
  });
  it("a cash order that is not completed has no award point yet", () => {
    expect(cashAwardPoint({ status: "pending", completed_at: null, total_amount: 1 }, [{ created_at: "2026-01-01", amount_paid: 5 }]))
      .toEqual({ at: null, source: null });
  });
});

describe("grace window and catch-up decision (R6)", () => {
  const enrolled = "2026-09-20T00:00:00Z";
  it("the award point may be up to 3 days before enrolment by default", () => {
    expect(withinGrace("2026-09-17T00:00:00Z", enrolled)).toBe(true);
    expect(withinGrace("2026-09-16T23:59:59Z", enrolled)).toBe(false);
    expect(withinGrace("2026-09-10T00:00:00Z", enrolled, 10)).toBe(true);
  });
  it("decides eligible / not_enrolled / not_at_award_point / paid_before_enrollment", () => {
    expect(catchUpDecision({ enrolledAt: null, awardAt: "2026-09-21T00:00:00Z" })).toBe("not_enrolled");
    expect(catchUpDecision({ enrolledAt: enrolled, awardAt: null })).toBe("not_at_award_point");
    expect(catchUpDecision({ enrolledAt: enrolled, awardAt: "2026-09-10T00:00:00Z" })).toBe("paid_before_enrollment");
    expect(catchUpDecision({ enrolledAt: enrolled, awardAt: "2026-09-18T00:00:00Z" })).toBe("eligible");
  });
});

describe("expiry and purchase dates (R7)", () => {
  it("the catch-up lot expires order_date + 180 days", () => {
    expect(lotExpiresOn("2026-08-01")).toBe("2027-01-28");
    expect(lotExpiresOn("2026-02-01")).toBe("2026-07-31");
  });
  it("points are born expired once order_date + 180 days has passed in PHT", () => {
    const now = new Date("2026-09-24T03:00:00Z");
    expect(expiredOnAward("2026-02-01", now)).toBe(true);
    expect(expiredOnAward("2026-08-01", now)).toBe(false);
    // Expiry day itself counts as expired (the lot's expiry is PHT midnight that day).
    expect(expiredOnAward("2026-03-28", now)).toBe(true);
    expect(expiredOnAward("2026-03-29", now)).toBe(false);
  });
  it("last_purchase_at only moves forward, and prev_purchase_at only shifts when it does", () => {
    expect(catchUpPurchaseDates("2026-09-01T00:00:00Z", "2026-08-01")).toEqual({});
    expect(catchUpPurchaseDates("2026-07-01T00:00:00Z", "2026-08-01")).toEqual({
      last_purchase_at: "2026-07-31T16:00:00.000Z",
      prev_purchase_at: "2026-07-01T00:00:00Z",
    });
    expect(catchUpPurchaseDates(null, "2026-08-01")).toEqual({
      last_purchase_at: "2026-07-31T16:00:00.000Z",
      prev_purchase_at: null,
    });
  });
});

describe("edge function outcomes", () => {
  it("maps codes to HTTP", () => {
    expect(httpStatusFor("not_found")).toBe(404);
    expect(httpStatusFor("forbidden")).toBe(403);
    expect(httpStatusFor("points_account_is_current_owner")).toBe(409);
    expect(httpStatusFor("already_earned")).toBe(409);
    expect(httpStatusFor("same_owner")).toBe(409);
    expect(httpStatusFor("reason_required")).toBe(400);
    expect(httpStatusFor("something_new")).toBe(400);
  });
  it("only a real award or an expected skip is not a failure (R9)", () => {
    expect(classifyAwardResult(true, { awarded: true })).toBe("awarded");
    expect(classifyAwardResult(true, { skipped: true, reason: "below_minimum" })).toBe("benign_skip");
    expect(classifyAwardResult(true, { skipped: true, reason: "loyalty_disabled" })).toBe("benign_skip");
    expect(classifyAwardResult(true, { skipped: true, reason: "already_awarded" })).toBe("failed");
    expect(classifyAwardResult(true, { skipped: true, reason: "not_enrolled" })).toBe("failed");
    expect(classifyAwardResult(false, { error: "boom" })).toBe("failed");
    expect(classifyAwardResult(true, null)).toBe("failed");
  });
});
