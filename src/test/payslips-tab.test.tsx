import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimesheetProfile } from "@/lib/timesheetEngine";

/**
 * Timesheet → Payslips tab rendered against a mocked database (the SQL harness in
 * supabase/tests/payslips is the authority on refusals; this pins the screen).
 */

const rpc = vi.fn();
function query(rows: unknown[]) {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "gte", "lt", "lte", "order"]) q[k] = () => q;
  q.range = async () => ({ data: rows, error: null });
  q.then = (res: (v: unknown) => unknown) => res({ data: rows, error: null });
  return q;
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (t: string) => query(t === "commission_agents" ? [{ name: "Kaila", user_id: "u-kaila" }] : []),
    storage: { from: () => ({}) },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PayslipsTab from "@/components/timesheet/PayslipsTab";

const prof = (user_id: string, template_type: "csr" | "live_admin"): TimesheetProfile => ({
  id: user_id, user_id, template_type, job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: template_type === "csr" ? 12000 : null,
  allowance: template_type === "csr" ? 2000 : null, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
});

let book: Record<string, unknown> | "missing";
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => vi.unstubAllGlobals());

/** Make Jose's payslip finalized (unpaid) so Record payment shows. */
function joseFinalized() {
  const b = book as Record<string, unknown>;
  const [p] = b.payslips as Record<string, unknown>[];
  b.payslips = [{ ...p, status: "finalized", jpy_sent: null, php_received: null, php_per_jpy: null, paid_on: null,
    proof_path: null, paid_at: null }];
}

