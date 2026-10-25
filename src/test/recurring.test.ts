import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  billPayload, billsToConfirm, olderOpenDrafts, defaultSpread, dueLabel, emptyBillForm, firstDue, formFromBill, frequencyLabel, normaliseBills,
  recurringRefusal, spreadLabel, validateBillForm, type RecurringBill,
} from "@/components/finance/recurring";
import { prepaidProblem, SOURCE_FILTERS } from "@/components/finance/expenses";

/**
 * Recurring bills + prepaid (Expenses Phase 3, owner 2026-10-25 D1–D6): the template form rules, due-date
 * preview, the "Bills to confirm" strip, and the wiring.
 */

const bill: RecurringBill = {
  id: "b1", name: "Tax accountant", category_id: "c1", category_name: "Tax accountant and legal fees", group_key: "professional",
  vendor_id: null, vendor_name: null, description: "Monthly accounting fee", currency: "JPY", amount: 33000, payment_method: "bank_transfer",
  paid_from: "1101", frequency: "monthly", due_day: 25, starts_on: "2026-06-10", ends_on: null, spread_months: null, active: true, notes: null,
  next_due_on: "2026-11-25", last_generated_on: "2026-10-25", open_draft_id: null,
};

describe("recurring bills — form", () => {
  it("validates in plain words", () => {
    const f = formFromBill(bill);
    expect(validateBillForm(f, true)).toBeNull();
    expect(validateBillForm({ ...f, name: "" }, true)).toBe("Give the bill a name.");
    expect(validateBillForm({ ...f, amount: "0" }, true)).toBe("Enter the expected amount.");
    expect(validateBillForm({ ...f, due_day: "31" }, true)).toContain("between 1 and 28");
    expect(validateBillForm({ ...f, paid_from: "" }, true)).toBe("Pick which bank or account pays this bill.");
    expect(validateBillForm({ ...f, paid_from: "", payment_method: "cash" }, true)).toBeNull();
    expect(validateBillForm({ ...f, paid_from: "" }, false)).toBeNull();
    expect(validateBillForm({ ...f, ends_on: "2026-01-01" }, true)).toBe("The end date is before the start date.");
    expect(validateBillForm({ ...f, spread: true, spread_months: "40" }, true)).toBe("Spread over 2 to 36 months.");
  });
  it("sends the server shape and suggests a natural spread", () => {
    const p = billPayload({ ...formFromBill(bill), spread: true, spread_months: "12", ends_on: "" });
    expect(p).toMatchObject({ id: "b1", amount: "33000", due_day: 25, spread_months: 12, ends_on: null, paid_from: "1101" });
    expect(billPayload(emptyBillForm("2026-10-25")).spread_months).toBeNull();
    expect(defaultSpread("yearly")).toBe(12);
    expect(defaultSpread("quarterly")).toBe(3);
  });
  it("previews the first due date like the server", () => {
    expect(firstDue("2026-06-10", 25)).toBe("2026-06-25");
    expect(firstDue("2026-06-10", 5)).toBe("2026-07-05");
    expect(firstDue("2026-12-20", 1)).toBe("2027-01-01");
  });
  it("describes a bill's state", () => {
    expect(dueLabel(bill, "2026-10-26")).toBe("Next 25 Nov 2026");
    expect(dueLabel({ ...bill, next_due_on: "2026-10-25" }, "2026-10-26")).toContain("Due");
    expect(dueLabel({ ...bill, open_draft_id: "e1" }, "2026-10-26")).toContain("waiting for your confirmation");
    expect(dueLabel({ ...bill, active: false }, "2026-10-26")).toBe("Inactive");
    expect(frequencyLabel("quarterly")).toBe("Every 3 months");
    expect(spreadLabel(12)).toBe("Spread over 12 months");
    expect(normaliseBills([{ ...bill, amount: "33000", due_day: "25", active: true }])[0].amount).toBe(33000);
    expect(recurringRefusal("already_generated")).toContain("already has an expense");
    expect(recurringRefusal("amount_too_small_to_spread")).toContain("too small");
    expect(recurringRefusal("23505")).toBe("");
    expect(olderOpenDrafts([{ open_draft_id: "a" }, { open_draft_id: "b" }, { open_draft_id: null }], new Set(["a"]))).toBe(1);
  });
});

describe("recurring bills — expenses tab", () => {
  it("lists recurring drafts as bills to confirm, oldest first", () => {
    const rows = [
      { id: "1", source: "recurring", status: "draft", expense_date: "2026-10-25" },
      { id: "2", source: "manual", status: "draft", expense_date: "2026-10-01" },
      { id: "3", source: "recurring", status: "approved", expense_date: "2026-10-05" },
      { id: "4", source: "recurring", status: "draft", expense_date: "2026-10-05" },
    ];
    expect(billsToConfirm(rows).map((r) => r.id)).toEqual(["4", "1"]);
    expect(SOURCE_FILTERS.some((s) => s.value === "recurring")).toBe(true);
    expect(prepaidProblem("")).toBeNull();
    expect(prepaidProblem("12")).toBeNull();
    expect(prepaidProblem("1")).toBe("Spread over 2 to 36 months.");
  });
  it("wiring: dialog mounted, prepaid saved after the upsert, ledger knows the release event", () => {
    const read = (p: string) => readFileSync(p, "utf8");
    const tab = read("src/components/finance/ExpensesTab.tsx");
    expect(tab).toContain("<RecurringBillsDialog");
    expect(tab).toContain('callRpc("set_expense_prepaid"');
    expect(tab).toContain('data-testid="bills-to-confirm"');
    expect(read("src/components/finance/ledger.ts")).toContain('expense_amortisation: "Prepaid release"');
    const sql = read("supabase/migrations/20270102100000_expenses_recurring_prepaid.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.expense_recurring_bills");
    expect(sql).toContain("cron.schedule('expenses-recurring', '20 15 * * *'");
    expect(sql).toContain("WHILE v_next <= v_as_of AND (b.ends_on IS NULL OR v_next <= b.ends_on) LOOP");
    expect(sql).toContain("amount_too_small_to_spread");
    expect(sql).toContain("(date_trunc('month', v_old.last_generated_on) + interval '1 month')::date");
    const gl = read("supabase/migrations/20270101100000_general_ledger_core.sql");
    expect(gl).toContain("'jpy', e.amount_jpy");
    expect(gl).toContain("SELECT 'expense_amortisation'");
    expect(gl).toContain("CASE WHEN e.prepaid_months IS NOT NULL THEN '1400'");
    for (const b of (sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [])) expect(b).not.toMatch(/^\s*--/m);
  });
});
