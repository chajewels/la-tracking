import { jsonResponse, corsPreflight } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { square, SquareError } from "../_shared/square.ts";
import type { SquareEnvironment } from "../_shared/card-rules.ts";
import {
  applyPaymentState, currentEnvironment, processSquareEvent, readPaymentAnyEnv, recoverAttempt, rpc,
  syncSquareDispute, syncSquareRefund,
} from "../_shared/square-sync.ts";

/**
 * square-reconcile — the hourly Square safety net (integrity 2026-10-04, SQ14;
 * docs/SQUARE-INTEGRITY.md; cron minute :53, Vault key, like paidy-reconcile).
 *
 * The webhook is the fast path; this sweep repairs whatever it missed, oldest
 * first and bounded per run (a backlog cannot starve anything):
 *   1. inbox    — webhook events that failed, were quarantined, never finished
 *                 or are stuck past their lease are processed again;
 *   2. attempts — a card attempt whose create answer was lost (reserved /
 *                 unknown) is looked up in Square's payment list by its
 *                 reference: found → filed or resolved (SQ03/SQ04); not found
 *                 after 15 min → CancelPaymentByIdempotencyKey, then closed;
 *   3. holds    — every live hold, captured-unrecorded payment and open
 *                 exception is read back and the provider truth applied; a
 *                 mismatched / risk-HIGH hold still live is voided again;
 *   4. refunds  — refunds on captured payments (Dashboard refunds included);
 *   5. disputes — open disputes refreshed (state, deadline);
 *   6. bells    — hold expiry 2 days before Square's own deadline, dispute
 *                 evidence 3 days / 1 day before, each stamped with its bell;
 *   7. Events API — when the owner has enabled it, recent payment / refund /
 *                 dispute events are pulled into the inbox (optional).
 * It never captures and never records a payment. A lost hold the order can
 * still take is FILED for staff Confirm; otherwise the SQL rings a bell —
 * never an automatic void (owner decision), except a hold that is ours and
 * wrong (amount mismatch) or flagged HIGH risk (fraud rule).
 *
 * Auth: service role only (pg_cron with the Vault key). Report-style answer.
 */
const LOG = "[square-reconcile]";
const MAX_EVENTS = 50;
const MAX_ATTEMPTS = 30;
const MAX_HOLDS = 100;
const MAX_CAPTURED = 60;
const ATTEMPT_GRACE_MS = 2 * 60 * 1000;
const ATTEMPT_GIVE_UP_MS = 15 * 60 * 1000;
const REFUND_WATCH_DAYS = 120;

