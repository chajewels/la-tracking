// supabase/functions/_shared/paidy-cancel-release.ts
//
// Owner decision 2026-10-06: when staff CANCEL a web order that has an open
// Paidy authorisation, the Hub closes the authorisation at Paidy first, then
// cancels. Paidy documents a closed payment as final — a reopened invoice is
// paid with a NEW Paidy checkout, never by reviving the old authorisation.
//
// Called by cancel-cash-order before terminate_web_order_atomic. It never
// changes the order: it only releases the Paidy side, so the ordinary cancel
// can run. Every decision is taken from Paidy's own read-back (never trust a
// Paidy state not read from Paidy). The pending Paidy submission is rejected
// QUIETLY — the customer gets the cancellation email, not a second
// "payment not accepted" email.

import { paidy, type PaidyPayment } from "./paidy.ts";
import { paidyCancelStep, paidyProviderOutcome } from "./paidy-rules.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export type PaidyReleaseResult =
  | { ok: true; closed: number }
  | { ok: false; code: "paidy_already_captured" | "paidy_unverified" | "paidy_close_failed" | "paidy_release_failed" | "paidy_release_incomplete"; message: string };

const CAPTURED_MSG =
  "Paidy has already taken this payment (captured in the Paidy dashboard), so the order was not cancelled. Confirm the Paidy submission first; a refund is then made in the Paidy dashboard.";
const UNVERIFIED_MSG =
  "Could not check the Paidy payment with Paidy, so the order was not cancelled. Try again in a few minutes.";
const INCOMPLETE_MSG =
  "The Paidy authorisation is closed, but the Hub could not finish updating its record. Press Cancel again — it finishes the remaining steps; nothing is charged twice.";

type Client = { get: (id: string) => Promise<PaidyPayment>; close: (id: string) => Promise<PaidyPayment> };
const ENDED = new Set(["closed", "rejected", "expired"]);

/**
 * Retry-complete (reassessment P08): every call re-derives what is left to do
 * from the database, so a call that stopped half-way (Paidy closed, Hub write
 * failed) is finished by the next one:
 *   1. an AUTHORISED row is read back from Paidy; captured → refuse; still
 *      authorised → close, and the close is re-classified from Paidy's answer
 *      (a lost answer is read back before anything is decided);
 *   2. the row moves authorised → ended by compare-and-set; losing that race
 *      to a capture refuses the cancel;
 *   3. every ENDED row (including one an earlier attempt closed) has its
 *      still-queued submissions rejected quietly, and each rejection is audited.
 * Captured rows are never touched here.
 */
export async function releasePaidyForCancel(
  supabase: Db,
  cashOrderId: string,
  userId: string,
  client: Client = paidy,
): Promise<PaidyReleaseResult> {
  const { data: rows, error } = await supabase
    .from("paidy_payments").select("id, paidy_payment_id, status")
    .eq("cash_order_id", cashOrderId).in("status", ["authorized", "closed", "rejected", "expired"]);
  if (error) return { ok: false, code: "paidy_release_failed", message: "Could not read the Paidy record. Nothing was changed; try again." };

  let closed = 0;
  for (const row of (rows ?? []) as { id: string; paidy_payment_id: string; status: string }[]) {
    let status = row.status;
    if (status === "authorized") {
      let live: PaidyPayment;
      try {
        live = await client.get(row.paidy_payment_id);
      } catch {
        return { ok: false, code: "paidy_unverified", message: UNVERIFIED_MSG };
      }
      let outcome = paidyProviderOutcome(live);
      const step = paidyCancelStep(outcome);
      if (step === "refuse") return { ok: false, code: "paidy_already_captured", message: CAPTURED_MSG };
      if (step === "retry") return { ok: false, code: "paidy_unverified", message: UNVERIFIED_MSG };
      let payload: PaidyPayment = live;
      let reason = `Paidy status ${String(live.status)} at order cancel`;
      if (step === "close") {
        try {
          payload = await client.close(row.paidy_payment_id);
        } catch (e) {
          // A lost or refused answer: ask Paidy what actually happened.
          try { payload = await client.get(row.paidy_payment_id); }
          catch { return { ok: false, code: "paidy_unverified", message: UNVERIFIED_MSG }; }
          if (paidyProviderOutcome(payload) === "authorized") {
            return { ok: false, code: "paidy_close_failed", message: `Paidy did not accept the close (${e instanceof Error ? e.message : String(e)}), so the order was not cancelled. Try again.` };
          }
        }
        outcome = paidyProviderOutcome(payload);
        if (outcome === "captured") return { ok: false, code: "paidy_already_captured", message: CAPTURED_MSG };
        if (outcome === "authorized" || outcome === "unknown") {
          return { ok: false, code: "paidy_close_failed", message: "Paidy did not confirm the close, so the order was not cancelled. Try again." };
        }
        reason = "order cancelled by staff";
        closed++;
      }
      const ended = outcome === "expired" ? "expired" : outcome === "rejected" ? "rejected" : "closed";
      const at = new Date().toISOString();
      const { data: won, error: upErr } = await supabase.from("paidy_payments").update({
        status: ended, closed_at: at, closed_reason: reason, last_payload: payload, updated_at: at,
      }).eq("id", row.id).eq("status", "authorized").select("id");
      if (upErr) return { ok: false, code: "paidy_release_incomplete", message: INCOMPLETE_MSG };
      if ((won ?? []).length === 0) {
        // Another pass changed the row first — believe the database, not us.
        const { data: cur, error: curErr } = await supabase.from("paidy_payments").select("status").eq("id", row.id).maybeSingle();
        if (curErr) return { ok: false, code: "paidy_release_incomplete", message: INCOMPLETE_MSG };
        status = String((cur as { status?: string } | null)?.status ?? "");
        if (status === "captured") return { ok: false, code: "paidy_already_captured", message: CAPTURED_MSG };
      } else {
        status = ended;
      }
    }
    if (!ENDED.has(status)) continue;

    // Reject the still-queued Paidy submission(s) — quietly, compare-and-set
    // (a running Confirm keeps its claim). Repeats safely on a retry.
    const at = new Date().toISOString();
    const { data: flipped, error: subErr } = await supabase.from("payment_submissions").update({
      status: "rejected", updated_at: at, processing_started_at: null, reviewer_user_id: userId,
      reviewer_notes: "Order cancelled by staff — Paidy confirmed the authorisation ended without a capture; nothing was charged.",
    }).eq("paidy_payment_id", row.id).in("status", ["submitted", "under_review"]).select("id");
    if (subErr) return { ok: false, code: "paidy_release_incomplete", message: INCOMPLETE_MSG };
    for (const s of (flipped ?? []) as { id: string }[]) {
      const audit = {
        entity_type: "cash_payment_submission", entity_id: s.id, action: "submission_rejected",
        performed_by_user_id: userId,
        new_value_json: { reason: "order_cancelled_paidy_closed", paidy_payment_id: row.paidy_payment_id },
      };
      const { error: aErr } = await supabase.from("audit_logs").insert(audit);
      if (aErr) {
        const { error: aErr2 } = await supabase.from("audit_logs").insert(audit);
        if (aErr2) console.error(`[paidy-cancel] audit row for submission ${s.id} could not be written:`, aErr2);
      }
    }
  }
  return { ok: true, closed };
}
