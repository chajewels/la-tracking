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
import { paidyAdoptBlock, paidyCaptureDeadlineText, paidyCapturedAmount, paidyFilingMismatch, paidyLatestCapture, paidyMismatchReleases, paidyModeFrom, paidyProviderOutcome, paidyYen, type PaidyMode } from "./paidy-rules.ts";
import { paidy, type PaidyPayment } from "./paidy.ts";
import { openPaidyCase } from "./paidy-sync.ts";
import { sendPaymentSubmittedEmail } from "./order-update-email.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type AnyRec = Record<string, any>;

export type FilingPath = "website_paidy" | "paidy_webhook" | "paidy_reconcile";

export const PAIDY_ORDER_FIELDS =
  "id, customer_id, invoice_number, web_reference, source_channel, status, payment_status, payment_method, currency, remaining_balance, total_paid, ready_confirmed_at";

/**
 * What a release attempt established — from PAIDY'S OWN ANSWER, never from
 * the HTTP status of the close call (PA05, owner brief 2026-10-08):
 *   released  Paidy reports the authorisation closed / rejected / expired:
 *             nothing is held for the customer; the row is ended.
 *   captured  Paidy reports a capture: money was taken — the row is written
 *             captured (never closed) and the locking capture case is opened.
 *   pending   Paidy still reports AUTHORIZED (the close was not accepted) or
 *             refused the call: a durable close_failed case; the sweep retries.
 *   unknown   Paidy's answer could not be classified (timeout, bad object):
 *             same durable case; nothing is written as released.
 */
export type PaidyReleaseOutcome = "released" | "captured" | "pending" | "unknown";
export const paidyReleased = (o: PaidyReleaseOutcome): boolean => o === "released";

/**
 * Releases (closes) an authorisation the Hub will not take, and says what
 * Paidy then reports. A close Paidy does not accept — or answers with
 * anything other than an ended authorisation — becomes a durable
 * close_failed (or capture) case the sweep retries (R08) — never only a bell,
 * and never recorded as released on the strength of a 2xx.
 */
export async function releasePaidyAuthorization(supabase: Db, payment: PaidyPayment, ctx: {
  cash_order_id?: string | null; paidy_payment_row?: string | null; why: string;
}): Promise<PaidyReleaseOutcome> {
  const before = paidyProviderOutcome(payment);
  if (before === "closed" || before === "rejected" || before === "expired") return "released";
  if (before === "captured") return await releaseSawCapture(supabase, payment, ctx);
  let answer: PaidyPayment | null = null;
  let failure: string | null = null;
  try {
    answer = await paidy.close(payment.id);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    // A lost or refused answer is not a state: ask Paidy what it holds now.
    try { answer = await paidy.get(payment.id); } catch { answer = null; }
  }
  const outcome = answer ? paidyProviderOutcome(answer) : "unknown";
  if (outcome === "closed" || outcome === "rejected" || outcome === "expired") {
    // Release the order at once (the lock reads this row), not at the next sweep.
    const at = new Date().toISOString();
    const { error } = await supabase.from("paidy_payments").update({
      status: outcome, closed_at: at, closed_reason: `released: ${ctx.why}`.slice(0, 200), last_payload: answer, updated_at: at,
    }).eq("paidy_payment_id", payment.id).eq("status", "authorized");
    if (error) console.error(`[paidy] closed status write for ${payment.id} failed (the sweep repairs it):`, error);
    return "released";
  }
  if (outcome === "captured" && answer) return await releaseSawCapture(supabase, answer, ctx);
  const detail = failure ? `close refused: ${failure}` : `Paidy still reports ${String(answer?.status ?? "unknown")}`;
  console.warn(`[paidy] close of ${payment.id} (${ctx.why}) not confirmed — case opened: ${detail}`);
  await openPaidyCase(supabase, {
    kind: "close_failed", paidy_payment_id: payment.id, cash_order_id: ctx.cash_order_id ?? null,
    paidy_payment_row: ctx.paidy_payment_row ?? null,
    detail: { why: ctx.why, error: detail, outcome },
    bell: { title: "Paidy authorisation not released yet", body: `${payment.id} · ${ctx.why} · ${detail}. The hourly check retries; do not capture it in the Paidy dashboard.` },
  });
  return outcome === "unknown" ? "unknown" : "pending";
}

