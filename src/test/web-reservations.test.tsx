import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as edge from "../../supabase/functions/_shared/web-reservation-rules.ts";
import * as hub from "@/lib/web-reservations";

/**
 * Reserve-first A2 (2026-09-24). The rules the edge functions run
 * (_shared/web-reservation-rules.ts, imported by relative path as
 * web-order-gaps.test.ts does) and their Hub twin (src/lib/web-reservations.ts),
 * plus the DeadlinesCard state a reservation shows.
 *
 * Every one of these fails silently if wrong: a Hub plan read as "awaiting"
 * blocks a real customer's portal payment; a switch read fail-OPEN starts
 * taking reservations nobody asked for.
 *
 * Website orders PR 10 (2026-10-01) retired the reserve-first checkout and its
 * Confirm / Can't supply UI (ReservationActions, ReservationsAwaitingCard); the
 * tests of those components and of the removed helpers left with them.
 */

// ------------------------------------------------------------------ mocks
vi.mock("@/hooks/use-supabase-data", () => ({
  useSetAccountDeadlines: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useReactivateWebLayaway: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/contexts/PermissionsContext", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import DeadlinesCard from "@/components/accounts/DeadlinesCard";

// ------------------------------------------------------------------ rules
const web = (over: Record<string, unknown> = {}) => ({ source_channel: "web", ready_confirmed_at: null, status: "pending", payment_status: "awaiting_confirmation", ...over });

describe("what counts as a reservation", () => {
  it("is a WEB row with ready_confirmed_at null", () => {
    expect(edge.isUnconfirmedReservation(web())).toBe(true);
    expect(edge.isUnconfirmedReservation(web({ ready_confirmed_at: "2026-09-24T01:00:00Z" }))).toBe(false);
  });

  it("never treats a Hub row as one, though Hub rows carry NULL too", () => {
    // A1 stamps only web rows. Without the channel check every Hub plan would
    // read as a reservation and the portal would refuse its payments.
    for (const ch of ["hub_manual", "shopify", null, undefined, "page365"]) {
      expect(edge.isUnconfirmedReservation({ source_channel: ch as string | null, ready_confirmed_at: null })).toBe(false);
      expect(edge.isAwaitingConfirmation({ source_channel: ch as string | null, ready_confirmed_at: null, status: "active" }, "layaway")).toBe(false);
    }
  });

  it("is awaiting only while still live — pending cash, active layaway", () => {
    expect(edge.isAwaitingConfirmation(web(), "cash_order")).toBe(true);
    expect(edge.isAwaitingConfirmation(web({ status: "cancelled" }), "cash_order")).toBe(false);
    expect(edge.isAwaitingConfirmation(web({ status: "active" }), "layaway")).toBe(true);
    expect(edge.isAwaitingConfirmation(web({ status: "overdue" }), "layaway")).toBe(false);
  });

  it("is never ready for payment before confirmation", () => {
    expect(edge.isReadyForPayment(web(), "cash_order")).toBe(false);
    expect(edge.isReadyForPayment(web({ status: "active" }), "layaway")).toBe(false);
    const confirmed = { ready_confirmed_at: "2026-09-24T01:00:00Z" };
    expect(edge.isReadyForPayment(web({ ...confirmed, payment_status: "pending_transfer" }), "cash_order")).toBe(true);
    expect(edge.isReadyForPayment(web({ ...confirmed, payment_status: "paid", status: "completed" }), "cash_order")).toBe(false);
    expect(edge.isReadyForPayment(web({ ...confirmed, status: "overdue" }), "layaway")).toBe(true);
    // A Hub plan is payable as it always was.
    expect(edge.isReadyForPayment({ source_channel: "hub_manual", ready_confirmed_at: null, status: "active" }, "layaway")).toBe(true);
  });

  it("gives the storefront both flags from one row", () => {
    expect(edge.reservationFlags(web(), "cash_order")).toEqual({ awaiting_confirmation: true, ready_for_payment: false });
  });
});

describe("timing", () => {
  const created = "2026-09-24T00:00:00.000Z";
  it("auto-cancels 72 hours after checkout", () => {
    expect(edge.reservationAutoCancelAt(created)).toBe("2026-09-27T00:00:00.000Z");
    expect(edge.reservationAutoCancelAt("not a date")).toBeNull();
  });

  it("owes sales@ one reminder at 24 hours, never two", () => {
    const at = (h: number) => new Date(Date.parse(created) + h * 3_600_000);
    expect(edge.isDueForReminder({ created_at: created }, at(23))).toBe(false);
    expect(edge.isDueForReminder({ created_at: created }, at(24))).toBe(true);
    expect(edge.isDueForReminder({ created_at: created, reservation_reminded_at: "2026-09-25T00:10:00Z" }, at(30))).toBe(false);
  });

  it("formats the age staff see", () => {
    const now = new Date(Date.parse(created) + 29 * 3_600_000);
    expect(hub.formatReservationAge(created, now)).toBe("1d 5h");
    expect(hub.formatReservationAge(created, new Date(Date.parse(created) + 5 * 3_600_000))).toBe("5h");
  });
});

describe("refusals", () => {

  it("says the payment refusal in one code everywhere", () => {
    expect(edge.NOT_READY_FOR_PAYMENT).toBe("not_ready_for_payment");
  });
});

describe("the Hub twin agrees with the edge rules", () => {
  const rows = [
    web(), web({ status: "active" }), web({ status: "cancelled" }), web({ ready_confirmed_at: "2026-09-24T01:00:00Z" }),
    { source_channel: "hub_manual", ready_confirmed_at: null, status: "active" }, { source_channel: null }, null,
  ];
  it("on every predicate", () => {
    for (const r of rows) {
      expect(hub.isUnconfirmedReservation(r as never)).toBe(edge.isUnconfirmedReservation(r as never));
      for (const k of ["cash_order", "layaway"] as const) {
        expect(hub.isAwaitingConfirmation(r as never, k)).toBe(edge.isAwaitingConfirmation(r as never, k));
      }
    }
  });
  it("on the clock and the constants", () => {
    for (const c of ["2026-09-24T00:00:00.000Z", "", null, "garbage"]) {
      expect(hub.reservationAutoCancelAt(c as string | null)).toBe(edge.reservationAutoCancelAt(c as string | null));
    }
    expect(hub.RESERVATION_AUTO_CANCEL_HOURS).toBe(edge.RESERVATION_AUTO_CANCEL_HOURS);
    expect(hub.RESERVATION_REMIND_HOURS).toBe(edge.RESERVATION_REMIND_HOURS);
    expect(hub.RESERVATION_LIVE_STATUS).toEqual(edge.RESERVATION_LIVE_STATUS);
    for (const k of ["cash_order", "layaway"] as const) expect(hub.reservationKindLabel(k)).toBe(edge.reservationKindLabel(k));
  });
});

describe("staff payment guard (every staff payment path refuses an unconfirmed reservation)", () => {
  it("finds the first unconfirmed web row and never a Hub row", () => {
    const hubPlan = { id: "h", source_channel: "hub_manual", ready_confirmed_at: null, invoice_number: "19001" };
    const confirmed = web({ id: "c", ready_confirmed_at: "2026-09-24T01:00:00Z" });
    const reservation = web({ id: "r", invoice_number: "900050", web_reference: "CJ-W-000050" });
    expect(edge.firstUnconfirmedReservation([hubPlan, confirmed])).toBeNull();
    expect(edge.firstUnconfirmedReservation([hubPlan, reservation, confirmed])).toBe(reservation);
    expect(edge.firstUnconfirmedReservation(null)).toBeNull();
    expect(edge.firstUnconfirmedReservation([null, undefined])).toBeNull();
  });

  it("answers not_ready_for_payment naming the customer's reference", () => {
    const body = edge.staffNotReadyForPaymentBody({ invoice_number: "900050", web_reference: "CJ-W-000050" });
    expect(body.error).toBe("not_ready_for_payment");
    expect(body.reference).toBe("CJ-W-000050");
    expect(body.message).toMatch(/^CJ-W-000050 is still a reservation\. Confirm the piece/);
    expect(edge.staffNotReadyForPaymentBody(null).message).toMatch(/^This web order is still a reservation/);
  });

  // The functions run under Deno and cannot be imported here, so the wiring is
  // asserted on their CODE (comment lines stripped — a comment mentioning the
  // guard must not satisfy this).
  const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  it.each([
    ["supabase/functions/record-payment/index.ts", /firstUnconfirmedReservation\(\[account\]\)/],
    ["supabase/functions/record-multi-payment/index.ts", /firstUnconfirmedReservation\(accounts\)/],
    ["supabase/functions/review-payment-submission/index.ts", /firstUnconfirmedReservation\(orders\)/],
  ])("%s refuses with a 409 before any write", (file, call) => {
    const src = code(file);
    expect(src).toMatch(call);
    expect(src).toMatch(/staffNotReadyForPaymentBody\([a-z]+\)\), \{\s*status: 409/);
  });

  it("review-payment-submission checks before it flips the submission to confirmed", () => {
    const src = code("supabase/functions/review-payment-submission/index.ts");
    expect(src.indexOf("firstUnconfirmedReservation(orders)")).toBeGreaterThan(-1);
    expect(src.indexOf("firstUnconfirmedReservation(orders)")).toBeLessThan(src.indexOf('.update({ status: "confirmed"'));
  });

  it("the customer and cash paths still carry their own guard", () => {
    expect(code("supabase/functions/submit-payment/index.ts")).toMatch(/isUnconfirmedReservation\(acct\)/);
    expect(code("supabase/functions/submit-cash-payment/index.ts")).toMatch(/isUnconfirmedReservation\(cashOrder\)/);
  });
});

// ------------------------------------------------------------ components
describe("DeadlinesCard on a reservation", () => {
  it("says there is no deadline yet and offers no Change", () => {
    render(
      <DeadlinesCard
        entityType="cash_order" entityId="o1" status="pending" transferDueAt={null}
        sourceChannel="web" awaitingConfirmation canEdit
      />,
    );
    expect(screen.getByText(/Awaiting confirmation — no payment deadline yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change/i })).toBeNull();
  });

  it("is unchanged for a confirmed order", () => {
    render(
      <DeadlinesCard
        entityType="cash_order" entityId="o1" status="pending" transferDueAt="2026-09-27T05:00:00.000Z"
        sourceChannel="web" canEdit
      />,
    );
    expect(screen.queryByText(/Awaiting confirmation/)).toBeNull();
    expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument();
  });
});
