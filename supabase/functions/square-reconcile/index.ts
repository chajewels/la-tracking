import { jsonResponse, corsPreflight } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { square, SquareError } from "../_shared/square.ts";
import type { SquareEnvironment } from "../_shared/card-rules.ts";
import {
  applyPaymentState, currentEnvironment, processSquareEvent, readPaymentAnyEnv, recoverAttempt, rpc,
  syncSquareDispute, syncSquareRefund,
} from "../_shared/square-sync.ts";
import { getState, putState, walkStream } from "../_shared/square-stream.ts";
import { sendCardHoldReleasedEmail } from "../_shared/payment-event-emails.ts";

/**
 * square-reconcile — the hourly Square safety net (integrity 2026-10-04, SQ14;
 * close-out QC06 / QC07 / QC11, 2026-10-05; docs/SQUARE.md; cron minute :53,
 * Vault key, like paidy-reconcile).
 *
 * The webhook is the fast path; this sweep repairs whatever it missed. Every
 * stream that can be longer than one run resumes from a DURABLE checkpoint in
 * square_sync_state, so an outage of any length (within what Square keeps) is
 * caught up page by page and nothing is skipped:
 *   A. Events API — payment / refund / dispute events, a time window at a time,
 *                 every page, checkpoint + cursor saved after each page (QC06);
 *   B. refunds    — ListRefunds from a checkpoint: a Dashboard refund on a
 *                 capture of ANY age is found (QC07);
 *   C. disputes   — ListDisputes: a dispute the webhook missed is found (QC07);
 *      (A–C only ENQUEUE into the inbox; step 1 processes, with retries.)
 *   1. inbox      — webhook / discovered events that failed, were quarantined,
 *                 never finished or are stuck past their lease;
 *   2. attempts   — a card attempt whose create answer was lost is looked up;
 *                 an incomplete search never cancels it (QC08);
 *   3. holds      — live holds, captured-unrecorded money and open exceptions
 *                 read back, fair round-robin by reconciled_at (QC11);
 *   4. refunds    — captured payments' refund ids (recent captures) and EVERY
 *                 refund not yet terminal, whatever its capture's age (QC07);
 *   5. disputes   — open disputes refreshed (state, deadline);
 *   6. bells      — hold expiry, dispute evidence deadlines.
 * The run ends with ok | degraded | failed, saved in square_sync_state
 * (reconcile_last_run / reconcile_last_ok, shown in Website → Card payments);
 * degraded or failed rings a bell (at most every 6 h). A silent cron is
 * visible there as an old "last good run".
 *
 * It never captures and never records a payment. Auth: service role only.
 */
const LOG = "[square-reconcile]";
const MAX_EVENTS = 50;
const MAX_ATTEMPTS = 30;
const MAX_HOLDS = 100;
const MAX_CAPTURED = 60;
const MAX_OPEN_REFUNDS = 50;
const MAX_PAGES = 10;
const ATTEMPT_GRACE_MS = 2 * 60 * 1000;
const ATTEMPT_GIVE_UP_MS = 15 * 60 * 1000;
const REFUND_WATCH_DAYS = 120;
const HOUR = 60 * 60 * 1000;
const EVENT_TYPES = ["payment.created", "payment.updated", "refund.created", "refund.updated", "dispute.created", "dispute.state.updated"];
const BACKLOG_ALERT = 200;
const BELL_EVERY_MS = 6 * HOUR;

type Rec = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;

