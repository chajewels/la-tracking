import { jsonResponse, corsPreflight } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/handler.ts";
import { PaidyError, paidy, type PaidyPayment } from "../_shared/paidy.ts";
import { filePaidyAuthorization, paidyModeNow } from "../_shared/paidy-filing.ts";
import { PAIDY_RECORD_FIELDS, paidyBellOnce, syncPaidyPayment } from "../_shared/paidy-sync.ts";
import { paidyConfirmLeaseExpired, paidyProviderOutcome } from "../_shared/paidy-rules.ts";

/**
 * paidy-reconcile — the hourly Paidy check (P12, 2026-10-04). docs/PAIDY.md
 * "Integrity"; cron in docs/CRON-AND-EDGE-AUTH.md (Vault key, service role).
 *
 * The webhook is the fast path; this sweep catches whatever it missed. For
 * every Paidy payment the Hub still has reason to watch it reads Paidy back
 * and runs the SAME sync as the webhook (_shared/paidy-sync.ts):
 *   - authorised with no live submission (an interrupted filing) → filed for
 *     staff Confirm, or released when the order can no longer take it (Q3)
 *   - closed / rejected on Paidy while still queued → submission rejected
 *   - captured on Paidy, not recorded in the Hub → bell (staff finish it)
 *   - refunds → paidy_refunds + bell (never applied to the order)
 *   - a Confirm left half-way past its lease → bell "Finish recording"
 *
 * It never captures, never records a payment, never changes an order's
 * totals. An authorisation the Hub has NO record of at all can only arrive
 * through the webhook — Paidy has no "list payments" API.
 *
 * Auth: service role only (pg_cron with the Vault key). Report-style answer.
 */
const LOG = "[paidy-reconcile]";
const MAX_PER_RUN = 150;
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
    checked: 0, refiled: 0, synced: 0, captured_unrecorded: 0, refunds: 0,
    stuck_confirms: 0, paidy_errors: 0, write_errors: 0, skipped_mode_off: false,
  };

  try {
    const mode = await paidyModeNow(supabase);
    // With Paidy switched off there is nothing to read with; stuck confirms
    // and captured-unrecorded payments are still worth a bell, so carry on
    // only when a secret is configured (paidy.get throws otherwise).

    // 1. Payments to watch: still authorised, or captured within the refund window.
    const since = new Date(Date.now() - REFUND_WATCH_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error: rowsErr } = await supabase
      .from("paidy_payments").select(PAIDY_RECORD_FIELDS)
      .or(`status.eq.authorized,and(status.eq.captured,captured_at.gte.${since})`)
      .order("updated_at", { ascending: true }).limit(MAX_PER_RUN);
    if (rowsErr) throw rowsErr;

    for (const row of (rows ?? []) as Record<string, unknown>[]) {
      report.checked++;
      let payment: PaidyPayment;
      try {
        payment = await paidy.get(String(row.paidy_payment_id));
      } catch (e) {
        report.paidy_errors++;
        console.error(`${LOG} paidy.get ${row.paidy_payment_id} failed:`, e);
        if (e instanceof PaidyError && e.code === "paidy_not_configured") { report.skipped_mode_off = mode === "off"; break; }
        continue;
      }
      try {
        // An authorised record with no live submission: the filing was
        // interrupted (before the atomic writer) — give it its submission.
        if (row.status === "authorized" && paidyProviderOutcome(payment) === "authorized") {
          const { data: live, error: liveErr } = await supabase
            .from("payment_submissions").select("id").eq("paidy_payment_id", row.id)
            .in("status", ["submitted", "under_review", "confirmed"]).limit(1);
          if (liveErr) throw liveErr;
          if ((live ?? []).length === 0) {
            const { data: order, error: orderErr } = await supabase
              .from("cash_orders")
              .select("id, customer_id, invoice_number, web_reference, source_channel, status, payment_status, remaining_balance, ready_confirmed_at, customer:customers(id, full_name)")
              .eq("id", row.cash_order_id).maybeSingle();
            if (orderErr) throw orderErr;
            if (order) {
              const o = order as Record<string, unknown> & { customer?: { id: string; full_name?: string | null } };
              const canTake = o.status === "pending" && o.payment_status === "pending_transfer";
              if (canTake) {
                const r = await filePaidyAuthorization(supabase, {
                  order: o, customer: { id: String(o.customer?.id ?? o.customer_id), full_name: o.customer?.full_name ?? null },
                  payment, expectTest: mode === "test", path: "paidy_reconcile",
                });
                if (r.ok) report.refiled++;
                else console.warn(`${LOG} refile ${row.paidy_payment_id} refused: ${r.error} ${r.detail ?? ""}`);
                if (!r.ok && r.error === "paidy_mismatch") {
                  await paidyBellOnce(supabase, "paidy_unmatched_authorization", "Paidy authorisation could not be filed",
                    `${row.paidy_payment_id} · ${r.detail ?? r.error}${r.released ? " — released, no charge" : ""}`,
                    { cash_order_id: o.id, paidy_payment_id: String(row.paidy_payment_id), detail: r.detail ?? null });
                }
              } else {
                try { await paidy.close(String(row.paidy_payment_id)); } catch (e) { console.warn(`${LOG} close ${row.paidy_payment_id} failed:`, e); }
                await paidyBellOnce(supabase, "paidy_unmatched_authorization", "Paidy authorisation released",
                  `${row.paidy_payment_id} · the order is ${o.status}/${o.payment_status} and can no longer take it — released, no charge`,
                  { cash_order_id: o.id, paidy_payment_id: String(row.paidy_payment_id) });
              }
              // Re-read so the sync below sees the post-close state.
              try { payment = await paidy.get(String(row.paidy_payment_id)); } catch { /* sync with what we have */ }
            }
          }
        }
        const r = await syncPaidyPayment(supabase, row, payment, "reconcile");
        report.synced++;
        if (r.flagged.includes("captured_unrecorded")) report.captured_unrecorded++;
        report.refunds += r.new_refunds;
      } catch (e) {
        report.write_errors++;
        console.error(`${LOG} sync ${row.paidy_payment_id} failed:`, e);
      }
    }

    // 2. Confirms left half-way (claimed, no payment) past the lease.
    const { data: stuck, error: stuckErr } = await supabase
      .from("payment_submissions")
      .select("id, cash_order_id, processing_started_at, paidy_payment_id, paidy:paidy_payments(paidy_payment_id)")
      .eq("payment_method", "paidy").eq("status", "confirmed").is("confirmed_payment_id", null)
      .not("paidy_payment_id", "is", null).limit(100);
    if (stuckErr) throw stuckErr;
    for (const s of (stuck ?? []) as Record<string, any>[]) {
      if (!paidyConfirmLeaseExpired(s.processing_started_at)) continue;
      report.stuck_confirms++;
      const pid = String(s.paidy?.paidy_payment_id ?? s.paidy_payment_id);
      await paidyBellOnce(supabase, "paidy_confirm_interrupted", "Paidy Confirm did not finish",
        `A Confirm of ${pid} stopped before the payment was recorded. Open Payment Submissions and press "Finish recording" (it reads Paidy first and never charges twice).`,
        { cash_order_id: s.cash_order_id, submission_id: s.id, paidy_payment_id: pid });
    }

    return jsonResponse({ ok: true, ...report });
  } catch (e) {
    console.error(`${LOG} run failed:`, e);
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e), ...report }, 500);
  }
});
