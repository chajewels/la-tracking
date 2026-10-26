import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPayslipPdf } from "@/lib/payslipPdf";
import {
  assertEarningsMatch, earningsRows, earningsTotal, footer, headerDetails, payslipNumber, paymentBlock,
  paymentNote, periodLabel, proofCaption, rightBlockLayout, signatureBlock,
} from "@/lib/payslipPdfLayout";
import { ADDRESS_EN, CORPORATE_NO, EMAIL, LEGAL_NAME_JA, NAME_EN, PHONE, REPRESENTATIVE } from "@/lib/companyInfo";
import { COMPANY_NAME, type Payslip } from "@/lib/payslips";

/** Corporate payslip PDF page 1 (owner 2026-10-27; docs/PAYSLIPS.md "Corporate PDF"). */

const TINY_PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

function payslip(over: Partial<Payslip> = {}): Payslip {
  return {
    id: "3fa2b9c1-0d4e-4a7b-9c2d-1e2f3a4b5c6d",
    user_id: "u1",
    pay_month: "2026-09-01",
    status: "finalized",
    staff_name: "Gay Marie Santos",
    address: "12 Rizal St, Quezon City",
    date_of_birth: "1995-03-14",
    job_title: "Customer Service Representative",
    template_type: "csr",
    timesheet: {
      days_worked: 24, total_hours: 192.5, daily_pay_sum: 14000, basic_salary: 15000, capped_gross: 14000,
      monthly_allowance: 2000, forfeited_weeks: 1, allowance_paid: 1500, net: 15500,
    },
    commission: { role_won: null, earnings: 0, top_sales_tier: 0, top_sales_bonus: 0, total: 0 },
    timesheet_net_php: 15500,
    commission_php: 0,
    total_php: 15500,
    jpy_sent: null,
    php_received: null,
    php_per_jpy: null,
    paid_on: null,
    proof_path: null,
    finalized_by: "a1b2c3d4-0000-4000-8000-000000000001",
    finalized_at: "2026-10-04T16:30:00Z", // 05 Oct 2026 01:30 in Japan
    paid_at: null,
    voided_at: null,
    void_reason: null,
    created_at: "2026-10-04T16:30:00Z",
    ...over,
  };
}

const PAID = {
  status: "paid" as const,
  jpy_sent: 39287,
  php_received: 16400,
  php_per_jpy: 0.417441,
  paid_on: "2026-10-05",
  proof_path: "3fa2b9c1-0d4e-4a7b-9c2d-1e2f3a4b5c6d/1730000000-bdo.png",
};

describe("payslip number and header details", () => {
  it("PS-YYYY-MM-XXXXXX from the pay month and the first 6 hex of the id, uppercase", () => {
    expect(payslipNumber(payslip())).toBe("PS-2026-09-3FA2B9");
    expect(payslipNumber(payslip({ id: "abcdef12-3456-4789-8abc-def012345678", pay_month: "2026-12-01" }))).toBe("PS-2026-12-ABCDEF");
  });

  it("the period is the month, never a 1–31 range", () => {
    expect(periodLabel(payslip())).toBe("September 2026");
  });

  it("headerDetails: Pay period, Payslip no., Issued (Japan time), Status — in that order", () => {
    expect(headerDetails(payslip())).toEqual([
      { label: "Pay period", value: "September 2026" },
      { label: "Payslip no.", value: "PS-2026-09-3FA2B9" },
      { label: "Issued", value: "05 Oct 2026" },
      { label: "Status", value: "Finalized" },
    ]);
    expect(headerDetails(payslip(PAID))[3]).toEqual({ label: "Status", value: "Paid" });
  });
});

describe("rightBlockLayout", () => {
  it("the title's last glyph and the details block end on the same right edge, letter-spacing included", () => {
    const glyphs = [14, 13, 13, 12, 11, 7, 12]; // P A Y S L I P
    const l = rightBlockLayout({
      right: 523.28, titleGlyphWidths: glyphs, letterSpacing: 4,
      labelWidths: [40, 45, 25, 28], valueWidths: [70, 92, 55, 38], gap: 10,
    });
    const titleWidth = glyphs.reduce((a, b) => a + b, 0) + 4 * (glyphs.length - 1);
    expect(l.titleX).toBeCloseTo(523.28 - titleWidth, 9);
    expect(l.titleRight).toBeCloseTo(523.28, 9);
    expect(l.blockRight).toBeCloseTo(523.28, 9);
    expect(l.titleRight).toBeCloseTo(l.blockRight, 9);
    // values start on one line, set by the widest value; labels end `gap` to its left
    expect(l.valueX).toBeCloseTo(523.28 - 92, 9);
    expect(l.labelRight).toBeCloseTo(l.valueX - 10, 9);
    expect(l.left).toBeCloseTo(Math.min(l.titleX, l.labelRight - 45), 9);
  });

  it("no trailing spacing: a wider spacing moves the first glyph left, never the last", () => {
    const a = rightBlockLayout({ right: 100, titleGlyphWidths: [10, 10], letterSpacing: 0, labelWidths: [], valueWidths: [], gap: 10 });
    const b = rightBlockLayout({ right: 100, titleGlyphWidths: [10, 10], letterSpacing: 8, labelWidths: [], valueWidths: [], gap: 10 });
    expect(a.titleRight).toBe(100);
    expect(b.titleRight).toBe(100);
    expect(b.titleX).toBe(a.titleX - 8);
  });
});

