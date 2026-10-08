/**
 * Square ↔ Hub synchronisation (integrity 2026-10-04, docs/SQUARE-INTEGRITY.md).
 * ONE implementation used by square-webhook, square-reconcile, website and
 * review-payment-submission, so every path applies the same provider truth.
 *
 * Every database step is an atomic RPC (20261104100000_square_integrity.sql)
 * and every RPC error is checked (SQ02): a failed write throws, so the caller
 * records the work as failed and it is retried — never reported as synced.
 */

import { isAttemptReference, squareEnvironmentOf, squareModeFrom, type SquareEnvironment } from "./card-rules.ts";
import { paymentFacts, square, SquareError, type SquareDispute, type SquarePayment, type SquareRefund } from "./square.ts";
import { sendCardHoldReleasedEmail, sendCashPaymentRejectedEmail } from "./payment-rejected-email.ts";
import { sendOrderUpdateEmail, sendPaymentSubmittedEmail } from "./order-update-email.ts";
import { sendWebCancellationEmail } from "./web-cancellation-email.ts";
import { NEUTRAL_CANCEL_REASON } from "./customer-reasons.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export class SyncError extends Error {
  constructor(message: string, public retryable = true) { super(message); this.name = "SyncError"; }
}

/** Calls an RPC and throws on a transport/database error (never ignored). */
export async function rpc(db: Db, name: string, args: AnyRec): Promise<AnyRec> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new SyncError(`${name}: ${error.message ?? String(error)}`);
  return (data ?? {}) as AnyRec;
}

/** The environment of the current Square mode (off → null). */
export async function currentEnvironment(db: Db): Promise<SquareEnvironment | null> {
  const { data, error } = await db.from("system_settings").select("value").eq("key", "square_mode").maybeSingle();
  if (error) throw new SyncError(`system_settings: ${error.message}`);
  return squareEnvironmentOf(squareModeFrom(data?.value));
}

/** Which environment a Square payment id lives in: its row/attempt, else the current mode, else sandbox. */
export async function environmentForPayment(db: Db, squarePaymentId: string): Promise<SquareEnvironment> {
  const { data: row, error } = await db.from("square_payments").select("environment, test").eq("square_payment_id", squarePaymentId).maybeSingle();
  if (error) throw new SyncError(`square_payments: ${error.message}`);
  if (row) return (row.environment as SquareEnvironment | null) ?? (row.test ? "sandbox" : "production");
  const { data: att, error: aErr } = await db.from("square_card_attempts").select("environment").eq("square_payment_id", squarePaymentId).limit(1).maybeSingle();
  if (aErr) throw new SyncError(`square_card_attempts: ${aErr.message}`);
  if (att?.environment) return att.environment as SquareEnvironment;
  return (await currentEnvironment(db)) ?? "sandbox";
}

/** PHT calendar day — the submission date the Hub has always used for card filings. */
export function phtToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
}

/** Applies a Square read-back to the Hub (apply_square_payment_state). */
export async function applyPaymentState(db: Db, p: SquarePayment, source: string, userId: string | null = null): Promise<AnyRec> {
  const f = paymentFacts(p);
  const result = await rpc(db, "apply_square_payment_state", {
    p_square_payment_id: p.id, p_provider_status: p.status, p_amount_jpy: f.amountJpy, p_refunded_jpy: f.refundedJpy,
    p_currency: f.currency, p_provider_version: f.providerVersion, p_provider_updated_at: f.providerUpdatedAt,
    p_captured_at: f.capturedAt, p_capture_by: f.captureBy, p_card_brand: f.cardBrand, p_card_last4: f.cardLast4,
    p_receipt_url: f.receiptUrl, p_risk_level: f.riskLevel, p_provider_verification: f.verification,
    p_payload: p, p_source: source, p_user_id: userId,
  });
  // Square ended the hold itself (webhook / reconcile) and the SQL rejected the
  // waiting submission: tell the customer (owner 2026-10-05). A reviewer's
  // Reject ('void') and a Confirm's read-back ('review', 'capture') send their
  // own email from review-payment-submission, so they are skipped here.
  if ((result as AnyRec | null)?.submission_action === "rejected" && !["void", "review", "capture"].includes(source)) {
    const { data: sub } = await db.from("payment_submissions").select("id")
      .eq("square_payment_id", (result as AnyRec).square_row_id).eq("status", "rejected")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (sub?.id) await sendCashPaymentRejectedEmail(db, { submissionId: String(sub.id), kind: "provider_ended" });
  }
  return result;
}

