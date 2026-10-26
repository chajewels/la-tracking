/**
 * Controls (Expenses Phase 8, owner 2026-10-26 D1–D6). Pure rules, no React.
 * Finance → Ledger → "Checks" (the nightly completeness check), "Bank rec" (statement import + matching +
 * sign-off) and the close-readiness panel on Months. Migration 20270107100000_expenses_controls.sql.
 */
import { daysInMonth, pad } from "@/components/finance/ledger";

export const CHECKS_KEY = ["finance", "ledger", "checks"] as const;
export const BANKREC_KEY = ["finance", "ledger", "bankrec"] as const;
export const READINESS_KEY = ["finance", "ledger", "readiness"] as const;

// ---------- completeness check ----------

export type CheckSeverity = "error" | "warning";
export type CheckKind =
  | "unposted" | "orphan" | "posting_failed" | "duplicate" | "unbalanced" | "trial_balance"
  | "late_posting" | "month_open" | "suspense" | "expense_paid_from" | "expense_draft" | "unmapped_method" | "reconciliation";
export type CheckIssue = {
  kind: CheckKind; severity: CheckSeverity; ref: string | null; count: number; label: string;
  link: { view?: string; month?: string; account?: string; journal_no?: number; source_type?: string; source_id?: string } | null;
};
export type CheckRun = {
  id: string; ran_at: string; trigger: "cron" | "manual"; run_by: string | null; errors: number; warnings: number; bell_rung: boolean; duration_ms: number | null;
  issues?: CheckIssue[];
};
export type LedgerChecks = { can_post: boolean; latest: CheckRun | null; runs: CheckRun[] };

const num = (v: unknown, d = 0) => (v == null || v === "" ? d : Number(v));

export function normaliseIssue(x: Record<string, unknown>): CheckIssue {
  return {
    kind: String(x.kind) as CheckKind, severity: x.severity === "error" ? "error" : "warning", ref: (x.ref as string | null) ?? null,
    count: num(x.count, 1), label: String(x.label ?? ""), link: (x.link as CheckIssue["link"]) ?? null,
  };
}
export function normaliseRun(x: Record<string, unknown>): CheckRun {
  return {
    id: String(x.id), ran_at: String(x.ran_at), trigger: x.trigger === "cron" ? "cron" : "manual", run_by: (x.run_by as string | null) ?? null,
    errors: num(x.errors), warnings: num(x.warnings), bell_rung: x.bell_rung === true, duration_ms: x.duration_ms == null ? null : num(x.duration_ms),
    issues: Array.isArray(x.issues) ? (x.issues as Record<string, unknown>[]).map(normaliseIssue) : undefined,
  };
}
export function normaliseChecks(raw: Record<string, unknown>): LedgerChecks {
  return {
    can_post: raw.can_post === true,
    latest: raw.latest ? normaliseRun(raw.latest as Record<string, unknown>) : null,
    runs: Array.isArray(raw.runs) ? (raw.runs as Record<string, unknown>[]).map(normaliseRun) : [],
  };
}

/** What each check kind means to the owner, in one line, and what to do. */
export const CHECK_KIND_LABEL: Record<CheckKind, { title: string; action: string }> = {
  unposted: { title: "Events without a journal", action: "Press Post now; if it fails, the run note says which event." },
  orphan: { title: "Journals whose source changed", action: "Press Post now — the engine reverses and reposts them." },
  posting_failed: { title: "The last posting run failed", action: "Read the note on the Journals strip; fix the source (plan, payment, expense) and post again." },
  duplicate: { title: "Two live journals for one event", action: "Should not happen (the database refuses it). Tell Claude." },
  unbalanced: { title: "A journal that does not balance", action: "Should not happen (the database refuses it). Tell Claude." },
  trial_balance: { title: "The trial balance is off", action: "Should not happen. Tell Claude before closing any month." },
  late_posting: { title: "Items booked into the open month", action: "Normal after a correction to a closed month — the 税理士 pack notes them." },
  month_open: { title: "A month still open", action: "Reconcile the accounts and close it on Months." },
  suspense: { title: "Suspense balance over 30 days", action: "Map the payment spelling (Accounts) or set Paid from on the expense." },
  expense_paid_from: { title: "Approved expenses without Paid from", action: "Open Finance → Expenses and set which account paid each one." },
  expense_draft: { title: "Old expense drafts", action: "Approve or void them in Finance → Expenses." },
  unmapped_method: { title: "Payment spellings not mapped", action: "Map them on Accounts; the payments repost to the right bank." },
  reconciliation: { title: "Accounts not reconciled", action: "Import the statement on Bank rec and sign the month off." },
};

