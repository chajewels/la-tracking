/**
 * Recurring bills + prepaid rules (Expenses Phase 3, owner decisions 2026-10-25 D1–D6 as recommended;
 * plan claude/expenses-phase3-recurring-plan-2026-10-25.md). Pure functions, no React, no Supabase.
 */
import { type ExpenseCurrency, type PaymentMethod, cleanAmountInput, todayTokyo } from "@/components/finance/expenses";

export const RECURRING_BILLS_KEY = ["finance", "expenses", "recurring-bills"] as const;

export type Frequency = "monthly" | "quarterly" | "yearly";
export const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: "monthly", label: "Every month" },
  { value: "quarterly", label: "Every 3 months" },
  { value: "yearly", label: "Every year" },
];
export function frequencyLabel(f: string): string { return FREQUENCIES.find((x) => x.value === f)?.label ?? f; }

export type RecurringBill = {
  id: string; name: string; category_id: string; category_name: string; group_key: string;
  vendor_id: string | null; vendor_name: string | null; description: string;
  currency: ExpenseCurrency; amount: number; payment_method: PaymentMethod; paid_from: string | null;
  frequency: Frequency; due_day: number; starts_on: string; ends_on: string | null;
  spread_months: number | null; active: boolean; notes: string | null;
  next_due_on: string; last_generated_on: string | null; open_draft_id: string | null;
};

export type RecurringState = { available: true; today: string; bills: RecurringBill[] } | { available: false };

export function normaliseBills(raw: unknown): RecurringBill[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((b) => ({
    ...(b as unknown as RecurringBill),
    amount: Number(b.amount),
    due_day: Number(b.due_day),
    spread_months: b.spread_months == null ? null : Number(b.spread_months),
    active: b.active === true,
  }));
}

export interface BillForm {
  id: string | null;
  name: string;
  category_id: string;
  vendor_id: string;
  description: string;
  currency: ExpenseCurrency;
  amount: string;
  payment_method: PaymentMethod;
  paid_from: string;
  frequency: Frequency;
  due_day: string;
  starts_on: string;
  ends_on: string;
  spread: boolean;
  spread_months: string;
  notes: string;
}

export function emptyBillForm(today: string = todayTokyo()): BillForm {
  return {
    id: null, name: "", category_id: "", vendor_id: "", description: "", currency: "JPY", amount: "",
    payment_method: "bank_transfer", paid_from: "", frequency: "monthly", due_day: "1", starts_on: today, ends_on: "",
    spread: false, spread_months: "12", notes: "",
  };
}

export function formFromBill(b: RecurringBill): BillForm {
  return {
    id: b.id, name: b.name, category_id: b.category_id, vendor_id: b.vendor_id ?? "", description: b.description,
    currency: b.currency, amount: String(b.amount), payment_method: b.payment_method, paid_from: b.paid_from ?? "",
    frequency: b.frequency, due_day: String(b.due_day), starts_on: b.starts_on, ends_on: b.ends_on ?? "",
    spread: b.spread_months != null, spread_months: String(b.spread_months ?? 12), notes: b.notes ?? "",
  };
}

/** Months a payment is naturally spread over for a frequency (what the switch suggests). */
export function defaultSpread(f: Frequency): number { return f === "yearly" ? 12 : f === "quarterly" ? 3 : 2; }

