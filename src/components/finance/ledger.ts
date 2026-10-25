/**
 * Finance → Ledger rules (Expenses Phase 2b, owner decisions 2026-10-25, plan
 * claude/expenses-phase2b-ledger-plan-2026-10-25.md). Pure functions, no React, no Supabase.
 *
 * The books are Cha Jewels Japan in yen (owner D2): every amount shown as a total is *_jpy.
 * Fiscal year runs May–April (owner F1): FY is named by the year it ENDS.
 */

export const LEDGER_STATUS_KEY = ["finance", "ledger", "status"] as const;
export const LEDGER_JOURNALS_KEY = ["finance", "ledger", "journals"] as const;
export const LEDGER_TB_KEY = ["finance", "ledger", "trial-balance"] as const;
export const LEDGER_COA_KEY = ["finance", "ledger", "accounts"] as const;
export const PAID_FROM_KEY = ["finance", "expenses", "paid-from"] as const;

export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "cogs" | "expense";
export type JournalKind = "auto" | "manual" | "opening" | "reversal";
export type JournalStatus = "posted" | "reversed";
export type MethodKind = "bank" | "cash" | "clearing" | "cod" | "non_cash" | "suspense";

export type GlAccount = {
  code: string; name: string; kind: AccountKind; contra: boolean; currency_hint: string | null;
  active: boolean; sort_order: number; system_key: string | null;
  debit_jpy?: number; credit_jpy?: number; balance_jpy?: number;
};
export type MethodMap = { spelling: string; account_code: string; kind: MethodKind; note: string | null };
export type Period = {
  period_start: string; fiscal_year: number; status: "open" | "closed";
  closed_at: string | null; closed_by: string | null; note: string | null;
};
export type PostingRun = {
  id: string; started_at: string; finished_at: string | null; trigger: "cron" | "manual" | "migration";
  posted: number; reversed: number; moved: number; skipped: number;
};
export type UnmappedMethod = { spelling: string; rows: number; first_seen: string };
export type ExpenseNeedingAccount = {
  id: string; expense_date: string; description: string; amount: number; currency: "JPY" | "PHP";
  payment_method: string; source: string;
};
export type LedgerStatus = {
  ledger_start_date: string | null;
  fiscal_year_start_month: number;
  php_jpy_rate: number | null;
  can_post: boolean; can_close: boolean; can_admin: boolean;
  pending: { posted: number; reversed: number; moved: number; pending: number };
  last_run: PostingRun | null;
  journal_count: number;
  moved_count: number;
  unmapped_methods: UnmappedMethod[];
  expenses_without_paid_from: ExpenseNeedingAccount[];
  periods: Period[];
};
export type JournalLine = {
  id: string; line_no: number; account_code: string; account_name: string;
  debit: number; credit: number; currency: "JPY" | "PHP"; fx_php_per_jpy: number | null;
  debit_jpy: number; credit_jpy: number; memo: string | null;
  customer_id: string | null; account_id: string | null; cash_order_id: string | null; expense_id: string | null;
};
export type Journal = {
  id: string; journal_no: number; entry_date: string; period_start: string; source_date: string;
  kind: JournalKind; source_type: string; source_id: string | null; description: string;
  status: JournalStatus; reverses: string | null; reversed_by: string | null; reason: string | null;
  posted_by: string | null; posted_at: string; total_jpy: number; lines: JournalLine[];
};
export type TrialBalanceRow = {
  code: string; name: string; kind: AccountKind; contra: boolean;
  opening_jpy: number; debit_jpy: number; credit_jpy: number; closing_jpy: number;
};
export type PaidFromAccount = { code: string; name: string; currency_hint: string | null };

export type LedgerState = { available: true; status: LedgerStatus } | { available: false };

// ---------- normalising jsonb (numbers may arrive as strings) ----------

export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function normaliseStatus(raw: Record<string, unknown>): LedgerStatus {
  const pending = (raw.pending ?? {}) as Record<string, unknown>;
  return {
    ledger_start_date: (raw.ledger_start_date as string | null) ?? null,
    fiscal_year_start_month: num(raw.fiscal_year_start_month) || 5,
    php_jpy_rate: raw.php_jpy_rate == null ? null : num(raw.php_jpy_rate),
    can_post: raw.can_post === true,
    can_close: raw.can_close === true,
    can_admin: raw.can_admin === true,
    pending: { posted: num(pending.posted), reversed: num(pending.reversed), moved: num(pending.moved), pending: num(pending.pending) },
    last_run: (raw.last_run as PostingRun | null) ?? null,
    journal_count: num(raw.journal_count),
    moved_count: num(raw.moved_count),
    unmapped_methods: Array.isArray(raw.unmapped_methods)
      ? (raw.unmapped_methods as Record<string, unknown>[]).map((m) => ({ spelling: String(m.spelling), rows: num(m.rows), first_seen: String(m.first_seen) }))
      : [],
    expenses_without_paid_from: Array.isArray(raw.expenses_without_paid_from)
      ? (raw.expenses_without_paid_from as Record<string, unknown>[]).map((e) => ({
          id: String(e.id), expense_date: String(e.expense_date), description: String(e.description), amount: num(e.amount),
          currency: (e.currency as "JPY" | "PHP") ?? "JPY", payment_method: String(e.payment_method ?? ""), source: String(e.source ?? "manual"),
        }))
      : [],
    periods: Array.isArray(raw.periods) ? (raw.periods as Period[]) : [],
  };
}

