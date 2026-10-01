import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  AWAITING_PAYMENT_BADGE, draftClosedLabel, draftKindLabel, formatCountdown, isAwaitingPayment, isClosedUnpaid,
  isParkedWebOrder, showInSalesLists,
} from "@/lib/web-park";

/**
 * Website orders PR 5 — the park area (docs/WEB-ORDER-DRAFTS.md "PR 5").
 * A web order stays out of the Cash / Layaway lists until its first real
 * payment (web_released_at); a never-paid one is never a sale (W2-2).
 */

// ------------------------------------------------------------------ rules
const web = (over: Record<string, unknown> = {}) => ({
  source_channel: "web", web_released_at: null, ready_confirmed_at: "2026-09-29T01:00:00Z", status: "pending", ...over,
});

describe("what is parked", () => {
  it("a web order with no payment is parked and hidden from the Cash / Layaway lists", () => {
    expect(isParkedWebOrder(web())).toBe(true);
    expect(showInSalesLists(web())).toBe(false);
  });

  it("the first payment releases it into the lists — for good", () => {
    expect(showInSalesLists(web({ web_released_at: "2026-09-30T00:00:00Z" }))).toBe(true);
    // Sticky: a released order that was later cancelled still shows (money was received).
    expect(showInSalesLists(web({ web_released_at: "2026-09-30T00:00:00Z", status: "cancelled" }))).toBe(true);
  });

  it("never touches a Hub order, though Hub rows carry NULL too", () => {
    for (const ch of ["hub_manual", "page365", "shopify", null, undefined]) {
      expect(showInSalesLists({ source_channel: ch as string | null, web_released_at: null, status: "pending" })).toBe(true);
    }
  });

  it("a completed order is never hidden", () => {
    expect(showInSalesLists(web({ status: "completed" }))).toBe(true);
  });

  it("awaiting payment = confirmed, unpaid, still live", () => {
    expect(isAwaitingPayment(web(), "cash_order")).toBe(true);
    expect(isAwaitingPayment(web({ status: "active" }), "layaway")).toBe(true);
    expect(isAwaitingPayment(web({ status: "overdue" }), "layaway")).toBe(true);
    // A row still unconfirmed (ready_confirmed_at NULL, the retired reserve-first
    // shape) is never "awaiting payment" — nothing is owed before confirmation.
    expect(isAwaitingPayment(web({ ready_confirmed_at: null }), "cash_order")).toBe(false);
    expect(isAwaitingPayment(web({ status: "expired" }), "cash_order")).toBe(false);
    expect(isAwaitingPayment(web({ status: "forfeited" }), "layaway")).toBe(false);
  });

  it("closed unpaid = cancelled / expired / forfeited with no payment", () => {
    expect(isClosedUnpaid(web({ status: "expired" }), "cash_order")).toBe(true);
    expect(isClosedUnpaid(web({ status: "cancelled" }), "layaway")).toBe(true);
    expect(isClosedUnpaid(web({ status: "cancelled", web_released_at: "2026-09-30T00:00:00Z" }), "cash_order")).toBe(false);
    expect(isClosedUnpaid(web({ status: "pending" }), "cash_order")).toBe(false);
  });

  it("labels say how the customer will pay, never that she has", () => {
    expect(draftKindLabel({ mode: "full", term_months: null })).toBe("Full payment");
    expect(draftKindLabel({ mode: "layaway", term_months: 6 })).toBe("Layaway · 6 months");
    expect(draftClosedLabel("declined", "Sold at the shop")).toBe("Can't supply: Sold at the shop");
    expect(draftClosedLabel("expired")).toMatch(/72 hours/);
  });

  it("counts down to the deadline and says when it has passed", () => {
    const now = new Date("2026-09-29T00:00:00Z");
    expect(formatCountdown("2026-09-29T05:00:00Z", now)).toBe("in 5h");
    expect(formatCountdown("2026-09-30T03:00:00Z", now)).toBe("in 1d 3h");
    expect(formatCountdown("2026-09-28T22:00:00Z", now)).toBe("passed 2h ago");
    expect(formatCountdown(null, now)).toBe("no deadline");
  });
});

// ------------------------------------------------------------------ screen
type Rec = Record<string, unknown>;
let openDrafts: Rec[] = [];
let closedDrafts: Rec[] = [];
let awaiting: Rec[] = [];
let closedOrders: Rec[] = [];
const decline = vi.fn();