/** The labels a filing carries: customer reference, invoice, sender name. */
export async function orderLabels(db: Db, orderId: string): Promise<{ reference: string; invoice: string; senderName: string | null; customerId: string | null }> {
  const { data, error } = await db.from("cash_orders").select("web_reference, invoice_number, customer_id, customers(full_name)").eq("id", orderId).maybeSingle();
  if (error) throw new SyncError(`cash_orders: ${error.message}`);
  return {
    reference: String(data?.web_reference ?? data?.invoice_number ?? ""),
    invoice: String(data?.invoice_number ?? ""),
    senderName: (data?.customers as AnyRec | null)?.full_name ?? null,
    customerId: data?.customer_id ?? null,
  };
}

/** Records an APPROVED payment for its attempt (file_square_authorization_atomic). */
export async function fileForAttempt(db: Db, attempt: AnyRec, p: SquarePayment, path: string): Promise<AnyRec> {
  const f = paymentFacts(p);
  const labels = await orderLabels(db, attempt.cash_order_id);
  const filed = await rpc(db, "file_square_authorization_atomic", {
    p_attempt_id: attempt.id, p_square_payment_id: p.id, p_amount_jpy: f.amountJpy, p_currency: f.currency,
    p_location_id: p.location_id ?? null, p_card_brand: f.cardBrand, p_card_last4: f.cardLast4, p_receipt_url: f.receiptUrl,
    p_authorized_at: f.authorizedAt, p_capture_by: f.captureBy, p_risk_level: f.riskLevel,
    p_provider_verification: f.verification, p_provider_version: f.providerVersion, p_provider_updated_at: f.providerUpdatedAt,
    p_payload: p, p_payment_date: phtToday(), p_sender_name: labels.senderName,
    p_notes: `Card authorisation (Square) from the website (${labels.reference})`,
    p_reference_label: labels.reference, p_path: path,
  });
  // Addendum §9 #1 (live finding CJ-W-900068: the hold sent nothing): she
  // hears that her card payment arrived and is a HOLD, not a charge — from
  // whichever path filed it. Only a NEW filing; once per submission.
  if (filed.outcome === "filed" && filed.submission?.id) {
    await sendPaymentSubmittedEmail(db, {
      submissionId: String(filed.submission.id),
      card: { brand: f.cardBrand, last4: f.cardLast4, holdUntil: f.captureBy },
    });
  }
  return filed;
}

export async function resolveAttempt(db: Db, attemptId: string, status: string, from: string[], extra: { squarePaymentId?: string | null; code?: string | null; detail?: string | null; risk?: string | null } = {}): Promise<AnyRec> {
  return await rpc(db, "resolve_square_attempt", {
    p_attempt_id: attemptId, p_status: status, p_from: from, p_square_payment_id: extra.squarePaymentId ?? null,
    p_error_code: extra.code ?? null, p_detail: extra.detail ?? null, p_risk_level: extra.risk ?? null,
  });
}

/**
 * Suspected fraud (owner 2026-10-04): void the hold first (if any), then cancel
 * the invoice through square_fraud_cancel (it refuses — and bells — when card
 * money is unresolved or other money was received). Returns its answer.
 */
export async function fraudCancel(db: Db, env: SquareEnvironment, orderId: string, trigger: string, detail: AnyRec, holdSquareId: string | null): Promise<AnyRec> {
  if (holdSquareId) {
    try {
      const voided = await square.cancel(env, holdSquareId);
      await applyPaymentState(db, voided, "void");
    } catch (e) {
      // The void is re-read below; an unresolved hold makes square_fraud_cancel stand down and bell staff.
      console.warn("[square-sync] fraud void failed:", e instanceof Error ? e.message : e);
      try { await applyPaymentState(db, await square.get(env, holdSquareId), "reconcile"); } catch { /* reconcile retries */ }
    }
  }
  const res = await rpc(db, "square_fraud_cancel", { p_order_id: orderId, p_trigger: trigger, p_detail: detail });
  // Addendum §9 #10: she is told the order was cancelled because her payment
  // could not be confirmed — never "fraud". Once per order.
  if (res.ok) await sendWebCancellationEmail(db, orderId, { reason: `${NEUTRAL_CANCEL_REASON.ja} / ${NEUTRAL_CANCEL_REASON.en}`, reasonByLang: NEUTRAL_CANCEL_REASON, refundStatus: null, refundNote: null, idempotencyKey: `order-cancelled-auto-${orderId}` });
  return res;
}

