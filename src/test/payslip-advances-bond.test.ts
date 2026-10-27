import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildPayslipPdf } from "@/lib/payslipPdf";
import {
  advanceProofCaption, advanceProofFallback, assertDeductionsMatch, deductionRows, employeeIdLine, payBand, paymentBlock,
  paymentNote,
} from "@/lib/payslipPdfLayout";
import {
  advanceDateMin, advanceProofFileName, advanceProofPath, amountDue, bondPreview, breakdownLines, canIssueForMonth,
  draftBreakdown, normaliseBook, payslipRefusal, payslipRows, storedBreakdown, validateAdvance, validateEmployeeDetails,
  type CashAdvance, type Payslip,
} from "@/lib/payslips";

/**
 * Cash advances, employee ID and the first-month cash bond (owner 2026-10-27; migration 20270204100000).
 * finalize_payslip decides the bond server-side (SQL harness phase 2); bondPreview mirrors it for the draft.
 */

const TINY_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function slip(over: Partial<Payslip> = {}): Payslip {
  return {
    id: "3fa2b9c1-0d4e-4a7b-9c2d-1e2f3a4b5c6d", user_id: "u1", pay_month: "2026-08-01", status: "finalized",
    staff_name: "Nina Ramos", address: "Makati", date_of_birth: "2000-02-02", job_title: "CSR", template_type: "csr",
    timesheet: { days_worked: 20, total_hours: 160, daily_pay_sum: 8000.03, basic_salary: 10000, capped_gross: 8000.03,
      monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 10000.03 },
    commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
    timesheet_net_php: 10000.03, commission_php: 0, total_php: 10000.03,
    jpy_sent: null, php_received: null, php_per_jpy: null, paid_on: null, proof_path: null,
    finalized_at: "2026-09-01T01:00:00Z", paid_at: null, voided_at: null, void_reason: null, created_at: "2026-09-01T01:00:00Z",
    employee_id: "CJ-101", hire_date: "2026-08-10",
    cash_advances: [
      { id: "a1", advance_date: "2026-08-05", amount_php: 600, note: "Transport", proof_path: "advances/a1/1-gcash.png" },
      { id: "a2", advance_date: "2026-08-20", amount_php: 400, note: "Medicine", proof_path: null },
    ],
    cash_advance_php: 1000, net_pay_php: 9000.03, is_final_pay: false,
    cash_bond_held_php: 4500.01, cash_bond_released_php: 0, cash_bond_source_payslip_id: null, amount_due_php: 4500.02,
    ...over,
  };
}
const OLD: Partial<Payslip> = {
  employee_id: undefined, hire_date: undefined, cash_advances: undefined, cash_advance_php: undefined, net_pay_php: undefined,
  is_final_pay: undefined, cash_bond_held_php: undefined, cash_bond_released_php: undefined, amount_due_php: undefined,
  total_php: 10000.03,
};
const adv = (over: Partial<CashAdvance>): CashAdvance => ({
  id: "x", user_id: "u1", pay_month: "2026-08-01", advance_date: "2026-08-05", amount_php: 100, note: "n", proof_path: null,
  status: "active", void_reason: null, created_at: "2026-08-05T00:00:00Z", payslip_id: null, ...over,
});

describe("cash bond preview (mirrors finalize_payslip)", () => {
  const base = { monthKey: "2026-08", totalPhp: 10000.03, advancesPhp: 1000, hireDate: "2026-08-10", firstMonthIssued: false, pending: null, isFinalPay: false };

  it("the hire month holds half of net pay, odd centavo in the paid half", () => {
    const b = bondPreview(base);
    expect(b.kind).toBe("held");
    expect(b.held).toBe(4500.01);
    expect(draftBreakdown(10000.03, [adv({ amount_php: 600 }), adv({ amount_php: 400 })], b).due).toBe(4500.02);
  });

  it("Final pay in the first month holds nothing", () => {
    expect(bondPreview({ ...base, isFinalPay: true }).kind).toBe("none");
  });

  it("released on the next month only, or earlier on Final pay", () => {
    const pending = { source_payslip_id: "s", pay_month: "2026-08-01", amount: 4500.01 };
    const sep = bondPreview({ ...base, monthKey: "2026-09", firstMonthIssued: true, pending });
    expect(sep).toMatchObject({ kind: "released", released: 4500.01, releasedFrom: "2026-08" });
    expect(bondPreview({ ...base, monthKey: "2026-10", firstMonthIssued: true, pending }).kind).toBe("none");
    expect(bondPreview({ ...base, monthKey: "2026-10", firstMonthIssued: true, pending, isFinalPay: true }).released).toBe(4500.01);
  });

  it("a later month before the first-month payslip is blocked (cash_bond_order); before April 2026 there is no bond", () => {
    expect(bondPreview({ ...base, monthKey: "2026-09" })).toMatchObject({ kind: "blocked", firstMonth: "2026-08" });
    expect(bondPreview({ ...base, monthKey: "2026-09", hireDate: "2025-03-01" }).kind).toBe("none");
    expect(bondPreview({ ...base, hireDate: null }).kind).toBe("none");
  });
});