vi.mock("@/hooks/use-web-park", () => ({
  useWebDrafts: (scope: string) => ({ data: scope === "open" ? openDrafts : closedDrafts, isLoading: false, isError: false }),
  useWebAwaitingPayment: () => ({ data: awaiting, isLoading: false, isError: false }),
  useWebClosedUnpaid: () => ({ data: closedOrders, isLoading: false, isError: false }),
  useInvalidateWebPark: () => vi.fn(),
  declineWebDraft: (...a: unknown[]) => decline(...a),
}));
vi.mock("@/contexts/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import WebOrdersPark from "@/components/web-orders/WebOrdersPark";

const draft = (over: Rec = {}): Rec => ({
  id: "d1", web_reference: "CJ-W-900070", customer_id: "c1", customer_name: "Ana Web", customer_is_test: false,
  mode: "full", term_months: null, currency: "JPY", total: 20000, shipping_pending: false, country: "JP",
  status: "to_confirm", decline_reason: null, decided_at: null, cash_order_id: null, layaway_account_id: null,
  created_at: new Date().toISOString(), open_service_requests: 0, ...over,
});
const order = (over: Rec = {}): Rec => ({
  kind: "cash_order", id: "o1", reference: "CJ-W-900071", customer_id: "c2", customer_name: "Ben Web", customer_is_test: false,
  currency: "JPY", total_amount: 50800, amount_due: 50800, plan_months: null, status: "pending",
  transfer_due_at: new Date(Date.now() + 3 * 3_600_000).toISOString(), created_at: "2026-09-29T00:00:00Z",
  reminder_sent: false, pending_submission: false, ...over,
});

function mount(search?: string) {
  return render(<MemoryRouter><WebOrdersPark search={search} /></MemoryRouter>);
}

beforeEach(() => {
  openDrafts = []; closedDrafts = []; awaiting = []; closedOrders = [];
  decline.mockReset();
  decline.mockResolvedValue(undefined);
});

describe("Sales → Website orders", () => {
  it("To confirm lists drafts with their badges and a Review link", () => {
    openDrafts = [draft({ shipping_pending: true, open_service_requests: 1, mode: "layaway", term_months: 6, customer_is_test: true })];
    mount();
    expect(screen.getByText("To confirm · 1")).toBeInTheDocument();
    const row = screen.getByTestId("park-draft");
    expect(within(row).getByText("Shipping to add")).toBeInTheDocument();
    expect(within(row).getByText("Service requested")).toBeInTheDocument();
    expect(within(row).getByText("Layaway · 6 months")).toBeInTheDocument();
    expect(within(row).getByText("🧪 TEST")).toBeInTheDocument();
    expect(within(row).getByText(/before shipping/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Review" })).toHaveAttribute("href", "/orders/review/website/d1");
  });

  it("To confirm lists drafts only — the old reserve-first flow is retired (PR 10)", () => {
    openDrafts = [draft()];
    mount();
    expect(screen.getByText("To confirm · 1")).toBeInTheDocument();
    expect(screen.queryByText("Old flow")).toBeNull();
    expect(screen.queryByTestId("park-old-flow")).toBeNull();
  });

  it("Can't supply needs a reason, then declines the draft", async () => {
    openDrafts = [draft()];
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Can't supply" }));
    const submit = screen.getByRole("button", { name: "Decline and put the piece back on sale" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: " Sold at the shop " } });
    fireEvent.click(submit);
    await waitFor(() => expect(decline).toHaveBeenCalledWith("d1", " Sold at the shop "));
  });

  it("the toolbar search filters by CJ-W reference or customer name", () => {
    openDrafts = [draft(), draft({ id: "d2", web_reference: "CJ-W-900099", customer_name: "Carla" })];
    mount("carla");
    expect(screen.getAllByTestId("park-draft")).toHaveLength(1);
    expect(screen.getByText("CJ-W-900099")).toBeInTheDocument();
  });

  it("Awaiting payment shows the badge, what is due, the deadline, the reminder and a pending submission", async () => {
    awaiting = [order({ reminder_sent: true, pending_submission: true }), order({ kind: "layaway", id: "a1", reference: "CJ-W-900072", amount_due: 120000, plan_months: 6 })];
    mount();
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Awaiting payment · 2/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Awaiting payment · 2/ }));
    const rows = await screen.findAllByTestId("park-awaiting");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(AWAITING_PAYMENT_BADGE)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Reminder sent/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Payment submitted/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Deposit due/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/No reminder yet/)).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/accounts/a1");
  });

  it("Closed lists declined drafts and orders that were never paid", async () => {
    closedDrafts = [draft({ status: "declined", decline_reason: "Sold at the shop", decided_at: "2026-09-29T02:00:00Z" })];
    closedOrders = [order({ status: "expired" })];
    mount();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Closed" }));
    fireEvent.click(screen.getByRole("tab", { name: "Closed" }));
    const rows = await screen.findAllByTestId("park-closed");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/Can't supply: Sold at the shop/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Not paid by the deadline — expired/)).toBeInTheDocument();
  });

  it("says so when nothing is waiting", () => {
    mount();
    expect(screen.getByText("Nothing to confirm.")).toBeInTheDocument();
  });
});
