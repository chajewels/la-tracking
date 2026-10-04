/**
 * Bring the Hub's record of ONE Paidy payment in line with what Paidy says.
 * docs/PAIDY.md "Integrity" + "Follow-up". Shared by paidy-webhook (one
 * payment, on Paidy's notification) and paidy-reconcile (the sweep). The
 * payment passed in MUST be Paidy's own read-back.
 *
 * Owner 2026-10-04: staff CAPTURE in Paidy's merchant dashboard; the Hub
 * RECORDS what Paidy reports. So when Paidy shows a capture the Hub has not
 * recorded, this asks the one recording path (review-payment-submission,
 * through `opts.record`) to record it — exact yen, nothing refunded, its own
 * submission. Anything that cannot be recorded becomes a durable paidy_cases
 * row (and a bell the first time), never a silent drop.
 *
 * Every pass is a full repair, not a diff against what the Hub thought before
 * (R05): the record's status, the refund total (R06, from the ledger), the
 * queued submissions of a payment Paidy closed / rejected / let expire (R07)
 * are all re-derived from Paidy's answer, so a retry after a failure at any
 * write reaches the same end state as an uninterrupted pass.
 *
 * What it NEVER does: move money at Paidy, change an order's totals itself,
 * apply a refund to an order. Every write is checked and THROWS on failure.
 */

import { paidyBell } from "./paidy-filing.ts";
import {
  paidyCapturedAmount, paidyConfirmLeaseExpired, paidyLatestCapture, paidyNewRefunds,
  paidyProviderOutcome, paidyRecordProblem,
} from "./paidy-rules.ts";
import type { PaidyPayment } from "./paidy.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export const PAIDY_RECORD_FIELDS =
  "id, cash_order_id, customer_id, status, paidy_payment_id, amount_jpy, refund_jpy, expires_at, capture_id, captured_at, test, check_failures";

/** Rings a bell unless the same type already rang for the same payment in the last 24 h (the sweep must not spam). */
export async function paidyBellOnce(supabase: Db, type: string, title: string, body: string, metadata: AnyRec & { paidy_payment_id: string }): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("staff_notifications").select("id")
    .eq("type", type).contains("metadata", { paidy_payment_id: metadata.paidy_payment_id }).gte("created_at", since).limit(1);
  if (error) console.warn(`[paidy] bell dedupe read failed for ${type} (ringing anyway):`, error);
  else if ((data ?? []).length > 0) return false;
  return await paidyBell(supabase, type, title, body, metadata);
}

export type PaidyCaseKind =
  | "close_failed" | "captured_unrecorded" | "captured_no_submission" | "refund_before_record"
  | "refund_after_record" | "record_failed" | "unmatched_authorization" | "provider_unreadable" | "stale_authorization";

/**
 * Opens (or refreshes) the durable case; rings the bell only when the case is
 * new. THROWS when the case cannot be written — the caller must not
 * acknowledge an event whose only trace would be lost (R08).
 */
export async function openPaidyCase(supabase: Db, c: {
  kind: PaidyCaseKind; paidy_payment_id: string; cash_order_id?: string | null; paidy_payment_row?: string | null;
  submission_id?: string | null; detail?: AnyRec; bell?: { title: string; body: string };
}): Promise<{ case_id: string | null; new: boolean }> {
  const { data, error } = await supabase.rpc("open_paidy_case", {
    p_kind: c.kind, p_paidy_payment_id: c.paidy_payment_id, p_cash_order_id: c.cash_order_id ?? null,
    p_paidy_payment_row: c.paidy_payment_row ?? null, p_submission_id: c.submission_id ?? null, p_detail: c.detail ?? {},
  });
  if (error) throw new Error(`open_paidy_case ${c.kind}: ${error.message ?? String(error)}`);
  const r = (data ?? {}) as AnyRec;
  if (r.new === true && c.bell) {
    await paidyBell(supabase, `paidy_case_${c.kind}`, c.bell.title, c.bell.body,
      { case_id: r.case_id, cash_order_id: c.cash_order_id ?? null, paidy_payment_id: c.paidy_payment_id, kind: c.kind });
  }
  return { case_id: (r.case_id as string) ?? null, new: r.new === true };
}