describe("earnings rows", () => {
  it("CSR not capped: daily pay, cap 'not reached' (—), allowance; sums to total", () => {
    const p = payslip();
    const rows = earningsRows(p);
    expect(rows).toEqual([
      { label: "Daily pay earned", details: "24 days · 192.5 hrs", amount: 14000, amountText: "₱14,000" },
      { label: "Basic salary cap", details: "₱15,000 — not reached", amount: null, amountText: "—" },
      { label: "Allowance", details: "₱2,000 monthly · 1 week forfeited", amount: 1500, amountText: "₱1,500" },
    ]);
    expect(earningsTotal(rows)).toBe(p.total_php);
    expect(() => assertEarningsMatch(rows, p.total_php)).not.toThrow();
  });

  it("CSR capped: a negative cap row brings the daily pay down to the basic salary", () => {
    const p = payslip({
      timesheet: {
        days_worked: 27, total_hours: 230, daily_pay_sum: 16200.5, basic_salary: 15000, capped_gross: 15000,
        monthly_allowance: 2000, forfeited_weeks: 0, allowance_paid: 2000, net: 17000,
      },
      timesheet_net_php: 17000, total_php: 17000,
    });
    const rows = earningsRows(p);
    expect(rows[1]).toEqual({ label: "Basic salary cap", details: "Capped at ₱15,000", amount: -1200.5, amountText: "-₱1,200.50" });
    expect(rows[2].details).toBe("₱2,000 monthly · 0 weeks forfeited");
    expect(earningsTotal(rows)).toBe(17000);
    expect(() => assertEarningsMatch(rows, p.total_php)).not.toThrow();
  });

  it("Live Admin: full days × ₱500, half days × ₱300, and a total-hours line", () => {
    const p = payslip({
      template_type: "live_admin",
      job_title: "Live Admin",
      timesheet: { days_at_500: 20, days_at_300: 3, total_hours: 150.25, net: 10900 },
      timesheet_net_php: 10900, total_php: 10900,
    });
    const rows = earningsRows(p);
    expect(rows).toEqual([
      { label: "Full days", details: "20 × ₱500", amount: 10000, amountText: "₱10,000" },
      { label: "Half days", details: "3 × ₱300", amount: 900, amountText: "₱900" },
      { label: "Hours", details: "Total hours 150.25", amount: null, amountText: "" },
    ]);
    expect(() => assertEarningsMatch(rows, p.total_php)).not.toThrow();
  });

  it("commission rows: hidden at 0; Top Sales only when tier > 0; rows still sum to total", () => {
    expect(earningsRows(payslip()).some(r => r.label === "Commission")).toBe(false);

    const noTier = payslip({
      commission: { role_won: "Closer", earnings: 3200.75, top_sales_tier: 0, top_sales_bonus: 0, total: 3200.75 },
      commission_php: 3200.75, total_php: 18700.75,
    });
    const r1 = earningsRows(noTier);
    expect(r1.find(r => r.label === "Commission")).toEqual({ label: "Commission", details: "Role won: Closer", amount: 3200.75, amountText: "₱3,200.75" });
    expect(r1.some(r => r.label.startsWith("Top Sales"))).toBe(false);
    expect(() => assertEarningsMatch(r1, noTier.total_php)).not.toThrow();

    const tier2 = payslip({
      commission: { role_won: null, earnings: 1000, top_sales_tier: 2, top_sales_bonus: 500, total: 1500 },
      commission_php: 1500, total_php: 17000,
    });
    const r2 = earningsRows(tier2);
    expect(r2.find(r => r.label === "Commission")?.details).toBe("Role won: —");
    expect(r2.find(r => r.label === "Top Sales 2 bonus")?.amount).toBe(500);
    expect(earningsTotal(r2)).toBe(17000);
  });

  it("rows that do not add up to total_php refuse to draw", () => {
    const rows = earningsRows(payslip());
    expect(() => assertEarningsMatch(rows, 15500.01)).toThrow("earnings_mismatch");
  });
});

