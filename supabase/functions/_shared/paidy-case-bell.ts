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