async function openPayment() {
  const table = await screen.findByTestId("payslips-table");
  const jose = within(table).getByText("Jose Reyes").closest("tr") as HTMLElement;
  fireEvent.click(within(jose).getByRole("button", { name: /View/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Record payment/ }));
  return screen.findByLabelText("Yen sent (¥)") as Promise<HTMLInputElement>;
}

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PayslipsTab
        profiles={[prof("u-kaila", "csr"), prof("u-jose", "live_admin")]}
        entriesByUser={new Map()}
        nameByUser={new Map([["u-kaila", "Kaila Cruz"], ["u-jose", "Jose Reyes"]])}
        monthKey="2026-09"
        onMonthChange={() => {}}
        monthOptions={["2026-10", "2026-09"]}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  rpc.mockReset();
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes("open.er-api.com")
      ? { rates: { PHP: 0.4 }, time_last_update_utc: "Mon, 26 Oct 2026 00:02:31 +0000" }
      : { date: "2026-10-26", rates: { PHP: 0.41 } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  book = {
    ok: true, month: "2026-09-01", can_manage: true, php_jpy_rate: "0.42",
    payslips: [{
      id: "s1", user_id: "u-jose", pay_month: "2026-09-01", status: "paid", staff_name: "Jose Reyes", address: "Cebu",
      date_of_birth: "1998-11-02", job_title: "Live Admin", template_type: "live_admin",
      timesheet: { days_at_500: 10, days_at_300: 4, total_hours: 61, net: 6200 },
      commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
      timesheet_net_php: "6200.00", commission_php: "0.00", total_php: "6200.00", jpy_sent: 14762, php_received: "6150.00",
      php_per_jpy: "0.416610", paid_on: "2026-10-05", proof_path: "s1/proof.jpg", finalized_at: "2026-10-01T00:00:00Z",
      paid_at: "2026-10-05T00:00:00Z", voided_at: null, void_reason: null, created_at: "2026-10-01T00:00:00Z",
    }],
    details: [{ user_id: "u-kaila", address: null, date_of_birth: null }, { user_id: "u-jose", address: "Cebu", date_of_birth: "1998-11-02" }],
  };
  rpc.mockImplementation(async (name: string) => {
    if (name === "save_staff_payroll_details") return { data: { ok: true, changed: ["address"] }, error: null };
    if (name === "get_payslip_book") {
      if (book === "missing") return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
      return { data: book, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});

describe("Payslips tab", () => {
  it("waits for the database update before the migration exists", async () => {
    book = "missing";
    mount();
    expect(await screen.findByTestId("payslips-waiting")).toHaveTextContent("Waiting for the database update");
  });

  it("lists every active staff member with status, stored figures for an issued payslip", async () => {
    mount();
    const table = await screen.findByTestId("payslips-table");
    const kaila = within(table).getByText("Kaila Cruz").closest("tr") as HTMLElement;
    const jose = within(table).getByText("Jose Reyes").closest("tr") as HTMLElement;
    expect(within(kaila).getByText("Not issued")).toBeInTheDocument();
    expect(within(jose).getByText("Paid")).toBeInTheDocument();
    expect(within(jose).getAllByText("₱6,200").length).toBeGreaterThan(0);
  });

  it("Finalize is blocked until address and date of birth exist", async () => {
    mount();
    const table = await screen.findByTestId("payslips-table");
    const kaila = within(table).getByText("Kaila Cruz").closest("tr") as HTMLElement;
    fireEvent.click(within(kaila).getByRole("button", { name: /View/ }));
    const view = await screen.findByTestId("payslip-view");
    expect(view.textContent).toContain("Ｃｈａ\u3000Ｊｅｗｅｌｓ株式会社"); // exact full-width string
    expect(within(view).getByText("Payslip — September 2026")).toBeInTheDocument();
    await waitFor(() => expect(within(view).getByTestId("payslip-finalize-block")).toHaveTextContent("Add address and date of birth first"));
    expect(within(view).getByTestId("payslip-finalize")).toBeDisabled();
    expect(within(view).getByText("No commission this month")).toBeInTheDocument();
  });

  it("a paid payslip shows the payment line, rate and the difference", async () => {
    mount();
    const table = await screen.findByTestId("payslips-table");
    const jose = within(table).getByText("Jose Reyes").closest("tr") as HTMLElement;
    fireEvent.click(within(jose).getByRole("button", { name: /View/ }));
    const pay = await screen.findByTestId("payslip-payment");
    expect(pay).toHaveTextContent("September 2026 salary ¥14,762 → ₱6,150");
    expect(pay).toHaveTextContent("Rate used ₱0.41661 per ¥1");
    expect(pay).toHaveTextContent("Paid on 5 Oct 2026");
    expect(pay).toHaveTextContent("Difference vs payslip total: -₱50");
  });

  it("Record payment pre-fills yen from today's market rate — never the system 0.42", async () => {
    joseFinalized();
    mount();
    const yen = await openPayment();
    await waitFor(() => expect(yen.value).toBe("15500")); // ₱6,200 ÷ 0.40
    expect(yen.value).not.toBe("14762"); // ₱6,200 ÷ 0.42 (system rate)
    expect(screen.getByTestId("market-rate")).toHaveTextContent("Market rate today: ¥1 = ₱0.40 (open.er-api.com, Mon, 26 Oct 2026 00:02:31 +0000)");
    expect((screen.getByLabelText("Pesos received (₱)") as HTMLInputElement).value).toBe("6200");
  });

  it("when no market rate can be fetched the yen stays empty and says so", async () => {
    joseFinalized();
    fetchMock.mockImplementation(async () => { throw new Error("offline"); });
    mount();
    const yen = await openPayment();
    await waitFor(() => expect(screen.getByTestId("market-rate")).toHaveTextContent("Market rate unavailable — enter the yen sent from the proof."));
    expect(yen.value).toBe("");
  });

  it("a typed yen amount is never overwritten when the rate arrives", async () => {
    joseFinalized();
    let release: () => void = () => {};
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, json: async () => ({ rates: { PHP: 0.4 }, time_last_update_utc: "x" }) });
    }));
    mount();
    const yen = await openPayment();
    expect(screen.getByTestId("market-rate")).toHaveTextContent("Getting today's market rate…");
    fireEvent.change(yen, { target: { value: "15000" } });
    release();
    await waitFor(() => expect(screen.getByTestId("market-rate")).toHaveTextContent("Market rate today"));
    expect(yen.value).toBe("15000");
  });

  it("Edit details on a row opens that person and saves with their user id", async () => {
    mount();
    const table = await screen.findByTestId("payslips-table");
    const kaila = within(table).getByText("Kaila Cruz").closest("tr") as HTMLElement;
    fireEvent.click(within(kaila).getByRole("button", { name: /Edit details/ }));
    const row = await screen.findByTestId("payslip-details-row");
    expect(row).toHaveTextContent("Kaila Cruz");
    expect(screen.getAllByTestId("payslip-details-row")).toHaveLength(1);
    fireEvent.change(within(row).getByLabelText("Address"), { target: { value: "12 Rizal St" } });
    fireEvent.change(within(row).getByLabelText("Date of birth"), { target: { value: "1995-03-14" } });
    fireEvent.click(within(row).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("save_staff_payroll_details",
      { p_user_id: "u-kaila", p_address: "12 Rizal St", p_date_of_birth: "1995-03-14" }));
  });

  it("a payslip blocked on missing details offers Edit details for that person", async () => {
    mount();
    const table = await screen.findByTestId("payslips-table");
    const kaila = within(table).getByText("Kaila Cruz").closest("tr") as HTMLElement;
    fireEvent.click(within(kaila).getByRole("button", { name: /View/ }));
    fireEvent.click(await screen.findByTestId("payslip-edit-details"));
    const row = await screen.findByTestId("payslip-details-row");
    expect(row).toHaveTextContent("Kaila Cruz");
  });

  it("a paid payslip offers Download PDF and Download proof", async () => {
    mount();
    const table = await screen.findByTestId("payslips-table");
    const jose = within(table).getByText("Jose Reyes").closest("tr") as HTMLElement;
    fireEvent.click(within(jose).getByRole("button", { name: /View/ }));
    expect(await screen.findByTestId("payslip-download-pdf")).toBeEnabled();
    expect(screen.getByRole("button", { name: /Download proof/ })).toBeInTheDocument();
  });
});
