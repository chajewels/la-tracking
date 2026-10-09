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
  paidyProviderOutcome, paidyRecordProblem, paidyRefundReceivedKey,
} from "./paidy-rules.ts";
import type { PaidyPayment } from "./paidy.ts";
import { sendCashPaymentRejectedEmail } from "./payment-rejected-email.ts";
import { sendOrderUpdateEmail } from "./order-update-email.ts";

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
    // PA07 (2026-10-08): the bell's success is RECORDED on the case; a bell
    // that did not ring leaves bell_rung_at NULL and the sweep rings it once.
    const rang = await paidyBell(supabase, `paidy_case_${c.kind}`, c.bell.title, c.bell.body,
      { case_id: r.case_id, cash_order_id: c.cash_order_id ?? null, paidy_payment_id: c.paidy_payment_id, kind: c.kind });
    if (rang && r.case_id) {
      const { error } = await supabase.from("paidy_cases").update({ bell_rung_at: new Date().toISOString() }).eq("id", r.case_id);
      if (error) console.warn("[paidy] bell_rung_at stamp failed (the sweep may ring once more):", error);
    }
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
  if (fresh.length > 0) flagged.push("refund");

  // 2. The record: status re-derived from Paidy every pass (R05/R07); the
  //    refund total is the LEDGER's after this pass's refunds are recorded
  //    (R06, below) — never Paidy's unverified figure, never a cached one.

  // P02 (reassessment 2026-10-06): two passes for the same payment can overlap
  // (webhook + sweep, or two deliveries). Each write below is a compare-and-set
  // on the DATABASE row, never on the caller's cached copy, so an older answer
  // arriving late can never undo a newer financial fact:
  //   - a capture is terminal: nothing after it moves the status off 'captured';
  //   - closed / rejected / expired only ever replace 'authorized';
  //   - the refund total only ever grows (ledger rows are never deleted);
  //   - a non-capture answer never overwrites a captured row's snapshot.
  const touch: AnyRec = { updated_at: now, last_checked_at: now, check_failures: 0 };
  if (source === "webhook") touch.last_webhook_at = now;
  let statusAfter = String(row.status);
  if (outcome === "captured") {
    const latest = paidyLatestCapture(payment);
    const capUpd: AnyRec = { ...touch, last_payload: payment, status: "captured",
      captured_at: latest?.created_at ?? row.captured_at ?? now };
    if (latest?.id) capUpd.capture_id = latest.id;
    if (payment.expires_at) capUpd.expires_at = payment.expires_at;
    const { error: capErr } = await supabase.from("paidy_payments").update(capUpd).eq("id", row.id);
    must(capErr, "paidy_payments capture update");
  } else {
    const meta: AnyRec = { ...touch, last_payload: payment };
    if (payment.expires_at) meta.expires_at = payment.expires_at;
    const { error: metaErr } = await supabase.from("paidy_payments").update(meta).eq("id", row.id).neq("status", "captured");
    must(metaErr, "paidy_payments update");
    if (outcome === "closed" || outcome === "rejected" || outcome === "expired") {
      const { error: endErr } = await supabase.from("paidy_payments").update({
        status: outcome, closed_at: now,
        closed_reason: `${source}: ${event || String(payment.status)}${outcome === "expired" ? " (past expires_at)" : ""}`,
      }).eq("id", row.id).eq("status", "authorized");
      must(endErr, "paidy_payments status update");
    }
  }
  // PA02 (owner brief 2026-10-08): every refund Paidy reports is RECORDED
  // through record_paidy_refund — the only writer of paidy_refunds. It locks
  // the ORDER first (the cancel RPCs hold the same lock, so a refund and a
  // cancel serialise), inserts idempotently by refund id, raises refund_jpy
  // monotonically, and rings paidy_refund_after_credit when the order already
  // holds a cancellation credit lot. Runs AFTER the capture status is written
  // (a refund only exists on a capture). Verified before the call (owner
  // correction 1): the payment object passed the PA12 validator for THIS id
  // (whole-yen amounts, refund→capture linkage), and the environment of the
  // read-back matches the row's — a mismatch records nothing and is flagged.
  const envOk = typeof row.test !== "boolean" || payment.test === row.test;
  const captureIdOf = (r: { capture_id?: string }) => r.capture_id ?? paidyLatestCapture(payment)?.id ?? null;
  for (const r of fresh) {
    await openPaidyCase(supabase, {
      kind: recorded ? "refund_after_record" : "refund_before_record",
      paidy_payment_id: pid, cash_order_id: row.cash_order_id, paidy_payment_row: row.id,
      detail: { refund_id: r.id, refund_jpy: r.amount, capture_id: r.capture_id ?? null, captured_jpy: paidyCapturedAmount(payment), reopen: true },
      bell: recorded
        ? { title: "Paidy refund on a recorded payment", body: `${pid} · refund ${yen(r.amount)} (${r.id}) reported by Paidy. The order was NOT changed — decide in Payment Submissions → Paidy cases.` }
        : { title: "Paidy refund before the payment was recorded", body: `${pid} · refund ${yen(r.amount)} (${r.id}). The Hub did NOT record this payment (owner rule: a refund is a staff decision) — open Payment Submissions → Paidy cases.` },
    });
    if (!envOk || payment.id !== pid) {
      console.error(`[paidy-sync] refund ${r.id} on ${pid} NOT recorded: read-back env/id mismatch (row.test=${String(row.test)}, payment.test=${String(payment.test)}, payment.id=${payment.id})`);
      flagged.push("refund_unverified");
      continue;
    }
    const { data: rec, error: recErr } = await supabase.rpc("record_paidy_refund", {
      p_refund_id: r.id, p_paidy_payment_row: row.id, p_amount_jpy: r.amount, p_capture_id: captureIdOf(r),
      p_refunded_at: r.created_at ?? null, p_payload: r.raw,
    });
    must(recErr, "record_paidy_refund");
    const res = (rec ?? {}) as AnyRec;
    if (!res.ok) {
      console.error(`[paidy-sync] record_paidy_refund refused ${r.id} on ${pid}:`, res.error);
      flagged.push(`refund_${String(res.error ?? "refused")}`);
      continue;
    }
    if (res.bell) flagged.push("refund_after_credit");
    if (res.inserted) {
      newRefunds++;
      // Addendum §9 #9: a refund made in the Paidy dashboard reaches her —
      // once per Paidy refund id, only when this pass recorded it (web orders
      // only; never throws, never blocks the sync).
      if (row.cash_order_id) {
        await sendOrderUpdateEmail(supabase, {
          entity: "cash_order", id: String(row.cash_order_id), variant: "refund_received",
          amount: r.amount, refundMethod: "paidy", idempotencyKey: paidyRefundReceivedKey(r.id),
        });
      }
    }
  }
  // The ledger total AFTER this pass's refunds (R06): the RPC already raised
  // refund_jpy; this re-read keeps the row monotonic against an older pass.
  const { data: ledger2, error: ledger2Err } = await supabase.from("paidy_refunds").select("amount_jpy").eq("paidy_payment_row", row.id);
  must(ledger2Err, "paidy_refunds total read");
  const refundTotalAfter = ((ledger2 ?? []) as AnyRec[]).reduce((s, r) => s + (Number(r.amount_jpy) || 0), 0);
  const { error: refErr } = await supabase.from("paidy_payments").update({ refund_jpy: refundTotalAfter })
    .eq("id", row.id).or(`refund_jpy.is.null,refund_jpy.lt.${refundTotalAfter}`);
  must(refErr, "paidy_payments refund total");
  // What the row says NOW (after any concurrent pass) decides what follows.
  const { data: nowRow, error: nowErr } = await supabase.from("paidy_payments").select("status").eq("id", row.id).maybeSingle();
  must(nowErr, "paidy_payments re-read");
  statusAfter = String((nowRow as AnyRec | null)?.status ?? statusAfter);

  // 3. Paidy will never pay this one (closed / rejected / expired, nothing
  //    captured): every still-QUEUED submission is rejected — whatever the
  //    Hub's status was before (R05), so a retry finishes a half-done pass.
  // P02: never when the row is captured — an older "closed" arriving late must
  // not reject the submission that records money Paidy took.
  if ((outcome === "closed" || outcome === "rejected" || outcome === "expired") && statusAfter !== "captured") {
    let rejected = 0;
    for (const sub of subs.filter((s) => s.status === "submitted" || s.status === "under_review")) {
      // M4 (Paidy QC 2026-10-09): the Paidy row, the rejection, the audit row
      // and the customer-email intent in ONE transaction. A retry after a
      // lost answer sees already_rejected and changes nothing; an email the
      // sender never reached is replayed by the sweep from the intent.
      const { data: ended, error: endErr } = await supabase.rpc("end_paidy_submission_provider_ended_atomic", {
        p_submission_id: sub.id, p_paidy_row: row.id, p_end_status: outcome,
        p_end_reason: `${outcome} at Paidy (${event || source})`,
        p_reviewer_notes: outcome === "expired"
          ? "The Paidy authorisation expired before it was captured — the customer may pay again (Paidy or bank transfer)."
          : `Paidy reports this payment ${String(payment.status)} (${event || source}) — nothing was charged; the customer may pay again.`,
        p_payload: payment, p_audit: { event: event || null, source },
      });
      must(endErr, "end_paidy_submission_provider_ended_atomic");
      const res = (ended ?? {}) as AnyRec;
      if (!res.ok || res.rejected !== true) continue; // a reviewer got there first, or it was captured
      rejected++;
      // The customer hears it from us — Paidy never emails a cancellation.
      await sendCashPaymentRejectedEmail(supabase, { submissionId: sub.id, kind: "provider_ended" });
      if (res.followup_key) {
        const { error: fuErr } = await supabase.from("payment_submission_followups")
          .update({ status: "done", done_at: new Date().toISOString(), attempts: 1 })
          .eq("idempotency_key", res.followup_key).eq("status", "pending");
        if (fuErr) console.warn("[paidy-sync] followup mark-done failed (the sweep re-checks it):", fuErr);
      }
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
    const problem = live ? paidyRecordProblem({ capturedAmount: captured, recordAmount: row.amount_jpy, submittedAmount: live.submitted_amount, refundedAmount: refundTotalAfter }) : null;
    if (running) {
      flagged.push("recording_in_progress");
    } else if (refundTotalAfter > 0) {
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