export function normaliseJournals(raw: unknown): Journal[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((j) => ({
    ...(j as unknown as Journal),
    journal_no: num(j.journal_no),
    total_jpy: num(j.total_jpy),
    lines: Array.isArray(j.lines)
      ? (j.lines as Record<string, unknown>[]).map((l) => ({
          ...(l as unknown as JournalLine),
          debit: num(l.debit), credit: num(l.credit), debit_jpy: num(l.debit_jpy), credit_jpy: num(l.credit_jpy),
          fx_php_per_jpy: l.fx_php_per_jpy == null ? null : num(l.fx_php_per_jpy),
        }))
      : [],
  }));
}

export function normaliseTrialBalance(raw: unknown): TrialBalanceRow[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((r) => ({
    code: String(r.code), name: String(r.name), kind: r.kind as AccountKind, contra: r.contra === true,
    opening_jpy: num(r.opening_jpy), debit_jpy: num(r.debit_jpy), credit_jpy: num(r.credit_jpy), closing_jpy: num(r.closing_jpy),
  }));
}

export function normaliseAccounts(raw: unknown): GlAccount[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((a) => ({
    ...(a as unknown as GlAccount),
    sort_order: num(a.sort_order), debit_jpy: num(a.debit_jpy), credit_jpy: num(a.credit_jpy), balance_jpy: num(a.balance_jpy),
  }));
}

// ---------- fiscal year (May–April) ----------

/** FY is named by the year it ends: June 2026 → 2027 when the year starts in May. */
export function fiscalYearOf(monthKey: string, startMonth = 5): number {
  const [y, m] = monthKey.split("-").map(Number);
  if (startMonth <= 1) return y;
  return m >= startMonth ? y + 1 : y;
}

export function fiscalYearRange(fy: number, startMonth = 5): { from: string; to: string } {
  const fromY = startMonth === 1 ? fy : fy - 1;
  const from = `${fromY}-${pad(startMonth)}-01`;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endY = startMonth === 1 ? fy : fy;
  return { from, to: `${endY}-${pad(endMonth)}-${pad(daysInMonth(endY, endMonth))}` };
}

export function fiscalYearLabel(fy: number, startMonth = 5): string {
  const { from, to } = fiscalYearRange(fy, startMonth);
  return `FY${fy} (${shortMonth(from)} – ${shortMonth(to)})`;
}