describe("breakdown, amount due, Excel", () => {
  it("stored breakdown lines: advances, totals, net pay, bond, amount due / paid", () => {
    const lines = breakdownLines(storedBreakdown(slip())!, false).map(l => `${l.label} | ${l.value}`);
    expect(lines).toEqual([
      "Less: Cash advance — 05 Aug 2026 · Transport | -₱600",
      "Less: Cash advance — 20 Aug 2026 · Medicine | -₱400",
      "Total earnings | ₱10,000.03",
      "Total cash advances | ₱1,000",
      "Net pay | ₱9,000.03",
      "Less: Cash bond — first-month pay (50% held) | -₱4,500.01",
      "Amount due | ₱4,500.02",
    ]);
    const rel = slip({ pay_month: "2026-09-01", cash_advances: [], cash_advance_php: 0, net_pay_php: 10000.03, cash_bond_held_php: 0,
      cash_bond_released_php: 4500.01, cash_bond_source_payslip_id: "s", amount_due_php: 14500.04, cash_bond_source_month: "2026-08-01" });
    expect(breakdownLines(storedBreakdown(rel)!, true).slice(-2).map(l => `${l.label} | ${l.value}`))
      .toEqual(["Cash bond released — August 2026 | ₱4,500.01", "Amount paid | ₱14,500.04"]);
  });

  it("amount due falls back to net pay, then total (older payslips)", () => {
    expect(amountDue(slip())).toBe(4500.02);
    expect(amountDue({ total_php: 9, net_pay_php: 8, amount_due_php: undefined })).toBe(8);
    expect(amountDue(slip(OLD))).toBe(10000.03);
    expect(storedBreakdown(slip(OLD))).toBeNull();
  });

  it("Excel: Employee ID row, the deduction rows and Amount due; older payslips keep Total", () => {
    const rows = payslipRows(slip(), "2026-10-27").map(r => r.join(" | "));
    expect(rows).toContain("Employee ID | CJ-101");
    expect(rows).toContain("Less: Cash advance — 05 Aug 2026 · Transport | -₱600");
    expect(rows).toContain("Total cash advances | ₱1,000");
    expect(rows).toContain("Less: Cash bond — first-month pay (50% held) | -₱4,500.01");
    expect(rows).toContain("Amount due | ₱4,500.02");
    expect(rows).not.toContain("Total | ₱10,000.03");
    const old = payslipRows(slip(OLD), "2026-10-27").map(r => r.join(" | "));
    expect(old).toContain("Total | ₱10,000.03");
    expect(old.some(r => r.startsWith("Employee ID"))).toBe(false);
  });

  it("a paid payslip compares the pesos with the amount due", () => {
    const paid = slip({ status: "paid", jpy_sent: 11000, php_received: 4500, php_per_jpy: 0.409091, paid_on: "2026-09-25", proof_path: "x/p.jpg" });
    expect(payslipRows(paid, "2026-10-27").map(r => r.join(" | "))).toContain("Difference vs amount due | -₱0.02");
    const block = paymentBlock(paid);
    expect(block.paid && block.rows.map(r => r.label)).toContain("Difference vs amount due");
  });
});

