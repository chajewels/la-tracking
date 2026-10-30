import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { timesheetDatesOf, isoDowOf, type TimesheetEntry, type TimesheetProfile } from "@/lib/timesheetEngine";
import {
  BOND_HELD_LABEL, BOND_HELD_TYPED_LABEL, bondPreview, breakdownLines, correctionLabel, editPayload, figureInputs,
  figuresFromInputs, normaliseBook, payslipNumber, payslipRefusal, payslipRows, storedBreakdown, validateFigureInputs,
} from "@/lib/payslips";
import { deductionRows, payslipNumber as layoutNumber } from "@/lib/payslipPdfLayout";

/**
 * Edit figures + cash bond on the salary only (owner 2026-10-27 15:20–15:32; migration 20270207100000,
 * get_payslip_book features.edit_figures). The SQL harness (phase 5) is the authority on the server side:
 * the void + re-issue transaction, the copied payment and every refusal.
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
    from: () => query([]),
    storage: { from: () => ({ upload: vi.fn(), createSignedUrl: async () => ({ data: null, error: {} }) }) },
  },
}));
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a), warning: vi.fn() },
}));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

import PayslipsTab from "@/components/timesheet/PayslipsTab";

const KAILA = "u-kaila";
const prof: TimesheetProfile = {
  id: KAILA, user_id: KAILA, template_type: "csr", job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: 12000, allowance: 2000, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
};
const kailaEntries: TimesheetEntry[] = timesheetDatesOf("2026-09").filter(d => isoDowOf(d) !== 7)
  .map(d => ({ work_date: d, am_in: `${d}T09:00:00+08:00`, am_out: null, pm_in: null, pm_out: `${d}T17:00:00+08:00` }));

const ALL = {
  cash_advances: true, employee_id: true, cash_bond: true, pay_history: true, from_april: true, second_proof: true, bonuses: true,
  edit_figures: true,
};
const ID = "5d1e2f3a-0000-4000-8000-000000000001";
const OLD = "9abcdef0-0000-4000-8000-000000000002";
const payslip = (over: Record<string, unknown> = {}) => ({
  id: ID, user_id: KAILA, pay_month: "2026-09-01", status: "paid", staff_name: "Kaila Cruz", address: "QC",
  date_of_birth: "1995-03-14", job_title: null, template_type: "csr",
  timesheet: { days_worked: 26, total_hours: 216, daily_pay_sum: 12000, basic_salary: 12000, capped_gross: 12000,
    monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 14000 },
  commission: { role_won: "Closer", earnings: 1000, top_sales_tier: 0, top_sales_bonus: 0, total: 1000 },
  timesheet_net_php: "14000", commission_php: "1000", total_php: "15000", jpy_sent: 37000, php_received: "15000", php_per_jpy: "0.405405",
  paid_on: "2026-10-05", proof_path: `${OLD}/gcash.png`, proof_path_2: null, finalized_at: "2026-10-01T00:00:00Z",
  paid_at: "2026-10-05T00:00:00Z", voided_at: null, void_reason: null, created_at: "2026-10-01T00:00:00Z", employee_id: "CJ-001",
  hire_date: null, cash_advances: [], cash_advance_php: "0", net_pay_php: "15000", is_final_pay: false, cash_bond_held_php: "0",
  cash_bond_released_php: "0", cash_bond_source_payslip_id: null, amount_due_php: "15000", bonuses: [], bonus_php: "0",
  correction_reason: null, corrected_from_payslip_id: null, ...over,
});

let book: Record<string, unknown>;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  rpc.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PHP: 0.4 }, time_last_update_utc: "x" }) })));
  book = {
    ok: true, month: "2026-09-01", can_manage: true, php_jpy_rate: "0.42", features: ALL, payslips: [],
    details: [{ user_id: KAILA, address: "QC", date_of_birth: "1995-03-14", employee_id: "CJ-001", hire_date: null,
      first_month_issued: null, cash_bond_pending: null }],
    cash_advances: [], bonuses: [], pay_settings: [],
  };
  rpc.mockImplementation(async (name: string) => {
    if (name === "get_payslip_book") return { data: book, error: null };
    if (["finalize_payslip", "correct_payslip"].includes(name)) return { data: { ok: true }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  });
});

const mount = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PayslipsTab profiles={[prof]} entriesByUser={new Map([[KAILA, kailaEntries]])}
        nameByUser={new Map([[KAILA, "Kaila Cruz"]])} monthKey="2026-09" onMonthChange={() => {}}
        monthOptions={["2026-10", "2026-09"]} />
    </QueryClientProvider>,
  );
};
const openView = async () => {
  mount();
  const table = await screen.findByTestId("payslips-table");
  const row = within(table).getByText("Kaila Cruz").closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /View/ }));
  return screen.findByTestId("payslip-view");
};
const type = (id: string, v: string) => fireEvent.change(screen.getByTestId(`ef-${id}`), { target: { value: v } });

describe("Edit figures — rules", () => {
  it("recalculates the CSR totals as the engine does (cap, allowance quarters)", () => {
    const f = figureInputs("csr", { days_worked: 26, total_hours: 216, daily_pay_sum: 12500, basic_salary: 12000,
      monthly_allowance: 4000, forfeited_weeks: 1 }, { role_won: "Closer", earnings: 500, top_sales_tier: 2, top_sales_bonus: 300 });
    const fig = figuresFromInputs("csr", f, { role_won: "Closer", top_sales_tier: 2 });
    expect(fig.timesheet).toMatchObject({ capped_gross: 12000, allowance_paid: 3000, net: 15000 });
    expect(fig.commission).toEqual({ role_won: "Closer", earnings: 500, top_sales_tier: 2, top_sales_bonus: 300, total: 800 });
    expect(fig.total_php).toBe(15800);
    // a bonus typed where there was none gets tier 1; removing it sets tier 0.
    expect(figuresFromInputs("csr", { ...f, top_sales_bonus: "0" }, { top_sales_tier: 2 }).commission.top_sales_tier).toBe(0);
    expect(figuresFromInputs("csr", f, { top_sales_tier: 0 }).commission.top_sales_tier).toBe(1);
  });

  it("recalculates Live Admin as ₱500 / ₱300 days", () => {
    const f = figureInputs("live_admin", { days_at_500: 3, days_at_300: 2, total_hours: 20 }, { earnings: 0, top_sales_bonus: 0 });
    expect(figuresFromInputs("live_admin", f, {}).timesheet).toEqual({ days_at_500: 3, days_at_300: 2, total_hours: 20, net: 2100 });
  });

  it("validates every line and the reason", () => {
    const ok = figureInputs("csr", { days_worked: 26, total_hours: 216, daily_pay_sum: 12000, basic_salary: 12000,
      monthly_allowance: 2000, forfeited_weeks: 0 }, { earnings: 0, top_sales_bonus: 0 });
    expect(validateFigureInputs("csr", ok, "Paper sheet")).toBeNull();
    expect(validateFigureInputs("csr", ok, "ab")).toMatch(/reason/);
    expect(validateFigureInputs("csr", { ...ok, days_worked: "26.5" }, "Paper sheet")).toMatch(/Days worked: enter a whole number/);
    expect(validateFigureInputs("csr", { ...ok, forfeited_weeks: "5" }, "Paper sheet")).toMatch(/at most 4/);
    expect(validateFigureInputs("csr", { ...ok, basic_salary: "-1" }, "Paper sheet")).toMatch(/Basic salary cap/);
    expect(validateFigureInputs("csr", { ...ok, earnings: "1.234" }, "Paper sheet")).toMatch(/up to 2 decimals/);
    expect(validateFigureInputs("csr", { ...ok, cash_bond: "x" }, "Paper sheet")).toMatch(/Cash bond/);
    const la = figureInputs("live_admin", { days_at_500: 20, days_at_300: 12, total_hours: 1 }, { earnings: 0, top_sales_bonus: 0 });
    expect(validateFigureInputs("live_admin", la, "Paper sheet")).toMatch(/at most 31 together/);
  });

  it("the payload carries a typed bond only when one is typed", () => {
    const fig = figuresFromInputs("live_admin", figureInputs("live_admin", { days_at_500: 1, days_at_300: 0, total_hours: 4 }, {}), {});
    expect(editPayload(fig, "")).not.toHaveProperty("cash_bond_held_php");
    expect(editPayload(fig, " 250.5 ")).toMatchObject({ cash_bond_held_php: 250.5, total_php: 500 });
  });

  it("the bond is half of the salary once edit_figures is on (commission, bonuses and advances left out)", () => {
    const base = { monthKey: "2026-09", totalPhp: 20000, advancesPhp: 3000, hireDate: "2026-09-02", firstMonthIssued: false,
      pending: null, isFinalPay: false, timesheetNetPhp: 12000.55 };
    expect(bondPreview(base).held).toBe(8500); // before the migration: (20000 − 3000) / 2
    expect(bondPreview({ ...base, salaryOnly: true }).held).toBe(6000.27); // odd centavo stays paid
    expect(bondPreview({ ...base, salaryOnly: true, isFinalPay: true }).kind).toBe("none");
  });

  it("labels a corrected payslip and its typed bond on the screen, Excel and PDF", () => {
    const p = normaliseBook({ month: "2026-09-01", features: ALL,
      payslips: [payslip({ correction_reason: "Missed day 14 Sept", corrected_from_payslip_id: OLD, cash_bond_held_php: "2000",
        amount_due_php: "13000", hire_date: "2026-09-02" })] }).payslips[0];
    expect(correctionLabel(p)).toBe(`Manually corrected (replaces payslip no. PS-2026-09-9ABCDE) — Missed day 14 Sept`);
    expect(correctionLabel({ ...p, correction_reason: null })).toBeNull();
    expect(correctionLabel({ ...p, corrected_from_payslip_id: null })).toBe("Manually corrected — Missed day 14 Sept");
    expect(layoutNumber(p)).toBe(payslipNumber(p));
    const rows = payslipRows(p, "2026-10-27").map(r => r.join(" | "));
    expect(rows).toContain(correctionLabel(p));
    const b = storedBreakdown(p);
    expect(breakdownLines(b!, true).map(l => l.label)).toContain(BOND_HELD_TYPED_LABEL);
    expect(deductionRows(p).bond[0].label).toBe(BOND_HELD_TYPED_LABEL);
    const plain = normaliseBook({ month: "2026-09-01", features: ALL,
      payslips: [payslip({ cash_bond_held_php: "2000", amount_due_php: "13000" })] }).payslips[0];
    expect(deductionRows(plain).bond[0].label).toBe(BOND_HELD_LABEL);
  });

  it("explains the new refusals", () => {
    expect(payslipRefusal("bond_exceeds_pay")).toMatch(/more than what is left to pay/);
    expect(payslipRefusal("bond_already_released")).toMatch(/Correct that later payslip first/);
  });
});

describe("Payslips tab — Edit figures", () => {
  it("is hidden until the database has the feature", async () => {
    book.features = { ...ALL, edit_figures: false };
    book.payslips = [payslip()];
    const view = await openView();
    expect(within(view).queryByTestId("payslip-edit-figures")).toBeNull();
    expect(within(view).getByTestId("payslip-changed")).toHaveTextContent(/void and re-issue/);
  });

  it("on a draft: finalizes with the typed figures and the reason (5-argument finalize)", async () => {
    const view = await openView();
    fireEvent.click(await within(view).findByTestId("payslip-edit-figures"));
    const dialog = await screen.findByTestId("edit-figures-dialog");
    expect(within(dialog).getByTestId("ef-save")).toBeDisabled(); // no reason yet
    type("basic_salary", "12500");
    type("daily_pay_sum", "12500");
    type("reason", "Paper sheet says 12,500");
    await waitFor(() => expect(within(dialog).getByTestId("ef-totals")).toHaveTextContent("₱14,500"));
    fireEvent.click(within(dialog).getByTestId("ef-save"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("finalize_payslip", expect.objectContaining({
      p_user_id: KAILA, p_pay_month: "2026-09-01", p_is_final_pay: false, p_correction_reason: "Paper sheet says 12,500",
      p_payload: expect.objectContaining({ timesheet_net_php: 14500, total_php: 14500 }),
    })));
    const payload = rpc.mock.calls.find(c => c[0] === "finalize_payslip")![1].p_payload;
    expect(payload).not.toHaveProperty("cash_bond_held_php");
    expect(toastSuccess).toHaveBeenCalledWith("Payslip finalized with your figures");
  });

  it("on a paid payslip: corrects it (void + re-issue), keeping the payment, with a typed bond", async () => {
    book.payslips = [payslip()];
    const view = await openView();
    fireEvent.click(within(view).getByTestId("payslip-edit-figures"));
    const dialog = await screen.findByTestId("edit-figures-dialog");
    expect(dialog).toHaveTextContent(/the payment and proofs stay on it/);
    type("cash_bond", "20000");
    type("reason", "Bond agreed with Kaila");
    expect(within(dialog).getByTestId("ef-problem")).toHaveTextContent(/more than what is left to pay/);
    expect(within(dialog).getByTestId("ef-save")).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("ef-bond-half"));
    expect(within(dialog).getByTestId("ef-totals")).toHaveTextContent("Cash bond held− ₱7,000Amount due₱8,000");
    fireEvent.click(within(dialog).getByTestId("ef-save"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("correct_payslip", {
      p_id: ID, p_is_final_pay: false, p_reason: "Bond agreed with Kaila",
      p_payload: expect.objectContaining({ cash_bond_held_php: 7000, timesheet_net_php: 14000, commission_php: 1000 }),
    }));
    expect(toastSuccess).toHaveBeenCalledWith("Payslip corrected — the payment was kept");
  });

  it("shows a server refusal in plain English", async () => {
    book.payslips = [payslip({ status: "finalized", jpy_sent: null, php_received: null, php_per_jpy: null, paid_on: null,
      proof_path: null, paid_at: null })];
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_payslip_book") return { data: book, error: null };
      if (name === "correct_payslip") return { data: { error: "bond_already_released" }, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const view = await openView();
    fireEvent.click(within(view).getByTestId("payslip-edit-figures"));
    await screen.findByTestId("edit-figures-dialog");
    type("reason", "Fix");
    fireEvent.click(screen.getByTestId("ef-save"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Correct that later payslip first/)));
  });

  it("a corrected payslip says so on the view", async () => {
    book.payslips = [payslip({ correction_reason: "Missed day 14 Sept", corrected_from_payslip_id: OLD })];
    const view = await openView();
    expect(within(view).getByTestId("payslip-corrected")).toHaveTextContent("Manually corrected (replaces payslip no. PS-2026-09-9ABCDE) — Missed day 14 Sept");
  });
});