export function validateBillForm(f: BillForm, paidFromRequired: boolean): string | null {
  if (f.name.trim().length < 1) return "Give the bill a name.";
  if (f.name.trim().length > 120) return "The name is too long (120 characters).";
  if (!f.category_id) return "Pick a category.";
  if (f.description.trim().length < 1) return "Describe the bill (this becomes the expense text).";
  if (f.description.trim().length > 500) return "The description is too long (500 characters).";
  const amt = cleanAmountInput(f.amount, f.currency);
  if (!amt || Number(amt) <= 0) return "Enter the expected amount.";
  if (f.currency === "JPY" && !/^\d+$/.test(amt)) return "Yen amounts are whole yen.";
  if (paidFromRequired && f.payment_method !== "cash" && !f.paid_from) return "Pick which bank or account pays this bill.";
  const day = Number(f.due_day);
  if (!Number.isInteger(day) || day < 1 || day > 28) return "The due day must be between 1 and 28 (so every month has it).";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.starts_on)) return "Pick the start date.";
  if (f.ends_on && f.ends_on < f.starts_on) return "The end date is before the start date.";
  if (f.spread) {
    const n = Number(f.spread_months);
    if (!Number.isInteger(n) || n < 2 || n > 36) return "Spread over 2 to 36 months.";
  }
  if (f.notes.length > 2000) return "Notes are too long (2000 characters).";
  return null;
}

export function billPayload(f: BillForm) {
  return {
    id: f.id ?? undefined,
    name: f.name.trim(),
    category_id: f.category_id,
    vendor_id: f.vendor_id || null,
    description: f.description.trim(),
    currency: f.currency,
    amount: cleanAmountInput(f.amount, f.currency),
    payment_method: f.payment_method,
    paid_from: f.paid_from || null,
    frequency: f.frequency,
    due_day: Number(f.due_day),
    starts_on: f.starts_on,
    ends_on: f.ends_on || null,
    spread_months: f.spread ? Number(f.spread_months) : null,
    notes: f.notes.trim() || null,
  };
}

/** The first due date the server will compute (mirrors recurring_first_due). */
export function firstDue(startsOn: string, dueDay: number): string {
  const [y, m, d] = startsOn.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d <= dueDay) return `${y}-${pad(m)}-${pad(dueDay)}`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${pad(nm)}-${pad(dueDay)}`;
}

export function dueLabel(b: Pick<RecurringBill, "active" | "next_due_on" | "ends_on" | "open_draft_id">, today: string): string {
  if (!b.active) return "Inactive";
  if (b.open_draft_id) return "Draft waiting for your confirmation";
  if (b.next_due_on <= today) return "Due — the draft appears at the next run";
  const [y, m, d] = b.next_due_on.split("-").map(Number);
  return `Next ${new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
}

export function spreadLabel(months: number | null): string {
  return months ? `Spread over ${months} months` : "";
}

/** Recurring drafts a month's expense list carries — the "Bills to confirm" strip. */
export function billsToConfirm<T extends { source: string; status: string; expense_date: string }>(expenses: T[]): T[] {
  return expenses.filter((e) => e.source === "recurring" && e.status === "draft").sort((a, b) => a.expense_date.localeCompare(b.expense_date));
}

export function recurringRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "You don't have permission for this.";
    case "invalid_name": return "Give the bill a name (up to 120 characters).";
    case "invalid_category": return "Pick an active category.";
    case "category_booked_automatically": return "Payroll and commission are booked from their own pages, not as bills.";
    case "invalid_vendor": return "That vendor is not available.";
    case "invalid_description": return "Describe the bill (1–500 characters).";
    case "invalid_currency": return "Pick ¥ or ₱.";
    case "invalid_amount": return "Enter a valid amount (whole yen for ¥).";
    case "invalid_payment_method": return "Pick how it is paid.";
    case "invalid_account": return "Pick a bank, cash or clearing account.";
    case "invalid_frequency": return "Pick monthly, quarterly or yearly.";
    case "invalid_due_day": return "The due day must be 1–28.";
    case "invalid_date": return "Check the dates (start from 2020, end after start; a one-off draft needs a date within the bill's life).";
    case "invalid_spread": return "Spread over 2 to 36 months.";
    case "invalid_notes": return "Notes are too long.";
    case "already_generated": return "That cycle already has an expense (void it first to regenerate).";
    case "not_found": return "That bill no longer exists.";
    case "not_draft": return "Only a draft can change its spread.";
    case "rate_not_set": return "The peso rate is not set, so drafts can't be created yet.";
    default: return "";
  }
}
