import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHECK_KIND_LABEL, DEFAULT_PROFILE, type BankRec, type CheckIssue,
  buildStatementLines, cashAdjustmentHint, controlsRefusal, decodeStatementBytes, expectedClosing, formatSigned, groupIssues, importPayload, issueHref, lastCheckLabel,
  normaliseBankRec, normaliseChecks, normaliseReadiness, parseAmount, parseCsvRows, parseStatementDate, readinessItems, sha256Hex, signOffBlockers, sniffDelimiter, splitCsvLine,
} from "@/components/finance/controls";
import { refusalCode, expenseRefusal } from "@/components/finance/expenses";
import { normaliseStatus } from "@/components/finance/ledger";

/**
 * Controls (Expenses Phase 8, owner 2026-10-26 D1–D6): the bank-file parser (Shift-JIS, delimiters, Japanese
 * amounts and dates, column maps), the sign-off rules, the check / readiness presentation, and the wiring.
 */

describe("controls — bank file parsing", () => {
  it("decodes UTF-8 (BOM stripped) and falls back to Shift-JIS", () => {
    const utf8 = new TextEncoder().encode("﻿日付,摘要\n2026/09/05,振込");
    expect(decodeStatementBytes(utf8)).toEqual({ text: "日付,摘要\n2026/09/05,振込", encoding: "utf-8" });
    const sjis = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x8e, 0x63, 0x8d, 0x82]);
    const out = decodeStatementBytes(sjis);
    expect(out.encoding).toBe("shift_jis");
    expect(out.text).toBe("日付,残高");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x2c, 0x00, 0x42, 0x00]);
    expect(decodeStatementBytes(utf16)).toEqual({ text: "A,B", encoding: "utf-8" });
  });
  it("sniffs the delimiter and splits quoted fields", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3\n4,5,6")).toBe(",");
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(splitCsvLine('2026/09/05,"振込 ヤマダ, タロウ","1,000",,', ",")).toEqual(["2026/09/05", "振込 ヤマダ, タロウ", "1,000", "", ""]);
    expect(splitCsvLine('a,"he said ""hi""",b', ",")).toEqual(["a", 'he said "hi"', "b"]);
    expect(parseCsvRows("a,b\r\n\r\n1,2\n", ",")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("amounts: full-width, yen signs, commas, brackets, △ and minus", () => {
    expect(parseAmount("1,000")).toBe(1000);
    expect(parseAmount("￥１２，３４５")).toBe(12345);
    expect(parseAmount("-5,000")).toBe(-5000);
    expect(parseAmount("△5,000")).toBe(-5000);
    expect(parseAmount("▲220")).toBe(-220);
    expect(parseAmount("(1,000.50)")).toBe(-1000.5);
    expect(parseAmount("+300")).toBe(300);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount("₱1,500.00")).toBe(1500);
    expect(parseAmount("1.000,00")).toBe(1000);
    expect(parseAmount("-12.345,67")).toBe(-12345.67);
    expect(parseAmount("1,000-")).toBeNull();
  });
  it("dates: Japanese bank formats and day-first exports", () => {
    expect(parseStatementDate("2026/09/05", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("2026-9-5", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("20260905", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("2026.09.05", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("２０２６/０９/０５", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("2026年9月5日", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("05/09/2026", "dmy")).toBe("2026-09-05");
    expect(parseStatementDate("09/05/2026", "mdy")).toBe("2026-09-05");
    expect(parseStatementDate("05/09/26", "dmy")).toBe("2026-09-05");
    expect(parseStatementDate("26/09/05", "ymd")).toBe("2026-09-05");
    expect(parseStatementDate("2026/02/30", "ymd")).toBeNull();
    expect(parseStatementDate("令和8年9月5日", "ymd")).toBeNull();
    expect(parseStatementDate("", "ymd")).toBeNull();
  });
  it("builds lines from an in/out map, reports unreadable rows, skips blanks", () => {
    const rows = parseCsvRows("日付,摘要,お預入れ,お引出し,残高\n2026/09/05,振込 ヤマダ,\"10,000\",,\"1,010,000\"\n2026/09/06,手数料,,220,\"1,009,780\"\n,,,,\nbad,row,,,\n2026/09/07,ゼロ,,,\"1,009,780\"", ",");
    const out = buildStatementLines(rows, { ...DEFAULT_PROFILE, header_rows: 1, date_col: 0, description_col: 1, in_col: 2, out_col: 3, balance_col: 4 });
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatchObject({ booked_on: "2026-09-05", description: "振込 ヤマダ", amount: 10000, balance_after: 1010000 });
    expect(out.lines[1]).toMatchObject({ booked_on: "2026-09-06", amount: -220, balance_after: 1009780 });
    expect(out.skipped_rows).toBe(1);
    expect(out.problems).toEqual([{ row: 5, reason: expect.stringContaining("No date") }, { row: 6, reason: "No amount (neither money in nor money out)" }]);
  });
  it("a signed column keeps the sign; money out always negative", () => {
    const rows = [["d", "x", "amt"], ["2026/09/05", "a", "-300"], ["2026/09/06", "b", "300"]];
    const out = buildStatementLines(rows, { ...DEFAULT_PROFILE, signed_col: 2, description_col: 1 });
    expect(out.lines.map((l) => l.amount)).toEqual([-300, 300]);
    const outOnly = buildStatementLines([["d", "out"], ["2026/09/05", "450"]], { ...DEFAULT_PROFILE, header_rows: 1, date_col: 0, description_col: null, out_col: 1 });
    expect(outOnly.lines[0].amount).toBe(-450);
  });
  it("payload shape and the sha", async () => {
    const parsed = buildStatementLines([["2026/09/05", "a", "1000", "", "5"]], { ...DEFAULT_PROFILE, header_rows: 0, in_col: 2, out_col: 3, balance_col: 4 });
    const p = importPayload("1101", "smbc.csv", "ab".repeat(32), { ...DEFAULT_PROFILE, account_code: "1101", in_col: 2, out_col: 3, balance_col: 4 }, parsed);
    expect(p).toMatchObject({ account_code: "1101", file_name: "smbc.csv", file_sha256: "ab".repeat(32) });
    expect((p.profile as Record<string, unknown>).account_code).toBeUndefined();
    expect((p.lines as Record<string, unknown>[])[0]).toEqual({ booked_on: "2026-09-05", description: "a", amount: "1000.00", balance_after: "5.00", raw: ["2026/09/05", "a", "1000", "", "5"] });
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

const baseRec: BankRec = {
  account: "1101", name: "SMBC", name_ja: "普通預金 三井住友", currency: "JPY", is_cash: false, month: "2026-08-01", month_end: "2026-08-31",
  ledger_closing_native: 1048000, ledger_closing_jpy: 1048000, in_transit_native: 0, statement_closing: 1059780, statement_closing_source: "statement",
  reconciliation: null, can_post: true, profile: null, imports: [], matched_count: 2, ignored: [],
  unmatched_statement: [{ id: "s1", booked_on: "2026-08-11", description: "x", amount: 12000, balance_after: null, candidates: [] }],
  unmatched_ledger: [{ journal_line_id: "j1", journal_no: 9, entry_date: "2026-08-10", source_type: "payment", description: "p", memo: null, signed_amount: 12000, signed_jpy: 12000, customer_id: null, account_id: null, cash_order_id: null, expense_id: null },
                     { journal_line_id: "j2", journal_no: 10, entry_date: "2026-08-30", source_type: "payment", description: "late", memo: null, signed_amount: 5000, signed_jpy: 5000, customer_id: null, account_id: null, cash_order_id: null, expense_id: null }],
};

describe("controls — sign-off rules", () => {
  it("lists what blocks a bank account", () => {
    expect(signOffBlockers(baseRec, null)).toEqual(["Type (or import) the statement closing balance.", "1 statement line not matched or ignored.", "1 Hub entry dated before the last five days of the month is not on the statement."]);
    expect(signOffBlockers(baseRec, 1059780)[0]).toBe("Difference +¥11,780 between the statement and the ledger.");
    expect(signOffBlockers({ ...baseRec, unmatched_statement: [], unmatched_ledger: [baseRec.unmatched_ledger[1]] }, 1048000)).toEqual([]);
    const transit = { ...baseRec, unmatched_statement: [], unmatched_ledger: [baseRec.unmatched_ledger[1]], in_transit_native: 5000 };
    expect(expectedClosing(transit)).toBe(1043000);
    expect(signOffBlockers(transit, 1043000)).toEqual([]);
    expect(signOffBlockers(transit, 1048000)[0]).toBe("Difference +¥5,000 between the statement and the ledger (after in-transit items).");
  });
  it("cash accounts need only the count; a difference gets a hint, never a posting", () => {
    const cash: BankRec = { ...baseRec, account: "1010", name: "Cash on hand - Japan", is_cash: true, ledger_closing_native: 20000, ledger_closing_jpy: 20000, statement_closing: null, statement_closing_source: null };
    expect(signOffBlockers(cash, null)).toEqual(["Type the counted cash."]);
    expect(signOffBlockers(cash, 20000)).toEqual([]);
    expect(cashAdjustmentHint(cash, 20000)).toBeNull();
    expect(cashAdjustmentHint(cash, 20500)).toMatch(/Cash over by ¥500: a manual journal Dr 1010 Cash on hand - Japan \/ Cr 4900/);
    expect(cashAdjustmentHint(cash, 19000)).toMatch(/Cash short by ¥1,000: a manual journal Dr 6900 .* \/ Cr 1010/);
  });
  it("signed money formatting", () => {
    expect(formatSigned(-440, "JPY")).toBe("−¥440");
    expect(formatSigned(12000, "JPY")).toBe("+¥12,000");
    expect(formatSigned(0, "JPY")).toBe("¥0");
    expect(formatSigned(-1500.5, "PHP")).toBe("−₱1,500.50");
  });
});

describe("controls — checks and readiness presentation", () => {
  const issues: CheckIssue[] = [
    { kind: "unposted", severity: "error", ref: null, count: 2, label: "2 events", link: { view: "journals" } },
    { kind: "month_open", severity: "warning", ref: "2026-08", count: 1, label: "August open", link: { view: "periods", month: "2026-08" } },
    { kind: "reconciliation", severity: "warning", ref: "2026-08", count: 1, label: "SMBC", link: { view: "bankrec", month: "2026-08" } },
    { kind: "expense_draft", severity: "warning", ref: null, count: 3, label: "drafts", link: { view: "expenses" } },
  ];
  it("groups, links and labels every kind", () => {
    const g = groupIssues(issues);
    expect(g.errors).toHaveLength(1); expect(g.warnings).toHaveLength(3);
    expect(issueHref(issues[0])).toBe("/finance?tab=ledger&view=journals");
    expect(issueHref(issues[2])).toBe("/finance?tab=ledger&view=bankrec&month=2026-08");
    expect(issueHref(issues[3])).toBe("/finance?tab=expenses");
    for (const k of Object.keys(CHECK_KIND_LABEL)) expect(CHECK_KIND_LABEL[k as keyof typeof CHECK_KIND_LABEL].action.length).toBeGreaterThan(10);
  });
  it("normalises runs and the status line", () => {
    const c = normaliseChecks({ can_post: true, latest: { id: "r1", ran_at: "2026-10-26T16:10:00Z", trigger: "cron", errors: "0", warnings: "3", bell_rung: true, issues: issues.slice(1) }, runs: [{ id: "r1", ran_at: "2026-10-26T16:10:00Z", trigger: "cron", errors: 0, warnings: 3, bell_rung: true }] });
    expect(c.latest?.issues).toHaveLength(3);
    expect(c.runs[0].issues).toBeUndefined();
    expect(lastCheckLabel(c.latest, new Date("2026-10-27T03:00:00Z"))).toBe("Checked today 01:10 · 3 warnings");
    expect(lastCheckLabel({ ...c.latest!, errors: 2 }, new Date("2026-10-29T03:00:00Z"))).toBe("Checked 2 days ago · 2 errors, 3 warnings");
    expect(lastCheckLabel({ ...c.latest!, warnings: 0 }, new Date("2026-10-28T03:00:00Z"))).toBe("Checked yesterday · all clear");
    expect(lastCheckLabel(null)).toBe("Never checked");
  });
  it("readiness items read like a checklist; errors first", () => {
    const r = normaliseReadiness({ period_start: "2026-08-01", period_end: "2026-08-31", errors: 1, warnings: 3, can_close: false, unposted_events: 2, posting_failed: 1, dry_run: true, unbalanced_journals: 0, duplicate_journals: 0,
      unmapped_methods: [{ spelling: "bank transfer", rows: 2, first_seen: "2026-08-01" }], expenses_without_paid_from: [], draft_expenses: 1,
      unreconciled_accounts: [{ code: "1101", name: "SMBC", name_ja: null, lines: 4, status: "none" }, { code: "1111", name: "BDO", name_ja: null, lines: 2, status: "open" }], suspense_jpy: "0" });
    const items = readinessItems(r);
    expect(items[0]).toEqual({ severity: "error", text: "The last posting run failed on 1 event" });
    expect(items.map((i) => i.severity)).toEqual(["error", "warning", "warning", "warning", "warning"]);
    expect(items[3].text).toBe("Not reconciled: 1101 SMBC, 1111 BDO");
    expect(items[4].text).toMatch(/2 events dated in or before the month not posted yet — Close posts them first/);
    expect(readinessItems({ ...r, posting_failed: 0, unposted_events: 0, unmapped_methods: [], draft_expenses: 0, unreconciled_accounts: [] })).toEqual([]);
    expect(readinessItems({ ...r, posting_failed: 0, dry_run_error: "rate_not_set" })[0]).toEqual({ severity: "error", text: "The peso rate is not set, so nothing can post" });
  });
  it("status strip and periods carry the Phase 8 fields; older servers leave them empty", () => {
    const s = normaliseStatus({ ledger_start_date: "2026-06-01", fiscal_year_start_month: "4", can_post: true, last_check: { id: "x", ran_at: "2026-10-26T16:10:00Z", trigger: "cron", errors: "1", warnings: "0", bell_rung: true },
      periods: [{ period_start: "2026-08-01", fiscal_year: 2027, status: "open", closed_at: null, closed_by: null, note: null, reconciled_accounts: "1", unreconciled_accounts: "2" }] });
    expect(s.last_check).toMatchObject({ errors: 1, trigger: "cron" });
    expect(s.periods[0]).toMatchObject({ reconciled_accounts: 1, unreconciled_accounts: 2 });
    const old = normaliseStatus({ periods: [{ period_start: "2026-08-01", fiscal_year: 2027, status: "open", closed_at: null, closed_by: null, note: null }] });
    expect(old.last_check).toBeNull();
    expect(old.periods[0].reconciled_accounts).toBeUndefined();
  });
  it("bank rec normaliser", () => {
    const r = normaliseBankRec({ account: "1101", name: "SMBC", currency: "JPY", is_cash: false, month: "2026-08-01", month_end: "2026-08-31", ledger_closing_native: "1048000", ledger_closing_jpy: "1048000", statement_closing: null, statement_closing_source: null,
      reconciliation: { account_code: "1101", month_start: "2026-08-01", statement_closing: "1048000", difference: "0", unmatched_statement: 0, unmatched_ledger: 0, status: "reconciled", note: null, reconciled_at: "2026-10-26T00:00:00Z" },
      can_post: false, profile: { account_code: "1101", delimiter: ",", header_rows: "1", date_col: "0", date_format: "ymd", description_col: 1, in_col: 2, out_col: 3, signed_col: null, balance_col: null, encoding: "shift_jis" },
      imports: [], matched_count: "4", ignored: [], unmatched_statement: [{ id: "a", booked_on: "2026-08-31", description: "fee", amount: "-220", balance_after: null, candidates: [] }], unmatched_ledger: [] });
    expect(r.reconciliation?.status).toBe("reconciled");
    expect(r.profile).toMatchObject({ header_rows: 1, date_col: 0, in_col: 2, signed_col: null, encoding: "shift_jis" });
    expect(r.unmatched_statement[0].amount).toBe(-220);
    expect(r.matched_count).toBe(4);
  });
  it("refusal codes", () => {
    expect(controlsRefusal("duplicate_file")).toMatch(/already imported/);
    expect(controlsRefusal("unmatched_statement_lines")).toMatch(/Match or ignore/);
    expect(controlsRefusal("invalid_line_match")).toMatch(/opening balance/);
    expect(controlsRefusal("cash_has_no_statement")).toMatch(/count the drawer/);
    expect(controlsRefusal("nope")).toBeNull();
    expect(refusalCode({ message: 'period_closed: 2026-06-15 is in a closed month' })).toBe("period_closed");
    expect(expenseRefusal("period_closed")).toMatch(/closed in the ledger/);
  });
});

describe("controls — wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("tabs, URL view, readiness dialog, bell route, run.sh", () => {
    const tab = read("src/components/finance/LedgerTab.tsx");
    expect(tab).toContain('<TabsTrigger value="bankrec">Bank rec</TabsTrigger>');
    expect(tab).toContain('<TabsTrigger value="checks">');
    expect(tab).toContain('callRpc("get_close_readiness", { p_period_start: closing })');
    expect(tab).toContain("disabled={!readiness.data || !readiness.data.can_close || close.isPending}");
    expect(tab).toContain('searchParams.get("view")');
    expect(tab).toMatch(/useEffect\(\(\) => \{\s*if \(urlView && \(VIEWS as readonly string\[\]\)\.includes\(urlView\) && urlView !== view\) setView/);
    const rec = read("src/components/finance/BankRecSection.tsx");
    expect(rec).toContain("parsed.problems.length > 0 || !amountOk");
    expect(rec).toContain("const openDialog = () => { setProfile(rec.profile ?? DEFAULT_PROFILE); setFile(null); setOpen(true); };");
    expect(rec).toContain("useEffect(() => { if (initialMonth && /^\\d{4}-\\d{2}$/.test(initialMonth)) setMonth(initialMonth); }, [initialMonth]);");
    expect(tab).toContain("accounts reconciled");
    const bell = read("src/components/notifications/StaffNotificationBell.tsx");
    expect(bell).toContain("n.type === 'ledger_check'");
    expect(bell).toContain("navigate('/finance?tab=ledger&view=checks')");
    const run = read("supabase/tests/expenses/run.sh");
    expect(run).toContain("test_controls.sql");
    expect(run).toContain("test_e2e.sql");
  });
  it("migration: trigger order, cron, grants, no -- comments in bodies, live-lines view excludes reversals", () => {
    const m = read("supabase/migrations/20270107100000_expenses_controls.sql");
    expect(m).toContain("CREATE TRIGGER expenses_before_period_lock BEFORE INSERT OR UPDATE ON public.expenses");
    expect(m).toContain("cron.schedule('gl-completeness-check', '10 16 * * *'");
    expect(m).toContain("WHERE j.status = 'posted' AND j.kind <> 'reversal'");
    expect(m).toContain("j.source_date AS entry_date");
    expect(m).toContain("PERFORM pg_advisory_xact_lock(hashtext('bank_match:' || p_account));");
    expect(m).toContain("'cash_has_no_statement'");
    expect(m).toContain("IF v_run->>'ok' IS DISTINCT FROM 'true' THEN");
    expect(m).toContain("public.gl_pending_counts(v_today - 2)");
    for (const fn of ["import_bank_statement(jsonb)", "void_bank_import(uuid, text)", "auto_match_bank_lines(text, date)", "match_bank_line(uuid, uuid)", "unmatch_bank_line(uuid)", "ignore_bank_line(uuid, text)",
      "get_bank_reconciliation(text, date)", "sign_off_reconciliation(text, date, numeric, text)", "reopen_reconciliation(text, date, text)", "get_close_readiness(date)", "run_ledger_check()", "get_ledger_checks(integer)", "close_period(date, text)", "get_ledger_status(boolean)"]) {
      expect(m).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon;`);
      expect(m).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO authenticated;`);
    }
    for (const fn of ["gl_run_completeness_check(text, uuid)", "gl_auto_match(text, date, uuid)", "gl_close_readiness(date, boolean)", "gl_unmapped_methods(date)", "gl_is_money_account(text)"]) {
      expect(m).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    }
    const bodies = m.split("$fn$").filter((_, i) => i % 2 === 1);
    expect(bodies.length).toBeGreaterThan(15);
    for (const b of bodies) expect(b.split("\n").some((l) => l.trimStart().startsWith("--"))).toBe(false);
    expect(m).toContain("INSERT INTO public.staff_notifications (type, title, body, metadata)");
    expect(m).not.toMatch(/staff_notifications[^;]*¥/);
  });
});
