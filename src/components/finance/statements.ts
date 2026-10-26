/**
 * Statements + 税理士 pack (Expenses Phase 7, owner 2026-10-26 D1–D6). Pure rules, no React.
 * Finance → Ledger → "Statements" and the print page /finance/tax-pack read `get_statements`,
 * `get_receivable_ageing` and `get_journal_export` (migration 20270106100000_expenses_statements.sql).
 * Everything is derived from the posted journals as they stand; nothing here writes to the books.
 */
import { daysInMonth, fiscalYearOf, fiscalYearRange, longMonth, monthRange, pad, rangeFor, type RangeMode } from "@/components/finance/ledger";

/** The registered company name as the storefront prints it (full-width, see supabase/functions/_shared/.../brand.ts). */
export const COMPANY_NAME_JA = "Ｃｈａ　Ｊｅｗｅｌｓ株式会社";

export const STATEMENTS_KEY = ["finance", "ledger", "statements"] as const;
export const AGEING_KEY = ["finance", "ledger", "ageing"] as const;

export type PlSection = "revenue" | "cogs" | "sga" | "nonop";
export const PL_SECTION_LABEL: Record<PlSection, { en: string; ja: string }> = {
  revenue: { en: "Operating revenue", ja: "営業収益" },
  cogs: { en: "Cost of sales", ja: "売上原価" },
  sga: { en: "Selling, general and administrative", ja: "販売費及び一般管理費" },
  nonop: { en: "Non-operating", ja: "営業外収益・費用" },
};
export const PL_SECTIONS: PlSection[] = ["revenue", "cogs", "sga", "nonop"];

