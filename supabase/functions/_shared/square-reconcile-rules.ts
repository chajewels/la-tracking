/**
 * Pure rules for square-reconcile (Square QA S01 / S02 / B02, 2026-10-08).
 * No Deno, no imports beyond types — tested by development/square-qa-reconcile.test.ts.
 */
import type { SquareEnvironment } from "./card-rules.ts";

/**
 * S02: the environments whose refunds and disputes are discovered this run —
 * the current mode's environment plus every environment that still has card
 * rows worth watching (a live hold, a recent capture, an open refund or
 * dispute). So discovery keeps running with the mode off, and after a
 * test → live switch the old sandbox rows are still watched. Sorted, unique.
 */
export function discoveryEnvironments(
  current: SquareEnvironment | null,
  rows: Array<{ environment?: string | null; test?: boolean | null }>,
): SquareEnvironment[] {
  const set = new Set<SquareEnvironment>();
  if (current) set.add(current);
  for (const r of rows) {
    const env = r.environment === "sandbox" || r.environment === "production"
      ? r.environment
      : (r.test === true ? "sandbox" : r.test === false ? "production" : null);
    if (env) set.add(env);
  }
  return [...set].sort();
}

/**
 * S01: an attempt counts as "stuck" in a run when it is still open after its
 * give-up time and recovery could not settle it this run ('waiting'). A
 * 'cancelling' attempt is mid-cancel, not stuck.
 */
export function attemptStuckThisRun(
  a: { status?: unknown; created_at?: unknown },
  outcome: string,
  nowMs: number,
  giveUpMs: number,
): boolean {
  if (outcome !== "waiting") return false;
  if (a.status !== "reserved" && a.status !== "unknown") return false;
  const created = Date.parse(String(a.created_at ?? ""));
  return Number.isFinite(created) && nowMs - created >= giveUpMs;
}

/** B02: at most this many re-sends of one refund email, then a bell. */
export const MAX_REFUND_EMAIL_RESENDS = 3;

/** B02: a refund's email is only re-sent once the first send had time to land. */
export const REFUND_EMAIL_GRACE_MS = 30 * 60 * 1000;

/** The email key square-sync uses for a completed Square refund (same key = never twice). */
export function refundReceivedKey(squareRefundId: string): string {
  return `refund-received-square-${squareRefundId}`;
}

/**
 * B02: what to do after one re-send attempt, from sendOrderUpdateEmail's
 * outcome. 'done' = stop for good (sent, or a deliberate no-send: not a
 * website order, test customer, no address, suppressed address); 'retry' =
 * a transient failure, try next hour; 'give_up' = the last allowed try failed.
 */
export function refundEmailNext(
  outcome: { sent: boolean; reason?: string },
  resendsBefore: number,
): "done" | "retry" | "give_up" {
  if (outcome.sent) return "done";
  const r = String(outcome.reason ?? "error");
  const transient = r === "error" || r === "not_sent_error" || r === "not_sent_not_configured";
  if (!transient) return "done";
  return resendsBefore + 1 >= MAX_REFUND_EMAIL_RESENDS ? "give_up" : "retry";
}

/**
 * R09 (2026-10-08): how a failed Events API read is shown. Square does not
 * document the exact "not enabled" code, so: a 4xx OTHER than 400, before the
 * Events API has ever answered for this environment, reads as not enabled
 * (panel, not alarm). A 400 is OUR request and always alarms; a 5xx / network
 * failure is "unavailable"; after a successful read any Square error alarms.
 */
export function eventsErrorKind(
  e: { kind: string; status: number } | null | undefined,
  neverRead: boolean,
): "not_enabled" | "unavailable" | "error" {
  if (!e) return "error";
  const fourXx = e.kind === "client" || e.kind === "auth";   // a real 401/403 is kind "auth"
  if (fourXx && e.status !== 400) return neverRead ? "not_enabled" : "unavailable";
  if (fourXx) return "error";
  return "unavailable";
}
