import { describe, expect, it } from "vitest";
import {
  FREEZING_SUBMISSION_STATUSES,
  forfeitEmailKind,
  isFreezingSubmissionStatus,
  partitionExpiryCandidates,
  reviveRefusalStatus,
  isFinalForfeit,
  describeShortLines,
  reactivateRefusal,
} from "../../supabase/functions/_shared/web-order-rules.ts";

/**
 * The three web-order gaps fixed on 2026-09-23. The module under test is the
 * SAME file the edge functions run (imported by relative path, as
 * payment-validation.test.ts does), so a rule that drifts here drifts there.
 *
 * Each of these fails silently in production: an order expired over a pending
 * submission looks like any other expiry, a frozen order that starves the
 * sweep looks like a quiet hour, and the wrong forfeit email still arrives —
 * just from the wrong brand, with a debt-sounding "remaining balance".
 */

const o = (id: string) => ({ id });

describe("INVARIANT 12 statuses", () => {
  it("freezes on exactly submitted and under_review", () => {
    expect([...FREEZING_SUBMISSION_STATUSES]).toEqual(["submitted", "under_review"]);
    expect(isFreezingSubmissionStatus("submitted")).toBe(true);
    expect(isFreezingSubmissionStatus("under_review")).toBe(true);
  });

  it("does not freeze on resolved or parked submissions", () => {
    for (const s of ["confirmed", "rejected", "cancelled", "needs_clarification", "", null, undefined]) {
      expect(isFreezingSubmissionStatus(s as string | null | undefined)).toBe(false);
    }
  });
});

describe("partitionExpiryCandidates — gap 1", () => {
  it("never expires an order a pending submission freezes", () => {
    const { expire, frozen } = partitionExpiryCandidates([o("a"), o("b"), o("c")], new Set(["b"]), 100);
    expect(expire.map((x) => x.id)).toEqual(["a", "c"]);
    expect(frozen.map((x) => x.id)).toEqual(["b"]);
  });

  it("keeps the oldest-deadline-first order the caller selected", () => {
    const { expire } = partitionExpiryCandidates([o("3"), o("1"), o("2")], new Set(), 100);
    expect(expire.map((x) => x.id)).toEqual(["3", "1", "2"]);
  });

  it("does not let frozen orders at the head of the queue starve the rest", () => {
    // Two frozen orders have the oldest deadlines. With a plain limit(2) and a
    // skip, this run would expire nothing, and so would every run after it.
    const orders = [o("f1"), o("f2"), o("x"), o("y"), o("z")];
    const { expire, frozen } = partitionExpiryCandidates(orders, new Set(["f1", "f2"]), 2);
    expect(expire.map((x) => x.id)).toEqual(["x", "y"]);
    expect(frozen.map((x) => x.id)).toEqual(["f1", "f2"]);
  });

  it("reports every frozen order even past the cap", () => {
    const orders = [o("a"), o("f1"), o("b"), o("f2"), o("c")];
    const { expire, frozen } = partitionExpiryCandidates(orders, new Set(["f1", "f2"]), 1);
    expect(expire.map((x) => x.id)).toEqual(["a"]);
    expect(frozen.map((x) => x.id)).toEqual(["f1", "f2"]);
  });

  it("handles an empty run", () => {
    expect(partitionExpiryCandidates([], new Set(["a"]), 100)).toEqual({ expire: [], frozen: [] });
  });
});

describe("reviveRefusalStatus — gap 2", () => {
  it("404s an order that is not a web order", () => {
    expect(reviveRefusalStatus("not_web_order")).toBe(404);
  });

  it("409s the conflicts with the world", () => {
    for (const e of ["out_of_stock", "not_expired", "already_paid", "payment_exists"]) {
      expect(reviveRefusalStatus(e)).toBe(409);
    }
  });

  it("400s a bad request", () => {
    expect(reviveRefusalStatus("reason_required")).toBe(400);
    expect(reviveRefusalStatus("anything_else")).toBe(400);
  });
});

describe("forfeitEmailKind — gap 3", () => {
  it("sends a web plan the storefront email", () => {
    expect(forfeitEmailKind("web")).toBe("storefront");
  });

  it("keeps every other plan on the Hub template", () => {
    for (const c of ["hub_manual", "shopify_direct", "social_manual", "pancake", null, undefined, ""]) {
      expect(forfeitEmailKind(c as string | null | undefined)).toBe("hub");
    }
  });
});

describe("isFinalForfeit — the permanent email variant", () => {
  it("is final only for final_forfeited", () => {
    expect(isFinalForfeit("final_forfeited")).toBe(true);
    for (const st of ["forfeited", "extension_active", "active", "", null, undefined]) {
      expect(isFinalForfeit(st as string | null | undefined)).toBe(false);
    }
  });
});

describe("describeShortLines — which piece blocked it", () => {
  it("names sku and title", () => {
    expect(describeShortLines([{ sku: "N4020", title: "Pearl ring" }, { sku: "", title: "K18 chain" }]))
      .toBe("N4020 (Pearl ring), K18 chain");
  });
  it("drops empty lines and survives null", () => {
    expect(describeShortLines([{ sku: null, title: null }])).toBe("");
    expect(describeShortLines(null)).toBe("");
  });
});

describe("reactivateRefusal — all-or-nothing reactivation", () => {
  it("passes a successful RPC through", () => {
    expect(reactivateRefusal({ ok: true } as never)).toBeNull();
    expect(reactivateRefusal(null)).toBeNull();
  });

  it("409s a sold piece and names it", () => {
    const r = reactivateRefusal({ error: "out_of_stock", lines: [{ sku: "N4020", title: "Pearl ring" }] });
    expect(r?.status).toBe(409);
    expect(String(r?.body.error)).toContain("N4020 (Pearl ring)");
    expect(String(r?.body.error)).toContain("Nothing was changed");
    expect(r?.body.error_code).toBe("out_of_stock");
  });

  it("409s the trigger's raise when a piece sells mid-reactivation", () => {
    const r = reactivateRefusal({ message: "web_layaway_stock_unavailable: CJ-W-000123 — took 0 of 1 lines" });
    expect(r?.status).toBe(409);
    expect(r?.body.error_code).toBe("out_of_stock");
  });

  it("answers a lock-time race with the function's existing guard messages", () => {
    expect(reactivateRefusal({ error: "final_forfeited" })?.body.error)
      .toBe("This account is PERMANENTLY FORFEITED. No reactivation, extension, or negotiation is allowed.");
    expect(reactivateRefusal({ error: "not_forfeited", status: "active" })?.body.error)
      .toBe("Account is 'active', not 'forfeited'. Only forfeited accounts can be reactivated.");
    expect(reactivateRefusal({ error: "already_reactivated" })?.body.error)
      .toBe("This account has already been reactivated once. No further reactivation is allowed.");
    expect(reactivateRefusal({ error: "not_found" })?.status).toBe(404);
  });

  it("does not treat an unrelated error message as a stock refusal", () => {
    expect(reactivateRefusal({ message: "connection reset" })).toBeNull();
  });
});
