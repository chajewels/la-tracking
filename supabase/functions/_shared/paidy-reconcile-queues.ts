/**
 * paidy-reconcile recovery queues — R3 / R4 (owner go 2026-10-16 15:41 JST;
 * QA assessment 2026-10-11 13:15 JST).
 *
 * R3: step 5 ("Confirms left half-way") walks EVERY Confirm past its lease,
 *     oldest first, through paidy_stuck_confirms (keyset-paged on
 *     (coalesce(processing_started_at, '-infinity'), id)). The lease filter is
 *     in the query, so a Confirm still inside its lease can no longer fill the
 *     page and hide the others.
 * R4: window verification and the orphan capture case check stamp a "last
 *     tried" column on every attempt and read never-tried / least-recently
 *     tried first, so a row Paidy cannot answer for rotates to the back
 *     instead of occupying the capped batch every run.
 */
import { PAIDY_CONFIRM_LEASE_MS } from "./paidy-rules.ts";

export const PAIDY_STUCK_CONFIRM_PAGE = 100;
/** Safety bound per run (100 × 50 = 5,000 Confirms), the same bound as the bell sweeps. */
export const PAIDY_STUCK_CONFIRM_MAX_PAGES = 50;

/** The lease cut passed to paidy_stuck_confirms: a Confirm started at or before it is past its lease. */
export function paidyStuckConfirmLeaseCut(nowMs: number): string {
  return new Date(nowMs - PAIDY_CONFIRM_LEASE_MS).toISOString();
}

/** One Confirm left half-way, as paidy_stuck_confirms returns it. */
export interface StuckConfirm {
  submission_id: string;
  cash_order_id: string;
  payment_method: string | null;
  reference_number: string | null;
  processing_started_at: string | null;
  /** Paidy's payment id when the submission is Paidy-linked, else null. */
  paidy_payment_id: string | null;
  /** coalesce(processing_started_at, '-infinity') — the keyset sort key. */
  sort_at: string;
}

export interface StuckConfirmSweepDeps {
  list(after: { at: string; id: string } | null, limit: number): Promise<StuckConfirm[]>;
  handle(row: StuckConfirm): Promise<void>;
}

/** Walk every Confirm past its lease, oldest first. `oldest` is the first row seen (null when none). */
export async function sweepStuckConfirms(
  deps: StuckConfirmSweepDeps,
): Promise<{ seen: number; pages: number; oldest: StuckConfirm | null }> {
  const out = { seen: 0, pages: 0, oldest: null as StuckConfirm | null };
  let after: { at: string; id: string } | null = null;
  while (out.pages < PAIDY_STUCK_CONFIRM_MAX_PAGES) {
    const page = await deps.list(after, PAIDY_STUCK_CONFIRM_PAGE);
    out.pages++;
    for (const row of page) {
      if (out.oldest === null) out.oldest = row;
      out.seen++;
      await deps.handle(row);
    }
    if (page.length < PAIDY_STUCK_CONFIRM_PAGE) break;
    const last = page[page.length - 1];
    after = { at: last.sort_at, id: last.submission_id };
  }
  return out;
}
