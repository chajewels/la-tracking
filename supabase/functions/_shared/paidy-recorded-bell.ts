/**
 * The "Paidy payment recorded" bell (owner 2026-10-10, QC PR-B D5), built in
 * ONE place so the bell rung at recording time (review-payment-submission)
 * and the late bell rung by the hourly sweep (paidy-reconcile, reassessment
 * F2, owner 2026-10-10 "A") read the same. The text builders are pure; the
 * writer and the sweep below take the database as an argument.
 *
 * Type paidy_payment_recorded is emailed to Brenda + the admins when ticked
 * in Website → Settings → Staff bell emails. One bell per cash payment,
 * keyed on metadata.cash_payment_id and enforced by the unique index
 * uq_staff_notifications_paidy_recorded (QA reopen 2026-10-10).
 */

export const PAIDY_RECORDED_BELL_TYPE = "paidy_payment_recorded";

/** How long the sweep leaves a recording alone before ringing a missing bell —
 *  the recording path rings within seconds; this keeps the two from racing. */
export const PAIDY_RECORDED_BELL_GRACE_MINUTES = 10;

/** The sweep only looks back this far (and never before the feature shipped). */
export const PAIDY_RECORDED_BELL_LOOKBACK_DAYS = 7;
export const PAIDY_RECORDED_BELL_SINCE = "2026-10-10T10:10:00Z";

export interface PaidyRecordedBellInput {
  reference: string;
  amountJpy: number;
  senderName: string | null | undefined;
  automatic: boolean;
  fullyPaid: boolean;
  remainingJpy: number;
  /** true when the hourly sweep rings it because the first ring never happened. */
  late?: boolean;
}

const yen = (n: number) => `¥${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

export function paidyRecordedBell(i: PaidyRecordedBellInput): { type: string; title: string; body: string } {
  const title = i.fullyPaid ? "Paidy payment recorded — order completed, ready to ship" : "Paidy payment recorded";
  const how = i.automatic ? "automatically after the capture in the Paidy dashboard" : "by a staff Confirm";
  const tail = i.fullyPaid ? " · the order is completed and ready to ship" : ` · ${yen(i.remainingJpy)} still due`;
  const late = i.late ? " · this bell was sent late by the hourly Paidy check" : "";
  return {
    type: PAIDY_RECORDED_BELL_TYPE,
    title,
    body: `${i.reference} · ${yen(i.amountJpy)} · ${String(i.senderName ?? "")} · recorded ${how}${tail}${late}`,
  };
}

/** Earliest recording the sweep considers, as an ISO string. */
export function paidyRecordedBellSince(nowMs: number): string {
  const lookback = nowMs - PAIDY_RECORDED_BELL_LOOKBACK_DAYS * 86_400_000;
  return new Date(Math.max(lookback, Date.parse(PAIDY_RECORDED_BELL_SINCE))).toISOString();
}

/** Latest recording the sweep considers (older than the grace period). */
export function paidyRecordedBellUntil(nowMs: number): string {
  return new Date(nowMs - PAIDY_RECORDED_BELL_GRACE_MINUTES * 60_000).toISOString();
}

// ── QA reopen of F2 (2026-10-10 23:21): one atomic writer, full traversal ──
// The bell is written ONLY through ring_paidy_payment_recorded_bell (INSERT …
// ON CONFLICT DO NOTHING against uq_staff_notifications_paidy_recorded), by
// BOTH the recording path and the hourly sweep. The database, not a prior
// read, guarantees one bell per cash payment, however many workers overlap.

// deno-lint-ignore no-explicit-any
type Db = any;

export type RingOutcome = "rung" | "exists" | "failed";

/** Ring the bell for one cash payment through the one writer. Never throws. */
export async function ringPaidyRecordedBell(
  supabase: Db, bell: { title: string; body: string }, metadata: Record<string, unknown> & { cash_payment_id: string },
): Promise<RingOutcome> {
  try {
    const { data, error } = await supabase.rpc("ring_paidy_payment_recorded_bell", {
      p_title: bell.title, p_body: bell.body, p_metadata: metadata,
    });
    if (error) { console.error("[paidy] recorded bell failed:", error); return "failed"; }
    return data === true ? "rung" : "exists";
  } catch (e) {
    console.error("[paidy] recorded bell threw:", e);
    return "failed";
  }
}

/** One recording that has no bell, as paidy_recorded_bell_missing returns it. */
export interface MissingRecordedBell {
  cash_payment_id: string; payment_created_at: string; amount_paid: number | string;
  cash_order_id: string; submission_id: string; sender_name: string | null; reviewer_user_id: string | null;
}

export interface RecordedBellOrder { id: string; status: string; remaining_balance: number | string | null; reference: string }

export interface SweepDeps {
  /** One keyset page of recordings in [since, until] that have no bell, oldest first. */
  missing(after: { at: string; id: string } | null, limit: number): Promise<MissingRecordedBell[]>;
  /** The order the payment belongs to, or null when it cannot be read. */
  order(cashOrderId: string): Promise<RecordedBellOrder | null>;
  ring(bell: { title: string; body: string }, metadata: Record<string, unknown> & { cash_payment_id: string }): Promise<RingOutcome>;
}

export const PAIDY_RECORDED_BELL_PAGE = 100;
/** Safety bound per run (100 × 50 = 5,000 recordings); the next run continues. */
export const PAIDY_RECORDED_BELL_MAX_PAGES = 50;

/** Walk EVERY recording in the window that has no bell (keyset-paged, so a
 *  page of already-belled recordings can never hide a later one) and ring each
 *  through the one writer. "exists" means another worker rang it first. */
export async function sweepMissingRecordedBells(deps: SweepDeps): Promise<{ rung: number; already: number; failed: number; pages: number }> {
  const out = { rung: 0, already: 0, failed: 0, pages: 0 };
  let after: { at: string; id: string } | null = null;
  while (out.pages < PAIDY_RECORDED_BELL_MAX_PAGES) {
    const page = await deps.missing(after, PAIDY_RECORDED_BELL_PAGE);
    out.pages++;
    for (const m of page) {
      const o = await deps.order(m.cash_order_id);
      if (!o) { out.failed++; continue; }
      const automatic = m.reviewer_user_id == null;
      const fullyPaid = String(o.status) === "completed";
      const b = paidyRecordedBell({
        reference: o.reference, amountJpy: Number(m.amount_paid), senderName: m.sender_name,
        automatic, fullyPaid, remainingJpy: Number(o.remaining_balance ?? 0), late: true,
      });
      const r = await deps.ring(b, {
        cash_order_id: o.id, submission_id: m.submission_id, cash_payment_id: m.cash_payment_id,
        actor: automatic ? "paidy_auto" : "staff", fully_paid: fullyPaid, late: true,
      });
      if (r === "rung") out.rung++; else if (r === "exists") out.already++; else out.failed++;
    }
    if (page.length < PAIDY_RECORDED_BELL_PAGE) break;
    const last = page[page.length - 1];
    after = { at: last.payment_created_at, id: last.cash_payment_id };
  }
  return out;
}
