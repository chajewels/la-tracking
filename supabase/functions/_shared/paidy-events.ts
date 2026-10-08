/**
 * One Paidy notification, processed from the inbox (paidy_webhook_events).
 * Used by paidy-webhook (right after storing it) and paidy-reconcile (for
 * anything the webhook could not finish). docs/PAIDY.md "Follow-up" R08/R09
 * and "PR 3 — recovery" (PA09 / PA10, owner brief 2026-10-08).
 *
 * Only the payment id is used; everything else is Paidy's own read-back.
 * Idempotent: running the same event twice reaches the same state.
 *
 * PA09: every inbox write is checked and reported (`writes_failed`); a
 * caller processes an event only after CLAIMING it (claim_paidy_webhook_event,
 * 5-minute lease) so a late webhook finish and the sweep never work on one
 * notification together.
 * PA10: an event this key cannot answer is PARKED, never dropped —
 *   other_environment   the Hub row says the payment belongs to the other
 *                       key family; retried daily by whichever key is in;
 *   unknown_to_this_key Paidy answered 404 to this key for an id with no Hub
 *                       row; the other key gets its turn (tried_test /
 *                       tried_live); only when BOTH keys answered 404 is the
 *                       event closed as not ours.
 * Classification (PA04): once the order is known (Hub row, or Paidy's
 * order_ref / metadata), cash_order_id and test are written on the event so a
 * window expiry is held only by notifications about ITS order.
 */
import { PaidyError, paidy, paidySecretIsTest, type PaidyPayment } from "./paidy.ts";
import { adoptOrphanAuthorization, orderForPaidyRef } from "./paidy-filing.ts";
import { PAIDY_RECORD_FIELDS, openPaidyCase, syncPaidyPayment } from "./paidy-sync.ts";
import { paidyCapturedAmount, paidyProviderOutcome } from "./paidy-rules.ts";
import { paidyAutoRecord } from "./paidy-autorecord.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

/** How long the website callback gets before an authorisation is filed from the webhook. */
export const ORPHAN_GRACE_MS = 3 * 60 * 1000;

export interface EventResult {
  done: boolean;
  retry_callback_window?: boolean;
  retry_provider?: boolean;
  /** PA09: an inbox bookkeeping write that failed (the event's own state may now be stale). */
  writes_failed?: number;
  error?: string;
  summary: Record<string, unknown>;
}

/** Back-off for a failed event: 2, 4, 8 … minutes, capped at 6 h. */
export function paidyEventBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60 * 1000, 2 ** Math.max(1, Math.min(attempts, 12)) * 60 * 1000);
}

/** A parked event is retried once a day (the keys may be switched) — and never dropped (owner 2026-10-08). */
export const PARKED_RETRY_MS = 24 * 60 * 60 * 1000;
export type ParkedReason = "other_environment" | "unknown_to_this_key";

/** Claims the event for this worker (compare-and-set lease). False = someone else holds it. */
export async function claimPaidyEvent(supabase: Db, inboxId: string, by: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_paidy_webhook_event", { p_id: inboxId, p_by: by, p_lease_seconds: 300 });
  if (error) { console.error("[paidy-events] claim failed:", error); return false; }
  return data === true;
}

/**
 * Inbox bookkeeping. Returns whether the write landed; a failure is retried
 * once and then reported to the caller (never swallowed — PA09).
 */
async function markInbox(supabase: Db, inboxId: string, patch: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.from("paidy_webhook_events").update({ ...patch, claimed_at: null, claimed_by: null }).eq("id", inboxId);
    if (!error) return true;
    console.error(`[paidy-events] inbox update failed (attempt ${attempt + 1}):`, error);
  }
  return false;
}

async function failInbox(supabase: Db, inboxId: string, attempts: number, why: string, delayMs?: number): Promise<boolean> {
  return await markInbox(supabase, inboxId, {
    attempts: attempts + 1, last_error: why.slice(0, 500),
    next_attempt_at: new Date(Date.now() + (delayMs ?? paidyEventBackoffMs(attempts + 1))).toISOString(),
  });
}