/**
 * After filing returned an exception: a mismatched hold is ours and wrong →
 * void it; risk HIGH → void + fraud cancel; a hold that arrived while Paidy
 * took the order (unfiled_hold / paidy_in_progress) → void it (the order is
 * Paidy's; nothing is charged). Any other unfiled hold (order could not take
 * it) is NOT voided automatically — staff decide (bell rung in SQL).
 */
export async function handleFilingException(db: Db, env: SquareEnvironment, attempt: AnyRec, p: SquarePayment, filed: AnyRec): Promise<string> {
  // Addendum §9 #10: a hold the Hub released by itself, with no submission to
  // reject, still reaches her — "the hold was released, nothing was charged",
  // never the internal reason. Once per Square payment.
  const released = (otherPaymentInProgress = false) => sendCardHoldReleasedEmail(db, { orderId: String(attempt.cash_order_id), amount: paymentFacts(p).amountJpy, squarePaymentId: p.id, otherPaymentInProgress });
  if (filed.exception === "amount_mismatch") {
    try { await applyPaymentState(db, await square.cancel(env, p.id), "void"); await released(); return "mismatch_voided"; }
    catch (e) { console.warn("[square-sync] mismatch void failed:", e instanceof Error ? e.message : e); return "mismatch_void_pending"; }
  }
  if (filed.exception === "unfiled_hold" && filed.reason === "paidy_in_progress") {
    // Her Paidy payment holds the order: never "pay again" — only "the card hold was released".
    try { await applyPaymentState(db, await square.cancel(env, p.id), "void"); await released(true); return "paidy_voided"; }
    catch (e) { console.warn("[square-sync] paidy-conflict void failed:", e instanceof Error ? e.message : e); return "paidy_void_pending"; }
  }
  if (filed.exception === "risk_high") {
    const res = await fraudCancel(db, env, attempt.cash_order_id, "risk_high", { square_payment_id: p.id, attempt: attempt.reference }, p.id);
    if (res.ok) return "risk_high_cancelled";
    // Not cancelled (staff decide): the hold was voided first — tell her so,
    // only if Square now says it is no longer held.
    try {
      const after = await square.get(env, p.id);
      if (after.status === "CANCELED") await released();
    } catch { /* reconcile re-reads it; no email without proof the hold is gone */ }
    return "risk_high_flagged";
  }
  return String(filed.exception ?? "exception");
}

/**
 * The one sync of a Square payment read-back (authoritative GetPayment or a
 * ListPayments row). Outcomes: synced | filed | attempt_resolved | exception |
 * quarantined (ours, no match yet — retry) | ignored_unrelated (not a Cha
 * Jewels attempt: never allocated).
 */