type Rec = Record<string, unknown>;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const auth = await requireAuth(req, { allowServiceRole: true });
  if (auth instanceof Response) return auth;
  if (!auth.isService) return jsonResponse({ error: "Service role only" }, 403);
  const db = auth.supabase;

  const report = {
    events_retried: 0, events_done: 0, events_failed: 0,
    attempts_checked: 0, attempts_filed: 0, attempts_resolved: 0, attempts_cancelled: 0, attempts_waiting: 0,
    holds_checked: 0, holds_changed: 0, voids_retried: 0, refunds_synced: 0, disputes_synced: 0,
    bells: {} as Rec, events_api: "not_tried", square_errors: 0, write_errors: 0, errors: [] as string[],
  };
  const note = (where: string, e: unknown) => {
    const msg = e instanceof SquareError ? `square ${e.status} ${e.code} (${e.kind})` : e instanceof Error ? e.message : String(e);
    if (e instanceof SquareError) report.square_errors++; else report.write_errors++;
    if (report.errors.length < 20) report.errors.push(`${where}: ${msg}`.slice(0, 200));
    console.error(LOG, where, msg);
  };

  // 1. Inbox retries.
  try {
    const now = new Date().toISOString();
    const staleLease = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: evs, error } = await db.from("square_webhook_events")
      .select("event_id, payload, status")
      .or(`and(status.in.(failed,quarantined),next_attempt_at.lte.${now}),and(status.eq.received,received_at.lte.${staleLease}),and(status.eq.processing,processing_started_at.lte.${staleLease})`)
      .order("received_at", { ascending: true }).limit(MAX_EVENTS);
    if (error) throw error;
    for (const ev of (evs ?? []) as Rec[]) {
      try {
        const claim = await rpc(db, "claim_square_event", { p_event_id: ev.event_id, p_lease_seconds: 120 });
        if (!claim.claimed) continue;
        report.events_retried++;
        const r = await processSquareEvent(db, (ev.payload ?? {}) as Rec);
        await rpc(db, "finish_square_event", { p_event_id: ev.event_id, p_status: r.status, p_outcome: r.outcome, p_error: r.error ?? null, p_retry_seconds: 600 });
        if (r.status === "failed" || r.status === "quarantined") report.events_failed++; else report.events_done++;
      } catch (e) { note(`event ${ev.event_id}`, e); }
    }
  } catch (e) { note("inbox", e); }

  // 2. Attempts with no recorded outcome.
  try {
    const cutoff = new Date(Date.now() - ATTEMPT_GRACE_MS).toISOString();
    const { data: atts, error } = await db.from("square_card_attempts").select("*")
      .in("status", ["reserved", "unknown", "cancelling"]).lte("updated_at", cutoff)
      .order("created_at", { ascending: true }).limit(MAX_ATTEMPTS);
    if (error) throw error;
    for (const a of (atts ?? []) as Rec[]) {
      report.attempts_checked++;
      try {
        const r = await recoverAttempt(db, a, ATTEMPT_GIVE_UP_MS, "reconcile");
        if (r === "filed" || r === "exception") report.attempts_filed++;
        else if (r === "resolved") report.attempts_resolved++;
        else if (r === "cancelled") report.attempts_cancelled++;
        else report.attempts_waiting++;
      } catch (e) { note(`attempt ${a.reference}`, e); }
    }
  } catch (e) { note("attempts", e); }

  // 3. Live holds, captured-unrecorded, open exceptions.
  try {
    const { data: rows, error } = await db.from("square_payments")
      .select("id, square_payment_id, status, environment, test, exception, exception_resolved_at, cash_payment_id")
      .or("status.eq.authorized,and(status.eq.captured,cash_payment_id.is.null,exception_resolved_at.is.null)")
      .order("updated_at", { ascending: true }).limit(MAX_HOLDS);
    if (error) throw error;
    for (const row of (rows ?? []) as Rec[]) {
      report.holds_checked++;
      const env = (row.environment as SquareEnvironment | null) ?? (row.test ? "sandbox" : "production");
      try {
        const got = await readPaymentAnyEnv(env, String(row.square_payment_id));
        if (!got) continue;
        let p = got.payment;
        if (p.status === "APPROVED" && (row.exception === "amount_mismatch" || row.exception === "risk_high")) {
          p = await square.cancel(got.env, p.id);
          report.voids_retried++;
        }
        const r = await applyPaymentState(db, p, "reconcile");
        if (r.changed) report.holds_changed++;
      } catch (e) { note(`hold ${row.square_payment_id}`, e); }
    }
  } catch (e) { note("holds", e); }

  // 4. Refunds on captured payments (Dashboard refunds may arrive without a webhook).
  try {
    const since = new Date(Date.now() - REFUND_WATCH_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: caps, error } = await db.from("square_payments")
      .select("square_payment_id, environment, test, refund_jpy")
      .eq("status", "captured").gte("captured_at", since)
      .order("updated_at", { ascending: true }).limit(MAX_CAPTURED);
    if (error) throw error;
    for (const c of (caps ?? []) as Rec[]) {
      const env = (c.environment as SquareEnvironment | null) ?? (c.test ? "sandbox" : "production");
      try {
        const got = await readPaymentAnyEnv(env, String(c.square_payment_id));
        if (!got) continue;
        await applyPaymentState(db, got.payment, "reconcile");
        for (const rid of got.payment.refund_ids ?? []) {
          const refund = await square.getRefund(got.env, rid);
          const r = await syncSquareRefund(db, got.env, refund);
          if (r.outcome === "synced") report.refunds_synced++;
        }
      } catch (e) { note(`refunds ${c.square_payment_id}`, e); }
    }
  } catch (e) { note("refunds", e); }

  // 5. Open disputes.
  try {
    const { data: ds, error } = await db.from("square_disputes")
      .select("square_dispute_id, square_payment_id").not("state", "in", "(WON,LOST,ACCEPTED)")
      .order("updated_at", { ascending: true }).limit(50);
    if (error) throw error;
    for (const d of (ds ?? []) as Rec[]) {
      try {
        const { data: row } = await db.from("square_payments").select("environment, test").eq("square_payment_id", d.square_payment_id).maybeSingle();
        const env = ((row?.environment as SquareEnvironment | null) ?? (row?.test ? "sandbox" : "production"));
        const r = await syncSquareDispute(db, await square.getDispute(env, String(d.square_dispute_id)));
        if (r.outcome === "synced") report.disputes_synced++;
      } catch (e) { note(`dispute ${d.square_dispute_id}`, e); }
    }
  } catch (e) { note("disputes", e); }

  // 6. Deadline bells (each bell and its stamp in one SQL statement).
  try { report.bells = await rpc(db, "ring_square_deadline_bells", { p_now: new Date().toISOString() }); }
  catch (e) { note("bells", e); }

  // 7. Events API (optional — only works once the owner has enabled it).
  try {
    const env = await currentEnvironment(db);
    if (env) {
      const end = new Date();
      const begin = new Date(end.getTime() - 2 * 60 * 60 * 1000);
      const { events } = await square.searchEvents(env, {
        types: ["payment.created", "payment.updated", "refund.created", "refund.updated", "dispute.created", "dispute.state.updated"],
        beginTime: begin.toISOString(), endTime: end.toISOString(),
      });
      let added = 0;
      for (const ev of events) {
        const id = typeof ev.event_id === "string" ? ev.event_id : null;
        if (!id) continue;
        const { error } = await db.from("square_webhook_events").upsert(
          { event_id: id, event_type: String(ev.type ?? ""), payload: ev, status: "failed", next_attempt_at: new Date().toISOString(), outcome: "events_api" },
          { onConflict: "event_id", ignoreDuplicates: true },
        );
        if (error) throw error;
        added++;
      }
      report.events_api = `ok (${events.length} seen, ${added} queued)`;
    } else report.events_api = "mode_off";
  } catch (e) {
    report.events_api = e instanceof SquareError ? `unavailable: ${e.status} ${e.code}` : `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
  }

  return jsonResponse({ ok: true, report });
});
