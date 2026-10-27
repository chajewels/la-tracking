import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { computeMonth, type TimesheetEntry, type TimesheetProfile, type MonthComputation } from "@/lib/timesheetEngine";
import { computeMonth as computeCommissionMonth, type CommissionSplit, type SaleRow } from "@/lib/commissionEngine";
import {
  COMPANY_NAME, actualRate, buildCommissionFigures, buildFigures, buildTimesheetFigures, canIssueForMonth,
  commissionLines, currentPayslip, defaultYenSent, detailsComplete, figuresChanged, finalizePayload, findAgentResult,
  formatPeso, longMonthLabel, normaliseBook, paymentLine, payslipFileName, proofFileName, payslipRefusal, payslipRows, payslipTitle, payslipWorkbook,
  proofContentType, proofPath, proofProblem, timesheetLines, validateDetails, validatePayment, type Payslip,
} from "@/lib/payslips";

/**
 * Timesheet → Payslips (owner-confirmed plan 2026-10-26; migration 20270201100000_staff_payslips.sql).
 * The tab's rules: figures from the two engines, totals that finalize_payslip accepts, the one
 * currency rule (divide), the actual remittance rate, the proof path, Excel from stored figures,
 * and the page wiring (admin + can_view_all only).
 */

function profile(over: Partial<TimesheetProfile>): TimesheetProfile {
  return {
    id: "p", user_id: "u", template_type: "csr", job_title: "CSR", timezone: "Asia/Manila",
    work_days: [1, 2, 3, 4, 5, 6], shift_start: null, shift_end: null, basic_salary: 12000, allowance: 2000,
    half_day_rate: null, full_day_rate: null, full_day_threshold_hours: null, dayoff_divisor: 4, active: true,
    ...over,
  };
}

/** A punch day in Manila time: in at `from`, 1-hour break at 12:00, out at `to` (hours, local). */
function day(date: string, from: number, to: number): TimesheetEntry {
  const iso = (h: number) => new Date(`${date}T${String(h).padStart(2, "0")}:00:00+08:00`).toISOString();
  return { work_date: date, am_in: iso(from), am_out: iso(12), pm_in: iso(13), pm_out: iso(to) };
}