export async function syncSquarePayment(db: Db, env: SquareEnvironment, p: SquarePayment, source: string): Promise<{ outcome: string; detail?: AnyRec }> {
  const applied = await applyPaymentState(db, p, source);
  if (applied.ok) return { outcome: "synced", detail: applied };
  if (applied.error !== "unknown_payment") throw new SyncError(`apply_square_payment_state: ${applied.error}`);

  // No row: correlate through the attempt reference (SQ03).
  if (!isAttemptReference(p.reference_id)) return { outcome: "ignored_unrelated" };
  const { data: attempt, error } = await db.from("square_card_attempts").select("*").eq("reference", p.reference_id).maybeSingle();
  if (error) throw new SyncError(`square_card_attempts: ${error.message}`);
  if (!attempt) return { outcome: "quarantined" };

  if (p.status === "APPROVED" || p.status === "COMPLETED") {
    const filed = await fileForAttempt(db, attempt, p, `${source}_recovery`);
    if (filed.error) throw new SyncError(`file_square_authorization_atomic: ${filed.error}`);
    if (p.status === "COMPLETED") await applyPaymentState(db, p, source);
    if (filed.outcome === "exception") return { outcome: "exception", detail: { ...filed, action: await handleFilingException(db, env, attempt, p, filed) } };
    return { outcome: "filed", detail: filed };
  }
  if (p.status === "FAILED" || p.status === "CANCELED") {
    const to = p.status === "FAILED" ? "declined" : "cancelled";
    const res = await resolveAttempt(db, attempt.id, to, ["reserved", "unknown", "cancelling"], { squarePaymentId: p.id, code: `square_${p.status.toLowerCase()}` });
    if (res.ok && res.fraud) await fraudCancel(db, env, attempt.cash_order_id, String(res.fraud), { attempt: attempt.reference, counts: res.counts }, null);
    return { outcome: "attempt_resolved", detail: res };
  }
  return { outcome: "quarantined" }; // PENDING/UNKNOWN: look again later
}

/**
 * QC05 (2026-10-05): a refund or dispute can arrive BEFORE the Hub knows its
 * payment (Square does not order its events; the payment's own filing may have
 * failed). "Unknown payment" therefore proves nothing about relevance. The
 * parent is read from Square and synced first:
 *   ours      — the Hub now holds the payment row (filed / synced now);
 *   unrelated — Square has the payment and it is NOT a Cha Jewels web attempt
 *               (e.g. an in-person sale on the same account): safe to ignore;
 *   pending   — not visible yet, or ours but not filed yet: QUARANTINE and
 *               retry, never ignore (the inbox gives up after 12 tries, bell).
 */
export async function recoverParentPayment(db: Db, env: SquareEnvironment, paymentId: string): Promise<"ours" | "unrelated" | "pending"> {
  const { data: row, error } = await db.from("square_payments").select("id").eq("square_payment_id", paymentId).maybeSingle();
  if (error) throw new SyncError(`square_payments: ${error.message}`);
  if (row) return "ours";
  const got = await readPaymentAnyEnv(env, paymentId);
  if (!got) return "pending";
  if (!isAttemptReference(got.payment.reference_id)) return "unrelated";
  const r = await syncSquarePayment(db, got.env, got.payment, "parent_recovery");
  return r.outcome === "synced" || r.outcome === "filed" || r.outcome === "exception" ? "ours" : "pending";
}

/**
 * SQF02 (2026-10-09): the yen a Square refund may be recorded as — a positive
 * whole amount in JPY — or null. Null is never 0: a refund the Hub cannot read
 * as yen is quarantined (the inbox retries, then bells), never written.
 */
export function refundMoneyJpy(refund: SquareRefund): number | null {
  const m = refund.amount_money;
  if (!m || typeof m !== "object") return null;
  const amount = Number(m.amount);
  if (typeof m.amount !== "number" && typeof m.amount !== "string") return null;
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  if (String(m.currency ?? "").trim().toUpperCase() !== "JPY") return null;
  return amount;
}