export type PlLine = {
  key: string; section: PlSection; label: string; label_ja: string; level: number;
  cur: number; prior: number | null; prior_year: number | null; delta: number | null; delta_pct: number | null; flag: boolean;
};
export type BsSection = "current_assets" | "fixed_assets" | "current_liabilities" | "fixed_liabilities" | "equity";
export const BS_SECTION_LABEL: Record<BsSection, { en: string; ja: string }> = {
  current_assets: { en: "Current assets", ja: "流動資産" },
  fixed_assets: { en: "Fixed assets", ja: "固定資産" },
  current_liabilities: { en: "Current liabilities", ja: "流動負債" },
  fixed_liabilities: { en: "Long-term liabilities", ja: "固定負債" },
  equity: { en: "Equity", ja: "純資産" },
};
export const BS_SECTIONS: BsSection[] = ["current_assets", "fixed_assets", "current_liabilities", "fixed_liabilities", "equity"];
export type BsGroup = "cash" | "clearing" | "receivables" | "inventory" | "other_current_assets" | "fixed_assets" | "current_liabilities" | "fixed_liabilities" | "equity";
export const BS_GROUP_LABEL: Record<BsGroup, { en: string; ja: string }> = {
  cash: { en: "Cash and deposits", ja: "現金及び預金" }, clearing: { en: "Provider clearing and COD", ja: "未収入金" },
  receivables: { en: "Receivables", ja: "売掛金" }, inventory: { en: "Inventory", ja: "商品" },
  other_current_assets: { en: "Other current assets", ja: "その他流動資産" }, fixed_assets: { en: "Fixed assets", ja: "固定資産" },
  current_liabilities: { en: "Current liabilities", ja: "流動負債" }, fixed_liabilities: { en: "Long-term liabilities", ja: "固定負債" }, equity: { en: "Equity", ja: "純資産" },
};
export type BsLine = {
  key: string; code: string | null; label: string; label_ja: string | null; kind: "asset" | "liability" | "equity"; contra: boolean;
  section: BsSection; group: BsGroup; cur: number; prior: number;
};
export type BsTotals = {
  assets: number; liabilities: number; equity: number; check: number;
  prior_assets: number; prior_liabilities: number; prior_equity: number; prior_check: number;
};
export type CfSection = "operating" | "investing" | "financing";
export const CF_SECTION_LABEL: Record<CfSection, { en: string; ja: string }> = {
  operating: { en: "Operating activities", ja: "営業活動によるキャッシュ・フロー" },
  investing: { en: "Investing activities", ja: "投資活動によるキャッシュ・フロー" },
  financing: { en: "Financing activities", ja: "財務活動によるキャッシュ・フロー" },
};
export const CF_SECTIONS: CfSection[] = ["operating", "investing", "financing"];
export type CfLine = { key: string; section: CfSection; label: string; label_ja: string; amount: number };
export type CashFlow = {
  lines: CfLine[]; net_change: number; cash_open: number; cash_close: number; actual_change: number; difference: number; unrealised_fx_on_cash: number;
};
export type AgeBucket = { plans?: number; lines?: number; orders?: number; php: number; jpy: number; total_jpy: number };
export type Ageing = {
  as_of: string; requested_as_of: string | null; rate: number | null; basis: "current" | "current_open_lines_aged_at_date";
  layaway: Record<"not_due" | "d1_30" | "d31_60" | "d61_90" | "d90p", AgeBucket>;
  cash_orders: Record<"d0_30" | "d31_60" | "d61_90" | "d90p", AgeBucket>;
  forecast: Record<"next_30" | "next_60" | "next_90", AgeBucket>;
  ledger: { layaway_jpy: number; orders_jpy: number };
};
export const LAYAWAY_BUCKETS: { key: keyof Ageing["layaway"]; label: string; ja: string }[] = [
  { key: "not_due", label: "Not yet due", ja: "期日前" }, { key: "d1_30", label: "1–30 days late", ja: "1〜30日" },
  { key: "d31_60", label: "31–60 days", ja: "31〜60日" }, { key: "d61_90", label: "61–90 days", ja: "61〜90日" }, { key: "d90p", label: "Over 90 days", ja: "90日超" },
];
export const ORDER_BUCKETS: { key: keyof Ageing["cash_orders"]; label: string; ja: string }[] = [
  { key: "d0_30", label: "Ordered within 30 days", ja: "30日以内" }, { key: "d31_60", label: "31–60 days", ja: "31〜60日" },
  { key: "d61_90", label: "61–90 days", ja: "61〜90日" }, { key: "d90p", label: "Over 90 days", ja: "90日超" },
];
export const FORECAST_BUCKETS: { key: keyof Ageing["forecast"]; label: string; ja: string }[] = [
  { key: "next_30", label: "Due in the next 30 days", ja: "30日以内" }, { key: "next_60", label: "31–60 days", ja: "31〜60日" }, { key: "next_90", label: "61–90 days", ja: "61〜90日" },
];
export type CurrencyCheck = { kind: "layaway" | "cash_order"; id: string; invoice_number: string; order_date: string; currency: "JPY" | "PHP"; country: string | null; amount: number };
export type Comparison = { from: string; to: string; available: boolean };
export type Statements = {
  from: string; to: string; ledger_start: string | null; today: string; fiscal_year_start_month: number; fiscal_year_start: string;
  journal_count: number; rate: number | null; flags: { pct: number; jpy: number };
  comparisons: { prior: Comparison; prior_year: Comparison };
  income_statement: { lines: PlLine[]; gross_margin_pct: number | null; operating_margin_pct: number | null };
  balance_sheet: { as_of: string; prior_as_of: string; lines: BsLine[]; totals: BsTotals };
  cash_flow: CashFlow;
  ageing: Ageing;
  currency_checks: { count: number; rows: CurrencyCheck[] };
  outside_hub: { label: string; label_ja: string }[];
};
export type JournalExportRow = {
  entry_date: string; journal_no: number; line_no: number; kind: string; status: string; source_type: string; source_date: string; description: string;
  account_code: string; account_name: string; account_name_ja: string | null; debit_jpy: number; credit_jpy: number;
  native_amount: number; currency: "JPY" | "PHP"; rate: number | null; memo: string | null; tax_flag: "" | "domestic" | "export"; reversed: boolean;
};
export type JournalExport = { from: string; to: string; offset: number; total_rows: number; returned: number; truncated: boolean; rows: JournalExportRow[] };

