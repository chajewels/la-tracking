import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXPENSE_GROUPS, canEnterManually, cleanAmountInput, detailLines, monthFromSearch, receiptContentType, emptyExpenseForm, expensePayload, expenseRefusal, filterExpenses,
  formatAmount, monthKeyTokyo, monthLabel, normaliseBook, previewJpy, receiptPath, receiptProblem,
  shiftMonth, todayTokyo, totalsByGroup, validateExpenseForm, type Expense,
} from "@/components/finance/expenses";

/**
 * Finance → Expenses, Phase 1 (owner 2026-10-25; migration 20261230100000_expenses_ledger.sql).
 * The tab's rules: one peso rate (divide, never multiply), only approved rows count,
 * the form's checks, the receipt path the database accepts, and the page wiring.
 */

function exp(over: Partial<Expense>): Expense {
  return {
    id: "e", expense_date: "2026-10-20", category_id: "c", category_name: "Photoroom", group_key: "tech",
    vendor_id: null, vendor_name: null, description: "x", currency: "JPY", amount: 1000, fx_php_per_jpy: null,
    amount_jpy: 1000, payment_method: "card", receipt_path: null, status: "approved", source: "manual",
    notes: null, details: null, approved_at: null, voided_at: null, void_reason: null, created_at: "2026-10-20T00:00:00Z",
    ...over,
  };
}

describe("expenses — money", () => {
  it("converts pesos to yen by DIVIDING by the rate (CLAUDE.md currency standard)", () => {
    expect(previewJpy(10000, "PHP", 0.42)).toBe(23810);
    expect(previewJpy(10000, "PHP", 0.42)).not.toBe(4200);
    expect(previewJpy(15000, "JPY", 0.42)).toBe(15000);
    expect(previewJpy(10000, "PHP", null)).toBeNull();
    expect(previewJpy(0, "JPY", 0.42)).toBeNull();
  });

  it("counts approved only; drafts separate; void nowhere", () => {
    const t = totalsByGroup([
      exp({ id: "1", amount_jpy: 1000, status: "approved", group_key: "tech" }),
      exp({ id: "2", amount_jpy: 500, status: "draft", group_key: "tech" }),
      exp({ id: "3", amount_jpy: 9999, status: "void", group_key: "tech" }),
      exp({ id: "4", amount_jpy: 23810, status: "approved", group_key: "people" }),
    ]);
    expect(t.approvedJpy).toBe(24810);
    expect(t.draftJpy).toBe(500);
    const tech = t.groups.find((g) => g.key === "tech")!;
    expect(tech).toMatchObject({ approvedJpy: 1000, draftJpy: 500, approvedCount: 1, draftCount: 1 });
    expect(t.groups).toHaveLength(8);
  });

  it("formats yen whole and pesos with up to two decimals", () => {
    expect(formatAmount(15000, "JPY")).toBe("¥15,000");
    expect(formatAmount(10000, "PHP")).toBe("₱10,000");
    expect(formatAmount(1234.5, "PHP")).toBe("₱1,234.50");
  });

  it("normalises numeric strings from jsonb", () => {
    const b = normaliseBook({
      month: "2026-10-01", can_manage: true, can_approve: false, php_jpy_rate: "0.42",
      categories: [], vendors: [], expenses: [{ id: "a", amount: "10000.00", amount_jpy: "23810", fx_php_per_jpy: "0.420000" }],
    });
    expect(b.php_jpy_rate).toBe(0.42);
    expect(b.expenses[0]).toMatchObject({ amount: 10000, amount_jpy: 23810, fx_php_per_jpy: 0.42 });
    expect(b.can_manage).toBe(true);
    expect(b.can_approve).toBe(false);
  });
});

describe("expenses — groups and months", () => {
  it("keeps the owner's eight groups in her order", () => {
    expect(EXPENSE_GROUPS.map((g) => g.key)).toEqual([
      "people", "cost_of_goods", "marketing", "payment_fees", "shipping", "tech", "office", "professional",
    ]);
  });

  it("uses Japan time for the month and today", () => {
    const lateUtc = new Date("2026-10-31T16:30:00Z"); // 01:30 on 1 Nov in Tokyo
    expect(monthKeyTokyo(lateUtc)).toBe("2026-11");
    expect(todayTokyo(lateUtc)).toBe("2026-11-01");
  });

  it("moves across year ends", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthLabel("2026-10")).toBe("October 2026");
  });
});

