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
};

export function emailStatusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "sent") return "default";
  if (status === "failed" || status === "dlq" || status === "suppressed") return "destructive";
  return "secondary";
}
