/**
 * One Paidy notification, processed from the inbox (paidy_webhook_events).
 * Used by paidy-webhook (right after storing it) and paidy-reconcile (for
 * anything the webhook could not finish). docs/PAIDY.md "Follow-up" R08/R09.
 *
 * Only the payment id is used; everything else is Paidy's own read-back.
 * Idempotent: running the same event twice reaches the same state.
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
  error?: string;
  summary: Record<string, unknown>;
}

/** Back-off for a failed event: 2, 4, 8 … minutes, capped at 6 h. */
export function paidyEventBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60 * 1000, 2 ** Math.max(1, Math.min(attempts, 12)) * 60 * 1000);
}

async function markInbox(supabase: Db, inboxId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from("paidy_webhook_events").update(patch).eq("id", inboxId);
  if (error) console.error("[paidy-events] inbox update failed:", error);
}

async function failInbox(supabase: Db, inboxId: string, attempts: number, why: string, delayMs?: number) {
  await markInbox(supabase, inboxId, {
    attempts: attempts + 1, last_error: why.slice(0, 500),
    next_attempt_at: new Date(Date.now() + (delayMs ?? paidyEventBackoffMs(attempts + 1))).toISOString(),
  });
}

export async function processPaidyEvent(
  supabase: Db, inboxId: string, pid: string, event: string, source: "webhook" | "reconcile", attempts = 0,
): Promise<EventResult> {
  try {
    const { data: row, error: rowErr } = await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("paidy_payment_id", pid).maybeSingle();
    if (rowErr) throw rowErr;

    // R18: a payment from the OTHER environment (a test payment while the Hub
    // runs live keys, or the reverse) cannot be read with this key — skipped,
    // not counted as an error.
    if (row) {
      let secretTest: boolean | null = null;
      try { secretTest = paidySecretIsTest(); } catch { /* not configured: handled by get() below */ }
      if (secretTest !== null && (row.test === true) !== secretTest) {
        await markInbox(supabase, inboxId, { processed_at: new Date().toISOString(), last_error: "other_environment" });
        return { done: true, summary: { skipped: "other_environment" } };
      }
    }

    let payment: PaidyPayment;
    try {
      payment = await paidy.get(pid);
    } catch (e) {
      const pe = e instanceof PaidyError ? e : null;
      if (pe && pe.status === 404) {
        // Paidy does not know this id (R08: distinguished from a credential
        // problem): quarantined as a case, the event is done.
        await openPaidyCase(supabase, {
          kind: "provider_unreadable", paidy_payment_id: pid, cash_order_id: row?.cash_order_id ?? null, paidy_payment_row: row?.id ?? null,
          detail: { status: pe.status, code: pe.code, event, source },
          bell: { title: "Paidy notification for an unknown payment", body: `${pid} · Paidy answered ${pe.status} ${pe.code}. Check the Paidy dashboard (Payment Submissions → Paidy cases).` },
        });
        await markInbox(supabase, inboxId, { processed_at: new Date().toISOString(), last_error: `paidy ${pe.status} ${pe.code}` });
        return { done: true, summary: { quarantined: "provider_unreadable" } };
      }
      // 401/403, not configured, timeout, 5xx: repairable — keep the event.
      await failInbox(supabase, inboxId, attempts, pe ? `paidy ${pe.status} ${pe.code}` : String(e));
      return { done: false, retry_provider: true, error: "paidy_unavailable", summary: {} };
    }

    if (!row) {
      const outcome = paidyProviderOutcome(payment);
      const ageMs = Date.now() - (Date.parse(String(payment.created_at ?? "")) || 0);
      if (outcome === "authorized" && ageMs < ORPHAN_GRACE_MS) {
        // Paidy notifies before the customer's browser reports back: give the
        // website callback its window; the event waits in the inbox.
        await failInbox(supabase, inboxId, attempts, "callback_window", ORPHAN_GRACE_MS - ageMs + 5000);
        return { done: false, retry_callback_window: true, summary: {} };
      }
      let summary: Record<string, unknown>;
      if (outcome === "authorized") {
        summary = { orphan: await adoptOrphanAuthorization(supabase, payment, source === "webhook" ? "paidy_webhook" : "paidy_reconcile") };
      } else if (outcome === "captured") {
        const order = await orderForPaidyRef(supabase, payment.order?.order_ref);
        await openPaidyCase(supabase, {
          kind: "captured_no_submission", paidy_payment_id: pid, cash_order_id: order?.id ?? null,
          detail: { order_ref: payment.order?.order_ref ?? null, captured_jpy: paidyCapturedAmount(payment), no_hub_record: true },
          bell: { title: "Paidy took a payment the Hub has no record of", body: `${pid} · ¥${Math.round(Number(payment.amount) || 0).toLocaleString("en-US")} · order_ref "${String(payment.order?.order_ref ?? "")}" — check the Paidy dashboard (Payment Submissions → Paidy cases).` },
        });
        summary = { orphan: "captured_no_submission" };
      } else {
        summary = { ignored: `unknown_payment_${outcome}` };
      }
      await markInbox(supabase, inboxId, { processed_at: new Date().toISOString(), last_error: null });
      return { done: true, summary };
    }

    const r = await syncPaidyPayment(supabase, row, payment, source, event, { record: paidyAutoRecord });
    await markInbox(supabase, inboxId, { processed_at: new Date().toISOString(), last_error: null });
    return { done: true, summary: { status: r.status_after, outcome: r.outcome, flagged: r.flagged } };
  } catch (e) {
    console.error(`[paidy-events] ${pid} failed:`, e);
    await failInbox(supabase, inboxId, attempts, e instanceof Error ? e.message : String(e));
    return { done: false, error: "sync_failed", summary: {} };
  }
}