describe("expenses — form", () => {
  it("refuses an incomplete form with plain words", () => {
    const f = emptyExpenseForm("2026-10-25");
    expect(validateExpenseForm(f)).toBe("Pick a category.");
    expect(validateExpenseForm({ ...f, category_id: "c" })).toBe("Write what it was for.");
    expect(validateExpenseForm({ ...f, category_id: "c", description: "Vercel" })).toBe("Enter the amount.");
    expect(validateExpenseForm({ ...f, category_id: "c", description: "Vercel", amount: "10.5" })).toBe("Yen amounts are whole yen.");
    expect(validateExpenseForm({ ...f, category_id: "c", description: "Vercel", amount: "2400" })).toBeNull();
    expect(validateExpenseForm({ ...f, category_id: "c", description: "x", currency: "PHP", amount: "10.5" })).toBeNull();
  });

  it("cleans amount input per currency", () => {
    expect(cleanAmountInput("¥15,000.7", "JPY")).toBe("150007");
    expect(cleanAmountInput("1,234.567", "PHP")).toBe("1234.56");
    expect(cleanAmountInput("12.3.4", "PHP")).toBe("12.34");
  });

  it("sends a new vendor name only when no vendor is picked", () => {
    const base = { ...emptyExpenseForm("2026-10-25"), category_id: "c", description: " Vercel Oct ", amount: "2400" };
    expect(expensePayload({ ...base, new_vendor_name: " Vercel " })).toMatchObject({ vendor_id: null, new_vendor_name: "Vercel", description: "Vercel Oct" });
    expect(expensePayload({ ...base, vendor_id: "v1", new_vendor_name: "ignored" })).toMatchObject({ vendor_id: "v1", new_vendor_name: null });
  });

  it("explains every server refusal and never shows a raw database code", () => {
    for (const code of ["permission_denied", "not_draft", "reason_required", "invalid_amount", "already_void",
      "invalid_receipt_path", "rate_not_set", "category_booked_automatically"]) {
      expect(expenseRefusal(code)).not.toBe(code);
    }
    expect(expenseRefusal("23514")).toBe("Something went wrong. Try again in a moment.");
    expect(expenseRefusal("23505")).not.toContain("23505");
  });

  it("keeps Staff payroll and Sales commission out of manual entry (Phase 2 books them)", () => {
    expect(canEnterManually({ active: true, system_key: "payroll" })).toBe(false);
    expect(canEnterManually({ active: true, system_key: "commission" })).toBe(false);
    expect(canEnterManually({ active: true, system_key: "bonus" })).toBe(true);
    expect(canEnterManually({ active: true, system_key: "uncategorised" })).toBe(false);
    expect(canEnterManually({ active: true, system_key: null })).toBe(true);
    expect(canEnterManually({ active: false, system_key: null })).toBe(false);
  });
});

