/**
 * SQV03 / D-SQV03 (owner 2026-10-09): before an admin APPROVES a refund outside
 * Square, the Hub re-reads every refund of the order's card payments from Square
 * and records what it finds, so the approval is decided on Square's current
 * facts — not on a local row that may be minutes or hours old.
 *
 * Every captured payment is read (GetPayment); every refund id Square lists on
 * it, plus every refund id the Hub already holds for it, is read (GetRefund) and
 * recorded through syncSquareRefund (the same path as webhooks and reconcile).
 * Fail closed: any read error, or a refund the Hub could not record, refuses the
 * approval — an unknown refund could be money already going back.
 */
import type { SquareEnvironment } from "./card-rules.ts";
import { type SquarePayment, type SquareRefund, square } from "./square.ts";
import { syncSquareRefund } from "./square-sync.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export interface ResyncDeps {
  getPayment(env: SquareEnvironment, id: string): Promise<SquarePayment>;
  getRefund(env: SquareEnvironment, id: string): Promise<SquareRefund>;
  sync(env: SquareEnvironment, refund: SquareRefund): Promise<{ outcome: string; detail?: string }>;
}

export function liveResyncDeps(db: Db): ResyncDeps {
  return {
    getPayment: (env, id) => square.get(env, id),
    getRefund: (env, id) => square.getRefund(env, id),
    sync: (env, refund) => syncSquareRefund(db, env, refund),
  };
}

export type ResyncResult =
  | { ok: true; payments: number; refunds: number }
  | { ok: false; error: "square_unreachable" | "refund_not_recorded" | "hub_read_failed"; detail: string };

export async function resyncOrderRefunds(db: Db, orderId: string, deps: ResyncDeps = liveResyncDeps(db)): Promise<ResyncResult> {
  const { data: pays, error } = await db.from("square_payments")
    .select("square_payment_id, environment, test").eq("cash_order_id", orderId).eq("status", "captured");
  if (error) return { ok: false, error: "hub_read_failed", detail: String(error.message ?? error) };
  const { data: known, error: kErr } = await db.from("square_refunds")
    .select("square_refund_id, square_payment_id").eq("cash_order_id", orderId);
  if (kErr) return { ok: false, error: "hub_read_failed", detail: String(kErr.message ?? kErr) };
  let refunds = 0;
  for (const p of (pays ?? []) as Array<{ square_payment_id: string; environment: string | null; test: boolean | null }>) {
    const env: SquareEnvironment = p.environment === "production" || p.environment === "sandbox"
      ? p.environment : (p.test === false ? "production" : "sandbox");
    let payment: SquarePayment;
    try { payment = await deps.getPayment(env, p.square_payment_id); }
    catch (e) { return { ok: false, error: "square_unreachable", detail: `payment ${p.square_payment_id}: ${(e as Error)?.message ?? e}` }; }
    const ids = new Set<string>(Array.isArray(payment.refund_ids) ? payment.refund_ids.filter((x) => typeof x === "string" && x !== "") : []);
    for (const k of (known ?? []) as Array<{ square_refund_id: string; square_payment_id: string }>) {
      if (k.square_payment_id === p.square_payment_id) ids.add(String(k.square_refund_id));
    }
    for (const id of ids) {
      let refund: SquareRefund;
      try { refund = await deps.getRefund(env, id); }
      catch (e) { return { ok: false, error: "square_unreachable", detail: `refund ${id}: ${(e as Error)?.message ?? e}` }; }
      let r: { outcome: string; detail?: string };
      try { r = await deps.sync(env, refund); }
      catch (e) { return { ok: false, error: "refund_not_recorded", detail: `refund ${id}: ${(e as Error)?.message ?? e}` }; }
      if (r.outcome !== "synced") return { ok: false, error: "refund_not_recorded", detail: `refund ${id}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}` };
      refunds++;
    }
  }
  return { ok: true, payments: (pays ?? []).length, refunds };
}