describe("payment block, payment note, signatures, footer", () => {
  it("finalized: Not paid yet, no payment line", () => {
    expect(paymentBlock(payslip())).toEqual({ paid: false, rows: [], note: "Not paid yet" });
    expect(paymentNote(payslip(), null)).toBeNull();
  });

  it("paid: paid on, yen, pesos, rate; difference only when pesos differ from the total", () => {
    const same = paymentBlock(payslip({ ...PAID, php_received: 15500 }));
    expect(same.paid && same.rows.map(r => r.label)).toEqual(["Paid on", "Yen sent", "Pesos received", "Rate used (₱ per ¥1)"]);

    const diff = paymentBlock(payslip(PAID));
    expect(diff.paid && diff.rows).toEqual([
      { label: "Paid on", value: "5 Oct 2026" },
      { label: "Yen sent", value: "¥39,287" },
      { label: "Pesos received", value: "₱16,400" },
      { label: "Rate used (₱ per ¥1)", value: "0.417441" },
      { label: "Difference vs payslip total", value: "₱900" },
    ]);
  });

  it("payment note names page 2, or says the proof could not be included", () => {
    expect(paymentNote(payslip(PAID), true)).toBe("September 2026 salary ¥39,287 → ₱16,400 · Proof of payment attached (page 2)");
    expect(paymentNote(payslip(PAID), false)).toBe("September 2026 salary ¥39,287 → ₱16,400 · Proof of payment could not be included");
  });

  it("signatures: Prepared by (finalizer, blank when unknown — never an id) · Approved by · Received by", () => {
    expect(signatureBlock(payslip(), "Brendalyn Bumagat")).toEqual([
      { label: "Prepared by", name: "Brendalyn Bumagat" },
      { label: "Approved by", name: "Cynthia Nera Largo, Representative Director" },
      { label: "Received by", name: "Staff signature and date" },
    ]);
    expect(signatureBlock(payslip(), null)[0].name).toBe("");
    expect(signatureBlock(payslip(), "  ")[0].name).toBe("");
    expect(signatureBlock(payslip(), "a1b2c3d4-0000-4000-8000-000000000001")[0].name).toBe("");
  });

  it("footer: confidential + Page 1 of N, and no 'Generated' line", () => {
    const f = footer(3);
    expect(f).toEqual({ left: "Confidential — for the named recipient only.", right: "Page 1 of 3" });
    expect(`${f.left} ${f.right}`).not.toMatch(/generated/i);
  });

  it("image-proof caption carries the company and the payslip number", () => {
    expect(proofCaption("PS-2026-09-3FA2B9", "1730000000-bdo.png", "2026-10-05"))
      .toBe("Cha Jewels Co., Ltd. — Proof of payment — PS-2026-09-3FA2B9 — 1730000000-bdo.png — paid on 5 Oct 2026");
  });
});

describe("page 1 is drawn last, with the final page count", () => {
  it("renderPage1 receives 1 + proof pages and whether the proof made it in", async () => {
    const seen: [number, boolean | null][] = [];
    const render = async (n: number, inc: boolean | null) => { seen.push([n, inc]); return TINY_PNG; };
    await buildPayslipPdf({ renderPage1: render, proof: null, paidOn: null });
    await buildPayslipPdf({ renderPage1: render, proof: { bytes: TINY_PNG, contentType: "image/png", fileName: "a.png" }, paidOn: "2026-10-05", payslipNo: "PS-2026-09-3FA2B9" });
    await buildPayslipPdf({ renderPage1: render, proof: { bytes: new Uint8Array([1]), contentType: "image/heic", fileName: "a.heic" }, paidOn: "2026-10-05", convertImage: async () => null });
    expect(seen).toEqual([[1, null], [2, true], [2, false]]);
  });
});

describe("company constants and the badge", () => {
  it("LEGAL_NAME_JA is exactly Ｃｈａ　Ｊｅｗｅｌｓ株式会社 (full-width, ideographic space)", () => {
    expect(Array.from(LEGAL_NAME_JA).map(c => c.codePointAt(0)!.toString(16).toUpperCase())).toEqual([
      "FF23", "FF48", "FF41", "3000", "FF2A", "FF45", "FF57", "FF45", "FF4C", "FF53", "682A", "5F0F", "4F1A", "793E",
    ]);
    expect(COMPANY_NAME).toBe(LEGAL_NAME_JA);
    expect(NAME_EN).toBe("Cha Jewels Co., Ltd.");
    expect(ADDRESS_EN).toBe("Time Mansion 301, 6-5-1 Tateishi, Katsushika-ku, Tokyo 124-0012, Japan");
    expect([PHONE, EMAIL, CORPORATE_NO]).toEqual(["03-6657-6129", "sales@chajewelsjp.com", "7011801044120"]);
    expect(REPRESENTATIVE).toBe("Cynthia Nera Largo, Representative Director");
  });

  it("the PDF uses the website badge, never the Hub's 'Japan Gold' logo, and prints no 'Generated by' line", () => {
    const src = readFileSync(resolve(__dirname, "../lib/payslipPdf.ts"), "utf8");
    const layout = readFileSync(resolve(__dirname, "../lib/payslipPdfLayout.ts"), "utf8");
    expect(src).toContain("import badgeUrl from '@/assets/brand/cha-jewels-badge-512.webp';");
    expect(src).not.toContain("cha-jewels-logo.jpeg");
    expect(`${src}\n${layout}`).not.toMatch(/Generated by/);
  });
});