describe("expenses — receipts", () => {
  it("builds the only path shape attach_expense_receipt accepts", () => {
    const p = receiptPath("11111111-2222-3333-4444-555555555555", "Vercel Invoice #12 (Oct).pdf", 1729830000000);
    expect(p.startsWith("11111111-2222-3333-4444-555555555555/1729830000000-")).toBe(true);
    expect(p).not.toContain("..");
    expect(p).not.toMatch(/[ #()]/);
    expect(receiptPath("e", "../../etc/passwd", 1)).not.toContain("..");
  });

  it("accepts photos and PDFs up to 10 MB", () => {
    expect(receiptProblem({ type: "application/pdf", size: 1000 })).toBeNull();
    expect(receiptProblem({ type: "image/heic", size: 1000 })).toBeNull();
    expect(receiptProblem({ type: "text/html", size: 10 })).not.toBeNull();
    expect(receiptProblem({ type: "image/png", size: 11 * 1024 * 1024 })).not.toBeNull();
  });

  it("accepts HEIC when the browser reports no type (Chrome/Firefox/Windows)", () => {
    expect(receiptContentType({ type: "", name: "IMG_0001.HEIC" })).toBe("image/heic");
    expect(receiptProblem({ type: "", name: "IMG_0001.heic", size: 1000 })).toBeNull();
    expect(receiptProblem({ type: "", name: "notes.txt", size: 10 })).not.toBeNull();
  });
});

describe("expenses — filters", () => {
  it("filters by status, group and text", () => {
    const rows = [
      exp({ id: "1", description: "Vercel October", vendor_name: "Vercel", status: "draft" }),
      exp({ id: "2", description: "Payroll", group_key: "people", category_name: "Staff payroll", source: "payroll" }),
    ];
    expect(filterExpenses(rows, { status: "draft", group: "all", source: "all", search: "" }).map((e) => e.id)).toEqual(["1"]);
    expect(filterExpenses(rows, { status: "all", group: "people", source: "all", search: "" }).map((e) => e.id)).toEqual(["2"]);
    expect(filterExpenses(rows, { status: "all", group: "all", source: "all", search: "vercel" }).map((e) => e.id)).toEqual(["1"]);
    expect(filterExpenses(rows, { status: "all", group: "all", source: "payroll", search: "" }).map((e) => e.id)).toEqual(["2"]);
    expect(filterExpenses(rows, { status: "all", group: "all", source: "manual", search: "" }).map((e) => e.id)).toEqual(["1"]);
  });

  it("reads the ?month= deep link and renders booking details", () => {
    expect(monthFromSearch("?tab=expenses&month=2026-09")).toBe("2026-09");
    expect(monthFromSearch("?month=2026-13")).toBeNull();
    expect(monthFromSearch("")).toBeNull();
    const rows = detailLines({ kind: "payroll", lines: [{ name: "Ana", template: "csr", total_hours: 160, net: 12000 }] });
    expect(rows).toEqual([{ name: "Ana", meta: "CSR · 160.0 h", amount: 12000 }]);
    expect(detailLines(null)).toEqual([]);
  });
});

describe("expenses — wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("adds the Finance tab gated by the expense permissions", () => {
    const finance = read("src/pages/Finance.tsx");
    expect(finance).toContain("'vault' | 'expenses'");
    expect(finance).toContain("const showExpenses = can('manage_expenses') || can('approve_expenses');");
    expect(finance).toContain('<TabsContent value="expenses"');
    const sidebar = read("src/components/layout/AppSidebar.tsx");
    expect(sidebar).toContain("{ label: 'Expenses', tab: 'expenses', permFilter: (can) => can('manage_expenses') || can('approve_expenses') },");
  });

  it("lists both keys in the permission matrix", () => {
    const matrix = read("src/components/settings/PermissionMatrixTab.tsx");
    expect(matrix).toContain("key: 'manage_expenses'");
    expect(matrix).toContain("key: 'approve_expenses'");
  });

  it("migration: one peso rate, no fx_rates, no write policies, private bucket", () => {
    const sql = read("supabase/migrations/20261230100000_expenses_ledger.sql");
    expect(sql).toContain("key = 'php_jpy_rate'");
    expect(sql).toContain("round(NEW.amount / v_rate)");
    expect(sql).not.toMatch(/FROM\s+public\.fx_rates/);
    expect(sql).not.toMatch(/CREATE POLICY[^;]*ON public\.expenses[^;]*FOR (INSERT|UPDATE|DELETE)/);
    expect(sql).toMatch(/'expense-receipts', 'expense-receipts', false/);
    expect(sql).toContain("BEFORE TRUNCATE ON public.expenses");
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_categories, public.expense_vendors, public.expenses");
    expect(sql).toContain("c.system_key IN ('payroll', 'commission')");
    const bodies = sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [];
    expect(bodies.length).toBeGreaterThanOrEqual(6);
    for (const b of bodies) expect(b).not.toMatch(/^\s*--/m);
  });
});
