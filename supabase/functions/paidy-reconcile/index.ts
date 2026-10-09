import { jsonResponse, corsPreflight } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { PaidyError, paidy, paidySecretIsTest, type PaidyPayment } from "../_shared/paidy.ts";
import { PAIDY_ORDER_FIELDS, adoptOrphanAuthorization, filePaidyAuthorization, orderForPaidyRef, paidyModeNow, paidyReleased, releasePaidyAuthorization } from "../_shared/paidy-filing.ts";
import { PAIDY_RECORD_FIELDS, openPaidyCase, paidyBellOnce, syncPaidyPayment } from "../_shared/paidy-sync.ts";
import { paidyAdoptBlock, paidyCapturedAmount, paidyConfirmLeaseExpired, paidyProviderOutcome, paidyRefundTotal } from "../_shared/paidy-rules.ts";
import { claimPaidyEvent, processPaidyEvent } from "../_shared/paidy-events.ts";
import { paidyAutoRecord } from "../_shared/paidy-autorecord.ts";
import { paidyCaseBell } from "../_shared/paidy-case-bell.ts";
import { sendCashPaymentRejectedEmail } from "../_shared/payment-rejected-email.ts";
import { advanceCancelIntent, cancellationSnapshot, emitCancellationFollowups, syncStoreCreditToShopify } from "../_shared/cancel-followups.ts";
import type { RefundStatus } from "../_shared/email-templates/order-cancelled.tsx";

/**
 * paidy-reconcile — the Paidy sweep (cron, service role, Vault key).
 * docs/PAIDY.md "Integrity", "Follow-up" and "PR 3 — recovery";
 * docs/CRON-AND-EDGE-AUTH.md.
 *
 *   1. Drains the webhook inbox (paidy_webhook_events) — anything the webhook
 *      stored but could not finish (R08). PA09/PA10: only this environment's
 *      working batch, each event CLAIMED first (lease), duplicates completed
 *      only after the first event for that payment is done; then a small
 *      batch of PARKED events (other environment / unknown id) for this key.
 *   2. Reads every payment the Hub still watches from Paidy, OLDEST CHECK
 *      FIRST (last_checked_at), so a row that keeps failing never starves the
 *      rest (R18), and runs the same sync as the webhook: closes/expiries
 *      reject queued submissions, captures are RECORDED automatically
 *      (owner: staff capture in the Paidy dashboard), refunds open cases.
 *      PA10: unrecorded captures are watched WHATEVER their age.
 *   3. Re-files an authorisation whose filing was interrupted; releases one
 *      its order can no longer take; retries closes Paidy refused before —
 *      PA05: including releases of payments the Hub never filed (a
 *      close_failed case with no payment row).
 *   4. Expires Paidy checkout windows nobody came back from (30 min), only
 *      once Paidy can hold nothing for the order (P04; SQL decides). PA04: a
 *      window that knows its payment id is first VERIFIED with Paidy here.
 *   4b. Orphan capture cases: closed only when Paidy reports a full refund.
 *   5. Bells cash-order Confirms left half-way past the lease.
 *   6. PR 4 (PA06 / PA14 / PA07): follow-up emails the Hub never reached
 *      (no email_send_log row — never a replay of a failed send), staff
 *      cancellations interrupted after their Paidy release (finished from
 *      the terminate step on; one interrupted before the release only rings
 *      a bell — owner decision), and open cases whose first bell never rang.
 *
 * Only this environment's payments are read (P07); an inbox event from the
 * other environment is parked and retried daily — never dropped (owner
 * 2026-10-08). Never captures. Report-style answer with ok = no errors.
 */
