/**
 * Filing a Paidy authorisation as a payment submission (P01/P04/P12,
 * 2026-10-04). docs/PAIDY.md "Integrity".
 *
 * Three callers reach the same writer, file_paidy_submission_atomic (one
 * transaction under a lock on the order):
 *   - website POST /orders/:id/paidy  — the Checkout callback (path website_paidy)
 *   - paidy-webhook                   — Paidy's authorize_success, when the
 *                                       callback was lost (path paidy_webhook)
 *   - paidy-reconcile                 — the hourly sweep (path paidy_reconcile)
 *
 * The payment passed in MUST be Paidy's own read-back (paidy.get); nothing a
 * browser or an unsigned webhook says is trusted. Owner Q3 (2026-10-04): the
 * money is with Paidy, never with the customer, so an authorisation the Hub
 * missed is FILED for staff to Confirm; it is released (closed) only when the
 * order can no longer take it, and staff are told either way.
 */

import { customerReference } from "./order-reference.ts";
import { paidyCaptureDeadlineText, paidyFilingMismatch, paidyModeFrom, paidyYen, type PaidyMode } from "./paidy-rules.ts";
import { paidy, type PaidyPayment } from "./paidy.ts";
import { openPaidyCase } from "./paidy-sync.ts";
import { sendPaymentFiledEmail } from "./payment-event-emails.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export type FilingPath = "website_paidy" | "paidy_webhook" | "paidy_reconcile";

export const PAIDY_ORDER_FIELDS =
  "id, customer_id, invoice_number, web_reference, source_channel, status, payment_status, currency, remaining_balance, total_paid, ready_confirmed_at";

/**
 * Releases (closes) an authorisation the Hub will not take. A close Paidy does
 * not accept becomes a durable close_failed case the sweep retries (R08) —
 * never only a bell. Returns whether Paidy accepted the close.
 */
export async function releasePaidyAuthorization(supabase: Db, payment: PaidyPayment, ctx: {
  cash_order_id?: string | null; paidy_payment_row?: string | null; why: string;
}): Promise<boolean> {
  if (payment.status !== "AUTHORIZED") return true;
  try {
    const closed = await paidy.close(payment.id);
    // Release the order at once (the lock reads this row), not at the next sweep.
    const at = new Date().toISOString();
    const { error } = await supabase.from("paidy_payments").update({
      status: "closed", closed_at: at, closed_reason: `released: ${ctx.why}`.slice(0, 200), last_payload: closed, updated_at: at,
    }).eq("paidy_payment_id", payment.id).eq("status", "authorized");
    if (error) console.error(`[paidy] closed status write for ${payment.id} failed (the sweep repairs it):`, error);
    return true;
  } catch (e) {
    console.warn(`[paidy] close of ${payment.id} (${ctx.why}) failed — case opened:`, e);
    await openPaidyCase(supabase, {
      kind: "close_failed", paidy_payment_id: payment.id, cash_order_id: ctx.cash_order_id ?? null,
      paidy_payment_row: ctx.paidy_payment_row ?? null,
      detail: { why: ctx.why, error: e instanceof Error ? e.message : String(e) },
      bell: { title: "Paidy authorisation not released yet", body: `${payment.id} · ${ctx.why} · Paidy did not accept the close. The hourly check retries; do not capture it in the Paidy dashboard.` },
    });
    return false;
  }
}

/** Inserts a staff bell; returns false (and logs) when the insert fails — never throws. */
export async function paidyBell(supabase: Db, type: string, title: string, body: string, metadata: AnyRec): Promise<boolean> {
  try {
    const { error } = await supabase.from("staff_notifications").insert({ type, title, body, metadata });
    if (error) { console.error(`[paidy] bell ${type} failed:`, error); return false; }
    return true;
  } catch (e) {
    console.error(`[paidy] bell ${type} threw:`, e);
    return false;
  }
}

/** paidy_mode as the Hub holds it now (fail-closed to off). Throws on a read error. */
export async function paidyModeNow(supabase: Db): Promise<PaidyMode> {
  const { data, error } = await supabase.from("system_settings").select("value").eq("key", "paidy_mode").maybeSingle();
  if (error) throw error;
  return paidyModeFrom((data as AnyRec | null)?.value);
}

