import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  type BookedMonth, type CommissionLine, type PayrollLine,
  activeBooking, bookableLines, bookedSummary, bookingProblem, bookingRefusal, dialogRows, driftWarning,
  expensesLink, formatPeso, monthProblemFor, normaliseBookedMonths, sumLines, wasVoided,
} from "@/components/finance/mark-paid";

/**
 * "Mark as paid" (Expenses Phase 2, owner 2026-10-25): the button's rules on Timesheet →
 * Cost Master and Commissions → Payout Breakdown, and the page wiring.
 */

const payroll: PayrollLine[] = [
  { user_id: "u1", name: "Ana", template: "csr", total_hours: 160, net: 12000 },
  { user_id: "u2", name: "Kaila", template: "live_admin", total_hours: 40.5, net: 7500 },
  { user_id: "u3", name: "Idle", template: "csr", total_hours: 0, net: 0 },
];
const commission: CommissionLine[] = [
  { name: "Ana", role_won: "Closer", earn: 3000, bonus: 500, total: 3500 },
  { name: "Cris", role_won: null, earn: 0, bonus: 0, total: 0 },
];
const booked = (over: Partial<BookedMonth>): BookedMonth => ({
  month_key: "2026-09", expense_id: "e1", status: "approved", amount: 19500, amount_jpy: 46429,
  expense_date: "2026-10-01", approved_at: "2026-10-01T00:00:00Z", voided_at: null, details: null, ...over,
});

describe("mark as paid — lines and totals", () => {
  it("keeps every payroll line (zero pay included) but only paid-out commission lines", () => {
    expect(bookableLines("payroll", payroll)).toHaveLength(3);
    expect(bookableLines("commission", commission).map((l) => (l as CommissionLine).name)).toEqual(["Ana"]);
  });

  it("sums what the screen shows", () => {
    expect(sumLines("payroll", payroll)).toBe(19500);
    expect(sumLines("commission", bookableLines("commission", commission))).toBe(3500);
  });

  it("repeats the screen's rows in the dialog", () => {
    expect(dialogRows("payroll", payroll)[1]).toEqual({ name: "Kaila", meta: "Live Admin · 40.5 h", amount: 7500 });
    expect(dialogRows("commission", commission)[0].meta).toBe("Closer · earn ₱3,000 · bonus ₱500");
  });
});

describe("mark as paid — when the button is allowed", () => {
  const today = "2026-10-25";
  it("refuses future months, empty months and bad dates in plain words", () => {
    expect(bookingProblem("payroll", "2026-11", payroll, today, "2026-10", today)).toBe("A future month can't be marked as paid.");
    expect(bookingProblem("commission", "2026-09", [commission[1]], today, "2026-10", today)).toBe("No payouts this month.");
    expect(bookingProblem("payroll", "2026-09", [payroll[2]], today, "2026-10", today)).toBe("The total is zero.");
    expect(bookingProblem("payroll", "2026-09", payroll, "2026-10-30", "2026-10", today)).toBe("The paid-on date can't be in the future.");
    expect(bookingProblem("payroll", "2026-09", payroll, "2026-08-31", "2026-10", today)).toBe("The paid-on date can't be before the month being paid.");
    expect(bookingProblem("payroll", "2026-09", payroll, today, "2026-10", today)).toBeNull();
    // the button only depends on the month and lines, never on the typed date
    expect(monthProblemFor("payroll", "2026-09", payroll, "2026-10")).toBeNull();
    expect(monthProblemFor("payroll", "2026-11", payroll, "2026-10")).toBe("A future month can't be marked as paid.");
    expect(bookingProblem("payroll", "2026-10", payroll, today, "2026-10", today)).toBeNull();
  });
});

