import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * Website orders PR 4 — the review screen (/orders/review/website/:id).
 * The screen shows only the server's figures, locks what W2-3 locks,
 * preselects Pabitbit for the Philippines only (W2-10), and Confirm sends the
 * staff's inputs — never totals.
 */

type Rec = Record<string, unknown>;
let draft: Rec;
let preview: Rec;
const invoke = vi.fn();

const tables: Record<string, () => Rec | Rec[]> = {
  web_order_drafts: () => draft,
  web_order_draft_lines: () => [{ id: "l1", title: "Pendant K18", sku: "AL3", qty: 1, unit_price_jpy: 20000, line_total_jpy: 20000, hold_state: "held" }],
  customers: () => ({ id: "c1", full_name: "Ana Web", email: "ana@example.com" }),
  shipping_methods: () => [
    { id: "m-pab", provider_name: "Pabitbit", title: "Pabitbit Service", is_active: true },
    { id: "m-yam", provider_name: "Yamato", title: "Yamato Transport", is_active: true },
  ],
};
function chain(table: string) {
  const result = () => tables[table]();
  const q: Rec = {};
  q.select = () => q; q.eq = () => q; q.order = () => ({ then: (r: (v: Rec) => void) => r({ data: result(), error: null }) });
  q.maybeSingle = async () => ({ data: result(), error: null });
  return q;
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (t: string) => chain(t), functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));
vi.mock("@/components/layout/AppLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const toastOk = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastOk(...a), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { useLocation } from "react-router-dom";
function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="services-landing">{loc.pathname + loc.search}</p>;
}

import WebOrderReview from "@/pages/WebOrderReview";

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/orders/review/website/d1"]}>
        <Routes>
          <Route path="/orders/review/website/:id" element={<WebOrderReview />} />
          <Route path="/cash-orders/:id" element={<p>cash order page</p>} />
          <Route path="/services" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  draft = {
    id: "d1", customer_id: "c1", mode: "full", term_months: null, settlement_currency: "JPY",
    subtotal: 20000, shipping: 800, total: 20800, ship_to_snapshot: { recipient_name: "Ana", line1: "1-2-3 Tateishi", city: "Tokyo", country: "JP" },
    country: "JP", order_type: "SELF", invoice_seq: 900060, web_reference: "CJ-W-900060", status: "to_confirm",
    decline_reason: null, cash_order_id: null, layaway_account_id: null, created_at: "2026-09-29T00:00:00Z",
  };
  preview = { errors: [], currency: "JPY", products: 20000, shipping: 800, services: 0, discount: 0, total: 20800,
    loyalty_jpy_amount: 20000, loyalty_default_jpy: 20000, loyalty_tier: null, deadline_hours: 24,
    transfer_due_at: "2026-09-30T00:00:00Z", layaway: null };
  invoke.mockReset();
  toastOk.mockReset();
  invoke.mockImplementation(async (_name: string, { body }: { body: Rec }) => {
    if (body.action === "preview") return { data: preview, error: null };
    if (body.action === "confirm") return { data: { ok: true, entity_type: "cash_order", entity_id: "o1", email: { sent: true } }, error: null };
    return { data: { ok: true }, error: null };
  });
});