/** The cash order a Paidy order_ref names (web_reference for web orders, else invoice_number). Throws on a read error. */
export async function orderForPaidyRef(supabase: Db, orderRef: unknown): Promise<AnyRec | null> {
  const ref = String(orderRef ?? "").trim();
  if (!ref || ref.length > 64) return null;
  const select = `${PAIDY_ORDER_FIELDS}, customer:customers(id, full_name, is_test)`;
  for (const column of ["web_reference", "invoice_number"]) {
    const { data, error } = await supabase.from("cash_orders").select(select).eq(column, ref).limit(2);
    if (error) throw error;
    const rows = (data ?? []) as AnyRec[];
    // customerReference must name exactly this row, or it is not ours.
    const hit = rows.filter((o) => customerReference(o) === ref);
    if (hit.length === 1) return hit[0];
  }
  return null;
}

export type FilingResult =
  | { ok: true; outcome: "created" | "existing" | "recovered"; submission: AnyRec; paidy_record_id: string }
  | { ok: false; error: string; detail?: string; released?: boolean };

/**
 * Validate Paidy's read-back against the order and file it. On a mismatch
 * with a known order the authorisation is CLOSED (so nothing sits on the
 * customer's Paidy limit) — except when the order is merely busy with
 * another pending payment, which is left for the next sweep.
 */
export async function filePaidyAuthorization(supabase: Db, args: {
  order: AnyRec;
  customer: { id: string; full_name?: string | null };
  payment: PaidyPayment;
  expectTest: boolean;
  path: FilingPath;
}): Promise<FilingResult> {
  const { order, customer, payment, path } = args;
  const ref = customerReference(order as never);
  const mismatch = paidyFilingMismatch(payment, order, { test: args.expectTest, orderRef: ref });
  if (mismatch) {
    const released = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: `mismatch: ${mismatch}` });
    return { ok: false, error: "paidy_mismatch", detail: mismatch, released };
  }
  const amount = paidyYen(payment.amount);
  if (amount == null) {
    const released = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: "amount not whole yen" });
    return { ok: false, error: "paidy_mismatch", detail: "amount", released };
  }

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
  const { data, error } = await supabase.rpc("file_paidy_submission_atomic", {
    p_cash_order_id: order.id,
    p_customer_id: customer.id,
    p_paidy_payment_id: payment.id,
    p_amount_jpy: amount,
    p_test: payment.test === true,
    p_authorized_at: payment.created_at ?? new Date().toISOString(),
    p_expires_at: payment.expires_at ?? null,
    p_payload: payment,
    p_payment_date: today,
    p_sender_name: customer.full_name ?? null,
    // PD1: a Paidy submission carries no proof file — its proof is the
    // authorisation read back from Paidy.
    p_notes: path === "website_paidy"
      ? `Paidy authorisation from the website (${ref})`
      : `Paidy authorisation recovered by ${path === "paidy_webhook" ? "Paidy's webhook" : "the hourly Paidy check"} (${ref})`,
    p_path: path,
  });
  if (error) throw error;
  const r = (data ?? {}) as AnyRec;
  if (!r.ok) {
    const err = String(r.error ?? "filing_failed");
    // R15: the locked order no longer matches this authorisation (balance
    // moved, part-paid, not yen, expired) — release it so nothing stays
    // reserved on the customer's Paidy limit.
    if (err === "stale_authorization") {
      const released = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: `stale: ${String(r.detail ?? "")}` });
      return { ok: false, error: err, detail: String(r.detail ?? ""), released };
    }
    return { ok: false, error: err, detail: r.lock ? String(r.lock) : r.status ? String(r.status) : undefined };
  }

  if (r.outcome !== "existing") {
    const shown = amount.toLocaleString("en-US");
    const recovered = path !== "website_paidy";
    await paidyBell(supabase, "paidy_authorized",
      recovered ? "Paidy payment recovered — capture it in Paidy" : "Paidy payment authorised — capture it in Paidy",
      `${ref} · ¥${shown} · ${customer.full_name ?? ""} · capture it in the Paidy merchant dashboard (${paidyCaptureDeadlineText(payment.expires_at)}); the Hub records it automatically${recovered ? " · filed after the website callback was lost" : ""}`,
      { cash_order_id: order.id, submission_id: r.submission?.id, paidy_payment_id: payment.id, test: payment.test === true, path, outcome: r.outcome });
    // Email addendum 1 (2026-10-06): tell HER it was received. Keyed by the
    // submission, so the website callback, Paidy's webhook and the hourly
    // check send it once between them. Never throws.
    if (r.submission?.id) await sendPaymentFiledEmail(supabase, String(r.submission.id));
  }
  return { ok: true, outcome: r.outcome, submission: r.submission, paidy_record_id: r.paidy_record_id };
}

