import { describe, expect, it } from "vitest";
import {
  claimLeaseExpired, isOrphanCaptureCase, isPermissionRefusal, orphanRecordErrorText, orphanRecordSuccessText,
  paidyLockView, PAIDY_LOCK_LINES, ORPHAN_RECORD_ERRORS,
} from "@/lib/paidy-staff-ui";
import { refundMethodChoice, refusalText, type RefundParts } from "@/components/web-orders/MarkRefundIssuedDialog";
import { STAFF_BELL_EMAIL_CHOICES } from "@/components/settings/staff-bell-emails";

// Paidy QC PR-B (owner "all recommended", 2026-10-10). Pure decisions behind
// the staff Paidy UI; the SQL and edge functions remain the authority.

describe("M1: a permission refusal is decided by status / code, never by the message", () => {
  it("403 is a permission refusal", () => {
    expect(isPermissionRefusal(403, undefined)).toBe(true);
    expect(isPermissionRefusal(403, "paidy_unverified")).toBe(true);
  });
  it("a coded forbidden / permission_denied / insufficient_permission is one", () => {
    for (const c of ["forbidden", "permission_denied", "insufficient_permission", "FORBIDDEN"]) {
      expect(isPermissionRefusal(400, c)).toBe(true);
      expect(isPermissionRefusal(undefined, c)).toBe(true);
    }
  });
  it("a 502 paidy_unverified quoting Paidy's service.forbidden is NOT one", () => {
    expect(isPermissionRefusal(502, "paidy_unverified")).toBe(false);
    expect(isPermissionRefusal(502, "forbidden")).toBe(false);
    expect(isPermissionRefusal(undefined, "paidy_unverified")).toBe(false);
    expect(isPermissionRefusal(409, undefined)).toBe(false);
  });
});

describe("M2: orphan capture cases", () => {
  it("a capture kind with no paidy_payments row is an orphan", () => {
    for (const kind of ["captured_unrecorded", "captured_no_submission", "record_failed"]) {
      expect(isOrphanCaptureCase({ kind, paidy_payment_row: null })).toBe(true);
      expect(isOrphanCaptureCase({ kind, paidy_payment_row: "row-1" })).toBe(false);
    }
    expect(isOrphanCaptureCase({ kind: "close_failed", paidy_payment_row: null })).toBe(false);
  });
  it("every refusal code has plain words; the server's message wins", () => {
    const codes = ["forbidden_admin_only", "reason_required", "case_not_found", "case_not_orphan", "case_not_open", "order_missing",
      "order_cannot_take_payment", "amount_differs_from_balance", "order_part_paid", "not_yen", "paidy_not_captured", "paidy_refunded",
      "paidy_order_mismatch", "paidy_environment_mismatch", "paidy_unavailable", "payment_in_progress", "already_recorded"];
    for (const c of codes) expect(ORPHAN_RECORD_ERRORS[c], c).toBeTruthy();
    expect(orphanRecordErrorText("paidy_unavailable", "Paidy said 503.")).toBe("Paidy said 503.");
    expect(orphanRecordErrorText("not_yen", "")).toMatch(/yen/);
    expect(orphanRecordErrorText("weird_code")).toMatch(/weird_code/);
  });
  it("success wording follows the outcome", () => {
    expect(orphanRecordSuccessText("recorded")).toMatch(/completed/);
    expect(orphanRecordSuccessText("queued")).toMatch(/within the hour/);
  });
});

describe("M3: the server lock decides the cash order page", () => {
  it("non-Paidy locks and the open Paidy window are not a Paidy hold", () => {
    for (const l of [null, undefined, "", "card_payment_unresolved", "submission_pending", "paidy_checkout_open"]) {
      expect(paidyLockView(l as string | null).paidyHold).toBe(false);
    }
  });
  it("each Paidy lock maps to its line", () => {
    expect(paidyLockView("paidy_submission_pending")).toEqual({ paidyHold: true, kind: "submission_pending", line: PAIDY_LOCK_LINES.submission_pending });
    expect(paidyLockView("paidy_captured_unrecorded")).toMatchObject({ paidyHold: true, kind: "captured_unrecorded" });
    expect(PAIDY_LOCK_LINES.captured_unrecorded).toMatch(/Paidy cases/);
    expect(paidyLockView("paidy_authorized")).toMatchObject({ paidyHold: true, kind: "authorized" });
    expect(PAIDY_LOCK_LINES.authorized).toMatch(/hourly Paidy check/);
    expect(PAIDY_LOCK_LINES.submission_pending).toMatch(/Finish recording/);
    expect(paidyLockView("paidy_something_new")).toMatchObject({ paidyHold: true, kind: "other" });
  });
});

describe("L5: Finish recording waits for the 5-minute lease", () => {
  const now = Date.parse("2026-10-10T03:00:00Z");
  it("hidden while the claim is younger than 5 minutes", () => {
    expect(claimLeaseExpired("2026-10-10T02:57:00Z", now)).toBe(false);
  });
  it("shown at 5 minutes and after, and when no stamp exists", () => {
    expect(claimLeaseExpired("2026-10-10T02:55:00Z", now)).toBe(true);
    expect(claimLeaseExpired(null, now)).toBe(true);
    expect(claimLeaseExpired("not a date", now)).toBe(true);
  });
});

const parts = (o: Partial<RefundParts> = {}): RefundParts => ({ marks: [], cardOpen: false, nonCardOpen: false, cardMarked: 0, nonCard: 0, paidy: 0, ...o });

describe("L1/L2: Mark refund issued on a Paidy-only order", () => {
  it("a Paidy-only order offers and starts on Paidy only", () => {
    expect(refundMethodChoice({ paidByCard: false, approvalPayout: null, exceptionOpen: false, parts: parts({ nonCard: 50000, paidy: 50000 }) }))
      .toEqual({ methods: ["paidy"], initial: "paidy" });
  });
  it("a bank-transfer order still starts on bank transfer", () => {
    expect(refundMethodChoice({ paidByCard: false, approvalPayout: null, exceptionOpen: false, parts: parts({ nonCard: 50000, paidy: 0 }) }).initial)
      .toBe("bank_transfer");
  });
  it("paidy_refund_incomplete names both figures", () => {
    expect(refusalText({ code: "paidy_refund_incomplete", paidyPaid: 50000, paidyRefunded: 20000 }))
      .toBe("Paidy has refunded ¥20,000 of ¥50,000. Refund the rest in the Paidy dashboard, then mark it.");
    expect(refusalText({ code: "paidy_refund_incomplete" })).toMatch(/Refund the rest in the Paidy dashboard/);
  });
});

describe("staff bell email choices (owner 2026-10-10)", () => {
  it("lists the two new Paidy bells and keeps the old ones", () => {
    const types = STAFF_BELL_EMAIL_CHOICES.map((c) => c.type);
    expect(types).toContain("paidy_payment_recorded");
    expect(types).toContain("paidy_window_stuck");
    expect(types).toContain("email_bounced");
    expect(new Set(types).size).toBe(types.length);
  });
});