/** A release that found money already taken: never written as closed; the capture case locks the order. */
async function releaseSawCapture(supabase: Db, payment: PaidyPayment, ctx: {
  cash_order_id?: string | null; paidy_payment_row?: string | null; why: string;
}): Promise<PaidyReleaseOutcome> {
  const captured = paidyCapturedAmount(payment);
  const latest = paidyLatestCapture(payment);
  if (ctx.paidy_payment_row) {
    const at = new Date().toISOString();
    const upd: AnyRec = { status: "captured", last_payload: payment, updated_at: at, captured_at: latest?.created_at ?? at };
    if (latest?.id) upd.capture_id = latest.id;
    const { error } = await supabase.from("paidy_payments").update(upd).eq("id", ctx.paidy_payment_row).neq("status", "captured");
    if (error) console.error(`[paidy] capture write for ${payment.id} failed (the sweep repairs it):`, error);
  }
  await openPaidyCase(supabase, {
    kind: ctx.paidy_payment_row ? "captured_unrecorded" : "captured_no_submission",
    paidy_payment_id: payment.id, cash_order_id: ctx.cash_order_id ?? null, paidy_payment_row: ctx.paidy_payment_row ?? null,
    detail: { why: ctx.why, captured_jpy: captured, found_at_release: true },
    bell: { title: "Paidy took a payment the Hub was releasing", body: `${payment.id} · ¥${Math.round(captured).toLocaleString("en-US")} · ${ctx.why} — Paidy reports a capture, so nothing was released. Payment Submissions → Paidy cases.` },
  });
  return "captured";
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
  | { ok: false; error: string; detail?: string; released?: boolean; release?: PaidyReleaseOutcome };

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
  if (mismatch && !paidyMismatchReleases(mismatch)) {
    // M1 (Paidy QC 2026-10-09): another order's payment (order_ref) or the
    // other environment's (test_flag) is never closed from here — that
    // would release money another order is waiting for. Nothing is written.
    return { ok: false, error: "paidy_mismatch", detail: mismatch, released: false };
  }
  if (mismatch) {
    const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: `mismatch: ${mismatch}` });
    return { ok: false, error: "paidy_mismatch", detail: mismatch, released: paidyReleased(release), release };
  }
  const amount = paidyYen(payment.amount);
  if (amount == null) {
    const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: "amount not whole yen" });
    return { ok: false, error: "paidy_mismatch", detail: "amount", released: paidyReleased(release), release };
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
    // M6 (Paidy QC 2026-10-09): a card payment in flight on the order wins;
    // the late authorisation is released so nothing sits on her Paidy limit.
    if (err === "stale_authorization" || err === "card_payment_unresolved") {
      const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why: `stale: ${String(r.detail ?? "")}` });
      return { ok: false, error: err, detail: String(r.detail ?? ""), released: paidyReleased(release), release };
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
    // Addendum §9 #1: she hears that her Paidy payment arrived — whichever
    // path filed it. Once per submission; web orders only; never throws.
    if (r.submission?.id) await sendPaymentSubmittedEmail(supabase, { submissionId: String(r.submission.id) });
  }
  return { ok: true, outcome: r.outcome, submission: r.submission, paidy_record_id: r.paidy_record_id };
}

/**
 * An authorisation Paidy holds that no Hub order record knows (webhook or
 * sweep). Files it when its order can take it, releases it when the order
 * cannot, and tells staff either way. Returns a short outcome for logs.
 */
export async function adoptOrphanAuthorization(supabase: Db, payment: PaidyPayment, path: FilingPath): Promise<string> {
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
  // L1 (Paidy QC 2026-10-09): the same switches the website applies — Paidy
  // off, a test payment for a customer not flagged is_test, or a web order
  // whose chosen method is no longer Paidy — release instead of filing.
  const blocked = paidyAdoptBlock(mode, order, customer);
  const ref = customerReference(order as never);
  if (!canTake || blocked) {
    const why = blocked ?? `order is ${order.status}/${order.payment_status}`;
    const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: order.id, why });
    const released = paidyReleased(release);
    // A capture found here already rang its own case bell (releaseSawCapture).
    if (release !== "captured") {
      await paidyBell(supabase, "paidy_unmatched_authorization", released ? "Paidy authorisation released" : "Paidy authorisation could not be released",
        `${ref} · ¥${amount} · ${blocked ? `not taken (${blocked})` : `the order is ${order.status}/${order.payment_status} and can no longer take it`}${released ? " — released, no charge" : " — the hourly check retries the release"}`,
        { cash_order_id: order.id, paidy_payment_id: payment.id, path, released, release, blocked });
    }
    return released ? "released" : `release_${release}`;
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
  if (result.error === "paidy_mismatch" || result.error === "stale_authorization" || result.error === "card_payment_unresolved") {
    // PA05: say what Paidy established, never "released" on a failed close.
    return result.released ? `released_${result.error}` : `release_${result.release ?? "unknown"}_${result.error}`;
  }
  await openPaidyCase(supabase, {
    kind: "unmatched_authorization", paidy_payment_id: payment.id, cash_order_id: order.id,
    detail: { error: result.error, detail: result.detail ?? null, path },
    bell: { title: "Paidy authorisation not filed", body: `${ref} · ¥${amount} · ${result.error}${result.detail ? ` (${result.detail})` : ""} — Payment Submissions → Paidy cases.` },
  });
  return `refused_${result.error}`;
}