describe("mark as paid — booked state", () => {
  it("finds the live booking and knows when a month was voided", () => {
    const months = [booked({ status: "void", voided_at: "2026-10-02T00:00:00Z" }), booked({ expense_id: "e2" })];
    expect(activeBooking(months, "2026-09")?.expense_id).toBe("e2");
    expect(wasVoided(months, "2026-09")).toBe(false);
    expect(wasVoided([months[0]], "2026-09")).toBe(true);
    expect(activeBooking(months, "2026-08")).toBeNull();
  });

  it("describes the booking and warns when the figures moved", () => {
    expect(bookedSummary(booked({}))).toBe("Paid on 1 Oct 2026 · ₱19,500 (≈ ¥46,429)");
    expect(driftWarning(booked({}), 19500)).toBeNull();
    expect(driftWarning(booked({}), 19800)).toContain("Booked ₱19,500 · now computes ₱19,800");
    expect(driftWarning(null, 1)).toBeNull();
    expect(expensesLink("2026-09")).toBe("/finance?tab=expenses&month=2026-09");
    // the link opens the month the expense is DATED (paid-on), where the Expenses tab lists it
    expect(expensesLink(booked({}).expense_date.slice(0, 7))).toBe("/finance?tab=expenses&month=2026-10");
    expect(formatPeso(1234.5)).toBe("₱1,234.50");
  });

  it("normalises jsonb numbers and explains refusals", () => {
    const m = normaliseBookedMonths([{ month_key: "2026-09", expense_id: "e", status: "approved", amount: "19500.00", amount_jpy: "46429", expense_date: "2026-10-01" }]);
    expect(m[0].amount).toBe(19500);
    expect(normaliseBookedMonths(null)).toEqual([]);
    expect(bookingRefusal("already_booked")).toContain("already marked as paid");
    expect(bookingRefusal("23505")).toBe("");
  });
});

describe("mark as paid — wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("Cost Master and Payout Breakdown mount the panel, gated by approve_expenses", () => {
    const ts = read("src/pages/Timesheet.tsx");
    expect(ts).toContain("const canMarkPaid = can('approve_expenses');");
    expect(ts).toContain('<MarkPaidPanel source="payroll"');
    expect(ts).toContain("canMarkPaid={canMarkPaid}");
    const cm = read("src/pages/Commissions.tsx");
    expect(cm).toContain("const canMarkPaid = can('approve_expenses');");
    expect(cm).toContain('source="commission"');
    expect(cm).toContain("onMonthChange={setSelectedMonthKey} canMarkPaid={canMarkPaid}");
    expect(cm).toContain("top_sales: a.isTopSales,");
    const panel = read("src/components/finance/MarkPaidPanel.tsx");
    expect(panel).toContain("expensesLink(booking.expense_date.slice(0, 7))");
    expect(panel).toContain("disabled={state.isLoading || !!monthProblem}");
    expect(panel).toContain("state.isError");
  });

  it("migration: one booking per month unless voided, approved at once, history refreshed", () => {
    const sql = read("supabase/migrations/20261231100000_expenses_payroll_commission.sql");
    expect(sql).toContain("e.status <> 'void'");
    expect(sql).toContain("SET status = 'approved'");
    expect(sql).toContain("INSERT INTO public.timesheet_monthly_history");
    expect(sql).toContain("ON CONFLICT (month_key)");
    expect(sql).not.toContain("timesheet_monthly_history_month_uq");
    expect(sql).toContain("p_paid_on < p_month OR p_paid_on > v_today");
    expect(sql).toContain("has_permission(v_uid, 'approve_expenses')");
    const bodies = sql.match(/\$fn\$[\s\S]*?\$fn\$/g) ?? [];
    expect(bodies.length).toBe(4);
    for (const b of bodies) expect(b).not.toMatch(/^\s*--/m);
    const p1 = read("supabase/migrations/20261230100000_expenses_ledger.sql");
    expect(p1).toContain("WHERE source_ref IS NOT NULL AND status <> 'void'");
    expect(p1).toContain("details         jsonb NULL");
  });
});
