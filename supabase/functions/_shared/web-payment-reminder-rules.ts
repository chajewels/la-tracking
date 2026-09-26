/**
 * Stage D payment reminders (2026-10-04): pure rules.
 *
 * Kept free of Deno globals and of the Supabase client so the SAME file the
 * edge function runs is imported by vitest (src/test/web-payment-reminders.test.ts),
 * the way _shared/web-reservation-rules.ts is.
 *
 * THE AUTHORITY IS SQL. web_payment_reminder_eligible / _candidates / claim_
 * (migration 20261004100000_web_payment_reminders.sql) decide who is reminded
 * and when, under a row lock. These functions MIRROR that rule so the Hub can
 * explain it and vitest can pin it; the SQL tests
 * (docs/sql/20261004_web_payment_reminders_local_tests.sql) prove the SQL side.
 * Change one, change both. docs/WEB-PAYMENT-REMINDERS.md.
 *
 * Transactional: nothing here reads a consent, newsletter, cart-reminder or
 * suppression record. It is the customer's own order.
 */

export type PaymentReminderMode = "off" | "owner_only" | "on";
export type PaymentReminderEntity = "cash_order" | "layaway";

/** At most this many reminders per order, across every deadline it ever had. */
export const MAX_PAYMENT_REMINDERS_PER_ORDER = 2;
/** A deadline this long after staff confirmation (or shorter) is the 24h first-order kind. */
export const FIRST_ORDER_KIND_MAX_HOURS = 30;
/** 24h deadline: remind when this many hours (or fewer) remain. */
export const SHORT_DEADLINE_WINDOW_HOURS = 6;
/** 72h deadline (or a moved one): remind when this many hours (or fewer) remain. */
export const LONG_DEADLINE_WINDOW_HOURS = 24;
/** Never remind with less than this left — the email could arrive after the deadline. */
export const MIN_HOURS_LEFT = 1;

/** The storefront test gate's owner-readable addresses (_shared/storefront-email.ts ownerReadable). */
const OWNER_READABLE_ADDRESS = "chajewelsjapan@gmail.com";
const OWNER_READABLE_DOMAIN = "@chajewelsjp.com";

const HOUR = 3_600_000;

/**
 * system_settings.web_payment_reminders_mode, read FAIL-CLOSED: only the exact
 * strings "owner_only" and "on" do anything. Absent, null, a typo, a boolean —
 * all OFF, so a broken setting can never start emailing customers.
 */
export function readPaymentReminderMode(value: unknown): PaymentReminderMode {
  return value === "owner_only" || value === "on" ? value : "off";
}

/** A valid owner-list entry: a full address, or "@domain" for a whole domain. */
export function isValidOwnerEntry(entry: string): boolean {
  const e = entry.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || /^@[^@\s]+\.[^@\s]+$/.test(e);
}

/** Does this address match the owner list? "@domain" matches the domain's addresses. */
export function ownerAddressMatches(list: readonly string[], email: string): boolean {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  return list.some((raw) => {
    const entry = String(raw ?? "").trim().toLowerCase();
    if (!entry) return false;
    return entry.startsWith("@") ? e.endsWith(entry) : e === entry;
  });
}

/** May a reminder go to this address under this mode? */
export function recipientAllowed(mode: PaymentReminderMode, ownerList: readonly string[], email: string): boolean {
  if (mode === "on") return true;
  if (mode === "owner_only") return ownerAddressMatches(ownerList, email);
  return false;
}

/** The storefront test gate: a test customer is reachable only at an owner-readable address. */
export function passesTestGate(isTest: boolean | null | undefined, email: string): boolean {
  if (isTest !== true) return true;
  const e = email.trim().toLowerCase();
  return e === OWNER_READABLE_ADDRESS || e.endsWith(OWNER_READABLE_DOMAIN);
}

/** Hours before the deadline at which this order's reminder window opens. */
export function reminderWindowHours(readyConfirmedAt: string | Date, deadline: string | Date): number {
  const span = (new Date(deadline).getTime() - new Date(readyConfirmedAt).getTime()) / HOUR;
  return span <= FIRST_ORDER_KIND_MAX_HOURS ? SHORT_DEADLINE_WINDOW_HOURS : LONG_DEADLINE_WINDOW_HOURS;
}

/**
 * Is the order inside its reminder window right now? The hourly sweep sends
 * the first time this is true, so a 24h deadline is reminded 5–6h before and a
 * 72h one 23–24h before. No quiet hours: the deadline is the customer's.
 */
export function isInReminderWindow(
  row: { readyConfirmedAt: string | Date | null | undefined; deadline: string | Date | null | undefined },
  now: Date = new Date(),
): boolean {
  if (!row.readyConfirmedAt || !row.deadline) return false;
  const left = (new Date(row.deadline).getTime() - now.getTime()) / HOUR;
  if (!Number.isFinite(left) || left <= MIN_HOURS_LEFT) return false;
  return left <= reminderWindowHours(row.readyConfirmedAt, row.deadline);
}

/** Room for another reminder, given how many this order has already had? */
export function underReminderCap(alreadySent: number): boolean {
  return alreadySent < MAX_PAYMENT_REMINDERS_PER_ORDER;
}

/** The language the reminder goes out in: a cash order's own (pickLang); a layaway is ALWAYS English. */
export function paymentReminderLang(entity: PaymentReminderEntity, customerLang: unknown): "ja" | "en" {
  if (entity === "layaway") return "en";
  return customerLang === "en" ? "en" : "ja";
}

/** Machine label in email_send_log and Lovable's send log. */
export function paymentReminderLabel(entity: PaymentReminderEntity): "order-payment-due" | "layaway-deposit-due" {
  return entity === "layaway" ? "layaway-deposit-due" : "order-payment-due";
}

/**
 * One logical send per order per deadline — the same key the ledger's UNIQUE
 * constraint expresses, so a retried call dedupes at the provider too.
 */
export function paymentReminderIdempotencyKey(entityId: string, deadline: string | Date): string {
  return `payment-due-${entityId}-${Math.floor(new Date(deadline).getTime() / 1000)}`;
}

/** web_payment_reminders.status for a sendStorefrontEmail outcome. */
export function reminderFinishStatus(
  res: { sent: true } | { sent: false; reason: string },
): "sent" | "skipped" | "failed" | "suppressed" {
  if (res.sent) return "sent";
  if (res.reason === "recipient_suppressed") return "suppressed";
  if (res.reason === "error" || res.reason === "not_found") return "failed";
  return "skipped";
}
