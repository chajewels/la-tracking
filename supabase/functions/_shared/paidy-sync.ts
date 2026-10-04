/**
 * Bring the Hub's record of ONE Paidy payment in line with what Paidy says
 * (P05/P11/P12, 2026-10-04). docs/PAIDY.md "Integrity". Shared by
 * paidy-webhook (one payment, on Paidy's notification) and paidy-reconcile
 * (hourly sweep). The payment passed in MUST be Paidy's own read-back.
 *
 * What it may change:
 *   - paidy_payments: status (from Paidy), capture id/time, expires_at,
 *     refund_jpy, last_payload
 *   - paidy_refunds: one row per refund id Paidy reports (idempotent)
 *   - a still-QUEUED submission (submitted / under_review) is rejected when
 *     Paidy closed or rejected the authorisation with nothing captured — the
 *     money can no longer be taken (the rule that was already here)
 *
 * What it NEVER changes: cash_payments, order totals or status, refund
 * decisions. A capture the Hub has not recorded and every refund only ring a
 * staff bell (owner Q4 a: staff finish it; refunds stay a staff decision).
 *
 * Every write is checked and THROWS on failure, so the webhook answers 5xx and
 * Paidy retries (its retries back off for about 5 hours).
 */

import { paidyBell } from "./paidy-filing.ts";
import { paidyConfirmLeaseExpired, paidyLatestCapture, paidyNewRefunds, paidyProviderOutcome } from "./paidy-rules.ts";
import type { PaidyPayment } from "./paidy.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export const PAIDY_RECORD_FIELDS = "id, cash_order_id, status, paidy_payment_id, amount_jpy, refund_jpy, expires_at, capture_id, captured_at";

/** Rings a bell unless the same type already rang for the same payment in the last 24 h (the hourly sweep must not spam). */
export async function paidyBellOnce(supabase: Db, type: string, title: string, body: string, metadata: AnyRec & { paidy_payment_id: string }): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("staff_notifications").select("id")
    .eq("type", type).contains("metadata", { paidy_payment_id: metadata.paidy_payment_id }).gte("created_at", since).limit(1);
  if (error) console.warn(`[paidy] bell dedupe read failed for ${type} (ringing anyway):`, error);
  else if ((data ?? []).length > 0) return false;
  return await paidyBell(supabase, type, title, body, metadata);
}

function must(error: unknown, what: string) {
  if (error) throw new Error(`${what}: ${(error as { message?: string })?.message ?? String(error)}`);
}

export interface SyncResult { outcome: string; status_after: string; new_refunds: number; flagged: string[] }

