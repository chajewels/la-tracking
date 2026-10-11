/**
 * PA07 (owner go 2026-10-08 23:16 JST): the staff bell for a Paidy case, by
 * kind — ONE place, used by the sweep to ring any open case whose first bell
 * never rang (paidy_cases.bell_rung_at IS NULL). The texts match the ones the
 * opening code paths use, so a late bell reads like an on-time one.
 */
import type { PaidyCaseKind } from "./paidy-sync.ts";

export interface PaidyCaseBellInput {
  kind: PaidyCaseKind;
  paidy_payment_id: string;
  detail?: Record<string, unknown> | null;
  reference?: string | null;
}

const yen = (n: unknown) => `¥${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const CASES = "Payment Submissions → Paidy cases";

export function paidyCaseBell(c: PaidyCaseBellInput): { type: string; title: string; body: string } {
  const d = c.detail ?? {};
  const ref = c.reference ? ` · ${c.reference}` : "";
  const type = `paidy_case_${c.kind}`;
  switch (c.kind) {
    case "close_failed":
      return { type, title: "Paidy authorisation not released yet", body: `${c.paidy_payment_id}${ref} · ${String(d.why ?? "release")} · ${String(d.error ?? "Paidy did not accept the close")}. The hourly check retries; do not capture it in the Paidy dashboard.` };
    case "captured_unrecorded":
      return { type, title: "Paidy capture not recorded", body: `${c.paidy_payment_id}${ref} · ${yen(d.captured_jpy)} · Paidy reports a capture the Hub has not recorded. ${CASES}.` };
    case "captured_no_submission":
      return { type, title: "Paidy took a payment the Hub has no record of", body: `${c.paidy_payment_id}${ref} · ${yen(d.captured_jpy)} · order_ref "${String(d.order_ref ?? "")}" — check the Paidy dashboard (${CASES}).` };
    case "refund_before_record":
      return { type, title: "Paidy refund before the capture was recorded", body: `${c.paidy_payment_id}${ref} · refund ${yen(d.refund_jpy)} — a staff decision is needed (${CASES}).` };
    case "refund_after_record":
      return { type, title: "Paidy refund on a recorded payment", body: `${c.paidy_payment_id}${ref} · refund ${yen(d.refund_jpy)} — check the order's refund decision (${CASES}).` };
    case "record_failed":
      return { type, title: "Paidy capture could not be recorded", body: `${c.paidy_payment_id}${ref} · ${yen(d.captured_jpy)} · ${String(d.message ?? d.reason ?? "recording failed")}. The sweep retries; ${CASES} shows it.` };
    case "unmatched_authorization":
      return { type, title: "Paidy authorisation not filed", body: `${c.paidy_payment_id}${ref} · ${yen(d.amount_jpy)} · order_ref "${String(d.order_ref ?? "")}" · ${String(d.error ?? "matches no open order")} — ${CASES}.` };
    case "provider_unreadable":
      return { type, title: "Paidy notification for an unknown payment", body: `${c.paidy_payment_id}${ref} · Paidy answered ${String(d.status ?? "")} ${String(d.code ?? "")}. Check the Paidy dashboard (${CASES}).` };
    case "stale_authorization":
      return { type, title: "Paidy authorisation no longer matches its order", body: `${c.paidy_payment_id}${ref} · ${String(d.detail ?? d.reason ?? "stale")} — ${CASES}.` };
  }
}

/** Every kind the sweep may have to ring for — kept in step with PaidyCaseKind by the CI test. */
export const PAIDY_CASE_KINDS: readonly PaidyCaseKind[] = [
  "close_failed", "captured_unrecorded", "captured_no_submission", "refund_before_record",
  "refund_after_record", "record_failed", "unmatched_authorization", "provider_unreadable", "stale_authorization",
] as const;

// ── "fix 6c" (owner 2026-10-11; QA residual): one atomic writer, full traversal ──
// A case bell is written ONLY through ring_paidy_case_bell (locks the case,
// INSERT … ON CONFLICT DO NOTHING against uq_staff_notifications_paidy_case,
// stamps bell_rung_at in the same transaction), by BOTH openPaidyCase and the
// hourly sweep. The database, not a prior read, guarantees one bell per case.

// deno-lint-ignore no-explicit-any
type Db = any;

export type CaseRingOutcome = "rung" | "exists" | "closed" | "failed";

/** Ring the first bell of one case through the one writer. Never throws. */
export async function ringPaidyCaseBell(
  supabase: Db, caseId: string, bell: { title: string; body: string }, metadata: Record<string, unknown>,
): Promise<CaseRingOutcome> {
  try {
    const { data, error } = await supabase.rpc("ring_paidy_case_bell", {
      p_case_id: caseId, p_title: bell.title, p_body: bell.body, p_metadata: metadata,
    });
    if (error) { console.error(`[paidy] case bell ${caseId} failed:`, error); return "failed"; }
    return data === "rung" || data === "exists" || data === "closed" ? data : "failed";
  } catch (e) {
    console.error(`[paidy] case bell ${caseId} threw:`, e);
    return "failed";
  }
}

/** One open case with no bell stamp, as paidy_case_bell_missing returns it. */
export interface UnrungPaidyCase {
  case_id: string; kind: PaidyCaseKind; paidy_payment_id: string; cash_order_id: string | null;
  detail: Record<string, unknown> | null; opened_at: string; reference: string | null;
}

export interface CaseSweepDeps {
  /** One keyset page of open cases with no bell stamp, oldest first. */
  missing(after: { at: string; id: string } | null, limit: number): Promise<UnrungPaidyCase[]>;
  ring(caseId: string, bell: { title: string; body: string }, metadata: Record<string, unknown>): Promise<CaseRingOutcome>;
}

export const PAIDY_CASE_BELL_PAGE = 100;
/** Safety bound per run (100 × 50 = 5,000 cases); the next run continues. */
export const PAIDY_CASE_BELL_MAX_PAGES = 50;

/** Walk EVERY open case whose first bell never rang (keyset-paged, so cases
 *  whose ring keeps failing can never hide the ones after them) and ring each
 *  through the one writer. "exists" means another worker rang it first. */
export async function sweepUnrungPaidyCases(deps: CaseSweepDeps): Promise<{ rung: number; already: number; closed: number; failed: number; pages: number }> {
  const out = { rung: 0, already: 0, closed: 0, failed: 0, pages: 0 };
  let after: { at: string; id: string } | null = null;
  while (out.pages < PAIDY_CASE_BELL_MAX_PAGES) {
    const page = await deps.missing(after, PAIDY_CASE_BELL_PAGE);
    out.pages++;
    for (const c of page) {
      const b = paidyCaseBell({ kind: c.kind, paidy_payment_id: String(c.paidy_payment_id), detail: c.detail, reference: c.reference });
      const r = await deps.ring(c.case_id, b, { cash_order_id: c.cash_order_id ?? null, late: true });
      if (r === "rung") out.rung++; else if (r === "exists") out.already++; else if (r === "closed") out.closed++; else out.failed++;
    }
    if (page.length < PAIDY_CASE_BELL_PAGE) break;
    const last = page[page.length - 1];
    after = { at: last.opened_at, id: last.case_id };
  }
  return out;
}
