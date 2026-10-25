/**
 * Emailed bills in the Expenses tab (Phase 4, owner 2026-10-26 D1–D6). Pure rules, no React.
 * The reading itself happens in the edge function expenses-email-bills; this file shapes what the
 * owner sees and what "Make expense" sends.
 */
import type { Expense, ExpenseForm } from "@/components/finance/expenses";

export const EMAIL_BILLS_KEY = ["finance", "expenses", "email-bills"] as const;
export const UNCATEGORISED_SYSTEM_KEY = "uncategorised";

export type EmailBillStatus = "drafted" | "matched" | "needs_review" | "skipped" | "dismissed" | "error";
export type EmailAttachment = { name: string; mime: string; size: number; path: string };
export type EmailBill = {
  gmail_message_id: string; thread_id: string | null; mailbox: string;
  from_email: string | null; from_name: string | null; subject: string | null; received_at: string | null;
  status: EmailBillStatus; confidence: number | null;
  extracted: Record<string, unknown>; attachments: EmailAttachment[];
  expense_id: string | null; matched_expense_id: string | null; error: string | null;
  expense_status?: string | null; expense_date?: string | null; matched_description?: string | null;
};
export type EmailRun = {
  id: string; started_at: string; finished_at: string | null; trigger: "cron" | "manual";
  looked_at: number; drafted: number; matched: number; needs_review: number; skipped: number; errors: number; note: string | null;
};
export type EmailBillsState =
  | { available: true; enabled: boolean; mailbox: string; can_manage: boolean; last_run: EmailRun | null; messages: EmailBill[] }
  | { available: false };

export function normaliseEmailBills(raw: Record<string, unknown>): Extract<EmailBillsState, { available: true }> {
  const msgs = Array.isArray(raw.messages) ? (raw.messages as Record<string, unknown>[]) : [];
  return {
    available: true,
    enabled: raw.enabled === true,
    mailbox: String(raw.mailbox ?? ""),
    can_manage: raw.can_manage === true,
    last_run: (raw.last_run as EmailRun | null) ?? null,
    messages: msgs.map((m) => ({
      ...(m as unknown as EmailBill),
      confidence: m.confidence == null ? null : Number(m.confidence),
      extracted: (m.extracted && typeof m.extracted === "object" ? m.extracted : {}) as Record<string, unknown>,
      attachments: Array.isArray(m.attachments) ? (m.attachments as EmailAttachment[]) : [],
    })),
  };
}

export const EMAIL_STATUS_LABEL: Record<EmailBillStatus, string> = {
  drafted: "Draft created", matched: "Attached to a recurring bill", needs_review: "Needs review", skipped: "Skipped", dismissed: "Dismissed", error: "Could not be read",
};
export const EMAIL_STATUS_ORDER: EmailBillStatus[] = ["needs_review", "error", "drafted", "matched", "skipped", "dismissed"];

export function groupByStatus(messages: EmailBill[]): { status: EmailBillStatus; items: EmailBill[] }[] {
  return EMAIL_STATUS_ORDER.map((status) => ({ status, items: messages.filter((m) => m.status === status) })).filter((g) => g.items.length > 0);
}

/** Why a message landed where it did, in the owner's words. */
export function whyLabel(m: EmailBill): string {
  const why = m.extracted.why;
  if (typeof why === "string" && why) return why;
  if (m.status === "error") return m.error ?? "The reader failed on this email.";
  return "";
}

export function confidenceLabel(c: number | null): string {
  if (c == null) return "";
  return `${Math.round(c * 100)}% sure`;
}

/** Email drafts waiting in the month on screen — the "From email" strip. */
export function emailDraftsToConfirm<T extends Pick<Expense, "source" | "status" | "expense_date">>(expenses: T[]): T[] {
  return expenses.filter((e) => e.source === "email" && e.status === "draft").sort((a, b) => a.expense_date.localeCompare(b.expense_date));
}

/** An emailed draft still in the holding category cannot be approved — the owner must pick a category first. */
export function needsCategory(e: { category_id: string }, categories: { id: string; system_key: string | null }[]): boolean {
  return categories.some((c) => c.id === e.category_id && c.system_key === UNCATEGORISED_SYSTEM_KEY);
}

/** Prefill for "Make expense" from what the reader extracted (owner finishes the form). */
export function prefillFromEmail(m: EmailBill, today: string, categories: { id: string; name: string }[]): Partial<ExpenseForm> {
  const x = m.extracted;
  const cur = x.currency === "PHP" ? "PHP" : "JPY";
  const amount = typeof x.amount === "number" && x.currency !== "OTHER" ? String(x.amount) : "";
  const cat = typeof x.category === "string" ? categories.find((c) => c.name.toLowerCase() === (x.category as string).toLowerCase()) : undefined;
  const date = typeof x.bill_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.bill_date) && x.bill_date <= today ? x.bill_date : (m.received_at ?? today).slice(0, 10);
  return {
    expense_date: date,
    category_id: cat?.id ?? "",
    new_vendor_name: typeof x.vendor === "string" ? x.vendor : (m.from_name ?? ""),
    description: typeof x.description === "string" ? x.description : (m.subject ?? ""),
    currency: cur,
    amount,
    payment_method: "other",
  };
}

export function lastRunLabel(run: EmailRun | null): string {
  if (!run) return "No mail check yet";
  const when = new Date(run.started_at).toLocaleString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `Last check ${when}: ${run.looked_at} new email${run.looked_at === 1 ? "" : "s"} · ${run.drafted} draft${run.drafted === 1 ? "" : "s"}, ${run.matched} matched, ${run.needs_review} to review, ${run.skipped} skipped${run.errors ? `, ${run.errors} failed` : ""}`;
}

export function emailBillRefusal(code: string): string {
  switch (code) {
    case "permission_denied": return "You don't have permission for this.";
    case "already_generated": return "This email already has an expense.";
    case "not_found": return "That email is no longer listed.";
    case "invalid_date": return "Check the date.";
    case "invalid_amount": return "Enter a valid amount (whole yen for ¥).";
    case "invalid_currency": return "Pick ¥ or ₱.";
    case "invalid_category": return "Pick a category.";
    case "category_booked_automatically": return "Payroll and commission are booked from their own pages.";
    case "invalid_description": return "Describe the expense.";
    case "rate_not_set": return "The peso rate is not set.";
    case "gmail_auth_failed": return "Google has not granted the Hub permission to read the mailbox yet (Google Admin → domain-wide delegation → gmail.readonly).";
    case "gmail_list_failed": return "Gmail could not be read right now. Try again in a moment.";
    case "disabled": return "Email bills are turned off.";
    default: return "";
  }
}