const num = (v: unknown, d = 0) => (v == null || v === "" ? d : Number(v));
const numOrNull = (v: unknown) => (v == null || v === "" ? null : Number(v));

export function normaliseStatements(raw: Record<string, unknown>): Statements {
  const o = (k: string) => (raw[k] ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const bucket = (v: unknown): AgeBucket => {
    const b = (v ?? {}) as Record<string, unknown>;
    return { plans: b.plans == null ? undefined : num(b.plans), lines: b.lines == null ? undefined : num(b.lines), orders: b.orders == null ? undefined : num(b.orders), php: num(b.php), jpy: num(b.jpy), total_jpy: num(b.total_jpy) };
  };
  const buckets = <K extends string>(v: unknown, keys: K[]): Record<K, AgeBucket> => {
    const src = (v ?? {}) as Record<string, unknown>;
    return Object.fromEntries(keys.map((k) => [k, bucket(src[k])])) as Record<K, AgeBucket>;
  };
  const is = o("income_statement"); const bs = o("balance_sheet"); const cf = o("cash_flow"); const ag = o("ageing"); const cmp = o("comparisons"); const fl = o("flags");
  const comparison = (v: unknown): Comparison => { const c = (v ?? {}) as Record<string, unknown>; return { from: String(c.from ?? ""), to: String(c.to ?? ""), available: c.available === true }; };
  return {
    from: String(raw.from ?? ""), to: String(raw.to ?? ""), ledger_start: (raw.ledger_start as string | null) ?? null, today: String(raw.today ?? ""),
    fiscal_year_start_month: num(raw.fiscal_year_start_month, 4), fiscal_year_start: String(raw.fiscal_year_start ?? ""),
    journal_count: num(raw.journal_count), rate: numOrNull(raw.rate), flags: { pct: num(fl.pct, 15), jpy: num(fl.jpy, 100000) },
    comparisons: { prior: comparison(cmp.prior), prior_year: comparison(cmp.prior_year) },
    income_statement: {
      lines: arr(is.lines).map((l) => ({
        key: String(l.key), section: l.section as PlSection, label: String(l.label ?? ""), label_ja: String(l.label_ja ?? ""), level: num(l.level),
        cur: num(l.cur), prior: numOrNull(l.prior), prior_year: numOrNull(l.prior_year), delta: numOrNull(l.delta), delta_pct: numOrNull(l.delta_pct), flag: l.flag === true,
      })),
      gross_margin_pct: numOrNull(is.gross_margin_pct), operating_margin_pct: numOrNull(is.operating_margin_pct),
    },
    balance_sheet: {
      as_of: String(bs.as_of ?? ""), prior_as_of: String(bs.prior_as_of ?? ""),
      lines: arr(bs.lines).map((l) => ({
        key: String(l.key), code: (l.code as string | null) ?? null, label: String(l.label ?? ""), label_ja: (l.label_ja as string | null) ?? null,
        kind: l.kind as BsLine["kind"], contra: l.contra === true, section: l.section as BsSection, group: l.group as BsGroup, cur: num(l.cur), prior: num(l.prior),
      })),
      totals: Object.fromEntries(["assets", "liabilities", "equity", "check", "prior_assets", "prior_liabilities", "prior_equity", "prior_check"].map((k) => [k, num(((bs.totals ?? {}) as Record<string, unknown>)[k])])) as BsTotals,
    },
    cash_flow: {
      lines: arr(cf.lines).map((l) => ({ key: String(l.key), section: l.section as CfSection, label: String(l.label ?? ""), label_ja: String(l.label_ja ?? ""), amount: num(l.amount) })),
      net_change: num(cf.net_change), cash_open: num(cf.cash_open), cash_close: num(cf.cash_close), actual_change: num(cf.actual_change), difference: num(cf.difference), unrealised_fx_on_cash: num(cf.unrealised_fx_on_cash),
    },
    ageing: normaliseAgeing(ag),
    currency_checks: { count: num(o("currency_checks").count), rows: arr(o("currency_checks").rows).map((r) => ({ ...(r as unknown as CurrencyCheck), amount: num(r.amount) })) },
    outside_hub: arr(raw.outside_hub).map((x) => ({ label: String(x.label ?? ""), label_ja: String(x.label_ja ?? "") })),
  };
  function normaliseAgeing(a: Record<string, unknown>): Ageing {
    return {
      as_of: String(a.as_of ?? ""), requested_as_of: (a.requested_as_of as string | null) ?? null, rate: numOrNull(a.rate), basis: a.basis === "current" ? "current" : "current_open_lines_aged_at_date",
      layaway: buckets(a.layaway, ["not_due", "d1_30", "d31_60", "d61_90", "d90p"]),
      cash_orders: buckets(a.cash_orders, ["d0_30", "d31_60", "d61_90", "d90p"]),
      forecast: buckets(a.forecast, ["next_30", "next_60", "next_90"]),
      ledger: { layaway_jpy: num(((a.ledger ?? {}) as Record<string, unknown>).layaway_jpy), orders_jpy: num(((a.ledger ?? {}) as Record<string, unknown>).orders_jpy) },
    };
  }
}

export function normaliseAgeingOnly(raw: Record<string, unknown>): Ageing {
  return normaliseStatements({ ageing: raw }).ageing;
}

export function normaliseJournalExport(raw: Record<string, unknown>): JournalExport {
  const rows = Array.isArray(raw.rows) ? (raw.rows as Record<string, unknown>[]) : [];
  return {
    from: String(raw.from ?? ""), to: String(raw.to ?? ""), offset: num(raw.offset), total_rows: num(raw.total_rows), returned: num(raw.returned), truncated: raw.truncated === true,
    rows: rows.map((r) => ({
      entry_date: String(r.entry_date), journal_no: num(r.journal_no), line_no: num(r.line_no), kind: String(r.kind), status: String(r.status), source_type: String(r.source_type),
      source_date: String(r.source_date ?? ""), description: String(r.description ?? ""), account_code: String(r.account_code), account_name: String(r.account_name ?? ""),
      account_name_ja: (r.account_name_ja as string | null) ?? null, debit_jpy: num(r.debit_jpy), credit_jpy: num(r.credit_jpy), native_amount: num(r.native_amount),
      currency: r.currency === "PHP" ? "PHP" : "JPY", rate: numOrNull(r.rate), memo: (r.memo as string | null) ?? null,
      tax_flag: r.tax_flag === "export" ? "export" : r.tax_flag === "domestic" ? "domestic" : "", reversed: r.reversed === true,
    })),
  };
}

// ---------- ranges ----------

export type StatementRangeMode = RangeMode | "ytd";

/** Month / quarter / FY as the ledger has them, plus fiscal year to date (1 April … end of the chosen month). */
export function statementRange(mode: StatementRangeMode, monthKey: string, startMonth = 4): { from: string; to: string; label: string } {
  if (mode !== "ytd") return rangeFor(mode, monthKey, startMonth);
  const fy = fiscalYearOf(monthKey, startMonth);
  const { from } = fiscalYearRange(fy, startMonth);
  return { from, to: monthRange(monthKey).to, label: `FY${fy} to ${longMonth(monthKey)}` };
}

/** "Jun – Jul 2026" / "Jul 2026" for the comparison column headers. */
export function rangeLabel(from: string, to: string): string {
  const a = from.slice(0, 7); const b = to.slice(0, 7);
  const short = (k: string) => { const [y, m] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }); };
  if (a === b) return short(a);
  const [ya, ma] = a.split("-").map(Number); const [yb] = b.split("-").map(Number);
  const monthOnly = new Date(Date.UTC(ya, ma - 1, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return ya === yb ? `${monthOnly} – ${short(b)}` : `${short(a)} – ${short(b)}`;
}

/** Is `from..to` a whole number of calendar months? (Then the prior period is the same number of months before.) */
export function isMonthAligned(from: string, to: string): boolean {
  const [fy, fm, fd] = from.split("-").map(Number); const [ty, tm, td] = to.split("-").map(Number);
  return fd === 1 && td === daysInMonth(ty, tm) && fy > 0 && fm > 0;
}

/** The month key the last day of a range falls in — used to build the 税理士 pack link. */
export function taxPackHref(from: string, to: string): string {
  return `/finance/tax-pack?from=${from}&to=${to}`;
}

/** A real calendar date (so "2026-02-31" is refused, not rolled over by Date.parse). */
export function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Longest range get_statements accepts (days between from and to). */
export const MAX_STATEMENT_DAYS = 1100;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Parse ?from&to; invalid, reversed, over-long or missing → the previous whole month. */
export function parseTaxPackParams(search: string, thisMonth: string): { from: string; to: string } {
  const p = new URLSearchParams(search);
  const from = p.get("from") ?? ""; const to = p.get("to") ?? "";
  if (isCalendarDate(from) && isCalendarDate(to) && from <= to && daysBetween(from, to) <= MAX_STATEMENT_DAYS) return { from, to };
  const [y, m] = thisMonth.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
  return monthRange(prev);
}

// ---------- presentation rules ----------

/** Δ % as the owner reads it: "+12.5 %", "−100 %", or "—" when there is no prior (or prior was zero). */
export function deltaPctLabel(pct: number | null): string {
  if (pct == null) return "—";
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toLocaleString("en-US", { maximumFractionDigits: 1 })} %`;
}

/** Signed yen for a delta column: "+¥12,000" / "−¥3,000" / "¥0" / "—". */
export function signedYen(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "¥0";
  return `${n > 0 ? "+" : "−"}¥${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
}

/** Percentage label for a margin: "42.3 %" or "—". */
export function pctLabel(n: number | null): string {
  return n == null ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} %`;
}

/** Thresholds the owner can type: whole-ish percent (one decimal) 0–1000 and whole yen ≥ 0. Mirrors set_statement_flags. */
export function validateFlags(pct: string, jpy: string): string | null {
  const p = Number(pct.trim()); const j = Number(jpy.replace(/[,\s¥]/g, ""));
  if (pct.trim() === "" || Number.isNaN(p) || p < 0 || p > 1000 || Math.round(p * 10) !== p * 10) return "Percent must be 0–1000 with at most one decimal";
  if (jpy.trim() === "" || Number.isNaN(j) || j < 0 || j > 1_000_000_000) return "Yen must be a whole amount";
  return null;
}

/** Why the server refused — codes that are specific to this tab; others fall through to the ledger map. */
export function statementRefusal(code: string): string | null {
  switch (code) {
    case "invalid_pct": return "Percent must be 0–1000 with at most one decimal";
    case "invalid_amount": return "Yen must be a whole amount";
    case "invalid_range": return "The range is empty, reversed or longer than three years";
    case "invalid_offset": return "Export page out of range";
    case "invalid_name_ja": return "The Japanese name is too long (60 characters)";
    default: return null;
  }
}

/** Lines of a section, in order; totals (level 0) carry the section's result. */
export function plSectionLines(lines: PlLine[], section: PlSection): PlLine[] {
  return lines.filter((l) => l.section === section);
}

/** The flagged lines (level ≥ 1 only — totals are explained by their lines). */
export function flaggedLines(lines: PlLine[]): PlLine[] {
  return lines.filter((l) => l.flag && l.level >= 1);
}

/** Balance sheet lines by group with a subtotal, in the 試算表 order. */
export function bsGroups(lines: BsLine[], section: BsSection): { group: BsGroup; lines: BsLine[]; cur: number; prior: number }[] {
  const order: BsGroup[] = ["cash", "clearing", "receivables", "inventory", "other_current_assets", "fixed_assets", "current_liabilities", "fixed_liabilities", "equity"];
  const out: { group: BsGroup; lines: BsLine[]; cur: number; prior: number }[] = [];
  for (const g of order) {
    const ls = lines.filter((l) => l.section === section && l.group === g);
    if (ls.length === 0) continue;
    out.push({ group: g, lines: ls, cur: ls.reduce((s, l) => s + l.cur, 0), prior: ls.reduce((s, l) => s + l.prior, 0) });
  }
  return out;
}

export function bsSectionTotal(lines: BsLine[], section: BsSection): { cur: number; prior: number } {
  const ls = lines.filter((l) => l.section === section);
  return { cur: ls.reduce((s, l) => s + l.cur, 0), prior: ls.reduce((s, l) => s + l.prior, 0) };
}

export function cfSectionLines(cf: CashFlow, section: CfSection): { lines: CfLine[]; total: number } {
  const lines = cf.lines.filter((l) => l.section === section);
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
}

// ---------- CSV builders ----------

export const JOURNAL_CSV_HEADER = [
  "entry_date", "journal_no", "line_no", "kind", "status", "source_type", "source_date", "description",
  "account_code", "account_name", "勘定科目", "debit_jpy", "credit_jpy", "native_amount", "currency", "rate_php_per_jpy", "memo", "tax_flag", "reversed",
];

export function journalCsvRows(rows: JournalExportRow[], sourceLabel: (t: string) => string): unknown[][] {
  return rows.map((r) => [
    r.entry_date, r.journal_no, r.line_no, r.kind, r.status, sourceLabel(r.source_type), r.source_date, r.description,
    r.account_code, r.account_name, r.account_name_ja ?? "", r.debit_jpy, r.credit_jpy, r.native_amount, r.currency, r.rate ?? "", r.memo ?? "", r.tax_flag, r.reversed ? "yes" : "no",
  ]);
}

export const TRIAL_BALANCE_CSV_HEADER = ["code", "name", "勘定科目", "kind", "opening_jpy", "debit_jpy", "credit_jpy", "closing_jpy"];

export function trialBalanceCsvRows(rows: { code: string; name: string; kind: string; opening_jpy: number; debit_jpy: number; credit_jpy: number; closing_jpy: number }[], nameJa: (code: string) => string): unknown[][] {
  return rows.map((x) => [x.code, x.name, nameJa(x.code), x.kind, x.opening_jpy, x.debit_jpy, x.credit_jpy, x.closing_jpy]);
}

export const STATEMENT_CSV_HEADER = ["section", "key", "label", "勘定科目", "current_jpy", "prior_jpy", "prior_year_jpy", "delta_jpy", "delta_pct", "flag"];

export function statementCsvRows(lines: PlLine[]): unknown[][] {
  return lines.map((l) => [l.section, l.key, l.label, l.label_ja, l.cur, l.prior ?? "", l.prior_year ?? "", l.delta ?? "", l.delta_pct ?? "", l.flag ? "yes" : "no"]);
}

/** File names the 税理士 can file by period: journals-2026-07-01-2026-09-30 (used with exactName). */
export function exportFileName(prefix: string, from: string, to: string): string {
  return from.slice(0, 7) === to.slice(0, 7) && isMonthAligned(from, to) ? `${prefix}-${from.slice(0, 7)}` : `${prefix}-${from}-${to}`;
}

/** "April – March" for the fiscal-year label on the Months tab (any start month). */
export function fiscalYearSpan(startMonth: number): string {
  const name = (m: number) => new Date(Date.UTC(2000, ((m - 1) % 12 + 12) % 12, 1)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  const start = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 4;
  return `${name(start)} – ${name(start === 1 ? 12 : start - 1)}`;
}

/**
 * Join the pages of get_journal_export into CSV rows. `fetchPage(offset)` returns one normalised page.
 * Stops after `maxPages`; `capped` tells the caller the range was too big to export whole.
 */
export async function collectJournalRows(fetchPage: (offset: number) => Promise<JournalExport>, sourceLabel: (t: string) => string, maxPages = 20): Promise<{ rows: unknown[][]; capped: boolean }> {
  const rows: unknown[][] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const out = await fetchPage(offset);
    rows.push(...journalCsvRows(out.rows, sourceLabel));
    offset += out.returned;
    if (!out.truncated || out.returned === 0) return { rows, capped: false };
  }
  return { rows, capped: true };
}
