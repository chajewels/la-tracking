/**
 * Payment reminders switch (Settings → General): the words and shapes the card
 * uses, kept out of PaymentRemindersCard.tsx so the component file exports
 * only components. Rules: docs/WEB-PAYMENT-REMINDERS.md.
 */
import {
  isValidOwnerEntry, type PaymentReminderMode,
} from "../../../supabase/functions/_shared/web-payment-reminder-rules.ts";

export type { PaymentReminderMode };

export const PAYMENT_REMINDERS_KEY = ["web-payment-reminders"] as const;

export interface PaymentRemindersState {
  found: boolean;
  mode: PaymentReminderMode;
  owner_addresses: string[];
  updated_at: string | null;
  updated_by_user_id: string | null;
  updated_by_name: string | null;
  can_change: boolean;
  due_now: number;
  sent_7d: number;
}

export const MODE_LABEL: Record<PaymentReminderMode, string> = {
  off: "Off",
  owner_only: "Owner addresses only",
  on: "On for every customer",
};

/** What each mode does, in the words the card and the dialog show. */
export function paymentRemindersEffect(mode: PaymentReminderMode): string {
  switch (mode) {
    case "on":
      return "Every website customer with a confirmed, unpaid order gets one reminder before the payment deadline.";
    case "owner_only":
      return "Only the owner addresses below get reminders — for testing. Customers get nothing.";
    default:
      return "No payment reminders are sent.";
  }
}

/** One entry per line or comma; blanks dropped. */
export function parseOwnerAddresses(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** The entries that are neither an address nor "@domain". */
export function invalidOwnerAddresses(list: string[]): string[] {
  return list.filter((e) => !isValidOwnerEntry(e));
}

/** Words for a refusal from set_web_payment_reminders. */
export function paymentRemindersRefusal(code: string, entry?: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change payment reminders.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    case "stale": return "Someone else changed this a moment ago. The card now shows the current state.";
    case "setting_missing": return "The setting is missing. Ask Claude Code to check the payment-reminders migration.";
    case "invalid_mode": return "That mode is not one of Off, Owner addresses only, or On.";
    case "invalid_owner_address": return `"${entry ?? ""}" is not an email address or an @domain.`;
    case "owner_addresses_required": return "Add at least one owner address before choosing Owner addresses only.";
    case "too_many_owner_addresses": return "Keep the owner list to 20 entries or fewer.";
    default: return code || "Could not change payment reminders.";
  }
}

/** Words for a failed read of get_web_payment_reminders. */
export function paymentRemindersReadError(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "permission_denied") return "you do not have access to this setting.";
  if (code === "user_identity_required") return "your session has expired. Sign in again.";
  return "the server did not answer. Try again in a moment.";
}