describe("forms, features, refusals", () => {
  it("features: an old book has none, a 20270204100000 book all five (second_proof comes with 20270205100000)", () => {
    expect(normaliseBook({ month: "2026-09-01", payslips: [], details: [] }).features.cash_advances).toBe(false);
    const b = normaliseBook({
      month: "2026-09-01", payslips: [], features: { cash_advances: true, employee_id: true, cash_bond: true, pay_history: true, from_april: true },
      details: [{ user_id: "u", address: "a", date_of_birth: "1990-01-01", employee_id: "CJ-1", hire_date: "2026-08-10",
        first_month_issued: true, cash_bond_pending: { source_payslip_id: "s", pay_month: "2026-08-01", amount: "4500.01" } }],
      cash_advances: [{ id: "a", user_id: "u", pay_month: "2026-09-01", advance_date: "2026-09-02", amount_php: "100.50", note: "x", status: "void" }],
      pay_settings: [{ user_id: "u", effective_from: "2026-04-01", basic_salary: null, allowance: "4000" }],
    });
    const { second_proof, ...five } = b.features;
    expect(Object.values(five).every(Boolean)).toBe(true);
    expect(second_proof).toBe(false);
    expect(b.details[0].cash_bond_pending?.amount).toBe(4500.01);
    expect(b.cash_advances[0]).toMatchObject({ amount_php: 100.5, status: "void" });
    expect(b.pay_settings[0].allowance).toBe(4000);
    expect(canIssueForMonth("2026-04", true)).toBe(true);
    expect(canIssueForMonth("2026-04", false)).toBe(false);
  });

  it("employee ID and hire date rules", () => {
    expect(validateEmployeeDetails("CJ-001", "", "2026-10-27")).toBeNull();
    expect(validateEmployeeDetails("CJ 001", "", "2026-10-27")).toMatch(/letters, digits and hyphens/);
    expect(validateEmployeeDetails("A".repeat(31), "", "2026-10-27")).toMatch(/1–30/);
    expect(validateEmployeeDetails("", "2019-12-31", "2026-10-27")).toMatch(/before 2020/);
    expect(validateEmployeeDetails("", "2027-10-28", "2026-10-27")).toMatch(/more than a year/);
    expect(validateEmployeeDetails("", "2027-10-27", "2026-10-27")).toBeNull();
  });

  it("advance rules: date from the 1st of last month to today, 2 decimals, note", () => {
    const ok = { advanceDate: "2026-09-01", amount: "1000.50", note: "Rent" };
    expect(advanceDateMin("2026-10-27")).toBe("2026-09-01");
    expect(advanceDateMin("2026-01-15")).toBe("2025-12-01");
    expect(validateAdvance(ok, "2026-10-27")).toBeNull();
    expect(validateAdvance({ ...ok, advanceDate: "2026-08-31" }, "2026-10-27")).toMatch(/1st of last month/);
    expect(validateAdvance({ ...ok, advanceDate: "2026-10-28" }, "2026-10-27")).toMatch(/future/);
    expect(validateAdvance({ ...ok, amount: "1.234" }, "2026-10-27")).toMatch(/2 decimals/);
    expect(validateAdvance({ ...ok, note: "  " }, "2026-10-27")).toMatch(/note/);
    expect(advanceProofPath("a1", "My GCash.png", 1730000000)).toBe("advances/a1/1730000000-My_GCash.png");
    expect(advanceProofFileName("advances/a1/1730000000-My_GCash.png")).toBe("1730000000-My_GCash.png");
  });

  it("new refusals read as plain English", () => {
    for (const c of ["cash_bond_order", "advance_exceeds_pay", "month_finalized", "pay_settings_mismatch", "employee_id_taken",
      "invalid_employee_id", "invalid_hire_date", "note_required", "invalid_amount", "invalid_date"]) {
      expect(payslipRefusal(c)).not.toContain("_");
      expect(payslipRefusal(c)).not.toBe(payslipRefusal("unknown"));
    }
  });
});

