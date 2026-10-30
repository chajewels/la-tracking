import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { timesheetDatesOf, isoDowOf, type TimesheetEntry, type TimesheetProfile } from "@/lib/timesheetEngine";

/**
 * Payslips tab once the database has the cash-advance / employee-ID / cash-bond features
 * (get_payslip_book "features"; migration 20270204100000). The old-book behaviour is pinned by
 * payslips-tab.test.tsx; the SQL harness is the authority on every refusal.
 */

const rpc = vi.fn();
const upload = vi.fn();
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
    from: (t: string) => query(t === "commission_agents" ? [] : []),
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a), createSignedUrl: async () => ({ data: null, error: {} }) }) },
  },
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), warning: vi.fn() } }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

import PayslipsTab from "@/components/timesheet/PayslipsTab";

const KAILA = "u-kaila";
const JOSE = "u-jose";
const prof = (user_id: string, template_type: "csr" | "live_admin"): TimesheetProfile => ({
  id: user_id, user_id, template_type, job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: template_type === "csr" ? 12000 : null,
  allowance: template_type === "csr" ? 2000 : null, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
});
// Kaila works every non-Sunday of September's window: ₱12,000 capped + ₱2,000 allowance = ₱14,000.
const kailaEntries: TimesheetEntry[] = timesheetDatesOf("2026-09").filter(d => isoDowOf(d) !== 7)
  .map(d => ({ work_date: d, am_in: `${d}T09:00:00+08:00`, am_out: null, pm_in: null, pm_out: `${d}T17:00:00+08:00` }));

const FEATURES = { cash_advances: true, employee_id: true, cash_bond: true, pay_history: true, from_april: true };
let book: Record<string, unknown>;
afterEach(() => vi.unstubAllGlobals());

const advance = (over: Record<string, unknown>) => ({
  id: "a1", user_id: KAILA, pay_month: "2026-09-01", advance_date: "2026-09-10", amount_php: "1000.00", note: "Rent",
  proof_path: null, status: "active", void_reason: null, created_at: "2026-09-10T00:00:00Z", payslip_id: null, ...over,
});

beforeEach(() => {
  rpc.mockReset();
  upload.mockReset();
  toastError.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PHP: 0.4 }, time_last_update_utc: "x" }) })));
  book = {
    ok: true, month: "2026-09-01", can_manage: true, php_jpy_rate: "0.42", features: FEATURES,
    payslips: [],
    details: [
      { user_id: KAILA, address: "Quezon City", date_of_birth: "1995-03-14", employee_id: "CJ-001", hire_date: "2026-09-03",
        first_month_issued: false, cash_bond_pending: null },
      { user_id: JOSE, address: "Cebu", date_of_birth: "1998-11-02", employee_id: null, hire_date: null,
        first_month_issued: null, cash_bond_pending: null },
    ],
    cash_advances: [advance({}), advance({ id: "a0", amount_php: "50.00", note: "Typo", status: "void", void_reason: "Typed twice" })],
    pay_settings: [],
  };
  rpc.mockImplementation(async (name: string) => {
    if (name === "get_payslip_book") return { data: book, error: null };
    if (name === "add_cash_advance") return { data: { ok: true, advance: { id: "new-1" } }, error: null };
    if (name === "attach_cash_advance_proof") return { data: { ok: true }, error: null };
    if (name === "save_staff_payroll_details") return { data: { ok: true, changed: [] }, error: null };
    if (name === "finalize_payslip") return { data: { ok: true, payslip: {} }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
});

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PayslipsTab
        profiles={[prof(KAILA, "csr"), prof(JOSE, "live_admin")]}
        entriesByUser={new Map([[KAILA, kailaEntries]])}
        nameByUser={new Map([[KAILA, "Kaila Cruz"], [JOSE, "Jose Reyes"]])}
        monthKey="2026-09"
        onMonthChange={() => {}}
        monthOptions={["2026-10", "2026-09"]}
      />
    </QueryClientProvider>,
  );
};
const rowOf = async (name: string) => {
  const table = await screen.findByTestId("payslips-table");
  return within(table).getByText(name).closest("tr") as HTMLElement;
};

