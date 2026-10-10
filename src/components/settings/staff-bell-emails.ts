/**
 * Staff bell emails (Website → Settings): words and shapes for
 * StaffBellEmailsCard.tsx (V11b, owner 2026-10-08). The bell stays in the Hub
 * for every member; the types listed here are ALSO emailed to the configured
 * addresses + every active user holding one of the roles (default: Brenda +
 * admins). docs/SQUARE.md "Staff bell emails".
 */
export const STAFF_BELL_EMAILS_KEY = ["staff-bell-emails"] as const;

export interface StaffBellEmailsState {
  found: boolean;
  types: string[];
  addresses: string[];
  roles: string[];
  resolved_recipients: string[];
  can_change: boolean;
  updated_at: string | null;
  updated_by_name: string | null;
  sent_7d: number;
  pending: number;
  failed_7d: number;
}

/** The bell types staff can tick, with what each one means. */
export const STAFF_BELL_EMAIL_CHOICES: { type: string; label: string }[] = [
  { type: "card_refund_pending", label: "Square refund still pending after 7 / 14 days" },
  { type: "card_dispute_deadline", label: "Dispute evidence due in 3 days / 1 day" },
  { type: "card_refund_after_credit", label: "Square refund on an order already cancelled with store credit" },
  { type: "refund_email_failed", label: "\"Refund received\" email failed 3 times" },
  { type: "email_bounced", label: "A customer email bounced / was reported / was suppressed (refund emails)" },
  { type: "card_dispute_opened", label: "New card dispute opened" },
  { type: "card_hold_expiring", label: "Card hold expiring (Confirm or Reject needed)" },
  { type: "card_attempt_stuck", label: "Card attempt stuck (Square never answered)" },
  { type: "square_reconcile_degraded", label: "Square hourly check degraded / failed" },
  // Q-UI2 (QC 2026-10-09): the newer card bells, so they can be ticked too.
  { type: "card_refund_unrecorded", label: "A Square refund the Hub could not record" },
  { type: "card_refund_after_exception", label: "Square refund completed after a refund outside Square" },
  { type: "card_refund_exception_approved", label: "Refund outside Square approved — pay it now" },
  { type: "card_dispute_after_credit", label: "Chargeback on an order already given store credit" },
  { type: "card_dispute_after_exception", label: "Chargeback on an order refunded outside Square" },
  { type: "refund_email_order_missing", label: "Refund email could not find its order" },
  { type: "square_event_failed", label: "A Square event failed after all retries" },
  { type: "card_capture_unverified", label: "Card capture could not be verified with Square" },
  { type: "card_recording_failed", label: "Card capture taken but not recorded" },
  { type: "card_void_failed", label: "Card hold could not be voided" },
  { type: "card_hold_unfiled", label: "Card hold with no submission (needs a decision)" },
  // L2 (2026-10-09): a dispute Square sent that the Hub could not read as yen.
  { type: "card_dispute_unrecorded", label: "A Square dispute the Hub could not record" },
  { type: "card_dispute_amount_unreadable", label: "A card dispute recorded without its amount (whole payment counted)" },
];

/** One per line or comma; lower-cased; blanks dropped. */
export function parseAddresses(text: string): string[] {
  return Array.from(new Set(text.split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean)));
}

export function invalidAddresses(list: string[]): string[] {
  return list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

export function staffBellEmailsRefusal(code: string, entry?: string): string {
  switch (code) {
    case "permission_denied": return "Only an admin can change staff bell emails.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    case "setting_missing": return "The setting is missing. Ask Claude Code to check the staff-bell-emails migration.";
    case "invalid_address": return `Not an email address: ${entry ?? ""}`;
    case "invalid_role": return `Not a Hub role: ${entry ?? ""}`;
    case "invalid_type": return `Not a bell type: ${entry ?? ""}`;
    case "too_many_addresses": return "At most 20 addresses.";
    default: return code;
  }
}
