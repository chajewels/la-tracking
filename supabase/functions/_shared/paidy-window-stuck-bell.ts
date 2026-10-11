/**
 * The "A Paidy approval is still waiting to be checked" bell
 * (paidy_window_stuck; second-hold fix 2026-10-10): a checkout window holding
 * an approval the Hub could not file, still open 3 hours past its expiry.
 *
 * Owner go 2026-10-11 11:43 JST (QA residual of 11:41): ONE bell per window,
 * enforced by the database. The bell is written ONLY through
 * ring_paidy_window_stuck_bell (locks the window, INSERT … ON CONFLICT DO
 * NOTHING against uq_staff_notifications_paidy_window_stuck, stamps
 * stuck_bell_at in the same transaction), and the hourly sweep walks EVERY
 * waiting window (paidy_window_stuck_missing, keyset-paged).
 */

// deno-lint-ignore no-explicit-any
type Db = any;

export const PAIDY_WINDOW_STUCK_BELL_TYPE = "paidy_window_stuck";
/** A window is "stuck" this long after its expiry. */
export const PAIDY_WINDOW_STUCK_HOURS = 3;
export const PAIDY_WINDOW_STUCK_PAGE = 100;
/** Safety bound per run (100 × 50 = 5,000 windows); the next run continues. */
export const PAIDY_WINDOW_STUCK_MAX_PAGES = 50;

export function paidyWindowStuckCutoff(nowMs: number): string {
  return new Date(nowMs - PAIDY_WINDOW_STUCK_HOURS * 60 * 60 * 1000).toISOString();
}

/** The bell text — unchanged from the second-hold fix. */
export function paidyWindowStuckBell(reference: string, paidyPaymentId: string | null): { title: string; body: string } {
  return {
    title: "A Paidy approval is still waiting to be checked",
    body: `${reference} · ${paidyPaymentId} · the customer cannot pay this order until Paidy is checked. Check the Paidy dashboard, then use "End Paidy window" on the order if Paidy holds nothing.`,
  };
}

export type WindowRingOutcome = "rung" | "exists" | "closed" | "failed";

/** Ring the bell for one window through the one writer. Never throws. */
export async function ringPaidyWindowStuckBell(
  supabase: Db, attemptId: string, bell: { title: string; body: string }, metadata: Record<string, unknown> = {},
): Promise<WindowRingOutcome> {
  try {
    const { data, error } = await supabase.rpc("ring_paidy_window_stuck_bell", {
      p_attempt_id: attemptId, p_title: bell.title, p_body: bell.body, p_metadata: metadata,
    });
    if (error) { console.error(`[paidy] window-stuck bell ${attemptId} failed:`, error); return "failed"; }
    return data === "rung" || data === "exists" || data === "closed" ? data : "failed";
  } catch (e) {
    console.error(`[paidy] window-stuck bell ${attemptId} threw:`, e);
    return "failed";
  }
}

/** One waiting window, as paidy_window_stuck_missing returns it. */
export interface StuckPaidyWindow {
  attempt_id: string; cash_order_id: string; paidy_payment_id: string | null; expires_at: string; reference: string;
}

export interface WindowSweepDeps {
  /** One keyset page of waiting windows past the cutoff with no bell stamp, oldest expiry first. */
  missing(after: { at: string; id: string } | null, limit: number): Promise<StuckPaidyWindow[]>;
  ring(attemptId: string, bell: { title: string; body: string }): Promise<WindowRingOutcome>;
}

/** Walk EVERY waiting window and ring each through the one writer. */
export async function sweepStuckPaidyWindows(deps: WindowSweepDeps): Promise<{ rung: number; already: number; closed: number; failed: number; pages: number }> {
  const out = { rung: 0, already: 0, closed: 0, failed: 0, pages: 0 };
  let after: { at: string; id: string } | null = null;
  while (out.pages < PAIDY_WINDOW_STUCK_MAX_PAGES) {
    const page = await deps.missing(after, PAIDY_WINDOW_STUCK_PAGE);
    out.pages++;
    for (const w of page) {
      const r = await deps.ring(w.attempt_id, paidyWindowStuckBell(w.reference, w.paidy_payment_id));
      if (r === "rung") out.rung++; else if (r === "exists") out.already++; else if (r === "closed") out.closed++; else out.failed++;
    }
    if (page.length < PAIDY_WINDOW_STUCK_PAGE) break;
    const last = page[page.length - 1];
    after = { at: last.expires_at, id: last.attempt_id };
  }
  return out;
}