/** Where a click on an issue goes inside the Ledger (tab + optional month / account). */
export function issueHref(i: CheckIssue): string {
  const view = i.link?.view ?? "journals";
  if (view === "expenses") return "/finance?tab=expenses";
  const p = new URLSearchParams({ tab: "ledger", view });
  if (i.link?.month) p.set("month", i.link.month);
  if (i.link?.account) p.set("account", i.link.account);
  return `/finance?${p.toString()}`;
}

export function groupIssues(issues: CheckIssue[]): { errors: CheckIssue[]; warnings: CheckIssue[] } {
  return { errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

/** "Checked 01:10 today · all clear" / "Checked 2 days ago · 3 warnings" for the status strip. */
export function lastCheckLabel(run: CheckRun | null, now: Date = new Date()): string {
  if (!run) return "Never checked";
  const at = new Date(run.ran_at);
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  const when = days <= 0 ? `today ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" })}` : days === 1 ? "yesterday" : `${days} days ago`;
  const what = run.errors > 0 ? `${run.errors} error${run.errors === 1 ? "" : "s"}${run.warnings ? `, ${run.warnings} warning${run.warnings === 1 ? "" : "s"}` : ""}`
    : run.warnings > 0 ? `${run.warnings} warning${run.warnings === 1 ? "" : "s"}` : "all clear";
  return `Checked ${when} · ${what}`;
}

// ---------- close readiness ----------

export type Readiness = {
  period_start: string; period_end: string; errors: number; warnings: number; can_close: boolean;
  unposted_events: number; posting_failed: number; dry_run: boolean; unbalanced_journals: number; duplicate_journals: number;
  unmapped_methods: { spelling: string; rows: number; first_seen: string }[];
  expenses_without_paid_from: { id: string; expense_date: string; description: string; amount: number; currency: "JPY" | "PHP" }[];
  draft_expenses: number;
  unreconciled_accounts: { code: string; name: string; name_ja: string | null; lines: number; status: string }[];
  suspense_jpy: number;
};
export function normaliseReadiness(raw: Record<string, unknown>): Readiness {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  return {
    period_start: String(raw.period_start ?? ""), period_end: String(raw.period_end ?? ""), errors: num(raw.errors), warnings: num(raw.warnings), can_close: raw.can_close === true,
    unposted_events: num(raw.unposted_events), posting_failed: num(raw.posting_failed), dry_run: raw.dry_run === true,
    unbalanced_journals: num(raw.unbalanced_journals), duplicate_journals: num(raw.duplicate_journals),
    unmapped_methods: arr(raw.unmapped_methods).map((m) => ({ spelling: String(m.spelling), rows: num(m.rows), first_seen: String(m.first_seen ?? "") })),
    expenses_without_paid_from: arr(raw.expenses_without_paid_from).map((e) => ({ id: String(e.id), expense_date: String(e.expense_date), description: String(e.description ?? ""), amount: num(e.amount), currency: e.currency === "PHP" ? "PHP" : "JPY" })),
    draft_expenses: num(raw.draft_expenses),
    unreconciled_accounts: arr(raw.unreconciled_accounts).map((a) => ({ code: String(a.code), name: String(a.name ?? ""), name_ja: (a.name_ja as string | null) ?? null, lines: num(a.lines), status: String(a.status ?? "none") })),
    suspense_jpy: num(raw.suspense_jpy),
  };
}

/** The readiness report as lines the owner reads before pressing Close. */
export function readinessItems(r: Readiness): { severity: CheckSeverity; text: string }[] {
  const out: { severity: CheckSeverity; text: string }[] = [];
  if (r.unposted_events > 0) out.push({ severity: "error", text: `${r.unposted_events} event${r.unposted_events === 1 ? "" : "s"} not posted yet (Close posts them first; if that fails the month stays open)` });
  if (r.posting_failed > 0) out.push({ severity: "error", text: `The last posting run failed on ${r.posting_failed} event${r.posting_failed === 1 ? "" : "s"}` });
  if (r.unbalanced_journals > 0) out.push({ severity: "error", text: `${r.unbalanced_journals} journal${r.unbalanced_journals === 1 ? "" : "s"} in the month do${r.unbalanced_journals === 1 ? "es" : ""} not balance` });
  if (r.duplicate_journals > 0) out.push({ severity: "error", text: `${r.duplicate_journals} event${r.duplicate_journals === 1 ? " has" : "s have"} two live journals` });
  if (r.unmapped_methods.length > 0) out.push({ severity: "warning", text: `${r.unmapped_methods.length} payment spelling${r.unmapped_methods.length === 1 ? "" : "s"} not mapped (${r.unmapped_methods.slice(0, 3).map((m) => m.spelling).join(", ")}${r.unmapped_methods.length > 3 ? ", …" : ""})` });
  if (r.expenses_without_paid_from.length > 0) out.push({ severity: "warning", text: `${r.expenses_without_paid_from.length} approved expense${r.expenses_without_paid_from.length === 1 ? "" : "s"} without a Paid from account` });
  if (r.draft_expenses > 0) out.push({ severity: "warning", text: `${r.draft_expenses} expense draft${r.draft_expenses === 1 ? "" : "s"} dated in the month still waiting` });
  if (r.unreconciled_accounts.length > 0) out.push({ severity: "warning", text: `Not reconciled: ${r.unreconciled_accounts.map((a) => `${a.code} ${a.name}`).join(", ")}` });
  if (r.suspense_jpy !== 0) out.push({ severity: "warning", text: `Suspense accounts (1190 / 1195) carry a balance at month end` });
  return out;
}

// ---------- bank reconciliation ----------

export type ImportProfile = {
  account_code?: string; delimiter: "," | ";" | "\t"; header_rows: number; date_col: number; date_format: "ymd" | "dmy" | "mdy";
  description_col: number | null; in_col: number | null; out_col: number | null; signed_col: number | null; balance_col: number | null; encoding: "utf-8" | "shift_jis";
};
export const DEFAULT_PROFILE: ImportProfile = { delimiter: ",", header_rows: 1, date_col: 0, date_format: "ymd", description_col: 1, in_col: null, out_col: null, signed_col: null, balance_col: null, encoding: "utf-8" };

export type StatementLine = { booked_on: string; description: string; amount: number; balance_after: number | null; raw: string[] };
export type Candidate = { journal_line_id: string; journal_no: number; entry_date: string; source_type: string; description: string; memo: string | null; signed_amount: number };
export type UnmatchedStatement = { id: string; booked_on: string; description: string; amount: number; balance_after: number | null; candidates: Candidate[] };
export type UnmatchedLedger = Candidate & { signed_jpy: number; customer_id: string | null; account_id: string | null; cash_order_id: string | null; expense_id: string | null };
export type IgnoredLine = { id: string; booked_on: string; description: string; amount: number; reason: string };
export type Reconciliation = {
  account_code: string; month_start: string; statement_closing: number | null; ledger_closing_native: number | null; ledger_closing_jpy: number | null; difference: number | null;
  unmatched_statement: number; unmatched_ledger: number; status: "open" | "reconciled"; note: string | null; reconciled_by: string | null; reconciled_at: string | null;
};
export type BankImport = { id: string; file_name: string; file_sha256: string; rows_in_file: number; inserted: number; skipped: number; period_from: string | null; period_to: string | null; imported_at: string; voided_at: string | null; void_reason: string | null };
export type BankRec = {
  account: string; name: string; name_ja: string | null; currency: "JPY" | "PHP"; is_cash: boolean; month: string; month_end: string;
  ledger_closing_native: number; ledger_closing_jpy: number; statement_closing: number | null; statement_closing_source: "typed" | "statement" | null;
  reconciliation: Reconciliation | null; can_post: boolean; profile: ImportProfile | null; imports: BankImport[];
  matched_count: number; ignored: IgnoredLine[]; unmatched_statement: UnmatchedStatement[]; unmatched_ledger: UnmatchedLedger[];
};

export function normaliseBankRec(raw: Record<string, unknown>): BankRec {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const cand = (c: Record<string, unknown>): Candidate => ({
    journal_line_id: String(c.journal_line_id), journal_no: num(c.journal_no), entry_date: String(c.entry_date), source_type: String(c.source_type ?? ""),
    description: String(c.description ?? ""), memo: (c.memo as string | null) ?? null, signed_amount: num(c.signed_amount),
  });
  const rec = raw.reconciliation as Record<string, unknown> | null | undefined;
  return {
    account: String(raw.account), name: String(raw.name ?? ""), name_ja: (raw.name_ja as string | null) ?? null, currency: raw.currency === "PHP" ? "PHP" : "JPY",
    is_cash: raw.is_cash === true, month: String(raw.month), month_end: String(raw.month_end),
    ledger_closing_native: num(raw.ledger_closing_native), ledger_closing_jpy: num(raw.ledger_closing_jpy),
    statement_closing: raw.statement_closing == null ? null : num(raw.statement_closing),
    statement_closing_source: raw.statement_closing_source === "typed" ? "typed" : raw.statement_closing_source === "statement" ? "statement" : null,
    reconciliation: rec ? {
      account_code: String(rec.account_code), month_start: String(rec.month_start), statement_closing: rec.statement_closing == null ? null : num(rec.statement_closing),
      ledger_closing_native: rec.ledger_closing_native == null ? null : num(rec.ledger_closing_native), ledger_closing_jpy: rec.ledger_closing_jpy == null ? null : num(rec.ledger_closing_jpy),
      difference: rec.difference == null ? null : num(rec.difference), unmatched_statement: num(rec.unmatched_statement), unmatched_ledger: num(rec.unmatched_ledger),
      status: rec.status === "reconciled" ? "reconciled" : "open", note: (rec.note as string | null) ?? null, reconciled_by: (rec.reconciled_by as string | null) ?? null, reconciled_at: (rec.reconciled_at as string | null) ?? null,
    } : null,
    can_post: raw.can_post === true,
    profile: raw.profile ? normaliseProfile(raw.profile as Record<string, unknown>) : null,
    imports: arr(raw.imports).map((i) => ({
      id: String(i.id), file_name: String(i.file_name ?? ""), file_sha256: String(i.file_sha256 ?? ""), rows_in_file: num(i.rows_in_file), inserted: num(i.inserted), skipped: num(i.skipped),
      period_from: (i.period_from as string | null) ?? null, period_to: (i.period_to as string | null) ?? null, imported_at: String(i.imported_at), voided_at: (i.voided_at as string | null) ?? null, void_reason: (i.void_reason as string | null) ?? null,
    })),
    matched_count: num(raw.matched_count),
    ignored: arr(raw.ignored).map((x) => ({ id: String(x.id), booked_on: String(x.booked_on), description: String(x.description ?? ""), amount: num(x.amount), reason: String(x.reason ?? "") })),
    unmatched_statement: arr(raw.unmatched_statement).map((x) => ({
      id: String(x.id), booked_on: String(x.booked_on), description: String(x.description ?? ""), amount: num(x.amount), balance_after: x.balance_after == null ? null : num(x.balance_after),
      candidates: arr(x.candidates).map(cand),
    })),
    unmatched_ledger: arr(raw.unmatched_ledger).map((x) => ({
      ...cand(x), signed_jpy: num(x.signed_jpy), customer_id: (x.customer_id as string | null) ?? null, account_id: (x.account_id as string | null) ?? null,
      cash_order_id: (x.cash_order_id as string | null) ?? null, expense_id: (x.expense_id as string | null) ?? null,
    })),
  };
}
export function normaliseProfile(p: Record<string, unknown>): ImportProfile {
  const col = (v: unknown) => (v == null || v === "" ? null : Number(v));
  return {
    account_code: p.account_code ? String(p.account_code) : undefined,
    delimiter: p.delimiter === ";" ? ";" : p.delimiter === "\t" ? "\t" : ",", header_rows: num(p.header_rows, 1), date_col: num(p.date_col),
    date_format: p.date_format === "dmy" ? "dmy" : p.date_format === "mdy" ? "mdy" : "ymd",
    description_col: col(p.description_col), in_col: col(p.in_col), out_col: col(p.out_col), signed_col: col(p.signed_col), balance_col: col(p.balance_col),
    encoding: p.encoding === "shift_jis" ? "shift_jis" : "utf-8",
  };
}

/** Decode a bank file: UTF-8 when it is valid UTF-8 (BOM stripped), otherwise Shift-JIS (Japanese banks). */
export function decodeStatementBytes(bytes: Uint8Array): { text: string; encoding: "utf-8" | "shift_jis" } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: text.replace(/^\uFEFF/, ""), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "shift_jis" };
  }
}