/** Queues an event in the durable inbox for step 1 (duplicates are ignored). */
async function enqueue(db: Db, eventId: string, type: string, payload: Rec, objectId: string | null, source: string): Promise<boolean> {
  const { data, error } = await db.from("square_webhook_events").upsert(
    { event_id: eventId, event_type: type, object_id: objectId, payload, status: "failed", next_attempt_at: new Date().toISOString(), outcome: source },
    { onConflict: "event_id", ignoreDuplicates: true },
  ).select("event_id");
  if (error) throw new Error(`square_webhook_events enqueue: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const auth = await requireAuth(req, { allowServiceRole: true });
  if (auth instanceof Response) return auth;
  if (!auth.isService) return jsonResponse({ error: "Service role only" }, 403);
  const db = auth.supabase;
  const startedAt = new Date().toISOString();

  const report = {
    events_api: "not_tried" as string, events_api_pages: 0, events_api_queued: 0,
    refunds_discovered: 0, refund_discovery: "not_tried" as string,
    disputes_discovered: 0, dispute_discovery: "not_tried" as string,
    events_retried: 0, events_done: 0, events_failed: 0,
    attempts_checked: 0, attempts_filed: 0, attempts_resolved: 0, attempts_cancelled: 0, attempts_waiting: 0,
    holds_checked: 0, holds_changed: 0, voids_retried: 0, refunds_synced: 0, open_refunds_checked: 0, disputes_synced: 0,
    bells: {} as Rec, square_errors: 0, write_errors: 0, auth_errors: 0, truncated: [] as string[], history_gaps: [] as string[],
    stage_errors: {} as Record<string, number>, errors: [] as string[],
  };
  const note = (where: string, e: unknown) => {
    const msg = e instanceof SquareError ? `square ${e.status} ${e.code} (${e.kind})` : e instanceof Error ? e.message : String(e);
    if (e instanceof SquareError) {
      report.square_errors++;
      if (e.kind === "auth" || e.kind === "not_configured") report.auth_errors++;
    } else report.write_errors++;
    const stage = where.split(" ")[0];
    report.stage_errors[stage] = (report.stage_errors[stage] ?? 0) + 1;
    if (report.errors.length < 20) report.errors.push(`${where}: ${msg}`.slice(0, 200));
    console.error(LOG, where, msg);
  };

  let env: SquareEnvironment | null = null;
  try { env = await currentEnvironment(db); } catch (e) { note("settings", e); }

  // A. Events API — checkpointed and paginated (QC06). Square keeps ~28 days,
  //    only from while it is ENABLED (an owner step per environment).
  if (env) {
    try {
      const r = await walkStream(db, `events:${env}`, {
        firstLookbackMs: 2 * HOUR, overlapMs: 5 * 60 * 1000, windowMs: 6 * HOUR, retentionMs: 27 * 24 * HOUR, maxPages: MAX_PAGES,
        fetch: async (b, e, c) => {
          const page = await square.searchEvents(env!, { types: EVENT_TYPES, beginTime: b, endTime: e, cursor: c });
          return { items: page.events, cursor: page.cursor };
        },
        handle: async (ev) => {
          const id = typeof ev.event_id === "string" ? ev.event_id : null;
          if (!id) return;
          if (await enqueue(db, id, String(ev.type ?? ""), ev, null, "events_api")) report.events_api_queued++;
        },
      });
      report.events_api_pages = r.pages;
      report.events_api = `ok (through ${r.through ?? "—"})`;
      if (r.truncated) report.truncated.push("events_api");
      if (r.history_gap) report.history_gaps.push(`events_api before ${r.history_gap}`);
    } catch (e) {
      // A Square client error before the Events API has EVER answered for this
      // environment (no checkpoint yet) is read as "not enabled": shown in the
      // panel, not an alarm. Once a read has succeeded, the same error is a
      // real fault and alarms like any other (review round 3, #9 — Square's
      // exact "not enabled" code is not documented, so it is not guessed).
      const neverRead = !((await getState(db, `events:${env}`).catch(() => null))?.through);
      if (e instanceof SquareError && e.kind === "client" && neverRead) {
        report.events_api = `not_enabled: ${e.status} ${e.code}`;
      } else {
        report.events_api = e instanceof SquareError ? `unavailable: ${e.status} ${e.code}` : `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160);
        note("events_api", e);
      }
    }
  } else report.events_api = "mode_off";

  // B. Refund discovery — every refund Square made, any capture age (QC07).
  if (env) {
    try {
      const r = await walkStream(db, `refunds:${env}`, {
        firstLookbackMs: 30 * 24 * HOUR, overlapMs: 10 * 60 * 1000, windowMs: 7 * 24 * HOUR, maxPages: MAX_PAGES,
        fetch: async (b, e, c) => {
          const page = await square.listRefunds(env!, { beginTime: b, endTime: e, cursor: c });
          return { items: page.refunds as unknown as Rec[], cursor: page.cursor };
        },
        handle: async (rf) => {
          const id = String(rf.id ?? "");
          if (!id) return;
          const payload = { type: "refund.updated", event_id: `refund_list:${id}:${String(rf.updated_at ?? "")}`, data: { id, object: { refund: rf } } };
          if (await enqueue(db, payload.event_id, "refund.updated", payload, id, "refund_discovery")) report.refunds_discovered++;
        },
      });
      report.refund_discovery = `ok (through ${r.through ?? "—"})`;
      if (r.truncated) report.truncated.push("refund_discovery");
    } catch (e) { report.refund_discovery = "error"; note("refund_discovery", e); }
  }

  // C. Dispute discovery — all disputes, a rolling scan that resumes from its
  //    saved cursor across runs, so any number of pages is covered (QC07,
  //    review #8); a cursor Square refuses restarts the scan.
  if (env) {
    try {
      const key = `disputes:${env}`;
      let cursor: string | null = ((await getState(db, key))?.cursor as string | undefined) ?? null;
      let pages = 0;
      do {
        let page;
        try { page = await square.listDisputes(env, { cursor }); }
        catch (e) {
          if (cursor && e instanceof SquareError && e.kind === "client") { cursor = null; await putState(db, key, { cursor: null }); continue; }
          throw e;
        }
        for (const d of page.disputes as unknown as Rec[]) {
          const id = String(d.id ?? d.dispute_id ?? "");
          if (!id) continue;
          const payload = { type: "dispute.state.updated", event_id: `dispute_list:${id}:${String(d.updated_at ?? d.state ?? "")}`, data: { id, object: { dispute: d } } };
          if (await enqueue(db, payload.event_id, "dispute.state.updated", payload, id, "dispute_discovery")) report.disputes_discovered++;
        }
        cursor = page.cursor;
        pages++;
        await putState(db, key, { cursor, scanned_at: new Date().toISOString() });
      } while (cursor && pages < MAX_PAGES);
      report.dispute_discovery = cursor ? `ok (scan continues next run, ${pages} pages)` : "ok";
    } catch (e) { report.dispute_discovery = "error"; note("dispute_discovery", e); }
  }

  // 1. Inbox: retries, newly queued events, stuck leases (oldest first; a
  //    failing event gets a later next_attempt_at, so it cannot starve others).
  try {
    const now = new Date().toISOString();
    const staleLease = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: evs, error } = await db.from("square_webhook_events")
      .select("event_id, payload, status")
      .or(`and(status.in.(failed,quarantined),next_attempt_at.lte.${now}),and(status.eq.received,received_at.lte.${staleLease}),and(status.eq.processing,processing_started_at.lte.${staleLease})`)
      .order("next_attempt_at", { ascending: true, nullsFirst: true }).limit(MAX_EVENTS);
    if (error) throw error;
    for (const ev of (evs ?? []) as Rec[]) {
      try {
        const claim = await rpc(db, "claim_square_event", { p_event_id: ev.event_id, p_lease_seconds: 120 });
        if (!claim.claimed) continue;
        report.events_retried++;
        const r = await processSquareEvent(db, (ev.payload ?? {}) as Rec);
        await rpc(db, "finish_square_event", { p_event_id: ev.event_id, p_status: r.status, p_outcome: r.outcome, p_error: r.error ?? null, p_retry_seconds: 600 });
        if (r.status === "failed" || r.status === "quarantined") report.events_failed++; else report.events_done++;
      } catch (e) { note(`inbox ${ev.event_id}`, e); }
    }
  } catch (e) { note("inbox", e); }

  // 2. Attempts with no recorded outcome. A failure touches updated_at so the
  //    next run tries the others first (fair round-robin).
  try {
    const cutoff = new Date(Date.now() - ATTEMPT_GRACE_MS).toISOString();
    const { data: atts, error } = await db.from("square_card_attempts").select("*")
      .in("status", ["reserved", "unknown", "cancelling"]).lte("updated_at", cutoff)
      .order("updated_at", { ascending: true }).limit(MAX_ATTEMPTS);
    if (error) throw error;
    for (const a of (atts ?? []) as Rec[]) {
      report.attempts_checked++;
      try {
        const r = await recoverAttempt(db, a, ATTEMPT_GIVE_UP_MS, "reconcile");
        if (r === "filed" || r === "exception") report.attempts_filed++;
        else if (r === "resolved") report.attempts_resolved++;
        else if (r === "cancelled") report.attempts_cancelled++;
        else report.attempts_waiting++;
      } catch (e) {
        note(`attempts ${a.reference}`, e);
        await db.from("square_card_attempts").update({ updated_at: new Date().toISOString() }).eq("id", a.id).eq("status", a.status);
      }
    }
  } catch (e) { note("attempts", e); }

  // 3. Live holds, captured-unrecorded, open exceptions — fair round-robin.
  try {
    const { data: rows, error } = await db.from("square_payments")
      .select("id, square_payment_id, status, environment, test, exception, exception_resolved_at, cash_payment_id")
      .or("status.eq.authorized,and(status.eq.captured,cash_payment_id.is.null,exception_resolved_at.is.null)")
      .order("reconciled_at", { ascending: true, nullsFirst: true }).limit(MAX_HOLDS);
    if (error) throw error;
    for (const row of (rows ?? []) as Rec[]) {
      report.holds_checked++;
      const rowEnv = (row.environment as SquareEnvironment | null) ?? (row.test ? "sandbox" : "production");
      try {
        const got = await readPaymentAnyEnv(rowEnv, String(row.square_payment_id));
        if (got) {
          let p = got.payment;
          if (p.status === "APPROVED" && (row.exception === "amount_mismatch" || row.exception === "risk_high")) {
            p = await square.cancel(got.env, p.id);
            report.voids_retried++;
          }
          const r = await applyPaymentState(db, p, "reconcile");
          // Email addendum 10: a retried exception void (mismatch / risk HIGH)
          // that went through → the neutral hold-released email. It sends only
          // when the row now reads 'voided' and no submission owns the hold;
          // keyed by the hold, so a later sweep never repeats it.
          if (p.status === "CANCELED" && (row.exception === "amount_mismatch" || row.exception === "risk_high")) {
            await sendCardHoldReleasedEmail(db, String(p.id));
          }
          if (r.changed) report.holds_changed++;
          for (const rid of p.refund_ids ?? []) {
            const rf = await square.getRefund(got.env, rid);
            if ((await syncSquareRefund(db, got.env, rf)).outcome === "synced") report.refunds_synced++;
          }
        }
      } catch (e) { note(`holds ${row.square_payment_id}`, e); }
      await db.from("square_payments").update({ reconciled_at: new Date().toISOString() }).eq("id", row.id);
    }
  } catch (e) { note("holds", e); }

  // 4a. Refunds on recent captures (Dashboard refunds may arrive without a webhook).
  try {
    const since = new Date(Date.now() - REFUND_WATCH_DAYS * 24 * HOUR).toISOString();
    const { data: caps, error } = await db.from("square_payments")
      .select("square_payment_id, environment, test, refund_jpy")
      .eq("status", "captured").gte("captured_at", since)
      .order("reconciled_at", { ascending: true, nullsFirst: true }).limit(MAX_CAPTURED);
    if (error) throw error;
    for (const c of (caps ?? []) as Rec[]) {
      const cEnv = (c.environment as SquareEnvironment | null) ?? (c.test ? "sandbox" : "production");
      try {
        const got = await readPaymentAnyEnv(cEnv, String(c.square_payment_id));
        if (!got) continue;
        await applyPaymentState(db, got.payment, "reconcile");
        for (const rid of got.payment.refund_ids ?? []) {
          const refund = await square.getRefund(got.env, rid);
          if ((await syncSquareRefund(db, got.env, refund)).outcome === "synced") report.refunds_synced++;
        }
      } catch (e) {
        note(`refunds ${c.square_payment_id}`, e);
      } finally {
        // every capture looked at goes to the back of the queue, checked or not,
        // so more than MAX_CAPTURED recent captures are all reached (review #8)
        await db.from("square_payments").update({ reconciled_at: new Date().toISOString() }).eq("square_payment_id", c.square_payment_id);
      }
    }
  } catch (e) { note("refunds", e); }

  // 4b. Every refund not yet terminal, whatever the age of its capture (QC07).
  try {
    const { data: open, error } = await db.from("square_refunds")
      .select("square_refund_id, square_payment_id").not("status", "in", "(COMPLETED,FAILED,REJECTED)")
      .order("updated_at", { ascending: true }).limit(MAX_OPEN_REFUNDS);
    if (error) throw error;
    for (const r of (open ?? []) as Rec[]) {
      report.open_refunds_checked++;
      try {
        const { data: row } = await db.from("square_payments").select("environment, test").eq("square_payment_id", r.square_payment_id).maybeSingle();
        const rEnv = ((row?.environment as SquareEnvironment | null) ?? (row?.test ? "sandbox" : "production"));
        if ((await syncSquareRefund(db, rEnv, await square.getRefund(rEnv, String(r.square_refund_id)))).outcome === "synced") report.refunds_synced++;
      } catch (e) { note(`open_refunds ${r.square_refund_id}`, e); }
      await db.from("square_refunds").update({ updated_at: new Date().toISOString() }).eq("square_refund_id", r.square_refund_id);
    }
  } catch (e) { note("open_refunds", e); }

  // 5. Open disputes.
  try {
    const { data: ds, error } = await db.from("square_disputes")
      .select("square_dispute_id, square_payment_id").not("state", "in", "(WON,LOST,ACCEPTED)")
      .order("updated_at", { ascending: true }).limit(50);
    if (error) throw error;
    for (const d of (ds ?? []) as Rec[]) {
      try {
        const { data: row } = await db.from("square_payments").select("environment, test").eq("square_payment_id", d.square_payment_id).maybeSingle();
        const dEnv = ((row?.environment as SquareEnvironment | null) ?? (row?.test ? "sandbox" : "production"));
        const r = await syncSquareDispute(db, await square.getDispute(dEnv, String(d.square_dispute_id)), dEnv);
        if (r.outcome === "synced") report.disputes_synced++;
      } catch (e) { note(`disputes ${d.square_dispute_id}`, e); }
      await db.from("square_disputes").update({ updated_at: new Date().toISOString() }).eq("square_dispute_id", d.square_dispute_id);
    }
  } catch (e) { note("disputes", e); }

  // 6. Deadline bells (each bell and its stamp in one SQL statement).
  try { report.bells = await rpc(db, "ring_square_deadline_bells", { p_now: new Date().toISOString() }); }
  catch (e) { note("bells", e); }

  // Status (QC11): failed = Square refuses our credentials, or every core
  // stage failed; degraded = anything else went wrong, a stream ran out of
  // pages, history is missing, or the inbox backlog is high.
  let backlog = 0;
  try {
    const { count, error } = await db.from("square_webhook_events").select("event_id", { count: "exact", head: true })
      .in("status", ["received", "processing", "failed", "quarantined"]);
    if (error) throw error;
    backlog = count ?? 0;
  } catch (e) { note("backlog", e); }
  const core = ["inbox", "attempts", "holds"];
  const coreAllFailed = core.every((s) => (report.stage_errors[s] ?? 0) > 0);
  const status: "ok" | "degraded" | "failed" =
    report.auth_errors > 0 || coreAllFailed ? "failed"
    : report.errors.length > 0 || report.truncated.length > 0 || report.history_gaps.length > 0 || backlog > BACKLOG_ALERT ? "degraded"
    : "ok";
  const summary = { at: startedAt, finished_at: new Date().toISOString(), status, backlog, report };
  try {
    await putState(db, "reconcile_last_run", summary);
    if (status === "ok") await putState(db, "reconcile_last_ok", { at: startedAt });
    if (status !== "ok") {
      const last = await getState(db, "reconcile_bell");
      if (!last || typeof last.at !== "string" || Date.now() - Date.parse(last.at) > BELL_EVERY_MS) {
        const { error } = await db.from("staff_notifications").insert({
          type: "square_reconcile_degraded",
          title: status === "failed" ? "Card payment checks FAILED" : "Card payment checks need attention",
          body: `The hourly Square check finished ${status}: ${report.errors.slice(0, 3).join(" · ") || report.truncated.concat(report.history_gaps).join(" · ") || `inbox backlog ${backlog}`}. Open Website → Card payments.`,
          metadata: { status, backlog, stage_errors: report.stage_errors, truncated: report.truncated, history_gaps: report.history_gaps },
        });
        if (error) throw error;
        await putState(db, "reconcile_bell", { at: new Date().toISOString(), status });
      }
    }
  } catch (e) { console.error(LOG, "status write failed", e instanceof Error ? e.message : e); }

  return jsonResponse({ ok: status !== "failed", status, backlog, report });
});
