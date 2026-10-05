/**
 * The customer's LATEST PAYMENT DECISION on an order or a plan (payment
 * lifecycle H6, 2026-10-05; spec §6.1).
 *
 * "Latest decision" = the newest submission among rejected /
 * needs_clarification / confirmed, ordered EXACTLY as the SQL writer
 * public.switch_web_payment_method_by_customer_atomic orders them:
 *
 *   ORDER BY updated_at DESC NULLS LAST, created_at DESC, id DESC
 *
 * Change one, change the other. The storefront shows the decision only when
 * it is a rejection or a request for more information; a newer confirmed
 * payment means there is nothing to show (null).
 *
 * `message` is payment_submissions.customer_message — the reviewer's text the
 * customer is meant to read. Internal notes never leave the Hub.
 *
 * Pure: no Deno globals, no Supabase client.
 */
import { publicMethod, type CheckoutMethod } from "./checkout-choice.ts";

export const DECIDED_STATUSES = ["rejected", "needs_clarification", "confirmed"] as const;
export type DecidedStatus = typeof DECIDED_STATUSES[number];

export type DecisionRow = {
  id?: string | null;
  status: string;
  payment_method: string | null;
  submitted_amount: number;
  created_at?: string | null;
  updated_at: string | null;
  customer_message: string | null;
};

export type LatestDecision = {
  status: "rejected" | "needs_clarification";
  method: CheckoutMethod;
  amount: number;
  decided_at: string;
  message: string | null;
};

/** The submission columns latestDecision reads (for a PostgREST select). */
export const DECISION_FIELDS = "id, status, payment_method, submitted_amount, created_at, updated_at, customer_message";

/**
 * A Postgres timestamptz as integer microseconds since the epoch, or null.
 * Date.parse keeps only milliseconds; Postgres orders by microseconds, so the
 * 4th–6th fractional digits are added back.
 */
export function timestampMicros(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const s = raw.trim().replace(" ", "T");
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const frac = /\.(\d+)/.exec(s)?.[1] ?? "";
  const extra = Number((frac + "000000").slice(3, 6));
  return ms * 1000 + extra;
}

/** DESC with NULLS LAST, as in SQL. Negative = a sorts first. */
function descNullsLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a === b ? 0 : (a > b ? -1 : 1);
}

/** The newest decided row (confirmed included), or null. */
export function newestDecided<T extends DecisionRow>(rows: T[]): T | null {
  const decided = rows.filter((r) => (DECIDED_STATUSES as readonly string[]).includes(String(r.status)));
  if (!decided.length) return null;
  const sorted = [...decided].sort((a, b) =>
    descNullsLast(timestampMicros(a.updated_at), timestampMicros(b.updated_at)) ||
    descNullsLast(timestampMicros(a.created_at), timestampMicros(b.created_at)) ||
    // uuid ordering in Postgres = byte order = lower-case hex string order.
    (() => {
      const x = String(a.id ?? "").toLowerCase();
      const y = String(b.id ?? "").toLowerCase();
      return x === y ? 0 : (x > y ? -1 : 1);
    })()
  );
  return sorted[0];
}

/** The decision the customer should see, or null (none, or confirmed newest). */
export function latestDecision(rows: DecisionRow[]): LatestDecision | null {
  const r = newestDecided(rows);
  if (!r || (r.status !== "rejected" && r.status !== "needs_clarification")) return null;
  const amount = Number(r.submitted_amount ?? 0);
  const msg = typeof r.customer_message === "string" && r.customer_message.trim() ? r.customer_message : null;
  return {
    status: r.status,
    method: publicMethod(r.payment_method),
    amount: Number.isFinite(amount) ? amount : 0,
    decided_at: String(r.updated_at ?? r.created_at ?? ""),
    message: msg,
  };
}