/**
 * An authorisation Paidy holds that no Hub order record knows (webhook or
 * sweep). Files it when its order can take it, releases it when the order
 * cannot, and tells staff either way. Returns a short outcome for logs.
 */
export async function adoptOrphanAuthorization(supabase: Db, payment: PaidyPayment, path: Exclude<FilingPath, "website_paidy">): Promise<string> {
  const order = await orderForPaidyRef(supabase, payment.order?.order_ref);
  const amount = Math.round(Number(payment.amount)).toLocaleString("en-US");
  if (!order) {
    // R08: quarantined as a durable case, not only a bell.
    await openPaidyCase(supabase, {
      kind: "unmatched_authorization", paidy_payment_id: payment.id,
      detail: { order_ref: payment.order?.order_ref ?? null, amount_jpy: payment.amount, status: payment.status, path },
      bell: { title: "Paidy authorisation with no Hub order", body: `${payment.id} · ¥${amount} · order_ref "${String(payment.order?.order_ref ?? "")}" matches no cash order — check the Paidy dashboard (Payment Submissions → Paidy cases).` },
    });
    return "unmatched";
  }
  const mode = await paidyModeNow(supabase);
  const customer = (order.customer ?? { id: order.customer_id }) as AnyRec;
  const canTake = order.status === "pending" && order.payment_status === "pending_transfer"
    && !(order.source_channel === "web" && order.ready_confirmed_at == null);
  const ref = customerReference(order as never);
  if (!canTake) {
    const released = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: `order is ${order.status}/${order.payment_status}` });
    await paidyBell(supabase, "paidy_unmatched_authorization", released ? "Paidy authorisation released" : "Paidy authorisation could not be released",
      `${ref} · ¥${amount} · the order is ${order.status}/${order.payment_status} and can no longer take it${released ? " — released, no charge" : " — the hourly check retries the release"}`,
      { cash_order_id: order.id, paidy_payment_id: payment.id, path, released });
    return released ? "released" : "release_failed";
  }
  const result = await filePaidyAuthorization(supabase, {
    order, customer: { id: customer.id, full_name: customer.full_name ?? null }, payment,
    expectTest: mode === "test", path,
  });
  if (result.ok) return `filed_${result.outcome}`;
  if (result.error === "submission_pending") {
    // The record is kept (the writer stores it before the one-payment check),
    // so the sweep files or releases it once the other payment is decided.
    await paidyBell(supabase, "paidy_unmatched_authorization", "Paidy authorisation waiting behind another payment",
      `${ref} · ¥${amount} · another payment on this order is waiting (${result.detail ?? "pending"}); the hourly check files or releases it once that is decided`,
      { cash_order_id: order.id, paidy_payment_id: payment.id, path });
    return "waiting";
  }
  if (result.error === "paidy_mismatch" || result.error === "stale_authorization") {
    return `released_${result.error}`;
  }
  await openPaidyCase(supabase, {
    kind: "unmatched_authorization", paidy_payment_id: payment.id, cash_order_id: order.id,
    detail: { error: result.error, detail: result.detail ?? null, path },
    bell: { title: "Paidy authorisation not filed", body: `${ref} · ¥${amount} · ${result.error}${result.detail ? ` (${result.detail})` : ""} — Payment Submissions → Paidy cases.` },
  });
  return `refused_${result.error}`;
}
