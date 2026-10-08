/**
 * STAFF BELL EMAILS (V11b, owner 2026-10-08): the pure rules behind the
 * staff-bell-emails edge function. No I/O here so deno can test every branch.
 *
 * - WHO gets a bell email is decided in SQL (staff_bell_email_recipients +
 *   the fan-out trigger); this module only shapes the email and decides what a
 *   send outcome means for the ledger row.
 * - One email per (bell, recipient), key `staff-bell-<bell id>-<recipient>` —
 *   the same key on a retry, so the provider never sends it twice.
 * - English only (internal). Links go to app.* (staff), never portal.*.
 */

export const HUB_URL = "https://app.chajewelsjp.com";

export interface ClaimedBellEmail {
  bell_id: string;
  recipient: string;
  attempts: number;
  bell_type: string;
  title: string;
  body: string;
  invoice_number: string | null;
  customer_id: string | null;
  bell_created_at: string;
  metadata: Record<string, unknown> | null;
}

export function staffBellEmailKey(bellId: string, recipient: string): string {
  return `staff-bell-${bellId}-${recipient.trim().toLowerCase()}`;
}

/** Where a staff member goes to act on the bell. */
export function staffBellHubUrl(b: Pick<ClaimedBellEmail, "bell_type" | "metadata">): string {
  const m = b.metadata ?? {};
  const orderId = typeof m.cash_order_id === "string" ? m.cash_order_id : null;
  if (b.bell_type === "email_bounced") return `${HUB_URL}/settings?tab=general`;
  if (b.bell_type === "refund_email_failed" && orderId) return `${HUB_URL}/cash-orders/${orderId}`;
  if (b.bell_type.startsWith("card_") || b.bell_type.startsWith("square_")) return `${HUB_URL}/website?tab=settings`;
  if (orderId) return `${HUB_URL}/cash-orders/${orderId}`;
  return `${HUB_URL}/dashboard`;
}

/** Subject: the bell title, prefixed so a staff inbox can filter it. */
export function staffBellSubject(b: Pick<ClaimedBellEmail, "title" | "invoice_number">): string {
  const inv = b.invoice_number ? ` · ${b.invoice_number}` : "";
  return `[Hub bell] ${b.title}${inv}`;
}

/** What a send outcome means for the ledger row (finish_staff_bell_email). */
export function staffBellFinishOutcome(
  r: { sent: true } | { sent: false; reason: string },
): "sent" | "skipped" | "retry" {
  if (r.sent) return "sent";
  // A suppressed staff address is deliberate (the provider holds it) — not a
  // transient failure, so no retry; the ledger says 'skipped' and the row is
  // visible in Settings → Email delivery like every other suppression.
  if (r.reason === "recipient_suppressed") return "skipped";
  return "retry";
}

/** Format the bell time for the email, in JST (staff are in Japan). */
export function staffBellWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${f.format(d)} JST`;
}
