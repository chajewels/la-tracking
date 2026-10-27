import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { timesheetDatesOf, isoDowOf, type TimesheetEntry, type TimesheetProfile } from "@/lib/timesheetEngine";
import {
  bonusesTotal, breakdownLines, draftBreakdown, normaliseBook, payslipRefusal, payslipRows, storedBreakdown,
  storedFiguresTotal, validateBonus, type PayslipBonus,
} from "@/lib/payslips";
import { assertEarningsMatch, earningsRows, paymentNote } from "@/lib/payslipPdfLayout";
import { buildPayslipPdf } from "@/lib/payslipPdf";

/**
 * Bonuses typed per month (owner 2026-10-27 14:04; migration 20270206100000, get_payslip_book
 * features.bonuses): Performance / KPI and Holiday / Christmas, added to earnings, up to 2 proofs each.
 * The SQL harness (phase 4) is the authority on refusals and the server-side total.
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
    from: () => query([]),
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a), createSignedUrl: async () => ({ data: null, error: {} }) }) },
  },
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a), warning: vi.fn() } }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

import PayslipsTab from "@/components/timesheet/PayslipsTab";

const KAILA = "u-kaila";
const prof: TimesheetProfile = {
  id: KAILA, user_id: KAILA, template_type: "csr", job_title: null, timezone: "Asia/Manila", work_days: [1, 2, 3, 4, 5, 6],
  shift_start: null, shift_end: null, basic_salary: 12000, allowance: 2000, half_day_rate: null, full_day_rate: null,
  full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
};
// Kaila works every non-Sunday of September's window: ₱12,000 capped + ₱2,000 allowance = ₱14,000.
const kailaEntries: TimesheetEntry[] = timesheetDatesOf("2026-09").filter(d => isoDowOf(d) !== 7)
  .map(d => ({ work_date: d, am_in: `${d}T09:00:00+08:00`, am_out: null, pm_in: null, pm_out: `${d}T17:00:00+08:00` }));

const ALL = { cash_advances: true, employee_id: true, cash_bond: true, pay_history: true, from_april: true, second_proof: true, bonuses: true };
const bonus = (over: Record<string, unknown>) => ({
  id: "b1", user_id: KAILA, pay_month: "2026-09-01", bonus_date: "2026-09-30", category: "performance", amount_php: "1500.00",
  note: "Q3 targets", proof_path: null, proof_path_2: null, status: "active", void_reason: null,
  created_at: "2026-09-30T00:00:00Z", payslip_id: null, ...over,
});
const payslip = (over: Record<string, unknown> = {}) => ({
  id: "s1", user_id: KAILA, pay_month: "2026-09-01", status: "finalized", staff_name: "Kaila Cruz", address: "QC",
  date_of_birth: "1995-03-14", job_title: null, template_type: "csr",
  timesheet: { days_worked: 26, total_hours: 216, daily_pay_sum: 12000, basic_salary: 12000, capped_gross: 12000,
    monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 14000 },
  commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
  timesheet_net_php: "14000", commission_php: "0", total_php: "15500", jpy_sent: null, php_received: null, php_per_jpy: null,
  paid_on: null, proof_path: null, proof_path_2: null, finalized_at: "2026-10-01T00:00:00Z", paid_at: null, voided_at: null,
  void_reason: null, created_at: "2026-10-01T00:00:00Z", employee_id: "CJ-001", hire_date: null,
  cash_advances: [], cash_advance_php: "0", net_pay_php: "15500", is_final_pay: false, cash_bond_held_php: "0",
  cash_bond_released_php: "0", cash_bond_source_payslip_id: null, amount_due_php: "15500",
  bonuses: [{ id: "b1", bonus_date: "2026-09-30", category: "performance", amount_php: 1500, note: "Q3 targets",
    proof_path: "bonuses/b1/1-memo.pdf", proof_path_2: null }],
  bonus_php: "1500", ...over,
});

let book: Record<string, unknown>;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  rpc.mockReset();
  upload.mockReset();
  upload.mockResolvedValue({ error: null });
  toastError.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PHP: 0.4 }, time_last_update_utc: "x" }) })));
  book = {
    ok: true, month: "2026-09-01", can_manage: true, php_jpy_rate: "0.42", features: ALL, payslips: [],
    details: [{ user_id: KAILA, address: "QC", date_of_birth: "1995-03-14", employee_id: "CJ-001", hire_date: null,
      first_month_issued: null, cash_bond_pending: null }],
    cash_advances: [],
    bonuses: [bonus({}), bonus({ id: "b0", category: "holiday", amount_php: "999.00", note: "Typed twice", status: "void", void_reason: "Twice" })],
    pay_settings: [],
  };
  rpc.mockImplementation(async (name: string) => {
    if (name === "get_payslip_book") return { data: book, error: null };
    if (name === "add_payslip_bonus") return { data: { ok: true, bonus: { id: "new-b" } }, error: null };
    if (["attach_payslip_bonus_proof", "void_payslip_bonus", "finalize_payslip"].includes(name)) return { data: { ok: true }, error: null };
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
const kailaRow = async () => {
  const table = await screen.findByTestId("payslips-table");
  return within(table).getByText("Kaila Cruz").closest("tr") as HTMLElement;
};
const img = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("Payslips tab — bonuses", () => {
  it("each row offers Bonuses with the active count; the draft total includes them", async () => {
    mount();
    const row = await kailaRow();
    const btn = within(row).getByTestId("payslip-bonuses-open");
    expect(btn).toHaveTextContent("Bonuses");
    expect(btn).toHaveTextContent("1"); // the void one is not counted
    await waitFor(() => expect(row).toHaveTextContent("₱15,500"));
  });

  it("before the database update there is no Bonuses button", async () => {
    book.features = { ...ALL, bonuses: false };
    delete book.bonuses;
    mount();
    expect(within(await kailaRow()).queryByTestId("payslip-bonuses-open")).toBeNull();
  });

  it("adds a bonus with 2 proofs: category, date, amount, note, then both files attached", async () => {
    mount();
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-bonuses-open"));
    const dlg = await screen.findByTestId("bonuses-dialog");
    expect(within(dlg).getByText("Bonuses — Kaila Cruz, September 2026")).toBeInTheDocument();
    expect(within(dlg).getAllByTestId("bonus-row")).toHaveLength(2);
    expect(within(dlg).getByTestId("bonuses-total")).toHaveTextContent("₱1,500");
    fireEvent.change(within(dlg).getByLabelText("Amount (₱)"), { target: { value: "2000" } });
    fireEvent.change(within(dlg).getByLabelText("Note"), { target: { value: "Christmas" } });
    expect(within(dlg).getByTestId("bonus-add")).toBeDisabled(); // no category yet
    fireEvent.change(within(dlg).getByLabelText("Category"), { target: { value: "holiday" } });
    fireEvent.change(within(dlg).getByLabelText(/Proof \(optional/), { target: { files: [img("gift.jpg")] } });
    fireEvent.change(within(dlg).getByLabelText("2nd proof (optional)"), { target: { files: [img("gift.jpg")] } });
    fireEvent.click(within(dlg).getByTestId("bonus-add"));
    await waitFor(() => expect(rpc.mock.calls.filter(c => c[0] === "attach_payslip_bonus_proof")).toHaveLength(2));
    expect(rpc).toHaveBeenCalledWith("add_payslip_bonus", expect.objectContaining({
      p_user_id: KAILA, p_pay_month: "2026-09-01", p_category: "holiday", p_amount_php: 2000, p_note: "Christmas",
    }));
    const paths = upload.mock.calls.map(c => String(c[0]));
    expect(paths[0]).toMatch(/^bonuses\/new-b\/\d+-gift\.jpg$/);
    expect(paths[1]).not.toBe(paths[0]);
  });

  it("voids a bonus with a reason", async () => {
    mount();
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-bonuses-open"));
    const dlg = await screen.findByTestId("bonuses-dialog");
    fireEvent.click(within(dlg).getByRole("button", { name: /^Void$/ }));
    fireEvent.change(within(dlg).getByLabelText("Reason"), { target: { value: "Wrong month" } });
    fireEvent.click(within(dlg).getByRole("button", { name: /Void bonus/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("void_payslip_bonus", { p_id: "b1", p_reason: "Wrong month" }));
  });

  it("the draft view lists the bonus, adds it to total earnings and titles the section", async () => {
    mount();
    fireEvent.click(within(await kailaRow()).getByRole("button", { name: /View/ }));
    const view = await screen.findByTestId("payslip-view");
    await waitFor(() => expect(within(view).getByText("Add: Performance / KPI bonus — 30 Sep 2026 · Q3 targets")).toBeInTheDocument());
    expect(within(view).getByText("Bonuses, deductions and cash bond")).toBeInTheDocument();
    expect(within(view).getByText("Total earnings").nextSibling).toHaveTextContent("₱15,500");
    expect(within(view).getByTestId("payslip-amount-due")).toHaveTextContent("₱15,500");
  });

  it("a finalized payslip with bonuses is not flagged as changed, and its bonuses are read-only", async () => {
    book.payslips = [payslip()];
    mount();
    fireEvent.click(within(await kailaRow()).getByRole("button", { name: /View/ }));
    const view = await screen.findByTestId("payslip-view");
    await waitFor(() => expect(within(view).getByText("Add: Performance / KPI bonus — 30 Sep 2026 · Q3 targets")).toBeInTheDocument());
    expect(within(view).queryByTestId("payslip-changed")).toBeNull();
    fireEvent.keyDown(view, { key: "Escape" });
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-bonuses-open"));
    const dlg = await screen.findByTestId("bonuses-dialog");
    expect(within(dlg).getByTestId("bonuses-locked")).toHaveTextContent("This month's payslip is finalized — void it to change bonuses");
    expect(within(dlg).queryByTestId("bonus-add")).toBeNull();
  });
});

describe("bonus helpers, Excel, PDF", () => {
  const TINY_PNG = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  const live = (over: Partial<PayslipBonus>): PayslipBonus => ({
    id: "x", user_id: KAILA, pay_month: "2026-09-01", bonus_date: "2026-09-10", category: "performance", amount_php: 100,
    note: "n", proof_path: null, proof_path_2: null, status: "active", void_reason: null, created_at: "2026-09-10T00:00:00Z",
    payslip_id: null, ...over,
  });

  it("the draft adds active bonuses to earnings in date order; void ones are left out", () => {
    const none = { kind: "none" as const, held: 0, released: 0, releasedFrom: null, firstMonth: null };
    const b = draftBreakdown(14000, [], none, [
      live({ id: "2", bonus_date: "2026-09-20", amount_php: 500.25, note: "late" }),
      live({ id: "1", bonus_date: "2026-09-05", amount_php: 1000, note: "early", category: "holiday" }),
      live({ id: "3", amount_php: 999, status: "void" }),
    ]);
    expect(b.earnings).toBe(15500.25);
    expect(b.bonusesTotal).toBe(1500.25);
    expect(b.bonuses.map(x => x.note)).toEqual(["early", "late"]);
    expect(breakdownLines(b, false)[0]).toEqual({ label: "Add: Holiday / Christmas bonus — 05 Sep 2026 · early", value: "₱1,000" });
    expect(bonusesTotal([live({ amount_php: 0.1 }), live({ amount_php: 0.2 })])).toBe(0.3);
  });

  it("stored payslips: breakdown, live-figure comparison and Excel include the bonus", () => {
    const p = normaliseBook({ ...book, payslips: [payslip()] }).payslips[0];
    expect(p.bonus_php).toBe(1500);
    expect(storedFiguresTotal(p)).toBe(14000);
    const b = storedBreakdown(p);
    expect(b?.earnings).toBe(15500);
    expect(b?.bonuses).toHaveLength(1);
    expect(payslipRows(p, "2026-10-27")).toContainEqual(["Add: Performance / KPI bonus — 30 Sep 2026 · Q3 targets", "₱1,500"]);
  });

  it("PDF earnings rows list the bonus and add up to the stored total", () => {
    const p = normaliseBook({ ...book, payslips: [payslip()] }).payslips[0];
    const rows = earningsRows(p);
    expect(rows.find(r => r.label === "Performance / KPI bonus")).toMatchObject({ details: "30 Sep 2026 · Q3 targets", amount: 1500 });
    expect(() => assertEarningsMatch(rows, p.total_php)).not.toThrow();
  });

  it("PDF appends bonus proofs after advance proofs and page 1 names their pages", async () => {
    const r = await buildPayslipPdf({
      page1Png: TINY_PNG, paidOn: null, proof: null,
      advanceProofs: [{ proof: { bytes: TINY_PNG, contentType: "image/png", fileName: "a.png" }, advanceDate: "2026-09-02", fileName: "a.png" }],
      bonusProofs: [
        { proof: { bytes: TINY_PNG, contentType: "image/png", fileName: "m.png" }, category: "performance", bonusDate: "2026-09-30", fileName: "m.png" },
        { proof: null, category: "holiday", bonusDate: "2026-09-30", fileName: "lost.pdf" },
      ],
    });
    expect(r.pageCount).toBe(4);
    expect(r.advancePages).toEqual({ first: 2, last: 2 });
    expect(r.bonusPages).toEqual({ first: 3, last: 4 });
    expect(r.bonusFallbacks).toEqual(["lost.pdf"]);
    const p = normaliseBook({ ...book, payslips: [payslip()] }).payslips[0];
    expect(paymentNote(p, null, r.advancePages, null, r.bonusPages)).toBe("Proofs attached: cash advance proofs page 2, bonus proofs pages 3–4");
    expect(paymentNote(p, null, null, null, r.bonusPages)).toBe("Bonus proofs attached (pages 3–4)");
  });

  it("form rules and refusals", () => {
    const ok = { bonusDate: "2026-09-30", category: "performance", amount: "1500", note: "Q3" };
    expect(validateBonus(ok, "2026-10-27")).toBeNull();
    expect(validateBonus({ ...ok, category: "" }, "2026-10-27")).toBe("Choose the bonus category.");
    expect(validateBonus({ ...ok, bonusDate: "2026-10-28" }, "2026-10-27")).toBe("The bonus date is in the future.");
    expect(validateBonus({ ...ok, bonusDate: "2026-03-31" }, "2026-10-27")).toBe("The bonus date must be from April 2026.");
    expect(validateBonus({ ...ok, amount: "1.005" }, "2026-10-27")).toBe("Enter the amount in pesos (up to 2 decimals) above 0.");
    expect(validateBonus({ ...ok, note: " " }, "2026-10-27")).toBe("Write a note for the bonus.");
    expect(payslipRefusal("bonus_month_finalized")).toBe("This month's payslip is finalized — void it to change bonuses.");
    expect(payslipRefusal("bonus_proofs_full")).toBe("This bonus already has 2 proofs.");
    expect(payslipRefusal("invalid_category")).toBe("Choose the bonus category.");
  });
});
