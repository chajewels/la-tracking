import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { timesheetDatesOf, isoDowOf, type TimesheetEntry, type TimesheetProfile } from "@/lib/timesheetEngine";
import {
  advanceProofPaths, advanceProofSlotFree, normaliseBook, payslipProofPaths, payslipRefusal, payslipRows, type Payslip,
} from "@/lib/payslips";
import { paymentNote, proofCaption } from "@/lib/payslipPdfLayout";
import { buildPayslipPdf } from "@/lib/payslipPdf";

/**
 * A 2nd proof file on the payment and on each cash advance (owner 2026-10-27 13:15; migration
 * 20270205100000, get_payslip_book features.second_proof). The SQL harness is the authority on refusals.
 */

const rpc = vi.fn();
const upload = vi.fn();
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
const kailaEntries: TimesheetEntry[] = timesheetDatesOf("2026-09").filter(d => isoDowOf(d) !== 7)
  .map(d => ({ work_date: d, am_in: `${d}T09:00:00+08:00`, am_out: null, pm_in: null, pm_out: `${d}T17:00:00+08:00` }));

const ALL = { cash_advances: true, employee_id: true, cash_bond: true, pay_history: true, from_april: true, second_proof: true };
const payslip = (over: Record<string, unknown> = {}) => ({
  id: "s1", user_id: KAILA, pay_month: "2026-09-01", status: "finalized", staff_name: "Kaila Cruz", address: "QC",
  date_of_birth: "1995-03-14", job_title: null, template_type: "csr",
  timesheet: { days_worked: 26, total_hours: 216, daily_pay_sum: 12000, basic_salary: 12000, capped_gross: 12000,
    monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 14000 },
  commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
  timesheet_net_php: "14000", commission_php: "0", total_php: "14000", jpy_sent: null, php_received: null, php_per_jpy: null,
  paid_on: null, proof_path: null, proof_path_2: null, finalized_at: "2026-10-01T00:00:00Z", paid_at: null, voided_at: null,
  void_reason: null, created_at: "2026-10-01T00:00:00Z", employee_id: "CJ-001", hire_date: null,
  cash_advances: [], cash_advance_php: "0", net_pay_php: "14000", is_final_pay: false, cash_bond_held_php: "0",
  cash_bond_released_php: "0", cash_bond_source_payslip_id: null, amount_due_php: "14000", ...over,
});
const PAID = {
  status: "paid", jpy_sent: 35000, php_received: "14000", php_per_jpy: "0.4", paid_on: "2026-10-05",
  proof_path: "s1/1730000000-bdo.jpg", paid_at: "2026-10-05T00:00:00Z",
};
const advance = (over: Record<string, unknown>) => ({
  id: "a1", user_id: KAILA, pay_month: "2026-09-01", advance_date: "2026-09-10", amount_php: "1000.00", note: "Rent",
  proof_path: null, proof_path_2: null, status: "active", void_reason: null, created_at: "2026-09-10T00:00:00Z",
  payslip_id: null, ...over,
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
    cash_advances: [], pay_settings: [],
  };
  rpc.mockImplementation(async (name: string) => {
    if (name === "get_payslip_book") return { data: book, error: null };
    if (["record_payslip_payment", "attach_payslip_proof", "attach_cash_advance_proof"].includes(name)) return { data: { ok: true }, error: null };
    if (name === "add_cash_advance") return { data: { ok: true, advance: { id: "new-1" } }, error: null };
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
const openView = async () => {
  fireEvent.click(within(await kailaRow()).getByRole("button", { name: /View/ }));
  return screen.findByTestId("payslip-view");
};
const img = (name: string) => new File(["x"], name, { type: "image/jpeg" });

describe("Record payment — 2 proof files", () => {
  it("uploads both files and records them with the 6-argument call", async () => {
    book.payslips = [payslip()];
    mount();
    fireEvent.click(within(await openView()).getByRole("button", { name: /Record payment/ }));
    fireEvent.change(await screen.findByLabelText("Proof of payment"), { target: { files: [img("bdo.jpg")] } });
    fireEvent.change(screen.getByLabelText("Proof of payment (2nd file, optional)"), { target: { files: [img("bdo.jpg")] } });
    const save = screen.getByRole("button", { name: /Save payment/ });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("record_payslip_payment", expect.anything()));
    const args = rpc.mock.calls.find(c => c[0] === "record_payslip_payment")?.[1] as Record<string, string>;
    expect(args.p_proof_path).toMatch(/^s1\/\d+-bdo\.jpg$/);
    expect(args.p_proof_path_2).toMatch(/^s1\/\d+-bdo\.jpg$/);
    expect(args.p_proof_path_2).not.toBe(args.p_proof_path); // same name, different paths
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("one file only sends p_proof_path_2 null", async () => {
    book.payslips = [payslip()];
    mount();
    fireEvent.click(within(await openView()).getByRole("button", { name: /Record payment/ }));
    fireEvent.change(await screen.findByLabelText("Proof of payment"), { target: { files: [img("a.jpg")] } });
    const save = screen.getByRole("button", { name: /Save payment/ });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("record_payslip_payment", expect.objectContaining({ p_proof_path_2: null })));
  });

  it("before the database update: no 2nd picker and the 5-argument call", async () => {
    book.features = { ...ALL, second_proof: false };
    book.payslips = [payslip()];
    mount();
    fireEvent.click(within(await openView()).getByRole("button", { name: /Record payment/ }));
    fireEvent.change(await screen.findByLabelText("Proof of payment"), { target: { files: [img("a.jpg")] } });
    expect(screen.queryByLabelText("Proof of payment (2nd file, optional)")).toBeNull();
    const save = screen.getByRole("button", { name: /Save payment/ });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("record_payslip_payment", expect.anything()));
    const args = rpc.mock.calls.find(c => c[0] === "record_payslip_payment")?.[1] as Record<string, unknown>;
    expect("p_proof_path_2" in args).toBe(false);
  });
});

describe("Paid payslip — adding the 2nd file later", () => {
  it("one proof: offers Add 2nd proof, uploads it and attaches it", async () => {
    book.payslips = [payslip(PAID)];
    mount();
    const view = await openView();
    expect(within(view).getByRole("button", { name: /Open proof of payment$/ })).toBeInTheDocument();
    fireEvent.change(within(view).getByLabelText("Add 2nd proof of payment"), { target: { files: [img("receipt.jpg")] } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("attach_payslip_proof", expect.objectContaining({ p_id: "s1" })));
    expect(String(upload.mock.calls[0][0])).toMatch(/^s1\/\d+-receipt\.jpg$/);
  });

  it("two proofs: both open and download, no Add 2nd proof", async () => {
    book.payslips = [payslip({ ...PAID, proof_path_2: "s1/1730000001-gcash.png" })];
    mount();
    const view = await openView();
    expect(within(view).getAllByTestId("payslip-proof")).toHaveLength(2);
    expect(within(view).getByRole("button", { name: /Open proof of payment \(2 of 2\)/ })).toBeInTheDocument();
    expect(within(view).getByRole("button", { name: /Download proof \(1 of 2\)/ })).toBeInTheDocument();
    expect(within(view).queryByTestId("payslip-add-second-proof")).toBeNull();
  });

  it("before the database update: no Add 2nd proof", async () => {
    book.features = { ...ALL, second_proof: false };
    book.payslips = [payslip(PAID)];
    mount();
    expect(within(await openView()).queryByTestId("payslip-add-second-proof")).toBeNull();
  });
});

describe("Cash advances — 2 proof files", () => {
  it("an advance with one proof offers Attach 2nd proof", async () => {
    book.cash_advances = [advance({ proof_path: "advances/a1/1-a.jpg" })];
    mount();
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    fireEvent.change(within(dlg).getByLabelText("Attach 2nd proof for Rent"), { target: { files: [img("b.jpg")] } });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("attach_cash_advance_proof", expect.objectContaining({ p_id: "a1" })));
  });

  it("an advance with two proofs shows Open proof 1 and 2 and nothing to attach", async () => {
    book.cash_advances = [advance({ proof_path: "advances/a1/1-a.jpg", proof_path_2: "advances/a1/2-b.jpg" })];
    mount();
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    expect(within(dlg).getByRole("button", { name: /Open proof 2/ })).toBeInTheDocument();
    expect(within(dlg).queryByText(/Attach/)).toBeNull();
  });

  it("adding an advance with 2 files attaches both", async () => {
    mount();
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    fireEvent.change(within(dlg).getByLabelText("Amount (₱)"), { target: { value: "300" } });
    fireEvent.change(within(dlg).getByLabelText("Note"), { target: { value: "Fare" } });
    fireEvent.change(within(dlg).getByLabelText(/Proof \(optional/), { target: { files: [img("a.jpg")] } });
    fireEvent.change(within(dlg).getByLabelText("2nd proof (optional)"), { target: { files: [img("a.jpg")] } });
    fireEvent.click(within(dlg).getByTestId("cash-advance-add"));
    await waitFor(() => expect(rpc.mock.calls.filter(c => c[0] === "attach_cash_advance_proof")).toHaveLength(2));
    const paths = upload.mock.calls.map(c => String(c[0]));
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
  });

  it("before the database update: one proof is the limit", async () => {
    book.features = { ...ALL, second_proof: false };
    book.cash_advances = [advance({ proof_path: "advances/a1/1-a.jpg" })];
    mount();
    fireEvent.click(within(await kailaRow()).getByTestId("payslip-advances-open"));
    const dlg = await screen.findByTestId("cash-advances-dialog");
    expect(within(dlg).queryByText(/Attach/)).toBeNull();
    expect(within(dlg).queryByLabelText("2nd proof (optional)")).toBeNull();
  });
});

describe("helpers, Excel, PDF", () => {
  const TINY_PNG = Uint8Array.from(Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

  it("proof paths and free slots", () => {
    expect(payslipProofPaths({ proof_path: "s/a", proof_path_2: null })).toEqual(["s/a"]);
    expect(payslipProofPaths({ proof_path: "s/a", proof_path_2: "s/b" })).toEqual(["s/a", "s/b"]);
    expect(advanceProofPaths({ proof_path: null, proof_path_2: null })).toEqual([]);
    expect(advanceProofSlotFree({ proof_path: null, proof_path_2: null }, false)).toBe(true);
    expect(advanceProofSlotFree({ proof_path: "x", proof_path_2: null }, false)).toBe(false);
    expect(advanceProofSlotFree({ proof_path: "x", proof_path_2: null }, true)).toBe(true);
    expect(advanceProofSlotFree({ proof_path: "x", proof_path_2: "y" }, true)).toBe(false);
  });

  it("the book carries second_proof and both advance paths", () => {
    const b = normaliseBook({ ...book, features: ALL, payslips: [payslip({ cash_advances: [
      { id: "a1", advance_date: "2026-09-10", amount_php: 1, note: "n", proof_path: "advances/a1/1-a", proof_path_2: "advances/a1/2-b" }] })],
    cash_advances: [advance({ proof_path_2: "advances/a1/2-b" })] });
    expect(b.features.second_proof).toBe(true);
    expect(b.payslips[0].cash_advances?.[0].proof_path_2).toBe("advances/a1/2-b");
    expect(b.cash_advances[0].proof_path_2).toBe("advances/a1/2-b");
  });

  it("refusals read plainly", () => {
    expect(payslipRefusal("second_proof_attached")).toBe("This payslip already has 2 proof files.");
    expect(payslipRefusal("not_paid")).toBe("Record the payment first.");
    expect(payslipRefusal("proof_already_attached")).toBe("This advance already has 2 proofs.");
  });

  it("Excel lists the 2nd file", () => {
    const p = normaliseBook({ ...book, payslips: [payslip({ ...PAID, proof_path_2: "s1/1730000001-gcash.png" })] }).payslips[0];
    const rows = payslipRows(p, "2026-10-27");
    expect(rows).toContainEqual(["Proof of payment", "1730000000-bdo.jpg"]);
    expect(rows).toContainEqual(["Proof of payment (2nd file)", "1730000001-gcash.png"]);
  });

  it("the PDF appends both payment proofs (1 of 2, 2 of 2) and page 1 names pages 2–3", async () => {
    const r = await buildPayslipPdf({
      page1Png: TINY_PNG, paidOn: "2026-10-05",
      proof: { bytes: TINY_PNG, contentType: "image/png", fileName: "a.png" },
      proof2: { bytes: TINY_PNG, contentType: "image/png", fileName: "b.png" },
    });
    expect(r.pageCount).toBe(3);
    expect(r.proofIncluded).toBe(true);
    expect(r.proofPages).toEqual({ first: 2, last: 3 });
    const p = normaliseBook({ ...book, payslips: [payslip(PAID)] }).payslips[0] as Payslip;
    expect(paymentNote(p, true, null, r.proofPages)).toContain("Proof of payment attached (pages 2–3)");
    expect(paymentNote(p, true)).toContain("Proof of payment attached (page 2)");
    expect(proofCaption("PS-1", "b.png", "2026-10-05", "2 of 2")).toContain("Proof of payment (2 of 2) — PS-1 — b.png");
  });

  it("a 2nd file that cannot be included gets its own fallback page and is named", async () => {
    const r = await buildPayslipPdf({
      page1Png: TINY_PNG, paidOn: "2026-10-05",
      proof: { bytes: TINY_PNG, contentType: "image/png", fileName: "a.png" },
      proof2: { bytes: new Uint8Array([1]), contentType: "image/heic", fileName: "b.heic" },
      convertImage: async () => null,
    });
    expect(r.pageCount).toBe(3);
    expect(r.proofIncluded).toBe(false);
    expect(r.proofFallbacks).toEqual(["b.heic"]);
  });
});
