import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  COMPANY_NAME_JA, JOURNAL_CSV_HEADER, STATEMENT_CSV_HEADER, TRIAL_BALANCE_CSV_HEADER,
  bsGroups, bsSectionTotal, cfSectionLines, deltaPctLabel, exportFileName, fiscalYearSpan, flaggedLines, isMonthAligned, journalCsvRows,
  normaliseJournalExport, normaliseStatements, parseTaxPackParams, pctLabel, rangeLabel, signedYen, statementCsvRows, statementRange, statementRefusal,
  taxPackHref, trialBalanceCsvRows, validateFlags,
} from "@/components/finance/statements";
import { CSV_BOM, csvText, toCsv } from "@/lib/csv";
import { normaliseAccounts, sourceTypeLabel } from "@/components/finance/ledger";

/**
 * Statements + 税理士 pack (Expenses Phase 7, owner 2026-10-26 D1–D6): range helpers (YTD, comparison labels),
 * the Δ / flag presentation, CSV builders with the UTF-8 BOM, the normalisers, and the wiring (tab, route, print,
 * page breaks, permission map, name_ja).
 */

describe("statements — ranges", () => {
  it("YTD runs from 1 April to the end of the chosen month (April–March year)", () => {
    expect(statementRange("ytd", "2026-10", 4)).toEqual({ from: "2026-04-01", to: "2026-10-31", label: "FY2027 to October 2026" });
    expect(statementRange("ytd", "2026-04", 4)).toEqual({ from: "2026-04-01", to: "2026-04-30", label: "FY2027 to April 2026" });
    expect(statementRange("ytd", "2027-03", 4)).toEqual({ from: "2026-04-01", to: "2027-03-31", label: "FY2027 to March 2027" });
    expect(statementRange("ytd", "2026-02", 4).from).toBe("2025-04-01");
  });
  it("month / quarter / FY are the ledger's own ranges", () => {
    expect(statementRange("month", "2026-09", 4)).toEqual({ from: "2026-09-01", to: "2026-09-30", label: "September 2026" });
    expect(statementRange("quarter", "2026-10", 4)).toMatchObject({ from: "2026-10-01", to: "2026-12-31", label: "Q3 FY2027" });
    expect(statementRange("fy", "2026-10", 4)).toMatchObject({ from: "2026-04-01", to: "2027-03-31" });
  });
  it("comparison column labels", () => {
    expect(rangeLabel("2026-07-01", "2026-07-31")).toBe("Jul 2026");
    expect(rangeLabel("2026-06-01", "2026-07-31")).toBe("Jun – Jul 2026");
    expect(rangeLabel("2025-10-01", "2026-03-31")).toBe("Oct 2025 – Mar 2026");
  });
  it("month alignment decides how the prior period is built", () => {
    expect(isMonthAligned("2026-07-01", "2026-09-30")).toBe(true);
    expect(isMonthAligned("2026-02-01", "2026-02-28")).toBe(true);
    expect(isMonthAligned("2026-07-05", "2026-09-30")).toBe(false);
    expect(isMonthAligned("2026-07-01", "2026-09-29")).toBe(false);
  });
  it("tax pack link and its parameters", () => {
    expect(taxPackHref("2026-07-01", "2026-09-30")).toBe("/finance/tax-pack?from=2026-07-01&to=2026-09-30");
    expect(parseTaxPackParams("?from=2026-07-01&to=2026-09-30", "2026-10")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(parseTaxPackParams("", "2026-10")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(parseTaxPackParams("?from=2026-09-30&to=2026-07-01", "2026-10")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(parseTaxPackParams("?from=nope&to=2026-09-30", "2026-01")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("file names carry the period", () => {
    expect(exportFileName("journals", "2026-07-01", "2026-07-31")).toBe("journals-2026-07");
    expect(exportFileName("journals", "2026-07-01", "2026-09-30")).toBe("journals-2026-07-01-2026-09-30");
    expect(exportFileName("trial-balance", "2026-07-05", "2026-07-31")).toBe("trial-balance-2026-07-05-2026-07-31");
  });
  it("fiscal year span label", () => {
    expect(fiscalYearSpan(4)).toBe("April – March");
    expect(fiscalYearSpan(1)).toBe("January – December");
    expect(fiscalYearSpan(99)).toBe("April – March");
  });
});

describe("statements — presentation", () => {
  it("Δ %, signed yen, margins", () => {
    expect(deltaPctLabel(null)).toBe("—");
    expect(deltaPctLabel(12.5)).toBe("+12.5 %");
    expect(deltaPctLabel(-100)).toBe("−100 %");
    expect(deltaPctLabel(0)).toBe("0 %");
    expect(signedYen(null)).toBe("—");
    expect(signedYen(0)).toBe("¥0");
    expect(signedYen(12000)).toBe("+¥12,000");
    expect(signedYen(-3000.4)).toBe("−¥3,000");
    expect(pctLabel(42.34)).toBe("42.3 %");
    expect(pctLabel(null)).toBe("—");
  });
  it("threshold validation mirrors set_statement_flags", () => {
    expect(validateFlags("15", "100000")).toBeNull();
    expect(validateFlags("2.5", "1,000")).toBeNull();
    expect(validateFlags("15", "¥100,000")).toBeNull();
    expect(validateFlags("15.55", "100000")).toMatch(/one decimal/);
    expect(validateFlags("-1", "100000")).toMatch(/0–1000/);
    expect(validateFlags("", "100000")).toMatch(/Percent/);
    expect(validateFlags("15", "")).toMatch(/Yen/);
  });
  it("refusal codes", () => {
    expect(statementRefusal("invalid_pct")).toMatch(/one decimal/);
    expect(statementRefusal("invalid_range")).toMatch(/three years/);
    expect(statementRefusal("invalid_name_ja")).toMatch(/60/);
    expect(statementRefusal("permission_denied")).toBeNull();
  });
  it("company name is the registered full-width name", () => {
    expect(COMPANY_NAME_JA).toBe("Ｃｈａ　Ｊｅｗｅｌｓ株式会社");
  });
});

const raw = {
  from: "2026-08-01", to: "2026-09-30", ledger_start: "2026-06-01", today: "2026-10-26", fiscal_year_start_month: "4", fiscal_year_start: "2026-04-01",
  journal_count: "12", rate: "0.42", flags: { pct: "15", jpy: "100000" },
  comparisons: { prior: { from: "2026-06-01", to: "2026-07-31", available: true }, prior_year: { from: "2025-08-01", to: "2025-09-30", available: false } },
  income_statement: {
    lines: [
      { key: "sales", section: "revenue", label: "Sales", label_ja: "売上高", level: 1, cur: "83810", prior: "219048", prior_year: null, delta: "-135238", delta_pct: "-61.7", flag: true },
      { key: "sales_export", section: "revenue", label: "export", label_ja: "輸出売上高", level: 2, cur: "23810", prior: "119048", prior_year: null, delta: "-95238", delta_pct: "-80", flag: false },
      { key: "revenue_total", section: "revenue", label: "Operating revenue", label_ja: "営業収益", level: 0, cur: "83810", prior: "219048", prior_year: null, delta: "-135238", delta_pct: "-61.7", flag: true },
      { key: "sga_marketing", section: "sga", label: "Marketing", label_ja: "広告宣伝費", level: 1, cur: "30000", prior: "0", prior_year: null, delta: "30000", delta_pct: null, flag: false },
      { key: "net_profit", section: "nonop", label: "Net profit", label_ja: "当期純利益", level: 0, cur: "53810", prior: "214048", prior_year: null, delta: "-160238", delta_pct: "-74.9", flag: true },
    ],
    gross_margin_pct: "100", operating_margin_pct: "64.2",
  },
  balance_sheet: {
    as_of: "2026-09-30", prior_as_of: "2026-07-31",
    lines: [
      { key: "1101", code: "1101", label: "SMBC", label_ja: "普通預金 三井住友", kind: "asset", contra: false, section: "current_assets", group: "cash", cur: "1165000", prior: "1185000" },
      { key: "1111", code: "1111", label: "BDO", label_ja: "普通預金 BDO", kind: "asset", contra: false, section: "current_assets", group: "cash", cur: "71429", prior: "47619" },
      { key: "1200", code: "1200", label: "Layaway receivable", label_ja: "売掛金（分割払い）", kind: "asset", contra: false, section: "current_assets", group: "receivables", cur: "121429", prior: "131429" },
      { key: "1500", code: "1500", label: "Equipment", label_ja: "工具器具備品", kind: "asset", contra: false, section: "fixed_assets", group: "fixed_assets", cur: "50000", prior: "50000" },
      { key: "3000", code: "3000", label: "Share capital", label_ja: "資本金", kind: "equity", contra: false, section: "equity", group: "equity", cur: "1000000", prior: "1000000" },
      { key: "current_fy_profit", code: null, label: "Profit of the current fiscal year to date", label_ja: "当期純利益（期首から）", kind: "equity", contra: false, section: "equity", group: "equity", cur: "267858", prior: "214048" },
    ],
    totals: { assets: "1547858", liabilities: "280000", equity: "1267858", check: "0", prior_assets: "1", prior_liabilities: "2", prior_equity: "3", prior_check: "0" },
  },
  cash_flow: {
    lines: [
      { key: "net_profit", section: "operating", label: "Net profit", label_ja: "当期純利益", amount: "53810" },
      { key: "d_receivables", section: "operating", label: "Receivables", label_ja: "売掛金", amount: "10000" },
      { key: "d_equipment", section: "investing", label: "Equipment", label_ja: "備品", amount: "0" },
      { key: "d_loans", section: "financing", label: "Loans", label_ja: "借入金", amount: "0" },
    ],
    net_change: "63810", cash_open: "1232619", cash_close: "1296429", actual_change: "63810", difference: "0", unrealised_fx_on_cash: "0",
  },
  ageing: {
    as_of: "2026-09-30", rate: "0.42", basis: "current_open_lines_aged_at_date",
    layaway: { not_due: { plans: 1, lines: 2, php: "30000", jpy: 0, total_jpy: "71428" }, d1_30: { plans: 1, lines: 1, php: 0, jpy: "30000", total_jpy: "30000" } },
    cash_orders: { d31_60: { orders: 1, php: 0, jpy: "20000", total_jpy: "20000" } },
    forecast: { next_60: { lines: 1, php: "15000", jpy: 0, total_jpy: "35714" } },
    ledger: { layaway_jpy: "121429", orders_jpy: "0" },
  },
  currency_checks: { count: 1, rows: [{ kind: "layaway", id: "x", invoice_number: "LA-MIX", order_date: "2026-08-01", currency: "PHP", country: "Japan", amount: "10000" }] },
  outside_hub: [{ label: "Officer compensation", label_ja: "役員報酬" }, { label: "Statutory welfare", label_ja: "法定福利費" }],
};

describe("statements — normalisers and section helpers", () => {
  const s = normaliseStatements(raw);
  it("numbers become numbers, nulls stay null, missing buckets are zero", () => {
    expect(s.journal_count).toBe(12);
    expect(s.rate).toBe(0.42);
    expect(s.flags).toEqual({ pct: 15, jpy: 100000 });
    expect(s.income_statement.lines[0]).toMatchObject({ cur: 83810, prior: 219048, prior_year: null, delta: -135238, delta_pct: -61.7, flag: true });
    expect(s.income_statement.lines[3].delta_pct).toBeNull();
    expect(s.balance_sheet.totals.assets).toBe(1547858);
    expect(s.balance_sheet.lines[5].code).toBeNull();
    expect(s.ageing.layaway.d90p).toMatchObject({ php: 0, jpy: 0, total_jpy: 0 });
    expect(s.ageing.layaway.d90p.plans).toBeUndefined();
    expect(s.ageing.layaway.not_due.total_jpy).toBe(71428);
    expect(s.ageing.forecast.next_60.php).toBe(15000);
    expect(s.ageing.basis).toBe("current_open_lines_aged_at_date");
    expect(s.currency_checks.rows[0].amount).toBe(10000);
    expect(s.outside_hub[1].label_ja).toBe("法定福利費");
    expect(normaliseStatements({}).income_statement.lines).toEqual([]);
  });
  it("flagged lines exclude totals", () => {
    expect(flaggedLines(s.income_statement.lines).map((l) => l.key)).toEqual(["sales"]);
  });
  it("balance sheet groups and totals", () => {
    const groups = bsGroups(s.balance_sheet.lines, "current_assets");
    expect(groups.map((g) => g.group)).toEqual(["cash", "receivables"]);
    expect(groups[0].cur).toBe(1165000 + 71429);
    expect(bsSectionTotal(s.balance_sheet.lines, "equity")).toEqual({ cur: 1267858, prior: 1214048 });
    expect(bsGroups(s.balance_sheet.lines, "fixed_liabilities")).toEqual([]);
  });
  it("cash flow sections", () => {
    expect(cfSectionLines(s.cash_flow, "operating").total).toBe(63810);
    expect(cfSectionLines(s.cash_flow, "financing").lines).toHaveLength(1);
  });
  it("journal export rows", () => {
    const out = normaliseJournalExport({ from: "a", to: "b", offset: 0, total_rows: "2", returned: "2", truncated: false, rows: [
      { entry_date: "2026-07-10", journal_no: "7", line_no: "2", kind: "auto", status: "posted", source_type: "layaway_sale", source_date: "2026-07-10", description: "Layaway sale LA-PH",
        account_code: "4100", account_name: "Sales", account_name_ja: "売上高", debit_jpy: "0", credit_jpy: "119048", native_amount: "50000", currency: "PHP", rate: "0.42", memo: "LA-PH", tax_flag: "export", reversed: false },
      { entry_date: "2026-07-10", journal_no: "7", line_no: "1", kind: "auto", status: "posted", source_type: "layaway_sale", source_date: "2026-07-10", description: "x",
        account_code: "1200", account_name: "Layaway receivable", account_name_ja: null, debit_jpy: "119048", credit_jpy: "0", native_amount: "50000", currency: "PHP", rate: "0.42", memo: null, tax_flag: "", reversed: true },
    ] });
    expect(out.total_rows).toBe(2);
    expect(out.rows[0]).toMatchObject({ journal_no: 7, credit_jpy: 119048, tax_flag: "export", reversed: false });
    expect(out.rows[1].tax_flag).toBe("");
    const rows = journalCsvRows(out.rows, sourceTypeLabel);
    expect(rows[0]).toEqual(["2026-07-10", 7, 2, "auto", "posted", "Layaway sale", "2026-07-10", "Layaway sale LA-PH", "4100", "Sales", "売上高", 0, 119048, 50000, "PHP", 0.42, "LA-PH", "export", "no"]);
    expect(rows[1][10]).toBe("");
    expect(rows[1][18]).toBe("yes");
    expect(rows[0]).toHaveLength(JOURNAL_CSV_HEADER.length);
  });
  it("name_ja arrives on the chart of accounts", () => {
    const acc = normaliseAccounts([{ code: "4100", name: "Sales", kind: "revenue", contra: false, currency_hint: null, active: true, sort_order: 500, system_key: "sales", name_ja: "売上高" }, { code: "6210", name: "x", kind: "expense", contra: false, currency_hint: null, active: true, sort_order: 1, system_key: null }]);
    expect(acc[0].name_ja).toBe("売上高");
    expect(acc[1].name_ja).toBeNull();
  });
});

describe("statements — CSV", () => {
  it("BOM is opt-in and sits before the header", () => {
    const text = csvText(["a", "b"], [[1, "x"]], { bom: true });
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe("a,b\n1,x");
    expect(csvText(["a"], [[1]])).toBe(toCsv(["a"], [[1]]));
    expect(CSV_BOM).toBe("﻿");
  });
  it("statement and trial-balance rows keep the escaping rules and the 勘定科目 column", () => {
    const s = normaliseStatements(raw);
    const rows = statementCsvRows(s.income_statement.lines);
    expect(rows[0]).toEqual(["revenue", "sales", "Sales", "売上高", 83810, 219048, "", -135238, -61.7, "yes"]);
    expect(rows[3][8]).toBe("");
    expect(rows[0]).toHaveLength(STATEMENT_CSV_HEADER.length);
    const tb = trialBalanceCsvRows([{ code: "4100", name: 'Sales, "net"', kind: "revenue", opening_jpy: 0, debit_jpy: 0, credit_jpy: 5, closing_jpy: -5 }], () => "売上高");
    expect(tb[0]).toHaveLength(TRIAL_BALANCE_CSV_HEADER.length);
    expect(toCsv(TRIAL_BALANCE_CSV_HEADER, tb).split("\n")[1]).toBe('4100,"Sales, ""net""",売上高,revenue,0,0,5,-5');
  });
});

describe("statements — wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Ledger tab, Months link, Accounts 勘定科目, trial-balance CSV through the shared helper", () => {
    const tab = read("src/components/finance/LedgerTab.tsx");
    expect(tab).toContain('<TabsTrigger value="statements">Statements</TabsTrigger>');
    expect(tab).toContain("<StatementsSection thisMonth={thisMonth} startMonth={s.fiscal_year_start_month} canAdmin={s.can_admin} />");
    expect(tab).toContain("taxPackHref(key, monthRange(m).to)");
    expect(tab).toContain("fiscalYearSpan(startMonth)");
    expect(tab).not.toContain("May – April");
    expect(tab).toContain("trialBalanceCsvRows(rows, nameJa)");
    expect(tab).not.toContain("new Blob(");
    expect(tab).toContain("name_ja: editingJa.value.trim()");
  });
  it("route, permission, print and page breaks", () => {
    expect(read("src/App.tsx")).toContain('<Route path="/finance/tax-pack" element={<Protected><TaxPack /></Protected>} />');
    expect(read("src/contexts/PermissionsContext.tsx")).toContain("'/finance/tax-pack': 'view_ledger'");
    const page = read("src/pages/TaxPack.tsx");
    expect(page).toContain("window.print()");
    expect(page).toContain('can("view_ledger")');
    expect(page).toContain("statement-print-area tax-pack");
    expect(page).toContain("{ bom: true, exactName: true }");
    const css = read("src/index.css");
    expect(css).toContain(".tax-pack .tax-pack-section {");
    expect(css).toContain("break-before: page;");
  });
  it("migration: name_ja seed, flags, the three RPCs, no -- comments inside function bodies", () => {
    const m = read("supabase/migrations/20270106100000_expenses_statements.sql");
    expect(m).toContain("ADD COLUMN IF NOT EXISTS name_ja");
    expect(m).toContain("('4100', '売上高')");
    expect(m).toContain("'statement_flag_pct', '\"15\"'");
    for (const fn of ["get_statements(date, date)", "get_receivable_ageing(date)", "get_journal_export(date, date, integer)", "set_statement_flags(numeric, numeric)"]) {
      expect(m).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`);
      expect(m).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    }
    for (const fn of ["gl_statement_flags()", "gl_stmt_pick(jsonb, text[], text)"]) expect(m).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    const bodies = m.split("$fn$").filter((_, i) => i % 2 === 1);
    expect(bodies.length).toBeGreaterThan(5);
    for (const b of bodies) expect(b.split("\n").some((l) => l.trimStart().startsWith("--"))).toBe(false);
    expect(read("supabase/tests/expenses/run.sh")).toContain("test_statements.sql");
  });
});
