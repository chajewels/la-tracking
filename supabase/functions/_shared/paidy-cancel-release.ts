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
  | { ok: false; code: "paidy_already_captured" | "paidy_unverified" | "paidy_close_failed" | "paidy_release_failed"; message: string };

const CAPTURED_MSG =
  "Paidy has already taken this payment (captured in the Paidy dashboard), so the order was not cancelled. Confirm the Paidy submission first; a refund is then made in the Paidy dashboard.";

export async function releasePaidyForCancel(
  supabase: Db,
  cashOrderId: string,
  userId: string,
  client: { get: (id: string) => Promise<PaidyPayment>; close: (id: string) => Promise<PaidyPayment> } = paidy,
): Promise<PaidyReleaseResult> {
  const { data: rows, error } = await supabase
    .from("paidy_payments").select("id, paidy_payment_id, status")
    .eq("cash_order_id", cashOrderId).eq("status", "authorized");
  if (error) return { ok: false, code: "paidy_release_failed", message: "Could not read the Paidy record. Nothing was changed; try again." };

  let closed = 0;
  for (const row of (rows ?? []) as { id: string; paidy_payment_id: string }[]) {
    let live: PaidyPayment;
    try {
      live = await client.get(row.paidy_payment_id);
    } catch {
      return { ok: false, code: "paidy_unverified", message: "Could not check the Paidy payment with Paidy, so the order was not cancelled. Try again in a few minutes." };
    }
    const outcome = paidyProviderOutcome(live);
    const step = paidyCancelStep(outcome);
    if (step === "refuse") return { ok: false, code: "paidy_already_captured", message: CAPTURED_MSG };
    if (step === "retry") {
      return { ok: false, code: "paidy_unverified", message: "Paidy's answer for this payment could not be read, so the order was not cancelled. Try again in a few minutes." };
    }
    const at = new Date().toISOString();
    let payload: PaidyPayment = live;
    let status: string = outcome;
    let reason = `Paidy status ${String(live.status)} at order cancel`;
    if (step === "close") {
      try {
        payload = await client.close(row.paidy_payment_id);
      } catch (e) {
        return { ok: false, code: "paidy_close_failed", message: `Paidy did not accept the close (${e instanceof Error ? e.message : String(e)}), so the order was not cancelled. Try again.` };
      }
      status = "closed";
      reason = "order cancelled by staff";
      closed++;
    }
    const { error: upErr } = await supabase.from("paidy_payments").update({
      status, closed_at: at, closed_reason: reason, last_payload: payload, updated_at: at,
    }).eq("id", row.id).eq("status", "authorized");
    if (upErr) return { ok: false, code: "paidy_release_failed", message: "The Paidy authorisation was closed but the Hub record could not be updated. Try the cancel again." };

    // Reject the still-queued Paidy submission(s) for this authorisation —
    // quietly, compare-and-set (a running Confirm keeps its claim).
    const { data: flipped, error: subErr } = await supabase.from("payment_submissions").update({
      status: "rejected", updated_at: at, processing_started_at: null, reviewer_user_id: userId,
      reviewer_notes: "Order cancelled by staff — the Paidy authorisation was closed; nothing was charged.",
    }).eq("paidy_payment_id", row.id).in("status", ["submitted", "under_review"]).select("id");
    if (subErr) return { ok: false, code: "paidy_release_failed", message: "The Paidy authorisation was closed but its submission could not be updated. Try the cancel again." };
    for (const s of (flipped ?? []) as { id: string }[]) {
      await supabase.from("audit_logs").insert({
        entity_type: "cash_payment_submission", entity_id: s.id, action: "submission_rejected",
        performed_by_user_id: userId,
        new_value_json: { reason: "order_cancelled_paidy_closed", paidy_payment_id: row.paidy_payment_id },
      });
    }
  }
  return { ok: true, closed };
}
