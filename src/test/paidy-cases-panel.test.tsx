import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * M2 / L4 (Paidy QC PR-B, 2026-10-10): an orphan capture case is recorded
 * only by an ADMIN through paidy-staff-action record_orphan_capture, never
 * through Resolve → Record; a failed list read is shown, not hidden.
 */

let roles: string[] = ["admin"];
let casesResult: { data: unknown; error: unknown } = { data: [], error: null };
const invoke = vi.fn();

function chain(result: { data: unknown; error: unknown; count?: number }) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "is", "not"]) c[m] = () => c;
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
  return c;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => (table === "paidy_cases" ? chain(casesResult) : chain({ data: [], error: null, count: 0 })),
    rpc: vi.fn(),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
  },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ roles }) }));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) } }));

import PaidyCasesPanel from "@/components/payments/PaidyCasesPanel";

const orphanCase = {
  id: "case-1", kind: "captured_no_submission", paidy_payment_id: "pay_abc", cash_order_id: "order-1",
  paidy_payment_row: null, detail: { captured_jpy: 48000 }, opened_at: "2026-10-10T00:00:00Z",
  last_seen_at: "2026-10-10T00:00:00Z", attempts: 1, cash_order: { invoice_number: "20001", web_reference: "CJ-W-000123" },
};
const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><PaidyCasesPanel canResolve={true} /></QueryClientProvider>);
};

beforeEach(() => {
  roles = ["admin"];
  casesResult = { data: [orphanCase], error: null };
  invoke.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

describe("orphan capture case", () => {
  it("an admin sees Record this Paidy payment (not Resolve) and it calls record_orphan_capture with the reason", async () => {
    invoke.mockResolvedValue({ data: { ok: true, outcome: "recorded", submission_id: "sub-1" }, error: null });
    mount();
    const btn = await screen.findByTestId("paidy-orphan-record");
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
    fireEvent.click(btn);
    const submit = await screen.findByTestId("paidy-orphan-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId("paidy-orphan-reason"), { target: { value: "short" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId("paidy-orphan-reason"), { target: { value: "Customer paid; Paidy shows capture." } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("paidy-staff-action", {
      body: { action: "record_orphan_capture", case_id: "case-1", reason: "Customer paid; Paidy shows capture." },
    }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/order is completed/)));
  });

  it("a refusal shows the server's message, else plain words for the code", async () => {
    invoke.mockResolvedValue({ data: { ok: false, error: "amount_differs_from_balance" }, error: null });
    mount();
    fireEvent.click(await screen.findByTestId("paidy-orphan-record"));
    fireEvent.change(await screen.findByTestId("paidy-orphan-reason"), { target: { value: "Recording the captured payment" } });
    fireEvent.click(screen.getByTestId("paidy-orphan-submit"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("The Paidy payment was not recorded",
      { description: expect.stringMatching(/balance/) }));
  });

  it("a non-admin sees the plain explanation and no record button", async () => {
    roles = ["finance"];
    mount();
    const line = await screen.findByTestId("paidy-orphan-explain");
    expect(line.textContent).toMatch(/Paidy took ¥48,000 and the Hub has no record of this payment yet/);
    expect(screen.queryByTestId("paidy-orphan-record")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("a case WITH a payment row keeps the ordinary Resolve", async () => {
    casesResult = { data: [{ ...orphanCase, paidy_payment_row: "row-1" }], error: null };
    mount();
    expect(await screen.findByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(screen.queryByTestId("paidy-orphan-record")).toBeNull();
  });
});

describe("L4: a failed list read is shown", () => {
  it("renders an error line instead of hiding the panel", async () => {
    casesResult = { data: null, error: { message: "permission denied for table paidy_cases" } };
    mount();
    expect(await screen.findByTestId("paidy-cases-error")).toHaveTextContent(/Could not load the open Paidy cases/);
  });
});