const LOG = "[paidy-reconcile]";
const MAX_PER_RUN = 150;
const MAX_EVENTS_PER_RUN = 100;
const MAX_PARKED_PER_RUN = 20;
const MAX_WINDOWS_VERIFIED_PER_RUN = 50;
const REFUND_WATCH_DAYS = 400; // Paidy accepts refunds for one year after capture.
const CLAIM_LEASE_MS = 5 * 60 * 1000;

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const auth = await requireAuth(req, { allowServiceRole: true });
  if (auth instanceof Response) return auth;
  if (!auth.isService) return jsonResponse({ error: "Service role only" }, 403);
  const supabase = auth.supabase;

  const report = {
    events: 0, events_failed: 0, events_parked: 0, inbox_write_errors: 0, checked: 0, refiled: 0, waiting: 0, synced: 0, auto_recorded: 0,
    captured_unrecorded: 0, refunds: 0, closes_retried: 0, orphan_releases_retried: 0, orphan_releases_resolved: 0,
    attempts_expired: 0, windows_verified: 0, windows_recovered: 0, stuck_confirms: 0,
    other_environment: 0, paidy_errors: 0, write_errors: 0, skipped_mode_off: false,
    orphan_cases_checked: 0, orphan_cases_resolved: 0,
    followups_done: 0, followups_failed: 0, cancel_intents_finished: 0, cancel_intents_bell: 0, case_bells_rung: 0,
    oldest_event_minutes: null as number | null, oldest_check_minutes: null as number | null, open_cases: null as number | null,
    parked_events: null as number | null, parked_oldest_minutes: null as number | null,
  };

  try {
    const mode = await paidyModeNow(supabase);
    let secretTest: boolean | null = null;
    try { secretTest = paidySecretIsTest(); } catch { report.skipped_mode_off = true; }
    const nowIso = () => new Date().toISOString();

    // 1. Inbox — this environment's working batch, then its parked batch.
    if (secretTest !== null) {
      const leaseCut = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
      const runBatch = async (parked: boolean, limit: number) => {
        let q = supabase
          .from("paidy_webhook_events").select("id, paidy_payment_id, event, attempts, received_at, parked_reason, tried_test, tried_live")
          .is("processed_at", null).lte("next_attempt_at", nowIso())
          .or(`test.is.null,test.eq.${secretTest}`)
          .or(`claimed_at.is.null,claimed_at.lt.${leaseCut}`)
          .order("received_at", { ascending: true }).limit(limit);
        q = parked ? q.not("parked_reason", "is", null) : q.is("parked_reason", null);
        const { data: events, error: evErr } = await q;
        if (evErr) throw evErr;
        // PA09: duplicates for one payment are completed ONLY after the first
        // event for it finished (one read covers every duplicate notification);
        // a first event that failed leaves its duplicates for the next run.
        const first = new Map<string, boolean>();
        const dupes: Record<string, any>[] = [];
        for (const ev of (events ?? []) as Record<string, any>[]) {
          const pid = String(ev.paidy_payment_id);
          if (first.has(pid)) { dupes.push(ev); continue; }
          if (!(await claimPaidyEvent(supabase, String(ev.id), "reconcile"))) { first.set(pid, false); continue; }
          if (parked) report.events_parked++; else report.events++;
          const r = await processPaidyEvent(supabase, String(ev.id), pid, String(ev.event ?? ""), "reconcile", Number(ev.attempts ?? 0), {
            receivedAt: ev.received_at, tried: { test: ev.tried_test === true, live: ev.tried_live === true },
          });
          report.inbox_write_errors += r.writes_failed ?? 0;
          if (!r.done && !r.retry_callback_window) report.events_failed++;
          if (r.summary?.skipped === "other_environment") report.other_environment++;
          first.set(pid, r.done && (r.writes_failed ?? 0) === 0 && !r.summary?.parked);
        }
        for (const ev of dupes) {
          if (first.get(String(ev.paidy_payment_id)) !== true) continue;
          const { error } = await supabase.from("paidy_webhook_events").update({ processed_at: nowIso(), last_error: "duplicate" }).eq("id", ev.id);
          if (error) { report.inbox_write_errors++; console.error(`${LOG} duplicate mark failed:`, error); }
        }
      };
      await runBatch(false, MAX_EVENTS_PER_RUN);
      await runBatch(true, MAX_PARKED_PER_RUN);
    }

    // 2–3. Watched payments, oldest check first.
    const { data: closeCases, error: ccErr } = await supabase
      .from("paidy_cases").select("id, paidy_payment_id, paidy_payment_row, cash_order_id, attempts, detail").eq("kind", "close_failed").eq("status", "open");
    if (ccErr) throw ccErr;
    const closePending = new Set(((closeCases ?? []) as Record<string, any>[]).map((c) => String(c.paidy_payment_id)));

    const since = new Date(Date.now() - REFUND_WATCH_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Authorised payments first (they can still be filed, released, expire or
    // be captured any minute), then UNRECORDED captures of any age (PA10 —
    // they are money the order has not seen), then recorded captures inside
    // the refund window — oldest check first.
    // P07 (2026-10-08): only THIS environment's payments are read — the
    // batch is never filled with rows the current key cannot check, so a
    // pile of test payments never starves live ones (or the reverse).
    const { data: authRows, error: authErr } = secretTest === null ? { data: [], error: null } : await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("status", "authorized").eq("test", secretTest)
      .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(MAX_PER_RUN);
    if (authErr) throw authErr;
    const { data: unrecRows, error: unrecErr } = secretTest === null ? { data: [], error: null } : await supabase
      .rpc("paidy_unrecorded_captures", { p_test: secretTest, p_limit: 50 });
    if (unrecErr) throw unrecErr;
    const room = Math.max(20, MAX_PER_RUN - (authRows ?? []).length - (unrecRows ?? []).length);
    const { data: capRows, error: capErr } = secretTest === null ? { data: [], error: null } : await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("status", "captured").eq("test", secretTest)
      .or(`captured_at.gte.${since},captured_at.is.null`)
      .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(room);
    if (capErr) throw capErr;
    const seenRows = new Set<string>();
    const rows: Record<string, any>[] = [];
    for (const r of [...(authRows ?? []), ...(unrecRows ?? []), ...(capRows ?? [])] as Record<string, any>[]) {
      if (seenRows.has(String(r.id))) continue;
      seenRows.add(String(r.id));
      rows.push(r);
    }

    for (const row of rows) {
      report.checked++;
      let payment: PaidyPayment;
      try {
        payment = await paidy.get(String(row.paidy_payment_id));
      } catch (e) {
        report.paidy_errors++;
        console.error(`${LOG} paidy.get ${row.paidy_payment_id} failed:`, e);
        const { error: touchErr } = await supabase.from("paidy_payments").update({
          last_checked_at: nowIso(), check_failures: Number(row.check_failures ?? 0) + 1,
        }).eq("id", row.id);
        if (touchErr) report.write_errors++;
        if (e instanceof PaidyError && e.code === "paidy_not_configured") { report.skipped_mode_off = mode === "off"; break; }
        continue;
      }
      try {
        const pid = String(row.paidy_payment_id);
        let outcome = paidyProviderOutcome(payment);

        // A close Paidy refused earlier (Reject, mismatch, stale filing): retry
        // it through the classifying helper (PA05 — never "released" on a 2xx).
        if (closePending.has(pid) && (outcome === "authorized" || outcome === "expired")) {
          report.closes_retried++;
          await releasePaidyAuthorization(supabase, payment, { cash_order_id: row.cash_order_id, paidy_payment_row: row.id, why: "close retried by the sweep" });
          try { payment = await paidy.get(pid); } catch { /* sync with what we have */ }
          outcome = paidyProviderOutcome(payment);
        }

        // An authorised record with no live submission: the filing was
        // interrupted — give it its submission, or release it.
        if (row.status === "authorized" && outcome === "authorized" && !closePending.has(pid)) {
          const { data: subs, error: subsErr } = await supabase
            .from("payment_submissions").select("id, status").eq("paidy_payment_id", row.id);
          if (subsErr) throw subsErr;
          const list = (subs ?? []) as Record<string, any>[];
          const live = list.some((s) => ["submitted", "under_review", "confirmed"].includes(String(s.status)));
          const ended = list.some((s) => s.status === "rejected" || s.status === "cancelled");
          if (!live) {
            const { data: order, error: orderErr } = await supabase
              .from("cash_orders").select(`${PAIDY_ORDER_FIELDS}, customer:customers(id, full_name, is_test)`)
              .eq("id", row.cash_order_id).maybeSingle();
            if (orderErr) throw orderErr;
            if (order) {
              const o = order as Record<string, any>;
              // L1 (Paidy QC 2026-10-09): the switches the website applies.
              const blocked = paidyAdoptBlock(mode, o, o.customer);
              if (ended) {
                // A reviewer rejected it (or it was cancelled): never re-filed (R03) — release.
                await releasePaidyAuthorization(supabase, payment, { cash_order_id: o.id, paidy_payment_row: row.id, why: "its submission was rejected or cancelled" });
              } else if (blocked) {
                const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: o.id, paidy_payment_row: row.id, why: blocked });
                if (release !== "captured") {
                  await paidyBellOnce(supabase, "paidy_unmatched_authorization", paidyReleased(release) ? "Paidy authorisation released" : "Paidy authorisation could not be released",
                    `${pid} · not filed (${blocked})${paidyReleased(release) ? " — released, no charge" : ` — ${release}; the next check retries the release`}`,
                    { cash_order_id: o.id, paidy_payment_id: pid, reason: blocked, released: paidyReleased(release), release });
                }
              } else {
                const r = await filePaidyAuthorization(supabase, {
                  order: o, customer: { id: String(o.customer?.id ?? o.customer_id), full_name: o.customer?.full_name ?? null },
                  payment, expectTest: mode === "test", path: "paidy_reconcile",
                });
                if (r.ok) report.refiled++;
                else if (r.error === "submission_pending") report.waiting++;
                else if (r.error === "order_cannot_take_payment" || r.error === "paidy_payment_rejected_by_reviewer") {
                  // (card_payment_unresolved is released inside filePaidyAuthorization — M6.)
                  const release = await releasePaidyAuthorization(supabase, payment, { cash_order_id: o.id, paidy_payment_row: row.id, why: r.error });
                  const released = paidyReleased(release);
                  if (release !== "captured") {
                    await paidyBellOnce(supabase, "paidy_unmatched_authorization", released ? "Paidy authorisation released" : "Paidy authorisation could not be released",
                      `${pid} · ${r.error}${released ? " — released, no charge" : ` — ${release}; the next check retries the release`}`,
                      { cash_order_id: o.id, paidy_payment_id: pid, reason: r.error, released, release });
                  }
                }
                // paidy_mismatch / stale_authorization release inside filePaidyAuthorization.
              }
              try { payment = await paidy.get(pid); } catch { /* sync with what we have */ }
            }
          }
        }

        const r = await syncPaidyPayment(supabase, row, payment, "reconcile", "", { record: paidyAutoRecord });
        report.synced++;
        if (r.flagged.includes("auto_recorded")) report.auto_recorded++;
        if (r.flagged.includes("captured_unrecorded")) report.captured_unrecorded++;
        report.refunds += r.new_refunds;
      } catch (e) {
        report.write_errors++;
        console.error(`${LOG} sync ${row.paidy_payment_id} failed:`, e);
      }
    }

    // 3b. PA05: a release that failed for a payment the Hub never filed — a
    // close_failed case with NO payment row — is retried here from Paidy's
    // read-back; the helper classifies the answer (released / captured /
    // pending / unknown) and only a release Paidy confirms resolves the case.
    if (secretTest !== null) {
      for (const c of (closeCases ?? []) as Record<string, any>[]) {
        if (c.paidy_payment_row) continue;
        report.orphan_releases_retried++;
        let live: PaidyPayment;
        try {
          live = await paidy.get(String(c.paidy_payment_id));
        } catch (e) {
          console.warn(`${LOG} orphan release ${c.id} ${c.paidy_payment_id}: Paidy read failed:`, e instanceof PaidyError ? `${e.status} ${e.code}` : e);
          continue;
        }
        if (live.test !== secretTest) continue; // the other key's payment — its own run owns it
        const { error: touchErr } = await supabase.from("paidy_cases")
          .update({ last_seen_at: nowIso(), attempts: Number(c.attempts ?? 0) + 1 }).eq("id", c.id);
        if (touchErr) report.write_errors++;
        const release = await releasePaidyAuthorization(supabase, live, { cash_order_id: c.cash_order_id ?? null, paidy_payment_row: null, why: `release retried by the sweep (${String(c.detail?.why ?? "")})` });
        if (release === "released" || release === "captured") {
          const { error } = await supabase.rpc("close_paidy_case_system", {
            p_case_id: c.id, p_resolution: release === "released" ? "released" : "captured",
            p_note: release === "released" ? "Paidy confirmed the authorisation is closed — nothing is held (sweep)." : "Paidy reports a capture — a capture case now holds the order (sweep).",
          });
          if (error) { report.write_errors++; console.error(`${LOG} orphan release case ${c.id} close failed:`, error); continue; }
          report.orphan_releases_resolved++;
        }
      }
    }

    // 4. Paidy windows nobody came back from — P04 (owner 2026-10-08): a
    // window she closed stays (and keeps the order locked) until here, and
    // SQL ends it only when the window has timed out, Paidy may hold nothing
    // for the order and no notification about the order is waiting.
    // PA04: a window that learned its Paidy payment id (the storefront's
    // rejected / closed callback) is VERIFIED with Paidy first: an
    // authorisation Paidy still holds is filed or released like any orphan;
    // only a payment Paidy reports ended lets the window expire as
    // verified_empty. A window with no id ends on time alone, named
    // unverified_no_id — honest, and bounded by adoption of a late arrival.
    if (secretTest !== null) {
      const { data: windows, error: winErr } = await supabase
        .from("paidy_checkout_attempts").select("id, cash_order_id, paidy_payment_id")
        .eq("status", "open").lte("expires_at", nowIso()).not("paidy_payment_id", "is", null).is("verified_empty_at", null)
        .order("expires_at", { ascending: true }).limit(MAX_WINDOWS_VERIFIED_PER_RUN);
      if (winErr) throw winErr;
      for (const w of (windows ?? []) as Record<string, any>[]) {
        const pid = String(w.paidy_payment_id);
        const { data: row, error: rowErr } = await supabase.from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("paidy_payment_id", pid).maybeSingle();
        if (rowErr) throw rowErr;
        if (row) continue; // the record exists: its own sync (steps 2–3) decides; the lock reads the row
        let live: PaidyPayment;
        try {
          live = await paidy.get(pid);
        } catch (e) {
          // Unreadable: the window stays until Paidy answers. Fail closed.
          // H1 (Paidy QC 2026-10-09): a 404 is recorded per key family; once
          // BOTH the test and the live key have answered 404 for this id,
          // Paidy holds nothing for it under any key — verified_empty. (One
          // 404 alone may just mean the other key family is in now.)
          if (e instanceof PaidyError && e.status === 404) {
            const at = nowIso();
            const mine = secretTest ? "not_found_test_at" : "not_found_live_at";
            const other = secretTest ? "not_found_live_at" : "not_found_test_at";
            const { data: stamped, error: stampErr } = await supabase.from("paidy_checkout_attempts")
              .update({ [mine]: at }).eq("id", w.id).eq("status", "open").select("not_found_test_at, not_found_live_at").maybeSingle();
            if (stampErr) { report.write_errors++; continue; }
            if (stamped && (stamped as Record<string, any>)[other]) {
              const { error } = await supabase.from("paidy_checkout_attempts").update({ verified_empty_at: at }).eq("id", w.id).eq("status", "open");
              if (error) report.write_errors++; else report.windows_verified++;
            }
            continue;
          }
          console.warn(`${LOG} window ${w.id} ${pid}: Paidy read failed:`, e instanceof PaidyError ? `${e.status} ${e.code}` : e);
          continue;
        }
        if (live.test !== secretTest) continue;
        const outcome = paidyProviderOutcome(live);
        if (outcome === "authorized") {
          report.windows_recovered++;
          await adoptOrphanAuthorization(supabase, live, "paidy_reconcile");
        } else if (outcome === "captured") {
          report.windows_recovered++;
          const order = await orderForPaidyRef(supabase, live.order?.order_ref);
          await openPaidyCase(supabase, {
            kind: "captured_no_submission", paidy_payment_id: pid, cash_order_id: order?.id ?? w.cash_order_id ?? null,
            detail: { order_ref: live.order?.order_ref ?? null, captured_jpy: paidyCapturedAmount(live), no_hub_record: true, from_window: w.id },
            bell: { title: "Paidy took a payment the Hub has no record of", body: `${pid} · ¥${Math.round(Number(live.amount) || 0).toLocaleString("en-US")} · found while verifying a closed Paidy window — check the Paidy dashboard (Payment Submissions → Paidy cases).` },
          });
        } else if (outcome === "closed" || outcome === "rejected" || outcome === "expired") {
          const { error } = await supabase.from("paidy_checkout_attempts").update({ verified_empty_at: nowIso() }).eq("id", w.id).eq("status", "open");
          if (error) report.write_errors++; else report.windows_verified++;
        }
        // unknown: the window stays for the next run.
      }
    }
    const { data: expired, error: expErr } = await supabase.rpc("expire_paidy_checkout_attempts", { p_cash_order_id: null });
    if (expErr) throw expErr;
    report.attempts_expired = Number(expired ?? 0);

    // 4b. PA01 (owner brief 2026-10-08): open ORPHAN capture cases — Paidy
    // took money the Hub has no payment row for; the open case is the order's
    // only lock. Each run re-reads the payment from Paidy: a capture Paidy
    // reports FULLY refunded closes the case as refunded_in_paidy (verified by
    // the sweep, never by a note); anything else keeps the case — and the
    // lock — and refreshes it. Only this environment's key can answer, so a
    // read Paidy refuses is left for the other environment's run (PA10).
    if (secretTest !== null) {
      const { data: orphans, error: orErr } = await supabase
        .from("paidy_cases").select("id, paidy_payment_id, kind, cash_order_id, attempts")
        .eq("status", "open").is("paidy_payment_row", null)
        .in("kind", ["captured_unrecorded", "captured_no_submission", "record_failed"])
        .order("opened_at", { ascending: true }).limit(50);
      if (orErr) throw orErr;
      for (const c of (orphans ?? []) as Record<string, any>[]) {
        report.orphan_cases_checked++;
        let live: PaidyPayment;
        try {
          live = await paidy.get(String(c.paidy_payment_id));
        } catch (e) {
          // 404 / other environment / unreadable: the case stays open and locked.
          console.warn(`${LOG} orphan case ${c.id} ${c.paidy_payment_id}: Paidy read failed:`, e instanceof PaidyError ? `${e.status} ${e.code}` : e);
          continue;
        }
        if (live.test !== secretTest) continue; // not this key's payment — the other run owns it
        const captured = paidyCapturedAmount(live);
        const refunded = paidyRefundTotal(live);
        const { error: touchErr } = await supabase.from("paidy_cases")
          .update({ last_seen_at: nowIso(), attempts: Number(c.attempts ?? 0) + 1 }).eq("id", c.id);
        if (touchErr) report.write_errors++;
        if (Number.isFinite(captured) && captured > 0 && refunded >= captured) {
          const { data: res, error: resErr } = await supabase.rpc("resolve_orphan_paidy_case_verified", {
            p_case_id: c.id, p_refunded_jpy: refunded, p_captured_jpy: captured,
            p_payload: { payment_id: live.id, captures: live.captures ?? [], refunds: live.refunds ?? [] },
          });
          if (resErr) { report.write_errors++; console.error(`${LOG} orphan case ${c.id} resolve failed:`, resErr); continue; }
          if ((res as Record<string, any> | null)?.ok) report.orphan_cases_resolved++;
        }
      }
    }

    // 5. Cash-order Confirms left half-way past the lease.
    const { data: stuck, error: stuckErr } = await supabase
      .from("payment_submissions")
      .select("id, cash_order_id, payment_method, reference_number, processing_started_at, paidy_payment_id, paidy:paidy_payments(paidy_payment_id)")
      .not("cash_order_id", "is", null).eq("status", "confirmed").is("confirmed_payment_id", null).limit(100);
    if (stuckErr) throw stuckErr;
    for (const s of (stuck ?? []) as Record<string, any>[]) {
      if (!paidyConfirmLeaseExpired(s.processing_started_at)) continue;
      report.stuck_confirms++;
      if (s.payment_method === "paidy" && s.paidy_payment_id) {
        // The automatic recorder resumes these itself (sync step 4); the bell
        // only says one is waiting.
        const pid = String(s.paidy?.paidy_payment_id ?? s.paidy_payment_id);
        await paidyBellOnce(supabase, "paidy_confirm_interrupted", "Paidy recording did not finish",
          `A recording of ${pid} stopped before the payment was written. The next check retries it; "Finish recording" on its submission does the same now.`,
          { cash_order_id: s.cash_order_id, submission_id: s.id, paidy_payment_id: pid });
      } else {
        await paidyBellOnce(supabase, "cash_confirm_interrupted", "Payment Confirm did not finish",
          `A Confirm of a ${String(s.payment_method ?? "cash")} payment (ref ${String(s.reference_number ?? "—")}) stopped before it was recorded. The submission shows Confirmed but no payment is on the order — check the order and the card/bank record before doing anything.`,
          { cash_order_id: s.cash_order_id, submission_id: s.id, paidy_payment_id: `submission:${s.id}` });
      }
    }

    // 6a. PA06 / PA14: follow-up emails the Hub owes and never reached. A
    //     pending intent older than 5 minutes is sent ONLY when email_send_log
    //     holds no row for its key — the send was never attempted. A failed
    //     send is never replayed (owner rule); such an intent is closed as done.
    {
      const cut = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: fus, error: fuErr } = await supabase
        .from("payment_submission_followups").select("id, kind, submission_id, cash_order_id, idempotency_key, payload, attempts")
        .eq("status", "pending").lte("created_at", cut).order("created_at", { ascending: true }).limit(25);
      if (fuErr) throw fuErr;
      for (const fu of (fus ?? []) as Record<string, any>[]) {
        const { data: logged, error: logErr } = await supabase.from("email_send_log").select("id")
          .contains("metadata", { idempotency_key: fu.idempotency_key }).limit(1);
        if (logErr) { report.write_errors++; continue; }
        const attempted = (logged ?? []).length > 0;
        if (Number(fu.attempts ?? 0) >= 3) {
          await supabase.from("payment_submission_followups").update({ status: "failed", last_error: "max_attempts" }).eq("id", fu.id);
          await paidyBellOnce(supabase, "paidy_followup_failed", "A customer email could not be sent",
            `${fu.kind} for ${fu.cash_order_id ?? fu.submission_id} was not sent after 3 attempts — send it by hand if needed.`,
            { cash_order_id: fu.cash_order_id, submission_id: fu.submission_id, paidy_payment_id: `followup:${fu.id}` });
          report.followups_failed++;
          continue;
        }
        if (!attempted) {
          try {
            if (fu.kind === "paidy_rejected_email" && fu.submission_id) {
              // M4 (Paidy QC 2026-10-09): a provider-ended intent is replayed
              // as provider_ended (no staff message), never as a staff Reject.
              const kind = fu.payload?.kind === "provider_ended" ? "provider_ended" : "staff";
              await sendCashPaymentRejectedEmail(supabase, { submissionId: String(fu.submission_id), kind, reason: kind === "staff" ? (fu.payload?.reason ?? null) : null });
            } else if (fu.kind === "web_cancellation_email" && fu.cash_order_id) {
              const snap = await cancellationSnapshot(supabase, String(fu.cash_order_id));
              if (snap) {
                const { data: orderRow } = await supabase.from("cash_orders").select("id, web_reference, invoice_number, customer_id").eq("id", fu.cash_order_id).maybeSingle();
                await emitCancellationFollowups(supabase, {
                  cash_order_id: String(fu.cash_order_id), isWeb: true, c: snap, orderRow: orderRow ?? {},
                  reason: String(fu.payload?.reason ?? ""), refundStatus: (fu.payload?.refund_status ?? null) as RefundStatus | null, refundNote: fu.payload?.refund_note ?? null,
                });
              }
            } else {
              // L8 (Paidy QC 2026-10-09): an intent this sweep cannot send (an
              // unknown kind, or no submission / order on it) is never closed
              // as done — it is marked failed and staff are told.
              await supabase.from("payment_submission_followups").update({ status: "failed", last_error: "unsendable_followup" }).eq("id", fu.id);
              await paidyBellOnce(supabase, "paidy_followup_failed", "A customer email could not be sent",
                `${fu.kind} for ${fu.cash_order_id ?? fu.submission_id ?? "—"} cannot be sent by the hourly check — send it by hand if needed.`,
                { cash_order_id: fu.cash_order_id, submission_id: fu.submission_id, paidy_payment_id: `followup:${fu.id}` });
              report.followups_failed++;
              continue;
            }
          } catch (e) {
            await supabase.from("payment_submission_followups").update({ attempts: Number(fu.attempts ?? 0) + 1, last_error: e instanceof Error ? e.message : String(e) }).eq("id", fu.id);
            report.followups_failed++;
            continue;
          }
        }
        const { error } = await supabase.from("payment_submission_followups")
          .update({ status: "done", done_at: nowIso(), attempts: Number(fu.attempts ?? 0) + 1, last_error: attempted ? "already_attempted" : null }).eq("id", fu.id);
        if (error) report.write_errors++; else report.followups_done++;
      }
    }

    // 6b. PA14: staff cancellations interrupted mid-way. An intent stuck ≥ 5
    //     minutes at paidy_released / terminated / notified is FINISHED (the
    //     money side already happened; the order must not stay open and
    //     unlocked); one stuck at started only rings a bell, once.
    {
      const cut = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data: intents, error: inErr } = await supabase
        .from("cash_order_cancel_intents").select("id, cash_order_id, user_id, user_email, reason, refund_status, refund_note, stage, bell_rung_at")
        .in("stage", ["started", "paidy_released", "terminated", "notified"]).lte("updated_at", cut)
        .order("updated_at", { ascending: true }).limit(20);
      if (inErr) throw inErr;
      for (const it of (intents ?? []) as Record<string, any>[]) {
        const orderId = String(it.cash_order_id);
        if (it.stage === "started") {
          if (it.bell_rung_at) continue;
          const rang = await paidyBellOnce(supabase, "cancel_interrupted", "A cancellation did not finish",
            `Cancel of order ${orderId} by ${it.user_email ?? "staff"} stopped before anything was released. The order is unchanged — open it and press Cancel again if it should be cancelled.`,
            { cash_order_id: orderId, intent_id: it.id, paidy_payment_id: `cancel:${it.id}` });
          if (rang) { await supabase.from("cash_order_cancel_intents").update({ bell_rung_at: nowIso() }).eq("id", it.id); report.cancel_intents_bell++; }
          continue;
        }
        try {
          const { data: orderRow, error: orErr } = await supabase.from("cash_orders")
            .select("id, source_channel, web_reference, invoice_number, customer_id, status").eq("id", orderId).maybeSingle();
          if (orErr) throw orErr;
          if (!orderRow) { await advanceCancelIntent(supabase, it.id, "abandoned", "order_not_found"); continue; }
          let c: Record<string, any> | null = null;
          if (it.stage === "paidy_released") {
            const { data, error } = await supabase.rpc("terminate_web_order_atomic", {
              p_order_id: orderId, p_outcome: "cancelled", p_reason: it.reason || null,
              p_user_id: it.user_id, p_user_email: it.user_email ?? null,
              p_refund_status: it.refund_status, p_refund_note: it.refund_note, p_source: "staff", p_preview: false,
            });
            if (error) throw error;
            const d = (data ?? {}) as Record<string, any>;
            if (d.ok === false && d.reason !== "already_terminal") {
              // Refused now (e.g. money arrived in the meantime): staff decide — not the sweep.
              await advanceCancelIntent(supabase, it.id, "abandoned", String(d.reason ?? "refused"));
              await paidyBellOnce(supabase, "cancel_interrupted", "An interrupted cancellation could not be finished",
                `Cancel of order ${orderRow.web_reference ?? orderRow.invoice_number} was refused when the Hub tried to finish it (${String(d.reason ?? "refused")}). Its Paidy authorisation was already released; open the order and decide.`,
                { cash_order_id: orderId, intent_id: it.id, paidy_payment_id: `cancel:${it.id}` });
              continue;
            }
            c = d.success === true ? d : await cancellationSnapshot(supabase, orderId);
            if (d.success === true && d.store_credit) {
              await syncStoreCreditToShopify({
                customer_id: d.store_credit.customer_id, direction: "credit", amount: Number(d.store_credit.amount),
                currency: d.store_credit.currency, lot_id: d.store_credit.lot_id, expires_at: d.store_credit.expires_at,
                reason: `Store credit issued on cancellation of ${d.web_reference ?? d.invoice_number ?? "cash order"}`,
              });
            }
            await advanceCancelIntent(supabase, it.id, "terminated");
          } else {
            c = await cancellationSnapshot(supabase, orderId);
          }
          if (!c) { await advanceCancelIntent(supabase, it.id, "abandoned", "not_cancelled"); continue; }
          await emitCancellationFollowups(supabase, {
            cash_order_id: orderId, isWeb: true, c, orderRow, reason: String(it.reason ?? ""),
            refundStatus: (it.refund_status ?? null) as RefundStatus | null, refundNote: it.refund_note ?? null,
          });
          await advanceCancelIntent(supabase, it.id, "done");
          report.cancel_intents_finished++;
        } catch (e) {
          report.write_errors++;
          console.error(`${LOG} cancel intent ${it.id} finish failed:`, e);
          await advanceCancelIntent(supabase, it.id, it.stage, e instanceof Error ? e.message : String(e));
        }
      }
    }

    // 6c. PA07: open cases whose first bell never rang — rung once, deduped
    //     on the case id, then stamped.
    {
      const { data: silent, error: sErr } = await supabase
        .from("paidy_cases").select("id, kind, paidy_payment_id, cash_order_id, detail, cash_order:cash_orders(web_reference, invoice_number)")
        .eq("status", "open").is("bell_rung_at", null).order("opened_at", { ascending: true }).limit(25);
      if (sErr) throw sErr;
      for (const c of (silent ?? []) as Record<string, any>[]) {
        const { data: prior } = await supabase.from("staff_notifications").select("id").contains("metadata", { case_id: c.id }).limit(1);
        if ((prior ?? []).length === 0) {
          const b = paidyCaseBell({ kind: c.kind, paidy_payment_id: String(c.paidy_payment_id), detail: c.detail, reference: c.cash_order?.web_reference ?? c.cash_order?.invoice_number ?? null });
          const { error } = await supabase.from("staff_notifications").insert({
            type: b.type, title: b.title, body: b.body,
            metadata: { case_id: c.id, cash_order_id: c.cash_order_id ?? null, paidy_payment_id: c.paidy_payment_id, kind: c.kind, late: true },
          });
          if (error) { report.write_errors++; continue; }
          report.case_bells_rung++;
        }
        const { error: stampErr } = await supabase.from("paidy_cases").update({ bell_rung_at: nowIso() }).eq("id", c.id);
        if (stampErr) report.write_errors++;
      }
    }

    // Lag (R18): how far behind the sweep is — and PA10: what is parked.
    const [{ data: oldestEv }, { data: oldestChk }, { count: openCases }, { data: parkedOldest, count: parkedCount }] = await Promise.all([
      supabase.from("paidy_webhook_events").select("received_at").is("processed_at", null).is("parked_reason", null).order("received_at", { ascending: true }).limit(1),
      supabase.from("paidy_payments").select("last_checked_at").eq("status", "authorized").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(1),
      supabase.from("paidy_cases").select("id", { count: "exact", head: true }).eq("status", "open"),
      supabase.from("paidy_webhook_events").select("received_at", { count: "exact" }).is("processed_at", null).not("parked_reason", "is", null).order("received_at", { ascending: true }).limit(1),
    ]);
    const minutesSince = (t: unknown) => typeof t === "string" ? Math.round((Date.now() - Date.parse(t)) / 60000) : null;
    report.oldest_event_minutes = minutesSince((oldestEv as Record<string, any>[] | null)?.[0]?.received_at);
    report.oldest_check_minutes = minutesSince((oldestChk as Record<string, any>[] | null)?.[0]?.last_checked_at);
    report.open_cases = openCases ?? null;
    report.parked_events = parkedCount ?? null;
    report.parked_oldest_minutes = minutesSince((parkedOldest as Record<string, any>[] | null)?.[0]?.received_at);

    const ok = report.write_errors === 0 && report.events_failed === 0 && report.paidy_errors === 0 && report.inbox_write_errors === 0;
    return jsonResponse({ ok, ...report });
  } catch (e) {
    console.error(`${LOG} run failed:`, e);
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e), ...report }, 500);
  }
});
