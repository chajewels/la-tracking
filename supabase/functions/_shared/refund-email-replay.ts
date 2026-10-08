/**
 * B02 refund-email replay, one refund per call — the logic of square-reconcile
 * step 7 with its I/O injected, so the deno test can run it against a scripted
 * database (SQF03 / SQF04, go-live counter-check 2026-10-08).
 *
 * THE CAP IS A CLAIM, NOT A STAMP (SQF04). email_resends is incremented BEFORE
 * the send, in a compare-and-set on the value just read: a run that cannot
 * claim (another runner got there, or the row changed) sends nothing. So at
 * most MAX_REFUND_EMAIL_RESENDS sends ever happen whatever fails afterwards —
 * the old order (send, then stamp) sent again every hour while the give-up
 * bell could not be written, because the stamp never landed.
 *
 * A refund that already used its sends but is not yet stamped given-up (the
 * bell failed last hour) gets NO send: only the bell is tried again, then the
 * stamp. The bell is one per (refund, type): an existing refund_email_failed
 * row for the refund is not written twice (R07 keeps bell-before-stamp).
 *
 * A row the email could not look up (SQF03): 'lookup_error' is a transient
 * database failure and is RETRIED; 'not_found' means the order row really is
 * absent — impossible for a web order (never hard-deleted), so it stops the
 * replay AND rings refund_email_order_missing, never a silent 'done'.
 */
import { MAX_REFUND_EMAIL_RESENDS, refundEmailNext, refundReceivedKey } from "./square-reconcile-rules.ts";

export interface ReplayRefund { id: string; square_refund_id: string; cash_order_id: string; amount_jpy: number; email_resends: number }
export interface ReplayDeps {
  /** A `sent` email_send_log row carrying this key exists. */
  alreadySent(key: string): Promise<boolean>;
  /** email_resends := before + 1 WHERE email_resends = before AND email_given_up_at IS NULL; true when a row changed. */
  claim(rf: ReplayRefund, before: number): Promise<boolean>;
  send(rf: ReplayRefund, key: string): Promise<{ sent: boolean; reason?: string }>;
  bellExists(rf: ReplayRefund, type: ReplayBellType): Promise<boolean>;
  ringBell(rf: ReplayRefund, type: ReplayBellType, reason: string | null): Promise<void>;
  /** refund_email_replay := false (the row leaves the queue). */
  markDone(rf: ReplayRefund): Promise<void>;
  /** email_given_up_at := now(). */
  stampGivenUp(rf: ReplayRefund): Promise<void>;
}
export type ReplayBellType = "refund_email_failed" | "refund_email_order_missing";
export type ReplayAction = "already_sent" | "sent" | "retry" | "given_up" | "stopped" | "order_missing" | "not_claimed";

async function bellOnce(rf: ReplayRefund, deps: ReplayDeps, type: ReplayBellType, reason: string | null): Promise<void> {
  if (await deps.bellExists(rf, type)) return;
  await deps.ringBell(rf, type, reason);
}

export async function replayRefundEmail(rf: ReplayRefund, deps: ReplayDeps): Promise<{ action: ReplayAction; reason?: string }> {
  const key = refundReceivedKey(rf.square_refund_id);
  if (await deps.alreadySent(key)) {
    await deps.markDone(rf);
    return { action: "already_sent" };
  }
  const before = Number(rf.email_resends ?? 0);
  if (before >= MAX_REFUND_EMAIL_RESENDS) {
    // Every allowed send was used and the give-up stamp is still missing: the
    // bell (R07: bell first) and the stamp are what remain — no send.
    await bellOnce(rf, deps, "refund_email_failed", "bell_pending");
    await deps.stampGivenUp(rf);
    return { action: "given_up", reason: "bell_pending" };
  }
  if (!(await deps.claim(rf, before))) return { action: "not_claimed" };
  const out = await deps.send(rf, key);
  const next = refundEmailNext(out, before);
  if (next === "alert") {
    await bellOnce(rf, deps, "refund_email_order_missing", out.reason ?? null);
    await deps.markDone(rf);
    return { action: "order_missing", reason: out.reason };
  }
  if (next === "done") {
    await deps.markDone(rf);
    return { action: out.sent ? "sent" : "stopped", reason: out.reason };
  }
  if (next === "retry") return { action: "retry", reason: out.reason };
  await bellOnce(rf, deps, "refund_email_failed", out.reason ?? null);
  await deps.stampGivenUp(rf);
  return { action: "given_up", reason: out.reason };
}
