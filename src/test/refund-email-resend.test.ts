import { describe, expect, it } from "vitest";
import { refundEmailBadge, refundEmailStateLine } from "../components/orders/refund-email-state";

// 2026-10-15 (QA rev. 2, finding C): on a card-paid order the 「返金が完了しました」
// email is skipped on purpose and Square's own 「返金を受け付けました」 goes
// instead. The panel used to show the first as "Never attempted / not
// attempted" (TEST-900080) and did not list the second at all.
const fmt = (iso: string) => `F(${iso})`;

describe("Refund emails panel — truthful on card orders", () => {
  it("a card mark with no attempt is 'skipped by design', not a missed email", () => {
    const e = { last_at: null, last_status: null, not_sent_reason: "card_refund_email_sent_by_square" as const, resendable: true, resends_used: 0 };
    expect(refundEmailBadge(e)).toBe("skipped by design");
    expect(refundEmailStateLine(e, fmt)).toBe("Not sent on card orders — by design: Square's own refund email (below) told the customer");
  });
  it("a Square refund email shows its real send-log state and says who re-sends it", () => {
    const e = { last_at: "2026-10-11T04:39:40Z", last_status: "sent", not_sent_reason: null, resendable: false, resends_used: 0 };
    expect(refundEmailBadge(e)).toBe("sent");
    expect(refundEmailStateLine(e, fmt)).toBe("Last attempt F(2026-10-11T04:39:40Z) PHT · re-sent automatically by the hourly check if needed (up to 3 times)");
  });
  it("an ordinary refund email keeps the manual-resend line", () => {
    const e = { last_at: null, last_status: null, resends_used: 1 };
    expect(refundEmailBadge(e)).toBe("not attempted");
    expect(refundEmailStateLine(e, fmt)).toBe("Never attempted · manual resends 1 of 3");
    expect(refundEmailStateLine({ ...e, last_at: "2026-10-09T01:00:00Z", last_status: "failed" }, fmt)).toBe("Last attempt F(2026-10-09T01:00:00Z) PHT · manual resends 1 of 3");
  });
  it("a card mark that DID send (mixed order, non-card part) is not called skipped", () => {
    const e = { last_at: "2026-10-09T01:00:00Z", last_status: "sent", not_sent_reason: "card_refund_email_sent_by_square" as const, resends_used: 0 };
    expect(refundEmailBadge(e)).toBe("sent");
    expect(refundEmailStateLine(e, fmt)).toContain("manual resends 0 of 3");
  });
});
