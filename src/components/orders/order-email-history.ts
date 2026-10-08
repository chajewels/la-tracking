/** Shapes and labels for OrderEmailHistory (get_order_email_history). */

export interface OrderEmailHistoryRow {
  created_at: string;
  template: string;
  status: string;
  recipient: string;
  error: string | null;
  skip_reason: string | null;
}

export interface OrderPaymentReminderRow {
  claimed_at: string;
  finished_at: string | null;
  deadline: string;
  status: string;
  detail: string | null;
  lang: "ja" | "en";
  currency: "JPY" | "PHP";
  amount: number;
  email: string;
}

export interface OrderEmailHistory {
  references: string[];
  emails: OrderEmailHistoryRow[];
  payment_reminders: OrderPaymentReminderRow[];
}

/** Staff-facing names for the storefront email labels. Unknown labels show raw. */
export const EMAIL_LABELS: Record<string, string> = {
  "order-confirmation": "Order confirmation",
  "order-reserved": "Reservation received",
  "order-ready": "Confirmed — pay now",
  "order-payment-due": "Payment reminder",
  "order-payment-received": "Payment received",
  "order-expired": "Order expired",
  "order-cancelled": "Order cancelled",
  "order-reservation-lapsed": "Reservation lapsed (72h)",
  "layaway-plan-created": "Layaway created",
  "layaway-reserved": "Layaway reservation received",
  "layaway-ready": "Confirmed — send deposit",
  "layaway-deposit-due": "Deposit reminder",
  "layaway-payment-received": "Payment received",
  "layaway-expired": "Layaway hold released",
  "layaway-declined": "Layaway declined",
  "layaway-reservation-lapsed": "Layaway reservation lapsed (72h)",
  "layaway-forfeited": "Layaway forfeited",
  // PA08 (2026-10-09): the order / plan update emails, named for staff.
  "order-update-needs_info": "We need details from you",
  "order-update-deadline_moved": "Payment deadline moved",
  "order-update-shipped": "Shipped",
  "order-update-details_received": "Details received",
  "order-update-payment_submitted": "Payment received for review",
  "order-update-payment_voided": "Payment voided",
  "order-update-payment_restored": "Payment restored",
  "order-update-refund_issued": "Refund sent (返金が完了しました)",
  "order-update-refund_received": "Provider refund received (返金を受け付けました)",
  "layaway-update-rejected": "Layaway payment not accepted",
  "layaway-update-needs_info": "Layaway — we need details",
  "layaway-update-deadline_moved": "Layaway deadline moved",
  "layaway-update-shipped": "Layaway shipped",
  "layaway-update-details_received": "Layaway details received",
  "layaway-update-reminder": "Layaway payment reminder",
  "layaway-update-penalty": "Layaway penalty applied",
  "layaway-update-penalty_reinstated": "Layaway penalty reinstated",
  "layaway-update-penalty_waived": "Layaway penalty waived",
  "layaway-update-payment_voided": "Layaway payment voided",
  "layaway-update-reactivated": "Layaway reactivated",
};

export function emailStatusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "sent") return "default";
  if (status === "failed" || status === "dlq" || status === "suppressed") return "destructive";
  return "secondary";
}