/** Pick the delimiter that splits the first non-empty lines into the most equal columns. */
export function sniffDelimiter(text: string): "," | ";" | "\t" {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best: "," | ";" | "\t" = ","; let bestScore = -1;
  for (const d of [",", ";", "\t"] as const) {
    const counts = lines.map((l) => splitCsvLine(l, d).length);
    const max = Math.max(...counts, 0);
    const score = max <= 1 ? 0 : counts.filter((c) => c === max).length * 100 + max;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** RFC 4180-ish split of one line (quotes, doubled quotes). */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delimiter) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export function parseCsvRows(text: string, delimiter: string): string[][] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => splitCsvLine(l, delimiter));
}

/** Full-width digits and signs → ASCII; ¥ ₱ , spaces removed; (1,000) △1,000 ▲1,000 -1,000 → negative. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw == null) return null;
  let s = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[－−―]/g, "-").replace(/．/g, ".").replace(/，/g, ",");
  s = s.replace(/[¥￥₱円\s,]/g, "");
  if (s === "" || s === "-") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[△▲]/.test(s)) { neg = true; s = s.slice(1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

/** 2026/09/05, 2026-09-05, 2026.9.5, 20260905 (ymd); 05/09/2026 (dmy); 09/05/2026 (mdy). Returns YYYY-MM-DD or null. */
export function parseStatementDate(raw: string | undefined, format: ImportProfile["date_format"]): string | null {
  if (!raw) return null;
  const s = raw.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();
  let y: number, m: number, d: number;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  const parts = /^(\d{1,4})[/.\-年](\d{1,2})[/.\-月](\d{1,4})日?/.exec(s);
  if (compact) { y = Number(compact[1]); m = Number(compact[2]); d = Number(compact[3]); }
  else if (parts) {
    const a = Number(parts[1]), b = Number(parts[2]), c = Number(parts[3]);
    if (parts[1].length === 4) { y = a; m = b; d = c; }
    else if (format === "mdy") { m = a; d = b; y = c; }
    else { d = a; m = b; y = c; }
    if (y < 100) y += 2000;
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m) || y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export type ParsedStatement = { lines: StatementLine[]; problems: { row: number; reason: string }[]; skipped_rows: number };

/** Turn the file's rows into statement lines with the saved column map. Rows with no date or no amount are reported, never guessed. */
export function buildStatementLines(rows: string[][], profile: ImportProfile): ParsedStatement {
  const lines: StatementLine[] = []; const problems: { row: number; reason: string }[] = []; let skipped = 0;
  rows.slice(profile.header_rows).forEach((cells, idx) => {
    const row = idx + profile.header_rows + 1;
    if (cells.every((c) => c === "")) { skipped++; return; }
    const booked_on = parseStatementDate(cells[profile.date_col], profile.date_format);
    if (!booked_on) { problems.push({ row, reason: `No date in column ${profile.date_col + 1} ("${cells[profile.date_col] ?? ""}")` }); return; }
    let amount: number | null = null;
    if (profile.signed_col != null) amount = parseAmount(cells[profile.signed_col]);
    else {
      const inn = profile.in_col == null ? null : parseAmount(cells[profile.in_col]);
      const out = profile.out_col == null ? null : parseAmount(cells[profile.out_col]);
      if (inn != null && inn !== 0) amount = Math.abs(inn);
      else if (out != null && out !== 0) amount = -Math.abs(out);
    }
    if (amount == null || amount === 0) { problems.push({ row, reason: "No amount (neither money in nor money out)" }); return; }
    const balance = profile.balance_col == null ? null : parseAmount(cells[profile.balance_col]);
    lines.push({ booked_on, description: profile.description_col == null ? "" : (cells[profile.description_col] ?? "").slice(0, 300), amount, balance_after: balance, raw: cells });
  });
  return { lines, problems, skipped_rows: skipped };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The import payload the RPC expects. */
export function importPayload(account: string, fileName: string, sha: string, profile: ImportProfile, parsed: ParsedStatement): Record<string, unknown> {
  const { account_code: _ignored, ...p } = profile;
  void _ignored;
  return {
    account_code: account, file_name: fileName.slice(0, 200), file_sha256: sha, encoding: profile.encoding, profile: p,
    lines: parsed.lines.map((l) => ({ booked_on: l.booked_on, description: l.description, amount: l.amount.toFixed(2), balance_after: l.balance_after == null ? null : l.balance_after.toFixed(2), raw: l.raw.slice(0, 12) })),
  };
}

/** Month key helpers for the picker. */
export function monthStartOf(monthKey: string): string { return `${monthKey}-01`; }
export function monthEndOf(monthKey: string): string { const [y, m] = monthKey.split("-").map(Number); return `${monthKey}-${pad(daysInMonth(y, m))}`; }

/** What stops a sign-off, in the owner's words (mirrors sign_off_reconciliation). */
export function signOffBlockers(rec: BankRec, typedClosing: number | null): string[] {
  const out: string[] = [];
  if (typedClosing == null) out.push(rec.is_cash ? "Type the counted cash." : "Type (or import) the statement closing balance.");
  else if (Math.round((typedClosing - rec.ledger_closing_native) * 100) !== 0) out.push(`Difference ${formatSigned(typedClosing - rec.ledger_closing_native, rec.currency)} between the ${rec.is_cash ? "count" : "statement"} and the ledger.`);
  if (!rec.is_cash && rec.unmatched_statement.length > 0) out.push(`${rec.unmatched_statement.length} statement line${rec.unmatched_statement.length === 1 ? "" : "s"} not matched or ignored.`);
  const end = new Date(`${rec.month_end}T00:00:00Z`).getTime();
  const old = rec.unmatched_ledger.filter((l) => end - new Date(`${l.entry_date}T00:00:00Z`).getTime() >= 5 * 86_400_000);
  if (!rec.is_cash && old.length > 0) out.push(`${old.length} Hub entr${old.length === 1 ? "y" : "ies"} dated before the last five days of the month ${old.length === 1 ? "is" : "are"} not on the statement.`);
  return out;
}

export function formatSigned(n: number, currency: "JPY" | "PHP"): string {
  const abs = Math.abs(n);
  const body = currency === "JPY" ? `¥${Math.round(abs).toLocaleString("en-US")}` : `₱${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `−${body}` : n > 0 ? `+${body}` : body;
}

/** The cash over / short entry the owner may post herself (D6) — text only, never posted automatically. */
export function cashAdjustmentHint(rec: BankRec, counted: number): string | null {
  const diff = Math.round((counted - rec.ledger_closing_native) * 100) / 100;
  if (diff === 0) return null;
  const amt = rec.currency === "JPY" ? `¥${Math.abs(diff).toLocaleString("en-US")}` : `₱${Math.abs(diff).toFixed(2)}`;
  return diff > 0
    ? `Cash over by ${amt}: a manual journal Dr ${rec.account} ${rec.name} / Cr 4900 Other income for ${amt} dated ${rec.month_end} brings the book to the count.`
    : `Cash short by ${amt}: a manual journal Dr 6900 Other operating expense / Cr ${rec.account} ${rec.name} for ${amt} dated ${rec.month_end} brings the book to the count.`;
}

/** Refusal codes specific to Phase 8 (others fall through to ledgerRefusal). */
export function controlsRefusal(code: string): string | null {
  switch (code) {
    case "invalid_file": return "The file could not be read.";
    case "no_lines": return "No statement lines were found with this column map.";
    case "too_many_lines": return "That file has more than 5,000 lines — split it by month.";
    case "duplicate_file": return "This exact file was already imported for this account.";
    case "invalid_line": return "A line has no date or no amount — check the column map.";
    case "invalid_profile": return "The column map is incomplete (date and an amount column are needed).";
    case "already_matched": return "That line is already matched.";
    case "not_matched": return "That line isn't matched.";
    case "amount_differs": return "The amounts differ — a match must be for the same amount.";
    case "date_too_far": return "Those dates are more than a month apart.";
    case "invalid_line_match": return "That Hub entry can't be matched (wrong account or an opening balance).";
    case "month_reconciled": return "That month is signed off — reopen it first.";
    case "already_reconciled": return "That month is already signed off.";
    case "not_reconciled": return "That month isn't signed off.";
    case "difference_remains": return "The closing balance doesn't agree with the ledger yet.";
    case "unmatched_statement_lines": return "Match or ignore every statement line first.";
    case "unmatched_ledger_lines": return "Some Hub entries are not on the statement — match them or check the dates.";
    case "ledger_errors": return "The month has ledger errors — see the readiness list; it can't close until they're gone.";
    case "invalid_amount": return "Type a valid closing balance.";
    default: return null;
  }
}
