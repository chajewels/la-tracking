/**
 * PA08 (owner decision 2026-10-09): the AUDITED MANUAL resend of a refund
 * email. Nothing here re-sends anything by itself — the owner rule "no
 * automatic replay" stands (the B02 card refund email is the one exception
 * and is NOT handled here). An admin presses Resend, gives a written reason,
 * and ONE more attempt goes out under a NEW idempotency key, so the provider
 * does not swallow it as a duplicate of the first one.
 *
 * Scope (owner, recommended option): refund emails on a website cash order
 * only — the 「返金が完了しました」 email (refund_issued, key
 * refund-issued-<order id>) and each Paidy 「返金を受け付けました」 email
 * (refund_received, key refund-received-paidy-<refund id>). Max 3 manual
 * resends per email; refused while the address is suppressed (a resend cannot
 * reach her — staff contact her another way).
 */

export const MAX_MANUAL_RESENDS = 3;
export const MIN_RESEND_REASON = 10;

export type ResendKind = "refund_issued" | "refund_received_paidy";

export interface ResendableEmail {
  kind: ResendKind;
  key: string;
  amount: number;
  /** refund_issued only: the method and day staff recorded. */
  refund_method?: string | null;
  refunded_on?: string | null;
  /** The newest send-log status for this email or any of its resends; null = never attempted. */
  last_status: string | null;
  last_at: string | null;
  resends_used: number;
}

/** The key of manual resend number n (1-based). */
export function resendKey(originalKey: string, n: number): string {
  return `${originalKey}-resend-${n}`;
}

/** The original key a send-log key belongs to (itself, or the key before "-resend-n"). */
export function originalKeyOf(key: string): string {
  return key.replace(/-resend-\d+$/, "");
}

/**
 * Why a resend is refused, or null when it may go. Checked in this order so
 * the staff message names the first thing to fix.
 */
export function resendRefusal(i: { reason: unknown; item: ResendableEmail | null }):
  | "reason_required" | "not_resendable" | "recipient_suppressed" | "resend_cap_reached" | null {
  const reason = typeof i.reason === "string" ? i.reason.trim() : "";
  if (reason.length < MIN_RESEND_REASON) return "reason_required";
  if (!i.item) return "not_resendable";
  if (i.item.last_status === "suppressed") return "recipient_suppressed";
  if (i.item.resends_used >= MAX_MANUAL_RESENDS) return "resend_cap_reached";
  return null;
}

/** Newest log row per original key (rows arrive newest first). */
export function latestByOriginalKey(rows: Array<{ key: string; status: string; created_at: string }>): Map<string, { status: string; created_at: string }> {
  const out = new Map<string, { status: string; created_at: string }>();
  for (const r of rows) {
    const k = originalKeyOf(r.key);
    if (!out.has(k)) out.set(k, { status: r.status, created_at: r.created_at });
  }
  return out;
}
