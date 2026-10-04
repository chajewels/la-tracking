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
  return await rpc(db, "apply_square_payment_state", {
    p_square_payment_id: p.id, p_provider_status: p.status, p_amount_jpy: f.amountJpy, p_refunded_jpy: f.refundedJpy,
    p_currency: f.currency, p_provider_version: f.providerVersion, p_provider_updated_at: f.providerUpdatedAt,
    p_captured_at: f.capturedAt, p_capture_by: f.captureBy, p_card_brand: f.cardBrand, p_card_last4: f.cardLast4,
    p_receipt_url: f.receiptUrl, p_risk_level: f.riskLevel, p_provider_verification: f.verification,
    p_payload: p, p_source: source, p_user_id: userId,
  });
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
  return await rpc(db, "file_square_authorization_atomic", {
    p_attempt_id: attempt.id, p_square_payment_id: p.id, p_amount_jpy: f.amountJpy, p_currency: f.currency,
    p_location_id: p.location_id ?? null, p_card_brand: f.cardBrand, p_card_last4: f.cardLast4, p_receipt_url: f.receiptUrl,
    p_authorized_at: f.authorizedAt, p_capture_by: f.captureBy, p_risk_level: f.riskLevel,
    p_provider_verification: f.verification, p_provider_version: f.providerVersion, p_provider_updated_at: f.providerUpdatedAt,
    p_payload: p, p_payment_date: phtToday(), p_sender_name: labels.senderName,
    p_notes: `Card authorisation (Square) from the website (${labels.reference})`,
    p_reference_label: labels.reference, p_path: path,
  });
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
  return await rpc(db, "square_fraud_cancel", { p_order_id: orderId, p_trigger: trigger, p_detail: detail });
}

/**
 * After filing returned an exception: a mismatched hold is ours and wrong →
 * void it; risk HIGH → void + fraud cancel; a hold that arrived while Paidy
 * took the order (unfiled_hold / paidy_in_progress) → void it (the order is
 * Paidy's; nothing is charged). Any other unfiled hold (order could not take
 * it) is NOT voided automatically — staff decide (bell rung in SQL).
 */
export async function handleFilingException(db: Db, env: SquareEnvironment, attempt: AnyRec, p: SquarePayment, filed: AnyRec): Promise<string> {
  if (filed.exception === "amount_mismatch") {
    try { await applyPaymentState(db, await square.cancel(env, p.id), "void"); return "mismatch_voided"; }
    catch (e) { console.warn("[square-sync] mismatch void failed:", e instanceof Error ? e.message : e); return "mismatch_void_pending"; }
  }
  if (filed.exception === "unfiled_hold" && filed.reason === "paidy_in_progress") {
    try { await applyPaymentState(db, await square.cancel(env, p.id), "void"); return "paidy_voided"; }
    catch (e) { console.warn("[square-sync] paidy-conflict void failed:", e instanceof Error ? e.message : e); return "paidy_void_pending"; }
  }
  if (filed.exception === "risk_high") {
    const res = await fraudCancel(db, env, attempt.cash_order_id, "risk_high", { square_payment_id: p.id, attempt: attempt.reference }, p.id);
    return res.ok ? "risk_high_cancelled" : "risk_high_flagged";
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

/** A refund (refund.created / refund.updated, or reconcile): the refund record, then the payment's refunded total. */
export async function syncSquareRefund(db: Db, env: SquareEnvironment, refund: SquareRefund): Promise<{ outcome: string }> {
  if (!refund.payment_id) return { outcome: "ignored_unrelated" };
  const res = await rpc(db, "record_square_refund", {
    p_refund_id: refund.id, p_square_payment_id: refund.payment_id, p_status: refund.status,
    p_amount_jpy: Number.isSafeInteger(Number(refund.amount_money?.amount)) ? Number(refund.amount_money?.amount) : 0,
    p_reason: refund.reason ?? null, p_provider_created_at: refund.created_at ?? null,
    p_provider_updated_at: refund.updated_at ?? null, p_payload: refund,
  });
  if (!res.ok) return { outcome: res.error === "unknown_payment" ? "ignored_unrelated" : "failed" };
  await applyPaymentState(db, await square.get(env, refund.payment_id), "reconcile");
  return { outcome: "synced" };
}

export async function syncSquareDispute(db: Db, dispute: SquareDispute): Promise<{ outcome: string }> {
  const paymentId = dispute.disputed_payment?.payment_id;
  if (!paymentId) return { outcome: "ignored_unrelated" };
  const amount = Number(dispute.amount_money?.amount);
  const res = await rpc(db, "record_square_dispute", {
    p_dispute_id: dispute.id ?? dispute.dispute_id, p_square_payment_id: paymentId, p_state: dispute.state,
    p_reason: dispute.reason ?? null, p_amount_jpy: Number.isSafeInteger(amount) ? amount : null,
    p_due_at: dispute.due_at ?? null, p_provider_created_at: dispute.created_at ?? null,
    p_provider_updated_at: dispute.updated_at ?? null, p_payload: dispute,
  });
  if (!res.ok) return { outcome: res.error === "unknown_payment" ? "ignored_unrelated" : "failed" };
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
      if (!p) return { status: "ignored", outcome: "not_found" };
      const r = await syncSquarePayment(db, p.env, p.payment, "webhook");
      return r.outcome === "quarantined" ? { status: "quarantined", outcome: r.outcome }
        : r.outcome === "ignored_unrelated" ? { status: "ignored", outcome: r.outcome }
        : { status: "done", outcome: r.outcome };
    }
    if (kind === "refund") {
      const paymentId = String((event?.data?.object?.refund ?? {}).payment_id ?? "");
      const env = paymentId ? await environmentForPayment(db, paymentId) : ((await currentEnvironment(db)) ?? "sandbox");
      const refund = await square.getRefund(env, id);
      const r = await syncSquareRefund(db, env, refund);
      return r.outcome === "ignored_unrelated" ? { status: "ignored", outcome: r.outcome } : { status: r.outcome === "failed" ? "failed" : "done", outcome: r.outcome };
    }
    const paymentId = String((event?.data?.object?.dispute ?? {}).disputed_payment?.payment_id ?? "");
    const env = paymentId ? await environmentForPayment(db, paymentId) : ((await currentEnvironment(db)) ?? "sandbox");
    const dispute = await square.getDispute(env, id);
    const r = await syncSquareDispute(db, dispute);
    return r.outcome === "ignored_unrelated" ? { status: "ignored", outcome: r.outcome } : { status: r.outcome === "failed" ? "failed" : "done", outcome: r.outcome };
  } catch (e) {
    const msg = e instanceof SquareError ? `square ${e.status} ${e.code} (${e.kind})` : e instanceof Error ? e.message : String(e);
    return { status: "failed", outcome: "error", error: msg.slice(0, 500) };
  }
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

/** A payment of this location carrying the attempt reference, from Square's list around the attempt time. */
export async function findPaymentByReference(env: SquareEnvironment, locationId: string, reference: string, createdMs: number): Promise<SquarePayment | null> {
  const begin = new Date(createdMs - 2 * 60 * 1000).toISOString();
  const end = new Date(Math.min(Date.now(), createdMs + 30 * 60 * 1000)).toISOString();
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const r = await square.list(env, { locationId, beginTime: begin, endTime: end, cursor });
    const hit = r.payments.find((p) => p.reference_id === reference);
    if (hit) return hit;
    if (!r.cursor) return null;
    cursor = r.cursor;
  }
  return null;
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
  const found = await findPaymentByReference(env, String(a.location_id), String(a.reference), created);
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
