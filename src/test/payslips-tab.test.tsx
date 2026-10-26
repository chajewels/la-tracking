import { beforeEach, describe, expect, it, vi } from "vitest";
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
  for (const k of ["select", "gte", "lt", "order"]) q[k] = () => q;
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
});