/** A refund (refund.created / refund.updated, or reconcile): the refund record, then the payment's refunded total. */
export async function syncSquareRefund(db: Db, env: SquareEnvironment, refund: SquareRefund): Promise<{ outcome: string; detail?: string }> {
  if (!refund.payment_id) return { outcome: "quarantined", detail: "no_payment_id" };
  const amountJpy = refundMoneyJpy(refund);
  if (amountJpy === null) return { outcome: "quarantined", detail: "bad_money" };
  const record = async () => await rpc(db, "record_square_refund", {
    p_refund_id: refund.id, p_square_payment_id: refund.payment_id, p_status: refund.status,
    p_amount_jpy: amountJpy,
    p_reason: refund.reason ?? null, p_provider_created_at: refund.created_at ?? null,
    p_provider_updated_at: refund.updated_at ?? null, p_payload: refund,
  });
  let res = await record();
  if (!res.ok && res.error === "unknown_payment") {
    const parent = await recoverParentPayment(db, env, refund.payment_id);
    if (parent === "unrelated") return { outcome: "ignored_unrelated" };
    if (parent === "pending") return { outcome: "quarantined" };
    res = await record();
    if (!res.ok && res.error === "unknown_payment") return { outcome: "quarantined" };
  }
  // SQF02: the ledger's own refusals (bad_amount / bad_currency / over_ceiling /
  // parent_mismatch) ring their bell inside record_square_refund; here the
  // event is 'failed' (the inbox retries and gives up with a bell) and the
  // reason travels in the error.
  if (!res.ok) return { outcome: "failed", detail: String(res.error ?? "record_square_refund") };
  const got = await readPaymentAnyEnv(env, refund.payment_id);
  if (got) await applyPaymentState(db, got.payment, "reconcile");
  // Addendum §9 #9: a refund made in the Square Dashboard reaches her once it
  // COMPLETES — once per refund id (web orders only; never throws).
  const rec = (res.refund ?? {}) as AnyRec;
  if (res.changed === true && String(rec.status ?? "").toUpperCase() === "COMPLETED" && rec.cash_order_id) {
    await sendOrderUpdateEmail(db, {
      entity: "cash_order", id: String(rec.cash_order_id), variant: "refund_received",
      amount: Number(rec.amount_jpy ?? 0), refundMethod: "card",
      idempotencyKey: `refund-received-square-${refund.id}`,
    });
  }
  return { outcome: "synced" };
}

export async function syncSquareDispute(db: Db, dispute: SquareDispute, env?: SquareEnvironment): Promise<{ outcome: string }> {
  const paymentId = dispute.disputed_payment?.payment_id;
  if (!paymentId) return { outcome: "quarantined" };
  const amount = Number(dispute.amount_money?.amount);
  const record = async () => await rpc(db, "record_square_dispute", {
    p_dispute_id: dispute.id ?? dispute.dispute_id, p_square_payment_id: paymentId, p_state: dispute.state,
    p_reason: dispute.reason ?? null, p_amount_jpy: Number.isSafeInteger(amount) ? amount : null,
    p_due_at: dispute.due_at ?? null, p_provider_created_at: dispute.created_at ?? null,
    p_provider_updated_at: dispute.updated_at ?? null, p_payload: dispute,
  });
  let res = await record();
  if (!res.ok && res.error === "unknown_payment") {
    const parent = await recoverParentPayment(db, env ?? (await environmentForPayment(db, paymentId)), paymentId);
    if (parent === "unrelated") return { outcome: "ignored_unrelated" };
    if (parent === "pending") return { outcome: "quarantined" };
    res = await record();
    if (!res.ok && res.error === "unknown_payment") return { outcome: "quarantined" };
  }
  if (!res.ok) return { outcome: "failed" };
  return { outcome: "synced" };
}

/** Webhook payload → the object id the event is about. */
export function eventObjectId(event: AnyRec): { kind: "payment" | "refund" | "dispute" | "other"; id: string | null } {
  const type = String(event?.type ?? "");
  const data = (event?.data ?? {}) as AnyRec;
  const obj = (data.object ?? {}) as AnyRec;
  if (type.startsWith("payment.")) return { kind: "payment", id: String(obj.payment?.id ?? data.id ?? "") || null };
  if (type.startsWith("refund.")) return { kind: "refund", id: String(obj.refund?.id ?? data.id ?? "") || null };
  if (type.startsWith("dispute.")) return { kind: "dispute", id: String(obj.dispute?.id ?? obj.dispute?.dispute_id ?? data.id ?? "") || null };
  return { kind: "other", id: null };
}

/**
 * Processes one stored webhook event. Returns the inbox status:
 * done | ignored | quarantined | failed (+ error). Never throws.
 */