function slip(over: Partial<Payslip>): Payslip {
  return {
    id: "11111111-1111-1111-1111-111111111111", user_id: "u", pay_month: "2026-09-01", status: "finalized",
    staff_name: "Kaila Cruz", address: "12 Rizal St, Quezon City", date_of_birth: "1995-03-14", job_title: "CSR",
    template_type: "csr",
    timesheet: { days_worked: 22, total_hours: 176.5, daily_pay_sum: 12400, basic_salary: 12000, capped_gross: 12000,
      monthly_allowance: 2000, forfeited_weeks: 1, allowance_paid: 1500, net: 13500 },
    commission: { role_won: "Closer", earnings: 2500.5, top_sales_tier: 1, top_sales_bonus: 500, total: 3000.5 },
    timesheet_net_php: 13500, commission_php: 3000.5, total_php: 16500.5,
    jpy_sent: null, php_received: null, php_per_jpy: null, paid_on: null, proof_path: null,
    finalized_at: "2026-10-01T00:00:00Z", paid_at: null, voided_at: null, void_reason: null,
    created_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

describe("payslips — money", () => {
  it("yen to send DIVIDES pesos by the rate (CLAUDE.md currency standard)", () => {
    expect(defaultYenSent(10000, 0.42)).toBe(23810);
    expect(defaultYenSent(10000, 0.42)).not.toBe(4200);
    expect(defaultYenSent(16500.5, 0.42)).toBe(39287);
    expect(defaultYenSent(10000, null)).toBeNull();
    expect(defaultYenSent(0, 0.42)).toBeNull();
  });

  it("stores the actual remittance rate: pesos received per yen sent, 6 decimals", () => {
    expect(actualRate(16400, 39287)).toBe(0.417441);
    expect(actualRate(0, 39287)).toBeNull();
    expect(actualRate(16400, 0)).toBeNull();
  });

  it("formats pesos the Hub way (no .00 on whole numbers)", () => {
    expect(formatPeso(13500)).toBe("₱13,500");
    expect(formatPeso(3000.5)).toBe("₱3,000.50");
  });
});

describe("payslips — timesheet figures", () => {
  it("CSR: capped gross + allowance = net, daily-pay sum before the cap", () => {
    const entries: TimesheetEntry[] = [];
    for (let d = 1; d <= 30; d++) entries.push(day(`2026-09-${String(d).padStart(2, "0")}`, 9, 18)); // 8h every day
    entries.push(day("2026-10-01", 9, 18)); // spillover row of the 31-row window
    const p = profile({});
    const m = computeMonth("2026-09", entries, p);
    const f = buildTimesheetFigures("csr", m, p);
    if (!("days_worked" in f)) throw new Error("csr figures expected");
    expect(f.days_worked).toBe(30); // in-month rows only
    expect(f.daily_pay_sum).toBeGreaterThan(f.capped_gross);
    expect(f.capped_gross).toBe(12000);
    expect(f.basic_salary).toBe(12000);
    expect(f.monthly_allowance).toBe(2000);
    expect(f.net).toBe(f.capped_gross + f.allowance_paid);
    expect(f.total_hours).toBe(248); // all 31 rows count
  });

  it("Live Admin: 500 × days at ₱500 + 300 × days at ₱300 = net (the whole 31-row window)", () => {
    const entries = [day("2026-09-01", 9, 18), day("2026-09-02", 9, 15), day("2026-09-03", 11, 14), day("2026-10-01", 9, 18)];
    const p = profile({ template_type: "live_admin", basic_salary: null, allowance: null });
    const m = computeMonth("2026-09", entries, p);
    const f = buildTimesheetFigures("live_admin", m, p);
    expect(f).toEqual({ days_at_500: 3, days_at_300: 1, total_hours: 23, net: 1800 });
    expect(f.net).toBe(m.net);
  });

  it("lines carry every CSR item and the Live Admin tiers", () => {
    const csr = timesheetLines("csr", slip({}).timesheet).map(l => l.label);
    expect(csr).toEqual(["Days worked", "Total hours", "Sum of daily pay (before cap)", "Basic salary cap",
      "Gross pay (capped)", "Monthly allowance", "Weeks forfeited (allowance)", "Allowance paid", "Timesheet net pay"]);
    const la = timesheetLines("live_admin", { days_at_500: 3, days_at_300: 1, total_hours: 21, net: 1800 });
    expect(la.map(l => l.value)).toEqual(["3", "1", "21", "₱1,800"]);
  });
});

describe("payslips — commission figures", () => {
  const split: CommissionSplit = {
    month: "2026-01-01", closer_pct: 40, processor_pct: 20, coordinator_pct: 15, support_pct: 10, verifier_pct: 5,
    top_sales_pct: 5, top_sales_2_pct: 5, merge_groups: [], pool_per_item_php: 1000,
  };
  const sale = (id: string, closer: string): SaleRow => ({
    id, sale_date: "2026-09-10", item_code: id, invoice_number: id, item_amount: 50000, client_name: id,
    closer, processor: closer, coordinator: closer, support: closer, verifier: closer, status: "Paid", channel: "Chat",
    source: "Facebook", opened_in_chat: true, closed_in_chat: true, eligible: true, notes: null,
  });

  it("matches the agent by name (from commission_agents.user_id) and sums earnings + Top Sales bonus", () => {
    const comp = computeCommissionMonth("2026-09", [sale("a", "Kaila"), sale("b", "Kaila"), sale("c", "Gayle")], [split]);
    const agent = findAgentResult(comp, " kaila ");
    expect(agent).not.toBeNull();
    const c = buildCommissionFigures(comp, agent);
    expect(c.top_sales_tier).toBe(1);
    expect(c.top_sales_bonus).toBe(150); // 5% of a ₱3,000 pool
    expect(c.total).toBe(c.earnings + c.top_sales_bonus);
    const second = buildCommissionFigures(comp, findAgentResult(comp, "Gayle"));
    expect(second.top_sales_tier).toBe(2);
  });

  it("an unlinked staff member gets ₱0 and 'No commission this month'", () => {
    const comp = computeCommissionMonth("2026-09", [sale("a", "Kaila")], [split]);
    const c = buildCommissionFigures(comp, findAgentResult(comp, null));
    expect(c).toEqual({ role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 });
    expect(commissionLines(c as unknown as Record<string, unknown>)).toEqual([{ label: "Commission", value: "No commission this month" }]);
  });

  it("the payload total is timesheet net + commission (finalize_payslip refuses anything else)", () => {
    const f = buildFigures(
      { days_at_500: 3, days_at_300: 1, total_hours: 21, net: 1800 },
      { role_won: "Closer", earnings: 1200.25, top_sales_tier: 0, top_sales_bonus: 0, total: 1200.25 },
    );
    expect(f.total_php).toBe(3000.25);
    const payload = finalizePayload(f);
    expect(Object.keys(payload).sort()).toEqual(["commission", "commission_php", "timesheet", "timesheet_net_php", "total_php"]);
    expect(payload).not.toHaveProperty("staff_name"); // the server copies staff details itself
  });

  it("warns only when the live total moved", () => {
    expect(figuresChanged(16500.5, 16500.5)).toBe(false);
    expect(figuresChanged(16500.5, 16500.504)).toBe(false);
    expect(figuresChanged(16500.5, 16600)).toBe(true);
  });
});

describe("payslips — forms and files", () => {
  it("payment form: whole yen, 2-decimal pesos, paid on between the pay month and today", () => {
    const ok = { jpySent: "39287", phpReceived: "16400.50", paidOn: "2026-10-05" };
    expect(validatePayment(ok, "2026-09-01", "2026-10-26")).toBeNull();
    expect(validatePayment({ ...ok, jpySent: "392.5" }, "2026-09-01", "2026-10-26")).toMatch(/whole number/);
    expect(validatePayment({ ...ok, jpySent: "0" }, "2026-09-01", "2026-10-26")).toMatch(/whole number/);
    expect(validatePayment({ ...ok, phpReceived: "1.234" }, "2026-09-01", "2026-10-26")).toMatch(/pesos/);
    expect(validatePayment({ ...ok, paidOn: "2026-10-27" }, "2026-09-01", "2026-10-26")).toMatch(/future/);
    expect(validatePayment({ ...ok, paidOn: "2026-08-31" }, "2026-09-01", "2026-10-26")).toMatch(/before the pay month/);
  });

  it("staff details: address ≤ 500, date of birth 1900..today", () => {
    expect(validateDetails("Manila", "1995-03-14", "2026-10-26")).toBeNull();
    expect(validateDetails("x".repeat(501), "", "2026-10-26")).toMatch(/500/);
    expect(validateDetails("Manila", "1899-12-31", "2026-10-26")).toMatch(/1900/);
    expect(validateDetails("Manila", "2026-10-27", "2026-10-26")).toMatch(/future/);
    expect(detailsComplete({ user_id: "u", address: "Manila", date_of_birth: "1995-03-14" })).toBe(true);
    expect(detailsComplete({ user_id: "u", address: " ", date_of_birth: "1995-03-14" })).toBe(false);
    expect(detailsComplete(null)).toBe(false);
  });

  it("proof path is <payslip_id>/<file> with no '..'", () => {
    const p = proofPath("abc", "../../GCash receipt.jpg", 1730000000000);
    expect(p.startsWith("abc/1730000000000-")).toBe(true);
    expect(p).not.toContain("..");
    expect(proofContentType({ type: "", name: "IMG_1.HEIC" })).toBe("image/heic");
    expect(proofProblem(null)).toMatch(/Attach/);
    expect(proofProblem({ type: "text/plain", size: 10, name: "a.txt" })).toMatch(/photo/);
    expect(proofProblem({ type: "application/pdf", size: 11 * 1024 * 1024 })).toMatch(/10 MB/);
    expect(proofProblem({ type: "image/png", size: 1000 })).toBeNull();
  });

  it("refusals are plain English, never raw codes", () => {
    for (const code of ["permission_denied", "already_issued", "details_missing", "invalid_totals", "proof_missing", "nonsense"]) {
      const msg = payslipRefusal(code);
      expect(msg).not.toMatch(/_/);
      expect(msg.length).toBeGreaterThan(10);
    }
    expect(payslipRefusal("details_missing")).toBe("Add employee ID, address and date of birth first.");
  });

  it("months: titles, and nothing before June 2026", () => {
    expect(longMonthLabel("2026-09")).toBe("September 2026");
    expect(payslipTitle("2026-09-01")).toBe("Payslip — September 2026");
    expect(canIssueForMonth("2026-05")).toBe(false);
    expect(canIssueForMonth("2026-06")).toBe(true);
  });

  it("a row shows the live payslip, else the latest void one", () => {
    const v1 = slip({ id: "v1", status: "void", created_at: "2026-10-01T00:00:00Z" });
    const v2 = slip({ id: "v2", status: "void", created_at: "2026-10-02T00:00:00Z" });
    const live = slip({ id: "l", status: "paid", created_at: "2026-10-03T00:00:00Z" });
    expect(currentPayslip([v1, live, v2], "u")?.id).toBe("l");
    expect(currentPayslip([v1, v2], "u")?.id).toBe("v2");
    expect(currentPayslip([v1], "other")).toBeNull();
  });

  it("normalises the book's numeric strings", () => {
    const b = normaliseBook({ month: "2026-09-01", php_jpy_rate: "0.42",
      payslips: [{ ...slip({}), total_php: "16500.50", jpy_sent: null }], details: [{ user_id: "u", address: null, date_of_birth: null }] });
    expect(b.php_jpy_rate).toBe(0.42);
    expect(b.payslips[0].total_php).toBe(16500.5);
    expect(b.details[0]).toMatchObject({ user_id: "u", address: null, date_of_birth: null });
  });
});

describe("payslips — Excel", () => {
  it("proof file name and payment line", () => {
    expect(proofFileName("abc/1730000000-a/b.jpg")).toBe("1730000000-a/b.jpg");
    expect(proofFileName(null)).toBe("");
    expect(paymentLine(slip({}))).toBe("Not paid yet");
    expect(paymentLine(slip({ jpy_sent: 39287, php_received: 16400 }))).toBe("September 2026 salary ¥39,287 → ₱16,400");
  });

  it("file name keeps letters, digits and _ only", () => {
    expect(payslipFileName("Gay Marie Dela Cruz", "2026-09-01")).toBe("Payslip_Gay_Marie_Dela_Cruz_2026-09.xlsx");
    expect(payslipFileName("Richell Ñoño (CSR)", "2026-09-01")).toBe("Payslip_Richell_Nono_CSR_2026-09.xlsx");
    expect(payslipFileName("***", "2026-09-01")).toBe("Payslip_Staff_2026-09.xlsx");
  });

  it("rows come from the stored figures, with the payment once paid", () => {
    const paid = slip({ status: "paid", jpy_sent: 39287, php_received: 16400, php_per_jpy: 0.417441, paid_on: "2026-10-05",
      proof_path: "11111111-1111-1111-1111-111111111111/1730000000-BDO remittance.pdf" });
    const rows = payslipRows(paid, "2026-10-26");
    const flat = rows.map(r => r.join(" | "));
    expect(rows[0]).toEqual([COMPANY_NAME]);
    expect(COMPANY_NAME).toBe("Ｃｈａ　Ｊｅｗｅｌｓ株式会社");
    expect(rows[1]).toEqual(["Payslip — September 2026"]);
    expect(flat).toContain("Staff name | Kaila Cruz");
    expect(flat).toContain("Date of birth | 14 Mar 1995");
    expect(flat).toContain("Total | ₱16,500.50");
    expect(flat).toContain("September 2026 salary ¥39,287 → ₱16,400 | ");
    expect(flat).toContain("Yen sent | ¥39,287");
    expect(flat).toContain("Proof of payment | 1730000000-BDO remittance.pdf");
    expect(flat.indexOf("Paid on | 5 Oct 2026")).toBeLessThan(flat.indexOf("Proof of payment | 1730000000-BDO remittance.pdf"));
    expect(flat).toContain("Rate used (₱ per ¥1) | 0.417441");
    expect(flat).toContain("Difference vs payslip total | -₱100.50");
    expect(flat).toContain("Status | Paid");
    expect(flat).toContain("Generated | 26 Oct 2026");
    expect(payslipRows(slip({}), "2026-10-26").map(r => r.join(" | "))).toContain("Not paid yet");
  });

  it("the workbook round-trips through SheetJS", () => {
    const wb = payslipWorkbook(slip({}), "2026-10-26");
    const back = XLSX.read(XLSX.write(wb, { type: "array", bookType: "xlsx" }), { type: "array" });
    const aoa = XLSX.utils.sheet_to_json<string[]>(back.Sheets.Payslip, { header: 1 });
    expect(aoa[0][0]).toBe(COMPANY_NAME);
    expect(aoa.some(r => r[0] === "Timesheet net pay" && r[1] === "₱13,500")).toBe(true);
  });
});

describe("payslips — page wiring", () => {
  const page = readFileSync("src/pages/Timesheet.tsx", "utf8");
  const tab = readFileSync("src/components/timesheet/PayslipsTab.tsx", "utf8");
  const sql = readFileSync("supabase/migrations/20270201100000_staff_payslips.sql", "utf8");

  it("the Payslips tab is admin + can_view_all only (the Cost Master gate), with a guard redirect", () => {
    expect(page).toContain("if (v === 'payslips' && !canViewCost) return defaultTab;");
    expect(page).toContain('{canViewCost && <TabsTrigger value="payslips">Payslips</TabsTrigger>}');
    expect(page).toMatch(/\{canViewCost && \(\s*<TabsContent value="payslips"/);
    expect(page).toContain("const canViewCost = isAdmin || canViewAll;");
  });

  it("the tab waits for the migration, signs proofs for 10 minutes, uploads before the RPC", () => {
    expect(tab).toContain("Waiting for the database update");
    expect(tab).toContain("createSignedUrl(path, 600)");
    expect(tab.indexOf(".upload(path, file")).toBeLessThan(tab.indexOf("callRpc('record_payslip_payment'"));
    expect(tab).not.toMatch(/\.from\('payslips'\)\.(insert|update|delete|upsert)/);
  });

  it("the migration gates every RPC and has no write policies", () => {
    for (const fn of ["get_payslip_book", "save_staff_payroll_details", "finalize_payslip", "record_payslip_payment", "void_payslip"]) {
      const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`));
      expect(body.slice(0, 1500)).toContain("IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied')");
    }
    expect(sql).not.toMatch(/CREATE POLICY [^;]*FOR (INSERT|UPDATE|DELETE|ALL)[^;]*ON public\./);
    expect(sql).toContain("value #>> '{}'");
  });
});
