import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimesheetProfile } from "@/lib/timesheetEngine";

/**
 * Commissions and Payslips against a database that has NOT had migration 20270225100000 applied yet
 * (the frontend reaches production first): the first commission_splits select asks for cutoff_day and
 * fails with an undefined-column error; both screens must retry without it and still load.
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));

let columnExists = false;
const splitsSelects: string[] = [];
const SPLIT = { month: "2026-04-01", closer_pct: 30, processor_pct: 20, coordinator_pct: 0, support_pct: 15, verifier_pct: 15,
  top_sales_pct: 15, top_sales_2_pct: 5, merge_groups: [], pool_per_item_php: 200 };
const sale = (id: string, sale_date: string) => ({ id, sale_date, item_code: id, invoice_number: id, item_amount: 1000, client_name: id,
  closer: "Ann", processor: "Bea", coordinator: null, support: "Cy", verifier: "Di", status: "Paid", channel: "Chat", source: "DM",
  opened_in_chat: true, closed_in_chat: true, eligible: true, notes: null });
const SALES = [sale("old-1", "2026-09-10"), sale("old-2", "2026-10-05")];

function query(table: string) {
  let cols = "";
  const result = () => {
    if (table === "commission_splits") {
      splitsSelects.push(cols);
      if (cols.includes("cutoff_day") && !columnExists) {
        return { data: null, error: { code: "42703", message: "column commission_splits.cutoff_day does not exist" } };
      }
      return { data: [columnExists ? { ...SPLIT, cutoff_day: null } : SPLIT], error: null };
    }
    if (table === "sales_log") return { data: SALES, error: null };
    if (table === "commission_agents") return { data: [{ id: "a1", name: "Ann", color: null, active: true, start_month: null, sort_order: 1, user_id: "u-ann" }], error: null };
    return { data: [], error: null };
  };
  const q: Record<string, unknown> = {};
  q.select = (c: string) => { cols = c; return q; };
  for (const k of ["gte", "lt", "order", "eq"]) q[k] = () => q;
  q.range = async () => result();
  q.then = (res: (v: unknown) => unknown) => res(result());
  return q;
}
const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (t: string) => query(t), storage: { from: () => ({}) } },
}));
vi.mock("@/components/layout/AppLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ roles: ["admin"], user: { id: "u-admin" } }),
}));
vi.mock("@/contexts/PermissionsContext", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/components/finance/MarkPaidPanel", () => ({ default: () => null }));

import Commissions from "@/pages/Commissions";
import PayslipsTab from "@/components/timesheet/PayslipsTab";

const prof = (user_id: string): TimesheetProfile => ({
  id: user_id, user_id, template_type: "csr", job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: 12000, allowance: 2000, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
});

beforeEach(() => {
  toastError.mockReset();
  splitsSelects.length = 0;
  columnExists = false;
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === "can_manage_payslips") return { data: true, error: null };
    if (name === "get_payslip_book") return { data: { ok: true, month: "2026-09-01", can_manage: true, php_jpy_rate: "0.42", payslips: [], details: [] }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
});

const mountCommissions = (url = "/commissions") => render(<MemoryRouter initialEntries={[url]}><Commissions /></MemoryRouter>);

describe("before the migration is applied", () => {
  it("Commissions loads, shows every sale in the Sales Log and hides the Cut-off column", async () => {
    mountCommissions("/commissions?tab=sales-log");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
    expect(splitsSelects).toHaveLength(2);
    expect(splitsSelects[0]).toContain("cutoff_day");
    expect(splitsSelects[1]).not.toContain("cutoff_day");
  });

  it("the Config tab has no Cut-off column", async () => {
    mountCommissions("/commissions?tab=config");
    expect(await screen.findByText("Commission Splits")).toBeInTheDocument();
    expect(screen.queryByText("Cut-off")).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("Payslips loads the commission month without error", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PayslipsTab profiles={[prof("u-kaila")]} entriesByUser={new Map()} nameByUser={new Map([["u-kaila", "Kaila Cruz"]])}
          monthKey="2026-09" onMonthChange={() => {}} monthOptions={["2026-09"]} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("payslips-table")).toBeInTheDocument();
    await waitFor(() => expect(splitsSelects).toHaveLength(2));
    expect(splitsSelects[1]).not.toContain("cutoff_day");
  });
});

describe("after the migration is applied", () => {
  it("Config shows the Cut-off column; the Archived tab holds the closed periods and the Sales Log the rest", async () => {
    columnExists = true;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T03:00:00Z"));
    try {
      mountCommissions("/commissions?tab=archived");
      expect(await screen.findByLabelText("Archived month")).toBeInTheDocument();
      expect(await screen.findByText("1 of 1")).toBeInTheDocument();
      expect(splitsSelects).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Config shows the Cut-off column once the column exists", async () => {
    columnExists = true;
    mountCommissions("/commissions?tab=config");
    expect(await screen.findByText("Cut-off")).toBeInTheDocument();
    expect(screen.getByLabelText("Apr 2026 cut-off")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Apr 2026 cut-off"), { target: { value: "20" } });
    expect((screen.getByLabelText("Apr 2026 cut-off") as HTMLSelectElement).value).toBe("20");
  });
});