function must(error: unknown, what: string) {
  if (error) throw new Error(`${what}: ${(error as { message?: string })?.message ?? String(error)}`);
}

export interface RecordResult { ok: boolean; status: number; error?: string; message?: string; handled?: boolean }
export interface SyncOptions {
  /** Records a claimed-or-queued Paidy submission through review-payment-submission (service role). */
  record?: (submissionId: string) => Promise<RecordResult>;
}
export interface SyncResult { outcome: string; status_after: string; new_refunds: number; flagged: string[] }

const yen = (n: unknown) => `¥${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

export async function syncPaidyPayment(
  supabase: Db, row: AnyRec, payment: PaidyPayment, source: "webhook" | "reconcile", event = "", opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = new Date().toISOString();
  const outcome = paidyProviderOutcome(payment);
  const pid = String(row.paidy_payment_id);
  const flagged: string[] = [];

  // 1. Refunds first (R06/R17): a case for every refund the ledger has not
  //    seen, THEN the ledger row — so a crash between them is repaired by the
  //    retry (the refund is still "fresh" and the case is refreshed, not lost).
  const { data: known, error: knownErr } = await supabase.from("paidy_refunds").select("refund_id").eq("paidy_payment_row", row.id);
  must(knownErr, "paidy_refunds read");
  const fresh = paidyNewRefunds(payment, ((known ?? []) as AnyRec[]).map((r) => String(r.refund_id)));

  const { data: subsData, error: subsErr } = await supabase
    .from("payment_submissions").select("id, status, confirmed_payment_id, processing_started_at, submitted_amount, created_at")
    .eq("paidy_payment_id", row.id).order("created_at", { ascending: false });
  must(subsErr, "payment_submissions read");
  const subs = (subsData ?? []) as AnyRec[];
  const recorded = subs.some((s) => s.confirmed_payment_id);

  let newRefunds = 0;
  for (const r of fresh) {
    await openPaidyCase(supabase, {
      kind: recorded ? "refund_after_record" : "refund_before_record",
      paidy_payment_id: pid, cash_order_id: row.cash_order_id, paidy_payment_row: row.id,
      detail: { refund_id: r.id, refund_jpy: r.amount, capture_id: r.capture_id ?? null, captured_jpy: paidyCapturedAmount(payment), reopen: true },
      bell: recorded
        ? { title: "Paidy refund on a recorded payment", body: `${pid} · refund ${yen(r.amount)} (${r.id}) reported by Paidy. The order was NOT changed — decide in Payment Submissions → Paidy cases.` }
        : { title: "Paidy refund before the payment was recorded", body: `${pid} · refund ${yen(r.amount)} (${r.id}). The Hub did NOT record this payment (owner rule: a refund is a staff decision) — open Payment Submissions → Paidy cases.` },
    });
    const { data: ins, error: insErr } = await supabase.from("paidy_refunds").upsert({
      paidy_payment_row: row.id, cash_order_id: row.cash_order_id, refund_id: r.id,
      amount_jpy: r.amount, refunded_at: r.created_at ?? null, payload: r.raw,
    }, { onConflict: "refund_id", ignoreDuplicates: true }).select("id");
    must(insErr, "paidy_refunds insert");
    if ((ins ?? []).length > 0) newRefunds++;
  }
  if (fresh.length > 0) flagged.push("refund");

  // 2. The record: status re-derived from Paidy every pass (R05/R07), refund
  //    total recomputed from the ledger every pass (R06).
  const { data: ledger, error: ledgerErr } = await supabase.from("paidy_refunds").select("amount_jpy").eq("paidy_payment_row", row.id);
  must(ledgerErr, "paidy_refunds total read");
  const refundTotal = ((ledger ?? []) as AnyRec[]).reduce((s, r) => s + (Number(r.amount_jpy) || 0), 0);

  const update: AnyRec = { last_payload: payment, updated_at: now, last_checked_at: now, check_failures: 0, refund_jpy: refundTotal };
  if (source === "webhook") update.last_webhook_at = now;
  if (payment.expires_at) update.expires_at = payment.expires_at;
  let statusAfter = String(row.status);
  if (outcome === "captured") {
    const latest = paidyLatestCapture(payment);
    statusAfter = "captured";
    update.status = "captured";
    update.capture_id = latest?.id ?? row.capture_id ?? null;
    update.captured_at = latest?.created_at ?? row.captured_at ?? now;
  } else if ((outcome === "closed" || outcome === "rejected" || outcome === "expired") && row.status === "authorized") {
    statusAfter = outcome;
    update.status = outcome;
    update.closed_at = now;
    update.closed_reason = `${source}: ${event || String(payment.status)}${outcome === "expired" ? " (past expires_at)" : ""}`;
  }
  const { error: updErr } = await supabase.from("paidy_payments").update(update).eq("id", row.id);
  must(updErr, "paidy_payments update");

  // 3. Paidy will never pay this one (closed / rejected / expired, nothing
  //    captured): every still-QUEUED submission is rejected — whatever the
  //    Hub's status was before (R05), so a retry finishes a half-done pass.
  if (outcome === "closed" || outcome === "rejected" || outcome === "expired") {
    let rejected = 0;
    for (const sub of subs.filter((s) => s.status === "submitted" || s.status === "under_review")) {
      const { data: flipped, error: rejErr } = await supabase.from("payment_submissions").update({
        status: "rejected", updated_at: now, processing_started_at: null,
        reviewer_notes: outcome === "expired"
          ? "The Paidy authorisation expired before it was captured — the customer may pay again (Paidy or bank transfer)."
          : `Paidy reports this payment ${String(payment.status)} (${event || source}) — nothing was charged; the customer may pay again.`,
      }).eq("id", sub.id).in("status", ["submitted", "under_review"]).select("id");
      must(rejErr, "payment_submissions reject");
      if ((flipped ?? []).length === 0) continue; // a reviewer got there first
      rejected++;
      const { error: audErr } = await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission", entity_id: sub.id, action: "submission_rejected",
        new_value_json: { reason: `paidy_${outcome}`, paidy_payment_id: pid, event: event || null, source },
      });
      must(audErr, "audit_logs insert");
    }
    if (rejected > 0) {
      await paidyBellOnce(supabase, "paidy_closed_externally", outcome === "expired" ? "Paidy authorisation expired before capture" : "Paidy payment ended before capture",
        `${pid} · Paidy: ${String(payment.status)}${outcome === "expired" ? " (expired)" : ""}. The pending submission was rejected; the customer can pay again.`,
        { cash_order_id: row.cash_order_id, paidy_payment_id: pid, event: event || null, source });
      flagged.push(outcome === "expired" ? "expired" : "closed_externally");
    }
  }

  // 3b. Still authorised, still queued, but the ORDER was cancelled / expired
  //     meanwhile: nothing may be captured — staff must Reject it (which
  //     releases it). A durable case, never an automatic status change.
  if (outcome === "authorized" && subs.some((s) => s.status === "submitted" || s.status === "under_review")) {
    const { data: ord, error: ordErr } = await supabase.from("cash_orders").select("status").eq("id", row.cash_order_id).maybeSingle();
    must(ordErr, "cash_orders read");
    const st = String((ord as AnyRec | null)?.status ?? "");
    if (st === "cancelled" || st === "expired") {
      await openPaidyCase(supabase, {
        kind: "stale_authorization", paidy_payment_id: pid, cash_order_id: row.cash_order_id, paidy_payment_row: row.id,
        detail: { reason: `order_${st}` },
        bell: { title: "Paidy authorisation on a closed order", body: `${pid} · the order is ${st} but Paidy still holds the authorisation. Reject its submission in Payment Submissions (that releases it) — do NOT capture it in the Paidy dashboard.` },
      });
      flagged.push("order_closed");
    }
  }

  // 4. Captured on Paidy and not recorded in the Hub → record it (owner D1),
  //    or open the case that says why not.
  if (outcome === "captured" && !recorded) {
    const captured = paidyCapturedAmount(payment);
    const running = subs.find((s) => s.status === "confirmed" && !s.confirmed_payment_id && !paidyConfirmLeaseExpired(s.processing_started_at));
    const live = subs.find((s) => s.status === "submitted" || s.status === "under_review"
      || (s.status === "confirmed" && !s.confirmed_payment_id && paidyConfirmLeaseExpired(s.processing_started_at)));
    const problem = live ? paidyRecordProblem({ capturedAmount: captured, recordAmount: row.amount_jpy, submittedAmount: live.submitted_amount, refundedAmount: refundTotal }) : null;
    if (running) {
      flagged.push("recording_in_progress");
    } else if (refundTotal > 0) {
      flagged.push("refund_before_record"); // case opened in step 1; nothing recorded (owner D4)
    } else if (!live) {
      await openPaidyCase(supabase, {
        kind: "captured_no_submission", paidy_payment_id: pid, cash_order_id: row.cash_order_id, paidy_payment_row: row.id,
        detail: { captured_jpy: captured, capture_id: paidyLatestCapture(payment)?.id ?? null, last_submission_status: subs[0]?.status ?? null },
        bell: { title: "Paidy took a payment with no live submission", body: `${pid} · ${yen(captured)} · captured in the Paidy dashboard, but its submission was rejected or cancelled. Decide in Payment Submissions → Paidy cases (record it, or refund it in Paidy).` },
      });
      flagged.push("captured_unrecorded");
    } else if (problem) {
      await openPaidyCase(supabase, {
        kind: "record_failed", paidy_payment_id: pid, cash_order_id: row.cash_order_id, paidy_payment_row: row.id, submission_id: live.id,
        detail: { reason: problem, captured_jpy: captured, authorized_jpy: row.amount_jpy, submitted_jpy: live.submitted_amount },
        bell: { title: "Paidy capture does not match its submission", body: `${pid} · captured ${yen(captured)} · ${problem}. Nothing was recorded — check the Paidy dashboard (Payment Submissions → Paidy cases).` },
      });
      flagged.push("captured_unrecorded");
    } else if (opts.record) {
      const res = await opts.record(String(live.id));
      if (res.ok) {
        flagged.push("auto_recorded");
      } else if (res.handled) {
        flagged.push("recording_in_progress");
      } else {
        await openPaidyCase(supabase, {
          kind: "record_failed", paidy_payment_id: pid, cash_order_id: row.cash_order_id, paidy_payment_row: row.id, submission_id: live.id,
          detail: { reason: res.error ?? `http_${res.status}`, message: res.message ?? null },
          bell: { title: "Paidy capture could not be recorded", body: `${pid} · ${yen(captured)} · ${res.message ?? res.error ?? `HTTP ${res.status}`}. The sweep retries; Payment Submissions → Paidy cases shows it.` },
        });
        flagged.push("captured_unrecorded");
      }
    } else {
      flagged.push("captured_unrecorded");
    }
  }

  // 5. Cases Paidy's own state has now settled are closed by the system
  //    (audited): a capture that got recorded, a close that went through.
  const settled: PaidyCaseKind[] = [];
  if (outcome === "captured" && (recorded || flagged.includes("auto_recorded"))) settled.push("record_failed", "captured_unrecorded", "captured_no_submission");
  if (outcome === "closed" || outcome === "rejected" || outcome === "expired") settled.push("close_failed");
  if (settled.length > 0) {
    const { data: open, error: openErr } = await supabase.from("paidy_cases").select("id, kind")
      .eq("paidy_payment_id", pid).eq("status", "open").in("kind", settled);
    must(openErr, "paidy_cases read");
    for (const c of (open ?? []) as AnyRec[]) {
      const { error } = await supabase.rpc("close_paidy_case_system", {
        p_case_id: c.id, p_resolution: c.kind === "close_failed" ? "released" : "recorded",
        p_note: `Paidy reports ${String(payment.status)}${outcome === "captured" ? " and the Hub has recorded the capture" : " — nothing to capture"} (${source}).`,
      });
      must(error, "close_paidy_case_system");
    }
  }

  return { outcome, status_after: statusAfter, new_refunds: newRefunds, flagged };
}