describe("review screen", () => {
  it("shows the order, the locked piece and the Hub's totals", async () => {
    mount();
    expect(await screen.findByText(/Review website order CJ-W-900060/)).toBeInTheDocument();
    expect(screen.getByTestId("web-review-line")).toHaveTextContent("Pendant K18");
    await waitFor(() => expect(screen.getByTestId("web-review-total")).toHaveTextContent("20,800"));
    expect(screen.getByText("Paid in full (cash order)")).toBeInTheDocument();
  });

  it("Japan: no courier preselected — Confirm waits for one", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("web-review-total")).toHaveTextContent("20,800"));
    expect(screen.getByText("Choose the courier before confirming.")).toBeInTheDocument();
    expect(screen.getByTestId("web-review-confirm")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Courier"), { target: { value: "m-yam" } });
    await waitFor(() => expect(screen.getByTestId("web-review-confirm")).toBeEnabled());
  });

  it("Philippines: Pabitbit is preselected", async () => {
    draft = { ...draft, country: "PH" };
    mount();
    await waitFor(() => expect((screen.getByLabelText("Courier") as HTMLSelectElement).value).toBe("m-pab"));
  });

  it("server problems are shown in plain words and block Confirm", async () => {
    preview = { ...preview, errors: ["shipping_required"], shipping: null };
    draft = { ...draft, country: "PH" };
    mount();
    const list = await screen.findByTestId("web-review-problems");
    expect(within(list).getByText(/Enter the shipping fee/)).toBeInTheDocument();
    expect(screen.getByTestId("web-review-confirm")).toBeDisabled();
  });

  it("Confirm sends the inputs (never a total) and opens the new order", async () => {
    draft = { ...draft, country: "PH" };
    mount();
    await waitFor(() => expect(screen.getByTestId("web-review-confirm")).toBeEnabled());
    fireEvent.click(screen.getByTestId("web-review-confirm"));
    expect(await screen.findByText("cash order page")).toBeInTheDocument();
    const confirmCall = invoke.mock.calls.find((c) => (c[1] as { body: Rec }).body.action === "confirm")!;
    const body = (confirmCall[1] as { body: Rec }).body;
    expect(confirmCall[0]).toBe("confirm-web-draft");
    expect(body).toMatchObject({ draft_id: "d1", shipping: 800, discount: 0, planned_shipping_method_id: "m-pab" });
    expect(body).not.toHaveProperty("total");
    expect(body).not.toHaveProperty("total_amount");
  });

  it("W2-6: a draft that carried a service request lands on Services with the job ready and the agreed fee", async () => {
    draft = { ...draft, country: "PH" };
    invoke.mockImplementation(async (_name: string, { body }: { body: Rec }) => {
      if (body.action === "preview") return { data: preview, error: null };
      return {
        data: { ok: true, entity_type: "cash_order", entity_id: "o1", email: { sent: true },
          figures: { ...preview, services: 3000 }, service_requests: [{ id: "sr1", kind: "resize" }] },
        error: null,
      };
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("web-review-confirm")).toBeEnabled());
    fireEvent.click(screen.getByTestId("web-review-confirm"));
    const landing = await screen.findByTestId("services-landing");
    const url = new URL(`http://x${landing.textContent}`);
    expect(url.pathname).toBe("/services");
    expect(url.searchParams.get("tab")).toBe("requests");
    expect(url.searchParams.get("open")).toBe("sr1");
    expect(url.searchParams.get("convert")).toBe("1");
    expect(url.searchParams.get("fee")).toBe("3000");
    expect(url.searchParams.get("return")).toBe("/cash-orders/o1");
  });

  it("a closed draft shows why and offers no Confirm", async () => {
    draft = { ...draft, status: "declined", decline_reason: "Sold at the shop" };
    mount();
    expect(await screen.findByTestId("web-review-closed")).toHaveTextContent("Declined: Sold at the shop");
    expect(screen.queryByTestId("web-review-confirm")).toBeNull();
  });

  it("Can't supply needs a reason and sends decline", async () => {
    draft = { ...draft, country: "PH" };
    mount();
    fireEvent.click(await screen.findByText("Can't supply"));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Sold at the shop" } });
    fireEvent.click(screen.getByText("Decline and put the piece back on sale"));
    await waitFor(() => expect(invoke.mock.calls.some((c) => (c[1] as { body: Rec }).body.action === "decline")).toBe(true));
    const call = invoke.mock.calls.find((c) => (c[1] as { body: Rec }).body.action === "decline")!;
    expect((call[1] as { body: Rec }).body).toMatchObject({ draft_id: "d1", reason: "Sold at the shop" });
  });
});

describe("payment choice + points (owner C1–C5, 2026-10-05)", () => {
  it("shows the method the customer chose, the points held, and the Hub's amount to pay", async () => {
    draft = { ...draft, payment_method: "paidy", points: 3000, points_value: 3000 };
    preview = { ...preview, payment_method: "paidy", points: 3000, points_value: 3000, due_now: 17800 };
    mount();
    expect(await screen.findByTestId("web-review-method")).toHaveTextContent("Paidy");
    expect(screen.getByTestId("web-review-points")).toHaveTextContent("3,000 pts");
    await waitFor(() => expect(screen.getByTestId("web-review-due")).toHaveTextContent("17,800"));
  });
  it("Change payment method sends the staff's choice and reason to change-payment-method", async () => {
    draft = { ...draft, payment_method: "paidy", points: 0, points_value: 0 };
    mount();
    fireEvent.click(await screen.findByTestId("web-review-change-method"));
    const dialog = await screen.findByTestId("change-payment-method-dialog");
    fireEvent.click(within(dialog).getByLabelText("Bank transfer"));
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Paidy declined" } });
    fireEvent.click(within(dialog).getByTestId("change-payment-method-save"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("change-payment-method", {
      body: { entity_type: "draft", entity_id: "d1", method: "transfer", reason: "Paidy declined" },
    }));
  });
});