export async function syncPaidyPayment(supabase: Db, row: AnyRec, payment: PaidyPayment, source: "webhook" | "reconcile", event = ""): Promise<SyncResult> {
  const now = new Date().toISOString();
  const outcome = paidyProviderOutcome(payment);
  const before = String(row.status); // the Hub's status as read, before this sync writes
  const flagged: string[] = [];
  const update: AnyRec = { last_payload: payment, updated_at: now };
  if (source === "webhook") update.last_webhook_at = now;
  if (payment.expires_at) update.expires_at = payment.expires_at;

  let statusAfter = before;
  if (outcome === "captured") {
    // Paidy's capture is the truth, whatever the Hub thought (even closed /
    // expired): money taken is never shown as not taken.
    if (before !== "captured") {
      const latest = paidyLatestCapture(payment);
      update.status = "captured";
      update.capture_id = latest?.id ?? row.capture_id ?? null;
      update.captured_at = latest?.created_at ?? row.captured_at ?? now;
      statusAfter = "captured";
    }
  } else if ((outcome === "closed" || outcome === "rejected") && before === "authorized") {
    update.status = outcome;
    update.closed_at = now;
    update.closed_reason = `${source}: ${event || String(payment.status)}`;
    statusAfter = outcome;
  }
  const { error: updErr } = await supabase.from("paidy_payments").update(update).eq("id", row.id);
  must(updErr, "paidy_payments update");

  // Closed or rejected on Paidy's side while a reviewer still had it in the
  // queue: nothing can be captured any more, so the submission is rejected.
  if ((outcome === "closed" || outcome === "rejected") && before === "authorized") {
    const { data: subs, error: subsErr } = await supabase
      .from("payment_submissions").select("id").eq("paidy_payment_id", row.id).in("status", ["submitted", "under_review"]);
    must(subsErr, "payment_submissions read");
    for (const sub of (subs ?? []) as { id: string }[]) {
      const { data: flipped, error: rejErr } = await supabase.from("payment_submissions").update({
        status: "rejected", updated_at: now,
        reviewer_notes: `Closed by Paidy (${event || payment.status}) before Confirm — the customer must pay again.`,
      }).eq("id", sub.id).in("status", ["submitted", "under_review"]).select("id");
      must(rejErr, "payment_submissions reject");
      if ((flipped ?? []).length === 0) continue; // a reviewer got there first
      const { error: audErr } = await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission", entity_id: sub.id, action: "submission_rejected",
        new_value_json: { reason: "paidy_closed_externally", paidy_payment_id: row.paidy_payment_id, event: event || null, source },
      });
      must(audErr, "audit_logs insert");
    }
    if ((subs ?? []).length > 0) {
      await paidyBell(supabase, "paidy_closed_externally", "Paidy authorisation closed before Confirm",
        `Paidy reports ${row.paidy_payment_id} as ${payment.status}; the pending submission was rejected. The customer must pay again.`,
        { cash_order_id: row.cash_order_id, paidy_payment_id: row.paidy_payment_id, event: event || null, source });
      flagged.push("closed_externally");
    }
  }

  // Captured on Paidy but no payment recorded in the Hub → staff finish it.
  if (outcome === "captured") {
    const { data: subs, error: subsErr } = await supabase
      .from("payment_submissions").select("id, status, confirmed_payment_id, processing_started_at")
      .eq("paidy_payment_id", row.id).order("created_at", { ascending: false });
    must(subsErr, "payment_submissions read");
    const list = (subs ?? []) as AnyRec[];
    const recorded = list.some((s) => s.confirmed_payment_id);
    const running = list.some((s) => s.status === "confirmed" && !s.confirmed_payment_id && !paidyConfirmLeaseExpired(s.processing_started_at));
    if (!recorded && !running) {
      const amount = Math.round(Number(payment.amount)).toLocaleString("en-US");
      const where = list.some((s) => s.status === "confirmed")
        ? `press "Finish recording" on its submission`
        : list.some((s) => s.status === "submitted" || s.status === "under_review")
          ? "press Confirm on its submission (the Hub records the capture; it does not charge again)"
          : "no live submission exists — record it by hand";
      await paidyBellOnce(supabase, "paidy_captured_unrecorded", "Paidy took a payment the Hub has not recorded",
        `${row.paidy_payment_id} · ¥${amount} · captured on Paidy, no payment in the Hub — ${where}`,
        { cash_order_id: row.cash_order_id, paidy_payment_id: row.paidy_payment_id, source });
      flagged.push("captured_unrecorded");
    }
  }

  // Refunds (P11): recorded, belled, never applied to the order.
  const { data: known, error: knownErr } = await supabase.from("paidy_refunds").select("refund_id").eq("paidy_payment_row", row.id);
  must(knownErr, "paidy_refunds read");
  const fresh = paidyNewRefunds(payment, ((known ?? []) as AnyRec[]).map((r) => String(r.refund_id)));
  let newRefunds = 0;
  for (const r of fresh) {
    const { data: ins, error: insErr } = await supabase.from("paidy_refunds").upsert({
      paidy_payment_row: row.id, cash_order_id: row.cash_order_id, refund_id: r.id,
      amount_jpy: r.amount, refunded_at: r.created_at ?? null, payload: r,
    }, { onConflict: "refund_id", ignoreDuplicates: true }).select("id");
    must(insErr, "paidy_refunds insert");
    if ((ins ?? []).length === 0) continue; // a concurrent sync recorded it
    newRefunds++;
    await paidyBell(supabase, "paidy_refund_recorded", "Paidy refund recorded",
      `${row.paidy_payment_id} · refund ¥${r.amount.toLocaleString("en-US")} (${r.id}) reported by Paidy. The order's balance was NOT changed — handle the refund decision in the Hub.`,
      { cash_order_id: row.cash_order_id, paidy_payment_id: row.paidy_payment_id, refund_id: r.id, amount_jpy: r.amount, source });
  }
  if (newRefunds > 0 || fresh.length > 0) {
    const { data: all, error: allErr } = await supabase.from("paidy_refunds").select("amount_jpy").eq("paidy_payment_row", row.id);
    must(allErr, "paidy_refunds total read");
    const total = ((all ?? []) as AnyRec[]).reduce((s, r) => s + Math.round(Number(r.amount_jpy) || 0), 0);
    const { error: totErr } = await supabase.from("paidy_payments").update({ refund_jpy: total, updated_at: now }).eq("id", row.id);
    must(totErr, "paidy_payments refund_jpy update");
    flagged.push("refund");
  }

  return { outcome, status_after: statusAfter, new_refunds: newRefunds, flagged };
}