export async function processSquareEvent(db: Db, event: AnyRec): Promise<{ status: "done" | "ignored" | "quarantined" | "failed"; outcome: string; error?: string }> {
  const { kind, id } = eventObjectId(event);
  try {
    if (kind === "other" || !id) return { status: "ignored", outcome: "ignored_type" };
    if (kind === "payment") {
      const env = await environmentForPayment(db, id);
      const p = await readPaymentAnyEnv(env, id);
      // Not visible in either environment (yet): kept and retried, never
      // concluded to be irrelevant (QC05) — the inbox gives up after 12 tries.
      if (!p) return { status: "quarantined", outcome: "not_found" };
      const r = await syncSquarePayment(db, p.env, p.payment, "webhook");
      return r.outcome === "quarantined" ? { status: "quarantined", outcome: r.outcome }
        : r.outcome === "ignored_unrelated" ? { status: "ignored", outcome: r.outcome }
        : { status: "done", outcome: r.outcome };
    }
    if (kind === "refund") {
      const paymentId = String((event?.data?.object?.refund ?? {}).payment_id ?? "");
      const env = paymentId ? await environmentForPayment(db, paymentId) : ((await currentEnvironment(db)) ?? "sandbox");
      const refund = await square.getRefund(env, id);
      return childStatus(await syncSquareRefund(db, env, refund));
    }
    const paymentId = String((event?.data?.object?.dispute ?? {}).disputed_payment?.payment_id ?? "");
    const env = paymentId ? await environmentForPayment(db, paymentId) : ((await currentEnvironment(db)) ?? "sandbox");
    const dispute = await square.getDispute(env, id);
    return childStatus(await syncSquareDispute(db, dispute, env));
  } catch (e) {
    const msg = e instanceof SquareError ? `square ${e.status} ${e.code} (${e.kind})` : e instanceof Error ? e.message : String(e);
    return { status: "failed", outcome: "error", error: msg.slice(0, 500) };
  }
}

/** Inbox status for a refund / dispute sync outcome. */
export function childStatus(r: { outcome: string; detail?: string }): { status: "done" | "ignored" | "quarantined" | "failed"; outcome: string; error?: string } {
  if (r.outcome === "ignored_unrelated") return { status: "ignored", outcome: r.outcome };
  if (r.outcome === "quarantined") return { status: "quarantined", outcome: r.outcome, ...(r.detail ? { error: r.detail } : {}) };
  if (r.outcome === "failed") return { status: "failed", outcome: r.outcome, ...(r.detail ? { error: r.detail } : {}) };
  return { status: "done", outcome: r.outcome };
}

/** GetPayment in the expected environment; a 404 there is tried in the other one (a sandbox/live switch). */
export async function readPaymentAnyEnv(env: SquareEnvironment, id: string): Promise<{ env: SquareEnvironment; payment: SquarePayment } | null> {
  try {
    return { env, payment: await square.get(env, id) };
  } catch (e) {
    if (!(e instanceof SquareError) || e.status !== 404) throw e;
    const other: SquareEnvironment = env === "sandbox" ? "production" : "sandbox";
    try { return { env: other, payment: await square.get(other, id) }; }
    catch (e2) { if (e2 instanceof SquareError && (e2.status === 404 || e2.kind === "not_configured" || e2.kind === "auth")) return null; throw e2; }
  }
}

/**
 * A payment of this location carrying the attempt reference, from Square's
 * list around the attempt time. QC08 (2026-10-05): three answers, never two —
 *   found      — the payment;
 *   absent     — every page of the window was read and none matched;
 *   incomplete — the page budget ran out with pages left: NOTHING is concluded
 *                (the caller keeps the attempt open and looks again).
 */
export const PAYMENT_SEARCH_MAX_PAGES = 20;
export type PaymentSearch =
  | { state: "found"; payment: SquarePayment }
  | { state: "absent" }
  | { state: "incomplete"; pages: number; cursor: string | null };
/** R01: where an earlier incomplete search stopped (square_card_attempts.search_cursor / search_pages). */
export type PaymentSearchStart = { cursor: string | null; pages: number } | null;
type PaymentLister = (env: SquareEnvironment, q: { locationId: string; beginTime: string; endTime: string; cursor?: string | null }) => Promise<{ payments: SquarePayment[]; cursor: string | null }>;
export async function findPaymentByReference(
  env: SquareEnvironment, locationId: string, reference: string, createdMs: number,
  maxPages = PAYMENT_SEARCH_MAX_PAGES, start: PaymentSearchStart = null, lister: PaymentLister = square.list,
): Promise<PaymentSearch> {
  const begin = new Date(createdMs - 2 * 60 * 1000).toISOString();
  const end = new Date(Math.min(Date.now(), createdMs + 30 * 60 * 1000)).toISOString();
  // R01 (2026-10-08): resume where the previous run stopped instead of
  // re-reading page 1 every hour. A cursor Square refuses (the window moved
  // while the attempt was young, or it expired) restarts from page 1 — once.
  let cursor: string | null = start?.cursor ?? null;
  let readBefore = start?.pages ?? 0;
  for (let page = 0; page < maxPages; page++) {
    let r;
    try {
      r = await lister(env, { locationId, beginTime: begin, endTime: end, cursor });
    } catch (e) {
      if (cursor && cursor === start?.cursor && e instanceof SquareError && e.kind === "client") {
        cursor = null; readBefore = 0; page--;
        continue;
      }
      throw e;
    }
    const hit = r.payments.find((p) => p.reference_id === reference);
    if (hit) return { state: "found", payment: hit };
    if (!r.cursor) return { state: "absent" };
    cursor = r.cursor;
  }
  return { state: "incomplete", pages: readBefore + maxPages, cursor };
}