describe("Payslips tab — cash advances, employee ID, cash bond", () => {
  it("each row offers Cash advances with the active count", async () => {
    mount();
    const kaila = await rowOf("Kaila Cruz");
    const btn = within(kaila).getByTestId("payslip-advances-open");
    expect(btn).toHaveTextContent("Cash advances");
    expect(btn).toHaveTextContent("1"); // the void one is not counted
  });

  it("the list's Amount due deducts cash advances (and the bond), same as the payslip", async () => {
    mount();
    const kaila = await rowOf("Kaila Cruz");
    // ₱14,000 earnings − ₱1,000 advance = ₱13,000 net − ₱6,500 first-month bond = ₱6,500.
    await waitFor(() => expect(within(kaila).getByText("₱6,500")).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: "Amount due" })).toBeInTheDocument();
  });

  it("Edit details has Employee ID and Hire date and saves them with the 5-argument call", async () => {
    mount();
    fireEvent.click(within(await rowOf("Jose Reyes")).getByRole("button", { name: /Edit details/ }));
    const row = await screen.findByTestId("payslip-details-row");
    fireEvent.change(within(row).getByLabelText("Employee ID (required to finalize)"), { target: { value: " LA-7 " } });
    fireEvent.change(within(row).getByLabelText("Hire date (optional)"), { target: { value: "2026-08-20" } });
    fireEvent.click(within(row).getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("save_staff_payroll_details", {
      p_user_id: JOSE, p_address: "Cebu", p_date_of_birth: "1998-11-02", p_employee_id: "LA-7", p_hire_date: "2026-08-20",
    }));
  });

  it("Finalize waits for the employee ID", async () => {
    mount();
    fireEvent.click(within(await rowOf("Jose Reyes")).getByRole("button", { name: /View/ }));
    const view = await screen.findByTestId("payslip-view");
    await waitFor(() => expect(within(view).getByTestId("payslip-finalize-block"))
      .toHaveTextContent("Add employee ID, address and date of birth first"));
    expect(within(view).getByTestId("payslip-edit-details")).toBeInTheDocument();
  });

  it("the draft shows advances, net pay, the first-month cash bond and the amount due", async () => {
    mount();
    fireEvent.click(within(await rowOf("Kaila Cruz")).getByRole("button", { name: /View/ }));
    const view = await screen.findByTestId("payslip-view");
    await waitFor(() => expect(within(view).getByText("Less: Cash advance — 10 Sep 2026 · Rent")).toBeInTheDocument());
    expect(within(view).getByText("Net pay").nextSibling).toHaveTextContent("₱13,000");
    expect(within(view).getByText("Less: Cash bond — first-month pay (50% held)").nextSibling).toHaveTextContent("-₱6,500");
    expect(within(view).getByTestId("payslip-amount-due")).toHaveTextContent("Amount due₱6,500");
    expect(within(view).getByTestId("payslip-bond-note")).toHaveTextContent("First pay month — 50% held as cash bond");
    expect(within(view).getByText("Employee ID").nextSibling).toHaveTextContent("CJ-001");
  });

  it("Finalize sends the Final pay tick (no bond held when ticked)", async () => {
    mount();
    fireEvent.click(within(await rowOf("Kaila Cruz")).getByRole("button", { name: /View/ }));
    const finalizeBtn = await screen.findByTestId("payslip-finalize");
    await waitFor(() => expect(finalizeBtn).toBeEnabled());
    fireEvent.click(finalizeBtn);
    expect(await screen.findByTestId("payslip-final-bond")).toHaveTextContent("Cash bond held: ₱6,500");
    fireEvent.click(screen.getByTestId("payslip-final-pay"));
    await waitFor(() => expect(screen.queryByTestId("payslip-final-bond")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /^Finalize$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("finalize_payslip", expect.objectContaining({
      p_user_id: KAILA, p_pay_month: "2026-09-01", p_is_final_pay: true,
    })));
  });

  it("adds an advance, uploads its proof, then attaches it", async () => {
    upload.mockResolvedValue({ error: null });
    mount();
    fireEvent.click(within(await rowOf("Kaila Cruz")).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    expect(within(dlg).getByText("Cash advances — Kaila Cruz, September 2026")).toBeInTheDocument();
    expect(within(dlg).getAllByTestId("cash-advance-row")).toHaveLength(2);
    expect(within(dlg).getByTestId("cash-advances-total")).toHaveTextContent("₱1,000");
    fireEvent.change(within(dlg).getByLabelText("Amount (₱)"), { target: { value: "250.50" } });
    fireEvent.change(within(dlg).getByLabelText("Note"), { target: { value: "Medicine" } });
    const file = new File(["x"], "gcash.png", { type: "image/png" });
    fireEvent.change(within(dlg).getByLabelText(/Proof \(optional/), { target: { files: [file] } });
    fireEvent.click(within(dlg).getByTestId("cash-advance-add"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("attach_cash_advance_proof", expect.objectContaining({ p_id: "new-1" })));
    expect(rpc).toHaveBeenCalledWith("add_cash_advance", expect.objectContaining({
      p_user_id: KAILA, p_pay_month: "2026-09-01", p_amount_php: 250.5, p_note: "Medicine",
    }));
    expect(String(upload.mock.calls[0][0])).toMatch(/^advances\/new-1\/\d+-gcash\.png$/);
  });

  it("a failed upload keeps the advance and offers Attach proof", async () => {
    upload.mockResolvedValue({ error: { message: "boom" } });
    mount();
    fireEvent.click(within(await rowOf("Kaila Cruz")).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    fireEvent.change(within(dlg).getByLabelText("Amount (₱)"), { target: { value: "100" } });
    fireEvent.change(within(dlg).getByLabelText("Note"), { target: { value: "Food" } });
    fireEvent.change(within(dlg).getByLabelText(/Proof \(optional/), { target: { files: [new File(["x"], "a.jpg", { type: "image/jpeg" })] } });
    fireEvent.click(within(dlg).getByTestId("cash-advance-add"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("The advance is saved, but its proof did not upload. Use Attach proof to try again."));
    expect(rpc).toHaveBeenCalledWith("add_cash_advance", expect.anything());
    expect(rpc).not.toHaveBeenCalledWith("attach_cash_advance_proof", expect.anything());
    expect(within(dlg).getByText("Attach proof")).toBeInTheDocument(); // the existing active advance without a proof
  });

  it("a finalized month makes the advances read-only", async () => {
    book.payslips = [{
      id: "s1", user_id: KAILA, pay_month: "2026-09-01", status: "finalized", staff_name: "Kaila Cruz", address: "QC",
      date_of_birth: "1995-03-14", job_title: null, template_type: "csr",
      timesheet: { days_worked: 26, total_hours: 216, daily_pay_sum: 12000, basic_salary: 12000, capped_gross: 12000,
        monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 14000 },
      commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
      timesheet_net_php: "14000", commission_php: "0", total_php: "14000", jpy_sent: null, php_received: null, php_per_jpy: null,
      paid_on: null, proof_path: null, finalized_at: "2026-10-01T00:00:00Z", paid_at: null, voided_at: null, void_reason: null,
      created_at: "2026-10-01T00:00:00Z", employee_id: "CJ-001", hire_date: "2026-09-03",
      cash_advances: [{ id: "a1", advance_date: "2026-09-10", amount_php: 1000, note: "Rent", proof_path: null }],
      cash_advance_php: "1000", net_pay_php: "13000", is_final_pay: false, cash_bond_held_php: "6500",
      cash_bond_released_php: "0", cash_bond_source_payslip_id: null, amount_due_php: "6500",
    }];
    mount();
    fireEvent.click(within(await rowOf("Kaila Cruz")).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    expect(within(dlg).getByTestId("cash-advances-locked")).toHaveTextContent("This month's payslip is finalized — void it to change advances");
    expect(within(dlg).queryByTestId("cash-advance-add")).toBeNull();
    expect(within(dlg).queryByRole("button", { name: /Void/ })).toBeNull();
  });

  it("Record payment pre-fills the AMOUNT DUE and its yen", async () => {
    (book.details as Record<string, unknown>[])[0].hire_date = "2026-09-03";
    book.payslips = [{
      id: "s1", user_id: KAILA, pay_month: "2026-09-01", status: "finalized", staff_name: "Kaila Cruz", address: "QC",
      date_of_birth: "1995-03-14", job_title: null, template_type: "csr",
      timesheet: { days_worked: 26, total_hours: 216, daily_pay_sum: 12000, basic_salary: 12000, capped_gross: 12000,
        monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 14000 },
      commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
      timesheet_net_php: "14000", commission_php: "0", total_php: "14000", jpy_sent: null, php_received: null, php_per_jpy: null,
      paid_on: null, proof_path: null, finalized_at: "2026-10-01T00:00:00Z", paid_at: null, voided_at: null, void_reason: null,
      created_at: "2026-10-01T00:00:00Z", employee_id: "CJ-001", hire_date: "2026-09-03",
      cash_advances: [{ id: "a1", advance_date: "2026-09-10", amount_php: 1000, note: "Rent", proof_path: null }],
      cash_advance_php: "1000", net_pay_php: "13000", is_final_pay: false, cash_bond_held_php: "6500",
      cash_bond_released_php: "0", cash_bond_source_payslip_id: null, amount_due_php: "6500",
    }];
    mount();
    fireEvent.click(within(await rowOf("Kaila Cruz")).getByRole("button", { name: /View/ }));
    const view = await screen.findByTestId("payslip-view");
    expect(within(view).getByTestId("payslip-amount-due")).toHaveTextContent("Amount due₱6,500");
    fireEvent.click(within(view).getByRole("button", { name: /Record payment/ }));
    const yen = await screen.findByLabelText("Yen sent (¥)") as HTMLInputElement;
    await waitFor(() => expect(yen.value).toBe("16250")); // ₱6,500 ÷ 0.40
    expect((screen.getByLabelText("Pesos received (₱)") as HTMLInputElement).value).toBe("6500");
    fireEvent.change(screen.getByLabelText("Pesos received (₱)"), { target: { value: "6400" } });
    expect(screen.getByText("Difference vs amount due: -₱100")).toBeInTheDocument();
  });
});