/** Parks the event for the other key: daily retry, never dropped. */
async function parkInbox(supabase: Db, inboxId: string, attempts: number, reason: ParkedReason, extra: Record<string, unknown> = {}): Promise<boolean> {
  return await markInbox(supabase, inboxId, {
    ...extra, parked_reason: reason, attempts: attempts + 1, last_error: reason,
    next_attempt_at: new Date(Date.now() + PARKED_RETRY_MS).toISOString(),
  });
}

/** PA04/PA10: the classification an event carries once its payment is known. */
export function paidyEventClassification(row: { cash_order_id?: unknown; test?: unknown } | null, payment?: PaidyPayment | null, order?: { id?: unknown } | null) {
  const c: Record<string, unknown> = {};
  const orderId = row?.cash_order_id ?? order?.id ?? null;
  if (orderId) c.cash_order_id = String(orderId);
  const test = typeof row?.test === "boolean" ? row.test : typeof payment?.test === "boolean" ? payment.test : null;
  if (test !== null) c.test = test;
  return c;
}

const done = (writes: boolean, summary: Record<string, unknown>): EventResult =>
  ({ done: true, writes_failed: writes ? 0 : 1, summary });

export async function processPaidyEvent(
  supabase: Db, inboxId: string, pid: string, event: string, source: "webhook" | "reconcile", attempts = 0,
  /**
   * H9 soft gate (R14): false only for a webhook delivery from a source that is
   * not one of Paidy's published IPs. It is still processed in full; only an
   * id Paidy does not know opens NO case and rings NO bell.
   * tried: which keys already answered 404 for this id (PA10).
   */
  opts: { recognisedSource?: boolean; receivedAt?: string | null; tried?: { test?: boolean; live?: boolean } } = {},
): Promise<EventResult> {
  try {
    const { data: row, error: rowErr } = await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("paidy_payment_id", pid).maybeSingle();
    if (rowErr) throw rowErr;

    let secretTest: boolean | null = null;
    try { secretTest = paidySecretIsTest(); } catch { /* not configured: handled by get() below */ }

    // PA10 (owner 2026-10-08): a payment from the OTHER environment (a test
    // payment while the Hub runs live keys, or the reverse) cannot be read
    // with this key. It is PARKED — classified, out of the working batch,
    // retried daily by whichever key is in — and NEVER dropped.
    if (row && secretTest !== null && (row.test === true) !== secretTest) {
      const ok = await parkInbox(supabase, inboxId, attempts, "other_environment", paidyEventClassification(row));
      return done(ok, { skipped: "other_environment", parked: true });
    }

    let payment: PaidyPayment;
    try {
      payment = await paidy.get(pid);
    } catch (e) {
      const pe = e instanceof PaidyError ? e : null;
      if (pe && pe.status === 404) {
        // Paidy does not know this id FOR THIS KEY (R08: distinguished from a
        // credential problem). From an unrecognised source (H9 soft gate) it
        // is only noted — no case, no bell — so random ids posted by
        // strangers cannot spam staff.
        if (opts.recognisedSource === false) {
          const ok = await markInbox(supabase, inboxId, { processed_at: new Date().toISOString(), last_error: `paidy ${pe.status} ${pe.code} (unrecognised source)` });
          return done(ok, { ignored: "provider_unreadable_unrecognised_source" });
        }
        // PA10: with no Hub row the id may belong to the other key family.
        // Record which key answered 404; park it for the other key. Only when
        // BOTH keys have answered 404 is it closed as not ours.
        const tried = { test: opts.tried?.test === true, live: opts.tried?.live === true };
        if (secretTest === true) tried.test = true; else if (secretTest === false) tried.live = true;
        const bothTried = tried.test && tried.live;
        if (!row && !bothTried) {
          await openPaidyCase(supabase, {
            kind: "provider_unreadable", paidy_payment_id: pid, cash_order_id: null, paidy_payment_row: null,
            detail: { status: pe.status, code: pe.code, event, source, tried_test: tried.test, tried_live: tried.live, parked: true },
            bell: { title: "Paidy notification for an unknown payment", body: `${pid} · Paidy answered ${pe.status} ${pe.code} to the ${secretTest ? "test" : "live"} key. Parked for the other key; check the Paidy dashboard (Payment Submissions → Paidy cases).` },
          });
          const ok = await parkInbox(supabase, inboxId, attempts, "unknown_to_this_key", { tried_test: tried.test, tried_live: tried.live });
          return done(ok, { parked: "unknown_to_this_key" });
        }
        await openPaidyCase(supabase, {
          kind: "provider_unreadable", paidy_payment_id: pid, cash_order_id: row?.cash_order_id ?? null, paidy_payment_row: row?.id ?? null,
          detail: { status: pe.status, code: pe.code, event, source, tried_test: tried.test, tried_live: tried.live },
          bell: { title: "Paidy notification for an unknown payment", body: `${pid} · Paidy answered ${pe.status} ${pe.code}${bothTried ? " to BOTH keys" : ""}. Check the Paidy dashboard (Payment Submissions → Paidy cases).` },
        });
        const ok = await markInbox(supabase, inboxId, {
          processed_at: new Date().toISOString(), last_error: `paidy ${pe.status} ${pe.code}${bothTried ? " (both keys)" : ""}`,
          tried_test: tried.test, tried_live: tried.live, parked_reason: null, ...paidyEventClassification(row),
        });
        return done(ok, { quarantined: "provider_unreadable", both_keys: bothTried });
      }
      // 401/403, not configured, timeout, 5xx: repairable — keep the event.
      const ok = await failInbox(supabase, inboxId, attempts, pe ? `paidy ${pe.status} ${pe.code}` : String(e));
      return { done: false, retry_provider: true, writes_failed: ok ? 0 : 1, error: "paidy_unavailable", summary: {} };
    }

    if (!row) {
      const outcome = paidyProviderOutcome(payment);
      const ageMs = Date.now() - (Date.parse(String(payment.created_at ?? "")) || 0);
      const order = await orderForPaidyRef(supabase, payment.order?.order_ref);
      const classified = paidyEventClassification(null, payment, order);
      if (outcome === "authorized" && ageMs < ORPHAN_GRACE_MS) {
        // Paidy notifies before the customer's browser reports back: give the
        // website callback its window; the event waits in the inbox.
        const ok = await markInbox(supabase, inboxId, {
          ...classified, attempts: attempts + 1, last_error: "callback_window",
          next_attempt_at: new Date(Date.now() + ORPHAN_GRACE_MS - ageMs + 5000).toISOString(),
        });
        return { done: false, retry_callback_window: true, writes_failed: ok ? 0 : 1, summary: {} };
      }
      let summary: Record<string, unknown>;
      if (outcome === "authorized") {
        summary = { orphan: await adoptOrphanAuthorization(supabase, payment, source === "webhook" ? "paidy_webhook" : "paidy_reconcile") };
      } else if (outcome === "captured") {
        await openPaidyCase(supabase, {
          kind: "captured_no_submission", paidy_payment_id: pid, cash_order_id: order?.id ?? null,
          detail: { order_ref: payment.order?.order_ref ?? null, captured_jpy: paidyCapturedAmount(payment), no_hub_record: true },
          bell: { title: "Paidy took a payment the Hub has no record of", body: `${pid} · ¥${Math.round(Number(payment.amount) || 0).toLocaleString("en-US")} · order_ref "${String(payment.order?.order_ref ?? "")}" — check the Paidy dashboard (Payment Submissions → Paidy cases).` },
        });
        summary = { orphan: "captured_no_submission" };
      } else {
        summary = { ignored: `unknown_payment_${outcome}` };
      }
      const ok = await markInbox(supabase, inboxId, { ...classified, processed_at: new Date().toISOString(), last_error: null, parked_reason: null });
      return done(ok, summary);
    }

    const r = await syncPaidyPayment(supabase, row, payment, source, event, { record: paidyAutoRecord });
    const ok = await markInbox(supabase, inboxId, { ...paidyEventClassification(row, payment), processed_at: new Date().toISOString(), last_error: null, parked_reason: null });
    return done(ok, { status: r.status_after, outcome: r.outcome, flagged: r.flagged });
  } catch (e) {
    console.error(`[paidy-events] ${pid} failed:`, e);
    const ok = await failInbox(supabase, inboxId, attempts, e instanceof Error ? e.message : String(e));
    return { done: false, writes_failed: ok ? 0 : 1, error: "sync_failed", summary: {} };
  }
}
