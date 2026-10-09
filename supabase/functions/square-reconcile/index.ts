import { jsonResponse, corsPreflight } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { square, SquareError } from "../_shared/square.ts";
import type { SquareEnvironment } from "../_shared/card-rules.ts";
import {
  applyPaymentState, currentEnvironment, isLateHoldReason, processSquareEvent, readPaymentAnyEnv, recoverAttempt, rpc, voidLateHold,
  syncSquareDispute, syncSquareRefund,
} from "../_shared/square-sync.ts";
import { getState, putState, walkStream } from "../_shared/square-stream.ts";
import { sendOrderUpdateEmail } from "../_shared/order-update-email.ts";
import { replayRefundEmail, type ReplayDeps, type ReplayRefund } from "../_shared/refund-email-replay.ts";
import {
  attemptStuckThisRun, discoveryEnvironments, eventsErrorKind, MAX_REFUND_EMAIL_RESENDS, REFUND_EMAIL_GRACE_MS,
} from "../_shared/square-reconcile-rules.ts";

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
 *   6. bells      — hold expiry, dispute evidence deadlines, refunds still
 *                 pending at 7 / 14 days (S05).
 *   7. refund emails — a completed refund whose 「返金を受け付けました」 email
 *                 never went out is sent again, same key (B02, owner 2026-10-08).
 * Square QA 2026-10-08: refund + dispute discovery (B, C) run for EVERY
 * environment with card rows still worth watching, also with the mode off
 * (S02); an attempt that stays unsettled rings a bell on the 3rd run (S01);
 * every progress write is checked (S03).
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
    discovery_environments: [] as string[],
    events_retried: 0, events_done: 0, events_failed: 0,
    attempts_stuck: 0, refund_emails_resent: 0, refund_emails_given_up: 0, health_write_failed: false,
    attempts_checked: 0, attempts_filed: 0, attempts_resolved: 0, attempts_cancelled: 0, attempts_waiting: 0,
    holds_checked: 0, holds_changed: 0, voids_retried: 0, refunds_synced: 0, open_refunds_checked: 0, disputes_synced: 0,
    bells: {} as Rec, square_errors: 0, write_errors: 0, auth_errors: 0, truncated: [] as string[], history_gaps: [] as string[],
    stage_errors: {} as Record<string, number>, errors: [] as string[], no_credentials: [] as string[],
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
  /**
   * F-09 (QC 2026-10-09): a row from an environment that is NOT the current
   * one, whose credentials were removed (e.g. the sandbox token after go-live),
   * cannot be read any more. That is expected history, not a failing check:
   * listed under no_credentials, never counted as an auth failure.
   */
  const noteEnv = (where: string, e: unknown, rowEnv: SquareEnvironment | null) => {
    if (e instanceof SquareError && e.kind === "not_configured" && rowEnv && env && rowEnv !== env) {
      if (report.no_credentials.length < 20) report.no_credentials.push(`${where} (${rowEnv})`.slice(0, 200));
      return;
    }
    note(where, e);
  };
  /** S03: a progress write that fails is reported (the run ends degraded), never ignored. */
  const checked = async (where: string, q: PromiseLike<{ error: unknown }>) => {
    try {
      const { error } = await q;
      if (error) note(where, error instanceof Error ? error : new Error(String((error as { message?: unknown })?.message ?? error)));
    } catch (e) { note(where, e); }
  };

  // R09 (2026-10-08): the environment of a refund's / dispute's parent payment.
  // A failed or empty lookup is an error for THAT child (reported, skipped),
  // never a silent fall-back to production credentials.
  const parentEnvironment = async (d: Db, squarePaymentId: string): Promise<SquareEnvironment> => {
    const { data: row, error } = await d.from("square_payments").select("environment, test").eq("square_payment_id", squarePaymentId).maybeSingle();
    if (error) throw error;
    if (!row) throw new Error(`parent payment ${squarePaymentId} not found`);
    const e = row.environment === "sandbox" || row.environment === "production" ? row.environment
      : row.test === true ? "sandbox" : row.test === false ? "production" : null;
    if (!e) throw new Error(`parent payment ${squarePaymentId} has no environment`);
    return e;
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
      const kind = eventsErrorKind(e instanceof SquareError ? e : null, neverRead);
      if (kind === "not_enabled" && e instanceof SquareError) {
        report.events_api = `not_enabled: ${e.status} ${e.code}`;
      } else {
        // R09: a 400 is our own request, never shown as an enablement state.
        report.events_api = (kind === "unavailable" && e instanceof SquareError ? `unavailable: ${e.status} ${e.code}` : `error: ${e instanceof Error ? e.message : String(e)}`).slice(0, 160);
        note("events_api", e);
      }
    }
  } else report.events_api = "mode_off";

  // S02: which environments to run discovery for — the current one plus any
  // environment that still has card rows worth watching.
  const currentEnv = env;
  let envs: SquareEnvironment[] = env ? [env] : [];
  try {
    const since = new Date(Date.now() - REFUND_WATCH_DAYS * 24 * HOUR).toISOString();
    const rows: Array<{ environment?: string | null; test?: boolean | null }> = [];
    const live = await db.from("square_payments").select("environment, test")
      .or(`status.eq.authorized,and(status.eq.captured,captured_at.gte.${since})`).limit(500);
    if (live.error) throw live.error;
    rows.push(...((live.data ?? []) as Rec[]));
    for (const t of ["square_refunds", "square_disputes"]) {
      const open = t === "square_refunds"
        ? await db.from(t).select("square_payment_row").not("status", "in", "(COMPLETED,FAILED,REJECTED)").limit(500)
        : await db.from(t).select("square_payment_row").not("state", "in", "(WON,LOST,ACCEPTED,INQUIRY_CLOSED)").limit(500);
      if (open.error) throw open.error;
      const ids = [...new Set(((open.data ?? []) as Rec[]).map((r) => r.square_payment_row).filter(Boolean))];
      if (ids.length) {
        const pr = await db.from("square_payments").select("environment, test").in("id", ids);
        if (pr.error) throw pr.error;
        rows.push(...((pr.data ?? []) as Rec[]));
      }
    }
    envs = discoveryEnvironments(env, rows);
  } catch (e) { note("environments", e); }
  report.discovery_environments = envs;

  // B. Refund discovery — every refund Square made, any capture age (QC07),
  //    for every environment in `envs` (S02).
  const refundDiscovery: string[] = [];
  for (const dEnv of envs) {
    try {
      const r = await walkStream(db, `refunds:${dEnv}`, {
        firstLookbackMs: 30 * 24 * HOUR, overlapMs: 10 * 60 * 1000, windowMs: 7 * 24 * HOUR, maxPages: MAX_PAGES,
        fetch: async (b, e, c) => {
          const page = await square.listRefunds(dEnv, { beginTime: b, endTime: e, cursor: c });
          return { items: page.refunds as unknown as Rec[], cursor: page.cursor };
        },
        handle: async (rf) => {
          const id = String(rf.id ?? "");
          if (!id) return;
          const payload = { type: "refund.updated", event_id: `refund_list:${id}:${String(rf.updated_at ?? "")}`, data: { id, object: { refund: rf } } };
          if (await enqueue(db, payload.event_id, "refund.updated", payload, id, "refund_discovery")) report.refunds_discovered++;
        },
      });
      refundDiscovery.push(`${dEnv}: ok (through ${r.through ?? "—"})`);
      if (r.truncated) report.truncated.push(`refund_discovery:${env}`);
    } catch (e) {
      // An environment kept only for old rows may have no credentials any more:
      // reported, not an alarm (the current environment's errors still alarm).
      if (dEnv !== currentEnv && e instanceof SquareError && e.kind === "not_configured") refundDiscovery.push(`${dEnv}: no_credentials`);
      else { refundDiscovery.push(`${dEnv}: error`); note(`refund_discovery ${dEnv}`, e); }
    }
  }
  report.refund_discovery = refundDiscovery.length ? refundDiscovery.join("; ") : "no_environment";

  // C. Dispute discovery — all disputes, a rolling scan that resumes from its
  //    saved cursor across runs, so any number of pages is covered (QC07,
  //    review #8); a cursor Square refuses restarts the scan. Every
  //    environment in `envs` (S02).
  const disputeDiscovery: string[] = [];
  for (const dEnv of envs) {
    try {
      const key = `disputes:${dEnv}`;
      let cursor: string | null = ((await getState(db, key))?.cursor as string | undefined) ?? null;
      let pages = 0;
      do {
        let page;
        try { page = await square.listDisputes(dEnv, { cursor }); }
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
      disputeDiscovery.push(cursor ? `${dEnv}: ok (scan continues next run, ${pages} pages)` : `${dEnv}: ok`);
    } catch (e) {
      if (dEnv !== currentEnv && e instanceof SquareError && e.kind === "not_configured") disputeDiscovery.push(`${dEnv}: no_credentials`);
      else { disputeDiscovery.push(`${dEnv}: error`); note(`dispute_discovery ${dEnv}`, e); }
    }
  }
  report.dispute_discovery = disputeDiscovery.length ? disputeDiscovery.join("; ") : "no_environment";

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
        else {
          report.attempts_waiting++;
          // S01: still unsettled past its give-up time → counted; the 3rd run rings one bell.
          if (attemptStuckThisRun(a, r, Date.now(), ATTEMPT_GIVE_UP_MS)) {
            const st = await rpc(db, "note_square_attempt_stuck", { p_attempt_id: a.id });
            if (st.ok) report.attempts_stuck++;
          }
          // R02 (2026-10-08): a waiting attempt moves to the back of the
          // updated_at order so attempt 31 is reached next run (fair round-robin).
          await checked(`attempts_waiting_touch ${a.reference}`,
            db.from("square_card_attempts").update({ updated_at: new Date().toISOString() }).eq("id", a.id).eq("status", a.status));
        }
      } catch (e) {
        noteEnv(`attempts ${a.reference}`, e, (a.environment as SquareEnvironment | null) ?? null);
        await checked(`attempts_touch ${a.reference}`,
          db.from("square_card_attempts").update({ updated_at: new Date().toISOString() }).eq("id", a.id).eq("status", a.status));
      }
    }
  } catch (e) { note("attempts", e); }

  // 3. Live holds, captured-unrecorded, open exceptions — fair round-robin.
  try {
    const { data: rows, error } = await db.from("square_payments")
      .select("id, square_payment_id, status, environment, test, exception, exception_note, exception_resolved_at, cash_payment_id, cash_order_id, customer_id")
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
          // F-07 (QC 2026-10-09): a hold that arrived while Paidy held the order
          // is voided at filing; if that void failed it is retried here too.
          const paidyConflict = row.exception === "unfiled_hold" && String(row.exception_note ?? "").startsWith("paidy_in_progress")
            && row.exception_resolved_at == null;
          // L7 (2026-10-09): a late hold on an attempt already closed is voided
          // at filing; if that void failed it is retried here, every hour, by
          // the SAME routine (same audit row, same "hold released" email key).
          const lateHold = row.exception === "unfiled_hold" && isLateHoldReason(row.exception_note) && row.exception_resolved_at == null;
          if (p.status === "APPROVED" && lateHold) {
            const v = await voidLateHold(db, got.env, {
              cashOrderId: String(row.cash_order_id), customerId: (row.customer_id as string | null) ?? null, attemptRef: null,
              test: (row.test as boolean | null) ?? null, reason: String(row.exception_note), squareRowId: String(row.id),
            }, p);
            report.voids_retried++;
            if (v === "late_hold_voided") report.holds_changed++;
          } else {
            if (p.status === "APPROVED" && (row.exception === "amount_mismatch" || row.exception === "risk_high" || paidyConflict)) {
              p = await square.cancel(got.env, p.id);
              report.voids_retried++;
            }
            const r = await applyPaymentState(db, p, "reconcile");
            if (r.changed) report.holds_changed++;
          }
          for (const rid of p.refund_ids ?? []) {
            const rf = await square.getRefund(got.env, rid);
            if ((await syncSquareRefund(db, got.env, rf)).outcome === "synced") report.refunds_synced++;
          }
        }
      } catch (e) { noteEnv(`holds ${row.square_payment_id}`, e, rowEnv); }
      await checked(`holds_touch ${row.square_payment_id}`,
        db.from("square_payments").update({ reconciled_at: new Date().toISOString() }).eq("id", row.id));
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
        noteEnv(`refunds ${c.square_payment_id}`, e, cEnv);
      } finally {
        // every capture looked at goes to the back of the queue, checked or not,
        // so more than MAX_CAPTURED recent captures are all reached (review #8)
        await checked(`refunds_touch ${c.square_payment_id}`,
          db.from("square_payments").update({ reconciled_at: new Date().toISOString() }).eq("square_payment_id", c.square_payment_id));
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
      let rEnv: SquareEnvironment | null = null;
      try {
        rEnv = await parentEnvironment(db, String(r.square_payment_id));
        if ((await syncSquareRefund(db, rEnv, await square.getRefund(rEnv, String(r.square_refund_id)))).outcome === "synced") report.refunds_synced++;
      } catch (e) { noteEnv(`open_refunds ${r.square_refund_id}`, e, rEnv); }
      await checked(`open_refunds_touch ${r.square_refund_id}`,
        db.from("square_refunds").update({ updated_at: new Date().toISOString() }).eq("square_refund_id", r.square_refund_id));
    }
  } catch (e) { note("open_refunds", e); }

  // 5. Open disputes.
  try {
    const { data: ds, error } = await db.from("square_disputes")
      .select("square_dispute_id, square_payment_id").not("state", "in", "(WON,LOST,ACCEPTED,INQUIRY_CLOSED)")
      .order("updated_at", { ascending: true }).limit(50);
    if (error) throw error;
    for (const d of (ds ?? []) as Rec[]) {
      let dEnv: SquareEnvironment | null = null;
      try {
        dEnv = await parentEnvironment(db, String(d.square_payment_id));
        const r = await syncSquareDispute(db, await square.getDispute(dEnv, String(d.square_dispute_id)), dEnv);
        if (r.outcome === "synced") report.disputes_synced++;
      } catch (e) { noteEnv(`disputes ${d.square_dispute_id}`, e, dEnv); }
      await checked(`disputes_touch ${d.square_dispute_id}`,
        db.from("square_disputes").update({ updated_at: new Date().toISOString() }).eq("square_dispute_id", d.square_dispute_id));
    }
  } catch (e) { note("disputes", e); }

  // 6. Deadline bells (each bell and its stamp in one SQL statement).
  try { report.bells = await rpc(db, "ring_square_deadline_bells", { p_now: new Date().toISOString() }); }
  catch (e) { note("bells", e); }

  // 7. B02 (owner 2026-10-08): a COMPLETED Square refund whose
  //    「返金を受け付けました」 email never went out is sent again with the SAME
  //    key square-sync used, so it is never sent twice. Only refunds that
  //    arrived after the release (refund_email_replay), only once the first
  //    send had 30 minutes, at most 3 re-sends, then a bell.
  //    SQF03/SQF04 (2026-10-09): the logic lives in _shared/refund-email-replay.ts
  //    (deno-tested with a scripted database); the send is CLAIMED on the row
  //    before it happens, the give-up bell is one per refund, and an order the
  //    email cannot find rings refund_email_order_missing instead of a silent stop.
  try {
    const before = new Date(Date.now() - REFUND_EMAIL_GRACE_MS).toISOString();
    const { data: done, error } = await db.from("square_refunds")
      .select("id, square_refund_id, cash_order_id, amount_jpy, email_resends")
      .eq("status", "COMPLETED").eq("refund_email_replay", true).is("email_given_up_at", null)
      // R04 (2026-10-08): the row's created_at is when the Hub first saw the
      // refund = when square-sync first tried the email. updated_at is rewritten
      // by every hourly poll and would keep the refund ineligible for ever.
      .lte("created_at", before).order("created_at", { ascending: true }).limit(20);
    if (error) throw error;
    const deps: ReplayDeps = {
      alreadySent: async (key) => {
        const sent = await db.from("email_send_log").select("id", { count: "exact", head: true })
          .eq("status", "sent").eq("metadata->>idempotency_key", key);
        if (sent.error) throw sent.error;
        return (sent.count ?? 0) > 0;
      },
      claim: async (rf, resendsBefore) => {
        const { data, error: e } = await db.from("square_refunds").update({ email_resends: resendsBefore + 1 })
          .eq("id", rf.id).eq("email_resends", resendsBefore).is("email_given_up_at", null).select("id");
        if (e) throw new Error(`refund_email_claim ${rf.square_refund_id}: ${e.message}`);
        return (data ?? []).length === 1;
      },
      send: (rf, key) => sendOrderUpdateEmail(db, {
        entity: "cash_order", id: String(rf.cash_order_id), variant: "refund_received",
        amount: Number(rf.amount_jpy ?? 0), refundMethod: "card", idempotencyKey: key,
      }),
      bellExists: async (rf, type) => {
        const { count, error: e } = await db.from("staff_notifications").select("id", { count: "exact", head: true })
          .eq("type", type).eq("metadata->>square_refund_id", rf.square_refund_id);
        if (e) throw new Error(`refund_email_bell_lookup ${rf.square_refund_id}: ${e.message}`);
        return (count ?? 0) > 0;
      },
      ringBell: async (rf, type, reason) => {
        // R07 (2026-10-08): the bell FIRST, the give-up stamp after. If the
        // bell cannot be written nothing is stamped, so the row comes back next
        // hour for its bell (and ONLY its bell — the sends were already claimed).
        const { data: o } = await db.from("cash_orders").select("invoice_number, web_reference, customer_id").eq("id", rf.cash_order_id).maybeSingle();
        const ref = o?.web_reference ?? o?.invoice_number ?? "";
        const yen = Number(rf.amount_jpy ?? 0).toLocaleString("en-US");
        const bell = await db.from("staff_notifications").insert(type === "refund_email_failed"
          ? {
            type, title: "Refund email could not be sent",
            body: `${ref} · ¥${yen} — the "refund received" email for Square refund ${rf.square_refund_id} failed ${MAX_REFUND_EMAIL_RESENDS} times (${reason ?? "error"}). Tell the customer another way and check Settings → Email delivery.`,
            customer_id: o?.customer_id ?? null, invoice_number: o?.invoice_number ?? null,
            metadata: { cash_order_id: rf.cash_order_id, square_refund_id: rf.square_refund_id, reason },
          }
          : {
            type, title: "Refund email: order not found",
            body: `Square refund ${rf.square_refund_id} (¥${yen}) is COMPLETED but its order ${rf.cash_order_id} could not be found when sending the "refund received" email. A web order is never deleted — check the order and tell the customer another way.`,
            customer_id: o?.customer_id ?? null, invoice_number: o?.invoice_number ?? null,
            metadata: { cash_order_id: rf.cash_order_id, square_refund_id: rf.square_refund_id, reason },
          });
        if (bell.error) throw new Error(`refund_email_bell ${rf.square_refund_id}: ${bell.error.message}`);
      },
      markDone: (rf) => checked(`refund_email_done ${rf.square_refund_id}`,
        db.from("square_refunds").update({ refund_email_replay: false }).eq("id", rf.id)),
      stampGivenUp: (rf) => checked(`refund_email_give_up ${rf.square_refund_id}`,
        db.from("square_refunds").update({ email_given_up_at: new Date().toISOString() }).eq("id", rf.id)),
    };
    for (const row of (done ?? []) as Rec[]) {
      const rf: ReplayRefund = { id: String(row.id), square_refund_id: String(row.square_refund_id), cash_order_id: String(row.cash_order_id), amount_jpy: Number(row.amount_jpy ?? 0), email_resends: Number(row.email_resends ?? 0) };
      try {
        const r = await replayRefundEmail(rf, deps);
        if (r.action === "sent") report.refund_emails_resent++;
        if (r.action === "given_up") report.refund_emails_given_up++;
        if (r.action === "order_missing") note(`refund_email ${rf.square_refund_id}`, new Error("order not found — bell refund_email_order_missing"));
      } catch (e) { note(`refund_email ${rf.square_refund_id}`, e); }
    }
  } catch (e) { note("refund_emails", e); }

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
  let finalStatus: "ok" | "degraded" | "failed" = status;
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
  } catch (e) {
    // S03: the health panel could not be updated — the run is not "ok", and
    // the response says so (the panel will show the last good run as old).
    console.error(LOG, "status write failed", e instanceof Error ? e.message : e);
    report.health_write_failed = true;
    if (finalStatus === "ok") finalStatus = "degraded";
  }

  return jsonResponse({ ok: finalStatus !== "failed", status: finalStatus, backlog, report });
});
