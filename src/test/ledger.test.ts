import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type LedgerStatus, type TrialBalanceRow,
  emptyManualForm, fiscalYearLabel, fiscalYearMonths, fiscalYearOf, fiscalYearRange, formatNative, formatYen, lastRunLabel,
  ledgerRefusal, lineYen, manualPayload, manualTotals, naturalBalance, normaliseJournals, normaliseStatus, postingSummary,
  profitSummary, quarterRange, rangeFor, sourceLink, trialBalanceTotals, validateManualForm,
} from "@/components/finance/ledger";
import { paidFromProblem } from "@/components/finance/expenses";

/**
 * Finance → Ledger (Expenses Phase 2b, owner 2026-10-25): fiscal-year math (May–April), yen conversion,
 * the manual-journal form rules, status wording, and the page wiring.
 */

describe("ledger — fiscal year May to April", () => {
  it("names the year by when it ends", () => {
    expect(fiscalYearOf("2026-05")).toBe(2027);
    expect(fiscalYearOf("2026-04")).toBe(2026);
    expect(fiscalYearOf("2026-06")).toBe(2027);
    expect(fiscalYearOf("2027-01")).toBe(2027);
    expect(fiscalYearOf("2026-01", 1)).toBe(2026);
  });
  it("spans the right dates", () => {
    expect(fiscalYearRange(2027)).toEqual({ from: "2026-05-01", to: "2027-04-30" });
    expect(fiscalYearLabel(2027)).toBe("FY2027 (May 2026 – Apr 2027)");
    expect(fiscalYearMonths(2027)[0]).toBe("2026-05");
    expect(fiscalYearMonths(2027)[11]).toBe("2027-04");
    expect(quarterRange(2027, 1)).toEqual({ from: "2026-05-01", to: "2026-07-31" });
    expect(quarterRange(2027, 4)).toEqual({ from: "2027-02-01", to: "2027-04-30" });
    expect(rangeFor("month", "2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "February 2026" });
    expect(rangeFor("quarter", "2026-10").label).toBe("Q2 FY2027");
    expect(rangeFor("fy", "2026-10").from).toBe("2026-05-01");
  });
});

describe("ledger — money", () => {
  it("formats yen and pesos", () => {
    expect(formatYen(1234567)).toBe("¥1,234,567");
    expect(formatYen(-5)).toBe("−¥5");
    expect(formatNative(1234.5, "PHP")).toBe("₱1,234.50");
  });
  it("converts peso lines at the one system rate", () => {
    expect(lineYen({ key: "a", account: "6600", side: "dr", amount: "42000", currency: "PHP", memo: "" }, 0.42)).toBe(100000);
    expect(lineYen({ key: "a", account: "6600", side: "dr", amount: "42000", currency: "PHP", memo: "" }, null)).toBeNull();
    expect(lineYen({ key: "a", account: "6600", side: "dr", amount: "1000", currency: "JPY", memo: "" }, null)).toBe(1000);
  });
  it("reads balances the accountant's way", () => {
    expect(naturalBalance({ kind: "asset", contra: false, closing_jpy: 500 })).toBe(500);
    expect(naturalBalance({ kind: "revenue", contra: false, closing_jpy: -800 })).toBe(800);
    expect(naturalBalance({ kind: "revenue", contra: true, closing_jpy: 100 })).toBe(100);
    expect(naturalBalance({ kind: "liability", contra: false, closing_jpy: -300 })).toBe(300);
  });
  it("totals a trial balance and a simple P&L", () => {
    const rows: TrialBalanceRow[] = [
      { code: "1102", name: "Rakuten", kind: "asset", contra: false, opening_jpy: 0, debit_jpy: 100000, credit_jpy: 3000, closing_jpy: 97000 },
      { code: "4100", name: "Sales", kind: "revenue", contra: false, opening_jpy: 0, debit_jpy: 0, credit_jpy: 100000, closing_jpy: -100000 },
      { code: "4150", name: "Reversals", kind: "revenue", contra: true, opening_jpy: 0, debit_jpy: 10000, credit_jpy: 0, closing_jpy: 10000 },
      { code: "5400", name: "Carrier", kind: "cogs", contra: false, opening_jpy: 0, debit_jpy: 2000, credit_jpy: 0, closing_jpy: 2000 },
      { code: "6500", name: "Tech", kind: "expense", contra: false, opening_jpy: 0, debit_jpy: 3000, credit_jpy: 0, closing_jpy: 3000 },
      { code: "1200", name: "Receivable", kind: "asset", contra: false, opening_jpy: 0, debit_jpy: 0, credit_jpy: 12000, closing_jpy: -12000 },
    ];
    expect(trialBalanceTotals(rows)).toEqual({ debit: 115000, credit: 115000, balanced: true });
    expect(profitSummary(rows)).toEqual({ revenue: 90000, cogs: 2000, expenses: 3000, gross: 88000, operating: 85000 });
  });
});

describe("ledger — manual journal form", () => {
  const today = "2026-10-25";
  const base = () => {
    const f = emptyManualForm(today);
    f.description = "Owner capital";
    f.lines[0] = { key: "a", account: "1102", side: "dr", amount: "100000", currency: "JPY", memo: "" };
    f.lines[1] = { key: "b", account: "3000", side: "cr", amount: "100000", currency: "JPY", memo: "" };
    return f;
  };
  it("balances in yen across currencies", () => {
    const f = base();
    f.lines[1] = { key: "b", account: "3000", side: "cr", amount: "42000", currency: "PHP", memo: "" };
    expect(manualTotals(f, 0.42)).toEqual({ debit: 100000, credit: 100000, balanced: true, unknownYen: false });
    expect(manualTotals(f, null).unknownYen).toBe(true);
  });
  it("explains every refusal in plain words", () => {
    expect(validateManualForm(base(), 0.42, "2026-06-01", today, [])).toBeNull();
    expect(validateManualForm(base(), 0.42, null, today, [])).toBe("The ledger has no start date yet.");
    expect(validateManualForm({ ...base(), entry_date: "2026-05-20" }, 0.42, "2026-06-01", today, [])).toContain("before the ledger start");
    expect(validateManualForm({ ...base(), entry_date: "2026-11-01" }, 0.42, "2026-06-01", today, [])).toBe("The date can't be in the future.");
    expect(validateManualForm({ ...base(), entry_date: "2026-07-10" }, 0.42, "2026-06-01", today, ["2026-07-01"])).toContain("July 2026 is closed");
    expect(validateManualForm({ ...base(), kind: "opening" }, 0.42, "2026-06-01", today, [])).toContain("Opening balances are dated on the ledger start");
    expect(validateManualForm({ ...base(), description: "x" }, 0.42, "2026-06-01", today, [])).toContain("Describe the entry");
    const bad = base(); bad.lines[1].amount = "90000";
    expect(validateManualForm(bad, 0.42, "2026-06-01", today, [])).toBe("Debits (¥100,000) and credits (¥90,000) must match in yen.");
    const dec = base(); dec.lines[0].amount = "100.5";
    expect(validateManualForm(dec, 0.42, "2026-06-01", today, [])).toBe("Yen amounts are whole yen.");
  });
  it("sends the server shape", () => {
    const p = manualPayload(base());
    expect(p.lines[0]).toEqual({ a: "1102", side: "dr", amt: "100000", cur: "JPY", memo: undefined });
    expect(p.kind).toBe("manual");
    expect(ledgerRefusal("unbalanced")).toContain("must match");
    expect(ledgerRefusal("auto_journal_follows_source")).toContain("Automatic journals follow their source");
    expect(ledgerRefusal("23505")).toBe("");
  });
});

describe("ledger — status and journals", () => {
  const status = (over: Partial<Record<string, unknown>>) => normaliseStatus({
    ledger_start_date: "2026-06-01", fiscal_year_start_month: "5", php_jpy_rate: "0.42", can_post: true, can_close: true, can_admin: true,
    pending: { posted: "3", reversed: "1", moved: 0, pending: "4" }, last_run: null, journal_count: "120", moved_count: 0,
    unmapped_methods: [{ spelling: "mystery", rows: "2", first_seen: "2026-08-01" }], expenses_without_paid_from: [], periods: [], ...over,
  });
  it("normalises jsonb strings and words the strip", () => {
    const s: LedgerStatus = status({});
    expect(s.pending?.posted).toBe(3);
    expect(s.unmapped_methods[0].rows).toBe(2);
    expect(postingSummary(s)).toBe("3 to post, 1 to reverse · runs nightly at 00:40 or press Post now");
    expect(postingSummary(status({ pending: { posted: 0, reversed: 0, moved: 0, pending: 0 } }))).toBe("Up to date · 120 journals");
    expect(postingSummary(status({ pending: null }))).toBe("120 journals · posts nightly at 00:40, or press Post now");
    expect(lastRunLabel({ id: "r", started_at: "2026-10-24T15:40:00Z", finished_at: null, trigger: "cron", posted: 5, reversed: 0, moved: 0, skipped: 0, failed: 2 })).toContain("2 FAILED");
    expect(postingSummary(status({ ledger_start_date: null }))).toContain("Ledger not started");
    expect(lastRunLabel(null)).toBe("No posting run yet");
    expect(lastRunLabel({ id: "r", started_at: "2026-10-24T15:40:00Z", finished_at: null, trigger: "cron", posted: 5, reversed: 0, moved: 1, skipped: 0 }))
      .toContain("(nightly): 5 posted, 0 reversed, 1 moved to an open month");
  });
  it("links a journal to its source", () => {
    const [j] = normaliseJournals([{ id: "j", journal_no: "7", total_jpy: "100", source_date: "2026-09-06", lines: [{ id: "l", debit: "100", credit: "0", debit_jpy: "100", credit_jpy: "0", expense_id: "e1", account_id: null, cash_order_id: null }] }]);
    expect(j.journal_no).toBe(7);
    expect(sourceLink(j)).toBe("/finance?tab=expenses&month=2026-09");
    expect(sourceLink({ source_date: "2026-09-06", lines: [{ ...j.lines[0], expense_id: null, account_id: "p1" }] })).toBe("/accounts/p1");
    expect(sourceLink({ source_date: "2026-09-06", lines: [] })).toBeNull();
  });
});

describe("ledger — expenses dialog Paid from", () => {
  it("requires an account unless paid in cash, and only once the ledger exists", () => {
    expect(paidFromProblem({ payment_method: "bank_transfer", paid_from: "" }, true)).toBe("Pick which bank or account paid this.");
    expect(paidFromProblem({ payment_method: "cash", paid_from: "" }, true)).toBeNull();
    expect(paidFromProblem({ payment_method: "card", paid_from: "1102" }, true)).toBeNull();
    expect(paidFromProblem({ payment_method: "card", paid_from: "" }, false)).toBeNull();
  });
});

describe("ledger — wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Finance, sidebar and Matrix carry the Ledger tab and its three keys", () => {
    const fin = read("src/pages/Finance.tsx");
    expect(fin).toContain("const showLedger = can('view_ledger');");
    expect(fin).toContain("tab === 'ledger' && <LedgerTab />");
    expect(read("src/components/layout/AppSidebar.tsx")).toContain("{ label: 'Ledger', tab: 'ledger', permFilter: (can) => can('view_ledger') }");
    const matrix = read("src/components/settings/PermissionMatrixTab.tsx");
    for (const k of ["view_ledger", "post_journal", "close_period"]) expect(matrix).toContain(`key: '${k}'`);
    const tab = read("src/components/finance/ExpensesTab.tsx");
    expect(tab).toContain('callRpc("set_expense_paid_from"');
    expect(tab).toContain("paidFromProblem(form, paidFromList !== null)");
  });
  it("migration: derived immutable ledger, one Sales account, May–April, 00:40 JST cron", () => {
    const sql = read("supabase/migrations/20270101100000_general_ledger_core.sql");
    expect(sql).toContain("('4100', 'Sales',");
    expect(sql).not.toContain("'4110'");
    expect(sql).toContain("('fiscal_year_start_month', '\"5\"'::jsonb)");
    expect(sql).toContain("gl_journals_live_source_uq");
    expect(sql).toContain("WHERE kind = 'auto' AND status = 'posted'");
    expect(sql).toContain("cron.schedule('gl-post-pending', '40 15 * * *'");
    expect(sql).toContain("JOIN first_pay fp ON fp.account_id = la.id");
    expect(sql).toContain("RETURN (v_last_closed + interval '1 month')::date;");
    expect(sql).toContain("paid_from IS DISTINCT FROM OLD.paid_from");
    // review fixes: Hub-linked store-credit redemptions post from the payment row only; close events filter on the close date
    expect(sql).toContain("t.txn_type::text = 'redeemed' AND t.account_id IS NULL AND t.cash_order_id IS NULL");
    expect(sql).toContain("BETWEEN s.start_date AND p_until");
    expect(sql).toContain("('transfer',           '1190', 'suspense'");
    expect(sql).toMatch(/EXCEPTION WHEN OTHERS THEN\s+v_failed := v_failed \+ 1;/);
    expect(sql).toContain("get_ledger_status(p_check_pending boolean DEFAULT false)");
    for (const k of ["view_ledger", "post_journal", "close_period"]) expect(sql).toContain(`'${k}'`);
    const bodies = sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [];
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toMatch(/^\s*--/m);
  });
});