describe("PDF page 1 rows", () => {
  it("PAID TO: Employee ID, omitted when absent", () => {
    expect(employeeIdLine(slip())).toBe("Employee ID: CJ-101");
    expect(employeeIdLine(slip(OLD))).toBeNull();
  });

  it("advance rows (negative), summary, bond row, AMOUNT DUE / AMOUNT PAID band; older = NET PAY total", () => {
    const d = deductionRows(slip());
    expect(d.advances.map(r => [r.label, r.amountText])).toEqual([
      ["Less: Cash advance — 05 Aug 2026 · Transport", "-₱600"], ["Less: Cash advance — 20 Aug 2026 · Medicine", "-₱400"]]);
    expect(d.summary.map(r => r.label)).toEqual(["Total earnings", "Total cash advances", "Net pay"]);
    expect(d.bond.map(r => r.label)).toEqual(["Less: Cash bond — first-month pay (50% held)"]);
    expect(payBand(slip())).toEqual({ label: "AMOUNT DUE", amount: 4500.02 });
    expect(payBand(slip({ status: "paid" }))).toEqual({ label: "AMOUNT PAID", amount: 4500.02 });
    expect(payBand(slip(OLD))).toEqual({ label: "NET PAY", amount: 10000.03 });
    expect(deductionRows(slip(OLD))).toEqual({ advances: [], summary: [], bond: [] });
  });

  it("earnings − advances − held + released must equal the amount due", () => {
    expect(() => assertDeductionsMatch(slip())).not.toThrow();
    expect(() => assertDeductionsMatch(slip(OLD))).not.toThrow();
    expect(() => assertDeductionsMatch(slip({ amount_due_php: 4500.03 }))).toThrow("deductions_mismatch");
    expect(() => assertDeductionsMatch(slip({ cash_advance_php: 999 }))).toThrow("deductions_mismatch");
  });

  it("paid line names the paid-on date, page 2 and the advance-proof pages", () => {
    const paid = slip({ status: "paid", jpy_sent: 11000, php_received: 4500.02, php_per_jpy: 0.409093, paid_on: "2026-09-05", proof_path: "x/p.jpg" });
    expect(paymentNote(paid, true, { first: 3, last: 4 }))
      .toBe("August 2026 salary paid on 05 Sep 2026: ¥11,000 → ₱4,500.02 · Proof of payment attached (page 2), cash advance proofs pages 3–4");
    expect(paymentNote(paid, true, { first: 3, last: 3 })).toMatch(/cash advance proofs page 3$/);
    expect(paymentNote(slip(), null, { first: 2, last: 2 })).toBe("Cash advance proofs attached (page 2)");
    expect(paymentNote(slip(), null, null)).toBeNull();
    expect(advanceProofCaption("2026-08-05", "1-gcash.png")).toBe("Cha Jewels Co., Ltd. — Cash advance — 05 Aug 2026 — 1-gcash.png");
    expect(advanceProofFallback("x.heic")).toBe("Cash advance proof could not be included — open it from the Hub: x.heic");
  });
});

describe("PDF page counts with advance proofs", () => {
  const pages = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();
  const payday = { bytes: TINY_PNG, contentType: "image/png", fileName: "p.png" };
  const advProof = { bytes: TINY_PNG, contentType: "image/png", fileName: "a.png" };

  it("0 advance proofs: payslip + payday proof", async () => {
    const r = await buildPayslipPdf({ page1Png: TINY_PNG, proof: payday, paidOn: "2026-09-05", advanceProofs: [] });
    expect(await pages(r.bytes)).toBe(2);
    expect(r.advancePages).toBeNull();
  });

  it("1 advance proof follows the payday proof (page 3)", async () => {
    let seen: unknown = null;
    const r = await buildPayslipPdf({
      renderPage1: async (_n, _p, adv) => { seen = adv; return TINY_PNG; },
      proof: payday, paidOn: "2026-09-05", advanceProofs: [{ proof: advProof, advanceDate: "2026-08-05", fileName: "a.png" }],
    });
    expect(await pages(r.bytes)).toBe(3);
    expect(r.advancePages).toEqual({ first: 3, last: 3 });
    expect(seen).toEqual({ first: 3, last: 3 });
  });

  it("2 advance proofs, one unreadable → fallback page; an unpaid payslip starts them at page 2", async () => {
    const r = await buildPayslipPdf({
      page1Png: TINY_PNG, proof: null, paidOn: null,
      advanceProofs: [
        { proof: advProof, advanceDate: "2026-08-05", fileName: "a.png" },
        { proof: null, advanceDate: "2026-08-20", fileName: "b.heic" },
      ],
    });
    expect(await pages(r.bytes)).toBe(3);
    expect(r.advancePages).toEqual({ first: 2, last: 3 });
    expect(r.advanceFallbacks).toEqual(["b.heic"]);
  });
});