/**
 * R01: remember (or forget) where the payment search stopped. Best effort —
 * a failure here is logged and never changes the recovery outcome, which the
 * next run then simply repeats from page 1.
 */
async function saveSearchCursor(db: Db, a: AnyRec, patch: { search_cursor: string | null; search_pages?: number }): Promise<void> {
  try {
    const r = await db.from("square_card_attempts").update(patch).eq("id", a.id);
    if (r?.error) console.warn(`[square-sync] search cursor not saved for ${a.reference}: ${r.error.message}`);
  } catch (e) {
    console.warn(`[square-sync] search cursor not saved for ${a.reference}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Resolves an attempt whose create answer was lost (reserved / unknown) or
 * whose cancel was interrupted (cancelling). Found in Square's list → synced
 * (filed / resolved). Not found once older than giveUpMs → cancelled by its
 * idempotency key (Square answers success also when nothing exists — either
 * way nothing stays held under that key) and closed. Used by square-reconcile
 * (15 min) and by the website when the customer comes back (2 min).
 */
export async function recoverAttempt(db: Db, a: AnyRec, giveUpMs: number, source: string): Promise<"filed" | "resolved" | "cancelled" | "waiting" | "exception"> {
  const env = a.environment as SquareEnvironment;
  const created = Date.parse(String(a.created_at));
  // A known Square payment id is read directly — no search needed (QC08).
  let found: SquarePayment | null = null;
  if (a.square_payment_id) {
    const got = await readPaymentAnyEnv(env, String(a.square_payment_id));
    if (got) found = got.payment;
  }
  if (!found) {
    const search = await findPaymentByReference(env, String(a.location_id), String(a.reference), created, PAYMENT_SEARCH_MAX_PAGES,
      a.search_cursor ? { cursor: a.search_cursor as string, pages: Number(a.search_pages ?? 0) } : null);
    // An incomplete search proves nothing: the attempt stays open (QC08) and
    // R01 saves where it stopped so the next run continues from there.
    if (search.state === "incomplete") {
      await saveSearchCursor(db, a, { search_cursor: search.cursor, search_pages: search.pages });
      return "waiting";
    }
    if (a.search_cursor) await saveSearchCursor(db, a, { search_cursor: null });
    if (search.state === "found") found = search.payment;
  }
  if (found) {
    const r = await syncSquarePayment(db, env, found, source);
    if (r.outcome === "attempt_resolved") return "resolved";
    if (r.outcome === "exception") return "exception";
    if (r.outcome === "filed" || r.outcome === "synced") return "filed";
    return "waiting";
  }
  if (a.status !== "cancelling" && Date.now() - created < giveUpMs) return "waiting";
  if (a.status !== "cancelling") {
    const c = await resolveAttempt(db, String(a.id), "cancelling", ["reserved", "unknown"], { detail: `${source}: no payment found` });
    if (!c.ok) return "waiting";
  }
  try {
    await square.cancelByIdempotencyKey(env, String(a.idempotency_key));
  } catch (e) {
    await resolveAttempt(db, String(a.id), "unknown", ["cancelling"], { detail: `${source}: cancel by key failed` });
    throw e;
  }
  await resolveAttempt(db, String(a.id), "cancelled", ["cancelling"], { code: "cancelled_by_key", detail: `${source}: no payment found; cancelled by idempotency key` });
  return "cancelled";
}
