import { jsonResponse, corsPreflight } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { PaidyError, paidy, paidySecretIsTest, type PaidyPayment } from "../_shared/paidy.ts";
import { PAIDY_ORDER_FIELDS, filePaidyAuthorization, paidyModeNow, releasePaidyAuthorization } from "../_shared/paidy-filing.ts";
import { PAIDY_RECORD_FIELDS, paidyBellOnce, syncPaidyPayment } from "../_shared/paidy-sync.ts";
import { paidyConfirmLeaseExpired, paidyProviderOutcome } from "../_shared/paidy-rules.ts";
import { processPaidyEvent } from "../_shared/paidy-events.ts";
import { paidyAutoRecord } from "../_shared/paidy-autorecord.ts";

/**
 * paidy-reconcile — the Paidy sweep (cron, service role, Vault key).
 * docs/PAIDY.md "Integrity" + "Follow-up"; docs/CRON-AND-EDGE-AUTH.md.
 *
 *   1. Drains the webhook inbox (paidy_webhook_events) — anything the webhook
 *      stored but could not finish (R08).
 *   2. Reads every payment the Hub still watches from Paidy, OLDEST CHECK
 *      FIRST (last_checked_at), so a row that keeps failing never starves the
 *      rest (R18), and runs the same sync as the webhook: closes/expiries
 *      reject queued submissions, captures are RECORDED automatically
 *      (owner: staff capture in the Paidy dashboard), refunds open cases.
 *   3. Re-files an authorisation whose filing was interrupted; releases one
 *      its order can no longer take; retries closes Paidy refused before.
 *   4. Expires Paidy checkout windows nobody came back from (30 min), only
 *      once Paidy can hold nothing for the order (P04; SQL decides).
 *   5. Bells cash-order Confirms left half-way past the lease.
 *
 * Only this environment's payments are read (P07); an inbox event from the
 * other environment is kept and retried daily for 30 days. Never captures. Report-style answer with ok = no errors.
 */