/** The months of a fiscal year in order (first of each month). */
export function fiscalYearMonths(fy: number, startMonth = 5): string[] {
  const { from } = fiscalYearRange(fy, startMonth);
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  for (let i = 0; i < 12; i++) {
    out.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function monthRange(monthKey: string): { from: string; to: string } {
  const [y, m] = monthKey.split("-").map(Number);
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad(daysInMonth(y, m))}` };
}

/** Quarter n (1–4) of a fiscal year. */
export function quarterRange(fy: number, quarter: 1 | 2 | 3 | 4, startMonth = 5): { from: string; to: string } {
  const months = fiscalYearMonths(fy, startMonth).slice((quarter - 1) * 3, quarter * 3);
  return { from: `${months[0]}-01`, to: monthRange(months[2]).to };
}

export type RangeMode = "month" | "quarter" | "fy";

export function rangeFor(mode: RangeMode, monthKey: string, startMonth = 5): { from: string; to: string; label: string } {
  const fy = fiscalYearOf(monthKey, startMonth);
  if (mode === "month") return { ...monthRange(monthKey), label: longMonth(monthKey) };
  if (mode === "fy") return { ...fiscalYearRange(fy, startMonth), label: fiscalYearLabel(fy, startMonth) };
  const idx = fiscalYearMonths(fy, startMonth).indexOf(monthKey);
  const q = (Math.floor(Math.max(idx, 0) / 3) + 1) as 1 | 2 | 3 | 4;
  return { ...quarterRange(fy, q, startMonth), label: `Q${q} FY${fy}` };
}

// ---------- formatting ----------

export function pad(n: number): string { return String(n).padStart(2, "0"); }
export function daysInMonth(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export function formatYen(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}¥${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

export function formatNative(n: number, currency: "JPY" | "PHP"): string {
  if (currency === "JPY") return formatYen(n);
  const sign = n < 0 ? "−" : "";
  return `${sign}₱${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function shortMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
export function longMonth(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export const KIND_LABEL: Record<AccountKind, string> = {
  asset: "Assets", liability: "Liabilities", equity: "Equity", revenue: "Revenue", cogs: "Cost of sales", expense: "Operating expenses",
};
export const KIND_ORDER: AccountKind[] = ["asset", "liability", "equity", "revenue", "cogs", "expense"];

export const JOURNAL_KIND_LABEL: Record<JournalKind, string> = {
  auto: "Automatic", manual: "Manual", opening: "Opening balance", reversal: "Reversal",
};

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  layaway_sale: "Layaway sale", layaway_close: "Layaway forfeited / cancelled", payment: "Layaway payment",
  cash_order_sale: "Cash order sale", cash_order_close: "Cash order cancelled / expired", cash_payment: "Cash order payment",
  store_credit_issue: "Store credit issued", store_credit_use: "Store credit used", expense: "Expense",
  square_refund: "Square refund", paidy_refund: "Paidy refund", web_refund: "Refund issued", manual: "Manual", opening: "Opening balance",
};
export const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABEL).filter((k) => k !== "manual" && k !== "opening");

export function sourceTypeLabel(t: string): string { return SOURCE_TYPE_LABEL[t] ?? t; }

/** Where a journal's source lives in the Hub (for the "open source" link). */
export function sourceLink(j: Pick<Journal, "source_date" | "lines">): string | null {
  const l = j.lines[0];
  if (!l) return null;
  if (l.expense_id) return `/finance?tab=expenses&month=${j.source_date.slice(0, 7)}`;
  if (l.account_id) return `/accounts/${l.account_id}`;
  if (l.cash_order_id) return `/cash-orders/${l.cash_order_id}`;
  return null;
}

/** A balance stated the way an accountant reads it: assets/expenses debit-normal, the rest credit-normal. */
export function naturalBalance(row: { kind: AccountKind; contra: boolean; closing_jpy: number }): number {
  const debitNormal = row.kind === "asset" || row.kind === "cogs" || row.kind === "expense";
  const raw = debitNormal ? row.closing_jpy : -row.closing_jpy;
  return row.contra ? -raw : raw;
}

export function trialBalanceTotals(rows: TrialBalanceRow[]): { debit: number; credit: number; balanced: boolean } {
  const debit = rows.reduce((s, r) => s + r.debit_jpy, 0);
  const credit = rows.reduce((s, r) => s + r.credit_jpy, 0);
  return { debit, credit, balanced: debit === credit };
}

/** Simple income statement from a trial-balance range: revenue − cost of sales − operating expenses. */
export function profitSummary(rows: TrialBalanceRow[]): { revenue: number; cogs: number; expenses: number; gross: number; operating: number } {
  const sum = (kind: AccountKind) => rows.filter((r) => r.kind === kind).reduce((s, r) => s + (kind === "revenue" ? r.credit_jpy - r.debit_jpy : r.debit_jpy - r.credit_jpy), 0);
  const revenue = sum("revenue");
  const cogs = sum("cogs");
  const expenses = sum("expense");
  return { revenue, cogs, expenses, gross: revenue - cogs, operating: revenue - cogs - expenses };
}

// ---------- status strip ----------

export function postingSummary(s: LedgerStatus): string {
  if (!s.ledger_start_date) return "Ledger not started — set the start date to begin posting.";
  const p = s.pending.pending;
  if (p === 0) return `Up to date · ${s.journal_count.toLocaleString("en-US")} journals`;
  const parts: string[] = [];
  if (s.pending.posted) parts.push(`${s.pending.posted} to post`);
  if (s.pending.reversed) parts.push(`${s.pending.reversed} to reverse`);
  return `${parts.join(", ")} · runs nightly at 00:40 or press Post now`;
}

export function lastRunLabel(run: PostingRun | null): string {
  if (!run) return "No posting run yet";
  const when = new Date(run.started_at).toLocaleString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const who = run.trigger === "cron" ? "nightly" : run.trigger === "manual" ? "by hand" : "migration";
  return `Last run ${when} (${who}): ${run.posted} posted, ${run.reversed} reversed${run.moved ? `, ${run.moved} moved to an open month` : ""}`;
}

// ---------- manual journal form ----------

export type ManualLine = { account: string; side: "dr" | "cr"; amount: string; currency: "JPY" | "PHP"; memo: string };
export type ManualJournalForm = { entry_date: string; description: string; kind: "manual" | "opening"; reason: string; lines: ManualLine[] };

export function emptyManualLine(side: "dr" | "cr" = "dr"): ManualLine {
  return { account: "", side, amount: "", currency: "JPY", memo: "" };
}
export function emptyManualForm(today: string): ManualJournalForm {
  return { entry_date: today, description: "", kind: "manual", reason: "", lines: [emptyManualLine("dr"), emptyManualLine("cr")] };
}

export function lineYen(l: ManualLine, rate: number | null): number | null {
  const amt = Number(l.amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  if (l.currency === "JPY") return Math.round(amt);
  if (!rate || rate <= 0) return null;
  return Math.round(amt / rate);
}

export function manualTotals(f: ManualJournalForm, rate: number | null): { debit: number; credit: number; balanced: boolean; unknownYen: boolean } {
  let debit = 0, credit = 0, unknownYen = false;
  for (const l of f.lines) {
    const y = lineYen(l, rate);
    if (y == null) { if (l.amount !== "") unknownYen = true; continue; }
    if (l.side === "dr") debit += y; else credit += y;
  }
  return { debit, credit, balanced: debit === credit && debit > 0, unknownYen };
}

export function validateManualForm(f: ManualJournalForm, rate: number | null, ledgerStart: string | null, today: string, closedPeriods: string[]): string | null {
  if (!ledgerStart) return "The ledger has no start date yet.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.entry_date)) return "Pick the entry date.";
  if (f.entry_date < ledgerStart) return `The date is before the ledger start (${dayLabel(ledgerStart)}).`;
  if (f.entry_date > today) return "The date can't be in the future.";
  if (f.kind === "opening" && f.entry_date !== ledgerStart) return `Opening balances are dated on the ledger start (${dayLabel(ledgerStart)}).`;
  if (closedPeriods.includes(f.entry_date.slice(0, 7) + "-01")) return `${longMonth(f.entry_date.slice(0, 7))} is closed. Reopen it first or use a date in an open month.`;
  if (f.description.trim().length < 3) return "Describe the entry (at least 3 characters).";
  if (f.lines.length < 2) return "A journal needs at least two lines.";
  if (f.lines.length > 50) return "At most 50 lines.";
  for (const l of f.lines) {
    if (!l.account) return "Pick an account on every line.";
    if (!/^\d+(\.\d{1,2})?$/.test(l.amount) || Number(l.amount) <= 0) return "Every line needs an amount above zero (two decimals at most).";
    if (l.currency === "JPY" && !/^\d+$/.test(l.amount)) return "Yen amounts are whole yen.";
  }
  const t = manualTotals(f, rate);
  if (t.unknownYen) return "The peso rate is not set, so peso lines can't be converted.";
  if (!t.balanced) return `Debits (${formatYen(t.debit)}) and credits (${formatYen(t.credit)}) must match in yen.`;
  return null;
}

export function manualPayload(f: ManualJournalForm) {
  return {
    kind: f.kind,
    entry_date: f.entry_date,
    description: f.description.trim(),
    reason: f.reason.trim() || undefined,
    lines: f.lines.map((l) => ({ a: l.account, side: l.side, amt: l.amount, cur: l.currency, memo: l.memo.trim() || undefined })),
  };
}

// ---------- refusals ----------

export function ledgerRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "You don't have permission for that.";
    case "ledger_start_not_set": return "Set the ledger start date first.";
    case "rate_not_set": return "The peso rate is not set in Settings, so nothing can be converted.";
    case "invalid_date": return "That date isn't allowed (first of a month, not in the future, from 2020).";
    case "invalid_period": return "Pick a month.";
    case "period_not_ended": return "A month can only be closed after it has ended.";
    case "before_ledger_start": return "That month is before the ledger start.";
    case "earlier_period_open": return "Close the earlier months first.";
    case "already_closed": return "That month is already closed.";
    case "not_closed": return "That month isn't closed.";
    case "later_period_closed": return "Reopen the later months first.";
    case "reason_required": return "Give a reason (at least 3 characters).";
    case "period_closed": return "That month is closed.";
    case "unbalanced": return "Debits and credits must match in yen.";
    case "invalid_lines": return "Check the lines: every line needs an active account, a side and an amount.";
    case "invalid_description": return "Describe the entry (3–500 characters).";
    case "opening_must_be_start_date": return "Opening balances are dated on the ledger start date.";
    case "auto_journal_follows_source": return "Automatic journals follow their source — fix the payment, plan or expense instead and run Post now.";
    case "cannot_reverse_reversal": return "A reversal can't be reversed; post the original again if needed.";
    case "already_reversed": return "That journal is already reversed.";
    case "ledger_has_journals": return "The start date can't change once journals exist.";
    case "invalid_account": return "Pick a bank, cash or clearing account.";
    case "invalid_spelling": return "That spelling can't be mapped.";
    case "invalid_kind": return "Pick what kind of account that is.";
    case "system_account": return "System accounts can't be deactivated.";
    case "not_found": return "That row no longer exists.";
    default: return "";
  }
}
