/**
 * "Mark as paid" (Expenses Phase 2, owner 2026-10-25): the rules behind the button on
 * Timesheet → Cost Master and Commissions → Payout Breakdown, kept out of the component
 * so they can be unit-tested.
 *
 * Both figures are computed in the browser (timesheetEngine / commissionEngine), so the
 * database RPCs book_payroll_month / book_commission_month RECORD the lines the button
 * sends — one approved PHP expense per month per source, breakdown kept in
 * expenses.details (migration 20261231100000_expenses_payroll_commission.sql).
 */

import { type ExpenseStatus, formatYen, previewJpy } from "@/components/finance/expenses";

export type BookingSource = "payroll" | "commission";

export const BOOKED_MONTHS_KEY = ["expense-booked"] as const;

export interface PayrollLine {
  user_id: string;
  name: string;
  template: "csr" | "live_admin";
  total_hours: number;
  net: number;
}

export interface CommissionLine {
  name: string;
  role_won: string | null;
  earn: number;
  bonus: number;
  total: number;
  /** Top Sales (★ on the Payout Breakdown). */
  top_sales?: boolean;
}

export type BookingLine = PayrollLine | CommissionLine;

export interface BookedMonth {
  month_key: string;
  expense_id: string;
  status: ExpenseStatus;
  amount: number;
  amount_jpy: number;
  expense_date: string;
  approved_at: string | null;
  voided_at: string | null;
  details: Record<string, unknown> | null;
}

export const SOURCE_LABEL: Record<BookingSource, string> = {
  payroll: "Staff payroll",
  commission: "Sales commission",
};

export const RPC_BY_SOURCE: Record<BookingSource, string> = {
  payroll: "book_payroll_month",
  commission: "book_commission_month",
};

export function normaliseBookedMonths(raw: unknown): BookedMonth[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const r = m as Record<string, unknown>;
    return {
      month_key: String(r.month_key ?? ""),
      expense_id: String(r.expense_id ?? ""),
      status: (r.status as ExpenseStatus) ?? "draft",
      amount: Number(r.amount ?? 0),
      amount_jpy: Number(r.amount_jpy ?? 0),
      expense_date: String(r.expense_date ?? ""),
      approved_at: (r.approved_at as string | null) ?? null,
      voided_at: (r.voided_at as string | null) ?? null,
      details: (r.details as Record<string, unknown> | null) ?? null,
    };
  });
}

/** The booking that counts for a month: the non-void one, if any. */
export function activeBooking(months: BookedMonth[], monthKey: string): BookedMonth | null {
  return months.find((m) => m.month_key === monthKey && m.status !== "void") ?? null;
}

/** True when the month had a booking that was later voided and nothing replaced it. */
export function wasVoided(months: BookedMonth[], monthKey: string): boolean {
  return !activeBooking(months, monthKey) && months.some((m) => m.month_key === monthKey && m.status === "void");
}

export function sumLines(source: BookingSource, lines: BookingLine[]): number {
  const total = source === "payroll"
    ? (lines as PayrollLine[]).reduce((s, l) => s + l.net, 0)
    : (lines as CommissionLine[]).reduce((s, l) => s + l.total, 0);
  return Math.round(total * 100) / 100;
}

/** Lines the RPC accepts: payroll keeps everyone with net ≥ 0; commission keeps total > 0. */
export function bookableLines(source: BookingSource, lines: BookingLine[]): BookingLine[] {
  if (source === "payroll") return (lines as PayrollLine[]).filter((l) => Number.isFinite(l.net) && l.net >= 0);
  return (lines as CommissionLine[]).filter((l) => Number.isFinite(l.total) && l.total > 0);
}

/** Why the month itself cannot be booked (decides the button), in plain words; null when it can. */
export function monthProblemFor(source: BookingSource, monthKey: string, lines: BookingLine[], todayKey: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return "Pick a month.";
  if (monthKey > todayKey) return "A future month can't be marked as paid.";
  const ok = bookableLines(source, lines);
  if (ok.length === 0) return source === "payroll" ? "Nobody has pay this month." : "No payouts this month.";
  if (sumLines(source, ok) <= 0) return "The total is zero.";
  return null;
}

/** The full check (month + paid-on date) that decides the dialog's confirm button. */
export function bookingProblem(source: BookingSource, monthKey: string, lines: BookingLine[], paidOn: string, todayKey: string, today: string): string | null {
  const m = monthProblemFor(source, monthKey, lines, todayKey);
  if (m) return m;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return "Pick the paid-on date.";
  if (paidOn > today) return "The paid-on date can't be in the future.";
  if (paidOn < `${monthKey}-01`) return "The paid-on date can't be before the month being paid.";
  return null;
}

/** Rows ≈ what Cost Master / Payout Breakdown show, so the dialog repeats the screen. */
export function dialogRows(source: BookingSource, lines: BookingLine[]): { name: string; meta: string; amount: number }[] {
  if (source === "payroll") {
    return (lines as PayrollLine[]).map((l) => ({
      name: l.name,
      meta: `${l.template === "csr" ? "CSR" : "Live Admin"} · ${l.total_hours.toFixed(1)} h`,
      amount: l.net,
    }));
  }
  return (lines as CommissionLine[]).map((l) => ({
    name: l.name,
    meta: `${l.role_won ?? "—"}${l.top_sales ? " ★" : ""} · earn ₱${l.earn.toLocaleString("en-US")} · bonus ₱${l.bonus.toLocaleString("en-US")}`,
    amount: l.total,
  }));
}

export function formatPeso(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `₱${r.toLocaleString("en-US", { minimumFractionDigits: r % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "Paid on 1 Oct 2026 · ₱31,000.50 (≈ ¥73,811)" */
export function bookedSummary(b: BookedMonth): string {
  const [y, m, d] = b.expense_date.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `Paid on ${date} · ${formatPeso(b.amount)} (≈ ${formatYen(b.amount_jpy)})`;
}

/** Warning when the screen now computes a different total than what was booked. */
export function driftWarning(b: BookedMonth | null, currentTotal: number): string | null {
  if (!b) return null;
  if (Math.abs(b.amount - currentTotal) < 0.005) return null;
  return `Booked ${formatPeso(b.amount)} · now computes ${formatPeso(currentTotal)}. To re-book, void the expense in Finance → Expenses, then mark as paid again.`;
}

export function yenPreview(total: number, rate: number | null): string {
  const jpy = previewJpy(total, "PHP", rate);
  return jpy == null ? "" : `≈ ${formatYen(jpy)}`;
}

/** Deep link into the Expenses tab for a booked month. */
export function expensesLink(monthKey: string): string {
  return `/finance?tab=expenses&month=${monthKey}`;
}

export function bookingRefusal(code: string): string {
  switch (code) {
    case "already_booked": return "This month is already marked as paid. To re-book it, void that expense in Finance → Expenses first.";
    case "invalid_month": return "That month can't be booked (it's in the future or not a whole month).";
    case "invalid_paid_on": return "The paid-on date must be between the first day of that month and today.";
    case "invalid_lines": return "The figures could not be read. Refresh the page and try again.";
    case "invalid_category": return "The payroll / commission category is missing in Expenses. Ask an admin.";
    case "invalid_source": return "Unknown booking type.";
    default: return "";
  }
}