const LOG = "[paidy-reconcile]";
const MAX_PER_RUN = 150;
const MAX_EVENTS_PER_RUN = 100;
const REFUND_WATCH_DAYS = 400; // Paidy accepts refunds for one year after capture.

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const auth = await requireAuth(req, { allowServiceRole: true });
  if (auth instanceof Response) return auth;
  if (!auth.isService) return jsonResponse({ error: "Service role only" }, 403);
  const supabase = auth.supabase;

  const report = {
    events: 0, events_failed: 0, checked: 0, refiled: 0, waiting: 0, synced: 0, auto_recorded: 0,
    captured_unrecorded: 0, refunds: 0, closes_retried: 0, attempts_expired: 0, stuck_confirms: 0,
    other_environment: 0, paidy_errors: 0, write_errors: 0, skipped_mode_off: false,
    oldest_event_minutes: null as number | null, oldest_check_minutes: null as number | null, open_cases: null as number | null,
  };

  try {
    const mode = await paidyModeNow(supabase);
    let secretTest: boolean | null = null;
    try { secretTest = paidySecretIsTest(); } catch { report.skipped_mode_off = true; }

    // 1. Inbox.
    if (secretTest !== null) {
      const { data: events, error: evErr } = await supabase
        .from("paidy_webhook_events").select("id, paidy_payment_id, event, attempts, received_at")
        .is("processed_at", null).lte("next_attempt_at", new Date().toISOString())
        .order("received_at", { ascending: true }).limit(MAX_EVENTS_PER_RUN);
      if (evErr) throw evErr;
      const seen = new Set<string>();
      for (const ev of (events ?? []) as Record<string, any>[]) {
        if (seen.has(ev.paidy_payment_id)) {
          // Same payment already processed this run (one read covers every duplicate notification).
          await supabase.from("paidy_webhook_events").update({ processed_at: new Date().toISOString(), last_error: "duplicate" }).eq("id", ev.id);
          continue;
        }
        seen.add(ev.paidy_payment_id);
        report.events++;
        const r = await processPaidyEvent(supabase, ev.id, ev.paidy_payment_id, String(ev.event ?? ""), "reconcile", Number(ev.attempts ?? 0), { receivedAt: ev.received_at });
        if (!r.done && !r.retry_callback_window) report.events_failed++;
        if (r.summary?.skipped === "other_environment") report.other_environment++;
      }
    }

    // 2–3. Watched payments, oldest check first.
    const { data: closeCases, error: ccErr } = await supabase
      .from("paidy_cases").select("paidy_payment_id").eq("kind", "close_failed").eq("status", "open");
    if (ccErr) throw ccErr;
    const closePending = new Set(((closeCases ?? []) as Record<string, any>[]).map((c) => String(c.paidy_payment_id)));

    const since = new Date(Date.now() - REFUND_WATCH_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Authorised payments first (they can still be filed, released, expire or
    // be captured any minute), then captures — watched for refunds and for a
    // recording that has not happened — oldest check first.
    // P07 (2026-10-08): only THIS environment's payments are read — the
    // batch is never filled with rows the current key cannot check, so a
    // pile of test payments never starves live ones (or the reverse).
    const { data: authRows, error: authErr } = secretTest === null ? { data: [], error: null } : await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("status", "authorized").eq("test", secretTest)
      .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(MAX_PER_RUN);
    if (authErr) throw authErr;
    const room = Math.max(20, MAX_PER_RUN - (authRows ?? []).length);
    const { data: capRows, error: capErr } = secretTest === null ? { data: [], error: null } : await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS).eq("status", "captured").eq("test", secretTest).gte("captured_at", since)
      .order("last_checked_at", { ascending: true, nullsFirst: true }).limit(room);
    if (capErr) throw capErr;
    const rows = [...(authRows ?? []), ...(capRows ?? [])];

    for (const row of rows as Record<string, any>[]) {
      report.checked++;
      let payment: PaidyPayment;
      try {
        payment = await paidy.get(String(row.paidy_payment_id));
      } catch (e) {
        report.paidy_errors++;
        console.error(`${LOG} paidy.get ${row.paidy_payment_id} failed:`, e);
        await supabase.from("paidy_payments").update({
          last_checked_at: new Date().toISOString(), check_failures: Number(row.check_failures ?? 0) + 1,
        }).eq("id", row.id);
        if (e instanceof PaidyError && e.code === "paidy_not_configured") { report.skipped_mode_off = mode === "off"; break; }
        continue;
      }
      try {
        const pid = String(row.paidy_payment_id);
        let outcome = paidyProviderOutcome(payment);

        // A close Paidy refused earlier (Reject, mismatch, stale filing): retry it.
        if (closePending.has(pid) && (outcome === "authorized" || outcome === "expired")) {
          report.closes_retried++;
          try { payment = await paidy.close(pid); } catch (e) { console.warn(`${LOG} close retry ${pid} failed:`, e); }
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
              .from("cash_orders").select(`${PAIDY_ORDER_FIELDS}, customer:customers(id, full_name)`)
              .eq("id", row.cash_order_id).maybeSingle();
            if (orderErr) throw orderErr;
            if (order) {
              const o = order as Record<string, any>;
              if (ended) {
                // A reviewer rejected it (or it was cancelled): never re-filed (R03) — release.
                await releasePaidyAuthorization(supabase, payment, { cash_order_id: o.id, paidy_payment_row: row.id, why: "its submission was rejected or cancelled" });
              } else {
                const r = await filePaidyAuthorization(supabase, {
                  order: o, customer: { id: String(o.customer?.id ?? o.customer_id), full_name: o.customer?.full_name ?? null },
                  payment, expectTest: mode === "test", path: "paidy_reconcile",
                });
                if (r.ok) report.refiled++;
                else if (r.error === "submission_pending") report.waiting++;
                else if (r.error === "order_cannot_take_payment" || r.error === "paidy_payment_rejected_by_reviewer") {
                  const released = await releasePaidyAuthorization(supabase, payment, { cash_order_id: o.id, paidy_payment_row: row.id, why: r.error });
                  await paidyBellOnce(supabase, "paidy_unmatched_authorization", released ? "Paidy authorisation released" : "Paidy authorisation could not be released",
                    `${pid} · ${r.error}${released ? " — released, no charge" : " — the next check retries the release"}`,
                    { cash_order_id: o.id, paidy_payment_id: pid, reason: r.error, released });
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

    // 4. Paidy windows nobody came back from — P04 (owner 2026-10-08): a
    // window she closed stays (and keeps the order locked) until here, and
    // SQL ends it only when the window has timed out, Paidy may hold nothing
    // for the order and no notification received since it opened is waiting.
    const { data: expired, error: expErr } = await supabase.rpc("expire_paidy_checkout_attempts", { p_cash_order_id: null });
    if (expErr) throw expErr;
    report.attempts_expired = Number(expired ?? 0);

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

    // Lag (R18): how far behind the sweep is.
    const [{ data: oldestEv }, { data: oldestChk }, { count: openCases }] = await Promise.all([
      supabase.from("paidy_webhook_events").select("received_at").is("processed_at", null).order("received_at", { ascending: true }).limit(1),
      supabase.from("paidy_payments").select("last_checked_at").eq("status", "authorized").order("last_checked_at", { ascending: true, nullsFirst: true }).limit(1),
      supabase.from("paidy_cases").select("id", { count: "exact", head: true }).eq("status", "open"),
    ]);
    const minutesSince = (t: unknown) => typeof t === "string" ? Math.round((Date.now() - Date.parse(t)) / 60000) : null;
    report.oldest_event_minutes = minutesSince((oldestEv as Record<string, any>[] | null)?.[0]?.received_at);
    report.oldest_check_minutes = minutesSince((oldestChk as Record<string, any>[] | null)?.[0]?.last_checked_at);
    report.open_cases = openCases ?? null;

    const ok = report.write_errors === 0 && report.events_failed === 0 && report.paidy_errors === 0;
    return jsonResponse({ ok, ...report });
  } catch (e) {
    console.error(`${LOG} run failed:`, e);
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e), ...report }, 500);
  }
});
