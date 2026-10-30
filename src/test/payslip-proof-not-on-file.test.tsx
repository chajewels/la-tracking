import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { timesheetDatesOf, isoDowOf, type TimesheetEntry, type TimesheetProfile } from "@/lib/timesheetEngine";
import {
  BOND_RETURNED_LABEL, PROOF_NOT_ON_FILE, breakdownLines, editPayload, figureInputs, figuresFromInputs, normaliseBook,
  payslipRefusal, payslipRows, storedBreakdown, validateFigureInputs,
} from "@/lib/payslips";
import { deductionRows, paymentNote } from "@/lib/payslipPdfLayout";

/**
 * "Proof not on file" (April–May 2026) and the cash bond returned on Final pay (owner 2026-10-28;
 * migration 20270209100000, features.proof_not_on_file / bond_returned). The SQL harness (phase 7) is the
 * authority on the server side.
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
  edit_figures: true, proof_not_on_file: true, bond_returned: true,
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

describe("Proof not on file + cash bond returned — rules", () => {
  it("the payload carries a returned bond only when one above 0 is typed", () => {
    const fig = figuresFromInputs("live_admin", figureInputs("live_admin", { days_at_500: 1, days_at_300: 0, total_hours: 4 }, {}), {});
    expect(editPayload(fig, "", "")).not.toHaveProperty("cash_bond_returned_php");
    expect(editPayload(fig, "", "0")).not.toHaveProperty("cash_bond_returned_php");
    expect(editPayload(fig, "", " 7333.33 ")).toMatchObject({ cash_bond_returned_php: 7333.33, total_php: 500 });
  });

  it("validates the returned bond", () => {
    const f = { ...figureInputs("live_admin", { days_at_500: 1, days_at_300: 0, total_hours: 4 },
      { earnings: 0, top_sales_bonus: 0 }), cash_bond_returned: "7,333" };
    expect(validateFigureInputs("live_admin", f, "Last pay")).toMatch(/Cash bond returned/);
    expect(validateFigureInputs("live_admin", { ...f, cash_bond_returned: "7333.33" }, "Last pay")).toBeNull();
  });

  it("a returned bond (no source payslip) is labelled as held before the Hub on the screen, Excel and PDF", () => {
    const p = normaliseBook({ month: "2026-05-01", features: ALL,
      payslips: [payslip({ pay_month: "2026-05-01", is_final_pay: true, correction_reason: "Cash bond returned on final pay",
        cash_bond_released_php: "7333.33", amount_due_php: "22333.33", php_received: "22333.33" })] }).payslips[0];
    const b = storedBreakdown(p)!;
    expect(breakdownLines(b, true).map(l => l.label)).toContain(BOND_RETURNED_LABEL);
    expect(deductionRows(p).bond[0]).toMatchObject({ label: BOND_RETURNED_LABEL, amount: 7333.33 });
    expect(payslipRows(p, "2026-10-28").map(r => r.join(" | "))).toContain(`${BOND_RETURNED_LABEL} | ₱7,333.33`);
  });

  it("shows \"proof not on file\" on Excel and the PDF payment line", () => {
    const p = normaliseBook({ month: "2026-04-01", features: ALL,
      payslips: [payslip({ pay_month: "2026-04-01", proof_path: null, proof_not_on_file: true, paid_on: "2026-05-05" })] }).payslips[0];
    expect(p.proof_not_on_file).toBe(true);
    expect(payslipRows(p, "2026-10-28").map(r => r.join(" | "))).toContain(`Proof of payment | ${PROOF_NOT_ON_FILE}`);
    expect(paymentNote(p, null)).toContain(PROOF_NOT_ON_FILE);
    expect(paymentNote(p, null)).not.toMatch(/attached/);
  });

  it("explains bond_pending_in_hub", () => {
    expect(payslipRefusal("bond_pending_in_hub")).toMatch(/added by itself on Final pay/);
  });
});

describe("Payslips tab — proof not on file + cash bond returned", () => {
  it("a paid payslip without proof says so and offers no proof button", async () => {
    book.payslips = [payslip({ proof_path: null, proof_not_on_file: true })];
    const view = await openView();
    expect(within(view).getByTestId("payslip-proof-not-on-file")).toHaveTextContent(PROOF_NOT_ON_FILE);
    expect(within(view).queryByTestId("payslip-proof")).toBeNull();
    expect(within(view).queryByTestId("payslip-add-second-proof")).toBeNull();
  });

  it("Final pay shows \"Cash bond returned\"; the typed amount is added and sent", async () => {
    const view = await openView();
    fireEvent.click(await within(view).findByTestId("payslip-edit-figures"));
    const dialog = await screen.findByTestId("edit-figures-dialog");
    expect(within(dialog).queryByTestId("ef-bond-returned-field")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("ef-final-pay"));
    expect(within(dialog).getByTestId("ef-bond-returned-field")).toBeInTheDocument();
    type("cash_bond_returned", "7333.33");
    type("reason", "Cash bond returned on final pay");
    await waitFor(() => expect(within(dialog).getByTestId("ef-totals")).toHaveTextContent("Cash bond returned+ ₱7,333.33"));
    fireEvent.click(within(dialog).getByTestId("ef-save"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("finalize_payslip", expect.objectContaining({
      p_is_final_pay: true, p_correction_reason: "Cash bond returned on final pay",
      p_payload: expect.objectContaining({ cash_bond_returned_php: 7333.33 }),
    })));
  });

  it("without the feature the field never shows", async () => {
    book.features = { ...ALL, bond_returned: false };
    const view = await openView();
    fireEvent.click(await within(view).findByTestId("payslip-edit-figures"));
    const dialog = await screen.findByTestId("edit-figures-dialog");
    fireEvent.click(within(dialog).getByTestId("ef-final-pay"));
    expect(within(dialog).queryByTestId("ef-bond-returned-field")).toBeNull();
  });
});
